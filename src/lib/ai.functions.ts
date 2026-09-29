import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const GenerateHooksSchema = z.object({
  product: z.string().trim().min(1).max(200),
  brandContext: z.string().trim().max(200).nullable().optional(),
  brandMode: z.enum(["winner", "project", "custom"]).default("project"),
  productUrl: z.string().trim().max(500).nullable().optional(),
  audience: z.string().trim().max(500).default(""),
  platform: z.string().trim().max(30).default("both"),
  contentStyle: z.string().trim().max(50).default("ugc"),
  count: z.number().int().min(1).max(25).default(10),
  categories: z.array(z.string().max(40)).max(10).default([]),
  winnerIds: z.array(z.string().uuid()).max(20).default([]),
  projectId: z.string().uuid().nullable().optional(),
});

export const generateHooksFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => GenerateHooksSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    let winners: Array<{
      text: string;
      category: string | null;
      structure: string | null;
      emotional_trigger: string | null;
      performance_score: number | null;
    }> = [];

    if (data.winnerIds.length > 0) {
      const { data: rows, error } = await supabase
        .from("hooks")
        .select("text, category, structure, emotional_trigger, performance_score")
        .in("id", data.winnerIds);
      if (error) throw new Error(error.message);
      winners = rows ?? [];
    }

    const { generateHooks } = await import("./ai/hooks-service.server");
    const { getProviderForUser } = await import("./ai/provider.server");
    const provider = await getProviderForUser(userId, supabase);
    const generated = await generateHooks({
      product: data.product,
      brandContext: data.brandContext ?? null,
      brandMode: data.brandMode,
      productUrl: data.productUrl ?? null,
      audience: data.audience,
      platform: data.platform,
      contentStyle: data.contentStyle,
      count: data.count,
      categories: data.categories,
      winners,
    }, provider);

    if (generated.length === 0) return { variants: [] };

    const { data: inserted, error: insErr } = await supabase
      .from("hook_variants")
      .insert(
        generated.map((g) => ({
          user_id: userId,
          project_id: data.projectId ?? null,
          parent_hook_id: null,
          text: g.text,
          category: g.category,
          structure: g.structure,
          emotional_trigger: g.emotional_trigger,
          score: g.score,
          rationale: g.rationale,
        })),
      )
      .select();
    if (insErr) throw new Error(insErr.message);

    return { variants: inserted ?? [] };
  });

const ScoreSchema = z.object({
  texts: z.array(z.string().min(1).max(300)).min(1).max(25),
  audience: z.string().max(500).default(""),
  platform: z.string().max(30).default("both"),
});

export const scoreHooksFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ScoreSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { scoreHooks } = await import("./ai/hooks-service.server");
    const { getProviderForUser } = await import("./ai/provider.server");
    const provider = await getProviderForUser(context.userId, context.supabase);
    return { scores: await scoreHooks(data.texts, data.audience, data.platform, provider) };
  });

/** Study pasted winning hooks: extract structure, trigger and format, then save them as winners. */
const StudySchema = z.object({
  texts: z.array(z.string().trim().min(3).max(300)).min(1).max(25),
  platform: z.string().trim().max(30).default("both"),
  audience: z.string().trim().max(500).default(""),
  projectId: z.string().uuid().nullable().optional(),
  save: z.boolean().default(true),
});

export const studyWinnersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => StudySchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { analyzeHookStructure } = await import("./ai/hooks-service.server");
    const { getProviderForUser } = await import("./ai/provider.server");
    const provider = await getProviderForUser(userId, supabase);

    const analysis = await analyzeHookStructure(
      data.texts.map((t) => ({ text: t })),
      provider,
    );

    const rows = data.texts.map((text, i) => ({
      text,
      structure: analysis[i]?.structure ?? "",
      emotional_trigger: analysis[i]?.emotional_trigger ?? "",
      format: analysis[i]?.format ?? "",
    }));

    if (!data.save) return { analyzed: rows, saved: [] };

    const { data: saved, error } = await supabase
      .from("hooks")
      .insert(
        rows.map((r) => ({
          user_id: userId,
          project_id: data.projectId ?? null,
          text: r.text,
          category: "Curiosity",
          structure: r.structure,
          emotional_trigger: r.emotional_trigger,
          audience: data.audience || null,
          platform: data.platform,
          source: "studied",
          is_winner: true,
        })),
      )
      .select();
    if (error) throw new Error(error.message);

    return { analyzed: rows, saved: saved ?? [] };
  });
