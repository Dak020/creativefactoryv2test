import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Music, Pause, Play, Shuffle, Volume2 } from "lucide-react";
import {
  getTrendingAudiosFn,
  getMyAudioLibraryFn,
  getAutoPickAudioFn,
  type TrendingAudioRow,
} from "@/lib/audio.functions";
import { resolveAudioUrl } from "@/lib/audio-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export type AudioStrategy = "none" | "original" | "auto" | "library";

export type AudioSelection = {
  strategy: AudioStrategy;
  /** true when the exported file should keep the source clip's own audio. */
  withAudio: boolean;
  /** The chosen soundtrack row, if the strategy resolves to one. */
  audio: TrendingAudioRow | null;
};

/**
 * "None" / "Original clip audio only" / "VA auto-pick" / "Pick from library".
 * Resolves to a soundtrack row (or none) that the caller mixes into the
 * render via soundtrackUrl/soundtrackVolume. Includes an inline preview player
 * and a VA sound shuffle button.
 */
export function AudioStrategySelector({
  value,
  onChange,
  /** Pre-selected track id, e.g. arriving from the Audio Library's "Use in Studio" link. */
  initialAudioId,
}: {
  value: AudioSelection;
  onChange: (next: AudioSelection) => void;
  initialAudioId?: string | null;
}) {
  const getAutoPick = useServerFn(getAutoPickAudioFn);
  const getTrending = useServerFn(getTrendingAudiosFn);
  const getMyLibrary = useServerFn(getMyAudioLibraryFn);

  const [autoRegion, setAutoRegion] = useState<"global" | "usa">("global");
  const [libraryAudioId, setLibraryAudioId] = useState<string | null>(initialAudioId ?? null);
  const [isShuffling, setIsShuffling] = useState(false);

  // Preview audio player state
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);

  const autoPickQ = useQuery({
    queryKey: ["auto-pick-audio", autoRegion],
    queryFn: () => getAutoPick({ data: { region: autoRegion } }),
    enabled: value.strategy === "auto",
  });

  const myLibraryQ = useQuery({
    queryKey: ["my-audio-library"],
    queryFn: () => getMyLibrary(),
    enabled: value.strategy === "library" || Boolean(initialAudioId),
  });

  const trendingListQ = useQuery({
    queryKey: ["trending-audios", "global"],
    queryFn: () => getTrending({ data: { region: "global" } }),
    enabled: value.strategy === "library" || Boolean(initialAudioId),
  });

  const myAudios = useMemo(() => myLibraryQ.data?.audios ?? [], [myLibraryQ.data]);
  const trendingAudios = useMemo(
    () => (trendingListQ.data?.audios ?? []).filter((a) => a.user_id === null),
    [trendingListQ.data],
  );

  const allSelectableAudios = useMemo(
    () => [...myAudios, ...trendingAudios],
    [myAudios, trendingAudios],
  );

  // Stop audio whenever the track changes or strategy switches
  const stopAudio = () => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setIsLoadingAudio(false);
  };

  useEffect(() => {
    stopAudio();
    return () => stopAudio();
  }, [value.audio?.id, value.strategy]);

  // Play / Pause preview handler
  async function handleTogglePlay() {
    if (!value.audio) return;

    if (isPlaying) {
      stopAudio();
      return;
    }

    setIsLoadingAudio(true);
    try {
      const url = await resolveAudioUrl(value.audio);
      if (!url) {
        toast.error("This sound has no playable preview link.");
        setIsLoadingAudio(false);
        return;
      }

      if (!audioElRef.current) {
        audioElRef.current = new Audio();
      }
      const el = audioElRef.current;
      el.pause();
      el.src = url;
      el.onended = () => {
        setIsPlaying(false);
        setIsLoadingAudio(false);
      };
      el.onerror = () => {
        toast.error("Could not play sound preview.");
        setIsPlaying(false);
        setIsLoadingAudio(false);
      };

      await el.play();
      setIsPlaying(true);
    } catch {
      toast.error("Could not play sound preview.");
      setIsPlaying(false);
    } finally {
      setIsLoadingAudio(false);
    }
  }

  // Shuffle / Re-roll VA pick
  async function handleShuffle() {
    setIsShuffling(true);
    stopAudio();
    try {
      const result = await getAutoPick({
        data: {
          region: autoRegion,
          excludeId: value.audio?.id ?? undefined,
        },
      });
      if (result.audio) {
        onChange({ strategy: "auto", withAudio: value.withAudio, audio: result.audio });
        toast.success(`Picked: ${result.audio.title}`);
      } else {
        toast.info("No alternative trending sound found.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setIsShuffling(false);
    }
  }

  // Auto-pick: whenever the region result changes, push the resolved track up
  useEffect(() => {
    if (value.strategy !== "auto") return;
    if (autoPickQ.data?.audio && !value.audio) {
      onChange({ strategy: "auto", withAudio: false, audio: autoPickQ.data.audio });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.strategy, autoPickQ.data?.audio?.id]);

  // A track arriving via ?audioId= pre-selects "library" mode
  useEffect(() => {
    if (!initialAudioId || value.strategy !== "none") return;
    const match = allSelectableAudios.find((a) => a.id === initialAudioId);
    if (match) {
      setLibraryAudioId(match.id);
      onChange({ strategy: "library", withAudio: value.withAudio, audio: match });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAudioId, allSelectableAudios.length]);

  const selectedLibraryAudio = useMemo(
    () => allSelectableAudios.find((a) => a.id === libraryAudioId) ?? null,
    [allSelectableAudios, libraryAudioId],
  );

  function setStrategy(strategy: AudioStrategy) {
    stopAudio();
    if (strategy === "none") {
      onChange({ strategy, withAudio: false, audio: null });
    } else if (strategy === "original") {
      onChange({ strategy, withAudio: true, audio: null });
    } else if (strategy === "auto") {
      onChange({ strategy, withAudio: false, audio: autoPickQ.data?.audio ?? null });
    } else {
      onChange({ strategy, withAudio: value.withAudio, audio: selectedLibraryAudio });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3 bg-card/40">
      <div className="flex items-center gap-2">
        <Music className="h-3.5 w-3.5 text-muted-foreground" />
        <Label className="text-xs font-medium">Audio</Label>
      </div>

      <Select value={value.strategy} onValueChange={(v) => setStrategy(v as AudioStrategy)}>
        <SelectTrigger className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None (silent)</SelectItem>
          <SelectItem value="original">Original clip audio only</SelectItem>
          <SelectItem value="auto">VA auto-pick sound</SelectItem>
          <SelectItem value="library">Select from audio library</SelectItem>
        </SelectContent>
      </Select>

      {/* VA AUTO-PICK CONTROLS */}
      {value.strategy === "auto" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={autoRegion}
              onValueChange={(v) => {
                const nextRegion = v as "global" | "usa";
                setAutoRegion(nextRegion);
                getAutoPick({ data: { region: nextRegion } }).then((res) => {
                  if (res.audio) {
                    onChange({ strategy: "auto", withAudio: value.withAudio, audio: res.audio });
                  }
                });
              }}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Top global sound</SelectItem>
                <SelectItem value="usa">Top USA sound</SelectItem>
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleShuffle}
              disabled={isShuffling || autoPickQ.isLoading}
              className="gap-1.5 text-xs h-9"
              title="Pick a different trending sound"
            >
              <Shuffle className={`h-3.5 w-3.5 ${isShuffling ? "animate-spin" : ""}`} />
              {isShuffling ? "Picking…" : "Shuffle sound"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* LIBRARY PICKER CONTROLS */}
      {value.strategy === "library" ? (
        <div className="space-y-2">
          <Select
            value={libraryAudioId ?? ""}
            onValueChange={(id) => {
              setLibraryAudioId(id);
              const match = allSelectableAudios.find((a) => a.id === id) ?? null;
              onChange({ strategy: "library", withAudio: value.withAudio, audio: match });
            }}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue
                placeholder={
                  myLibraryQ.isLoading || trendingListQ.isLoading
                    ? "Loading sounds…"
                    : "Choose a sound"
                }
              />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {myAudios.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    My Saved Library
                  </SelectLabel>
                  {myAudios.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.title}
                      {a.author ? ` — ${a.author}` : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}

              {trendingAudios.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Trending TikTok Sounds
                  </SelectLabel>
                  {trendingAudios.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.title}
                      {a.author ? ` — ${a.author}` : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          {allSelectableAudios.length === 0 && !myLibraryQ.isLoading && !trendingListQ.isLoading ? (
            <p className="text-[11px] text-muted-foreground">
              No sounds available yet — visit the Audio Library to sync or import one.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* AUDIO PREVIEW PLAYER CARD */}
      {(value.strategy === "auto" || value.strategy === "library") && value.audio ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background/80 p-2.5 shadow-sm">
          <div className="flex items-center gap-2.5 min-w-0">
            <Button
              type="button"
              variant={isPlaying ? "default" : "secondary"}
              size="icon"
              onClick={handleTogglePlay}
              disabled={isLoadingAudio}
              className="h-8 w-8 shrink-0 rounded-full"
              title={isPlaying ? "Pause preview" : "Play preview"}
            >
              {isLoadingAudio ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 ml-0.5" />
              )}
            </Button>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {value.audio.title}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {value.audio.author ? value.audio.author : "TikTok Trending"}
                {value.audio.duration_seconds ? ` • ${Math.round(value.audio.duration_seconds)}s` : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {value.audio.virality_score > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-amber-500/30 text-amber-500 bg-amber-500/5">
                🔥 {value.audio.virality_score}
              </Badge>
            )}
            {isPlaying && (
              <span className="flex items-center gap-1 text-[11px] text-primary font-medium animate-pulse">
                <Volume2 className="h-3.5 w-3.5" />
                Previewing
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* CLIP AUDIO MIXING CHECKBOX */}
      {(value.strategy === "auto" || value.strategy === "library") && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer pt-1">
          <input
            type="checkbox"
            className="size-3.5 rounded border-border"
            checked={value.withAudio}
            onChange={(e) => onChange({ ...value, withAudio: e.target.checked })}
          />
          Also keep the clip's own audio, mixed underneath
        </label>
      )}
    </div>
  );
}
