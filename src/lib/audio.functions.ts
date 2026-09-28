import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type TrendingAudioRow = {
  id: string;
  platform: string;
  region: string;
  title: string;
  author: string | null;
  audio_url: string | null;
  storage_path: string | null;
  cover_url: string | null;
  duration_seconds: number | null;
  virality_score: number;
  trend_rate: number;
  trend_label: string | null;
  source: string;
  is_favorite: boolean;
  user_id: string | null;
  created_at: string;
};

const AUDIO_COLUMNS =
  "id, platform, region, title, author, audio_url, storage_path, cover_url, duration_seconds, virality_score, trend_rate, trend_label, source, is_favorite, user_id, created_at";

/**
 * Trending tracks for a region, highest virality first. RLS already limits
 * this to system-wide rows (user_id null) plus the signed-in user's own
 * imports, so no extra user_id filter is needed here.
 */
export const getTrendingAudiosFn = createServerFn({ method: "GET" })
  .inputValidator((input: { region?: string } | undefined) => input ?? {})
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("trending_audios")
      .select(AUDIO_COLUMNS)
      .order("virality_score", { ascending: false });
    if (data.region) q = q.eq("region", data.region);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { audios: (rows ?? []) as TrendingAudioRow[] };
  });

/** Every audio the signed-in user owns (favorited copies and imports). */
export const getMyAudioLibraryFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("trending_audios")
      .select(AUDIO_COLUMNS)
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { audios: (rows ?? []) as TrendingAudioRow[] };
  });

export const toggleFavoriteAudioFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { audioId: string; isFavorite: boolean }) => input)
  .handler(async ({ data, context }) => {
    // A system-wide track (user_id null) can't be UPDATEd by a regular user
    // under RLS, so "favoriting" one creates the user's OWN copy (same audio,
    // their own row) so the star can actually be saved. Their own rows are
    // just patched in place.
    const { data: existing, error: findErr } = await context.supabase
      .from("trending_audios")
      .select("id, user_id")
      .eq("id", data.audioId)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!existing) throw new Error("That sound could not be found.");

    if (existing.user_id === context.userId) {
      const { error } = await context.supabase
        .from("trending_audios")
        .update({ is_favorite: data.isFavorite })
        .eq("id", data.audioId);
      if (error) throw new Error(error.message);
      return { ok: true, audioId: data.audioId };
    }

    if (!data.isFavorite) {
      // Un-favoriting a system track the user never copied is a no-op.
      return { ok: true, audioId: data.audioId };
    }

    const { data: source, error: srcErr } = await context.supabase
      .from("trending_audios")
      .select(AUDIO_COLUMNS)
      .eq("id", data.audioId)
      .single();
    if (srcErr || !source) throw new Error(srcErr?.message ?? "That sound could not be found.");

    const { data: copy, error: copyErr } = await context.supabase
      .from("trending_audios")
      .insert({
        user_id: context.userId,
        platform: source.platform,
        region: source.region,
        title: source.title,
        author: source.author,
        audio_url: source.audio_url,
        storage_path: source.storage_path,
        cover_url: source.cover_url,
        duration_seconds: source.duration_seconds,
        virality_score: source.virality_score,
        trend_rate: source.trend_rate,
        trend_label: source.trend_label,
        source: source.source,
        is_favorite: true,
      })
      .select("id")
      .single();
    if (copyErr || !copy) throw new Error(copyErr?.message ?? "Could not save this sound.");
    return { ok: true, audioId: copy.id };
  });

/** Save a user-imported sound (a pasted direct MP3 link) to their own library. */
export const addCustomAudioFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      title: string;
      author?: string;
      audioUrl: string;
      coverUrl?: string;
      durationSeconds?: number;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    if (!data.title.trim()) throw new Error("Give this sound a title.");
    if (!/^https?:\/\//i.test(data.audioUrl.trim())) {
      throw new Error("That doesn't look like a valid audio link.");
    }
    const { data: row, error } = await context.supabase
      .from("trending_audios")
      .insert({
        user_id: context.userId,
        platform: "tiktok",
        region: "global",
        title: data.title.trim(),
        author: data.author?.trim() || null,
        audio_url: data.audioUrl.trim(),
        cover_url: data.coverUrl?.trim() || null,
        duration_seconds: data.durationSeconds ?? null,
        source: "import",
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "Could not save this sound.");
    return { ok: true, audioId: row.id };
  });

export const deleteCustomAudioFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    // RLS already restricts deletes to the caller's own rows. A system
    // track simply won't match and delete() affects zero rows.
    const { error } = await context.supabase.from("trending_audios").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Highest-virality track in a region, for the VA's automatic pick. */
export const getAutoPickAudioFn = createServerFn({ method: "GET" })
  .inputValidator((input: { region?: string } | undefined) => input ?? {})
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("trending_audios")
      .select(AUDIO_COLUMNS)
      .eq("region", data.region ?? "global")
      .order("virality_score", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return { audio: (rows?.[0] ?? null) as TrendingAudioRow | null };
  });
