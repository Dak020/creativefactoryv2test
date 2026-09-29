/**
 * Per-user LLM connections. Any OpenAI-compatible endpoint works — OpenAI,
 * OpenRouter, Groq, Together, a local server, or an Anthropic-compatible
 * proxy — so the app is never tied to one vendor.
 *
 * The API key itself never leaves the server: the browser only ever sees a
 * masked hint (the DB grants exclude the api_key column too).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const SELECT = "id, label, base_url, model, key_hint, is_active, created_at";

function hint(key: string) {
  const tail = key.trim().slice(-4);
  return tail ? `••••${tail}` : "••••";
}

export const listAiCredentialsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("ai_credentials")
      .select(SELECT)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { credentials: data ?? [] };
  });

const SaveSchema = z.object({
  label: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().url().max(300),
  model: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(8).max(400),
  makeActive: z.boolean().default(true),
});

export const saveAiCredentialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveSchema.parse(input))
  .handler(async ({ data, context }) => {
    const userId = context.userId;

    if (data.makeActive) {
      await context.supabase.from("ai_credentials").update({ is_active: false }).eq("user_id", userId);
    }

    const { data: row, error } = await context.supabase
      .from("ai_credentials")
      .insert({
        user_id: userId,
        label: data.label,
        base_url: data.baseUrl.replace(/\/+$/, ""),
        model: data.model,
        api_key: data.apiKey,
        key_hint: hint(data.apiKey),
        is_active: data.makeActive,
      })
      .select(SELECT)
      .single();
    if (error) throw new Error(error.message);
    return { credential: row };
  });

const IdSchema = z.object({ id: z.string().uuid() });

export const activateAiCredentialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    await context.supabase.from("ai_credentials").update({ is_active: false }).eq("user_id", context.userId);
    const { error } = await context.supabase
      .from("ai_credentials")
      .update({ is_active: true })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Fall back to the built-in model by deactivating every saved connection. */
export const useBuiltInAiFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("ai_credentials").update({ is_active: false }).eq("user_id", context.userId);
    return { ok: true };
  });

export const deleteAiCredentialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("ai_credentials").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Round-trip one tiny prompt so the user knows the key really works. */
export const testAiCredentialFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("ai_credentials")
      .select("label, base_url, model, api_key")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .single();
    if (error || !row) throw new Error("Connection not found.");

    const { createCustomProvider } = await import("./ai/provider.server");
    const ai = createCustomProvider({
      baseUrl: row.base_url,
      apiKey: row.api_key,
      model: row.model,
      label: row.label ?? "custom",
    });
    try {
      const reply = await ai.complete([{ role: "user", content: "Reply with the single word: ok" }]);
      return { ok: true as const, reply: reply.slice(0, 80) };
    } catch (e) {
      return { ok: false as const, reply: (e as Error).message.slice(0, 200) };
    }
  });
