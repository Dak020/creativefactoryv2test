import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "crypto";
import { botKey, botToken, sendText, webhookSecret } from "@/lib/telegram/bot.server";

const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

const HELP = [
  "<b>Creative Factory VA</b>",
  "/status — overview of your workspace",
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
        const msg = update?.message;
        const chatId = msg?.chat?.id;
        const text: string = typeof msg?.text === "string" ? msg.text.slice(0, 500).trim() : "";
        if (typeof chatId !== "number" || msg?.chat?.type !== "private" || !text) {
          return Response.json({ ok: true });
        }

        const key = botKey(token);
        const [rawCmd, ...args] = text.split(/\s+/);
        const cmd = rawCmd.toLowerCase().replace(/^\//, "").replace(/@.*$/, "");

        try {
          if (cmd === "start" && args[0]) {
            const code = args[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
            const { data, error } = await db().rpc("telegram_link" as any, { _code: code, _chat_id: chatId, _key: key });
            if (error) throw error;
            await sendText(chatId, data
              ? `✅ Connected! I'm your Creative Factory VA.\n\n${HELP}`
              : "That link expired. Open Settings in the app and tap Connect Telegram again.");
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
