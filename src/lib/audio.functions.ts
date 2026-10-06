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
  external_id: string | null;
  source_url: string | null;
  source: string;
  is_favorite: boolean;
  user_id: string | null;
  created_at: string;
};

const AUDIO_COLUMNS =
  "id, platform, region, title, author, audio_url, storage_path, cover_url, duration_seconds, virality_score, trend_rate, trend_label, external_id, source_url, source, is_favorite, user_id, created_at";

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
      .neq("source", "seed_placeholder")
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
      .neq("source", "seed_placeholder")
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

/** Highest-virality tracks in a region, randomly sampled for the VA's automatic pick. */
export const getAutoPickAudioFn = createServerFn({ method: "GET" })
  .inputValidator((input: { region?: string | undefined; excludeId?: string | undefined } | undefined) => input ?? {})
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    // Auto-refresh the trending chart when it's older than 6h, so nobody has
    // to press Sync manually. Best-effort: stale rows are still used on failure.
    try {
      const region = data.region ?? "global";
      const { data: fresh } = await context.supabase
        .from("trending_audios")
        .select("last_synced_at")
        .eq("region", region)
        .eq("source", "apify")
        .order("last_synced_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const last = fresh?.last_synced_at ? new Date(fresh.last_synced_at).getTime() : 0;
      if (Date.now() - last > 6 * 60 * 60 * 1000) {
        const { fetchTrendingSounds } = await import("@/lib/audio/tiktok-sounds.server");
        const sounds = await fetchTrendingSounds(region, 40);
        if (sounds.length > 0) {
          await context.supabase.rpc("replace_trending_audios", {
            _platform: "tiktok",
            _region: region,
            _rows: sounds as any,
          });
        }
      }
    } catch (e) {
      console.warn("Auto trending sync skipped:", e);
    }
    let q = context.supabase
      .from("trending_audios")
      .select(AUDIO_COLUMNS)
      .eq("region", data.region ?? "global")
      .neq("source", "seed_placeholder")
      .order("virality_score", { ascending: false })
      .limit(15);

    if (data.excludeId) {
      q = q.neq("id", data.excludeId);
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    if (!rows || rows.length === 0) {
      // If filtering by excludeId left no tracks, fall back to top tracks without exclusion
      if (data.excludeId) {
        const { data: fallbackRows } = await context.supabase
          .from("trending_audios")
          .select(AUDIO_COLUMNS)
          .eq("region", data.region ?? "global")
          .neq("source", "seed_placeholder")
          .order("virality_score", { ascending: false })
          .limit(15);
        if (fallbackRows && fallbackRows.length > 0) {
          const idx = Math.floor(Math.random() * fallbackRows.length);
          return { audio: fallbackRows[idx] as TrendingAudioRow };
        }
      }
      return { audio: null };
    }

    // Pick randomly from the top trending pool so each variant gets a fresh sound
    const randomIndex = Math.floor(Math.random() * rows.length);
    return { audio: rows[randomIndex] as TrendingAudioRow };
  });

/** Save an audio file the browser already uploaded to the "media" bucket. */
export const addUploadedAudioFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      title: string;
      author?: string;
      storagePath: string;
      durationSeconds?: number;
      category?: string;
      region?: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    if (!data.title.trim()) throw new Error("Give this sound a title.");
    // The storage policy only lets a user write under their own id folder, so
    // refuse a path that isn't in it rather than store a dead reference.
    if (!data.storagePath.startsWith(`${context.userId}/`)) {
      throw new Error("That upload isn't in your own folder.");
    }
    const { data: row, error } = await context.supabase
      .from("trending_audios")
      .insert({
        user_id: context.userId,
        platform: "tiktok",
        region: data.region ?? "global",
        title: data.title.trim(),
        author: data.author?.trim() || null,
        storage_path: data.storagePath,
        audio_url: null,
        duration_seconds: data.durationSeconds ?? null,
        trend_label: data.category ?? "TikTok Audio",
        source: "upload",
      })
      .select(AUDIO_COLUMNS)
      .single();
    if (error || !row) throw new Error(error?.message ?? "Could not save this sound.");
    return { audio: row as TrendingAudioRow };
  });

/**
 * Refresh the shared (system-wide) trending chart for a region from Apify,
 * via the security-definer RPC (regular users can't INSERT user_id-null rows
 * directly under RLS). Reports the number of rows the sync actually wrote,
 * not just how many candidates Apify returned — a batch can come back
 * non-empty and still insert zero if every title was blank.
 */
export const syncTrendingAudiosFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { region?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const region = data.region ?? "global";
    const { fetchTrendingSounds } = await import("@/lib/audio/tiktok-sounds.server");
    const sounds = await fetchTrendingSounds(region, 40);
    if (sounds.length === 0) {
      return { count: 0, message: "No trending sounds found for this region right now." };
    }
    const { data: count, error } = await context.supabase.rpc("replace_trending_audios", {
      _platform: "tiktok",
      _region: region,
      _rows: sounds,
    });
    if (error) throw new Error(error.message);
    if (!count) {
      return {
        count: 0,
        message: "The trending-sound service returned no usable tracks this time.",
      };
    }
    return { count };
  });

/**
 * Import a TikTok video or sound link: resolve it to its underlying audio,
 * download the file server-side (avoids CORS and the source link expiring),
 * store it in the user's own media/ folder, and save it to their library.
 */
export const importTikTokUrlAudioFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { url: string; title?: string }) => input)
  .handler(async ({ data, context }) => {
    const trimmed = data.url.trim();
    if (!/^https?:\/\/(www\.|vm\.|vt\.)?tiktok\.com\//i.test(trimmed)) {
      throw new Error("That doesn't look like a TikTok link.");
    }
    const { resolveTikTokLink, downloadAudio } = await import("@/lib/audio/tiktok-sounds.server");
    const resolved = await resolveTikTokLink(trimmed);
    if (!resolved?.audioUrl) {
      throw new Error("Could not extract audio from that TikTok link. Please verify the URL.");
    }

    const { bytes, contentType } = await downloadAudio(resolved.audioUrl);
    const storagePath = `${context.userId}/audio-${crypto.randomUUID()}.mp3`;

    const { error: uploadError } = await context.supabase.storage
      .from("media")
      .upload(storagePath, bytes, { contentType, upsert: true });
    if (uploadError) throw new Error(`Failed to save extracted sound: ${uploadError.message}`);

    const { data: row, error: insertError } = await context.supabase
      .from("trending_audios")
      .insert({
        user_id: context.userId,
        platform: "tiktok",
        region: "global",
        title: (data.title?.trim() || resolved.title || "TikTok Audio").slice(0, 200),
        author: resolved.author?.slice(0, 120) || null,
        storage_path: storagePath,
        audio_url: null,
        cover_url: resolved.coverUrl || null,
        duration_seconds: resolved.durationSeconds || null,
        external_id: resolved.externalId || null,
        source_url: resolved.sourceUrl || trimmed,
        source: "tiktok_link",
        trend_label: "Imported Sound",
      })
      .select(AUDIO_COLUMNS)
      .single();

    if (insertError || !row) {
      // The DB row failed — don't leave the file orphaned in storage.
      await context.supabase.storage.from("media").remove([storagePath]);
      throw new Error(insertError?.message ?? "Failed to save to library.");
    }
    return { audio: row as TrendingAudioRow };
  });

/**
 * Ensure a track has a CORS-safe, storage-backed URL before it's used in a
 * render. A track that already has storage_path just gets re-signed; an
 * external (audio_url-only) track is downloaded and cached into the media
 * bucket once, and the row is updated so every future render reuses the
 * cached copy instead of re-downloading it.
 */
export const prepareAudioForRenderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { audioId: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: audio, error } = await context.supabase
      .from("trending_audios")
      .select("id, storage_path, audio_url")
      .eq("id", data.audioId)
      .single();
    if (error || !audio) throw new Error("Audio track not found.");

    if (audio.storage_path) {
      const { data: signed } = await context.supabase.storage
        .from("media")
        .createSignedUrl(audio.storage_path, 60 * 60 * 6);
      return { url: signed?.signedUrl ?? null };
    }

    if (!audio.audio_url) return { url: null };

    const { downloadAudio } = await import("@/lib/audio/tiktok-sounds.server");
    const { bytes, contentType } = await downloadAudio(audio.audio_url);
    const storagePath = `${context.userId}/cache-${crypto.randomUUID()}.mp3`;
    const { error: upErr } = await context.supabase.storage
      .from("media")
      .upload(storagePath, bytes, { contentType, upsert: true });
    if (upErr) throw new Error(`Could not prepare this sound: ${upErr.message}`);

    // Best-effort: if this fails the render can still proceed on the signed
    // URL below, it just won't be cached for next time.
    await context.supabase
      .from("trending_audios")
      .update({ storage_path: storagePath })
      .eq("id", audio.id);

    const { data: signed } = await context.supabase.storage
      .from("media")
      .createSignedUrl(storagePath, 60 * 60 * 6);
    return { url: signed?.signedUrl ?? null };
  });
