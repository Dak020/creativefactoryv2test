export interface BrowserRenderOptions {
  sourceUrl: string;
  startSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
  text: string;
  placement?: HookPlacement;
  fontSize?: number;
  textColor?: string;
  backgroundColor?: string;
  withAudio?: boolean;
  soundtrackUrl?: string | null;
  soundtrackVolume?: number;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export type HookPlacement = "top" | "middle" | "bottom";

export interface BrowserRenderResult {
  blob: Blob;
  extension: string;
  mimeType: string;
  thumbnail?: Blob;
}

export class RenderCancelledError extends Error {
  constructor() {
    super("Render was cancelled");
    this.name = "RenderCancelledError";
  }
}

export interface SeekOptions {
  seekMode?: "start" | "uniform" | "random" | "smart";
  totalDuration?: number;
  stepSeconds?: number;
}

export function planStartOffsets(
  clipDuration: number,
  targetDuration: number,
  variantCount: number,
  options?: SeekOptions,
): number[] {
  const maxStart = Math.max(0, clipDuration - targetDuration);
  if (maxStart === 0 || variantCount <= 1) {
    return Array.from({ length: variantCount }, () => 0);
  }

  const mode = options?.seekMode ?? "uniform";
  const step = options?.stepSeconds ?? 1.5;

  if (mode === "start") {
    return Array.from({ length: variantCount }, () => 0);
  }

  if (mode === "smart") {
    const offsets: number[] = [];
    for (let i = 0; i < variantCount; i++) {
      const candidate = (i * step) % (maxStart + 0.001);
      offsets.push(Math.min(candidate, maxStart));
    }
    return offsets;
  }

  if (mode === "random") {
    return Array.from({ length: variantCount }, () => {
      const rand = Math.random() * maxStart;
      return Math.round(rand * 10) / 10;
    });
  }

  const interval = maxStart / (variantCount - 1);
  return Array.from({ length: variantCount }, (_, i) => {
    return Math.round(i * interval * 10) / 10;
  });
}

function fontFor(size: number) {
  return `900 ${size}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
}

interface WrappedLine {
  text: string;
  x: number;
  y: number;
}

interface OverlayLayout {
  lines: WrappedLine[];
  fontSize: number;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
): string[] {
  ctx.font = fontFor(fontSize);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (ctx.measureText(word).width > maxWidth) {
        let piece = "";
        for (const char of word) {
          if (ctx.measureText(piece + char).width <= maxWidth) {
            piece += char;
          } else {
            if (piece) lines.push(piece);
            piece = char;
          }
        }
        current = piece;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function layoutOverlay(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  canvasWidth: number,
  canvasHeight: number,
  placement: HookPlacement = "top",
): OverlayLayout {
  const maxWidth = Math.round(canvasWidth * 0.84);
  const len = rawText.length;
  let baseSize = 64;
  if (len <= 25) baseSize = 76;
  else if (len <= 45) baseSize = 68;
  else if (len <= 80) baseSize = 58;
  else baseSize = 50;

  const scale = canvasWidth / 1080;
  let fontSize = Math.round(baseSize * scale);

  let lines: string[] = [];
  while (fontSize > Math.round(36 * scale)) {
    lines = wrapText(ctx, rawText, maxWidth, fontSize);
    if (lines.length <= 4) break;
    fontSize -= 4;
  }

  ctx.font = fontFor(fontSize);
  const lineHeight = Math.round(fontSize * 1.25);
  const lineGap = Math.round(fontSize * 0.15);
  const totalHeight = lines.length * lineHeight + (lines.length - 1) * lineGap;

  let startY: number;
  if (placement === "top") {
    startY = Math.round(canvasHeight * 0.16);
  } else if (placement === "middle") {
    startY = Math.round((canvasHeight - totalHeight) / 2);
  } else {
    startY = Math.round(canvasHeight * 0.72 - totalHeight);
  }

  const wrapped: WrappedLine[] = [];
  let currentY = startY;

  for (const line of lines) {
    const textX = Math.round(canvasWidth / 2);
    const textY = currentY + Math.round(fontSize * 0.88);

    wrapped.push({
      text: line,
      x: textX,
      y: textY,
    });

    currentY += lineHeight + lineGap;
  }

  return { lines: wrapped, fontSize };
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayLayout,
  fontString: string,
) {
  if (!overlay.lines.length) return;

  ctx.save();
  ctx.font = fontString;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const strokeWidth = Math.max(6, Math.round(overlay.fontSize * 0.16));

  // 1. Thick crisp black outline with subtle shadow
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = "#000000";
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = Math.round(overlay.fontSize * 0.15);
  ctx.shadowOffsetY = Math.round(overlay.fontSize * 0.05);

  for (const line of overlay.lines) {
    ctx.strokeText(line.text, line.x, line.y);
  }

  // 2. Bold white fill on top
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = "#ffffff";

  for (const line of overlay.lines) {
    ctx.fillText(line.text, line.x, line.y);
  }

  ctx.restore();
}

function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "video/webm";
  }
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=h264,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RenderCancelledError();
}

function waitFor(
  el: HTMLVideoElement,
  event: string,
  opts?: { signal?: AbortSignal | undefined; timeoutMs?: number },
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", fail);
      opts?.signal?.removeEventListener("abort", onAbort);
    };

    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const errCode = el.error
        ? ` (code ${el.error.code}: ${el.error.message || "media decode/network error"})`
        : "";
      reject(new Error(`Video failed to ${event}${errCode}. Check clip format or CORS permissions.`));
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RenderCancelledError());
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const errDetail = el.error
        ? ` (media error code ${el.error.code}: ${el.error.message})`
        : ` (readyState: ${el.readyState}, networkState: ${el.networkState})`;
      reject(new Error(`Timed out waiting for the clip to ${event}${errDetail}. Verify the video codec is H.264 MP4.`));
    }, opts?.timeoutMs ?? 45_000);

    if (opts?.signal?.aborted) {
      onAbort();
      return;
    }

    if (
      (event === "loadedmetadata" && el.readyState >= 1) ||
      (event === "loadeddata" && el.readyState >= 2) ||
      (event === "canplay" && el.readyState >= 3) ||
      (event === "seeked" && !el.seeking && el.readyState >= 2)
    ) {
      ok();
      return;
    }

    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", fail, { once: true });
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      el.load();
    } catch {
      /* ignore */
    }
  });
}

async function seekVideo(video: HTMLVideoElement, targetTime: number, signal?: AbortSignal): Promise<void> {
  if (Math.abs(video.currentTime - targetTime) < 0.05) {
    return;
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RenderCancelledError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, 4000);

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      video.currentTime = targetTime;
    } catch {
      cleanup();
      resolve();
    }
  });
}

export async function renderVariant(opts: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const { sourceUrl, durationSeconds, width, height, text, withAudio, soundtrackUrl, signal } = opts;
  throwIfAborted(signal);

  try {
    if (typeof document !== "undefined" && "fonts" in document) {
      await document.fonts.load(fontFor(64));
      await document.fonts.ready;
    }
  } catch {
    /* fallback cleanly */
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = !withAudio;
  video.volume = 1;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;
  try {
    video.load();
  } catch {
    /* ignore */
  }

  await waitFor(video, "loadedmetadata", { signal });

  const sourceDuration = Number.isFinite(video.duration) ? video.duration : durationSeconds;
  const maxStart = Math.max(0, sourceDuration - durationSeconds);
  const start = Math.min(Math.max(0, opts.startSeconds), maxStart);

  await seekVideo(video, start, signal);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const overlay = layoutOverlay(ctx, text.trim() || "…", width, height, opts.placement ?? "top");
  const drawFont = fontFor(overlay.fontSize);

  const drawFrame = () => {
    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (width - dw) / 2;
    const dy = (height - dh) / 2;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    try {
      ctx.drawImage(video, dx, dy, dw, dh);
    } catch {
      // ignore empty frames
    }

    drawOverlay(ctx, overlay, drawFont);
  };

  drawFrame();

  const thumbnail: Blob | undefined = await new Promise((res) => {
    canvas.toBlob((b) => res(b ?? undefined), "image/jpeg", 0.85);
  });

  const fps = 30;
  const canvasStream = canvas.captureStream(fps);

  let audioCtx: AudioContext | null = null;
  let soundtrackElement: HTMLAudioElement | null = null;
  const audioTracks: MediaStreamTrack[] = [];

  const cleanupAudio = () => {
    try {
      soundtrackElement?.pause();
      if (soundtrackElement) soundtrackElement.src = "";
    } catch {
      /* ignore */
    }
    try {
      if (audioCtx && audioCtx.state !== "closed") {
        void audioCtx.close();
      }
    } catch {
      /* ignore */
    }
  };

  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    if (AudioContextClass && (withAudio || soundtrackUrl)) {
      audioCtx = new AudioContextClass();
      const dest = audioCtx.createMediaStreamDestination();
      let hasSource = false;

      if (withAudio) {
        try {
          const videoSource = audioCtx.createMediaElementSource(video);
          videoSource.connect(dest);
          hasSource = true;
        } catch (e) {
          console.warn("Could not capture video audio source", e);
        }
      }

      if (soundtrackUrl) {
        try {
          const audio = new Audio();
          audio.crossOrigin = "anonymous";
          audio.preload = "auto";
          audio.src = soundtrackUrl;
          audio.volume = Math.max(0, Math.min(1, opts.soundtrackVolume ?? 1));
          soundtrackElement = audio;

          await new Promise<void>((resolve, reject) => {
            const ok = () => {
              cleanup();
              resolve();
            };
            const fail = () => {
              cleanup();
              reject(new Error("Failed to load soundtrack."));
            };
            const timeout = setTimeout(() => {
              cleanup();
              reject(new Error("Timed out loading soundtrack."));
            }, 20_000);
            const cleanup = () => {
              clearTimeout(timeout);
              audio.removeEventListener("canplaythrough", ok);
              audio.removeEventListener("error", fail);
            };
            audio.addEventListener("canplaythrough", ok, { once: true });
            audio.addEventListener("error", fail, { once: true });
            try {
              audio.load();
            } catch {
              /* ignore */
            }
          });

          audio.currentTime = 0;
          const trackSource = audioCtx.createMediaElementSource(audio);
          trackSource.connect(dest);
          hasSource = true;
        } catch (soundtrackErr) {
          console.warn("Could not bind soundtrack track; proceeding without it:", soundtrackErr);
        }
      }

      if (hasSource) {
        dest.stream.getAudioTracks().forEach((t) => audioTracks.push(t));
      }
    }
  } catch (err) {
    console.warn("Audio pipeline init failed; rendering video-only stream:", err);
  }

  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioTracks,
  ]);

  const mimeType = pickSupportedMimeType();
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const endSeconds = start + durationSeconds;
  const intervalMs = 1000 / fps;

  return new Promise<BrowserRenderResult>((resolve, reject) => {
    let timer: number | null = null;
    let stopped = false;

    const stop = async (err?: Error) => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      cleanupAudio();

      if (recorder.state !== "inactive") {
        recorder.onstop = () => {
          if (err) {
            reject(err);
          } else {
            const blob = new Blob(chunks, { type: mimeType });
            resolve({ blob, extension, mimeType, thumbnail });
          }
        };
        try {
          recorder.stop();
        } catch (recStopErr) {
          if (err) reject(err);
          else reject(recStopErr as Error);
        }
      } else if (err) {
        reject(err);
      } else {
        const blob = new Blob(chunks, { type: mimeType });
        resolve({ blob, extension, mimeType, thumbnail });
      }
    };

    recorder.onerror = () => stop(new Error("MediaRecorder reported an error."));

    if (signal) {
      if (signal.aborted) {
        stop(new RenderCancelledError());
        return;
      }
      signal.addEventListener("abort", () => stop(new RenderCancelledError()), { once: true });
    }

    try {
      recorder.start(100);
    } catch (e) {
      stop(e as Error);
      return;
    }

    if (audioCtx && audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    if (soundtrackElement) {
      soundtrackElement.currentTime = 0;
      void soundtrackElement.play().catch(() => {});
    }

    video.play().catch((playErr) => stop(playErr as Error));

    timer = window.setInterval(() => {
      if (signal?.aborted) {
        stop(new RenderCancelledError());
        return;
      }

      drawFrame();

      const elapsed = Math.max(0, video.currentTime - start);
      const progress = Math.min(100, Math.round((elapsed / durationSeconds) * 100));
      opts.onProgress?.(progress);

      if (video.currentTime >= endSeconds || video.ended) {
        stop();
      }
    }, intervalMs);
  });
}
