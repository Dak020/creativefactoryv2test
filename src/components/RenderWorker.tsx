import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { renderVariant, type HookPlacement } from "@/lib/render/browser-render";
import { renderSequence, type SequenceSegment } from "@/lib/render/sequence-render";
import { RENDER_BUCKET, OUT_W, OUT_H } from "@/lib/render/pipeline";
import { sendTelegramNotificationFn, sendTelegramPreviewFn } from "@/lib/telegram.functions";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to encode video blob to base64"));
      } else {
        resolve(base64);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function RenderWorker() {
  const isProcessingRef = useRef(false);
  const processedJobsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let isMounted = true;

    async function processJob(jobId: string) {
      if (isProcessingRef.current || processedJobsRef.current.has(jobId)) {
        return;
      }

      isProcessingRef.current = true;
      processedJobsRef.current.add(jobId);

      const toastId = toast.loading("Background render worker starting...");

      try {
        // 1. Fetch job details
        const { data: job, error: jobErr } = await supabase
          .from("render_jobs")
          .select("id, user_id, project_id, recipe_id, status")
          .eq("id", jobId)
          .single();

        if (jobErr || !job) {
          throw new Error(jobErr?.message || "Render job not found");
        }

        if (job.status !== "queued") {
          toast.dismiss(toastId);
          return;
        }

        // 2. Mark as processing in database
        // Atomic claim: only the one tab whose update flips queued→processing
        // renders. Other open tabs/devices get zero rows back and stay silent.
        const { data: claimed } = await supabase
          .from("render_jobs")
          .update({
            status: "processing",
            progress: 5,
            started_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("status", "queued")
          .select("id");
        if (!claimed || claimed.length === 0) {
          toast.dismiss(toastId);
          return;
        }

        toast.loading("Rendering video frames in browser...", { id: toastId });

        // 3. Fetch recipe details
        const { data: recipe, error: recipeErr } = await supabase
          .from("video_recipes")
          .select("*")
          .eq("id", job.recipe_id)
          .single();

        if (recipeErr || !recipe) {
          throw new Error(recipeErr?.message || "Video recipe not found");
        }

        const isDna = (recipe.background_color ?? "").includes("dna");
        const targetDuration = recipe.duration && recipe.duration > 0 && recipe.duration <= 30 ? recipe.duration : 8;

        // 3b. Fetch the audio/render hints this job was queued with (from the
        //     Telegram bot or a future in-app queue). Absent hints = app-native
        //     behavior: original clip audio, no soundtrack.
        const { data: hint } = await supabase
          .from("render_job_hints")
          .select("with_audio, soundtrack_url, audio_label, clip_ids, style")
          .eq("recipe_id", recipe.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const withAudio = hint?.with_audio ?? true;
        let soundtrackUrl = hint?.soundtrack_url ?? undefined;
        if (soundtrackUrl?.startsWith("media:")) {
          const { data: s } = await supabase.storage
            .from("media")
            .createSignedUrl(soundtrackUrl.slice("media:".length), 60 * 60);
          soundtrackUrl = s?.signedUrl ?? undefined;
        }
        const batchMatch = hint?.style?.match(/batch=(\d+)/);
        const batchTotal = batchMatch ? Math.max(1, parseInt(batchMatch[1]!, 10)) : 1;

        // Notify Telegram that rendering has actively started
        sendTelegramNotificationFn({
          data: {
            message: `⚙️ <b>Rendering started in browser!</b>\n\n• <b>Mode:</b> ${isDna ? "Clip DNA" : "Single Render"}\n• <b>Duration:</b> ${targetDuration}s\n• <b>Sound:</b> ${hint?.audio_label ?? "Original clip audio"}\n• <b>Hook:</b> "${recipe.overlay_text}"`,
          },
        }).catch(() => {});

        // Map overlay position
        let placement: HookPlacement = "top";
        if (recipe.overlay_position === "center" || recipe.overlay_position === "middle") {
          placement = "middle";
        } else if (recipe.overlay_position === "bottom") {
          placement = "bottom";
        }

        let renderResult: { blob: Blob; extension: string; mimeType: string; thumbnail?: Blob | null | undefined };

        if (isDna) {
          // --- CLIP DNA MULTI-CLIP RENDERING (app-identical solver) ---
          // Pull the DNA-tagged clips for THIS project (the same ones the
          // app's own DNA pipeline uses), signed and ready for the solver.
          const { data: dnaRows, error: dnaErr } = await supabase
            .from("media_assets")
            .select("id, filename, duration, storage_path, dna_role, allowed_speeds, hook_placement, seek_mode, seek_seconds")
            .eq("user_id", job.user_id)
            .eq("project_id", job.project_id)
            .in("dna_role", ["start", "middle", "end"])
            .order("created_at", { ascending: false });

          if (dnaErr) throw new Error(dnaErr.message);
          if (!dnaRows || dnaRows.length < 2) {
            throw new Error("Need at least 2 DNA-tagged clips in this project for a Clip DNA render");
          }

          // If Telegram queued specific clip ids, honor them; otherwise use
          // every DNA-tagged clip in the project.
          const wanted = hint?.clip_ids?.length ? hint.clip_ids : dnaRows.map((r) => r.id);
          const chosen = dnaRows
            .filter((r) => wanted.includes(r.id))
            .map((r) => ({
              id: r.id,
              role: r.dna_role as "start" | "middle" | "end",
              duration: Number(r.duration ?? 0),
              allowedSpeeds:
                Array.isArray(r.allowed_speeds) && r.allowed_speeds.length > 0
                  ? r.allowed_speeds.map(Number)
                  : [1.0, 1.5, 1.7, 2.0],
              hookPlacement: r.hook_placement,
              seekMode: (["random", "beginning", "manual"].includes(r.seek_mode)
                ? r.seek_mode
                : undefined) as "random" | "beginning" | "manual" | undefined,
              seekSeconds: Number(r.seek_seconds ?? 0),
              filename: r.filename,
              storage_path: r.storage_path,
            }));

          // Signed URLs for the solver clips
          const clips = await Promise.all(
            chosen.map(async (c) => {
              const { data: sData } = await supabase.storage.from("media").createSignedUrl(c.storage_path, 3600);
              return sData?.signedUrl ? { ...c, url: sData.signedUrl } : null;
            }),
          );
          const ready = clips.filter((c): c is NonNullable<typeof c> => Boolean(c));
          if (ready.length !== chosen.length) {
            throw new Error("One or more DNA-tagged clips could not be read from storage");
          }

          // Run the app's own deterministic DNA solver — same cuts, speeds and
          // ordering the in-app DNA flow produces.
          const { planDna } = await import("@/lib/render/dna-pipeline");
          const planned = planDna(ready, targetDuration);
          if (!planned.ok) throw new Error(planned.reason);

          // Persist the dna_recipe so the result is a real DNA record, not
          // just a multi-clip render pretending to be one.
          const opener = planned.plan.clipById[planned.plan.segments[0]!.media_asset_id]!;
          await supabase.from("dna_recipes").insert({
            user_id: job.user_id,
            project_id: job.project_id,
            target_duration: planned.plan.targetDuration,
            final_duration: planned.plan.finalDuration,
            segments: planned.plan.segments,
            hook_id: recipe.hook_id,
            hook_placement: planned.plan.placement,
          });

          const segments: SequenceSegment[] = planned.plan.segments.map((s) => ({
            clipId: s.media_asset_id,
            url: planned.plan.clipById[s.media_asset_id]!.url,
            sourceIn: s.source_in,
            sourceOut: s.source_out,
            speed: s.speed,
            outputDuration: s.output_duration,
          }));

          renderResult = await renderSequence({
            segments,
            durationSeconds: planned.plan.finalDuration,
            width: OUT_W,
            height: OUT_H,
            text: recipe.overlay_text || "",
            placement: planned.plan.placement,
            withAudio,
            soundtrackUrl,
            signal: undefined,
            onProgress: (pct) => {
              const p = Math.max(5, Math.min(85, Math.round(pct * 0.85)));
              supabase.from("render_jobs").update({ progress: p }).eq("id", job.id).then(() => {});
            },
          });
        } else {
          // --- SINGLE CLIP RENDERING ---
          if (!recipe.media_asset_id) {
            throw new Error("Recipe is missing media_asset_id");
          }

          const { data: asset, error: assetErr } = await supabase
            .from("media_assets")
            .select("id, storage_path, filename")
            .eq("id", recipe.media_asset_id)
            .single();

          if (assetErr || !asset) {
            throw new Error(assetErr?.message || "Media asset clip not found");
          }

          const { data: signData, error: signErr } = await supabase.storage
            .from("media")
            .createSignedUrl(asset.storage_path, 3600);

          if (signErr || !signData?.signedUrl) {
            throw new Error(signErr?.message || "Could not generate signed URL for media clip");
          }

          renderResult = await renderVariant({
            sourceUrl: signData.signedUrl,
            startSeconds: 0,
            durationSeconds: targetDuration,
            width: OUT_W,
            height: OUT_H,
            text: recipe.overlay_text || "",
            placement,
            fontSize: recipe.font_size || 48,
            withAudio,
            soundtrackUrl: soundtrackUrl ?? null,
            onProgress: (pct) => {
              const p = Math.max(5, Math.min(85, Math.round(pct * 0.85)));
              supabase.from("render_jobs").update({ progress: p }).eq("id", job.id).then(() => {});
            },
          });
        }

        const { blob, extension, mimeType, thumbnail } = renderResult;

        if (!blob || blob.size === 0) {
          throw new Error("Renderer produced an empty video blob");
        }

        toast.loading("Uploading rendered video...", { id: toastId });

        // 4. Upload rendered video to storage
        const outPath = `${job.user_id}/${job.id}.${extension}`;
        const { error: uploadErr } = await supabase.storage
          .from(RENDER_BUCKET)
          .upload(outPath, blob, { contentType: mimeType, upsert: true });

        if (uploadErr) {
          throw new Error(`Upload failed: ${uploadErr.message}`);
        }

        // Upload thumbnail if available
        let thumbPath: string | null = null;
        if (thumbnail && thumbnail.size > 0) {
          thumbPath = `${job.user_id}/${job.id}.jpg`;
          const { error: thumbErr } = await supabase.storage
            .from(RENDER_BUCKET)
            .upload(thumbPath, thumbnail, { contentType: "image/jpeg", upsert: true });
          if (thumbErr) thumbPath = null;
        }

        // 5. Save & Approval Handling (approved-batch variants auto-save):
        if (isDna && !hint?.style?.includes("auto")) {
          // --- DNA Render: Keep as preview for Telegram approval ---
          // NOT saved to generated_videos yet. Mark the job 'awaiting_approval'
          // so it doesn't look finished, and don't flip status to 'completed'.
          await supabase
            .from("render_jobs")
            .update({
              status: "awaiting_approval",
              progress: 100,
              output_url: outPath,
              completed_at: null,
              error_message: null,
            })
            .eq("id", job.id);

          toast.success("DNA Preview ready! Sending to Telegram for approval...", { id: toastId });

          // Send 9:16 preview with inline Approve & Discard buttons.
          // The browser session is already authenticated, so we mint a
          // short-lived signed URL here and Telegram streams the video
          // directly from storage — no server-side buffering.
          try {
            const { data: signed, error: signErr } = await supabase.storage
              .from(RENDER_BUCKET)
              .createSignedUrl(outPath, 60 * 60);
            if (signErr || !signed?.signedUrl) {
              throw new Error(signErr?.message ?? "Could not sign video URL");
            }

            await sendTelegramPreviewFn({
              data: {
                signedUrl: signed.signedUrl,
                storagePath: outPath,
                caption: `🎬 <b>Clip DNA Preview (9:16)</b>\n\n• <b>Hook:</b> "${recipe.overlay_text}"\n• <b>Duration:</b> ${targetDuration}s\n• <b>Batch:</b> ${batchTotal}x\n\n${batchTotal > 1 ? `Approve to save this and render ${batchTotal} variants:` : "Approve below to save to your project library:"}`,
                jobId: job.id,
                batchTotal,
              },
            });
            toast.success("Preview delivered to Telegram!", { id: toastId });
          } catch (tgErr) {
            console.warn("Telegram preview sending error:", tgErr);
            toast.error(
              `Preview saved, but Telegram delivery failed: ${tgErr instanceof Error ? tgErr.message : "unknown error"}`,
              { id: toastId },
            );
          }
        } else {
          // --- Single Render: Auto-save directly without requiring approval ---
          await supabase.from("generated_videos").insert({
            user_id: job.user_id,
            project_id: job.project_id,
            render_job_id: job.id,
            recipe_id: recipe.id,
            hook_id: recipe.hook_id,
            media_asset_id: recipe.media_asset_id,
            hook_text: recipe.overlay_text,
            output_url: outPath,
            thumbnail_url: thumbPath,
            duration: targetDuration,
            status: "completed",
          });

          await supabase
            .from("render_jobs")
            .update({
              status: "completed",
              progress: 100,
              output_url: outPath,
              completed_at: new Date().toISOString(),
              error_message: null,
            })
            .eq("id", job.id);

          toast.success("Render completed and saved to library!", { id: toastId });

          sendTelegramNotificationFn({
            data: {
              message: `✅ <b>Single Render Complete!</b>\n\n• <b>Hook:</b> "${recipe.overlay_text}"\n• <b>Duration:</b> ${targetDuration}s\n\nAuto-saved to your project library and ready to schedule.`,
            },
          }).catch(() => {});
        }
      } catch (err) {
        const errorMsg = (err as Error).message || "Render failed";
        console.error("Worker render error:", err);
        toast.error(`Render failed: ${errorMsg}`, { id: toastId });

        await supabase
          .from("render_jobs")
          .update({
            status: "failed",
            progress: 100,
            error_message: errorMsg,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);

        sendTelegramNotificationFn({
          data: {
            message: `❌ <b>Render failed:</b> ${errorMsg}`,
          },
        }).catch(() => {});
      } finally {
        isProcessingRef.current = false;
        checkPendingJobs();
      }
    }

    async function checkPendingJobs() {
      if (!isMounted || isProcessingRef.current) return;
      try {
        const { data: pendingJobs } = await supabase
          .from("render_jobs")
          .select("id")
          .eq("status", "queued")
          .order("created_at", { ascending: true })
          .limit(1);

        if (pendingJobs && pendingJobs.length > 0) {
          const nextJob = pendingJobs[0];
          if (nextJob && !processedJobsRef.current.has(nextJob.id)) {
            processJob(nextJob.id);
          }
        }
      } catch (e) {
        console.warn("Failed checking pending render jobs:", e);
      }
    }

    checkPendingJobs();

    const channel = supabase
      .channel("render_jobs_worker")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "render_jobs",
        },
        (payload) => {
          const newRow = payload.new as { id?: string; status?: string } | undefined;
          if (newRow?.id && newRow.status === "queued") {
            processJob(newRow.id);
          }
        }
      )
      .subscribe();

    const interval = setInterval(checkPendingJobs, 15000);

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  return null;
}
