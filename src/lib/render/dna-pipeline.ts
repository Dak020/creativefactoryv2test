/**
 * Clip DNA production pipeline (client-side).
 *
 *   tagged clips -> deterministic solver -> dna_recipes + video_recipes
 *   -> render_jobs -> sequence render -> storage upload -> generated_videos
 *
 * Preview-first: `runDnaVariant` produces exactly ONE variant so the user can
 * approve the style before the remaining N-1 are spent. The single-clip paths
 * (runBatch / runMultiClipBatch) are untouched by anything here.
 */

import { supabase } from "@/integrations/supabase/client";
import type { HookPlacement } from "./browser-render";
import { renderSequence, type SequenceSegment } from "./sequence-render";
import { RenderCancelledError } from "./browser-render";
import { resolveRenderUrl } from "./output";
import { OUT_H, OUT_W, RENDER_BUCKET, type BatchItem, type RenderStage } from "./pipeline";
import { solveForProject, type DnaSegment, type SolverClip } from "@/lib/dna/solver";

export type DnaClip = SolverClip & {
  /** Playable (signed) URL for the source file. */
  url: string;
  storage_path: string;
  filename: string;
};

export type DnaPlan = {
  segments: DnaSegment[];
  finalDuration: number;
  targetDuration: number;
  /** Frozen at solve time from the opening segment's clip. */
  placement: HookPlacement;
  clipById: Record<string, DnaClip>;
};

function normalizePlacement(value: string | null | undefined): HookPlacement {
  return value === "middle" || value === "bottom" ? value : "top";
}

/** Solve one DNA edit from the project's tagged clips. */
export function planDna(clips: DnaClip[], targetDuration: number): { ok: true; plan: DnaPlan } | { ok: false; reason: string } {
  const result = solveForProject(clips, targetDuration);
  if (!result.ok) return { ok: false, reason: result.reason };

  const clipById = Object.fromEntries(clips.map((c) => [c.id, c]));
  const opener = clipById[result.segments[0]!.media_asset_id];

  return {
    ok: true,
    plan: {
      segments: result.segments,
      finalDuration: result.finalDuration,
      targetDuration,
      placement: normalizePlacement(opener?.hookPlacement),
      clipById,
    },
  };
}

export type DnaVariantInput = {
  userId: string;
  projectId: string;
  plan: DnaPlan;
  hook: { id: string; text: string };
  withAudio?: boolean;
  /** Fully-resolved, CORS-readable URL of a soundtrack to bake into the export. */
  soundtrackUrl?: string | undefined;
  /** Soundtrack level, 0..1 (defaults to 1). */
  soundtrackVolume?: number | undefined;
  signal?: AbortSignal | undefined;
  /** When true, this render is a preview the user hasn't approved yet — the
   *  video is still actually rendered and uploaded (so it can be watched
   *  and judged), but no `generated_videos` row is written. Approving turns
   *  the SAME output into a real result via commitDnaPreview below, and
   *  discarding removes the uploaded file with deleteDnaPreview — either
   *  way nothing permanent exists until the user has actually decided. */
  isPreview?: boolean;
  onUpdate?: (item: BatchItem) => void;
};

/** Render + persist a single DNA variant. Returns its BatchItem. */
export async function runDnaVariant(input: DnaVariantInput): Promise<BatchItem> {
  const { userId, projectId, plan, hook, withAudio, isPreview } = input;
  const openerId = plan.segments[0]!.media_asset_id;
  const opener = plan.clipById[openerId]!;

  const { data: dnaRecipe, error: dnaErr } = await supabase
    .from("dna_recipes")
    .insert({
      user_id: userId,
      project_id: projectId,
      target_duration: plan.targetDuration,
      final_duration: plan.finalDuration,
      segments: plan.segments,
      hook_id: hook.id,
      hook_placement: plan.placement,
    })
    .select("id")
    .single();
  if (dnaErr || !dnaRecipe) throw new Error(dnaErr?.message ?? "Could not save the DNA recipe.");

  const { data: recipe, error: recipeErr } = await supabase
    .from("video_recipes")
    .insert({
      user_id: userId,
      project_id: projectId,
      hook_id: hook.id,
      media_asset_id: openerId,
      duration: plan.finalDuration,
      overlay_text: hook.text,
      overlay_position: plan.placement,
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

  let item: BatchItem = {
    jobId: job.id,
    recipeId: recipe.id,
    videoId: null,
    hookId: hook.id,
    hookText: hook.text,
    sourceName: plan.segments
      .map((s) => plan.clipById[s.media_asset_id]?.filename ?? "clip")
      .join(" → "),
    sourceAssetId: openerId,
    durationSeconds: plan.finalDuration,
    createdAt: job.created_at,
    outputPath: null,
    thumbnailPath: null,
    stage: "queued",
    progress: 0,
  };
  const patch = (p: Partial<BatchItem> & { stage?: RenderStage }) => {
    item = { ...item, ...p };
    input.onUpdate?.(item);
  };
  patch({});

  try {
    patch({ stage: "rendering", progress: 4 });
    await supabase
      .from("render_jobs")
      .update({ status: "processing", progress: 4, started_at: new Date().toISOString() })
      .eq("id", job.id);

    const segments: SequenceSegment[] = plan.segments.map((s) => ({
      url: plan.clipById[s.media_asset_id]!.url,
      sourceIn: s.source_in,
      sourceOut: s.source_out,
      speed: s.speed,
      outputDuration: s.output_duration,
    }));

    const { blob, extension, mimeType, thumbnail } = await renderSequence({
      segments,
      width: OUT_W,
      height: OUT_H,
      text: hook.text,
      placement: plan.placement,
      withAudio: !!withAudio,
      soundtrackUrl: input.soundtrackUrl,
      soundtrackVolume: input.soundtrackVolume,
      signal: input.signal,
      onProgress: (pct) => patch({ stage: "rendering", progress: Math.max(4, pct * 0.8) }),
    });

    patch({ stage: "encoding", progress: 85 });
    if (!blob || blob.size === 0) throw new Error("Renderer produced an empty video file.");

    patch({ stage: "uploading", progress: 90 });
    const outPath = `${userId}/${job.id}.${extension}`;
    const { error: upErr } = await supabase.storage
      .from(RENDER_BUCKET)
      .upload(outPath, blob, { contentType: mimeType, upsert: true });
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

    let thumbPath: string | null = null;
    if (thumbnail && thumbnail.size > 0) {
      thumbPath = `${userId}/${job.id}.jpg`;
      const { error: thumbErr } = await supabase.storage
        .from(RENDER_BUCKET)
        .upload(thumbPath, thumbnail, { contentType: "image/jpeg", upsert: true });
      if (thumbErr) thumbPath = null;
    }

    const url = await resolveRenderUrl(outPath);
    if (!url) throw new Error("Upload finished but the output file could not be read back.");

    if (isPreview) {
      // Nothing written to generated_videos yet — the file is uploaded and
      // playable so the user can actually judge it, but it doesn't become a
      // real, listed result until commitDnaPreview runs after approval.
      await supabase
        .from("render_jobs")
        .update({
          status: "processing",
          progress: 99,
          output_url: outPath,
          error_message: null,
        })
        .eq("id", job.id);

      patch({
        outputPath: outPath,
        thumbnailPath: thumbPath,
        stage: "completed",
        progress: 100,
        url,
        videoId: null,
        filename: `dna-preview.${extension}`,
      });
      return item;
    }

    const { data: video, error: videoErr } = await supabase
      .from("generated_videos")
      .insert({
        user_id: userId,
        project_id: projectId,
        render_job_id: job.id,
        recipe_id: recipe.id,
        hook_id: hook.id,
        media_asset_id: openerId,
        hook_text: hook.text,
        output_url: outPath,
        thumbnail_url: thumbPath,
        duration: plan.finalDuration,
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
      .eq("id", job.id);

    patch({
      outputPath: outPath,
      thumbnailPath: thumbPath,
      stage: "completed",
      progress: 100,
      url,
      videoId: video?.id ?? null,
      filename: `dna-${opener.filename.replace(/\.[^.]+$/, "")}.${extension}`,
    });
  } catch (e) {
    if (e instanceof RenderCancelledError) {
      patch({ stage: "failed", progress: 100, error: "Cancelled" });
      await supabase
        .from("render_jobs")
        .update({
          status: "cancelled",
          progress: 100,
          error_message: "Cancelled by user",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      return item;
    }
    const message = (e as Error).message || "Render failed.";
    patch({ stage: "failed", progress: 100, error: message });
    await supabase
      .from("render_jobs")
      .update({
        status: "failed",
        progress: 100,
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.id);
  }

  return item;
}

/**
 * Turn an already-rendered preview into a real, listed result. Call this
 * ONLY after the user approves — the video file was already uploaded during
 * the preview render, so this just writes the generated_videos row that
 * runDnaVariant skipped for a preview.
 */
export async function commitDnaPreview(input: {
  userId: string;
  projectId: string;
  item: BatchItem;
  hook: { id: string; text: string };
  plan: DnaPlan;
}): Promise<void> {
  const { userId, projectId, item, hook, plan } = input;
  if (!item.outputPath) throw new Error("No preview output to approve.");

  const { error: videoErr } = await supabase.from("generated_videos").insert({
    user_id: userId,
    project_id: projectId,
    render_job_id: item.jobId,
    recipe_id: item.recipeId,
    hook_id: hook.id,
    media_asset_id: item.sourceAssetId,
    hook_text: hook.text,
    output_url: item.outputPath,
    thumbnail_url: item.thumbnailPath,
    duration: plan.finalDuration,
    status: "completed",
  });
  if (videoErr) throw new Error(videoErr.message);

  await supabase
    .from("render_jobs")
    .update({
      status: "completed",
      progress: 100,
      output_url: item.outputPath,
      error_message: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", item.jobId);
}

/**
 * Discard an unapproved preview: remove the uploaded video/thumbnail from
 * storage (nothing was ever written to generated_videos, so there's no row
 * to delete) and mark its render_job cancelled so it doesn't linger as
 * "processing" forever.
 */
export async function deleteDnaPreview(item: BatchItem): Promise<void> {
  const paths = [item.outputPath, item.thumbnailPath].filter((p): p is string => Boolean(p));
  if (paths.length > 0) {
    await supabase.storage.from(RENDER_BUCKET).remove(paths);
  }
  await supabase
    .from("render_jobs")
    .update({
      status: "cancelled",
      progress: 100,
      error_message: "Preview discarded",
      completed_at: new Date().toISOString(),
    })
    .eq("id", item.jobId);
}

export type DnaBatchInput = {
  userId: string;
  projectId: string;
  clips: DnaClip[];
  hooks: { id: string; text: string }[];
  targetDuration: number;
  quantity: number;
  withAudio?: boolean;
  /** Fully-resolved, CORS-readable URL of a soundtrack to bake into the export. */
  soundtrackUrl?: string | undefined;
  /** Soundtrack level, 0..1 (defaults to 1). */
  soundtrackVolume?: number | undefined;
  signal?: AbortSignal;
  onUpdate: (items: BatchItem[]) => void;
};

/**
 * Render the remaining variants after a preview was approved. Each variant is
 * solved independently, so cuts, speeds and clip picks differ between them
 * even though they all land on the same target duration.
 */
export async function runDnaBatch(input: DnaBatchInput): Promise<BatchItem[]> {
  const { clips, hooks, targetDuration, quantity, signal } = input;
  if (hooks.length === 0) throw new Error("Select at least one hook.");

  const items: BatchItem[] = [];
  for (let i = 0; i < Math.max(1, quantity); i++) {
    // Checked BEFORE starting each variant — a cancel mid-batch must stop the
    // remaining queued variants from ever starting, not just interrupt
    // whichever one happens to be rendering right now.
    if (signal?.aborted) break;
    const planned = planDna(clips, targetDuration);
    if (!planned.ok) throw new Error(planned.reason);
    const hook = hooks[i % hooks.length]!;
    const item = await runDnaVariant({
      userId: input.userId,
      projectId: input.projectId,
      plan: planned.plan,
      hook,
      withAudio: !!input.withAudio,
      soundtrackUrl: input.soundtrackUrl,
      soundtrackVolume: input.soundtrackVolume,
      signal,
      onUpdate: (updated) => {
        const idx = items.findIndex((b) => b.jobId === updated.jobId);
        if (idx >= 0) items[idx] = updated;
        else items.push(updated);
        input.onUpdate([...items]);
      },
    });
    if (!items.some((b) => b.jobId === item.jobId)) items.push(item);
    input.onUpdate([...items]);
  }
  return items;
}

/** Human-readable description of a solved recipe, for the approval card. */
export function describePlan(plan: DnaPlan) {
  return plan.segments.map((s) => ({
    role: s.role,
    filename: plan.clipById[s.media_asset_id]?.filename ?? "clip",
    cut: `${s.source_in.toFixed(2)}s → ${s.source_out.toFixed(2)}s`,
    speed: `${s.speed}x`,
    outputDuration: `${s.output_duration.toFixed(2)}s`,
  }));
}
