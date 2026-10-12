import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";
import { tg, sendText, answerCallback, botToken, botKey, webhookSecret, BOT_USERNAME } from "@/lib/telegram/bot.server";

function esc(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function deleteMessage(chatId: number, messageId: number) {
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (err) {
    console.error("deleteMessage error:", err);
  }
}

async function editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    };
    if (replyMarkup) body["reply_markup"] = replyMarkup;
    await tg("editMessageText", body);
  } catch (err) {
    console.error("editMessageText error:", err);
  }
}

function buildStyleSelectKeyboard(projectId: string) {
  return {
    inline_keyboard: [
      [
        { text: "⚡ Single Clip Cut", callback_data: `st:s:${projectId}` },
        { text: "🧬 Clip DNA (Multi-Cut)", callback_data: `st:d:${projectId}` },
      ],
      [{ text: "❌ Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function buildDurationKeyboard(projectId: string, style: "s" | "d") {
  return {
    inline_keyboard: [
      [
        { text: "6s", callback_data: `dur:${style}:6:${projectId}` },
        { text: "8s (Default)", callback_data: `dur:${style}:8:${projectId}` },
      ],
      [
        { text: "10s", callback_data: `dur:${style}:10:${projectId}` },
        { text: "15s", callback_data: `dur:${style}:15:${projectId}` },
      ],
      [{ text: "« Back to Style", callback_data: `step_proj:${projectId}` }],
      [{ text: "❌ Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function buildBatchSelectKeyboard(projectId: string, style: "s" | "d", duration: number) {
  return {
    inline_keyboard: [
      [
        { text: "1x Single", callback_data: `bat:${style}:${duration}:1:${projectId}` },
        { text: "3x Variants", callback_data: `bat:${style}:${duration}:3:${projectId}` },
        { text: "5x Variants", callback_data: `bat:${style}:${duration}:5:${projectId}` },
      ],
      [{ text: "« Back to Duration", callback_data: `st:${style}:${projectId}` }],
      [{ text: "❌ Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _supabase: any = null;
function db() {
  if (!_supabase) {
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] || process.env['SUPABASE_PUBLISHABLE_KEY']!;
    _supabase = createClient(process.env['SUPABASE_URL']!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatCmd(cmd: string, data: any): string {
  if (cmd === "status") {
    return [
      "<b>📊 Status</b>",
      `Projects: ${data?.projects ?? 0}`,
      `Clips: ${data?.clips ?? 0}`,
      `Videos made: ${data?.videos ?? 0}`,
      `Posts scheduled: ${data?.scheduled ?? 0}`,
      `Published: ${data?.published ?? 0}`,
      `Failed posts: ${data?.failed ?? 0}`,
    ].join("\n");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[];
  if (!rows.length) return "Nothing here yet.";
  if (cmd === "clips")
    return "<b>🎬 Latest clips</b>\n" + rows.map((r) =>
      `• ${esc(r.filename)} — ${Number(r.duration ?? 0).toFixed(1)}s · ${esc(r.dna_role ?? "no role")}`).join("\n");
  if (cmd === "trends")
    return "<b>🔥 Trending sounds</b>\n" + rows.map((r, i) =>
      `${i + 1}. ${esc(r.title)}${r.author ? ` — ${esc(r.author)}` : ""}`).join("\n");
  return "<b>🗓 Upcoming posts</b>\n" + rows.map((r) =>
    `• ${new Date(r.scheduled_for).toUTCString().slice(0, 22)} UTC — ${esc(r.status)}`).join("\n");
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = botToken();
        const expectedSecret = webhookSecret(token);
        const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actualSecret, expectedSecret)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const key = botKey(token);

        const update = await request.json();

        // 1. Handle Slash Commands & Text Messages
        if (update.message) {
          const msg = update.message;
          const chatId = msg.chat?.id;
          const text = (msg.text || "").trim();

          if (!chatId) return Response.json({ ok: true });

          if (text.startsWith("/start")) {
            const code = (text.split(" ")[1] || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);

            if (!code) {
              await sendText(
                chatId,
                `👋 <b>Welcome to Creative Factory Bot!</b>\n\nTo link your account, open Settings in the web app and click Connect Telegram.`
              );
              return Response.json({ ok: true });
            }

            const { data: ok, error } = await db().rpc("telegram_link", { _code: code, _chat_id: chatId, _key: key });
            await sendText(
              chatId,
              !error && ok
                ? `✅ <b>Connected! I'm your Creative Factory VA.</b>\n\nType /render to start creating videos, or /help for all commands.`
                : `❌ That link expired. Open Settings in the app and tap Connect Telegram again.`
            );
            return Response.json({ ok: true });
          }

          const simple = text.toLowerCase().replace(/^\//, "").replace(/@.*$/, "");

          if (simple === "ping") {
            const startTransit = msg.date ? Math.max(0, Date.now() - msg.date * 1000) : 0;

            // 1. Measure Database query latency
            const dbStart = performance.now();
            const { data: link } = await db()
              .from("telegram_links")
              .select("user_id")
              .eq("chat_id", chatId)
              .maybeSingle();
            const dbMs = Math.round(performance.now() - dbStart);

            // 2. Measure Telegram Bot API roundtrip latency
            let apiMs = 0;
            try {
              const apiStart = performance.now();
              await tg("getMe", {});
              apiMs = Math.round(performance.now() - apiStart);
            } catch (err) {
              console.error("tg getMe error:", err);
            }

            const isLinked = Boolean(link?.user_id);
            const statusLines = [
              "🏓 <b>Pong!</b> Connection is healthy & active.",
              "",
              `• <b>Telegram API Speed:</b> <b>${apiMs} ms</b>`,
              `• <b>Database Latency:</b> <b>${dbMs} ms</b>`,
              startTransit > 0 ? `• <b>Inbound Transit:</b> ~${startTransit} ms` : null,
              `• <b>Account Status:</b> ${isLinked ? "✅ Linked" : "⚠️ Not linked (use /start in Settings)"}`,
              `• <b>Bot:</b> @${BOT_USERNAME}`,
              `• <b>Server Time:</b> ${new Date().toISOString().slice(11, 19)} UTC`,
            ].filter(Boolean).join("\n");

            await sendText(chatId, statusLines);
            return Response.json({ ok: true });
          }

          if (["status", "clips", "trends", "schedule"].includes(simple)) {
            const { data: res, error } = await db().rpc("telegram_command", { _chat_id: chatId, _key: key, _cmd: simple });
            if (error || !res?.linked) {
              await sendText(chatId, `⚠️ Please connect your account first from Settings in the app.`);
            } else {
              await sendText(chatId, formatCmd(simple, res.data));
            }
            return Response.json({ ok: true });
          }

          if (text === "/render" || text === "/projects") {
            const { data: link } = await db()
              .from("telegram_links")
              .select("user_id")
              .eq("chat_id", chatId)
              .maybeSingle();

            if (!link?.user_id) {
              await sendText(chatId, `⚠️ Please link your account first using the link from Settings → Integrations.`);
              return Response.json({ ok: true });
            }

            const { data: projects } = await db()
              .from("projects")
              .select("id, name")
              .eq("user_id", link.user_id)
              .order("created_at", { ascending: false })
              .limit(8);

            if (!projects || projects.length === 0) {
              await sendText(chatId, `No projects found. Create a project in Creative Factory first.`);
              return Response.json({ ok: true });
            }

            const keyboard = {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              inline_keyboard: projects.map((p: any) => [
                { text: `📁 ${p.name}`, callback_data: `step_proj:${p.id}` },
              ]),
            };

            await sendText(chatId, `🎬 <b>Select a Project to Render:</b>`, keyboard);
            return Response.json({ ok: true });
          }

          if (text === "/help") {
            await sendText(
              chatId,
              `🤖 <b>Creative Factory Bot Commands:</b>\n\n` +
              `• /render - Start the 4-step Render Wizard\n` +
              `• /projects - List your active projects\n` +
              `• /ping - Test connection & response speed (ms)\n` +
              `• /status, /clips, /trends, /schedule\n` +
              `• /help - Show available commands`
            );
            return Response.json({ ok: true });
          }

          return Response.json({ ok: true });
        }

        // 2. Handle Inline Button Callbacks
        if (update.callback_query) {
          const cb = update.callback_query;
          const callbackId = cb.id;
          const chatId = cb.message?.chat?.id;
          const messageId = cb.message?.message_id;
          const data = cb.data || "";

          if (!chatId || !messageId) {
            await answerCallback(callbackId);
            return Response.json({ ok: true });
          }

          // Cancel Wizard
          if (data === "cancel_wizard") {
            await answerCallback(callbackId, "Cancelled");
            await editMessageText(chatId, messageId, `❌ <i>Render wizard cancelled. Type /render to start again.</i>`);
            return Response.json({ ok: true });
          }

          // Step 1: Choose Style (Triggered by project selection or back button)
          if (data.startsWith("step_proj:") || data.startsWith("step_style:")) {
            const projectId = data.split(":")[1];
            await answerCallback(callbackId);

            const { data: project } = await db()
              .from("projects")
              .select("name")
              .eq("id", projectId)
              .maybeSingle();

            const projectName = project?.name || "Project";
            const keyboard = buildStyleSelectKeyboard(projectId);

            await editMessageText(
              chatId,
              messageId,
              `⚙️ <b>Step 1: Choose Style for ${esc(projectName)}</b>\n\n` +
              `• <b>Single Clip Cut:</b> One hook paired with one best clip\n` +
              `• <b>Clip DNA:</b> Multi-clip sequenced edit with speed ramps`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 2: Choose Duration (Triggered by style selection: st:s:... or st:d:...)
          if (data.startsWith("st:") || data.startsWith("step_dur:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "d" : "s";
            const projectId = parts[2];
            await answerCallback(callbackId);

            const keyboard = buildDurationKeyboard(projectId, style);
            await editMessageText(
              chatId,
              messageId,
              `⏱ <b>Step 2: Choose Target Duration</b>\n\n` +
              `How long should each video be? (TikTok & Reels sweet spot is 8s)`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 3: Choose Batch Quantity (Triggered by duration selection: dur:s:8:... or dur:d:8:...)
          if (data.startsWith("dur:") || data.startsWith("step_bat:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "d" : "s";
            const duration = parseInt(parts[2], 10) || 8;
            const projectId = parts[3];
            await answerCallback(callbackId);

            const keyboard = buildBatchSelectKeyboard(projectId, style, duration);
            await editMessageText(
              chatId,
              messageId,
              `📦 <b>Step 3: Choose Batch Quantity</b>\n\n` +
              `Generate multiple unique variations with randomized hooks & speed ramping\n\n` +
              (style === "d"
                ? `<i>Note: For DNA batches, a style preview is sent here first. Once you approve, the remaining batch renders automatically.</i>`
                : `<i>Note: Single batches render all variants straight into your library.</i>`),
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 4: Choose Audio Soundtrack (Triggered by batch selection: bat:s:8:3:... or bat:d:8:3:...)
          if (data.startsWith("bat:") || data.startsWith("step_aud:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "d" : "s";
            const duration = parseInt(parts[2], 10) || 8;
            const batch = parseInt(parts[3], 10) || 1;
            const projectId = parts[4];
            await answerCallback(callbackId);

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            let libraryTracks: { id: string; name: string }[] = [];
            if (link?.user_id) {
              const { data: tracks } = await db()
                .from("trending_audios")
                .select("id, title")
                .eq("user_id", link.user_id)
                .order("created_at", { ascending: false })
                .limit(3);
              libraryTracks = (tracks || []).map((t: { id: string; title: string }) => ({ id: t.id, name: t.title }));
            }

            const prefix = `aud:${style}:${duration}:${batch}:${projectId}`;
            const keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } = {
              inline_keyboard: [
                [{ text: "🎵 VA Trending Sound (Auto-pick)", callback_data: `${prefix}:tr` }],
                [{ text: "🔇 Silent (No music)", callback_data: `${prefix}:si` }],
                [{ text: "🗣 Original Clip Audio (Keep voice)", callback_data: `${prefix}:or` }],
              ],
            };

            for (const t of libraryTracks) {
              keyboard.inline_keyboard.push([
                { text: `🎶 ${t.name.slice(0, 24)}`, callback_data: `${prefix}:lb_${t.id.slice(0, 8)}` },
              ]);
            }

            keyboard.inline_keyboard.push([
              { text: `« Back to Quantity`, callback_data: `dur:${style}:${duration}:${projectId}` },
            ]);
            keyboard.inline_keyboard.push([
              { text: "❌ Cancel", callback_data: "cancel_wizard" },
            ]);

            await editMessageText(
              chatId,
              messageId,
              `🎵 <b>Step 4: Select Soundtrack</b>\n\n` +
              `Choose the audio layer for your ${duration}s ${style === "d" ? "Clip DNA" : "Single"} render:`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Execution Trigger (Triggered by audio selection: aud:style:duration:batch:projectId:audioChoice)
          if (data.startsWith("aud:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "d" : "s";
            const duration = parseInt(parts[2], 10) || 8;
            const batchTotal = parseInt(parts[3], 10) || 1;
            const projectId = parts[4];
            const audioChoice = parts[5];
            await answerCallback(callbackId, "Preparing render queue...");

            await deleteMessage(chatId, messageId);

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "⚠️ User link not found. Please connect in Settings.");
              return Response.json({ ok: true });
            }

            const { data: project } = await db()
              .from("projects")
              .select("name")
              .eq("id", projectId)
              .maybeSingle();
            const projectName = project?.name || "Project";

            // Resolve audio parameters
            let withAudio = false;
            let soundtrackUrl: string | null = null;
            let audioLabel = "None";

            if (audioChoice === "or") {
              withAudio = true;
              audioLabel = "Original clip audio";
            } else if (audioChoice === "tr") {
              const { data: tr } = await db()
                .from("trending_audios")
                .select("id, title, audio_url")
                .eq("user_id", link.user_id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (tr && tr.audio_url) {
                soundtrackUrl = tr.audio_url;
                audioLabel = tr.title || "Trending audio";
              } else {
                withAudio = true;
                audioLabel = "Original clip audio (no trending sound found)";
              }
            } else if (audioChoice && audioChoice.startsWith("lb_")) {
              const trackIdPrefix = audioChoice.slice(3);
              const { data: tr } = await db()
                .from("trending_audios")
                .select("id, title, audio_url")
                .eq("user_id", link.user_id)
                .ilike("id", `${trackIdPrefix}%`)
                .limit(1)
                .maybeSingle();

              if (tr && tr.audio_url) {
                soundtrackUrl = tr.audio_url;
                audioLabel = tr.title || "Library audio";
              }
            }

            // Fetch Hooks & Clips for this project
            const [hooksRes, clipsRes] = await Promise.all([
              db().from("hooks").select("id, text").eq("project_id", projectId).order("created_at", { ascending: false }),
              db().from("media_assets").select("id, filename, duration, storage_path, dna_role").eq("project_id", projectId),
            ]);

            const hooks = hooksRes.data || [];
            const clips = clipsRes.data || [];

            if (hooks.length === 0) {
              await sendText(chatId, `❌ Project "${esc(projectName)}" has no hooks. Add hooks in the web app first.`);
              return Response.json({ ok: true });
            }

            const isDna = style === "d";

            if (isDna) {
              const tagged = clips.filter((c: { dna_role?: string | null }) => ["start", "middle", "end"].includes(c.dna_role || ""));
              if (tagged.length < 2) {
                await sendText(chatId, `❌ Project "${esc(projectName)}" needs at least 2 DNA-tagged clips (Start/Middle/End) for Clip DNA.`);
                return Response.json({ ok: true });
              }
            } else {
              if (clips.length === 0) {
                await sendText(chatId, `❌ Project "${esc(projectName)}" has no media clips. Upload clips in the app first.`);
                return Response.json({ ok: true });
              }
            }

            const chosenHook = hooks[0]!;
            const primaryClip = isDna
              ? clips.find((c: { dna_role?: string | null }) => c.dna_role === "start") || clips[0]!
              : clips[0]!;

            // Create primary video_recipe
            const { data: recipe, error: recErr } = await db()
              .from("video_recipes")
              .insert({
                user_id: link.user_id,
                project_id: projectId,
                hook_id: chosenHook.id,
                media_asset_id: primaryClip.id,
                duration,
                overlay_text: chosenHook.text,
                overlay_position: "top",
                font_size: 48,
                background_color: isDna ? "#000000_dna" : "#00000000",
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

            const styleValue = isDna ? (batchTotal > 1 ? `dna:batch=${batchTotal}` : "dna") : "single";
            const { error: hintErr } = await db().from("render_job_hints").insert({
              recipe_id: recipe.id,
              user_id: link.user_id,
              with_audio: withAudio,
              soundtrack_url: soundtrackUrl,
              audio_label: audioLabel,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              clip_ids: clips.map((c: any) => c.id),
              style: styleValue,
            });
            if (hintErr) {
              console.error("render_job_hints insert failed", hintErr);
              await sendText(chatId, `❌ Failed to store render settings: ${esc(hintErr.message)}`);
              return Response.json({ ok: true });
            }

            const { data: job, error: jobErr } = await db()
              .from("render_jobs")
              .insert({
                user_id: link.user_id,
                project_id: projectId,
                recipe_id: recipe.id,
                status: "queued",
                progress: 0,
              })
              .select("id")
              .single();

            if (jobErr || !job) {
              await sendText(chatId, `❌ Could not queue render: ${esc(jobErr?.message || "Unknown error")}`);
              return Response.json({ ok: true });
            }

            if (!isDna && batchTotal > 1) {
              for (let i = 1; i < batchTotal; i++) {
                const nextHook = hooks[i % hooks.length] || chosenHook;
                const nextClip = clips[i % clips.length] || primaryClip;
                const { data: extraRec } = await db()
                  .from("video_recipes")
                  .insert({
                    user_id: link.user_id,
                    project_id: projectId,
                    hook_id: nextHook.id,
                    media_asset_id: nextClip.id,
                    duration,
                    overlay_text: nextHook.text,
                    overlay_position: i % 2 === 0 ? "top" : "middle",
                    font_size: 48,
                    background_color: "#00000000",
                    text_color: "#ffffff",
                    width: 1080,
                    height: 1920,
                  })
                  .select("id")
                  .single();

                if (extraRec) {
                  await db().from("render_job_hints").insert({
                    recipe_id: extraRec.id,
                    user_id: link.user_id,
                    with_audio: withAudio,
                    soundtrack_url: soundtrackUrl,
                    audio_label: audioLabel,
                    clip_ids: [primaryClip.id],
                    style: "single",
                  });
                  await db().from("render_jobs").insert({
                    user_id: link.user_id,
                    project_id: projectId,
                    recipe_id: extraRec.id,
                    status: "queued",
                    progress: 0,
                  });
                }
              }
            }

            const modeLabel = isDna ? "🧬 Clip DNA (Multi-clip)" : "⚡ Single Clip";
            await sendText(
              chatId,
              `🚀 <b>Render Queued for ${esc(projectName)}!</b>\n\n` +
              `• <b>Mode:</b> ${modeLabel}\n` +
              `• <b>Duration:</b> ${duration}s\n` +
              `• <b>Batch:</b> ${batchTotal}x\n` +
              `• <b>Sound:</b> ${esc(audioLabel)}\n` +
              `• <b>Hook:</b> "${esc(chosenHook.text)}"\n\n` +
              `<i>Keep your web app open in the background — frames will render in your browser worker now!</i>`
            );
            return Response.json({ ok: true });
          }

          // Approve Preview & Save Single
          if (data.startsWith("approve:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Approved! Saving to library...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) return Response.json({ ok: true });

            const { data: job } = await db().from("render_jobs").select("*").eq("id", jobId).maybeSingle();
            if (!job || !job.output_url) {
              await sendText(chatId, "Job record not found.");
              return Response.json({ ok: true });
            }

            const { data: recipe } = await db().from("video_recipes").select("*").eq("id", job.recipe_id).maybeSingle();

            const thumbPath = job.output_url.replace(/\.[^/.]+$/, ".jpg");
            const { error: insErr } = await db().from("generated_videos").insert({
              user_id: link.user_id,
              project_id: job.project_id,
              render_job_id: job.id,
              recipe_id: job.recipe_id,
              hook_id: recipe?.hook_id ?? null,
              media_asset_id: recipe?.media_asset_id ?? null,
              hook_text: recipe?.overlay_text ?? null,
              output_url: job.output_url,
              thumbnail_url: thumbPath,
              duration: recipe?.duration ?? 8,
              status: "completed",
            });

            if (insErr) {
              await sendText(chatId, `❌ Save failed: ${esc(insErr.message)}`);
              return Response.json({ ok: true });
            }

            await db().from("render_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", job.id);

            await sendText(
              chatId,
              `✅ <b>Video Approved & Saved!</b>\n\nYour video is now in your project library and ready to schedule.`
            );
            return Response.json({ ok: true });
          }

          // Approve DNA Style Preview & Spawn Batch
          if (data.startsWith("apprv_b:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Style approved! Generating batch...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) return Response.json({ ok: true });

            const { data: job } = await db().from("render_jobs").select("*").eq("id", jobId).maybeSingle();
            if (!job || !job.output_url) {
              await sendText(chatId, "Job record not found.");
              return Response.json({ ok: true });
            }

            const { data: recipe } = await db().from("video_recipes").select("*").eq("id", job.recipe_id).maybeSingle();
            await db().from("render_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", job.id);

            const { data: hint } = await db().from("render_job_hints").select("*").eq("recipe_id", job.recipe_id).maybeSingle();
            let batchTotal = 3;
            if (hint?.style && hint.style.includes("batch=")) {
              const match = hint.style.match(/batch=(\d+)/);
              if (match) batchTotal = parseInt(match[1], 10);
            }
            const remaining = Math.max(1, batchTotal);

            const [hooksRes, clipsRes] = await Promise.all([
              db().from("hooks").select("id, text").eq("project_id", job.project_id).order("created_at", { ascending: false }),
              db().from("media_assets").select("id, dna_role").eq("project_id", job.project_id).in("dna_role", ["start", "middle", "end"]),
            ]);

            const hooks = hooksRes.data || [];
            const clips = clipsRes.data || [];

            for (let i = 0; i < remaining; i++) {
              const hook = hooks[(i + 1) % hooks.length] || hooks[0] || { id: null, text: recipe?.overlay_text ?? "" };
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const openerClip = clips.find((c: any) => c.dna_role === "start") || clips[0] || { id: recipe?.media_asset_id };

              const { data: newRecipe } = await db()
                .from("video_recipes")
                .insert({
                  user_id: link.user_id,
                  project_id: job.project_id,
                  hook_id: hook.id,
                  media_asset_id: openerClip.id,
                  duration: recipe?.duration ?? 8,
                  overlay_text: hook.text,
                  overlay_position: i % 2 === 0 ? "top" : "middle",
                  font_size: 48,
                  background_color: "#000000_dna",
                  text_color: "#ffffff",
                  width: 1080,
                  height: 1920,
                })
                .select("id")
                .single();

              if (newRecipe) {
                await db().from("render_job_hints").insert({
                  recipe_id: newRecipe.id,
                  user_id: link.user_id,
                  with_audio: hint?.with_audio ?? false,
                  soundtrack_url: hint?.soundtrack_url ?? null,
                  audio_label: hint?.audio_label ?? "Same audio",
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  clip_ids: clips.map((c: any) => c.id),
                  style: "dna:auto",
                });

                await db().from("render_jobs").insert({
                  user_id: link.user_id,
                  project_id: job.project_id,
                  recipe_id: newRecipe.id,
                  status: "queued",
                  progress: 0,
                });
              }
            }

            await sendText(
              chatId,
              `🚀 <b>Style Approved!</b>\n\nStyle locked in — <b>${remaining} new DNA variants</b> are now rendering!`
            );
            return Response.json({ ok: true });
          }

          // Re-roll: cancel this preview and render a fresh random combination of the same recipe
          if (data.startsWith("reroll:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Re-rolling a new combination...");
            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            const { data: job } = await db().from("render_jobs").select("*").eq("id", jobId).maybeSingle();
            if (!link?.user_id || !job || job.user_id !== link.user_id) {
              await sendText(chatId, "Preview not found.");
              return Response.json({ ok: true });
            }
            await db().from("render_jobs").update({ status: "cancelled" }).eq("id", job.id);
            await db().from("render_jobs").insert({
              user_id: link.user_id,
              project_id: job.project_id,
              recipe_id: job.recipe_id,
              status: "queued",
              progress: 0,
            });
            await sendText(chatId, "🔄 <b>Re-rolling!</b> A new cut is rendering — keep the app open. The new preview will arrive here.");
            return Response.json({ ok: true });
          }

          // Discard Preview
          if (data.startsWith("discard:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Discarded");
            await db().from("render_jobs").update({ status: "cancelled" }).eq("id", jobId);
            await sendText(chatId, "🗑 Preview discarded. Type /render to start a new batch.");
            return Response.json({ ok: true });
          }

          await answerCallback(callbackId);
          return Response.json({ ok: true });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
