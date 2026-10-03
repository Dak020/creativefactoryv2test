import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";
import { answerCallback, botKey, botToken, sendText, webhookSecret } from "@/lib/telegram/bot.server";

const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

const HELP = [
  "<b>Creative Factory VA Commands</b>",
  "/projects — open project workspace & actions",
  "/addhook — pick a project & paste a new hook",
  "/status — workspace overview",
  "/clips — your latest clips",
  "/trends — top trending sounds",
  "/schedule — upcoming posts",
  "/help — this list",
].join("\n");

function db() {
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function format(cmd: string, data: any): string {
  if (cmd === "status") {
    return [
      "<b>📊 Status</b>",
      `Projects: ${data.projects}`,
      `Clips: ${data.clips}`,
      `Videos made: ${data.videos}`,
      `Renders running: ${data.renders_active}`,
      `Posts scheduled: ${data.scheduled}`,
      `Published: ${data.published}`,
      `Failed posts: ${data.failed}`,
    ].join("\n");
  }
  const rows = (data ?? []) as any[];
  if (!rows.length) return "Nothing here yet.";
  if (cmd === "clips")
    return "<b>🎬 Latest clips</b>\n" + rows.map((r) =>
      `• ${esc(r.filename)} — ${Number(r.duration ?? 0).toFixed(1)}s · ${esc(r.dna_role ?? "no role")} · ${esc(r.seek_mode)}`).join("\n");
  if (cmd === "trends")
    return "<b>🔥 Trending sounds</b>\n" + rows.map((r, i) =>
      `${i + 1}. ${esc(r.title)}${r.author ? ` — ${esc(r.author)}` : ""} (${esc(r.region)})`).join("\n");
  if (cmd === "schedule")
    return "<b>🗓 Upcoming posts</b>\n" + rows.map((r) =>
      `• ${new Date(r.scheduled_for).toUTCString().slice(0, 22)} UTC — ${esc(r.status)}${r.caption ? `\n  ${esc(r.caption)}` : ""}`).join("\n");
  return HELP;
}

async function resolveAudioForRender(
  audio: { id: string; storage_path: string | null; audio_url: string | null },
  userId: string
): Promise<string | null> {
  const supabase = db();
  if (audio.storage_path) {
    const { data } = await supabase.storage.from("media").createSignedUrl(audio.storage_path, 60 * 60 * 6);
    if (data?.signedUrl) return data.signedUrl;
  }
  if (!audio.audio_url) return null;
  try {
    const res = await fetch(audio.audio_url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const storagePath = `${userId}/cache-${crypto.randomUUID()}.mp3`;
    const { error: upErr } = await supabase.storage
      .from("media")
      .upload(storagePath, Buffer.from(arrayBuffer), {
        contentType: res.headers.get("content-type") || "audio/mpeg",
        upsert: true,
      });
    if (upErr) return null;
    await supabase.from("trending_audios").update({ storage_path: storagePath }).eq("id", audio.id);
    const { data: signed } = await supabase.storage.from("media").createSignedUrl(storagePath, 60 * 60 * 6);
    return signed?.signedUrl ?? null;
  } catch (err) {
    console.error("Failed to prepare audio for render:", err);
    return null;
  }
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = botToken();
        const expected = Buffer.from(webhookSecret(token));
        const actual = Buffer.from(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const update = (await request.json().catch(() => null)) as any;
        const key = botKey(token);

        // 1. Handle Inline Button Clicks & Project Actions
        if (update?.callback_query) {
          const cb = update.callback_query;
          const callbackId = cb.id;
          const data = String(cb.data || "");
          const chatId = cb.message?.chat?.id;

          // Open project dashboard (compact callback: "open_proj:<uuid>")
          if (data.startsWith("open_proj:") || data.startsWith("open_project:")) {
            const projectId = data.includes("open_proj:")
              ? data.split("open_proj:")[1]
              : data.split("open_project:")[1];
            await answerCallback(callbackId);

            const [projRes, hooksRes] = await Promise.all([
              db().from("projects").select("*").eq("id", projectId).maybeSingle(),
              db().from("hooks").select("id").eq("project_id", projectId),
            ]);

            const proj = projRes.data;
            if (!proj) {
              await sendText(chatId, "Project not found.");
              return Response.json({ ok: true });
            }

            const hookCount = hooksRes.data?.length ?? 0;

            const keyboard = {
              inline_keyboard: [
                [
                  { text: "➕ Add Hook", callback_data: `add_hook:${proj.id}` },
                  { text: `📝 View Hooks (${hookCount})`, callback_data: `view_hooks:${proj.id}` },
                ],
                [
                  { text: "🚀 Choose Render Style", callback_data: `choose_style:${proj.id}` },
                ],
                [
                  { text: "🔙 All Projects", callback_data: "list_projects" },
                ],
              ],
            };

            await sendText(
              chatId,
              `📁 <b>Project: ${esc(proj.name)}</b>\n\n` +
              `• <b>Style:</b> ${esc(proj.content_style || "general")}\n` +
              `• <b>Platform:</b> ${esc(proj.platform || "tiktok")}\n` +
              `• <b>Saved Hooks:</b> ${hookCount}\n\n` +
              `Choose an action below:`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Return to project list
          if (data === "list_projects") {
            await answerCallback(callbackId);
            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (link?.user_id) {
              const { data: projs } = await db().from("projects").select("id, name").eq("user_id", link.user_id);
              const keyboard = {
                inline_keyboard: (projs || []).slice(0, 8).map((p) => [
                  { text: `📁 ${p.name.slice(0, 25)}`, callback_data: `open_proj:${p.id}` },
                ]),
              };
              await sendText(chatId, "📁 <b>Your Projects:</b>\nTap a project to work in it:", keyboard);
            }
            return Response.json({ ok: true });
          }

          // View hooks for a project (compact callback: "view_hooks:<uuid>")
          if (data.startsWith("view_hooks:")) {
            const projectId = data.split(":")[1];
            await answerCallback(callbackId);

            const [projRes, hooksRes] = await Promise.all([
              db().from("projects").select("name").eq("id", projectId).maybeSingle(),
              db().from("hooks").select("text, is_winner").eq("project_id", projectId).order("created_at", { ascending: false }).limit(8),
            ]);

            const projName = projRes.data?.name || "Project";
            const hooks = hooksRes.data || [];

            if (hooks.length === 0) {
              await sendText(
                chatId,
                `📝 No hooks found in <b>${esc(projName)}</b>.\nUse the button below to add one.`,
                {
                  inline_keyboard: [
                    [{ text: "➕ Add Hook", callback_data: `add_hook:${projectId}` }],
                    [{ text: "🔙 Back to Project", callback_data: `open_proj:${projectId}` }],
                  ],
                }
              );
            } else {
              const hookList = hooks.map((h, i) => `${i + 1}. "${esc(h.text)}"${h.is_winner ? " ⭐" : ""}`).join("\n\n");
              await sendText(
                chatId,
                `📝 <b>Hooks in ${esc(projName)}:</b>\n\n${hookList}`,
                {
                  inline_keyboard: [
                    [{ text: "➕ Add Another Hook", callback_data: `add_hook:${projectId}` }],
                    [{ text: "🔙 Back to Project", callback_data: `open_proj:${projectId}` }],
                  ],
                }
              );
            }
            return Response.json({ ok: true });
          }

          // Choose Render Style: Single (8s) vs Clip DNA (2 Clips, 8s)
          if (data.startsWith("choose_style:") || data.startsWith("queue_render:")) {
            const projectId = data.split(":")[1];
            await answerCallback(callbackId);

            const { data: proj } = await db().from("projects").select("name").eq("id", projectId).maybeSingle();
            const projName = proj?.name || "Project";

            await sendText(
              chatId,
              `🎬 <b>Choose Render Style for ${esc(projName)}</b>\n\n` +
              `• <b>Single Render (8s):</b> Fast single-clip render. Auto-saved directly to your library without needing approval.\n\n` +
              `• <b>Clip DNA Render (8s):</b> Combines 2+ DNA-tagged clips into a multi-clip dynamic video using the app's DNA solver. Sends a 9:16 preview to Telegram for your approval before saving.`,
              {
                inline_keyboard: [
                  [{ text: "⚡ Single Render (8s, Auto-save)", callback_data: `pick_audio:single:${projectId}` }],
                  [{ text: "🧬 Clip DNA (Multi-clip, Preview & Approve)", callback_data: `pick_audio:dna:${projectId}` }],
                  [{ text: "🔙 Back to Project", callback_data: `open_proj:${projectId}` }],
                ],
              }
            );
            return Response.json({ ok: true });
          }

          // Pick the audio strategy
          if (data.startsWith("pick_audio:")) {
            const [_, style, projectId] = data.split(":");
            await answerCallback(callbackId);

            const { data: proj } = await db().from("projects").select("name").eq("id", projectId).maybeSingle();
            const projName = proj?.name || "Project";
            const styleCode = style === "dna" ? "d" : "s";

            await sendText(
              chatId,
              `🎵 <b>Choose sound for ${style === "dna" ? "Clip DNA" : "Single"} render in ${esc(projName)}:</b>`,
              {
                inline_keyboard: [
                  [{ text: "🔊 Original clip audio", callback_data: `pick_mode:original:${styleCode}:${projectId}` }],
                  [{ text: "🤖 VA auto-pick trending sound", callback_data: `pick_mode:auto:${styleCode}:${projectId}` }],
                  [{ text: "📚 Pick from audio library", callback_data: `pick_lib:${styleCode}:${projectId}` }],
                  [{ text: "🔇 No sound (silent)", callback_data: `pick_mode:none:${styleCode}:${projectId}` }],
                  [{ text: "🔙 Back", callback_data: `choose_style:${projectId}` }],
                ],
              }
            );
            return Response.json({ ok: true });
          }

          // Browse the user's own audio library for a specific track
          if (data.startsWith("pick_lib:")) {
            const [_, styleCode, projectId] = data.split(":");
            await answerCallback(callbackId);

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "Please connect your Telegram account first in Settings.");
              return Response.json({ ok: true });
            }

            const { data: audios } = await db()
              .from("trending_audios")
              .select("id, title, author")
              .eq("user_id", link.user_id)
              .neq("source", "seed_placeholder")
              .order("created_at", { ascending: false })
              .limit(10);

            const style = styleCode === "d" ? "dna" : "single";

            if (!audios || audios.length === 0) {
              await sendText(
                chatId,
                "📚 Your saved audio library is empty. Import sounds in the web app's Audio Library first.",
                {
                  inline_keyboard: [[{ text: "🔙 Back", callback_data: `pick_audio:${style}:${projectId}` }]],
                }
              );
              return Response.json({ ok: true });
            }

            const buttons = audios.map((a, idx) => [{
              text: `🎵 ${(a.title || "Untitled").slice(0, 30)}`,
              callback_data: `pick_lib_idx:${styleCode}:${idx}:${projectId}`,
            }]);

            buttons.push([{ text: "🔙 Back", callback_data: `pick_audio:${style}:${projectId}` }]);

            await sendText(chatId, "📚 <b>Pick a sound from your library:</b>", {
              inline_keyboard: buttons,
            });
            return Response.json({ ok: true });
          }

          // Execute queueing based on selected style + audio mode
          if (data.startsWith("pick_mode:") || data.startsWith("pick_lib_idx:")) {
            await answerCallback(callbackId, "Queueing render...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "Please connect your Telegram account first in Settings.");
              return Response.json({ ok: true });
            }

            let audioMode: "original" | "auto" | "none" | "lib" = "none";
            let style: "single" | "dna" = "single";
            let projectId = "";
            let libIndex: number | null = null;

            if (data.startsWith("pick_mode:")) {
              const parts = data.split(":");
              audioMode = parts[1] as any; // "original" | "auto" | "none"
              style = parts[2] === "d" ? "dna" : "single";
              projectId = parts[3] ?? "";
            } else {
              const parts = data.split(":");
              audioMode = "lib";
              style = parts[1] === "d" ? "dna" : "single";
              libIndex = parseInt(parts[2] ?? "", 10);
              projectId = parts[3] ?? "";
            }

            const { data: proj } = await db().from("projects").select("name").eq("id", projectId).maybeSingle();
            const projectName = proj?.name || "Project";

            // 1. Get latest hook
            const { data: hook } = await db()
              .from("hooks")
              .select("id, text")
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (!hook) {
              await sendText(
                chatId,
                `⚠️ <b>${esc(projectName)}</b> has no hooks yet!\nAdd a hook before queueing a render.`,
                {
                  inline_keyboard: [
                    [{ text: "➕ Add Hook Now", callback_data: `add_hook:${projectId}` }],
                    [{ text: "🔙 Back to Project", callback_data: `open_proj:${projectId}` }],
                  ],
                }
              );
              return Response.json({ ok: true });
            }

            // 2. Fetch clips — project-scoped, DNA-role-tagged for DNA renders
            let clipsQuery = db()
              .from("media_assets")
              .select("id, duration, storage_path, dna_role")
              .eq("user_id", link.user_id)
              .eq("project_id", projectId);

            if (style === "dna") {
              clipsQuery = clipsQuery.in("dna_role", ["start", "middle", "end"]);
            }

            const { data: clips, error: clipsErr } = await clipsQuery
              .order("created_at", { ascending: false })
              .limit(style === "dna" ? 6 : 1);

            if (clipsErr || !clips || clips.length === 0) {
              const why = style === "dna"
                ? `No DNA-tagged clips found in <b>${esc(projectName)}</b>.\nTag at least 2 clips with a DNA role (start / middle / end) in the web app first.`
                : `No media clips found in <b>${esc(projectName)}</b>.\nPlease upload at least one video clip in the web app before rendering.`;
              await sendText(chatId, `⚠️ ${why}`, {
                inline_keyboard: [[{ text: "🔙 Back to Project", callback_data: `open_proj:${projectId}` }]],
              });
              return Response.json({ ok: true });
            }

            // 3. Resolve audio for render
            let soundtrackUrl: string | null = null;
            let audioLabel = "No sound (silent)";
            let withAudio = false;

            try {
              if (audioMode === "original") {
                withAudio = true;
                audioLabel = "Original clip audio";
              } else if (audioMode === "auto") {
                const { data: autoRows } = await db()
                  .from("trending_audios")
                  .select("id, title, author, storage_path, audio_url, virality_score, region")
                  .eq("region", "global")
                  .neq("source", "seed_placeholder")
                  .order("virality_score", { ascending: false })
                  .limit(15);
                if (autoRows && autoRows.length > 0) {
                  const picked = autoRows[Math.floor(Math.random() * autoRows.length)]!;
                  const resolved = await resolveAudioForRender(picked, link.user_id);
                  if (resolved) {
                    soundtrackUrl = resolved;
                    audioLabel = `VA picked: ${picked.title}`;
                  } else {
                    audioLabel = "VA auto-pick failed — rendering silent";
                  }
                } else {
                  audioLabel = "No trending sounds available — rendering silent";
                }
              } else if (audioMode === "lib" && libIndex !== null && !isNaN(libIndex)) {
                const { data: audios } = await db()
                  .from("trending_audios")
                  .select("id, title, author, storage_path, audio_url")
                  .eq("user_id", link.user_id)
                  .neq("source", "seed_placeholder")
                  .order("created_at", { ascending: false })
                  .limit(10);
                const picked = audios?.[libIndex];
                if (picked) {
                  const resolved = await resolveAudioForRender(picked, link.user_id);
                  if (resolved) {
                    soundtrackUrl = resolved;
                    audioLabel = `Library: ${picked.title}`;
                  } else {
                    audioLabel = "Chosen library sound could not be loaded — rendering silent";
                  }
                }
              }
            } catch (audioErr) {
              console.error("audio resolve error", audioErr);
              audioLabel = "Audio prep failed — rendering silent";
            }

            // 4. Create video recipe with fixed 8s duration + audio settings baked in
            const targetDuration = 8;
            const primaryClip = clips[0]!;

            const { data: recipe, error: recErr } = await db()
              .from("video_recipes")
              .insert({
                user_id: link.user_id,
                project_id: projectId,
                hook_id: hook.id,
                media_asset_id: primaryClip.id,
                duration: targetDuration,
                overlay_text: hook.text,
                overlay_position: "top",
                font_size: 48,
                background_color: style === "dna" ? "#000000_dna" : "#000000_single",
                text_color: "#ffffff",
                width: 1080,
                height: 1920,
              })
              .select("id")
              .single();

            if (recErr || !recipe) {
              await sendText(chatId, `❌ Failed to create recipe: ${esc(recErr?.message || "Unknown error")}`);
              return Response.json({ ok: true });
            }

            // 5. Store render settings in render_job_hints
            const { error: hintErr } = await db().from("render_job_hints").insert({
              recipe_id: recipe.id,
              user_id: link.user_id,
              with_audio: withAudio,
              soundtrack_url: soundtrackUrl,
              audio_label: audioLabel,
              clip_ids: clips.map((c) => c.id),
              style,
            });
            if (hintErr) {
              console.error("render_job_hints insert failed", hintErr);
              await sendText(chatId, `❌ Failed to store render settings: ${esc(hintErr.message)}`);
              return Response.json({ ok: true });
            }

            // 6. Insert render job
            const { error: jobErr } = await db().from("render_jobs").insert({
              user_id: link.user_id,
              project_id: projectId,
              recipe_id: recipe.id,
              status: "queued",
              progress: 0,
            });

            if (jobErr) {
              await sendText(chatId, `❌ Could not queue render: ${esc(jobErr.message)}`);
            } else {
              const modeLabel = style === "dna" ? "🧬 Clip DNA (Multi-clip)" : "⚡ Single Clip";
              await sendText(
                chatId,
                `🚀 <b>Render Queued for ${esc(projectName)}!</b>\n\n` +
                `• <b>Style:</b> ${modeLabel}\n` +
                `• <b>Sound:</b> ${esc(audioLabel)}\n` +
                `• <b>Duration:</b> ${targetDuration} seconds\n` +
                `• <b>Hook:</b> "${esc(hook.text)}"\n` +
                `• <b>Status:</b> Queued\n\n` +
                (style === "dna"
                  ? `Keep your Creative Factory browser tab open. A 9:16 preview will be delivered here for your approval.`
                  : `Keep your Creative Factory browser tab open. The video will be auto-saved to your library once rendered.`)
              );
            }
            return Response.json({ ok: true });
          }

          // Add Hook prompt (compact callback: "add_hook:<uuid>")
          if (data.startsWith("add_hook:") || data.startsWith("select_project_hook:")) {
            const projectId = data.includes("add_hook:")
              ? data.split("add_hook:")[1]
              : data.split(":")[1];
            await answerCallback(callbackId);

            const { data: proj } = await db().from("projects").select("name").eq("id", projectId).maybeSingle();
            const projName = proj?.name || "Project";

            await sendText(
              chatId,
              `🎯 Selected: <b>${esc(projName)}</b>\n(ID: <code>${projectId}</code>)\n\nReply directly to this message with your hook text:`,
              { force_reply: true, selective: true }
            );
            return Response.json({ ok: true });
          }

          // Approve DNA style preview
          if (data.startsWith("approve:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Saving video to library...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (link?.user_id) {
              let jobQuery = db().from("render_jobs").select("*");
              if (jobId && jobId !== "last") {
                jobQuery = jobQuery.eq("id", jobId);
              } else {
                jobQuery = jobQuery.eq("user_id", link.user_id).order("created_at", { ascending: false }).limit(1);
              }
              const { data: job } = await jobQuery.maybeSingle();

              if (job && job.output_url) {
                const { data: recipe } = await db().from("video_recipes").select("*").eq("id", job.recipe_id).maybeSingle();

                await db().from("generated_videos").insert({
                  user_id: link.user_id,
                  project_id: job.project_id,
                  render_job_id: job.id,
                  recipe_id: recipe?.id ?? job.recipe_id,
                  hook_id: recipe?.hook_id ?? null,
                  media_asset_id: recipe?.media_asset_id ?? null,
                  hook_text: recipe?.overlay_text ?? "",
                  output_url: job.output_url,
                  thumbnail_url: `${link.user_id}/${job.id}.jpg`,
                  duration: recipe?.duration ?? 8,
                  status: "completed",
                });

                // Mark job as truly completed now that it's saved
                await db()
                  .from("render_jobs")
                  .update({ status: "completed", completed_at: new Date().toISOString() })
                  .eq("id", job.id);

                await sendText(
                  chatId,
                  `✅ <b>Clip DNA Video Approved!</b>\n\n` +
                  `Your video has been saved to your project library and is now ready to schedule in the web app!`
                );
                return Response.json({ ok: true });
              }
            }

            await sendText(chatId, `✅ <b>Approved!</b> Video saved to library.`);
            return Response.json({ ok: true });
          }

          // Discard preview
          if (data.startsWith("discard:")) {
            await answerCallback(callbackId, "Preview discarded");
            await sendText(chatId, `❌ <b>Preview discarded.</b> Nothing was saved to your library.`);
            return Response.json({ ok: true });
          }

          await answerCallback(callbackId);
          return Response.json({ ok: true });
        }

        // 2. Normal Message & Command Handling
        const msg = update?.message;
        const chatId = msg?.chat?.id;
        const text: string = typeof msg?.text === "string" ? msg.text.slice(0, 500).trim() : "";
        if (typeof chatId !== "number" || msg?.chat?.type !== "private" || !text) {
          return Response.json({ ok: true });
        }

        if (msg.reply_to_message?.text && msg.reply_to_message.text.includes("Reply directly to this message with your hook text")) {
          const idMatch = msg.reply_to_message.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (idMatch) {
            const projectId = idMatch[0];

            const { data: link } = await db()
              .from("telegram_links")
              .select("user_id")
              .eq("chat_id", chatId)
              .maybeSingle();

            if (link?.user_id) {
              const { error: insertErr } = await db().from("hooks").insert({
                user_id: link.user_id,
                project_id: projectId,
                text: text,
                category: "custom",
                platform: "tiktok",
                source: "telegram",
              });

              if (insertErr) {
                await sendText(chatId, `❌ Failed to save hook: ${esc(insertErr.message)}`);
              } else {
                await sendText(
                  chatId,
                  `✅ <b>Hook added!</b>\n\n"<i>${esc(text)}</i>"\n\nIt is now saved in your project's hook library.`,
                  {
                    inline_keyboard: [
                      [{ text: "📁 Open Project", callback_data: `open_proj:${projectId}` }],
                      [{ text: "➕ Add Another Hook", callback_data: `add_hook:${projectId}` }],
                    ],
                  }
                );
              }
              return Response.json({ ok: true });
            }
          }
        }

        const [rawCmd, ...args] = text.split(/\s+/);
        const cmd = (rawCmd ?? "").toLowerCase().replace(/^\//, "").replace(/@.*$/, "");

        try {
          if (cmd === "start" && args[0]) {
            const code = args[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
            const { data, error } = await db().rpc("telegram_link" as any, { _code: code, _chat_id: chatId, _key: key });
            if (error) throw error;
            await sendText(
              chatId,
              data
                ? `✅ Connected! I'm your Creative Factory VA.\n\n${HELP}`
                : "That link expired. Open Settings in the app and tap Connect Telegram again."
            );
            return Response.json({ ok: true });
          }

          if (cmd === "projects" || cmd === "project") {
            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "Please connect your Telegram account first in Settings.");
              return Response.json({ ok: true });
            }
            const { data: projs } = await db().from("projects").select("id, name, content_style").eq("user_id", link.user_id);
            if (!projs || projs.length === 0) {
              await sendText(chatId, "📁 No projects found. Create one in the app first.");
            } else {
              const inlineKeyboard = projs.slice(0, 8).map((p) => [
                {
                  text: `📁 ${p.name.slice(0, 25)}`,
                  callback_data: `open_proj:${p.id}`,
                },
              ]);
              await sendText(chatId, "📁 <b>Your Projects:</b>\nTap any project below to open its workspace and actions:", { inline_keyboard: inlineKeyboard });
            }
            return Response.json({ ok: true });
          }

          if (cmd === "addhook" || cmd === "addhooks") {
            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "Please connect your Telegram account first in Settings.");
              return Response.json({ ok: true });
            }
            const { data: projs } = await db().from("projects").select("id, name").eq("user_id", link.user_id);
            if (!projs || projs.length === 0) {
              await sendText(chatId, "📁 You don't have any projects yet. Create a project in the app first.");
              return Response.json({ ok: true });
            }
            const inlineKeyboard = projs.slice(0, 8).map((p) => [
              { text: `📁 ${p.name.slice(0, 25)}`, callback_data: `add_hook:${p.id}` },
            ]);
            await sendText(chatId, "🎯 <b>Select the project</b> to add a hook to:", { inline_keyboard: inlineKeyboard });
            return Response.json({ ok: true });
          }

          const known = ["status", "clips", "trends", "schedule"];
          const command = known.includes(cmd) ? cmd : "help";
          const { data, error } = await db().rpc("telegram_command" as any, { _chat_id: chatId, _key: key, _cmd: command });
          if (error) throw error;
          const res = data as { linked: boolean; data: unknown };
          if (!res?.linked) {
            await sendText(chatId, "Hi! Open Settings in the Creative Factory app and tap <b>Connect Telegram</b> to link me to your account.");
          } else {
            await sendText(chatId, command === "help" ? HELP : format(command, res.data));
          }
        } catch (e) {
          console.error("telegram webhook error", e);
          await sendText(chatId, "Something went wrong on my side. Try again in a moment.").catch(() => {});
        }
        return Response.json({ ok: true });
      },
    },
  },
});
