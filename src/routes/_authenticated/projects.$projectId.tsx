import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  CalendarClock,
  ChevronDown,
  Download,
  Loader2,
  Play,
  Sparkles,
  Trophy,
} from "lucide-react";
import { ScheduleTikTokDialog } from "@/components/ScheduleTikTokDialog";
import { AudioStrategySelector, type AudioSelection } from "@/components/AudioStrategySelector";
import { resolveAudioForRender } from "@/lib/audio-url";
import { prepareAudioForRenderFn } from "@/lib/audio.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { MediaLibraryPanel } from "@/components/MediaLibraryPanel";
import { HookLibraryPanel } from "@/components/HookLibraryPanel";
import { EmptyState, PageHeader, StatCard, StatusPill } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtDate, audienceSummary, signedUrl } from "@/lib/db";
import { downloadRender, renderFilename, resolveRenderUrl } from "@/lib/render/output";
import {
  CLIP_SECONDS,
  STAGE_LABEL,
  reapStaleJobs,
  cancelQueuedJobs,
  runBatch,
  runMultiClipBatch,
  type BatchItem,
} from "@/lib/render/pipeline";
import { Checkbox } from "@/components/ui/checkbox";
import { checkRoles } from "@/lib/dna/solver";
import type { SeekMode } from "@/lib/render/browser-render";
import {
  planDna,
  runDnaVariant,
  runDnaBatch,
  describePlan,
  commitDnaPreview,
  deleteDnaPreview,
  type DnaClip,
  type DnaPlan,
} from "@/lib/render/dna-pipeline";

import { deleteRender } from "@/lib/render/delete";
import { DeleteRenderButton } from "@/components/DeleteRenderButton";
import { RenderPlayer } from "@/components/RenderPlayer";
import { platformLabel, styleLabel } from "@/lib/constants";

const QUANTITY_PRESETS = [1, 5, 10, 20, 30] as const;
const MAX_QUANTITY = 30;

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  head: () => ({
    meta: [
      { title: "Project workspace — Creative Factory" },
      {
        name: "description",
        content: "Media, hooks, batch generation and render queue for this project.",
      },
      { property: "og:title", content: "Project workspace — Creative Factory" },
      {
        property: "og:description",
        content: "Produce short-form video batches from hooks and clips.",
      },
    ],
  }),
  component: ProjectWorkspace,
});

function ProjectWorkspace() {
  const { projectId } = Route.useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [scheduleTarget, setScheduleTarget] = useState<{
    id: string;
    hookText: string | null;
  } | null>(null);
  const batchAbortRef = useRef<AbortController | null>(null);
  const dnaAbortRef = useRef<AbortController | null>(null);
  const [quantityChoice, setQuantityChoice] = useState("5");
  const [customQuantity, setCustomQuantity] = useState("8");
  const [live, setLive] = useState<BatchItem[]>([]);
  const [showJobHistory, setShowJobHistory] = useState(false);

  // Same multi-clip rule as Studio: with 2+ clips selected, one batch is split
  // evenly across them (remainder randomly assigned). Defaults to every clip
  // in the project's media library.
  const [selectedClipIds, setSelectedClipIds] = useState<string[] | null>(null);

  // Clip DNA: combine role-tagged clips into one edit instead of a single
  // clip + hook. Separate running/progress state from the existing
  // single-clip flow above, since a DNA render and a regular render are
  // different pipelines that can't run at the same time from this page.
  const [targetDuration, setTargetDuration] = useState("8");
  const [dnaSeekMode, setDnaSeekMode] = useState<SeekMode>("random");
  const [dnaManualSeek, setDnaManualSeek] = useState("0");
  const dnaSeek = { mode: dnaSeekMode, manualSeconds: Number(dnaManualSeek) || 0 };
  // How many DNA variants a single approval produces (the approved preview
  // counts as the first one). Selectable instead of following the single-clip
  // batch quantity.
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

  // Abandoned jobs (closed tab, crashed render) must not sit in the queue forever.
  useEffect(() => {
    if (!user) return;
    void reapStaleJobs(user.id, projectId).then(() =>
      qc.invalidateQueries({ queryKey: ["project", projectId] }),
    );
  }, [user?.id, projectId, qc]);

  const { data, isLoading } = useQuery({
    // Scoped to the signed-in user so a different account never reads this cache.
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
          .select("id, filename, duration, storage_path, hook_placement, dna_role, allowed_speeds")
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
        media: media.data ?? [],
      };
    },
    // Only poll while something is actually in flight.
    refetchInterval: (q) => {
      if (running) return false;
      const active = (q.state.data?.jobs ?? []).some(
        (j: { status: string }) => j.status === "queued" || j.status === "processing",
      );
      return active ? 8000 : false;
    },
  });

  const mediaList = useMemo(() => data?.media ?? [], [data?.media]);
  const activeClipIds = useMemo(
    () =>
      (selectedClipIds ?? mediaList.map((m) => m.id)).filter((id) =>
        mediaList.some((m) => m.id === id),
      ),
    [selectedClipIds, mediaList],
  );

  // Only clips actually tagged with a DNA role participate — untagged clips
  // in this same project are invisible to DNA and keep working with the
  // regular single/multi-clip flow above. Also respects the same clip
  // selection/filter as the regular batch flow (activeClipIds) — DNA should
  // only draw from clips the user has actually selected for this batch, not
  // silently pull in every DNA-tagged clip in the whole project regardless
  // of what's currently filtered.
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
    // Guard against a second click landing while the sound is still being
    // prepared — two renders at once stall the video and ruin the export.
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
            hook_placement: a.hook_placement,
            url: a.url,
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
          toast.error("The source clip could not be read from storage.");
          return;
        }
        items = await runBatch({
          userId: user.id,
          projectId,
          asset,
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

  /** Sign a playable URL for every DNA-tagged clip. Returns null (with a
   *  toast) if any clip's file can't be read from storage. */
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

  /** Resolves the currently-selected soundtrack (if any) to a render-safe URL. */
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
      deleteDnaPreview(previousPreview.item).catch(() => {
        // Best-effort — a failed cleanup here just leaves one orphaned file,
        // not worth blocking the next preview render over.
      });
    }
    try {
      const clips = await resolveDnaClips();
      if (!clips) return;

      const planned = planDna(clips, target, dnaSeek);
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

  async function approveDna() {
    if (!user || !dnaPreview) return;
    const hooks = data?.hooks ?? [];
    if (hooks.length === 0) {
      toast.error("Add at least one hook to this project first.");
      return;
    }

    try {
      await commitDnaPreview({
        userId: user.id,
        projectId,
        item: dnaPreview.item,
        hook: dnaPreview.hook,
        plan: dnaPreview.plan,
      });
    } catch (e) {
      toast.error(`Could not save the approved preview: ${(e as Error).message}`);
      return;
    }

    const remaining = Math.max(0, dnaCount - 1);
    if (remaining === 0) {
      toast.success("Preview approved and saved.");
      setDnaPreview(null);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      return;
    }

    const target = Number(targetDuration);
    const controller = new AbortController();
    dnaAbortRef.current = controller;
    setDnaRunning(true);
    setDnaLive([dnaPreview.item]);
    try {
      const hookList = hooks.map((h) => ({ id: h.id, text: h.text }));
      const soundtrackUrl = await resolveSoundtrack();
      const items = await runDnaBatch({
        userId: user.id,
        projectId,
        clips: dnaPreview.clips,
        hooks: hookList,
        targetDuration: target,
        seek: dnaSeek,
        quantity: remaining,
        withAudio: audioSelection.withAudio,
        soundtrackUrl,
        signal: controller.signal,
        onUpdate: (updated) => setDnaLive([dnaPreview.item, ...updated]),
      });
      const done = items.filter((i) => i.stage === "completed").length;
      const cancelled = items.some((i) => i.error === "Cancelled");
      if (cancelled)
        toast.info(`Cancelled — ${done + 1} of ${dnaCount} DNA variants had already finished`);
      else if (done === items.length)
        toast.success(`${done + 1} of ${dnaCount} DNA variants rendered`);
      else
        toast.warning(`${done + 1} of ${dnaCount} DNA variants rendered — check the failed jobs`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDnaRunning(false);
      dnaAbortRef.current = null;
      setDnaPreview(null);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
    }
  }

  async function discardDnaPreview() {
    if (!dnaPreview) return;
    const item = dnaPreview.item;
    setDnaPreview(null);
    try {
      await deleteDnaPreview(item);
    } catch (e) {
      // Non-fatal: the preview is already cleared from the UI either way,
      // this just means the orphaned file lingers in storage a bit longer.
      toast.error(`Preview discarded, but cleanup failed: ${(e as Error).message}`);
    }
  }

  function cancelDna() {
    if (!dnaAbortRef.current) return;
    dnaAbortRef.current.abort();
    dnaAbortRef.current = null;
    // Don't wait for the render loop to unwind before the UI reacts — the
    // button should stop spinning the moment it is tapped.
    setDnaRunning(false);
    setDnaLive([]);
    toast.info("DNA render cancelled.");
    if (user)
      void cancelQueuedJobs(user.id, projectId).then(() =>
        qc.invalidateQueries({ queryKey: ["project", projectId] }),
      );
  }

  async function clearQueue() {
    if (!user) return;
    batchAbortRef.current?.abort();
    dnaAbortRef.current?.abort();
    const ok = await cancelQueuedJobs(user.id, projectId);
    await qc.invalidateQueries({ queryKey: ["project", projectId] });
    if (ok) toast.info("Queued renders cancelled.");
    else toast.error("Could not cancel the queued renders.");
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const project = data?.project;
  if (!project) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Project not found"
        description="It may have been deleted."
        action={
          <Button asChild>
            <Link to="/projects">Back to projects</Link>
          </Button>
        }
      />
    );
  }

  const requested = live.length;
  const completed = live.filter((l) => l.stage === "completed").length;
  const failed = live.filter((l) => l.stage === "failed");
  const allJobs = data?.jobs ?? [];
  const activeJobs = allJobs.filter((j) => j.status === "queued" || j.status === "processing");
  const finishedJobs = allJobs.filter((j) => j.status !== "queued" && j.status !== "processing");
  const queuedCount = activeJobs.length;

  return (
    <div className="space-y-8">
      <Link
        to="/projects"
        className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All projects
      </Link>

      <PageHeader
        title={project.name}
        description={`${platformLabel(project.platform)} · ${styleLabel(project.content_style)} · ${audienceSummary(project)}`}
        actions={
          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            <div className="min-w-36 flex-1 space-y-1.5 sm:flex-none">
              <Label className="text-xs">Batch quantity</Label>
              <Select value={quantityChoice} onValueChange={setQuantityChoice}>
                <SelectTrigger className="w-full sm:w-36">
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
                <Label htmlFor="project-custom-qty" className="text-xs">
                  How many? (1–{MAX_QUANTITY})
                </Label>
                <Input
                  id="project-custom-qty"
                  type="number"
                  min={1}
                  max={MAX_QUANTITY}
                  value={customQuantity}
                  onChange={(e) => setCustomQuantity(e.target.value)}
                  className="w-28"
                />
              </div>
            ) : null}
            <Button
              className="w-full sm:w-auto"
              onClick={() => void generateBatch()}
              disabled={running}
            >
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Render {quantity} variant{quantity === 1 ? "" : "s"}
            </Button>
            {running ? (
              <Button className="w-full sm:w-auto" variant="outline" onClick={cancelBatch}>
                Cancel
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Hooks" value={(data?.hooks ?? []).length} icon={Sparkles} accent />
        <StatCard label="Clips" value={(data?.media ?? []).length} icon={Play} />
        <StatCard
          label="Videos"
          value={(data?.videos ?? []).filter((v) => v.playbackUrl).length}
          icon={Trophy}
        />
        <div className="space-y-2">
          <StatCard label="Queue" value={queuedCount} icon={Loader2} />
          {queuedCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => void clearQueue()}
            >
              Cancel {queuedCount} queued render{queuedCount === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>
      </div>

      {requested > 0 ? (
        <div className="panel px-5 py-4 text-xs">
          <p className="font-medium">
            {completed} completed / {requested} requested
          </p>
          {failed.length > 0 ? (
            <p className="mt-1 text-destructive">
              Failed jobs:{" "}
              {failed.map((f) => `${f.jobId.slice(0, 8)} (${f.error ?? "unknown"})`).join(" · ")}
            </p>
          ) : null}
          <div className="mt-3 space-y-2">
            {live
              .filter((l) => l.stage !== "completed" && l.stage !== "failed")
              .map((l) => (
                <div key={l.jobId} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="line-clamp-1 text-muted-foreground">{l.hookText}</span>
                    <StatusPill status={STAGE_LABEL[l.stage]} />
                  </div>
                  <Progress value={l.progress} className="h-1.5" />
                </div>
              ))}
          </div>
        </div>
      ) : null}

      {mediaList.length > 0 ? (
        <div className="panel space-y-3 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Clips used in this batch</p>
              <p className="text-xs text-muted-foreground">
                {activeClipIds.length > 1
                  ? `The ${quantity} variants split evenly across ${activeClipIds.length} clips — any remainder goes to a random pick, and each clip keeps its own hook placement.`
                  : "Pick 2 or more clips to spread the batch across them."}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setSelectedClipIds(
                  activeClipIds.length === mediaList.length ? [] : mediaList.map((m) => m.id),
                )
              }
            >
              {activeClipIds.length === mediaList.length ? "Clear all" : "Select all"}
            </Button>
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {mediaList.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={activeClipIds.includes(m.id)}
                  onCheckedChange={() => toggleClip(m.id)}
                />
                <span className="line-clamp-1">{m.filename}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {Math.round(Number(m.duration ?? 0))}s
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Clip DNA</p>
            <p className="text-xs text-muted-foreground">
              Combine Start / Middle / End tagged clips into one edit. Tag clips and set their
              allowed speeds in the Media tab. The hook is burned onto the opening segment only.
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
            <Label className="text-xs">Start point in clips</Label>
            <div className="flex items-center gap-2">
              <Select value={dnaSeekMode} onValueChange={(v) => setDnaSeekMode(v as SeekMode)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="random">Random (different each render)</SelectItem>
                  <SelectItem value="manual">Choose a time</SelectItem>
                  <SelectItem value="beginning">From the beginning (0:00)</SelectItem>
                </SelectContent>
              </Select>
              {dnaSeekMode === "manual" && (
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={dnaManualSeek}
                  onChange={(e) => setDnaManualSeek(e.target.value)}
                  className="w-20"
                />
              )}
            </div>
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
            <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
              <div className="overflow-hidden rounded-lg border border-border bg-black">
                {dnaPreview.item.url ? (
                  <RenderPlayer src={dnaPreview.item.url} />
                ) : (
                  <div className="flex aspect-[9/16] items-center justify-center text-xs text-muted-foreground">
                    No preview file
                  </div>
                )}
              </div>
              <div className="space-y-2 text-xs">
                <p className="font-medium">
                  {dnaPreview.plan.finalDuration.toFixed(2)}s total · hook on the{" "}
                  {dnaPreview.plan.segments[0]!.role} segment ({dnaPreview.plan.placement})
                </p>
                {describePlan(dnaPreview.plan).map((s, i) => (
                  <p key={i} className="text-muted-foreground">
                    {i + 1}. <span className="uppercase">{s.role}</span> · {s.filename} · {s.cut} ·{" "}
                    {s.speed} · {s.outputDuration}
                  </p>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="w-full sm:w-auto"
                onClick={() => void approveDna()}
                disabled={dnaRunning}
              >
                {dnaRunning ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Approve this style — render {Math.max(0, dnaCount - 1)} more
              </Button>
              <Button
                className="w-full sm:w-auto"
                variant="ghost"
                onClick={() => void discardDnaPreview()}
                disabled={dnaRunning}
              >
                Discard preview
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Tabs defaultValue="hooks">
        <TabsList>
          <TabsTrigger value="hooks">Hooks</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="renders">Renders</TabsTrigger>
        </TabsList>

        <TabsContent value="hooks" className="pt-6">
          <HookLibraryPanel
            projectId={projectId}
            generatorContext={{
              product: data?.product?.name ?? project.name,
              productUrl: data?.product?.url ?? null,
              audience: audienceSummary(project),
              platform: project.platform,
              contentStyle: project.content_style,
            }}
          />
        </TabsContent>

        <TabsContent value="media" className="pt-6">
          <MediaLibraryPanel projectId={projectId} />
        </TabsContent>

        <TabsContent value="renders" className="space-y-6 pt-6">
          <div className="panel divide-y divide-border overflow-hidden">
            {activeJobs.length + finishedJobs.length === 0 ? (
              <p className="px-5 py-8 text-center text-xs text-muted-foreground">
                No render jobs yet.
              </p>
            ) : (
              <>
                {[...activeJobs, ...(showJobHistory ? finishedJobs : finishedJobs.slice(0, 1))].map(
                  (j) => (
                    <div key={j.id} className="px-5 py-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-xs text-muted-foreground">
                          {j.id.slice(0, 8)}
                        </span>
                        <StatusPill status={j.status} />
                      </div>
                      <Progress value={j.progress} className="mt-3 h-1.5" />
                      {j.error_message ? (
                        <p className="mt-2 text-[11px] text-destructive">{j.error_message}</p>
                      ) : null}
                    </div>
                  ),
                )}
                {finishedJobs.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setShowJobHistory((v) => !v)}
                    className="flex w-full items-center justify-center gap-1.5 px-5 py-3 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {showJobHistory ? "Hide history" : `History — ${finishedJobs.length - 1} more`}
                    <ChevronDown
                      className={`size-3.5 transition-transform ${showJobHistory ? "rotate-180" : ""}`}
                    />
                  </button>
                ) : null}
              </>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data?.videos.map((v) => (
              <div key={v.id} className="panel space-y-3 p-4">
                <div className="overflow-hidden rounded-lg border border-border bg-black">
                  {v.playbackUrl ? (
                    <RenderPlayer src={v.playbackUrl} poster={v.posterUrl} />
                  ) : (
                    <div className="flex aspect-[9/16] items-center justify-center px-4 text-center text-xs text-muted-foreground">
                      Output file missing — re-run this render.
                    </div>
                  )}
                </div>

                <p className="line-clamp-2 text-sm font-medium">{v.hook_text ?? "Untitled"}</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {(v.media_assets as { filename?: string } | null)?.filename ?? "Source clip"} ·{" "}
                  {Math.round(Number(v.duration ?? CLIP_SECONDS))}s · {fmtDate(v.created_at)}
                  {v.is_winner ? " · Winner" : ""}
                </p>
                <div className="flex items-center justify-between gap-2">
                  <StatusPill status={v.playbackUrl ? "completed" : "failed"} />
                  <div className="flex items-center gap-2">
                    {v.playbackUrl ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          void downloadRender(
                            v.playbackUrl!,
                            renderFilename(v.output_url, `hook-variant-${v.id.slice(0, 6)}`),
                          ).catch((e) => toast.error((e as Error).message))
                        }
                      >
                        <Download className="size-3.5" />
                        Download
                      </Button>
                    ) : null}
                    {v.playbackUrl ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          setScheduleTarget({ id: v.id, hookText: v.hook_text ?? null })
                        }
                      >
                        <CalendarClock className="size-3.5" />
                        Schedule
                      </Button>
                    ) : null}
                    <DeleteRenderButton
                      onConfirm={async () => {
                        try {
                          await deleteRender(v);
                          await qc.invalidateQueries({ queryKey: ["project", projectId] });
                          await qc.invalidateQueries({ queryKey: ["studio-results"] });
                          toast.success("Render deleted");
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      <ScheduleTikTokDialog
        videoId={scheduleTarget?.id ?? ""}
        hookText={scheduleTarget?.hookText ?? null}
        open={Boolean(scheduleTarget)}
        onOpenChange={(o) => !o && setScheduleTarget(null)}
      />
    </div>
  );
}
