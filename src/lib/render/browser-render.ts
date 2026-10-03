import {
  calculateFontScale,
  computeOverlayDimensions,
  DEFAULT_VIDEO_CONFIG,
  type FontStyleConfig,
  type VideoResolution,
} from "./types";
import { resolveAudioUrl } from "@/lib/audio-url";

export interface BrowserRenderOptions {
  videoUrl: string;
  hookText?: string | null;
  bodyText?: string | null;
  ctaText?: string | null;
  fontStyle?: FontStyleConfig;
  targetDuration?: number;
  speedMultiplier?: number;
  soundtrackUrl?: string | null;
  soundtrackVolume?: number;
  withAudio?: boolean;
  resolution?: VideoResolution;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface BrowserRenderResult {
  blob: Blob;
  duration: number;
  width: number;
  height: number;
  format: "mp4" | "webm";
}

const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickSupportedMimeType(): { mimeType: string; format: "mp4" | "webm" } {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not supported in this browser.");
  }
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return {
        mimeType: mime,
        format: mime.startsWith("video/mp4") ? "mp4" : "webm",
      };
    }
  }
  throw new Error("No supported video MIME type found for MediaRecorder.");
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines = 4,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }
  return lines;
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  text: string,
  opts: {
    currentTime: number;
    totalDuration: number;
    canvasWidth: number;
    canvasHeight: number;
    fontStyle?: FontStyleConfig;
    role: "hook" | "body" | "cta";
  },
) {
  const { currentTime, totalDuration, canvasWidth, canvasHeight, fontStyle, role } = opts;
  const config = fontStyle || {};

  let startTime = 0;
  let endTime = totalDuration;

  if (role === "hook") {
    startTime = 0;
    endTime = Math.min(totalDuration, config.hookDuration ?? DEFAULT_VIDEO_CONFIG.hookDuration);
  } else if (role === "body") {
    startTime = config.hookDuration ?? DEFAULT_VIDEO_CONFIG.hookDuration;
    endTime = Math.max(startTime, totalDuration - (config.ctaDuration ?? DEFAULT_VIDEO_CONFIG.ctaDuration));
  } else if (role === "cta") {
    endTime = totalDuration;
    startTime = Math.max(0, totalDuration - (config.ctaDuration ?? DEFAULT_VIDEO_CONFIG.ctaDuration));
  }

  if (currentTime < startTime || currentTime > endTime) {
    return;
  }

  const { maxWidth, paddingHorizontal } = computeOverlayDimensions(canvasWidth, canvasHeight);
  const scale = calculateFontScale(canvasWidth, canvasHeight);

  const rawSize =
    role === "hook"
      ? config.fontSizeHook ?? 54
      : role === "cta"
      ? config.fontSizeCta ?? 44
      : config.fontSizeBody ?? 38;

  const fontSize = Math.round(rawSize * scale);
  const lineHeight = Math.round(fontSize * 1.2);
  const fontFamily = config.fontFamily || "Inter, -apple-system, sans-serif";
  const fontWeight = config.fontWeight || "800";
  const textColor = config.textColor || "#FFFFFF";
  const strokeColor = config.strokeColor || "#000000";
  const strokeWidth = Math.round(Math.max(2, fontSize * 0.12));
  const textTransform = config.textTransform || (role === "hook" ? "uppercase" : "none");
  const position = config.position || "middle";

  ctx.save();
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let displayText = text;
  if (textTransform === "uppercase") displayText = text.toUpperCase();
  else if (textTransform === "lowercase") displayText = text.toLowerCase();

  const lines = wrapText(ctx, displayText, maxWidth, role === "hook" ? 3 : 4);
  if (lines.length === 0) {
    ctx.restore();
    return;
  }

  const totalTextHeight = lines.length * lineHeight;
  let blockCenterY: number;

  switch (position) {
    case "top":
      blockCenterY = canvasHeight * 0.22;
      break;
    case "bottom":
      blockCenterY = canvasHeight * 0.78;
      break;
    case "middle":
    default:
      blockCenterY = canvasHeight * 0.45;
      break;
  }

  const firstLineY = blockCenterY - totalTextHeight / 2 + lineHeight / 2;
  const centerX = canvasWidth / 2;

  lines.forEach((line, index) => {
    const y = firstLineY + index * lineHeight;

    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.strokeText(line, centerX, y);

    ctx.fillStyle = textColor;
    ctx.fillText(line, centerX, y);
  });

  ctx.restore();
}

async function seekVideo(video: HTMLVideoElement, targetTime: number, signal?: AbortSignal): Promise<void> {
  if (Math.abs(video.currentTime - targetTime) < 0.05) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let timeout: any = null;

    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      if (timeout) clearTimeout(timeout);
    };

    const onSeeked = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(`Video seek error at target time ${targetTime}`));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 4000);

    if (signal?.aborted) {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    try {
      video.currentTime = targetTime;
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

function waitFor(
  target: EventTarget,
  event: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let timeout: any = null;
    const cleanup = () => {
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (e: any) => {
      cleanup();
      let detail = "Media element error";
      if (target instanceof HTMLVideoElement && target.error) {
        detail = `${detail} (code ${target.error.code}: ${target.error.message || "playback failed"})`;
      }
      reject(new Error(detail));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timeout = setTimeout(() => {
      cleanup();
      let state = "";
      if (target instanceof HTMLVideoElement) {
        state = ` (readyState: ${target.readyState}, networkState: ${target.networkState})`;
      }
      reject(new Error(`Timed out waiting for ${event}${state}. Verify video codec is H.264 MP4.`));
    }, timeoutMs);
  });
}

export async function renderVariant(opts: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const {
    videoUrl,
    hookText,
    bodyText,
    ctaText,
    fontStyle,
    targetDuration,
    speedMultiplier = 1,
    soundtrackVolume = 1,
    withAudio = false,
    resolution = { width: 1080, height: 1920, fps: 30, bitrate: 8_000_000 },
    onProgress,
    signal,
  } = opts;

  let soundtrackUrl: string | null = null;
  if (opts.soundtrackUrl) {
    try {
      soundtrackUrl = await resolveAudioUrl(opts.soundtrackUrl);
    } catch (e) {
      console.warn("Failed to resolve soundtrack URL, proceeding without:", e);
    }
  }

  const { mimeType, format } = pickSupportedMimeType();

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.playsInline = true;
  video.preload = "auto";
  video.src = videoUrl;

  try {
    video.load();
  } catch {
    /* ignore */
  }

  const canvas = document.createElement("canvas");
  canvas.width = resolution.width;
  canvas.height = resolution.height;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) {
    throw new Error("Could not acquire 2D canvas context.");
  }

  await waitFor(video, "loadedmetadata", 30000, signal);

  const naturalDuration = video.duration || 8;
  const desiredDuration =
    targetDuration && targetDuration > 0
      ? Math.min(targetDuration, naturalDuration / Math.max(0.25, speedMultiplier))
      : naturalDuration / Math.max(0.25, speedMultiplier);

  const effectiveDuration = Math.max(1, desiredDuration);
  video.playbackRate = Math.max(0.25, Math.min(4, speedMultiplier));

  await seekVideo(video, 0, signal);

  let stream: MediaStream;
  const canvasStream = canvas.captureStream ? canvas.captureStream(resolution.fps) : null;
  if (!canvasStream) {
    throw new Error("HTMLCanvasElement.captureStream is not supported.");
  }

  let soundtrackElement: HTMLAudioElement | null = null;
  let audioCtx: AudioContext | null = null;
  const audioTracks: MediaStreamTrack[] = [];

  const cleanupAudio = () => {
    if (soundtrackElement) {
      try {
        soundtrackElement.pause();
        soundtrackElement.src = "";
      } catch {
        /* ignore */
      }
      soundtrackElement = null;
    }
    if (audioCtx && audioCtx.state !== "closed") {
      void audioCtx.close();
      audioCtx = null;
    }
  };

  video.muted = !withAudio;

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

  stream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioTracks,
  ]);

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: resolution.bitrate,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  return new Promise<BrowserRenderResult>((resolve, reject) => {
    let animId: number | null = null;
    let startTime = 0;
    let isFinished = false;

    const stop = (err?: Error) => {
      if (isFinished) return;
      isFinished = true;
      if (animId !== null) cancelAnimationFrame(animId);
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      cleanupAudio();
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      if (err) {
        reject(err);
      }
    };

    if (signal) {
      signal.addEventListener(
        "abort",
        () => stop(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }

    recorder.onerror = (e: any) => {
      stop(new Error(`MediaRecorder error: ${e?.error?.message || "unknown"}`));
    };

    recorder.onstop = () => {
      try {
        const blob = new Blob(chunks, { type: mimeType });
        resolve({
          blob,
          duration: effectiveDuration,
          width: resolution.width,
          height: resolution.height,
          format,
        });
      } catch (e) {
        reject(e as Error);
      }
    };

    const drawFrame = () => {
      if (isFinished) return;
      const now = performance.now();
      const elapsed = (now - startTime) / 1000;

      if (elapsed >= effectiveDuration) {
        stop();
        return;
      }

      const vw = video.videoWidth || resolution.width;
      const vh = video.videoHeight || resolution.height;
      const scale = Math.max(resolution.width / vw, resolution.height / vh);
      const drawW = vw * scale;
      const drawH = vh * scale;
      const offsetX = (resolution.width - drawW) / 2;
      const offsetY = (resolution.height - drawH) / 2;

      ctx.drawImage(video, offsetX, offsetY, drawW, drawH);

      if (hookText) {
        drawOverlay(ctx, hookText, {
          currentTime: elapsed,
          totalDuration: effectiveDuration,
          canvasWidth: resolution.width,
          canvasHeight: resolution.height,
          fontStyle,
          role: "hook",
        });
      }
      if (bodyText) {
        drawOverlay(ctx, bodyText, {
          currentTime: elapsed,
          totalDuration: effectiveDuration,
          canvasWidth: resolution.width,
          canvasHeight: resolution.height,
          fontStyle,
          role: "body",
        });
      }
      if (ctaText) {
        drawOverlay(ctx, ctaText, {
          currentTime: elapsed,
          totalDuration: effectiveDuration,
          canvasWidth: resolution.width,
          canvasHeight: resolution.height,
          fontStyle,
          role: "cta",
        });
      }

      if (onProgress) {
        onProgress(Math.min(0.99, elapsed / effectiveDuration));
      }

      animId = requestAnimationFrame(drawFrame);
    };

    try {
      recorder.start(100);
      startTime = performance.now();
    } catch (recErr) {
      stop(recErr as Error);
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
    animId = requestAnimationFrame(drawFrame);
  });
}
