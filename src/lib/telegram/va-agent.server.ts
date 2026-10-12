import { getProviderForUser } from "@/lib/ai/provider.server";
import { sendText, tg } from "./bot.server";

export async function sendChatAction(chatId: number, action = "typing") {
  try {
    await tg("sendChatAction", { chat_id: chatId, action });
  } catch (err) {
    console.error("sendChatAction error:", err);
  }
}

function esc(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type ConversationalContext = {
  chatId: number;
  userId: string;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
};

export async function handleTelegramConversationalMessage({
  chatId,
  userId,
  text,
  supabase,
}: ConversationalContext) {
  await sendChatAction(chatId, "typing");

  // 1. Gather User's Context
  const [
    projectsRes,
    videosRes,
    socialRes,
    trendingRes,
    scheduledRes,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("generated_videos")
      .select("id, project_id, hook_text, output_url, duration, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("social_accounts")
      .select("id, platform, account_handle, display_name, status")
      .eq("user_id", userId)
      .eq("status", "connected"),
    supabase
      .from("trending_audios")
      .select("id, title, author")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("scheduled_posts")
      .select("id, caption, scheduled_for, status")
      .eq("user_id", userId)
      .in("status", ["queued", "scheduled", "posting"])
      .order("scheduled_for", { ascending: true })
      .limit(5),
  ]);

  const projects = projectsRes.data || [];
  const projectIds = projects.map((p: { id: string }) => p.id);

  // Fetch asset and hook counts per project
  let clips: Array<{ id: string; project_id: string; filename: string; duration: number; dna_role: string | null }> = [];
  let hooks: Array<{ id: string; project_id: string; text: string }> = [];

  if (projectIds.length > 0) {
    const [clipsRes, hooksRes] = await Promise.all([
      supabase
        .from("media_assets")
        .select("id, project_id, filename, duration, dna_role")
        .in("project_id", projectIds),
      supabase
        .from("hooks")
        .select("id, project_id, text")
        .in("project_id", projectIds),
    ]);
    clips = clipsRes.data || [];
    hooks = hooksRes.data || [];
  }

  const projectsSummary = projects.map((p: { id: string; name: string }) => {
    const pClips = clips.filter((c) => c.project_id === p.id);
    const pHooks = hooks.filter((h) => h.project_id === p.id);
    const taggedDna = pClips.filter((c) => ["start", "middle", "end"].includes(c.dna_role || ""));
    return {
      id: p.id,
      name: p.name,
      clipCount: pClips.length,
      dnaTaggedClips: taggedDna.length,
      hookCount: pHooks.length,
      recentHooks: pHooks.slice(0, 3).map((h) => h.text),
    };
  });

  const recentVideos = (videosRes.data || []).map((v: { id: string; project_id: string; hook_text: string | null; duration: number; created_at: string }) => {
    const proj = projects.find((p: { id: string; name: string }) => p.id === v.project_id);
    return {
      id: v.id,
      projectName: proj?.name || "Unknown",
      hook: v.hook_text || "No hook",
      duration: v.duration,
      created: v.created_at,
    };
  });

  const socialAccounts = (socialRes.data || []).map((s: { id: string; platform: string; account_handle: string }) => ({
    id: s.id,
    platform: s.platform,
    handle: s.account_handle,
  }));

  const trendingAudios = (trendingRes.data || []).map((t: { id: string; title: string; author: string | null }) => ({
    id: t.id,
    title: t.title,
    author: t.author,
  }));

  const upcomingPosts = (scheduledRes.data || []).map((sp: { id: string; caption: string; scheduled_for: string; status: string }) => ({
    id: sp.id,
    caption: sp.caption.slice(0, 40),
    scheduledFor: sp.scheduled_for,
    status: sp.status,
  }));

  // 2. Ask AI to interpret user intent
  const systemPrompt = `You are Creative Factory VA, an elite executive video assistant inside Telegram.
You help creators run video render batches, schedule posts to social media, inspect creative assets, and brainstorm viral hooks.
Always speak warmly, concisely, and directly. Never say you are an AI model or refer to internal code.

USER DATA:
- Projects: ${JSON.stringify(projectsSummary)}
- Recent Rendered Videos: ${JSON.stringify(recentVideos)}
- Connected Social Accounts: ${JSON.stringify(socialAccounts)}
- Trending Sounds: ${JSON.stringify(trendingAudios)}
- Scheduled Posts: ${JSON.stringify(upcomingPosts)}

YOUR TASK:
Interpret the user's message and determine what action to execute.
Return STRICT JSON ONLY matching one of these action schemas:

1. RENDER ACTION (user wants to render or generate videos):
{
  "action": "render",
  "projectId": "<matched project ID from USER DATA>",
  "style": "single" | "dna", // default "single" unless user mentions DNA, multi-cut, sequence, combo
  "duration": number, // default 8, or 6, 8, 10, 15
  "batchTotal": number, // 1, 3, 5, etc. default 1
  "audioChoice": "tr" | "or" | "si" | "lb_<id>", // "tr" = trending auto-pick (default), "or" = original, "si" = silent
  "explanation": "One friendly line confirming what you're rendering"
}

2. ASK RENDER DETAILS (user wants to render but project is ambiguous or missing):
{
  "action": "ask_render_details",
  "message": "Question asking which project or clarification",
  "quickProjectButtons": true // true if we should show their projects as buttons
}

3. SCHEDULE ACTION (user wants to schedule/post a video):
{
  "action": "schedule",
  "videoId": "<id of video to schedule, or 'latest'>",
  "caption": "<suggested caption with hook and hashtags, or user's requested caption>",
  "scheduledFor": "<ISO date string or 'now'>",
  "socialAccountId": "<matched social account ID, or first available>"
}

4. GENERATE HOOKS (user asks for hook ideas, scripts, or angles):
{
  "action": "generate_hooks",
  "productOrTopic": "<topic>",
  "hooks": ["hook 1", "hook 2", "hook 3", "hook 4", "hook 5"],
  "tip": "Short high-converting tip"
}

5. STATUS / QUERY / CHAT (user asks a question about projects, clips, status, schedule, or general advice):
{
  "action": "chat",
  "reply": "Formatted HTML response with emojis, bullet points, clean and concise."
}
`;

  try {
    const ai = await getProviderForUser(userId, supabase);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decision = await ai.completeJson<any>([
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ]);

    if (!decision || typeof decision !== "object") {
      await sendText(
        chatId,
        "🤖 I understood your message! What would you like to do? Type /render to start the render wizard or /help to see options."
      );
      return;
    }

    // Handle Render Action
    if (decision.action === "render") {
      let targetProjectId = decision.projectId;
      if (!targetProjectId && projects.length === 1) {
        targetProjectId = projects[0].id;
      }

      if (!targetProjectId) {
        const keyboard = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inline_keyboard: projects.map((p: any) => [
            { text: `📁 ${p.name}`, callback_data: `step_proj:${p.id}` },
          ]),
        };
        await sendText(
          chatId,
          `🎬 <b>Which project would you like to render for?</b>`,
          keyboard
        );
        return;
      }

      const project = projects.find((p: { id: string }) => p.id === targetProjectId);
      const projectName = project?.name || "Project";
      const style = decision.style === "dna" ? "d" : "s";
      const isDna = style === "d";
      const duration = Number(decision.duration) || 8;
      const batchTotal = Math.max(1, Math.min(10, Number(decision.batchTotal) || 1));
      const audioChoice = decision.audioChoice || "tr";

      // Verify Project Assets
      const [hooksRes, clipsRes] = await Promise.all([
        supabase.from("hooks").select("id, text").eq("project_id", targetProjectId).order("created_at", { ascending: false }),
        supabase.from("media_assets").select("id, filename, duration, storage_path, dna_role").eq("project_id", targetProjectId),
      ]);

      const pHooks = hooksRes.data || [];
      const pClips = clipsRes.data || [];

      if (pHooks.length === 0) {
        await sendText(chatId, `❌ Project "<b>${esc(projectName)}</b>" has no hooks. Add hooks in the web app or ask me to write some hooks for you!`);
        return;
      }

      if (isDna) {
        const tagged = pClips.filter((c: { dna_role?: string | null }) => ["start", "middle", "end"].includes(c.dna_role || ""));
        if (tagged.length < 2) {
          await sendText(
            chatId,
            `❌ Project "<b>${esc(projectName)}</b>" needs at least 2 DNA-tagged clips (Start/Middle/End) for Clip DNA. Tag them in the app's Media tab first.`
          );
          return;
        }
      } else {
        if (pClips.length === 0) {
          await sendText(chatId, `❌ Project "<b>${esc(projectName)}</b>" has no media clips. Upload clips in the app first.`);
          return;
        }
      }

      // Audio setup
      let withAudio = false;
      let soundtrackUrl: string | null = null;
      let audioLabel = "None";

      if (audioChoice === "or") {
        withAudio = true;
        audioLabel = "Original clip audio";
      } else if (audioChoice === "tr") {
        const { data: tr } = await supabase
          .from("trending_audios")
          .select("id, title, audio_url")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (tr && tr.audio_url) {
          soundtrackUrl = tr.audio_url;
          audioLabel = tr.title || "Trending audio";
        } else {
          withAudio = true;
          audioLabel = "Original clip audio (no trending sound saved)";
        }
      } else if (audioChoice.startsWith("lb_")) {
        const trackIdPrefix = audioChoice.slice(3);
        const { data: tr } = await supabase
          .from("trending_audios")
          .select("id, title, audio_url")
          .eq("user_id", userId)
          .ilike("id", `${trackIdPrefix}%`)
          .limit(1)
          .maybeSingle();

        if (tr && tr.audio_url) {
          soundtrackUrl = tr.audio_url;
          audioLabel = tr.title || "Library audio";
        }
      }

      const chosenHook = pHooks[0]!;
      const primaryClip = isDna
        ? pClips.find((c: { dna_role?: string | null }) => c.dna_role === "start") || pClips[0]!
        : pClips[0]!;

      // Insert primary recipe
      const { data: recipe, error: recErr } = await supabase
        .from("video_recipes")
        .insert({
          user_id: userId,
          project_id: targetProjectId,
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
        return;
      }

      const styleValue = isDna ? (batchTotal > 1 ? `dna:batch=${batchTotal}` : "dna") : "single";
      await supabase.from("render_job_hints").insert({
        recipe_id: recipe.id,
        user_id: userId,
        with_audio: withAudio,
        soundtrack_url: soundtrackUrl,
        audio_label: audioLabel,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clip_ids: pClips.map((c: any) => c.id),
        style: styleValue,
      });

      await supabase.from("render_jobs").insert({
        user_id: userId,
        project_id: targetProjectId,
        recipe_id: recipe.id,
        status: "queued",
        progress: 0,
      });

      // Extra recipes for single batch
      if (!isDna && batchTotal > 1) {
        for (let i = 1; i < batchTotal; i++) {
          const nextHook = pHooks[i % pHooks.length] || chosenHook;
          const nextClip = pClips[i % pClips.length] || primaryClip;
          const { data: extraRec } = await supabase
            .from("video_recipes")
            .insert({
              user_id: userId,
              project_id: targetProjectId,
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
            await supabase.from("render_job_hints").insert({
              recipe_id: extraRec.id,
              user_id: userId,
              with_audio: withAudio,
              soundtrack_url: soundtrackUrl,
              audio_label: audioLabel,
              clip_ids: [primaryClip.id],
              style: "single",
            });
            await supabase.from("render_jobs").insert({
              user_id: userId,
              project_id: targetProjectId,
              recipe_id: extraRec.id,
              status: "queued",
              progress: 0,
            });
          }
        }
      }

      const modeLabel = isDna ? "🧬 Clip DNA (Multi-clip)" : "⚡ Single Clip Cut";
      await sendText(
        chatId,
        `🚀 <b>Render Queued for ${esc(projectName)}!</b>\n\n` +
        `• <b>Mode:</b> ${modeLabel}\n` +
        `• <b>Duration:</b> ${duration}s\n` +
        `• <b>Batch:</b> ${batchTotal}x\n` +
        `• <b>Sound:</b> ${esc(audioLabel)}\n` +
        `• <b>Hook:</b> "${esc(chosenHook.text)}"\n\n` +
        `<i>Keep your web app tab open — frames are rendering in your background worker!</i>`
      );
      return;
    }

    if (decision.action === "ask_render_details") {
      const keyboard = decision.quickProjectButtons && projects.length > 0
        ? {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            inline_keyboard: projects.map((p: any) => [
              { text: `📁 ${p.name}`, callback_data: `step_proj:${p.id}` },
            ]),
          }
        : undefined;

      await sendText(chatId, decision.message || "Which project would you like to render for?", keyboard);
      return;
    }

    if (decision.action === "schedule") {
      if (socialAccounts.length === 0) {
        await sendText(
          chatId,
          "⚠️ <b>No social accounts connected!</b> Connect your TikTok account in the web app under Accounts to schedule posts."
        );
        return;
      }

      let videoId = decision.videoId;
      if (!videoId || videoId === "latest") {
        const latest = recentVideos[0];
        if (!latest) {
          await sendText(chatId, "⚠️ You don't have any rendered videos yet to schedule! Render a video first.");
          return;
        }
        videoId = latest.id;
      }

      const video = recentVideos.find((v: { id: string }) => v.id === videoId) || recentVideos[0];
      const account = socialAccounts[0];
      const when = decision.scheduledFor && decision.scheduledFor !== "now"
        ? new Date(decision.scheduledFor)
        : new Date(Date.now() + 60 * 60 * 1000);

      const caption = decision.caption || `${video.hook || "Check this out!"}\n\n#fyp #viral #trending`;

      const { error: sErr } = await supabase
        .from("scheduled_posts")
        .insert({
          user_id: userId,
          generated_video_id: video.id,
          project_id: projects[0]?.id || null,
          social_account_id: account.id,
          caption,
          scheduled_for: when.toISOString(),
          status: "queued",
        })
        .select("id")
        .single();

      if (sErr) {
        await sendText(chatId, `❌ Failed to schedule: ${esc(sErr.message)}`);
        return;
      }

      await sendText(
        chatId,
        `🗓 <b>Post Scheduled!</b>\n\n` +
        `• <b>Account:</b> @${esc(account.handle)} (${account.platform})\n` +
        `• <b>Time:</b> ${when.toUTCString().slice(0, 22)} UTC\n` +
        `• <b>Caption:</b> "${esc(caption.slice(0, 100))}${caption.length > 100 ? "..." : ""}"\n\n` +
        `<i>I'll publish it when the time arrives!</i>`
      );
      return;
    }

    if (decision.action === "generate_hooks") {
      const hooksList = (decision.hooks || [])
        .map((h: string, idx: number) => `<b>${idx + 1}.</b> "${esc(h)}"`)
        .join("\n\n");

      await sendText(
        chatId,
        `💡 <b>Viral Hook Ideas for ${esc(decision.productOrTopic || "your brand")}:</b>\n\n` +
        `${hooksList}\n\n` +
        (decision.tip ? `🎯 <i>Pro tip: ${esc(decision.tip)}</i>\n\n` : "") +
        `<i>Want me to render videos with any of these? Just tell me "Render with hook #1 for [Project]"!</i>`
      );
      return;
    }

    // Default chat reply
    const replyText = decision.reply || "I'm your Creative Factory VA. Tell me what you'd like to render, schedule, or create!";
    await sendText(chatId, replyText);
  } catch (err) {
    console.error("handleTelegramConversationalMessage error:", err);
    await sendText(
      chatId,
      "⚡ I received your message! You can also use /render to start the step-by-step wizard anytime."
    );
  }
}
