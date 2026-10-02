import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { renderVariant, type HookPlacement } from "@/lib/render/browser-render";
import { RENDER_BUCKET, OUT_W, OUT_H } from "@/lib/render/pipeline";
import { sendTelegramPreviewFn } from "@/lib/telegram.functions";

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

        // 4. Fetch media clip asset
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

        // 5. Create signed URL for media clip
        const { data: signData, error: signErr } = await supabase.storage
          .from("media")
          .createSignedUrl(asset.storage_path, 3600);

        if (signErr || !signData?.signedUrl) {
          throw new Error(signErr?.message || "Could not generate signed URL for media clip");
        }

        // Map overlay position to browser-render HookPlacement ('top' | 'middle' | 'bottom')
        let placement: HookPlacement = "top";
        if (recipe.overlay_position === "center" || recipe.overlay_position === "middle") {
          placement = "middle";
        } else if (recipe.overlay_position === "bottom") {
          placement = "bottom";
        }

        // 6. Execute browser-side canvas rendering
        const { blob, extension, mimeType, thumbnail } = await renderVariant({
          sourceUrl: signData.signedUrl,
          startSeconds: 0,
          durationSeconds: recipe.duration || 8,
          width: recipe.width || OUT_W,
          height: recipe.height || OUT_H,
          text: recipe.overlay_text || "",
          placement,
          fontSize: recipe.font_size || 48,
          withAudio: true,
          onProgress: (pct) => {
            const p = Math.max(5, Math.min(85, Math.round(pct * 0.85)));
            supabase
              .from("render_jobs")
              .update({ progress: p })
              .eq("id", job.id)
              .then(() => {});
          },
        });

        if (!blob || blob.size === 0) {
          throw new Error("Renderer produced an empty video blob");
        }

        toast.loading("Uploading rendered video...", { id: toastId });

        // 7. Upload rendered video to storage
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

        // 8. Insert record in generated_videos
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
          duration: recipe.duration || 8,
          status: "completed",
        });

        // 9. Mark render_job as completed
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

        toast.success("Render completed successfully!", { id: toastId });

        // 10. Send Telegram preview
        try {
          toast.loading("Sending preview to Telegram...", { id: toastId });
          const base64Video = await blobToBase64(blob);
          await sendTelegramPreviewFn({
            data: {
              base64Video,
              caption: `🎬 <b>Render Ready!</b>\n\n• <b>Hook:</b> "${recipe.overlay_text}"\n• <b>Duration:</b> ${recipe.duration || 8}s`,
              projectId: job.project_id,
            },
          });
          toast.success("Preview delivered to Telegram bot!", { id: toastId });
        } catch (tgErr) {
          console.warn("Telegram preview delivery skipped or failed:", tgErr);
          toast.dismiss(toastId);
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

    // Check for pending jobs on initial mount
    checkPendingJobs();

    // Subscribe to Realtime inserts & updates on render_jobs
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

    // Polling fallback every 15s in case realtime drops
    const interval = setInterval(checkPendingJobs, 15000);

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  return null;
}
