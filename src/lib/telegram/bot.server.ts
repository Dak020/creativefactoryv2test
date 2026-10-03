import { createHash } from "crypto";

export const BOT_USERNAME = "CreativefactoryV1_bot";

export function botToken(): string {
  const t = process.env["TELEGRAM_BOT_TOKEN"];
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return t;
}

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

export function sendText(chatId: number, text: string, replyMarkup?: unknown) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body["reply_markup"] = replyMarkup;
  return tg("sendMessage", body);
}

export async function sendVideoWithButtons(
  chatId: number,
  videoBuffer: Buffer,
  caption: string,
  replyMarkup?: unknown
) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  // Explicitly specify 1080x1920 (9:16) and streaming for native vertical playback
  form.append("video", new Blob([new Uint8Array(videoBuffer)], { type: "video/mp4" }), "preview.mp4");
  form.append("width", "1080");
  form.append("height", "1920");
  form.append("supports_streaming", "true");
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  if (replyMarkup) {
    form.append("reply_markup", JSON.stringify(replyMarkup));
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken()}/sendVideo`, {
    method: "POST",
    body: form,
  });

  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !json.ok) {
    throw new Error(`sendVideo failed: ${json.description ?? res.status}`);
  }
  return json;
}

export function answerCallback(callbackQueryId: string, text?: string) {
  return tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}
