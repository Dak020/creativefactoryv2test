import { signedUrl } from "@/lib/db";

/**
 * Resolve a trending_audios row to a URL the browser can actually play. Used
 * for quick preview playback ONLY — a plain <audio> tag with no crossOrigin
 * set can usually play a raw external link fine, even without CORS headers.
 * Imported sounds are just a pasted external link (`audio_url`) with no
 * `storage_path`; a track we've stored ourselves is signed from the `media`
 * bucket instead.
 */
export async function resolveAudioUrl(audio: {
  storage_path: string | null;
  audio_url: string | null;
}): Promise<string | null> {
  if (audio.storage_path) {
    const url = await signedUrl("media", audio.storage_path, 60 * 60 * 6);
    if (url) return url;
  }
  return audio.audio_url ?? null;
}

/**
 * Resolve a trending_audios row to a URL safe to bake into a render. Unlike
 * resolveAudioUrl, this NEVER hands back a raw external link: the renderer
 * sets audio.crossOrigin = "anonymous" to pipe the track into an
 * AudioContext, which the browser blocks on any host that doesn't send CORS
 * headers (TikTok's CDN doesn't). A row with only audio_url — synced from
 * Apify or imported by link but not yet cached — is downloaded and cached
 * into our own storage server-side first (prepareAudioForRenderFn), and
 * every future render of that same track reuses the cached copy.
 */
export async function resolveAudioForRender(
  audio: { id: string; storage_path: string | null; audio_url: string | null },
  prepareAudioForRender: (input: { data: { audioId: string } }) => Promise<{ url: string | null }>,
): Promise<string | null> {
  if (audio.storage_path) {
    const url = await signedUrl("media", audio.storage_path, 60 * 60 * 6);
    if (url) return url;
  }
  if (!audio.audio_url) return null;
  const { url } = await prepareAudioForRender({ data: { audioId: audio.id } });
  return url;
}
