import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PROJECT_ID = "81a2e896-1052-4241-8514-4dd7922129c6";

function webhookHost(origin: string) {
  if (origin.includes("id-preview--") || origin.includes("localhost")) {
    return `https://project--${PROJECT_ID}-dev.lovable.app`;
  }
  return origin;
}

export const getTelegramLinkFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("telegram_links" as any)
      .select("chat_id, linked_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    const row = data as { chat_id: number | null; linked_at: string | null } | null;
    return { linked: !!row?.chat_id, linkedAt: row?.linked_at ?? null };
  });

export const connectTelegramFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { origin: string }) => ({ origin: String(d.origin).slice(0, 200) }))
  .handler(async ({ data, context }) => {
    const { BOT_USERNAME, botKeyHash, botToken, tg, webhookSecret } = await import("@/lib/telegram/bot.server");
    const token = botToken();
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 24);

    const { error } = await context.supabase.from("telegram_links" as any).upsert(
      { user_id: context.userId, link_code: code, bot_key_hash: botKeyHash(token) },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);

    await tg("setWebhook", {
      url: `${webhookHost(data.origin)}/api/public/telegram/webhook`,
      secret_token: webhookSecret(token),
      allowed_updates: ["message", "callback_query"],
    });

    await tg("setMyCommands", {
      commands: [
        { command: "status", description: "Workspace overview" },
        { command: "projects", description: "View your projects" },
        { command: "addhook", description: "Select project and add a hook" },
        { command: "clips", description: "Latest clips" },
        { command: "trends", description: "Top trending sounds" },
        { command: "schedule", description: "Upcoming scheduled posts" },
        { command: "help", description: "Show available commands" },
      ],
    }).catch((err) => {
      console.error("setMyCommands error:", err);
    });

    return { url: `https://t.me/${BOT_USERNAME}?start=${code}` };
  });

export const disconnectTelegramFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase.from("telegram_links" as any).delete().eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const sendTelegramNotificationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { message: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: link } = await supabase
      .from("telegram_links" as any)
      .select("chat_id")
      .eq("user_id", userId)
      .maybeSingle();

    const row = link as { chat_id: number | null } | null;
    if (!row?.chat_id) return { ok: false };

    const { sendText } = await import("@/lib/telegram/bot.server");
    await sendText(row.chat_id, data.message);
    return { ok: true };
  });

export const sendTelegramPreviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { base64Video: string; caption?: string; projectId?: string; jobId?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: link } = await supabase
      .from("telegram_links" as any)
      .select("chat_id")
      .eq("user_id", userId)
      .maybeSingle();

    const row = link as { chat_id: number | null } | null;
    if (!row?.chat_id) {
      throw new Error("Telegram account is not connected.");
    }

    const { sendVideoWithButtons } = await import("@/lib/telegram/bot.server");
    const videoBuffer = Buffer.from(data.base64Video, "base64");

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "👍 Approve & Save", callback_data: `approve:${data.jobId || "last"}:${data.projectId || "default"}` },
          { text: "❌ Discard", callback_data: `discard:${data.jobId || "last"}:${data.projectId || "default"}` },
        ],
      ],
    };

    await sendVideoWithButtons(
      row.chat_id,
      videoBuffer,
      data.caption || "🎬 <b>Clip DNA Style Preview Ready (9:16)</b>\nReview your preview below:",
      replyMarkup
    );

    return { ok: true };
  });
