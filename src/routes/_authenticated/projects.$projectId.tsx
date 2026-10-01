import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Sparkles,
  Layers,
  FileText,
  Film,
  Calendar,
  Send,
  Loader2,
  Trash2,
  AlertCircle,
  HelpCircle,
  FolderOpen,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  runBatch,
  runMultiClipBatch,
  MAX_QUANTITY,
  QUANTITY_PRESETS,
  signedUrl,
  reapStaleJobs,
  STAGE_LABEL,
  STAGE_ICON,
  type BatchItem,
  type RenderStage,
} from "@/lib/render/pipeline";
import {
  planDna,
  runDnaVariant,
  commitDnaPreview,
  deleteDnaPreview,
  type DnaClip,
  type DnaPlan,
} from "@/lib/render/dna-pipeline";
import { checkRoles } from "@/lib/dna/solver";
import { resolveRenderUrl } from "@/lib/render/output";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AudioStrategySelector,
  type AudioSelection,
} from "@/components/AudioStrategySelector";
import { HookLibraryPanel } from "@/components/HookLibraryPanel";
import { MediaLibraryPanel } from "@/components/MediaLibraryPanel";
import { HookGeneratorDialog } from "@/components/HookGeneratorDialog";
import { ScheduleTikTokDialog } from "@/components/ScheduleTikTokDialog";
import { RenderPlayer } from "@/components/RenderPlayer";
import { RenderFeedback } from "@/components/RenderFeedback";
import { DeleteRenderButton } from "@/components/DeleteRenderButton";
import { prepareAudioForRenderFn } from "@/lib/audio.functions";
import { resolveAudioForRender } from "@/lib/audio-url";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  component: ProjectDetailPage,
  head: () => ({
    meta: [
      { title: "Project Workspace — Creative Factory AI Assistant" },
      {
        name: "description",
        content: "Generate and manage video variants for this project.",
      },
    ],
  }),
});

function StatusPill({ status }: { status: string }) {
  const Icon = STAGE_ICON[status as RenderStage] ?? AlertCircle;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
      <Icon className="size-3" />
      {status}
    </span>
  );
}

function ProjectDetailPage() {
  const { projectId } = Route.useParams();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [quantityChoice, setQuantityChoice] = useState<string>("8");
  const [customQuantity, setCustomQuantity] = useState("8");
  const [live, setLive] = useState<BatchItem[]>([]);
  const [showJobHistory, setShowJobHistory] = useState(false);

  const [selectedClipIds, setSelectedClipIds] = useState<string[] | null>(null);

  const [targetDuration, setTargetDuration] = useState("8");
  const [dnaQuantity, setDnaQuantity] = useState("4");
  const prepareAudioForRender = useServerFn(prepareAudioForRenderFn);
  const [audioSelection, setAudioSelection] = useState<AudioSelection>({
    strategy: "none",
    withAudio: false,
    audio: null,
  });

  const [dnaRunning, setDnaRunning] = useState(false);
  const [dnaLive, setDnaLive] = useState<BatchItem[]>([]);
  const [dnaPreview, setDnaPreview] = useState<{
    item: BatchItem;
    plan: DnaPlan;
    clips: DnaClip[];
    hook: { id: string; text: string };
  } | null>(null);

  const quantity = useMemo(() => {
    if (quantityChoice !== "custom") return Number(quantityChoice);
    const n = Math.round(Number(customQuantity));
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_QUANTITY, Math.max(1, n));
  }, [quantityChoice, customQuantity]);

  const dnaCount = useMemo(() => {
    const n = Math.round(Number(dnaQuantity));
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_QUANTITY, Math.max(1, n));
  }, [dnaQuantity]);

  useEffect(() => {
    if (!user) return;
    void reapStaleJobs(user.id, projectId).then(() =>
      qc.invalidateQueries({ queryKey: ["project", projectId] }),
    );
  }, [user?.id, projectId, qc]);

  const { data, isLoading } = useQuery({
    queryKey: ["project", projectId, user?.id ?? "anon"],
    enabled: Boolean(user),
    staleTime: 15_000,
    queryFn: async () => {
      const [project, product, jobs, videos, hooks, media] = await Promise.all([
        supabase.from("projects").select("*").eq("id", projectId).maybeSingle(),
        supabase.from("products").select("*").eq("project_id", projectId).maybeSingle(),
        supabase
          .from("render_jobs")
          .select("*")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("generated_videos")
          .select("*, media_assets(filename)")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false }),
        supabase.from("hooks").select("id, text").eq("project_id", projectId),
        supabase
          .from("media_assets")
          .select("id, filename, duration, storage_path, hook_placement, dna_role, allowed_speeds, seek_mode, seek_seconds")
          .eq("project_id", projectId)
          .order("created_at", { ascending: false }),
      ]);
      const videoRows = await Promise.all(
        (videos.data ?? []).map(async (v) => ({
          ...v,
          playbackUrl: await resolveRenderUrl(v.output_url),
          posterUrl: await resolveRenderUrl(v.thumbnail_url),
        })),
      );
      return {
        project: project.data,
        product: product.data,
        jobs: jobs.data ?? [],
        videos: videoRows,
        hooks: hooks.data ?? [],
        media: (media.data ?? []) as any[],
      };
    },
  });

  const [running, setRunning] = useState(false);
  const [scheduleItem, setScheduleItem] = useState<{ id: string; url: string; hook: string } | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);
  const dnaAbortRef = useRef<AbortController | null>(null);

  const mediaList = data?.media ?? [];
  const activeClipIds = useMemo(
    () => selectedClipIds ?? mediaList.map((m) => m.id),
    [selectedClipIds, mediaList],
  );

  const dnaClips = useMemo(
    () =>
      mediaList
        .filter((m) => activeClipIds.includes(m.id))
        .filter((m) => m.dna_role === "start" || m.dna_role === "middle" || m.dna_role === "end")
        .map((m) => ({
          id: m.id,
          role: m.dna_role as "start" | "middle" | "end",
          duration: Number(m.duration ?? 0),
          allowedSpeeds:
            Array.isArray(m.allowed_speeds) && m.allowed_speeds.length > 0
              ? m.allowed_speeds.map(Number)
              : [1.0, 1.5, 1.7, 2.0],
          hookPlacement: m.hook_placement,
          filename: m.filename,
          storage_path: m.storage_path,
          seekMode: (m.seek_mode as "random" | "beginning" | "manual") || "random",
          seekSeconds: Number(m.seek_seconds) || 0,
        })),
    [mediaList, activeClipIds],
  );
  const dnaRoles = useMemo(() => checkRoles(dnaClips), [dnaClips]);

  function toggleClip(id: string) {
    setSelectedClipIds((prev) => {
      const base = prev ?? mediaList.map((m) => m.id);
      return base.includes(id) ? base.filter((c) => c !== id) : [...base, id];
    });
  }

  async function generateBatch() {
    if (!user) return;
    if (running) return;

    const hooks = data?.hooks ?? [];
    if (hooks.length === 0) {
      toast.error("Add at least one hook to this project first.");
      return;
    }
    const chosenAssets = activeClipIds
      .map((id) => mediaList.find((m) => m.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    if (chosenAssets.length === 0) {
      toast.error("Select at least one clip from this project's media library.");
      return;
    }
    const count = quantity;
    const hookList = hooks.map((h) => ({ id: h.id, text: h.text }));
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setRunning(true);
    setLive([]);
    try {
      let items: BatchItem[];
      if (chosenAssets.length > 1) {
        const withUrls = await Promise.all(
          chosenAssets.map(async (a) => {
            const url = await signedUrl("media", a.storage_path, 60 * 60 * 6);
            return url ? { ...a, url } : null;
          }),
        );
        const ready = withUrls.filter((a): a is NonNullable<typeof a> => Boolean(a));
        if (ready.length === 0) {
          toast.error("The selected clips could not be read from storage.");
          return;
        }
        items = await runMultiClipBatch({
          userId: user.id,
          projectId,
          assets: ready.map((a) => ({
            id: a.id,
            filename: a.filename,
            duration: a.duration,
            storage_path: a.storage_path,
            url: a.url,
            hook_placement: a.hook_placement,
          })),
          hooks: hookList,
          quantity: count,
          signal: controller.signal,
          onUpdate: setLive,
        });
      } else {
        const asset = chosenAssets[0]!;
        const url = await signedUrl("media", asset.storage_path, 60 * 60 * 6);
        if (!url) {
          toast.error("Could not load clip from storage");
          return;
        }
        items = await runBatch({
          userId: user.id,
          projectId,
          assetId: asset.id,
          assetUrl: url,
          hooks: hookList,
          quantity: count,
          signal: controller.signal,
          onUpdate: setLive,
        });
      }
      const done = items.filter((i) => i.stage === "completed").length;
      const cancelled = items.some((i) => i.error === "Cancelled");
      const across = chosenAssets.length > 1 ? ` across ${chosenAssets.length} clips` : "";
      if (cancelled)
        toast.info(`Cancelled — ${done} of ${count} variants had already finished${across}`);
      else if (done === items.length)
        toast.success(`${done} of ${count} variants rendered${across}`);
      else toast.warning(`${done} of ${count} variants rendered — check the failed jobs`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
      batchAbortRef.current = null;
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    }
  }

  function cancelBatch() {
    if (!batchAbortRef.current) return;
    batchAbortRef.current.abort();
    batchAbortRef.current = null;
    setRunning(false);
    toast.info("Render cancelled.");
  }

  async function resolveDnaClips(): Promise<DnaClip[] | null> {
    const withUrls = await Promise.all(
      dnaClips.map(async (c): Promise<DnaClip | null> => {
        const url = await signedUrl("media", c.storage_path, 60 * 60 * 6);
        return url ? { ...c, url } : null;
      }),
    );
    const ready = withUrls.filter((c): c is DnaClip => Boolean(c));
    if (ready.length !== dnaClips.length) {
      toast.error("One or more DNA-tagged clips could not be read from storage.");
      return null;
    }
    return ready;
  }

  async function resolveSoundtrack(): Promise<string | undefined> {
    if (!audioSelection.audio) return undefined;
    const resolved = await resolveAudioForRender(audioSelection.audio, prepareAudioForRender);
    if (!resolved) throw new Error("The selected sound has no playable audio link — pick another.");
    return resolved;
  }

  async function runDnaPreview() {
    if (!user) return;
    if (dnaRunning) return;

    if (!dnaRoles.ok) {
      toast.error(dnaRoles.reason);
      return;
    }
    const hooks = data?.hooks ?? [];
    if (hooks.length === 0) {
      toast.error("Add at least one hook to this project first.");
      return;
    }
    const target = Number(targetDuration);
    if (!Number.isFinite(target) || target <= 0) {
      toast.error("Enter a valid target duration.");
      return;
    }

    const previousPreview = dnaPreview;
    const controller = new AbortController();
    dnaAbortRef.current = controller;
    setDnaRunning(true);
    setDnaLive([]);
    setDnaPreview(null);
    if (previousPreview) {
      deleteDnaPreview(previousPreview.item).catch(() => {});
    }
    try {
      const clips = await resolveDnaClips();
      if (!clips) return;

      const planned = planDna(clips, target);
      if (!planned.ok) {
        toast.error(planned.reason);
        return;
      }

      const hookList = hooks.map((h) => ({ id: h.id, text: h.text }));
      const hook = hookList[Math.floor(Math.random() * hookList.length)]!;
      const soundtrackUrl = await resolveSoundtrack();

      const item = await runDnaVariant({
        userId: user.id,
        projectId,
        plan: planned.plan,
        hook,
        withAudio: audioSelection.withAudio,
        soundtrackUrl,
        signal: controller.signal,
        isPreview: true,
        onUpdate: (updated) => setDnaLive([updated]),
      });

      if (item.error === "Cancelled") {
        toast.info("Preview render cancelled.");
        return;
      }
      if (item.stage !== "completed") {
        toast.error(item.error ?? "The preview render failed.");
        return;
      }
      setDnaPreview({ item, plan: planned.plan, clips, hook });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDnaRunning(false);
      dnaAbortRef.current = null;
    }
  }

  async function approveDnaPreviewAndRenderRemaining() {
    if (!user || !dnaPreview) return;
    if (dnaRunning) return;

    const hooks = data?.hooks ?? [];
    if (hooks.length === 0) {
      toast.error("Add at least one hook to this project first.");
      return;
    }
    const totalCount = dnaCount;
    const controller = new AbortController();
    dnaAbortRef.current = controller;
    setDnaRunning(true);

    try {
      toast.info("Approving preview…");
      const approvedItem = await commitDnaPreview({
        userId: user.id,
        projectId,
        item: dnaPreview.item,
        plan: dnaPreview.plan,
        hook: dnaPreview.hook,
      });

      const items: BatchItem[] = [approvedItem];
      setDnaLive([approvedItem]);

      const remaining = totalCount - 1;
      const soundtrackUrl = await resolveSoundtrack();

      for (let i = 0; i < remaining; i++) {
        if (controller.signal.aborted) break;
        const rePlan = planDna(dnaPreview.clips, Number(targetDuration));
        if (!rePlan.ok) continue;

        const hookList = hooks.map((h) => ({ id: h.id, text: h.text }));
        const randomHook = hookList[Math.floor(Math.random() * hookList.length)]!;

        const next = await runDnaVariant({
          userId: user.id,
          projectId,
          plan: rePlan.plan,
          hook: randomHook,
          withAudio: audioSelection.withAudio,
          soundtrackUrl,
          signal: controller.signal,
          isPreview: false,
          onUpdate: (updated) => {
            setDnaLive((current) => {
              const idx = current.findIndex((c) => c.jobId === updated.jobId);
              if (idx === -1) return [...current, updated];
              const clone = [...current];
              clone[idx] = updated;
              return clone;
            });
          },
        });
        items.push(next);
      }

      setDnaPreview(null);
      const done = items.filter((i) => i.stage === "completed").length;
      toast.success(`${done} of ${totalCount} DNA variants finished.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDnaRunning(false);
      dnaAbortRef.current = null;
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    }
  }

  async function discardDnaPreview() {
    if (!dnaPreview) return;
    try {
      await deleteDnaPreview(dnaPreview.item);
      toast.info("Preview discarded.");
    } catch {
      // Ignored
    } finally {
      setDnaPreview(null);
      setDnaLive([]);
    }
  }

  function cancelDna() {
    if (!dnaAbortRef.current) return;
    dnaAbortRef.current.abort();
    dnaAbortRef.current = null;
    setDnaRunning(false);
    toast.info("DNA render cancelled.");
  }

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const project = data?.project;
  if (!project) {
    return (
      <div className="p-8">
        <p className="text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
          <p className="text-sm text-muted-foreground">
            {project.description || "Manage hooks, media clips, and video variants."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HookGeneratorDialog
            projectId={projectId}
            productContext={data?.product?.name ? `${data.product.name} — ${data.product.description}` : ""}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              <h2 className="text-base font-semibold">Clip DNA Engine</h2>
              <Badge variant="secondary" className="text-[10px]">Multi-clip</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Builds seamless edits from role-tagged clips (Start → Middle → End). Each clip follows its own start point and speeds set in the Media Library.
            </p>
          </div>
        </div>

        <AudioStrategySelector value={audioSelection} onChange={setAudioSelection} />

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="dna-duration" className="text-xs">
              Target duration (s)
            </Label>
            <Input
              id="dna-duration"
              type="number"
              min={1}
              max={60}
              step={0.5}
              value={targetDuration}
              onChange={(e) => setTargetDuration(e.target.value)}
              className="w-24"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dna-quantity" className="text-xs">
              Variants (1–{MAX_QUANTITY})
            </Label>
            <Input
              id="dna-quantity"
              type="number"
              min={1}
              max={MAX_QUANTITY}
              value={dnaQuantity}
              onChange={(e) => setDnaQuantity(e.target.value)}
              className="w-24"
            />
          </div>
          <Button
            className="w-full sm:w-auto"
            variant="secondary"
            onClick={() => void runDnaPreview()}
            disabled={dnaRunning || !dnaRoles.ok}
          >
            {dnaRunning ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {dnaPreview ? "Try a different combination" : "Preview one DNA render"}
          </Button>
          {dnaRunning ? (
            <Button className="w-full sm:w-auto" variant="outline" onClick={cancelDna}>
              Cancel
            </Button>
          ) : null}
        </div>

        {!dnaRoles.ok ? (
          <p className="text-xs text-destructive">{dnaRoles.reason}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Combination: {dnaRoles.sequence.join(" + ")}
          </p>
        )}

        {dnaLive.length > 0 && dnaRunning ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="line-clamp-1 text-muted-foreground">{dnaLive[0]!.hookText}</span>
              <StatusPill status={STAGE_LABEL[dnaLive[0]!.stage]} />
            </div>
            <Progress value={dnaLive[0]!.progress} className="h-1.5" />
          </div>
        ) : null}

        {dnaPreview ? (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">DNA Preview ready</p>
                <p className="text-xs text-muted-foreground">
                  Duration: {dnaPreview.plan.finalDuration}s · Cut:{" "}
                  {dnaPreview.plan.segments
                    .map((s) => `${dnaPreview.plan.clipById[s.media_asset_id]?.filename ?? "clip"} (${s.speed}x)`)
                    .join(" → ")}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => void discardDnaPreview()}>
                  Discard
                </Button>
                <Button size="sm" onClick={() => void approveDnaPreviewAndRenderRemaining()}>
                  Approve & render remaining {dnaCount - 1}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-primary" />
            <h2 className="text-base font-semibold">Single-Clip Batch Generator</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Takes one clip or splits variants across selected clips with hooks burned in.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Quantity</Label>
            <div className="flex items-center gap-1.5">
              {QUANTITY_PRESETS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant={quantityChoice === String(p) ? "default" : "outline"}
                  className="h-8 px-2.5 text-xs"
                  onClick={() => setQuantityChoice(String(p))}
                >
                  {p}
                </Button>
              ))}
              <Button
                type="button"
                size="sm"
                variant={quantityChoice === "custom" ? "default" : "outline"}
                className="h-8 px-2.5 text-xs"
                onClick={() => setQuantityChoice("custom")}
              >
                Custom
              </Button>
              {quantityChoice === "custom" && (
                <Input
                  type="number"
                  min={1}
                  max={MAX_QUANTITY}
                  value={customQuantity}
                  onChange={(e) => setCustomQuantity(e.target.value)}
                  className="h-8 w-20 text-xs"
                />
              )}
            </div>
          </div>

          <Button onClick={generateBatch} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Generate {quantity} variants
          </Button>
          {running && (
            <Button variant="outline" onClick={cancelBatch}>
              Cancel
            </Button>
          )}
        </div>

        {live.length > 0 && running && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            {live.map((item) => (
              <div key={item.jobId} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate text-muted-foreground">{item.hookText}</span>
                  <StatusPill status={STAGE_LABEL[item.stage]} />
                </div>
                <Progress value={item.progress} className="h-1.5" />
              </div>
            ))}
          </div>
        )}
      </div>

      <Tabs defaultValue="renders" className="space-y-4">
        <TabsList>
          <TabsTrigger value="renders" className="flex items-center gap-2">
            <Film className="size-4" />
            Rendered Videos ({data?.videos?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="hooks" className="flex items-center gap-2">
            <FileText className="size-4" />
            Hooks ({data?.hooks?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="media" className="flex items-center gap-2">
            <FolderOpen className="size-4" />
            Media Clips ({data?.media?.length ?? 0})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="renders" className="space-y-4">
          {(data?.videos?.length ?? 0) === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed text-center text-muted-foreground">
              <Film className="mb-2 size-8 text-muted-foreground/50" />
              <p className="text-sm">No videos rendered yet.</p>
              <p className="text-xs">Run a batch above to generate variations.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {data?.videos?.map((vid) => (
                <div key={vid.id} className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="aspect-[9/16] w-full bg-black">
                    <RenderPlayer url={vid.playbackUrl} posterUrl={vid.posterUrl} />
                  </div>
                  <div className="space-y-2 p-3">
                    <p className="line-clamp-2 text-xs font-medium">{vid.hook_text}</p>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{vid.duration}s</span>
                      <span>{vid.media_assets?.filename ?? "Clip"}</span>
                    </div>
                    <div className="flex items-center gap-1.5 pt-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 flex-1 text-xs"
                        onClick={() =>
                          setScheduleItem({
                            id: vid.id,
                            url: vid.playbackUrl,
                            hook: vid.hook_text ?? "",
                          })
                        }
                      >
                        <Calendar className="mr-1 size-3" />
                        Schedule
                      </Button>
                      <DeleteRenderButton videoId={vid.id} projectId={projectId} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="hooks">
          <HookLibraryPanel projectId={projectId} />
        </TabsContent>

        <TabsContent value="media">
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Select clips participating in renders:</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setSelectedClipIds(mediaList.map((m) => m.id))}
                >
                  Select all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => setSelectedClipIds([])}
                >
                  Clear
                </Button>
              </div>
            </div>
            <MediaLibraryPanel projectId={projectId} />
          </div>
        </TabsContent>
      </Tabs>

      {scheduleItem && (
        <ScheduleTikTokDialog
          open={Boolean(scheduleItem)}
          onOpenChange={(o) => !o && setScheduleItem(null)}
          videoUrl={scheduleItem.url}
          defaultCaption={scheduleItem.hook}
          generatedVideoId={scheduleItem.id}
        />
      )}
    </div>
  );
}
