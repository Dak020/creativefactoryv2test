import { signedUrl } from "@/lib/db";

/**
 * Resolve a trending_audios row to a URL the browser can actually play (and,
 * for a render, a URL the renderer can fetch cross-origin). Imported sounds
 * are just a pasted external link (`audio_url`) with no `storage_path`; a
 * track we've stored ourselves is signed from the `media` bucket instead.
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
