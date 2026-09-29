/**
 * AI provider abstraction.
 *
 * The rest of the app only ever talks to `getAiProvider()`, so swapping in
 * OpenAI-direct or Anthropic later is a single file change — no call-site
 * rewrites. Server-only: never import from client code.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface AiProvider {
  readonly id: string;
  readonly model: string;
  /** Returns raw text completion for the given messages. */
  complete(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string>;
  /** Returns a parsed JSON object completion. */
  completeJson<T>(messages: ChatMessage[], opts?: { temperature?: number }): Promise<T>;
}

class GatewayProvider implements AiProvider {
  readonly id = "lovable-ai-gateway";
  constructor(
    private apiKey: string,
    readonly model: string,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        reasoning_effort: "none",
      }),
    });

    if (res.status === 429) throw new Error("RATE_LIMIT: AI is busy, please retry in a moment.");
    if (res.status === 402) throw new Error("NO_CREDITS: AI credits exhausted. Add credits to continue.");
    if (!res.ok) throw new Error(`AI request failed (${res.status}): ${await res.text()}`);

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }

  async completeJson<T>(messages: ChatMessage[]): Promise<T> {
    const text = await this.complete(messages);
    return parseJsonLoose<T>(text);
  }
}

export function parseJsonLoose<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const startArr = cleaned.indexOf("[");
    const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (from === -1 || end === -1) throw new Error("AI returned an unparseable response.");
    return JSON.parse(cleaned.slice(from, end + 1)) as T;
  }
}

/**
 * Any OpenAI-compatible chat-completions endpoint: OpenAI itself, OpenRouter,
 * Groq, Together, a local llama.cpp server, Anthropic through a compatible
 * proxy — anything that accepts `POST {baseUrl}/chat/completions`.
 *
 * The app is never tied to one vendor: the user supplies base URL + key + model.
 */
class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  constructor(
    private baseUrl: string,
    private apiKey: string,
    readonly model: string,
    label?: string,
  ) {
    this.id = label ?? "custom";
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        // Harmless on other vendors; Anthropic-compatible proxies want it.
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ model: this.model, messages }),
    });

    if (res.status === 401 || res.status === 403)
      throw new Error("AUTH: your API key was rejected by the provider.");
    if (res.status === 429) throw new Error("RATE_LIMIT: provider is rate limiting, retry shortly.");
    if (res.status === 402) throw new Error("NO_CREDITS: this provider account is out of credits.");
    if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ text?: string }>;
    };
    return json.choices?.[0]?.message?.content ?? json.content?.[0]?.text ?? "";
  }

  async completeJson<T>(messages: ChatMessage[]): Promise<T> {
    return parseJsonLoose<T>(await this.complete(messages));
  }
}

export type CustomProviderConfig = { baseUrl: string; apiKey: string; model: string; label?: string };

export function createCustomProvider(cfg: CustomProviderConfig): AiProvider {
  return new OpenAiCompatibleProvider(cfg.baseUrl, cfg.apiKey, cfg.model, cfg.label);
}

/**
 * Built-in provider (Lovable AI Gateway). Used when the user has no active
 * LLM connection of their own.
 */
export function getAiProvider(): AiProvider {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project.");
  const model = process.env["AI_MODEL"] ?? "openai/gpt-5.6-sol";
  return new GatewayProvider(key, model);
}

/**
 * Resolve the provider for a signed-in user: their active saved connection if
 * they have one, otherwise the built-in gateway.
 */
export async function getProviderForUser(userId: string, supabase?: any): Promise<AiProvider> {
  if (!supabase) return getAiProvider();
  const { data } = await supabase
    .from("ai_credentials")
    .select("label, base_url, model, api_key")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (data?.api_key && data.base_url && data.model) {
    return createCustomProvider({
      baseUrl: data.base_url,
      apiKey: data.api_key,
      model: data.model,
      label: data.label ?? "custom",
    });
  }
  return getAiProvider();
}
