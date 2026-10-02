import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";
import { answerCallback, botKey, botToken, sendText, webhookSecret } from "@/lib/telegram/bot.server";

const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

const HELP = [
  "<b>Creative Factory VA Commands</b>",
  "/status — workspace overview",
  "/projects — your active projects",
  "/addhook — pick a project & paste a new hook",
  "/clips — your latest clips",
  "/trends — top trending sounds",
  "/schedule — upcoming posts",
  "/help — this list",
].join("\n");

function db() {
  return createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_PUBLISHABLE_KEY"]!, {
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

        // 1. Handle Inline Button Clicks
        if (update?.callback_query) {
          const cb = update.callback_query;
          const callbackId = cb.id;
          const data = String(cb.data || "");
          const chatId = cb.message?.chat?.id;

          if (data.startsWith("select_project_hook:")) {
            const [_, projectId, projectName] = data.split(":");
            await answerCallback(callbackId);

            // Prompt user with ForceReply to capture their hook text
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

        // Check if this is a reply to the "Reply directly to this message with your hook text" prompt
        if (msg.reply_to_message?.text && msg.reply_to_message.text.includes("Reply directly to this message with your hook text")) {
          const idMatch = msg.reply_to_message.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (idMatch) {
            const projectId = idMatch[0];

            // Lookup the user linked to this chat
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
                await sendText(chatId, `✅ <b>Hook added successfully!</b>\n\n"<i>${esc(text)}</i>"\n\nIt is now saved in your project's hook library.`);
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

          // Handle /projects command
          if (cmd === "projects") {
            const { data: link } = await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
            if (!link?.user_id) {
              await sendText(chatId, "Please connect your Telegram account first in Settings.");
              return Response.json({ ok: true });
            }
            const { data: projs } = await db().from("projects").select("id, name, content_style").eq("user_id", link.user_id);
            if (!projs || projs.length === 0) {
              await sendText(chatId, "📁 No projects found. Create one in the app first.");
            } else {
              const list = projs.map((p, i) => `${i + 1}. <b>${esc(p.name)}</b> (${esc(p.content_style || "general")})`).join("\n");
              await sendText(chatId, `📁 <b>Your Projects:</b>\n\n${list}\n\nUse /addhook to add a hook to one.`);
            }
            return Response.json({ ok: true });
          }

          // Handle /addhook command: show project picker buttons
          if (cmd === "addhook") {
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

            // Create inline keyboard with a button for each project
            const inlineKeyboard = projs.slice(0, 8).map((p) => [
              {
                text: `📁 ${p.name.slice(0, 25)}`,
                callback_data: `select_project_hook:${p.id}:${p.name.slice(0, 20)}`,
              },
            ]);

            await sendText(
              chatId,
              "🎯 <b>Select the project</b> you want to add a hook to:",
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
