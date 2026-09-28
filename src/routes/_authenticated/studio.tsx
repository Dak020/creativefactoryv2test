import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Download, Film, Loader2, Plus, Trophy, Upload, Wand2 } from "lucide-react";
import { ScheduleTikTokDialog } from "@/components/ScheduleTikTokDialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { EmptyState, PageHeader, StatusPill } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HOOK_CATEGORIES } from "@/lib/constants";
import { videoExtension, videoFileError, withTimeout } from "@/lib/video-file";
import { fmtDate, fmtDuration, signedUrl } from "@/lib/db";
import {
  CLIP_SECONDS,
  OUT_H,
  OUT_W,
  STAGE_LABEL,
  reapStaleJobs,
  runBatch,
  runMultiClipBatch,
  type BatchItem,
} from "@/lib/render/pipeline";
import { deleteRender } from "@/lib/render/delete";
import { DeleteRenderButton } from "@/components/DeleteRenderButton";
import { RenderPlayer } from "@/components/RenderPlayer";
import { downloadRender, renderFilename, resolveRenderUrl } from "@/lib/render/output";


const QUANTITY_PRESETS = [1, 5, 10, 20, 30] as const;
const MAX_HOOKS = 10;
const MAX_QUANTITY = 30;

export const Route = createFileRoute("/_authenticated/studio")({
  head: () => ({
    meta: [
      { title: "Studio — Creative Factory" },
      {
        name: "description",
        content:
          "Upload one clip, pick your winning hooks, choose a batch size and render vertical videos with the hook burned in.",
      },
      { property: "og:title", content: "Studio — Creative Factory" },
      {
        property: "og:description",
        content: "The complete upload, hook selection, batch render, download and cleanup workflow.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: StudioPage,
});

type ResultCard = BatchItem & { videoId: string | null };

function StudioPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [scheduleTarget, setScheduleTarget] = useState<{ id: string; hookText: string | null } | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [live, setLive] = useState<BatchItem[]>([]);
  const [rendering, setRendering] = useState(false);
  const renderAbortRef = useRef<AbortController | null>(null);
  const [requested, setRequested] = useState(0);

  const [quantityChoice, setQuantityChoice] = useState<string>("5");
  const [customQuantity, setCustomQuantity] = useState("8");

  const [text, setText] = useState("");
  const [category, setCategory] = useState<string>(HOOK_CATEGORIES[0]);
  const [notes, setNotes] = useState("");
  const [winner, setWinner] = useState(true);
  const [savingHook, setSavingHook] = useState(false);

  const quantity = useMemo(() => {
    if (quantityChoice !== "custom") return Number(quantityChoice);
    const n = Math.round(Number(customQuantity));
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_QUANTITY, Math.max(1, n));
  }, [quantityChoice, customQuantity]);

  // Jobs abandoned by a closed tab must not linger as "in progress" after a refresh.
  useEffect(() => {
    if (!user) return;
    void reapStaleJobs(user.id).then(() =>
      qc.invalidateQueries({ queryKey: ["studio-results"] }),
    );
  }, [user?.id, qc]);



  // Studio can scope itself to a specific project's own media and hooks —
  // pick one from this selector, same idea as the Project page already
  // uses. With nothing selected, Studio keeps its original behavior: the
  // single hidden "Studio" catch-all project used for quick, unsorted work.
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);

  const { data: userProjects } = useQuery({
    queryKey: ["studio-projects", user?.id ?? "anon"],
    enabled: Boolean(user),
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("projects")
        .select("id, name")
        .neq("name", "Studio")
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: defaultStudioProjectId } = useQuery({
    queryKey: ["studio-default-project", user?.id ?? "anon"],
    enabled: Boolean(user),
    staleTime: 60_000,
    queryFn: async () => (user ? ensureStudioProject(user.id) : null),
  });

  const effectiveProjectId = scopeProjectId ?? defaultStudioProjectId ?? null;

  const { data: assets } = useQuery({
    queryKey: ["studio-assets", user?.id ?? "anon", effectiveProjectId],
    enabled: Boolean(user) && Boolean(effectiveProjectId),
    staleTime: 15_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("media_assets")
        .select("id, filename, storage_path, duration, hook_placement, created_at, project_id")
        .eq("project_id", effectiveProjectId as string)
        .order("created_at", { ascending: false })
        .limit(100);
      return data ?? [];
    },
  });

  const { data: hooks } = useQuery({
    queryKey: ["studio-hooks", user?.id ?? "anon", effectiveProjectId],
    enabled: Boolean(user) && Boolean(effectiveProjectId),
    staleTime: 15_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("hooks")
        .select("id, text, category, notes, is_winner, created_at")
        .eq("project_id", effectiveProjectId as string)
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  // Persisted results, so everything survives a page reload.
  const { data: pastResults } = useQuery({
    queryKey: ["studio-results", user?.id ?? "anon"],
    enabled: Boolean(user),
    staleTime: 15_000,
    queryFn: async (): Promise<ResultCard[]> => {

      const [videos, failedJobs] = await Promise.all([
        supabase
          .from("generated_videos")
          .select(
            "id, hook_id, hook_text, output_url, thumbnail_url, duration, status, created_at, render_job_id, recipe_id, media_asset_id, media_assets(filename)",
          )
          .order("created_at", { ascending: false })
          .limit(30),
        supabase
          .from("render_jobs")
          .select("id, status, error_message, created_at, video_recipes(overlay_text, media_asset_id)")
          .eq("status", "failed")
          .order("created_at", { ascending: false })
          .limit(12),
      ]);

      const done: ResultCard[] = await Promise.all(
        (videos.data ?? []).map(async (r): Promise<ResultCard> => {
          const url = await resolveRenderUrl(r.output_url);
          const ok = Boolean(url) && r.status === "completed";
          return {
            jobId: r.render_job_id ?? r.id,
            videoId: r.id,
            recipeId: r.recipe_id,
            hookId: r.hook_id ?? "",
            hookText: r.hook_text ?? "Untitled hook",
            sourceName: (r.media_assets as { filename?: string } | null)?.filename ?? "Source clip",
            sourceAssetId: r.media_asset_id ?? "",
            durationSeconds: Number(r.duration ?? CLIP_SECONDS),
            createdAt: r.created_at,
            outputPath: r.output_url,
            thumbnailPath: r.thumbnail_url,
            stage: ok ? "completed" : "failed",
            progress: 100,
            ...(url ? { url } : { error: "Output file is missing from storage." }),
            filename: renderFilename(r.output_url, `hook-variant-${r.id.slice(0, 6)}`),
          };
        }),
      );

      const videoJobIds = new Set(done.map((d) => d.jobId));
      const failed: ResultCard[] = (failedJobs.data ?? [])
        .filter((j) => !videoJobIds.has(j.id))
        .map((j) => ({
          jobId: j.id,
          videoId: null,
          recipeId: null,
          hookId: "",
          hookText:
            (j.video_recipes as { overlay_text?: string } | null)?.overlay_text ?? "Untitled hook",
          sourceName: "Source clip",
          sourceAssetId: (j.video_recipes as { media_asset_id?: string } | null)?.media_asset_id ?? "",
          durationSeconds: CLIP_SECONDS,
          createdAt: j.created_at,
          outputPath: null,
          thumbnailPath: null,
          stage: "failed" as const,
          progress: 100,
          error: j.error_message ?? "Render failed.",
        }));

      return [...done, ...failed].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
  });

  const liveIds = new Set(live.map((l) => l.jobId));
  const results: ResultCard[] = [
    ...live.map((l) => ({ ...l, videoId: l.videoId })),
    ...(pastResults ?? []).filter((p) => !liveIds.has(p.jobId)),
  ];

  const completedCount = live.filter((l) => l.stage === "completed").length;
  const failedItems = live.filter((l) => l.stage === "failed");

  const asset = useMemo(
    () => (assets ?? []).find((a) => a.id === assetId) ?? (assets ?? [])[0] ?? null,
    [assets, assetId],
  );

  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!asset?.storage_path) {
      setAssetUrl(null);
      return;
    }
    signedUrl("media", asset.storage_path, 60 * 60 * 6).then((u) => {
      if (active) setAssetUrl(u);
    });
    return () => {
      active = false;
    };
  }, [asset?.storage_path]);

  // Multi-clip batch: when the user turns this on and picks 2+ clips, a
  // single "generate" spreads the requested quantity evenly across all
  // selected clips (remainder randomly assigned) instead of using only the
  // single clip picked above.
  const [multiClipMode, setMultiClipMode] = useState(false);
  const [originalSound, setOriginalSound] = useState(false);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  function toggleClipSelected(id: string) {
    setSelectedClipIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  const onUpload = useCallback(
    async (file: File) => {
      if (!user) {
        toast.error("You are signed out — sign in again to upload.");
        return;
      }
      const invalid = videoFileError(file);
      if (invalid) {
        toast.error(invalid);
        return;
      }
      setUploading(true);
      try {
        const projectId = effectiveProjectId ?? (await ensureStudioProject(user.id));
        if (!projectId) throw new Error("Could not prepare the studio project.");
        const meta = await withTimeout(probeVideo(file), 15000, {
          duration: 0,
          width: 0,
          height: 0,
        });
        const ext = videoExtension(file);
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("media")
          .upload(path, file, { contentType: file.type || "video/mp4", upsert: false });
        if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

        const { data, error } = await supabase
          .from("media_assets")
          .insert({
            user_id: user.id,
            project_id: projectId,
            storage_path: path,
            filename: file.name || `clip.${ext}`,
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            size_bytes: file.size,
            category: "Other",
          })
          .select("id")
          .single();
        if (error || !data) {
          await supabase.storage.from("media").remove([path]);
          throw new Error(`Saving the clip failed: ${error?.message ?? "no record returned"}`);
        }

        setAssetId(data.id);
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["studio-assets"] }),
          qc.invalidateQueries({ queryKey: ["media"] }),
          qc.invalidateQueries({ queryKey: ["project"] }),
        ]);
        toast.success("Source video uploaded");
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [qc, user],
  );

  async function saveHook() {
    if (!user) return;
    if (text.trim().length < 4) {
      toast.error("Write the hook text first.");
      return;
    }
    setSavingHook(true);
    const projectId = effectiveProjectId ?? (await ensureStudioProject(user.id));
    const { error } = await supabase.from("hooks").insert({
      user_id: user.id,
      project_id: projectId,
      text: text.trim(),
      category,
      notes: notes.trim() || null,
      is_winner: winner,
    });
    setSavingHook(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setText("");
    setNotes("");
    await qc.invalidateQueries({ queryKey: ["studio-hooks"] });
    toast.success("Hook saved");
  }

  function toggleHook(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((h) => h !== id);
      if (prev.length >= MAX_HOOKS) {
        toast.info(`You can select up to ${MAX_HOOKS} hooks per batch.`);
        return prev;
      }
      return [...prev, id];
    });
  }

  async function createVariants() {
    if (!user) {
      toast.error("Sign in again to continue.");
      return;
    }
    if (selected.length === 0) {
      toast.error("Select at least one hook.");
      return;
    }
    const chosen = selected
      .map((id) => (hooks ?? []).find((h) => h.id === id))
      .filter((h): h is NonNullable<typeof h> => Boolean(h))
      .map((h) => ({ id: h.id, text: h.text }));

    const projectId = effectiveProjectId ?? (await ensureStudioProject(user.id));
    if (!projectId) {
      toast.error("Could not prepare the studio project.");
      return;
    }

    if (multiClipMode) {
      if (selectedClipIds.length === 0) {
        toast.error("Select at least one clip.");
        return;
      }
      const chosenAssets = selectedClipIds
        .map((id) => (assets ?? []).find((a) => a.id === id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a));
      if (chosenAssets.length === 0) {
        toast.error("Selected clips could not be found — try reselecting.");
        return;
      }

      const controller = new AbortController();
      renderAbortRef.current = controller;
      setRendering(true);
      setRequested(quantity);
      setLive([]);
      try {
        const withUrls = await Promise.all(
          chosenAssets.map(async (a) => {
            const url = await signedUrl("media", a.storage_path, 60 * 60 * 6);
            return url ? { ...a, url } : null;
          }),
        );
        const ready = withUrls.filter((a): a is NonNullable<typeof a> => Boolean(a));
        if (ready.length === 0) {
          toast.error("Could not load the selected clips — try again.");
          return;
        }
        const items = await runMultiClipBatch({
          userId: user.id,
          projectId,
          assets: ready.map((a) => ({
            id: a.id,
            filename: a.filename,
            duration: a.duration,
            storage_path: a.storage_path,
            hook_placement: a.hook_placement,
            url: a.url,
          })),
          hooks: chosen,
          quantity,
          withAudio: originalSound,
          signal: controller.signal,
          onUpdate: setLive,
        });
        const done = items.filter((i) => i.stage === "completed").length;
        const cancelled = items.some((i) => i.error === "Cancelled");
        if (cancelled) toast.info(`Cancelled — ${done} of ${quantity} variants had already finished`);
        else if (done === items.length) toast.success(`${done} of ${quantity} variants rendered across ${ready.length} clips`);
        else toast.warning(`${done} of ${quantity} variants rendered — see the failed cards below`);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setRendering(false);
        renderAbortRef.current = null;
        await qc.invalidateQueries({ queryKey: ["studio-results"] });
        await qc.invalidateQueries({ queryKey: ["project"] });
      }
      return;
    }

    if (!asset || !assetUrl) {
      toast.error("Upload a source video first.");
      return;
    }

    const controller = new AbortController();
    renderAbortRef.current = controller;
    setRendering(true);
    setRequested(quantity);
    setLive([]);
    try {
      const items = await runBatch({
        userId: user.id,
        projectId,
        asset: {
          id: asset.id,
          filename: asset.filename,
          duration: asset.duration,
          storage_path: asset.storage_path,
          hook_placement: asset.hook_placement,
        },
        assetUrl,
        hooks: chosen,
        quantity,
        withAudio: audioSelection.withAudio,
        soundtrackUrl,
        signal: controller.signal,
        onUpdate: setLive,
      });
      const done = items.filter((i) => i.stage === "completed").length;
      const cancelled = items.some((i) => i.error === "Cancelled");
      if (cancelled) toast.info(`Cancelled — ${done} of ${quantity} variants had already finished`);
      else if (done === items.length) toast.success(`${done} of ${quantity} variants rendered`);
      else toast.warning(`${done} of ${quantity} variants rendered — see the failed cards below`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRendering(false);
      renderAbortRef.current = null;
      await qc.invalidateQueries({ queryKey: ["studio-results"] });
      await qc.invalidateQueries({ queryKey: ["project"] });
    }
  }

  function cancelRender() {
    renderAbortRef.current?.abort();
  }

  async function removeResult(card: ResultCard) {
    try {
      if (card.videoId) {
        await deleteRender({
          id: card.videoId,
          output_url: card.outputPath,
          thumbnail_url: card.thumbnailPath,
          render_job_id: card.jobId,
          recipe_id: card.recipeId,
        });
      }
      setLive((prev) => prev.filter((l) => l.jobId !== card.jobId));
      await qc.invalidateQueries({ queryKey: ["studio-results"] });
      await qc.invalidateQueries({ queryKey: ["project"] });
      toast.success("Render deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Studio"
        description="Upload one clip, select your hooks, choose how many variants to render, and export ready-to-post vertical videos."
      />

      <div className="panel flex flex-wrap items-center gap-3 p-4">
        <Label className="text-xs whitespace-nowrap">Working in</Label>
        <Select
          value={scopeProjectId ?? "__default__"}
          onValueChange={(v) => setScopeProjectId(v === "__default__" ? null : v)}
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder="Quick Studio work" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">Quick Studio work (unsorted)</SelectItem>
            {(userProjects ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Clips, hooks, and renders you add here go into this project — switch to see or work on a different one.
        </p>
      </div>

      {/* 1. Source video */}
      <section className="panel p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">1. Source video</h2>
            <p className="text-xs text-muted-foreground">One MP4 or MOV clip powers the whole batch.</p>
          </div>
          <Button onClick={() => fileRef.current?.click()} disabled={uploading} variant="secondary">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Upload video
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.mov"
            hidden
            onChange={(e) => {
              const input = e.currentTarget;
              const files = Array.from(input.files ?? []);
              input.value = "";
              const f = files[0];
              if (f) void onUpload(f);
            }}
          />
        </div>

        <div className="mt-5 grid gap-5 md:grid-cols-[240px_1fr]">
          <div className="overflow-hidden rounded-xl border border-border bg-black">
            {assetUrl ? (
              <video
                src={assetUrl}
                controls
                playsInline
                preload="metadata"
                className="aspect-[9/16] w-full bg-black object-contain"
              />

            ) : (
              <div className="flex aspect-[9/16] items-center justify-center text-xs text-muted-foreground">
                No source video
              </div>
            )}
          </div>
          <div className="space-y-3">
            {asset ? (
              <div className="text-sm">
                <p className="font-medium">{asset.filename}</p>
                <p className="text-xs text-muted-foreground">
                  Duration {fmtDuration(asset.duration)} · output {OUT_W}×{OUT_H} ·{" "}
                  {Math.round(Math.min(Number(asset.duration ?? CLIP_SECONDS), CLIP_SECONDS))}s per variant
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Upload a clip to get started.</p>
            )}
            {(assets ?? []).length > 1 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Use another upload</Label>
                <Select value={asset?.id ?? ""} onValueChange={setAssetId}>
                  <SelectTrigger className="max-w-sm">
                    <SelectValue placeholder="Pick a clip" />
                  </SelectTrigger>
                  <SelectContent>
                    {(assets ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.filename}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {(assets ?? []).length > 1 && (
              <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Generate across multiple clips</Label>
                  <Switch checked={multiClipMode} onCheckedChange={setMultiClipMode} />
                </div>
                {multiClipMode && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Pick 2 or more clips — the batch splits evenly across them (any remainder goes to a
                      random pick). Each clip renders with its own saved hook placement.
                    </p>
                    <div className="max-h-48 space-y-1 overflow-y-auto">
                      {(assets ?? []).map((a) => (
                        <label
                          key={a.id}
                          className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={selectedClipIds.includes(a.id)}
                            onCheckedChange={() => toggleClipSelected(a.id)}
                          />
                          <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                          <span className="text-xs text-muted-foreground">{fmtDuration(a.duration)}</span>
                        </label>
                      ))}
                    </div>
                    {selectedClipIds.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {selectedClipIds.length} clip{selectedClipIds.length === 1 ? "" : "s"} selected
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 2. Hook library */}
      <section className="panel p-5">
        <h2 className="text-sm font-semibold">2. Hook library</h2>
        <p className="text-xs text-muted-foreground">
          Save your winning openings, then select up to {MAX_HOOKS} for this batch.
        </p>

        <div className="mt-5 grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="hook-text" className="text-xs">
                Hook text
              </Label>
              <Textarea
                id="hook-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder="I tried this for 30 days and…"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Content style</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hook-notes" className="text-xs">
                Notes (optional)
              </Label>
              <Input
                id="hook-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Where it worked, why it hit…"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <span className="flex items-center gap-2 text-xs">
                <Trophy className="size-3.5 text-primary" /> Winner
              </span>
              <Switch checked={winner} onCheckedChange={setWinner} />
            </div>
            <Button onClick={() => void saveHook()} disabled={savingHook} className="w-full">
              {savingHook ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Save hook
            </Button>
          </div>

          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {selected.length}/{MAX_HOOKS} selected
            </p>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {(hooks ?? []).length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No hooks yet — save your first one.
                </p>
              ) : (
                (hooks ?? []).map((h) => (
                  <label
                    key={h.id}
                    className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-surface-raised/50"
                  >
                    <Checkbox
                      checked={selected.includes(h.id)}
                      onCheckedChange={() => toggleHook(h.id)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{h.text}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {h.category}
                        {h.is_winner ? " · Winner" : ""}
                        {h.notes ? ` · ${h.notes}` : ""}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Batch */}
      <section className="panel space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">3. Create the batch</h2>
          <p className="text-xs text-muted-foreground">
            Each variant trims a different section (up to {CLIP_SECONDS}s — shorter clips keep their full
            length) and burns one hook into the exported file.
          </p>
        </div>

        <AudioStrategySelector
          value={audioSelection}
          onChange={setAudioSelection}
          initialAudioId={search.audioId ?? null}
        />

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Batch quantity</Label>
            <Select value={quantityChoice} onValueChange={setQuantityChoice}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUANTITY_PRESETS.map((q) => (
                  <SelectItem key={q} value={String(q)}>
                    {q} variant{q === 1 ? "" : "s"}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {quantityChoice === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor="custom-qty" className="text-xs">
                How many? (1–{MAX_QUANTITY})
              </Label>
              <Input
                id="custom-qty"
                type="number"
                min={1}
                max={MAX_QUANTITY}
                value={customQuantity}
                onChange={(e) => setCustomQuantity(e.target.value)}
                className="w-32"
              />
            </div>
          ) : null}

          <Button
            onClick={() => void createVariants()}
            disabled={rendering || selected.length === 0 || !asset}
          >
            {rendering ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
            Render {quantity} variant{quantity === 1 ? "" : "s"}
          </Button>
          {rendering ? (
            <Button variant="outline" onClick={cancelRender}>
              Cancel
            </Button>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          Requesting <span className="font-medium text-foreground">{quantity}</span> variant
          {quantity === 1 ? "" : "s"} from {selected.length || 0} selected hook
          {selected.length === 1 ? "" : "s"}
          {selected.length > 0 && quantity > selected.length
            ? " (hooks cycle across the batch)"
            : ""}
          . Nothing extra is generated.
        </p>

        {requested > 0 ? (
          <div className="rounded-lg border border-border bg-surface-raised/40 px-4 py-3 text-xs">
            <span className="font-medium">
              {completedCount} completed / {requested} requested
            </span>
            {failedItems.length > 0 ? (
              <span className="text-destructive">
                {" "}
                · {failedItems.length} failed:{" "}
                {failedItems.map((f) => f.jobId.slice(0, 8)).join(", ")}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 4. Results */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">4. Results</h2>
        {results.length === 0 ? (
          <EmptyState
            icon={Film}
            title="No variants yet"
            description="Upload a clip, select hooks, choose a batch size and run the render."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((b, i) => (
              <div key={b.jobId} className="panel space-y-3 p-4">
                <div className="overflow-hidden rounded-lg border border-border bg-black">
                  {b.url ? (
                    <RenderPlayer src={b.url} />
                  ) : (
                    <div className="flex aspect-[9/16] items-center justify-center px-4 text-center text-xs text-muted-foreground">
                      {b.stage === "failed" ? "Render failed" : `${STAGE_LABEL[b.stage]}…`}
                    </div>
                  )}
                </div>
                <p className="line-clamp-2 text-sm font-medium">{b.hookText}</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {b.sourceName} · {Math.round(b.durationSeconds)}s · {fmtDate(b.createdAt)}
                  <br />
                  Job {b.jobId.slice(0, 8)}
                  {b.recipeId ? ` · Recipe ${b.recipeId.slice(0, 8)}` : ""}
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StatusPill status={STAGE_LABEL[b.stage]} />
                  <div className="flex items-center gap-2">
                    {b.url ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void downloadRender(b.url!, b.filename ?? `hook-variant-${i + 1}.mp4`).catch((e) =>
                            toast.error((e as Error).message),
                          )
                        }
                      >
                        <Download className="size-3.5" />
                        Download
                      </Button>
                    ) : null}
                    {b.videoId && b.url ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          setScheduleTarget({ id: b.videoId!, hookText: b.hookText ?? null })
                        }
                      >
                        <CalendarClock className="size-3.5" />
                        Schedule
                      </Button>
                    ) : null}
                    {b.videoId ? (
                      <DeleteRenderButton onConfirm={() => removeResult(b)} />
                    ) : null}
                  </div>
                </div>

                {b.stage !== "completed" && b.stage !== "failed" ? (
                  <Progress value={b.progress} className="h-1.5" />
                ) : null}
                {b.error ? <p className="text-[11px] text-destructive">{b.error}</p> : null}
              </div>
            ))}
          </div>
        )}
      </section>
      <ScheduleTikTokDialog
        videoId={scheduleTarget?.id ?? ""}
        hookText={scheduleTarget?.hookText ?? null}
        open={Boolean(scheduleTarget)}
        onOpenChange={(o) => !o && setScheduleTarget(null)}
      />
    </div>
  );
}

async function ensureStudioProject(userId: string) {
  const { data: existing } = await supabase
    .from("projects")
    .select("id")
    .eq("name", "Studio")
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data } = await supabase
    .from("projects")
    .insert({ user_id: userId, name: "Studio", platform: "both", content_style: "ugc" })
    .select("id")
    .single();
  return data?.id ?? null;
}

function probeVideo(file: File) {
  return new Promise<{ duration: number; width: number; height: number }>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const meta = {
        duration: Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ duration: 0, width: 0, height: 0 });
    };
    video.src = url;
  });
}
