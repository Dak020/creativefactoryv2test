import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { createHash, timingSafeEqual } from "crypto";
import { tg, sendText, answerCallback } from "@/lib/telegram/bot.server";

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
        { text: "Single Clip Cut", callback_data: `st_s:${projectId}` },
        { text: "Clip DNA (Multi-Cut)", callback_data: `st_d:${projectId}` },
      ],
      [{ text: "Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function buildDurationKeyboard(projectId: string, style: string) {
  const prefix = style === "dna" ? "dur_d" : "dur_s";
  return {
    inline_keyboard: [
      [
        { text: "6s", callback_data: `${prefix}:6:${projectId}` },
        { text: "8s (Default)", callback_data: `${prefix}:8:${projectId}` },
      ],
      [
        { text: "10s", callback_data: `${prefix}:10:${projectId}` },
        { text: "15s", callback_data: `${prefix}:15:${projectId}` },
      ],
      [{ text: "Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function buildBatchSelectKeyboard(projectId: string, style: string, duration: number) {
  const prefix = style === "dna" ? "bch_d" : "bch_s";
  return {
    inline_keyboard: [
      [
        { text: "1x Single", callback_data: `${prefix}:1:${duration}:${projectId}` },
        { text: "3x Variants", callback_data: `${prefix}:3:${duration}:${projectId}` },
        { text: "5x Variants", callback_data: `${prefix}:5:${duration}:${projectId}` },
      ],
      [{ text: "Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function deriveTelegramWebhookSecret(telegramApiKey: string): string {
  return createHash("sha256")
    .update(`telegram-webhook:${telegramApiKey}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

let _supabase: ReturnType<typeof createClient> | null = null;
function db() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _supabase;
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
        if (!TELEGRAM_API_KEY) {
          return new Response("TELEGRAM_API_KEY is not configured", { status: 500 });
        }

        const expectedSecret = deriveTelegramWebhookSecret(TELEGRAM_API_KEY);
        const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actualSecret, expectedSecret)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const update = await request.json();

        // 1. Handle Slash Commands & Text Messages
        if (update.message) {
          const msg = update.message;
          const chatId = msg.chat?.id;
          const text = (msg.text || "").trim();

          if (!chatId) return Response.json({ ok: true });

          if (text.startsWith("/start")) {
            const parts = text.split(" ");
            const token = parts[1]?.trim();

            if (!token) {
              await sendText(
                chatId,
                `👋 <b>Welcome to Creative Factory Bot!</b>\n\nTo link your account, open Settings → Integrations in the web app and click Connect Telegram.`
              );
              return Response.json({ ok: true });
            }

            // Verify connection token
            const { data: linkCode } = await db()
              .from("telegram_link_codes")
              .select("user_id, expires_at")
              .eq("code", token)
              .maybeSingle();

            if (!linkCode || new Date(linkCode.expires_at) < new Date()) {
              await sendText(
                chatId,
                `❌ This link code has expired or is invalid. Please generate a new code in the web app.`
              );
              return Response.json({ ok: true });
            }

            await db().from("telegram_links").upsert(
              {
                user_id: linkCode.user_id,
                chat_id: chatId,
                username: msg.from?.username ?? null,
                first_name: msg.from?.first_name ?? null,
                linked_at: new Date().toISOString(),
              },
              { onConflict: "chat_id" }
            );

            await sendText(
              chatId,
              `✅ <b>Account linked successfully!</b>\n\n` +
              `You can now control rendering, approve Clip DNA variations, and receive 9:16 video deliveries right here.\n\n` +
              `Type /render to start creating videos.`
            );
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
              inline_keyboard: projects.map((p) => [
                { text: `📁 ${p.name}`, callback_data: `step_style:${p.id}` },
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

          // Step 1: Choose Style (Single vs. Clip DNA)
          if (data.startsWith("step_style:")) {
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
              `🎬 <b>Project: ${esc(projectName)}</b>\n\n<b>Step 1 of 4: Choose Render Style</b>\n\n` +
              `• <b>Single Clip</b>: Quick render of your primary clip with styled hook\n` +
              `• <b>Clip DNA</b>: Smart multi-clip sequence solver (combines hook, body, and CTA clips)`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 2: Choose Duration (6s, 8s default, 10s, 15s)
          if (data.startsWith("step_dur:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "dna" : "single";
            const projectId = parts[2];
            await answerCallback(callbackId);

            const keyboard = buildDurationKeyboard(projectId, style);
            await editMessageText(
              chatId,
              messageId,
              `⏱️ <b>Step 2 of 4: Choose Target Duration</b>\n\n` +
              `Select the target duration for this ${style === "dna" ? "Clip DNA sequence" : "single clip"}:`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 3: Choose Batch Quantity (1x, 3x, 5x)
          if (data.startsWith("step_bat:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "dna" : "single";
            const duration = parseInt(parts[2], 10) || 8;
            const projectId = parts[3];
            await answerCallback(callbackId);

            const keyboard = buildBatchSelectKeyboard(projectId, style, duration);
            await editMessageText(
              chatId,
              messageId,
              `📦 <b>Step 3 of 4: Choose Batch Quantity</b>\n\n` +
              `• <b>1x Single</b>: Render 1 video\n` +
              `• <b>3x / 5x Variants</b>: Multiple cuts with randomized hooks & speed ramping\n\n` +
              (style === "dna"
                ? `<i>Note: For DNA batches, a style preview is sent here first. Once you approve, the remaining batch renders automatically.</i>`
                : `<i>Note: Single batches render all variants straight into your library.</i>`),
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 4: Choose Audio Soundtrack
          if (data.startsWith("step_aud:")) {
            const parts = data.split(":");
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
                .not("storage_path", "is", null)
                .order("created_at", { ascending: false })
                .limit(3);
              libraryTracks = (tracks || []).map((t) => ({ id: t.id, name: t.title }));
            }

            const prefix = `do_rend:${parts[1]}:${duration}:${batch}:${projectId}`;
            const keyboard = {
              inline_keyboard: [
                [{ text: "🔥 VA Trending Sound (Auto-Pick)", callback_data: `${prefix}:va` }],
                [{ text: "📹 Original Clip Audio (Keep Voice)", callback_data: `${prefix}:orig` }],
                ...libraryTracks.map((t) => [
                  { text: `🎵 ${t.name.slice(0, 26)}`, callback_data: `${prefix}:lib_${t.id.slice(0, 8)}` },
                ]),
                [{ text: "🔇 Silent (No Audio)", callback_data: `${prefix}:none` }],
                [{ text: "« Back to Batch", callback_data: `step_bat:${parts[1]}:${duration}:${projectId}` }],
              ],
            };

            await editMessageText(
              chatId,
              messageId,
              `🎵 <b>Step 4 of 4: Choose Audio & Music</b>\n\n` +
              `Configure the audio for your render:\n` +
              `• <b>VA Trending</b>: High-converting viral background track\n` +
              `• <b>Original Clip</b>: Keeps the speech/sound from original video\n` +
              `• <b>Silent</b>: Video-only stream (perfect for in-app voiceover)`,
              keyboard
            );
            return Response.json({ ok: true });
          }

          // Step 5: Execute Render Queueing
          if (data.startsWith("do_rend:")) {
            const parts = data.split(":");
            const style = parts[1] === "d" ? "dna" : "single";
            const isDna = style === "dna";
            const targetDuration = parseInt(parts[2], 10) || 8;
            const batchTotal = parseInt(parts[3], 10) || 1;
            const projectId = parts[4];
            const audioKey = parts[5] || "orig";

            await answerCallback(callbackId, "Queueing render job...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "⚠️ User link not found. Please relink your Telegram account.");
              return Response.json({ ok: true });
            }

            const [projRes, hooksRes, clipsRes] = await Promise.all([
              db().from("projects").select("name").eq("id", projectId).maybeSingle(),
              db().from("hooks").select("id, text").eq("project_id", projectId).order("created_at", { ascending: false }),
              db().from("media_assets").select("id, dna_role").eq("project_id", projectId).order("created_at", { ascending: false }),
            ]);

            const projectName = projRes.data?.name || "Project";
            const hooks = hooksRes.data || [];
            const allClips = clipsRes.data || [];
            const dnaClips = allClips.filter((c) => c.dna_role === "start" || c.dna_role === "middle" || c.dna_role === "end");
            const clips = isDna ? dnaClips : allClips;

            if (allClips.length === 0) {
              await sendText(chatId, `❌ No video clips found in <b>${esc(projectName)}</b>. Upload clips in the app first.`);
              return Response.json({ ok: true });
            }
            if (isDna && (dnaClips.length < 2 || !dnaClips.some((c) => c.dna_role === "start"))) {
              await sendText(
                chatId,
                `❌ <b>${esc(projectName)}</b> needs at least 2 DNA-tagged clips (one tagged <b>Start</b>) for Clip DNA.\n\nOpen Media Library in the app and set each clip's DNA Role.`,
              );
              return Response.json({ ok: true });
            }

            const primaryHook = hooks[0] || { id: null, text: "Wait for the end..." };
            const primaryClip = clips.find((c) => c.dna_role === "start") || clips[0]!;

            let withAudio = false;
            let soundtrackUrl: string | null = null;
            let audioLabel = "Original clip audio";

            if (audioKey === "orig") {
              withAudio = true;
              audioLabel = "Original clip audio";
            } else if (audioKey === "va" || audioKey.startsWith("lib_")) {
              withAudio = false;
              let q = db()
                .from("trending_audios")
                .select("id, title, storage_path")
                .not("storage_path", "is", null);
              if (audioKey === "va") {
                q = q.or(`user_id.eq.${link.user_id},user_id.is.null`).order("virality_score", { ascending: false });
              } else {
                q = q.eq("user_id", link.user_id).order("created_at", { ascending: false });
              }
              const { data: tracks } = await q.limit(20);
              const prefix = audioKey.replace("lib_", "");
              const pool = tracks || [];
              const track =
                audioKey === "va"
                  ? pool[Math.floor(Math.random() * Math.min(5, pool.length))]
                  : pool.find((t) => t.id.startsWith(prefix));
              if (track?.storage_path) {
                // Private bucket: the browser worker signs this path at render time.
                soundtrackUrl = `media:${track.storage_path}`;
                audioLabel = audioKey === "va" ? `VA: ${track.title}` : track.title;
              } else {
                withAudio = true;
                audioLabel = "Original clip audio (no saved sound found)";
              }
            } else if (audioKey === "none") {
              withAudio = false;
              audioLabel = "Silent (No audio)";
            }

            await deleteMessage(chatId, messageId);

            const { data: recipe, error: recErr } = await db()
              .from("video_recipes")
              .insert({
                user_id: link.user_id,
                project_id: projectId,
                hook_id: primaryHook.id,
                media_asset_id: primaryClip.id,
                duration: targetDuration,
                overlay_text: primaryHook.text,
                overlay_position: "top",
                font_size: 48,
                background_color: isDna ? "#000000_dna" : "#000000_single",
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

            // Encode batch count in style string without requiring a non-existent batch_total column
            const styleValue = isDna ? (batchTotal > 1 ? `dna:batch=${batchTotal}` : "dna") : "single";
            const { error: hintErr } = await db().from("render_job_hints").insert({
              recipe_id: recipe.id,
              user_id: link.user_id,
              with_audio: withAudio,
              soundtrack_url: soundtrackUrl,
              audio_label: audioLabel,
              clip_ids: clips.map((c) => c.id),
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
                const hookItem = hooks[i % hooks.length]!;
                const { data: extraRec } = await db()
                  .from("video_recipes")
                  .insert({
                    user_id: link.user_id,
                    project_id: projectId,
                    hook_id: hookItem.id,
                    media_asset_id: primaryClip.id,
                    duration: targetDuration,
                    overlay_text: hookItem.text,
                    overlay_position: "top",
                    font_size: 48,
                    background_color: "#000000_single",
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
              `• <b>Style:</b> ${modeLabel}\n` +
              `• <b>Duration:</b> ${targetDuration}s\n` +
              `• <b>Batch:</b> ${batchTotal} variant${batchTotal > 1 ? "s" : ""}\n` +
              `• <b>Sound:</b> ${esc(audioLabel)}\n` +
              `• <b>Hook:</b> "${esc(primaryHook.text)}"\n\n` +
              (isDna
                ? `A 9:16 preview will be sent here for your approval${batchTotal > 1 ? ` before generating the remaining ${batchTotal - 1} variants.` : "."}`
                : `Keep your Creative Factory browser tab open. The ${batchTotal > 1 ? `${batchTotal} videos` : "video"} will auto-save to your library once rendered.`)
            );
            return Response.json({ ok: true });
          }

          // Approve Preview: Single DNA video approval
          if (data.startsWith("approve:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Saving video to library...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (link?.user_id) {
              const { data: job } = await db().from("render_jobs").select("*").eq("id", jobId).maybeSingle();
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

                await db().from("render_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", job.id);

                await sendText(
                  chatId,
                  `✅ <b>Clip DNA Video Approved!</b>\n\nSaved to your project library and ready to schedule in the web app!`
                );
                return Response.json({ ok: true });
              }
            }
            await sendText(chatId, `✅ <b>Approved!</b> Video saved to library.`);
            return Response.json({ ok: true });
          }

          // Approve Preview & Spawn Batch
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
            await db().from("render_jobs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", job.id);

            const { data: hint } = await db().from("render_job_hints").select("*").eq("recipe_id", job.recipe_id).maybeSingle();
            let batchTotal = 3;
            if (hint?.style && hint.style.includes("batch=")) {
              const match = hint.style.match(/batch=(\d+)/);
              if (match) batchTotal = parseInt(match[1], 10);
            }
            const remaining = Math.max(1, batchTotal - 1);

            const [hooksRes, clipsRes] = await Promise.all([
              db().from("hooks").select("id, text").eq("project_id", job.project_id).order("created_at", { ascending: false }),
              db().from("media_assets").select("id, dna_role").eq("project_id", job.project_id).in("dna_role", ["start", "middle", "end"]),
            ]);

            const hooks = hooksRes.data || [];
            const clips = clipsRes.data || [];

            for (let i = 0; i < remaining; i++) {
              const hook = hooks[(i + 1) % hooks.length] || hooks[0] || { id: null, text: recipe?.overlay_text ?? "" };
              const openerClip = clips.find((c) => c.dna_role === "start") || clips[0] || { id: recipe?.media_asset_id };

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
                  clip_ids: clips.map((c) => c.id),
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
              `🚀 <b>Style Approved!</b>\n\nPreview saved to your library, and the remaining <b>${remaining} DNA variants</b> are now rendering!`
            );
            return Response.json({ ok: true });
          }

          // Discard Preview
          if (data.startsWith("discard:")) {
            const jobId = data.split(":")[1];
            await answerCallback(callbackId, "Preview discarded.");
            await db().from("render_jobs").update({ status: "cancelled" }).eq("id", jobId);
            await sendText(chatId, `🗑️ <b>Preview discarded.</b> You can run /render whenever you're ready to try another cut.`);
            return Response.json({ ok: true });
          }

          return Response.json({ ok: true });
        }

        return Response.json({ ok: true });
      },
    },
  },
});
