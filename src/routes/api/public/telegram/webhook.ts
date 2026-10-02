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

          // Open project dashboard
          if (data.startsWith("open_project:")) {
            const projectId = data.split(":")[1];
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
                  { text: "➕ Add Hook", callback_data: `select_project_hook:${proj.id}:${proj.name.slice(0, 20)}` },
                  { text: `📝 View Hooks (${hookCount})`, callback_data: `view_hooks:${proj.id}:${proj.name.slice(0, 20)}` },
                ],
                [
                  { text: "🚀 Queue Test Render", callback_data: `queue_render:${proj.id}:${proj.name.slice(0, 20)}` },
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
                  { text: `📁 ${p.name.slice(0, 25)}`, callback_data: `open_project:${p.id}` },
                ]),
              };
              await sendText(chatId, "📁 <b>Your Projects:</b>\nTap a project to work in it:", keyboard);
            }
            return Response.json({ ok: true });
          }

          // View hooks for a project
          if (data.startsWith("view_hooks:")) {
            const [_, projectId, projectName] = data.split(":");
            await answerCallback(callbackId);

            const { data: hooks } = await db()
              .from("hooks")
              .select("text, is_winner")
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
              .limit(8);

            if (!hooks || hooks.length === 0) {
              await sendText(
                chatId,
                `📝 No hooks found in <b>${esc(projectName)}</b>.\nUse the button below to add one.`,
                {
                  inline_keyboard: [
                    [{ text: "➕ Add Hook", callback_data: `select_project_hook:${projectId}:${projectName}` }],
                    [{ text: "🔙 Back to Project", callback_data: `open_project:${projectId}` }],
                  ],
                }
              );
            } else {
              const hookList = hooks.map((h, i) => `${i + 1}. "${esc(h.text)}"${h.is_winner ? " ⭐" : ""}`).join("\n\n");
              await sendText(
                chatId,
                `📝 <b>Hooks in ${esc(projectName)}:</b>\n\n${hookList}`,
                {
                  inline_keyboard: [
                    [{ text: "➕ Add Another Hook", callback_data: `select_project_hook:${projectId}:${projectName}` }],
                    [{ text: "🔙 Back to Project", callback_data: `open_project:${projectId}` }],
                  ],
                }
              );
            }
            return Response.json({ ok: true });
          }

          // Queue Render for a project
          if (data.startsWith("queue_render:")) {
            const [_, projectId, projectName] = data.split(":");
            await answerCallback(callbackId, "Queueing render...");

            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (link?.user_id) {
              const { error: jobErr } = await db().from("render_jobs").insert({
                user_id: link.user_id,
                project_id: projectId,
                status: "queued",
                source: "telegram",
              });

              if (jobErr) {
                await sendText(chatId, `❌ Could not queue render: ${esc(jobErr.message)}`);
              } else {
                await sendText(
                  chatId,
                  `🚀 <b>Render Queued for ${esc(projectName)}!</b>\n\n` +
                  `Keep your Creative Factory browser tab open. The browser will pick up this job, render the video, and the preview will be sent here.`
                );
              }
            }
            return Response.json({ ok: true });
          }

          // Add Hook prompt
          if (data.startsWith("select_project_hook:")) {
            const parts = data.split(":");
            const projectId = parts[1];
            const projectName = parts[2];
            await answerCallback(callbackId);

            await sendText(
              chatId,
              `🎯 Selected: <b>${esc(projectName || "Project")}</b>\n(ID: <code>${projectId}</code>)\n\nReply directly to this message with your hook text:`,
              { force_reply: true, selective: true }
            );
            return Response.json({ ok: true });
          }

          if (data.startsWith("approve:")) {
            await answerCallback(callbackId, "Style Approved!");
            await sendText(
              chatId,
              `✅ <b>Style Approved!</b>\nStarting batch render for project. Keep your browser open to complete rendering.`
            );
            return Response.json({ ok: true });
          }

          if (data.startsWith("discard:")) {
            await answerCallback(callbackId, "Discarded");
            await sendText(chatId, `❌ <b>Preview discarded.</b> You can generate a new preview anytime.`);
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

        // Handle reply to hook prompt
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
                      [{ text: "📁 Open Project", callback_data: `open_project:${projectId}` }],
                      [{ text: "➕ Add Another Hook", callback_data: `select_project_hook:${projectId}:Project` }],
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

          // Handle /projects command: clickable buttons for every project
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
                  callback_data: `open_project:${p.id}`,
                },
              ]);

              await sendText(
                chatId,
                "📁 <b>Your Projects:</b>\nTap any project below to open its workspace and actions:",
                { inline_keyboard: inlineKeyboard }
              );
            }
            return Response.json({ ok: true });
          }

          // Handle /addhook command: show project picker buttons
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
              {
                text: `📁 ${p.name.slice(0, 25)}`,
                callback_data: `select_project_hook:${p.id}:${p.name.slice(0, 20)}`,
              },
            ]);

            await sendText(
              chatId,
              "🎯 <b>Select the project</b> to add a hook to:",
              { inline_keyboard: inlineKeyboard }
            );
            return Response.json({ ok: true });
          }

          const known = ["status", "clips", "trends", "schedule"];
          const command = known.includes(cmd) ? cmd : "help";
          const { data, error } = await db().rpc("telegram_command" as any, { _chat_id: chatId, _key: key, _cmd: command });
          if (error) throw error;
          const res = data as { linked: boolean; data: unknown };
          if (!res?.linked) {
            await sendText(
              chatId,
              "Hi! Open Settings in the Creative Factory app and tap <b>Connect Telegram</b> to link me to your account."
            );
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
