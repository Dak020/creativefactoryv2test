import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Film,
  Loader2,
  Search,
  Trash2,
  Upload,
  Play,
  Tag,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { MEDIA_CATEGORIES, HOOK_PLACEMENTS, hookPlacementLabel } from "@/lib/constants";
import { videoExtension, videoFileError, withTimeout } from "@/lib/video-file";
import { fmtDuration, fmtDate } from "@/lib/db";

import { EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type MediaAsset = {
  id: string;
  project_id: string | null;
  storage_path: string;
  thumbnail_url: string | null;
  filename: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  category: string;
  tags: string[];
  hook_placement: string | null;
  dna_role: string | null;
  allowed_speeds: number[] | null;
  seek_mode?: "random" | "beginning" | "manual" | null;
  seek_seconds?: number | null;
  created_at: string;
};

const DNA_ROLE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "start", label: "Start" },
  { value: "middle", label: "Middle" },
  { value: "end", label: "End" },
] as const;

const DNA_SPEED_OPTIONS = [1, 1.5, 1.7, 2] as const;

type UploadDiagnostic = {
  stage: string;
  status: "pending" | "success" | "failure" | "info";
  detail: string;
};

function diagnosticDetail(value: unknown) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function probeVideo(file: File) {
  return new Promise<{ duration: number; width: number; height: number; thumb: Blob | null }>(
    (resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.src = url;
      const fail = () => {
        URL.revokeObjectURL(url);
        resolve({ duration: 0, width: 0, height: 0, thumb: null });
      };
      video.onerror = fail;
      video.onloadedmetadata = () => {
        const meta = {
          duration: video.duration || 0,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
        };
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
        video.onseeked = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.min(540, meta.width || 540);
            canvas.height = Math.round((canvas.width / (meta.width || 1)) * (meta.height || 1)) || 960;
            const ctx = canvas.getContext("2d");
            ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              (blob) => {
                URL.revokeObjectURL(url);
                resolve({ ...meta, thumb: blob });
              },
              "image/jpeg",
              0.72,
            );
          } catch {
            URL.revokeObjectURL(url);
            resolve({ ...meta, thumb: null });
          }
        };
      };
    },
  );
}

export function MediaLibraryPanel({ projectId }: { projectId?: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const creepRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ asset: MediaAsset; url: string } | null>(null);
  const [editing, setEditing] = useState<MediaAsset | null>(null);
  const [editCategory, setEditCategory] = useState("Other");
  const [editPlacement, setEditPlacement] = useState<string>("top");
  const [editTags, setEditTags] = useState("");
  const [editDnaRole, setEditDnaRole] = useState<string>("none");
  const [editSpeeds, setEditSpeeds] = useState<number[]>([...DNA_SPEED_OPTIONS]);
  const [editSeekMode, setEditSeekMode] = useState<"random" | "beginning" | "manual">("random");
  const [editSeekSeconds, setEditSeekSeconds] = useState("0");

  const [uploadDiagnostics, setUploadDiagnostics] = useState<UploadDiagnostic[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ pct: number; label: string } | null>(null);
  const [uploadDone, setUploadDone] = useState<string | null>(null);

  function stopCreep() {
    if (creepRef.current) clearInterval(creepRef.current);
    creepRef.current = null;
  }

  function setPhase(pct: number, label: string, ceiling?: number) {
    stopCreep();
    setProgress({ pct, label });
    if (ceiling === undefined) return;
    creepRef.current = setInterval(() => {
      setProgress((p) => (p && p.pct < ceiling ? { ...p, pct: Math.min(ceiling, p.pct + 1) } : p));
    }, 350);
  }

  function logUploadDiagnostic(
    stage: string,
    status: UploadDiagnostic["status"],
    detail: unknown,
  ) {
    const renderedDetail = typeof detail === "string" ? detail : diagnosticDetail(detail);
    setUploadDiagnostics((current) => [
      ...current.filter((entry) => entry.stage !== stage),
      { stage, status, detail: renderedDetail },
    ]);
  }

  const { data: assets, isLoading } = useQuery({
    queryKey: ["media", projectId ?? "all"],
    queryFn: async () => {
      let q = supabase.from("media_assets").select("*").order("created_at", { ascending: false });
      if (projectId) q = q.eq("project_id", projectId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as MediaAsset[];
    },
  });

  const { data: projectNames } = useQuery({
    queryKey: ["media-project-names"],
    enabled: !projectId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await supabase.from("projects").select("id, name");
      return new Map((data ?? []).map((p) => [p.id, p.name]));
    },
  });

  const filtered = useMemo(() => {
    const list = assets ?? [];
    return list.filter((a) => {
      const matchesCategory = category === "all" || a.category === category;
      const q = query.trim().toLowerCase();
      const matchesQuery =
        !q || a.filename.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q));
      return matchesCategory && matchesQuery;
    });
  }, [assets, category, query]);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      logUploadDiagnostic(
        "Mutation input",
        files.length > 0 ? "success" : "failure",
        `Stable File[] contains ${files.length} file(s) when the mutation starts.`,
      );
      if (files.length === 0) {
        const error = new Error(
          "The upload mutation received an empty file array after the input change event.",
        );
        logUploadDiagnostic("Stopping condition", "failure", error.message);
        throw error;
      }

      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      logUploadDiagnostic("Authentication", userErr ? "failure" : "success", {
        userId: userRes.user?.id ?? null,
        error: userErr,
      });
      if (userErr) throw new Error(`Auth check failed: ${userErr.message}`);
      const userId = userRes.user?.id;
      if (!userId) throw new Error("You are signed out — sign in again to upload.");
      logUploadDiagnostic("Authenticated user ID", "info", userId);
      logUploadDiagnostic("Project ID", projectId ? "success" : "failure", projectId ?? "null");

      let created = 0;
      const total = files.length;

      for (const [index, file] of files.entries()) {
        const base = Math.round((index / total) * 100);
        const span = 100 / total;
        const at = (fraction: number) => Math.min(99, Math.round(base + span * fraction));
        const name = file.name || "clip";
        setPhase(at(0.05), `Checking ${name}`);

        const ext = videoExtension(file);
        logUploadDiagnostic("File received", "success", {
          isFile: file instanceof File,
          name: file.name,
          mimeType: file.type || "(empty)",
          size: file.size,
          extension: ext,
        });
        const invalid = videoFileError(file);
        logUploadDiagnostic(
          "Validation",
          invalid ? "failure" : "success",
          invalid ?? "Accepted by MIME type and/or extension; file is non-empty and within the size limit.",
        );
        if (invalid) {
          logUploadDiagnostic("Stopping condition", "failure", `Validation rejected the file: ${invalid}`);
          throw new Error(invalid);
        }

        setPhase(at(0.15), `Reading ${name}`);
        const meta = await withTimeout(probeVideo(file), 15000, {
          duration: 0,
          width: 0,
          height: 0,
          thumb: null,
        });
        logUploadDiagnostic(
          "Video metadata",
          meta.duration > 0 && meta.width > 0 && meta.height > 0 ? "success" : "failure",
          meta,
        );
        const id = crypto.randomUUID();
        const path = `${userId}/${id}.${ext}`;

        logUploadDiagnostic("Before storage upload", "pending", {
          bucket: "media",
          path,
          contentType: file.type || "video/mp4",
          size: file.size,
        });
        setPhase(at(0.3), `Uploading ${name}`, at(0.85));
        const storageResult = await supabase.storage
          .from("media")
          .upload(path, file, { contentType: file.type || "video/mp4" });
        const { error: upErr } = storageResult;
        logUploadDiagnostic("Storage upload result", upErr ? "failure" : "success", storageResult);
        if (upErr) throw new Error(`Storage upload failed for ${file.name}: ${upErr.message}`);
        setPhase(at(0.9), `Saving ${name}`);

        let thumbnailUrl: string | null = null;
        if (meta.thumb) {
          const thumbPath = `${userId}/${id}-thumb.jpg`;
          const { error: thumbErr } = await supabase.storage
            .from("media")
            .upload(thumbPath, meta.thumb, { contentType: "image/jpeg" });
          if (!thumbErr) {
            const { data: signed } = await supabase.storage
              .from("media")
              .createSignedUrl(thumbPath, 60 * 60 * 24 * 365);
            thumbnailUrl = signed?.signedUrl ?? null;
          }
        }

        const insertPayload: Record<string, unknown> = {
          user_id: userId,
          project_id: projectId ?? null,
          storage_path: path,
          thumbnail_url: thumbnailUrl,
          filename: file.name || `clip.${ext}`,
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          size_bytes: file.size,
          category: "Other",
          tags: [],
          seek_mode: "random",
          seek_seconds: 0,
        };
        logUploadDiagnostic("Before database insert", "pending", insertPayload);
        const insertResult = await supabase
          .from("media_assets")
          .insert(insertPayload as any)
          .select("*")
          .single();
        const { data: inserted, error: insErr } = insertResult;
        logUploadDiagnostic("Database insert result", insErr ? "failure" : "success", insertResult);
        logUploadDiagnostic(
          "Returned media record",
          inserted ? "success" : "failure",
          inserted ?? "No media record was returned.",
        );
        if (insErr || !inserted) {
          await supabase.storage.from("media").remove([path]);
          throw new Error(`Saving ${file.name} failed: ${insErr?.message ?? "no record returned"}`);
        }
        created += 1;
      }
      if (created === 0) {
        const error = new Error(
          "Upload stopped because zero media records were created. See the stopping condition above.",
        );
        logUploadDiagnostic("Stopping condition", "failure", error.message);
        throw error;
      }

      const finalQuery = projectId
        ? await supabase
            .from("media_assets")
            .select("*")
            .eq("project_id", projectId)
            .order("created_at", { ascending: false })
        : await supabase.from("media_assets").select("*").order("created_at", { ascending: false });
      logUploadDiagnostic(
        "Final media query",
        finalQuery.error ? "failure" : "success",
        finalQuery,
      );
      if (finalQuery.error) throw new Error(`Final media query failed: ${finalQuery.error.message}`);
      return created;
    },

    onSuccess: (created) => {
      stopCreep();
      setProgress({ pct: 100, label: "Done" });
      setUploadDone(created === 1 ? "1 clip uploaded" : `${created} clips uploaded`);
      setUploadError(null);
      toast.success(created === 1 ? "Upload complete" : `${created} clips uploaded`);
      qc.invalidateQueries({ queryKey: ["media"] });
      qc.invalidateQueries({ queryKey: ["project"] });
      qc.invalidateQueries({ queryKey: ["studio-assets"] });
      setTimeout(() => {
        setProgress(null);
        setUploadDone(null);
      }, 4000);
    },
    onError: (e) => {
      const error = e instanceof Error ? e : new Error(diagnosticDetail(e));
      stopCreep();
      setProgress(null);
      setUploadError(error.message);
      logUploadDiagnostic("Upload error", "failure", error);
      toast.error(error.message);
    },
    onSettled: () => setUploading(false),
  });

  const remove = useMutation({
    mutationFn: async (asset: MediaAsset) => {
      await supabase.storage.from("media").remove([asset.storage_path]);
      const { error } = await supabase.from("media_assets").delete().eq("id", asset.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Clip deleted");
      qc.invalidateQueries({ queryKey: ["media"] });
    },
  });

  const saveEdit = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const updatePayload: Record<string, unknown> = {
        category: editCategory,
        hook_placement: editPlacement,
        tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        dna_role: editDnaRole === "none" ? null : editDnaRole,
        allowed_speeds: editSpeeds.length > 0 ? [...editSpeeds].sort((a, b) => a - b) : [...DNA_SPEED_OPTIONS],
        seek_mode: editSeekMode,
        seek_seconds: Number(editSeekSeconds) || 0,
      };
      const { error } = await supabase
        .from("media_assets")
        .update(updatePayload as any)
        .eq("id", editing.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Clip updated");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["media"] });
    },
  });

  async function openPreview(asset: MediaAsset) {
    const { data } = await supabase.storage.from("media").createSignedUrl(asset.storage_path, 3600);
    if (!data?.signedUrl) {
      toast.error("Could not load clip");
      return;
    }
    setPreview({ asset, url: data.signedUrl });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search filenames and tags"
            className="pl-9"
          />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {MEDIA_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov"
          multiple
          className="hidden"
          onChange={(e) => {
            const input = e.currentTarget;
            const files = Array.from(input.files ?? []);
            input.value = "";
            setUploadDiagnostics([]);
            setUploadError(null);
            setUploadDone(null);
            logUploadDiagnostic(
              "File input change event",
              files[0] ? "success" : "failure",
              files[0]
                ? {
                    receivedFile: true,
                    name: files[0].name,
                    mimeType: files[0].type || "(empty)",
                    size: files[0].size,
                    extension: videoExtension(files[0]),
                  }
                : { receivedFile: false, fileCount: files.length },
            );
            if (files.length) {
              setUploading(true);
              setPhase(2, `Preparing ${files.length} file${files.length === 1 ? "" : "s"}`);
              upload.mutate(files);
            }
          }}
        />
        <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          Upload clips
        </Button>
      </div>

      {progress ? (
        <div className="rounded-lg border border-border bg-surface-raised/40 px-4 py-3" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-2">
              {uploadDone ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
              ) : (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
              <span className="truncate">{uploadDone ?? progress.label}</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {Math.round(progress.pct)}%
            </span>
          </div>
          <Progress value={progress.pct} className="mt-2 h-1.5" />
        </div>
      ) : null}

      {uploadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4" role="alert">
          <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
            <AlertTriangle className="size-3.5" />
            Upload failed
          </div>
          <p className="mt-1 text-xs text-destructive">{uploadError}</p>
          {uploadDiagnostics.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                Technical details
              </summary>
              <dl className="mt-2 space-y-2 font-mono text-[11px]">
                {uploadDiagnostics.map((entry) => (
                  <div key={entry.stage} className="grid gap-1 border-t border-border pt-2 sm:grid-cols-[180px_1fr]">
                    <dt className="font-medium">
                      {entry.stage}: {entry.status === "success" ? "✓" : entry.status === "failure" ? "✗" : "…"}
                    </dt>
                    <dd
                      className={
                        entry.status === "failure"
                          ? "whitespace-pre-wrap break-words text-destructive"
                          : "whitespace-pre-wrap break-words text-muted-foreground"
                      }
                    >
                      {entry.detail}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Film}
          title="No clips match"
          description={
            assets?.length === 0
              ? "Upload raw footage to begin generating variations."
              : "Try adjusting your search or category filter."
          }
          action={
            assets?.length === 0 ? (
              <Button onClick={() => inputRef.current?.click()}>
                <Upload className="size-4" />
                Upload clips
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {filtered.map((asset) => (
            <div
              key={asset.id}
              className="group overflow-hidden rounded-lg border border-border bg-card transition hover:border-primary/50"
            >
              <div
                role="button"
                tabIndex={0}
                className="relative aspect-video w-full cursor-pointer overflow-hidden bg-black focus:outline-none focus:ring-2 focus:ring-primary"
                onClick={() => openPreview(asset)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openPreview(asset);
                  }
                }}
                aria-label={`Preview ${asset.filename}`}
              >
                {asset.thumbnail_url ? (
                  <img
                    src={asset.thumbnail_url}
                    alt={asset.filename}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center text-muted-foreground">
                    <Film className="size-6" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
                  <Play className="size-8 text-white drop-shadow" />
                </div>
                {asset.duration ? (
                  <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 font-mono text-[10px] text-white">
                    {fmtDuration(asset.duration)}
                  </span>
                ) : null}
              </div>

              <div className="space-y-1 p-2.5">
                <p className="truncate text-xs font-medium" title={asset.filename}>
                  {asset.filename}
                </p>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="secondary" className="text-[10px]">
                    {asset.category}
                  </Badge>
                  <Badge className="text-[10px]">
                    Hook: {hookPlacementLabel(asset.hook_placement)}
                  </Badge>
                  {asset.dna_role && (
                    <Badge variant="outline" className="border-primary text-[10px] capitalize text-primary">
                      DNA: {asset.dna_role}
                    </Badge>
                  )}
                  {asset.seek_mode && asset.seek_mode !== "random" && (
                    <Badge variant="outline" className="text-[10px]">
                      {asset.seek_mode === "beginning" ? "0:00" : `${asset.seek_seconds ?? 0}s`}
                    </Badge>
                  )}
                  {projectNames && (
                    <Badge variant="outline" className="text-[10px]">
                      {asset.project_id ? (projectNames.get(asset.project_id) ?? "Unknown project") : "Unsorted"}
                    </Badge>
                  )}
                  {asset.tags.slice(0, 2).map((t) => (
                    <Badge key={t} variant="outline" className="text-[10px]">
                      {t}
                    </Badge>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {asset.width}×{asset.height} · {fmtDate(asset.created_at)}
                </p>
                <div className="flex gap-1 pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    onClick={() => {
                      setEditing(asset);
                      setEditCategory(asset.category);
                      setEditPlacement(asset.hook_placement ?? "top");
                      setEditTags(asset.tags.join(", "));
                      setEditDnaRole(asset.dna_role ?? "none");
                      setEditSpeeds(
                        asset.allowed_speeds && asset.allowed_speeds.length > 0
                          ? asset.allowed_speeds.map(Number)
                          : [...DNA_SPEED_OPTIONS],
                      );
                      setEditSeekMode(asset.seek_mode ?? "random");
                      setEditSeekSeconds(String(asset.seek_seconds ?? 0));
                    }}
                  >
                    <Tag className="size-3" />
                    Tag
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => remove.mutate(asset)}
                    aria-label={`Delete ${asset.filename}`}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate text-sm">{preview?.asset.filename}</DialogTitle>
          </DialogHeader>
          {preview ? (
            <div className="flex max-h-[65vh] w-full items-center justify-center overflow-hidden rounded-lg bg-black">
              <video
                src={preview.url}
                controls
                playsInline
                preload="metadata"
                className="max-h-[65vh] w-full object-contain"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Categorize clip</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={editCategory} onValueChange={setEditCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEDIA_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Hook placement</Label>
              <Select value={editPlacement} onValueChange={setEditPlacement}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_PLACEMENTS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Clip DNA role</Label>
              <Select value={editDnaRole} onValueChange={setEditDnaRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DNA_ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                None keeps this clip out of DNA edits — it renders exactly as it does today.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Start point in clip</Label>
              <div className="flex items-center gap-2">
                <Select value={editSeekMode} onValueChange={(v) => setEditSeekMode(v as any)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="random">Random (fresh section each render)</SelectItem>
                    <SelectItem value="beginning">From the beginning (0:00)</SelectItem>
                    <SelectItem value="manual">Choose a time</SelectItem>
                  </SelectContent>
                </Select>
                {editSeekMode === "manual" && (
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={editSeekSeconds}
                    onChange={(e) => setEditSeekSeconds(e.target.value)}
                    placeholder="0.0"
                    className="w-24"
                  />
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {editSeekMode === "beginning"
                  ? "Always starts on the first frame (best for spoken hooks and intro clips)."
                  : editSeekMode === "manual"
                    ? `Always starts at ${Number(editSeekSeconds) || 0}s into this clip.`
                    : "Picks a random section on every render (best for B-roll)."}
              </p>
            </div>

            <div className="space-y-2">
              <Label>Playback speed</Label>
              <div className="flex flex-wrap gap-2">
                {(["auto", ...DNA_SPEED_OPTIONS.map(String)] as const).map((option) => {
                  const isAuto = option === "auto";
                  const active = isAuto ? editSpeeds.length > 1 : editSpeeds.length === 1 && editSpeeds[0] === Number(option);
                  return (
                    <Button
                      key={option}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      className="h-7 text-xs"
                      aria-pressed={active}
                      onClick={() => setEditSpeeds(isAuto ? [...DNA_SPEED_OPTIONS] : [Number(option)])}
                    >
                      {isAuto ? "Auto" : `${option}x`}
                    </Button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {editSpeeds.length > 1
                  ? "Auto: each render picks one of 1x, 1.5x, 1.7x or 2x for this clip."
                  : `Every render uses this clip at ${editSpeeds[0] ?? 1}x.`}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tags">Tags (comma separated)</Label>
              <Input
                id="tags"
                value={editTags}
                maxLength={300}
                onChange={(e) => setEditTags(e.target.value)}
                placeholder="kitchen, morning, b-roll"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => saveEdit.mutate()} disabled={saveEdit.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
