/**
 * Trending TikTok sound discovery.
 *
 * TikTok's own developer API only covers login and publishing — it exposes no
 * sound catalogue — so the charts come from an Apify actor that reads TikTok's
 * public search/sound pages.
 */
const GATEWAY_URL = "https://connector-gateway.lovable.dev/apify";
const SOUNDS_ACTOR = "seemuapps~tiktok-sounds-scraper";

export type ApifySound = {
  soundId?: string;
  title?: string;
  author?: string | null;
  durationSec?: number | null;
  usageCount?: number | null;
  coverUrl?: string | null;
  playUrl?: string | null;
  soundUrl?: string | null;
  sampleTopVideoPlays?: number | null;
  sampleTotalPlays?: number | null;
};

export type TrendingAudioSeed = {
  title: string;
  author: string | null;
  audio_url: string;
  cover_url: string | null;
  duration_seconds: number | null;
  virality_score: number;
  trend_rate: number;
  trend_label: string;
  external_id: string;
  source_url: string;
};

function apifyHeaders() {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const apifyKey = process.env["APIFY_API_KEY"];
  if (!lovableKey || !apifyKey) {
    throw new Error(
      "The trending-sound service isn't connected yet. Connect Apify, then try syncing again.",
    );
  }
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": apifyKey,
    "Content-Type": "application/json",
  };
}

async function runActor(input: unknown): Promise<ApifySound[]> {
  const res = await fetch(`${GATEWAY_URL}/acts/${SOUNDS_ACTOR}/run-sync-get-dataset-items`, {
    method: "POST",
    headers: apifyHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[apify] sounds actor failed [${res.status}]: ${body}`);
    throw new Error("Could not reach the trending-sound service. Try again in a minute.");
  }
  const items = (await res.json()) as unknown;
  return Array.isArray(items) ? (items as ApifySound[]) : [];
}

/**
 * Keywords per region. These target what people actually scroll past on the
 * For You page — songs AND iconic non-music sounds (drops, sax builds, remix
 * beats) — instead of the generic "trending sound" tag that meme/skit
 * accounts spam in their captions.
 */
const REGION_KEYWORDS: Record<string, { keywords: string[]; country?: string }> = {
  global: {
    keywords: ["viral fyp songs", "trending fyp music", "tiktok viral hits", "viral tiktok audio"],
  },
  usa: {
    keywords: ["trending fyp music usa", "viral songs tiktok us", "tiktok viral hits"],
    country: "US",
  },
};

/**
 * Titles that mark caption-spam rather than a real trending sound: meme skits,
 * AI slop, storytime dialogue and unnamed UGC voice clips.
 */
const SPAM_TITLE =
  /(fruit|brainrot|skit|storytime|story time|\bpov\b|part\s?\d|episode|\bdrama\b|ai voice|\bmeme\b|\basmr\b|original sound\s*-\s*(user)?\d{4,})/i;

/** Shortest sound we keep — below this it's almost always a reaction soundbite. */
const MIN_DURATION_SEC = 8;

/**
 * Fetch and rank the current trending sounds for a region. TikTok's public
 * search can come back thin for a narrow window, so widen the date range
 * instead of reporting "no sounds found".
 */
export async function fetchTrendingSounds(region: string, limit = 40): Promise<TrendingAudioSeed[]> {
  const cfg = REGION_KEYWORDS[region] ?? REGION_KEYWORDS["global"]!;
  const windows = ["this-week", "this-month", "all-time"] as const;

  for (const datePosted of windows) {
    const items = await runActor({
      mode: "sounds",
      keywords: cfg.keywords,
      sortBy: "most-liked",
      datePosted,
      ...(cfg.country ? { region: cfg.country } : {}),
      maxItems: limit,
    });
    const ranked = rankSounds(items);
    if (ranked.length > 0) return ranked;
  }
  return [];
}

/** Full metadata for one sound, looked up by its TikTok sound page URL or id. */
export async function fetchSoundDetails(soundUrlOrId: string): Promise<ApifySound | null> {
  const items = await runActor({ mode: "soundDetails", sounds: [soundUrlOrId] });
  return items[0] ?? null;
}

/** Turn raw usage numbers into the virality score and breakout badge the UI shows. */
export function rankSounds(items: ApifySound[]): TrendingAudioSeed[] {
  const usable = items.filter((s) => s.playUrl && s.title);
  if (usable.length === 0) return [];
  const maxUsage = Math.max(...usable.map((s) => s.usageCount ?? 0), 1);
  const maxPlays = Math.max(...usable.map((s) => s.sampleTopVideoPlays ?? 0), 1);

  return usable
    .map((s) => {
      const usage = s.usageCount ?? 0;
      const plays = s.sampleTopVideoPlays ?? 0;
      // Usage count is how widely a sound is already adopted; top-video plays
      // show how hard it's hitting right now. Blend both so an early sound
      // with huge reach still ranks.
      const reach = Math.round((usage / maxUsage) * 60 + (plays / maxPlays) * 40);
      const trendRate = Math.round((plays / Math.max(usage, 1)) * 10) / 10;
      const label =
        reach >= 80
          ? "Blowing up"
          : trendRate >= 50
            ? "Early breakout"
            : reach >= 45
              ? "Rising"
              : "Steady";
      return {
        title: s.title!.slice(0, 200),
        author: s.author?.slice(0, 120) ?? null,
        audio_url: s.playUrl!,
        cover_url: s.coverUrl ?? null,
        duration_seconds: s.durationSec ?? null,
        virality_score: Math.min(100, Math.max(1, reach)),
        trend_rate: Math.min(999, trendRate),
        trend_label: label,
        external_id: s.soundId ?? "",
        source_url: s.soundUrl ?? "",
      };
    })
    .sort((a, b) => b.virality_score - a.virality_score);
}

/**
 * Resolve any TikTok video or sound link to its audio. Video links go through
 * a public resolver; sound pages are looked up through the sounds actor.
 */
export async function resolveTikTokLink(url: string): Promise<{
  title: string;
  author: string | null;
  audioUrl: string;
  coverUrl: string | null;
  durationSeconds: number | null;
  externalId: string | null;
  sourceUrl: string;
} | null> {
  if (/tiktok\.com\/music\//i.test(url)) {
    const sound = await fetchSoundDetails(url);
    if (!sound?.playUrl) return null;
    return {
      title: sound.title ?? "TikTok sound",
      author: sound.author ?? null,
      audioUrl: sound.playUrl,
      coverUrl: sound.coverUrl ?? null,
      durationSeconds: sound.durationSec ?? null,
      externalId: sound.soundId ?? null,
      sourceUrl: sound.soundUrl ?? url,
    };
  }

  const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=0`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[tiktok-link] resolver failed [${res.status}]`);
    return null;
  }
  const json = (await res.json()) as {
    code?: number;
    data?: {
      music?: string;
      title?: string;
      cover?: string;
      music_info?: { title?: string; author?: string; play?: string; cover?: string; duration?: number };
    };
  };
  const info = json.data?.music_info;
  const audioUrl = info?.play ?? json.data?.music;
  if (json.code !== 0 || !audioUrl) return null;
  return {
    title: (info?.title ?? json.data?.title ?? "TikTok sound").slice(0, 200),
    author: info?.author?.slice(0, 120) ?? null,
    audioUrl,
    coverUrl: info?.cover ?? json.data?.cover ?? null,
    durationSeconds: info?.duration ?? null,
    externalId: null,
    sourceUrl: url,
  };
}

/** Download an audio file so it can be stored in our own bucket (CORS-safe). */
export async function downloadAudio(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.tiktok.com/" },
  });
  if (!res.ok) throw new Error("That sound could not be downloaded.");
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error("That sound came back empty.");
  if (bytes.byteLength > 30 * 1024 * 1024) throw new Error("That sound is too large.");
  const contentType = res.headers.get("content-type") ?? "audio/mpeg";
  return { bytes, contentType: contentType.startsWith("audio") ? contentType : "audio/mpeg" };
}
