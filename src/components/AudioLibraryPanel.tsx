import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Flame, Loader2, Pause, Play, Plus, Star, TrendingUp, Trash2 } from "lucide-react";
import {
  getTrendingAudiosFn,
  getMyAudioLibraryFn,
  toggleFavoriteAudioFn,
  addCustomAudioFn,
  deleteCustomAudioFn,
  type TrendingAudioRow,
} from "@/lib/audio.functions";
import { resolveAudioUrl } from "@/lib/audio-url";
import { fmtDuration } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ImportDraft = { title: string; author: string; audioUrl: string; coverUrl: string };
const emptyImport: ImportDraft = { title: "", author: "", audioUrl: "", coverUrl: "" };

function ViralityBadge({ audio }: { audio: TrendingAudioRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary" className="gap-1">
        <Flame className="h-3 w-3 text-orange-500" />
        {Math.round(audio.virality_score)} virality
      </Badge>
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
  onPlayToggle,
  onFavorite,
  favoritePending,
  onDelete,
  deletePending,
  canDelete,
}: {
  audio: TrendingAudioRow;
  playingId: string | null;
  onPlayToggle: (audio: TrendingAudioRow) => void;
  onFavorite: (audio: TrendingAudioRow) => void;
  favoritePending: boolean;
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
        <button
          type="button"
          aria-label={audio.is_favorite ? "Remove favorite" : "Mark as favorite"}
          onClick={() => onFavorite(audio)}
          disabled={favoritePending}
          className="mt-0.5 shrink-0"
        >
          <Star
            className={
              audio.is_favorite
                ? "h-4 w-4 fill-amber-400 text-amber-400"
                : "h-4 w-4 text-muted-foreground"
            }
          />
        </button>
      </div>

      <ViralityBadge audio={audio} />

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPlayToggle(audio)} className="gap-1.5">
          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {isPlaying ? "Pause" : "Preview"}
        </Button>
        <Button
          size="sm"
          onClick={() => navigate({ to: "/studio", search: { audioId: audio.id } })}
        >
          Use in Studio
        </Button>
        {canDelete && onDelete ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
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
  const getTrending = useServerFn(getTrendingAudiosFn);
  const getMyLibrary = useServerFn(getMyAudioLibraryFn);
  const toggleFavorite = useServerFn(toggleFavoriteAudioFn);
  const addCustom = useServerFn(addCustomAudioFn);
  const deleteCustom = useServerFn(deleteCustomAudioFn);

  const [tab, setTab] = useState<"global" | "usa" | "mine">("global");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [draft, setDraft] = useState<ImportDraft>(emptyImport);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

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
    enabled: tab === "mine",
  });

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

  const importMut = useMutation({
    mutationFn: (input: ImportDraft) =>
      addCustom({
        data: {
          title: input.title,
          audioUrl: input.audioUrl,
          ...(input.author ? { author: input.author } : {}),
          ...(input.coverUrl ? { coverUrl: input.coverUrl } : {}),
        },
      }),
    onSuccess: () => {
      invalidateAll();
      setImportOpen(false);
      setDraft(emptyImport);
      toast.success("Sound imported");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteCustom({ data: { id } }),
    onSuccess: () => {
      invalidateAll();
      toast.success("Sound removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

  const canSaveImport = draft.title.trim() && /^https?:\/\//i.test(draft.audioUrl.trim());

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
        {audios.map((a) => (
          <AudioCard
            key={a.id}
            audio={a}
            playingId={playingId}
            onPlayToggle={handlePlayToggle}
            onFavorite={(audio) =>
              favMut.mutate({ audioId: audio.id, isFavorite: !audio.is_favorite })
            }
            favoritePending={favMut.isPending}
            onDelete={(audio) => deleteMut.mutate(audio.id)}
            deletePending={deleteMut.isPending}
            canDelete={canDelete}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="panel space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Trending Audio Library</h2>
          <p className="text-xs text-muted-foreground">
            Pick a sound to bake into your next render, or let the VA auto-pick the top track.
          </p>
        </div>
        <Button size="sm" onClick={() => setImportOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Import audio
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="global">Trending Global</TabsTrigger>
          <TabsTrigger value="usa">Trending USA</TabsTrigger>
          <TabsTrigger value="mine">My Library</TabsTrigger>
        </TabsList>

        <TabsContent value="global" className="pt-4">
          {renderList(
            globalQ.data?.audios ?? [],
            globalQ.isLoading,
            "No global trending sounds yet — check back soon or import your own.",
          )}
        </TabsContent>
        <TabsContent value="usa" className="pt-4">
          {renderList(
            usaQ.data?.audios ?? [],
            usaQ.isLoading,
            "No USA trending sounds yet — check back soon or import your own.",
          )}
        </TabsContent>
        <TabsContent value="mine" className="pt-4">
          {renderList(
            mineQ.data?.audios ?? [],
            mineQ.isLoading,
            "Nothing here yet — favorite a trending sound or import your own link.",
            true,
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import audio</DialogTitle>
            <DialogDescription>
              Paste a direct link to an MP3 file, give it a title, and it's saved to your library.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="audio-title">Title</Label>
              <Input
                id="audio-title"
                placeholder="e.g. Original sound - creator"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audio-author">Artist (optional)</Label>
              <Input
                id="audio-author"
                value={draft.author}
                onChange={(e) => setDraft({ ...draft, author: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audio-url">MP3 or TikTok link</Label>
              <Input
                id="audio-url"
                placeholder="https://…"
                value={draft.audioUrl}
                onChange={(e) => setDraft({ ...draft, audioUrl: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                Must be a direct, publicly accessible link — a page that requires sign-in won't
                play.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => importMut.mutate(draft)}
              disabled={!canSaveImport || importMut.isPending}
            >
              {importMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save sound
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
