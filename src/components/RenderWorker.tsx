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
        await supabase
          .from("render_jobs")
          .update({
            status: "processing",
            progress: 5,
            started_at: new Date().toISOString(),
          })
          .eq("id", job.id);

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

        const isDna = recipe.background_color?.includes("dna");
        const targetDuration = recipe.duration && recipe.duration > 0 && recipe.duration <= 30 ? recipe.duration : 8;

        // Notify Telegram that rendering has actively started
        sendTelegramNotificationFn({
          data: {
            message: `⚙️ <b>Rendering started in browser!</b>\n\n• <b>Mode:</b> ${isDna ? "Clip DNA" : "Single Render"}\n• <b>Duration:</b> ${targetDuration}s\n• <b>Hook:</b> "${recipe.overlay_text}"`,
          },
        }).catch(() => {});

        // Map overlay position
        let placement: HookPlacement = "top";
        if (recipe.overlay_position === "center" || recipe.overlay_position === "middle") {
          placement = "middle";
        } else if (recipe.overlay_position === "bottom") {
          placement = "bottom";
        }

        let renderResult: { blob: Blob; extension: string; mimeType: string; thumbnail?: Blob | null };

        if (isDna) {
          // --- CLIP DNA MULTI-CLIP RENDERING ---
          const { data: clips } = await supabase
            .from("media_assets")
            .select("id, storage_path, filename")
            .eq("user_id", job.user_id)
            .order("created_at", { ascending: false })
            .limit(2);

          if (!clips || clips.length === 0) {
            throw new Error("No media clips available for DNA sequence");
          }

          // Generate signed URLs for the clips
          const segments: SequenceSegment[] = [];
          const segDuration = targetDuration / clips.length;

          for (const clip of clips) {
            const { data: sData } = await supabase.storage.from("media").createSignedUrl(clip.storage_path, 3600);
            if (sData?.signedUrl) {
              segments.push({
                url: sData.signedUrl,
                sourceIn: 0,
                sourceOut: segDuration,
                speed: 1,
                outputDuration: segDuration,
              });
            }
          }

          if (segments.length === 0) {
            throw new Error("Could not resolve media clips for DNA rendering");
          }

          renderResult = await renderSequence({
            segments,
            width: OUT_W,
            height: OUT_H,
            text: recipe.overlay_text || "",
            placement,
            withAudio: true,
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
            withAudio: true,
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

        // 5. Save & Approval Handling:
        if (isDna) {
          // --- DNA Render: Keep as preview for Telegram approval ---
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

          toast.success("DNA Preview ready! Sending to Telegram for approval...", { id: toastId });

          // Send 9:16 preview with inline Approve & Discard buttons
          try {
            const base64Video = await blobToBase64(blob);
            await sendTelegramPreviewFn({
              data: {
                base64Video,
                caption: `🎬 <b>Clip DNA Preview (9:16)</b>\n\n• <b>Hook:</b> "${recipe.overlay_text}"\n• <b>Duration:</b> ${targetDuration}s\n\nApprove below to save to your project library:`,
                projectId: job.project_id,
                jobId: job.id,
              },
            });
            toast.success("Preview delivered to Telegram!", { id: toastId });
          } catch (tgErr) {
            console.warn("Telegram preview sending error:", tgErr);
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

          // Notify Telegram of auto-save completion (no preview buttons required)
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
