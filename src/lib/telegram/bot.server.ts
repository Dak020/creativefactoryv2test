import { createHash } from "crypto";

export const BOT_USERNAME = "CreativefactoryV1_bot";

export function botToken(): string {
  const t = process.env["TELEGRAM_BOT_TOKEN"];
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return t;
}

/** Key the webhook passes to the database; only its hash is stored. */
export function botKey(token: string) {
  return createHash("sha256").update(`cf-bot:${token}`).digest("hex");
}
export function botKeyHash(token: string) {
  return createHash("sha256").update(botKey(token)).digest("hex");
}
export function webhookSecret(token: string) {
  return createHash("sha256").update(`telegram-webhook:${token}`).digest("base64url");
}

export async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (!res.ok || !json.ok) {
    console.error(`Telegram ${method} failed [${res.status}]: ${json.description}`);
    throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  }
  return json.result;
}

export function sendText(chatId: number, text: string) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}
