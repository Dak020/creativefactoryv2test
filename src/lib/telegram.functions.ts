import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PROJECT_ID = "81a2e896-1052-4241-8514-4dd7922129c6";

function webhookHost(origin: string) {
  // Preview links go through a sign-in wall; Telegram needs the public dev host.
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
      allowed_updates: ["message"],
    });
    await tg("setMyCommands", {
      commands: [
        { command: "status", description: "Workspace overview" },
        { command: "clips", description: "Latest clips" },
        { command: "trends", description: "Top trending sounds" },
        { command: "schedule", description: "Upcoming posts" },
        { command: "help", description: "All commands" },
      ],
    }).catch(() => {});

    return { url: `https://t.me/${BOT_USERNAME}?start=${code}` };
  });

export const disconnectTelegramFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase.from("telegram_links" as any).delete().eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
