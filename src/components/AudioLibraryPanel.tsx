import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Bookmark,
  Check,
  Flame,
  Link2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  TrendingUp,
  Upload,
} from "lucide-react";
import {
  getTrendingAudiosFn,
  getMyAudioLibraryFn,
  toggleFavoriteAudioFn,
  addUploadedAudioFn,
  deleteCustomAudioFn,
  syncTrendingAudiosFn,
  importTikTokUrlAudioFn,
  type TrendingAudioRow,
} from "@/lib/audio.functions";
import { resolveAudioUrl } from "@/lib/audio-url";
import { fmtDuration } from "@/lib/db";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const AUDIO_CATEGORIES = [
  "TikTok Trending",
  "Viral Beats",
  "Background / Lofi",
  "Voiceover / Sound FX",
] as const;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg)$/i;

function ViralityBadge({ audio }: { audio: TrendingAudioRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Uploads aren't a measured trend, so they carry no score to show. */}
      {audio.virality_score > 0 ? (
        <Badge variant="secondary" className="gap-1">
          <Flame className="h-3 w-3 text-orange-500" />
          {Math.round(audio.virality_score)} virality
        </Badge>
      ) : null}
      {audio.trend_rate ? (
        <Badge variant="outline" className="gap-1">
          <TrendingUp className="h-3 w-3" />
          {audio.trend_rate > 0 ? "+" : ""}
          {audio.trend_rate}%
        </Badge>
      ) : null}
      {audio.trend_label ? (
        <span className="text-[11px] text-muted-foreground">{audio.trend_label}</span>
      ) : null}
    </div>
  );
}

function AudioCard({
  audio,
  playingId,
  isSaved,
  onPlayToggle,
  onSave,
  savePending,
  onDelete,
  deletePending,
  canDelete,
}: {
  audio: TrendingAudioRow;
  playingId: string | null;
  isSaved: boolean;
  onPlayToggle: (audio: TrendingAudioRow) => void;
  onSave: (audio: TrendingAudioRow) => void;
  savePending: boolean;
  onDelete: (audio: TrendingAudioRow) => void;
  deletePending: boolean;
  canDelete: boolean;
}) {
  const navigate = useNavigate();
  const isPlaying = playingId === audio.id;

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex items-start gap-3">
        <div className="relative size-12 shrink-0 overflow-hidden rounded-md bg-surface-raised">
          {audio.cover_url ? (
            <img src={audio.cover_url} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <Play className="h-4 w-4" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{audio.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {audio.author ?? "Unknown artist"}
            {audio.duration_seconds ? ` · ${fmtDuration(audio.duration_seconds)}` : ""}
          </p>
        </div>
      </div>

      <ViralityBadge audio={audio} />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPlayToggle(audio)} className="gap-1.5">
          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {isPlaying ? "Pause" : "Preview"}
        </Button>

        {canDelete ? (
          <Button
            size="sm"
            onClick={() => navigate({ to: "/studio", search: { audioId: audio.id } })}
          >
            Use in Studio
          </Button>
        ) : isSaved ? (
          <Badge
            variant="outline"
            className="h-8 gap-1 border-emerald-500/40 bg-emerald-500/10 px-2.5 text-xs text-emerald-600 dark:text-emerald-400"
          >
            <Check className="h-3 w-3" />
            Saved in Library
          </Badge>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSave(audio)}
            disabled={savePending}
            className="gap-1.5"
          >
            <Bookmark className="h-3.5 w-3.5" />
            Save to Library
          </Button>
        )}

        {!canDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: "/studio", search: { audioId: audio.id } })}
          >
            Use in Studio
          </Button>
        )}

        {canDelete ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto text-destructive hover:bg-destructive/10"
            aria-label="Delete sound"
            onClick={() => onDelete(audio)}
            disabled={deletePending}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function AudioLibraryPanel() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const getTrending = useServerFn(getTrendingAudiosFn);
  const getMyLibrary = useServerFn(getMyAudioLibraryFn);
  const toggleFavorite = useServerFn(toggleFavoriteAudioFn);
  const addUploaded = useServerFn(addUploadedAudioFn);
  const deleteCustom = useServerFn(deleteCustomAudioFn);
  const syncTrending = useServerFn(syncTrendingAudiosFn);
  const importTikTokUrl = useServerFn(importTikTokUrlAudioFn);

  const [tab, setTab] = useState<"global" | "usa" | "mine">("global");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<"file" | "link">("file");
  const [category, setCategory] = useState<string>(AUDIO_CATEGORIES[0]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tiktokLink, setTiktokLink] = useState("");
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const globalQ = useQuery({
    queryKey: ["trending-audios", "global"],
    queryFn: () => getTrending({ data: { region: "global" } }),
    enabled: tab === "global",
  });
  const usaQ = useQuery({
    queryKey: ["trending-audios", "usa"],
    queryFn: () => getTrending({ data: { region: "usa" } }),
    enabled: tab === "usa",
  });
  const mineQ = useQuery({
    queryKey: ["my-audio-library"],
    queryFn: () => getMyLibrary(),
  });

  // The trending tabs are for curated (system-wide) sounds. Your own uploads
  // live under My Library, even though they're also returned by the shared
  // query the Studio picker reads from.
  const systemOnly = (rows: TrendingAudioRow[] | undefined) =>
    (rows ?? []).filter((a) => a.user_id === null);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["trending-audios"] });
    qc.invalidateQueries({ queryKey: ["my-audio-library"] });
  };

  const favMut = useMutation({
    mutationFn: (input: { audioId: string; isFavorite: boolean }) =>
      toggleFavorite({ data: input }),
    onSuccess: () => invalidateAll(),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: async (audio: TrendingAudioRow) => {
      await deleteCustom({ data: { id: audio.id } });
      if (audio.source === "upload" && audio.storage_path) {
        await supabase.storage.from("media").remove([audio.storage_path]);
      }
    },
    onSuccess: () => {
      invalidateAll();
      toast.success("Sound removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncMut = useMutation({
    mutationFn: (region: "global" | "usa") => syncTrending({ data: { region } }),
    onSuccess: (result) => {
      invalidateAll();
      if (result.count > 0)
        toast.success(`Synced ${result.count} trending sound${result.count === 1 ? "" : "s"}`);
      else toast.info(result.message ?? "No new trending sounds found.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const importUrlMut = useMutation({
    mutationFn: (url: string) => importTikTokUrl({ data: { url } }),
    onSuccess: () => {
      invalidateAll();
      setUploadOpen(false);
      setTiktokLink("");
      setTab("mine");
      toast.success("Sound imported to My Library!");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleAudioUpload(file: File) {
    if (uploading) return;
    if (!user) {
      toast.error("Sign in again to upload.");
      return;
    }
    if (!file.type.startsWith("audio/") && !AUDIO_EXT.test(file.name)) {
      toast.error("Choose an audio file (.mp3, .wav, .m4a, .aac, .ogg).");
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      toast.error("That file is over 25 MB.");
      return;
    }
    setUploading(true);
    let path: string | null = null;
    try {
      const objectUrl = URL.createObjectURL(file);
      const duration = await new Promise<number>((resolve) => {
        const probe = new Audio();
        const done = (n: number) => {
          window.clearTimeout(timer);
          URL.revokeObjectURL(objectUrl);
          resolve(n);
        };
        const timer = window.setTimeout(() => done(0), 5000);
        probe.addEventListener("loadedmetadata", () => done(Math.round(probe.duration) || 0), {
          once: true,
        });
        probe.addEventListener("error", () => done(0), { once: true });
        probe.src = objectUrl;
      });

      const ext = (file.name.split(".").pop() || "mp3").toLowerCase();
      path = `${user.id}/audio-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("media")
        .upload(path, file, { contentType: file.type || "audio/mpeg" });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      await addUploaded({
        data: {
          title: file.name.replace(/\.[^/.]+$/, ""),
          storagePath: path,
          category,
          ...(duration > 0 ? { durationSeconds: duration } : {}),
        },
      });
      invalidateAll();
      setUploadOpen(false);
      setTab("mine");
      toast.success("Sound added to your library");
    } catch (e) {
      if (path) await supabase.storage.from("media").remove([path]);
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handlePlayToggle(audio: TrendingAudioRow) {
    if (playingId === audio.id) {
      audioElRef.current?.pause();
      setPlayingId(null);
      return;
    }
    const url = await resolveAudioUrl(audio);
    if (!url) {
      toast.error("This sound has no playable audio link.");
      return;
    }
    if (!audioElRef.current) audioElRef.current = new Audio();
    const el = audioElRef.current;
    el.pause();
    el.src = url;
    el.play().catch(() => toast.error("Could not play this sound."));
    setPlayingId(audio.id);
    el.onended = () => setPlayingId((cur) => (cur === audio.id ? null : cur));
  }

  // Cross-reference all IDs, external_ids, and titles saved in the user's personal library
  const savedKeys = new Set(
    (mineQ.data?.audios ?? [])
      .flatMap((a) => [a.id, a.external_id, a.title.toLowerCase().trim()])
      .filter(Boolean),
  );

  function renderList(
    audios: TrendingAudioRow[],
    isLoading: boolean,
    emptyHint: string,
    canDelete = false,
  ) {
    if (isLoading) return <p className="text-sm text-muted-foreground">Loading sounds…</p>;
    if (audios.length === 0) {
      return (
        <p className="rounded-md border border-border bg-surface-raised p-4 text-sm text-muted-foreground">
          {emptyHint}
        </p>
      );
    }
    return (
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {audios.map((a) => {
          const isSaved =
            savedKeys.has(a.id) ||
            (a.external_id ? savedKeys.has(a.external_id) : false) ||
            savedKeys.has(a.title.toLowerCase().trim());

          return (
            <AudioCard
              key={a.id}
              audio={a}
              playingId={playingId}
              isSaved={isSaved}
              onPlayToggle={handlePlayToggle}
              onSave={(audio) =>
                favMut.mutate(
                  { audioId: audio.id, isFavorite: true },
                  {
                    onSuccess: () => {
                      toast.success("Saved to your Library! Ready for Clip DNA & Studio.");
                    },
                  },
                )
              }
              savePending={favMut.isPending}
              onDelete={(audio) => deleteMut.mutate(audio)}
              deletePending={deleteMut.isPending}
              canDelete={canDelete}
            />
          );
        })}
      </ul>
    );
  }

  const noTrendingHint =
    "No trending sounds have been added yet. Upload your own or click 'Sync trending' to pull the latest chart.";

  return (
    <section className="panel space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Trending Audio Library</h2>
          <p className="text-xs text-muted-foreground">
            Pick a sound to bake into your next render, or let the VA auto-pick the top track.
          </p>
        </div>
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload className="mr-2 h-4 w-4" />
          Add audio
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="global">Trending Global</TabsTrigger>
          <TabsTrigger value="usa">Trending USA</TabsTrigger>
          <TabsTrigger value="mine">My Library</TabsTrigger>
        </TabsList>

        <TabsContent value="global" className="pt-4">
          <div className="mb-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncMut.mutate("global")}
              disabled={syncMut.isPending}
            >
              {syncMut.isPending && syncMut.variables === "global" ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
              )}
              Sync trending
            </Button>
          </div>
          {renderList(systemOnly(globalQ.data?.audios), globalQ.isLoading, noTrendingHint)}
        </TabsContent>
        <TabsContent value="usa" className="pt-4">
          <div className="mb-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncMut.mutate("usa")}
              disabled={syncMut.isPending}
            >
              {syncMut.isPending && syncMut.variables === "usa" ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
              )}
              Sync trending
            </Button>
          </div>
          {renderList(systemOnly(usaQ.data?.audios), usaQ.isLoading, noTrendingHint)}
        </TabsContent>
        <TabsContent value="mine" className="pt-4">
          {renderList(
            mineQ.data?.audios ?? [],
            mineQ.isLoading,
            "Nothing here yet. Upload an audio file or click 'Save to Library' on any trending track.",
            true,
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          if (uploading || importUrlMut.isPending) return;
          setUploadOpen(open);
          if (!open) {
            setUploadMode("file");
            setTiktokLink("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {uploadMode === "file" ? "Upload audio" : "Import a TikTok link"}
            </DialogTitle>
            <DialogDescription>
              {uploadMode === "file"
                ? "Upload an audio file you have the rights to use. Uploaded files always play and export correctly."
                : "Paste a TikTok video or sound link — the audio is extracted and saved to your library."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Button
              type="button"
              variant={uploadMode === "file" ? "default" : "outline"}
              size="sm"
              onClick={() => setUploadMode("file")}
            >
              <Upload className="mr-2 h-3.5 w-3.5" />
              Upload a file
            </Button>
            <Button
              type="button"
              variant={uploadMode === "link" ? "default" : "outline"}
              size="sm"
              onClick={() => setUploadMode("link")}
            >
              <Link2 className="mr-2 h-3.5 w-3.5" />
              Paste a TikTok link
            </Button>
          </div>

          {uploadMode === "file" ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="audio-category">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="audio-category" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIO_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) void handleAudioUpload(file);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center hover:bg-muted/50 ${
                  dragging ? "border-primary bg-muted/50" : "border-border"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleAudioUpload(file);
                    e.target.value = "";
                  }}
                />
                {uploading ? (
                  <Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin text-muted-foreground" />
                ) : (
                  <Upload className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                )}
                <p className="text-sm font-medium">
                  {uploading ? "Uploading…" : "Drop an audio file here, or click to browse"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  MP3, WAV, M4A, AAC or OGG, up to 25 MB
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="tiktok-link">TikTok link</Label>
                <Input
                  id="tiktok-link"
                  placeholder="https://www.tiktok.com/@user/video/… or https://vm.tiktok.com/…"
                  value={tiktokLink}
                  onChange={(e) => setTiktokLink(e.target.value)}
                  disabled={importUrlMut.isPending}
                />
                <p className="text-[11px] text-muted-foreground">
                  Works with a video link (its sound is extracted) or a sound page link.
                </p>
              </div>
              <Button
                className="w-full"
                disabled={!tiktokLink.trim() || importUrlMut.isPending}
                onClick={() => importUrlMut.mutate(tiktokLink.trim())}
              >
                {importUrlMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import sound
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
