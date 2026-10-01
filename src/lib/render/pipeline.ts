/**
 * Shared client-side production pipeline.
 *
 *   source clip + hook -> video_recipes -> render_jobs -> browser render
 *   -> storage upload -> verified signed URL -> generated_videos
 *
 * A variant is only ever reported (and stored) as `completed` when the output
 * object actually exists in storage and resolves to a playable signed URL.
 */

import { supabase } from "@/integrations/supabase/client";
import { planStartOffsets, renderVariant, RenderCancelledError, type HookPlacement, type SeekOptions } from "./browser-render";
import { resolveRenderUrl } from "./output";

export const RENDER_BUCKET = "renders";
export const OUT_W = 1080;
export const OUT_H = 1920;
export const CLIP_SECONDS = 8;
export const QUANTITY_PRESETS = [1, 5, 10, 20, 30] as const;
export const MAX_QUANTITY = 30;

export type RenderStage =
  | "queued"
  | "rendering"
  | "encoding"
  | "uploading"
  | "completed"
  | "failed";

export const STAGE_LABEL: Record<RenderStage, string> = {
  queued: "Queued",
  rendering: "Rendering",
  encoding: "Encoding",
  uploading: "Uploading",
  completed: "Completed",
  failed: "Failed",
};

export type BatchItem = {
  jobId: string;
  recipeId: string | null;
  videoId: string | null;
  hookId: string;
  hookText: string;
  sourceName: string;
  sourceAssetId: string;
  durationSeconds: number;
  createdAt: string;
  outputPath: string | null;
  thumbnailPath: string | null;
  stage: RenderStage;
  progress: number;
  url?: string;
  filename?: string;
  error?: string;
};

export type BatchInput = {
  userId: string;
  projectId: string;
  asset: {
    id: string;
    filename: string;
    duration: number | null;
    storage_path: string;
    hook_placement?: string | null;
  };
  assetUrl: string;
  hooks: { id: string; text: string }[];
  quantity: number;
  withAudio?: boolean;
  /** Fully-resolved, CORS-readable URL of a soundtrack to bake into every variant. */
  soundtrackUrl?: string | undefined;
  /** Soundtrack level, 0..1 (defaults to 1). */
  soundtrackVolume?: number | undefined;
  signal?: AbortSignal | undefined;
  seek?: SeekOptions;
  onUpdate: (items: BatchItem[]) => void;
};


/**
 * Round-robin the selected hooks across the requested number of variants, so
 * the user gets exactly the quantity they asked for — never more, never fewer.
 */
export function planVariants(hooks: { id: string; text: string }[], quantity: number) {
  if (hooks.length === 0) return [];
  return Array.from({ length: Math.max(1, quantity) }, (_, i) => hooks[i % hooks.length]!);
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Split `quantity` render slots evenly across `clipIds`. If it doesn't divide
 * evenly, the remainder is randomly assigned to any of the selected clips
 * (not deterministically to the first N clips in order) — so repeatedly
 * requesting an odd quantity doesn't always favor the same clip over time.
 * Returns one clip id per slot, in the order slots should be rendered.
 */
export function planClipAssignment(clipIds: string[], quantity: number): string[] {
  const ids = clipIds.filter(Boolean);
  if (ids.length === 0) return [];
  const n = Math.max(1, quantity);
  const base = Math.floor(n / ids.length);
  const remainder = n % ids.length;

  const assignment: string[] = [];
  for (const id of ids) {
    for (let i = 0; i < base; i++) assignment.push(id);
  }
  // Randomly pick which `remainder` clips get one extra slot, instead of
  // always the first `remainder` clips in the array. Fisher-Yates, not
  // Array.sort(() => Math.random() - 0.5) — the latter is a well-known
  // biased shuffle whose distribution depends on the sort algorithm's
  // comparison pattern, not a uniform random permutation.
  const shuffledIds = shuffle(ids);
  for (let i = 0; i < remainder; i++) assignment.push(shuffledIds[i]!);

  // Shuffle the final render order too (cosmetic — doesn't affect the even
  // split, just avoids all of one clip's slots being grouped together).
  return shuffle(assignment);
}

export async function runBatch(input: BatchInput): Promise<BatchItem[]> {
  const { userId, projectId, asset, assetUrl, quantity, onUpdate } = input;
  const plan = planVariants(input.hooks, quantity);
  if (plan.length === 0) throw new Error("Select at least one hook.");

  const placement: HookPlacement =
    asset.hook_placement === "middle" || asset.hook_placement === "bottom"
      ? asset.hook_placement
      : "top";

  // CLIP_SECONDS is a ceiling, not a target: a clip shorter than 8s must stay
  // its own length. Only clips longer than 8s get trimmed down to it. Never
  // stretch/freeze/duplicate a short source just to reach 8 seconds.
  const sourceDuration = Number(asset.duration ?? CLIP_SECONDS);
  const outputDuration = sourceDuration > 0 ? Math.min(sourceDuration, CLIP_SECONDS) : CLIP_SECONDS;

  const offsets = planStartOffsets(sourceDuration, plan.length, outputDuration, input.seek);

  let items: BatchItem[] = [];
  const push = () => onUpdate([...items]);
  const patch = (jobId: string, p: Partial<BatchItem>) => {
    items = items.map((b) => (b.jobId === jobId ? { ...b, ...p } : b));
    push();
  };

  // 1. Persist the full recipe + job graph up front so the requested quantity
  //    is visible and truthful before any pixels are drawn.
  for (const hook of plan) {
    const { data: recipe, error: recipeErr } = await supabase
      .from("video_recipes")
      .insert({
        user_id: userId,
        project_id: projectId,
        hook_id: hook.id,
        media_asset_id: asset.id,
        duration: outputDuration,
        overlay_text: hook.text,
        overlay_position: placement,
        font_size: 60,
        background_color: "#00000000",
        text_color: "#FFFFFF",

        width: OUT_W,
        height: OUT_H,
      })
      .select("id")
      .single();
    if (recipeErr || !recipe) throw new Error(recipeErr?.message ?? "Could not create the recipe.");

    const { data: job, error: jobErr } = await supabase
      .from("render_jobs")
      .insert({
        user_id: userId,
        project_id: projectId,
        recipe_id: recipe.id,
        status: "queued",
        progress: 0,
      })
      .select("id, created_at")
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? "Could not queue the render job.");

    items.push({
      jobId: job.id,
      recipeId: recipe.id,
      videoId: null,
      hookId: hook.id,
      hookText: hook.text,
      sourceName: asset.filename,
      sourceAssetId: asset.id,
      durationSeconds: outputDuration,
      createdAt: job.created_at,
      outputPath: null,
      thumbnailPath: null,
      stage: "queued",
      progress: 0,
    });
  }
  push();

  // 2. Render each variant.
  for (let i = 0; i < items.length; i++) {
    if (input.signal?.aborted) break;
    const item = items[i]!;
    try {
      patch(item.jobId, { stage: "rendering", progress: 4 });
      await supabase
        .from("render_jobs")
        .update({ status: "processing", progress: 4, started_at: new Date().toISOString() })
        .eq("id", item.jobId);

      const { blob, extension, mimeType, thumbnail } = await renderVariant({
        sourceUrl: assetUrl,
        startSeconds: offsets[i] ?? 0,
        durationSeconds: outputDuration,
        width: OUT_W,
        height: OUT_H,
        text: item.hookText,
        placement,
        withAudio: Boolean(input.withAudio),
        soundtrackUrl: input.soundtrackUrl,
        soundtrackVolume: input.soundtrackVolume,
        signal: input.signal,
        onProgress: (pct) => patch(item.jobId, { stage: "rendering", progress: Math.max(4, pct * 0.8) }),
      });

      patch(item.jobId, { stage: "encoding", progress: 85 });
      if (!blob || blob.size === 0) throw new Error("Renderer produced an empty video file.");

      patch(item.jobId, { stage: "uploading", progress: 90 });
      const outPath = `${userId}/${item.jobId}.${extension}`;
      const { error: upErr } = await supabase.storage
        .from(RENDER_BUCKET)
        .upload(outPath, blob, { contentType: mimeType, upsert: true });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      let thumbPath: string | null = null;
      if (thumbnail && thumbnail.size > 0) {
        thumbPath = `${userId}/${item.jobId}.jpg`;
        const { error: thumbErr } = await supabase.storage
          .from(RENDER_BUCKET)
          .upload(thumbPath, thumbnail, { contentType: "image/jpeg", upsert: true });
        if (thumbErr) thumbPath = null;
      }

      // 3. Verify the object is really there and playable before completing.
      const url = await resolveRenderUrl(outPath);
      if (!url) throw new Error("Upload finished but the output file could not be read back.");

      const { data: video, error: videoErr } = await supabase
        .from("generated_videos")
        .insert({
          user_id: userId,
          project_id: projectId,
          render_job_id: item.jobId,
          recipe_id: item.recipeId,
          hook_id: item.hookId,
          media_asset_id: asset.id,
          hook_text: item.hookText,
          output_url: outPath,
          thumbnail_url: thumbPath,
          duration: outputDuration,
          status: "completed",
        })
        .select("id")
        .single();
      if (videoErr) throw new Error(videoErr.message);

      await supabase
        .from("render_jobs")
        .update({
          status: "completed",
          progress: 100,
          output_url: outPath,
          error_message: null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", item.jobId);

      patch(item.jobId, {
        outputPath: outPath,
        thumbnailPath: thumbPath,
        stage: "completed",
        progress: 100,
        url,
        videoId: video?.id ?? null,
        filename: `hook-variant-${i + 1}.${extension}`,
      });
    } catch (e) {
      if (e instanceof RenderCancelledError) {
        patch(item.jobId, { stage: "failed", progress: 100, error: "Cancelled" });
        await supabase
          .from("render_jobs")
          .update({
            status: "cancelled",
            progress: 100,
            error_message: "Cancelled by user",
            completed_at: new Date().toISOString(),
          })
          .eq("id", item.jobId);
        break;
      }
      const message = (e as Error).message || "Render failed.";
      patch(item.jobId, { stage: "failed", progress: 100, error: message });
      await supabase
        .from("render_jobs")
        .update({
          status: "failed",
          progress: 100,
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", item.jobId);
    }
  }

  return items;
}

export type MultiClipAsset = {
  id: string;
  filename: string;
  duration: number | null;
  storage_path: string;
  hook_placement?: string | null;
  url: string;
};

export type MultiClipBatchInput = {
  userId: string;
  projectId: string;
  assets: MultiClipAsset[];
  hooks: { id: string; text: string }[];
  quantity: number;
  withAudio?: boolean;
  /** Fully-resolved, CORS-readable URL of a soundtrack to bake into every variant. */
  soundtrackUrl?: string | undefined;
  /** Soundtrack level, 0..1 (defaults to 1). */
  soundtrackVolume?: number | undefined;
  signal?: AbortSignal | undefined;
  seek?: SeekOptions;
  onUpdate: (items: BatchItem[]) => void;
};

/**
 * Same production pipeline as runBatch, but spreads the requested quantity
 * across multiple selected clips instead of assuming a single source asset.
 * Each render slot uses ITS OWN clip's duration, start-offset plan, and
 * saved hook placement — a clip tagged "bottom" always renders with its
 * hook on the bottom, regardless of what other selected clips are tagged.
 */
export async function runMultiClipBatch(input: MultiClipBatchInput): Promise<BatchItem[]> {
  const { userId, projectId, assets, quantity, onUpdate } = input;
  if (assets.length === 0) throw new Error("Select at least one clip.");
  const hookPlan = planVariants(input.hooks, quantity);
  if (hookPlan.length === 0) throw new Error("Select at least one hook.");

  const assetById = new Map(assets.map((a) => [a.id, a]));
  const clipAssignment = planClipAssignment(
    assets.map((a) => a.id),
    hookPlan.length,
  );

  // Precompute each distinct clip's output duration and start-offset plan
  // once (not per slot) — a clip's own duration never changes between slots,
  // only which offset within it a given slot uses.
  const perClip = new Map<string, { outputDuration: number; offsets: number[]; placement: HookPlacement }>();
  for (const asset of assets) {
    const slotsForThisClip = clipAssignment.filter((id) => id === asset.id).length;
    const sourceDuration = Number(asset.duration ?? CLIP_SECONDS);
    const outputDuration = sourceDuration > 0 ? Math.min(sourceDuration, CLIP_SECONDS) : CLIP_SECONDS;
    const placement: HookPlacement =
      asset.hook_placement === "middle" || asset.hook_placement === "bottom" ? asset.hook_placement : "top";
    perClip.set(asset.id, {
      outputDuration,
      offsets: planStartOffsets(sourceDuration, Math.max(1, slotsForThisClip), outputDuration, input.seek),
      placement,
    });
  }
  // Track how many slots of each clip we've already consumed an offset for.
  const usedOffsets = new Map<string, number>();

  let items: BatchItem[] = [];
  const push = () => onUpdate([...items]);
  const patch = (jobId: string, p: Partial<BatchItem>) => {
    items = items.map((b) => (b.jobId === jobId ? { ...b, ...p } : b));
    push();
  };

  // 1. Persist the full recipe + job graph up front, one per slot, each tied
  //    to its assigned clip.
  for (let i = 0; i < hookPlan.length; i++) {
    const hook = hookPlan[i]!;
    const clipId = clipAssignment[i]!;
    const asset = assetById.get(clipId)!;
    const clipInfo = perClip.get(clipId)!;

    const { data: recipe, error: recipeErr } = await supabase
      .from("video_recipes")
      .insert({
        user_id: userId,
        project_id: projectId,
        hook_id: hook.id,
        media_asset_id: asset.id,
        duration: clipInfo.outputDuration,
        overlay_text: hook.text,
        overlay_position: clipInfo.placement,
        font_size: 60,
        background_color: "#00000000",
        text_color: "#FFFFFF",
        width: OUT_W,
        height: OUT_H,
      })
      .select("id")
      .single();
    if (recipeErr || !recipe) throw new Error(recipeErr?.message ?? "Could not create the recipe.");

    const { data: job, error: jobErr } = await supabase
      .from("render_jobs")
      .insert({
        user_id: userId,
        project_id: projectId,
        recipe_id: recipe.id,
        status: "queued",
        progress: 0,
      })
      .select("id, created_at")
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? "Could not queue the render job.");

    items.push({
      jobId: job.id,
      recipeId: recipe.id,
      videoId: null,
      hookId: hook.id,
      hookText: hook.text,
      sourceName: asset.filename,
      sourceAssetId: asset.id,
      durationSeconds: clipInfo.outputDuration,
      createdAt: job.created_at,
      outputPath: null,
      thumbnailPath: null,
      stage: "queued",
      progress: 0,
    });
  }
  push();

  // 2. Render each variant, reading from its own assigned clip.
  for (let i = 0; i < items.length; i++) {
    if (input.signal?.aborted) break;
    const item = items[i]!;
    const clipId = clipAssignment[i]!;
    const asset = assetById.get(clipId)!;
    const clipInfo = perClip.get(clipId)!;
    const usedForThisClip = usedOffsets.get(clipId) ?? 0;
    const startSeconds = clipInfo.offsets[usedForThisClip] ?? 0;
    usedOffsets.set(clipId, usedForThisClip + 1);

    try {
      patch(item.jobId, { stage: "rendering", progress: 4 });
      await supabase
        .from("render_jobs")
        .update({ status: "processing", progress: 4, started_at: new Date().toISOString() })
        .eq("id", item.jobId);

      const { blob, extension, mimeType, thumbnail } = await renderVariant({
        sourceUrl: asset.url,
        startSeconds,
        durationSeconds: clipInfo.outputDuration,
        width: OUT_W,
        height: OUT_H,
        text: item.hookText,
        placement: clipInfo.placement,
        withAudio: Boolean(input.withAudio),
        soundtrackUrl: input.soundtrackUrl,
        soundtrackVolume: input.soundtrackVolume,
        signal: input.signal,
        onProgress: (pct) => patch(item.jobId, { stage: "rendering", progress: Math.max(4, pct * 0.8) }),
      });

      patch(item.jobId, { stage: "encoding", progress: 85 });
      if (!blob || blob.size === 0) throw new Error("Renderer produced an empty video file.");

      patch(item.jobId, { stage: "uploading", progress: 90 });
      const outPath = `${userId}/${item.jobId}.${extension}`;
      const { error: upErr } = await supabase.storage
        .from(RENDER_BUCKET)
        .upload(outPath, blob, { contentType: mimeType, upsert: true });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      let thumbPath: string | null = null;
      if (thumbnail && thumbnail.size > 0) {
        thumbPath = `${userId}/${item.jobId}.jpg`;
        const { error: thumbErr } = await supabase.storage
          .from(RENDER_BUCKET)
          .upload(thumbPath, thumbnail, { contentType: "image/jpeg", upsert: true });
        if (thumbErr) thumbPath = null;
      }

      const url = await resolveRenderUrl(outPath);
      if (!url) throw new Error("Upload finished but the output file could not be read back.");

      const { data: video, error: videoErr } = await supabase
        .from("generated_videos")
        .insert({
          user_id: userId,
          project_id: projectId,
          render_job_id: item.jobId,
          recipe_id: item.recipeId,
          hook_id: item.hookId,
          media_asset_id: asset.id,
          hook_text: item.hookText,
          output_url: outPath,
          thumbnail_url: thumbPath,
          duration: clipInfo.outputDuration,
          status: "completed",
        })
        .select("id")
        .single();
      if (videoErr) throw new Error(videoErr.message);

      await supabase
        .from("render_jobs")
        .update({
          status: "completed",
          progress: 100,
          output_url: outPath,
          error_message: null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", item.jobId);

      patch(item.jobId, {
        outputPath: outPath,
        thumbnailPath: thumbPath,
        stage: "completed",
        progress: 100,
        url,
        videoId: video?.id ?? null,
        filename: `hook-variant-${i + 1}.${extension}`,
      });
    } catch (e) {
      if (e instanceof RenderCancelledError) {
        patch(item.jobId, { stage: "failed", progress: 100, error: "Cancelled" });
        await supabase
          .from("render_jobs")
          .update({
            status: "cancelled",
            progress: 100,
            error_message: "Cancelled by user",
            completed_at: new Date().toISOString(),
          })
          .eq("id", item.jobId);
        break;
      }
      const message = (e as Error).message || "Render failed.";
      patch(item.jobId, { stage: "failed", progress: 100, error: message });
      await supabase
        .from("render_jobs")
        .update({
          status: "failed",
          progress: 100,
          error_message: message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", item.jobId);
    }
  }

  return items;
}

/** Jobs left in an active state longer than this were abandoned (tab closed, crash). */
export const STALE_JOB_MS = 1000 * 60 * 20;

/**
 * Renders run in the browser tab that started them, so a closed tab can strand
 * a job in `queued`/`processing` forever. Flip anything older than the cutoff to
 * `failed` so the active queue only ever shows work that is really in flight.
 */
export async function reapStaleJobs(userId: string, projectId?: string) {
  const cutoff = new Date(Date.now() - STALE_JOB_MS).toISOString();
  let q = supabase
    .from("render_jobs")
    .update({
      status: "failed",
      progress: 100,
      error_message: "Render was interrupted before it finished. Run it again.",
      completed_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("status", ["queued", "processing"])
    .lt("created_at", cutoff);
  if (projectId) q = q.eq("project_id", projectId);
  const { error } = await q;
  if (error) return 0;
  return 1;
}

/** Cancel every queued/processing job for this user (optionally one project). */
export async function cancelQueuedJobs(userId: string, projectId?: string) {
  let q = supabase
    .from("render_jobs")
    .update({
      status: "cancelled",
      progress: 100,
      error_message: "Cancelled by user",
      completed_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("status", ["queued", "processing"]);
  if (projectId) q = q.eq("project_id", projectId);
  const { error } = await q;
  return !error;
}
