import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Music } from "lucide-react";
import {
  getTrendingAudiosFn,
  getAutoPickAudioFn,
  type TrendingAudioRow,
} from "@/lib/audio.functions";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
 * render via soundtrackUrl/soundtrackVolume.
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

  const [autoRegion, setAutoRegion] = useState<"global" | "usa">("global");
  const [libraryAudioId, setLibraryAudioId] = useState<string | null>(initialAudioId ?? null);

  const autoPickQ = useQuery({
    queryKey: ["auto-pick-audio", autoRegion],
    queryFn: () => getAutoPick({ data: { region: autoRegion } }),
    enabled: value.strategy === "auto",
  });

  // The full trending list backs the "pick from library" dropdown — reusing
  // the same query key as the Audio Library page means switching here after
  // visiting that page is instant (no refetch).
  const libraryListQ = useQuery({
    queryKey: ["trending-audios", "global"],
    queryFn: () => getTrending({ data: { region: "global" } }),
    enabled: value.strategy === "library" || Boolean(initialAudioId),
  });
  const libraryAudios = useMemo(() => libraryListQ.data?.audios ?? [], [libraryListQ.data]);

  // Auto-pick: whenever the region result changes, push the resolved track
  // up to the caller so it actually gets used in the render.
  useEffect(() => {
    if (value.strategy !== "auto") return;
    onChange({ strategy: "auto", withAudio: false, audio: autoPickQ.data?.audio ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.strategy, autoPickQ.data?.audio?.id]);

  // A track arriving via ?audioId= pre-selects "library" mode once the list loads.
  useEffect(() => {
    if (!initialAudioId || value.strategy !== "none") return;
    const match = libraryAudios.find((a) => a.id === initialAudioId);
    if (match) {
      setLibraryAudioId(match.id);
      onChange({ strategy: "library", withAudio: value.withAudio, audio: match });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAudioId, libraryAudios.length]);

  const selectedLibraryAudio = useMemo(
    () => libraryAudios.find((a) => a.id === libraryAudioId) ?? null,
    [libraryAudios, libraryAudioId],
  );

  function setStrategy(strategy: AudioStrategy) {
    if (strategy === "none") onChange({ strategy, withAudio: false, audio: null });
    else if (strategy === "original") onChange({ strategy, withAudio: true, audio: null });
    else if (strategy === "auto")
      onChange({ strategy, withAudio: false, audio: autoPickQ.data?.audio ?? null });
    else onChange({ strategy, withAudio: value.withAudio, audio: selectedLibraryAudio });
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <Music className="h-3.5 w-3.5 text-muted-foreground" />
        <Label className="text-xs">Audio</Label>
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

      {value.strategy === "auto" ? (
        <div className="space-y-1.5">
          <Select value={autoRegion} onValueChange={(v) => setAutoRegion(v as "global" | "usa")}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Top global sound</SelectItem>
              <SelectItem value="usa">Top USA sound</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {autoPickQ.isLoading
              ? "Finding the top track…"
              : autoPickQ.data?.audio
                ? `Picked: ${autoPickQ.data.audio.title}${autoPickQ.data.audio.author ? ` — ${autoPickQ.data.audio.author}` : ""}`
                : "No trending sound available for this region yet."}
          </p>
        </div>
      ) : null}

      {value.strategy === "library" ? (
        <div className="space-y-1.5">
          <Select
            value={libraryAudioId ?? ""}
            onValueChange={(id) => {
              setLibraryAudioId(id);
              const match = libraryAudios.find((a) => a.id === id) ?? null;
              onChange({ strategy: "library", withAudio: value.withAudio, audio: match });
            }}
          >
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue
                placeholder={libraryListQ.isLoading ? "Loading sounds…" : "Choose a sound"}
              />
            </SelectTrigger>
            <SelectContent>
              {libraryAudios.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.title}
                  {a.author ? ` — ${a.author}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {libraryAudios.length === 0 && !libraryListQ.isLoading ? (
            <p className="text-[11px] text-muted-foreground">
              No sounds saved yet — visit the Audio Library to import or favorite one.
            </p>
          ) : null}
        </div>
      ) : null}

      {(value.strategy === "auto" || value.strategy === "library") && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5"
            checked={value.withAudio}
            onChange={(e) => onChange({ ...value, withAudio: e.target.checked })}
          />
          Also keep the clip's own audio, mixed underneath
        </label>
      )}
    </div>
  );
}
