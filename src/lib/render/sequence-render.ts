import {
  planStartOffsets,
  RenderCancelledError,
  type HookPlacement,
  type SeekOptions,
} from "./browser-render";

export { RenderCancelledError };
export type { HookPlacement, SeekOptions };
export { planStartOffsets };

export interface SequenceSegment {
  clipId?: string | undefined | undefined;
  url: string;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  role?: "start" | "middle" | "end" | string | undefined;
  zoom?: number | undefined;
}

export interface SequenceRenderOptions {
  segments: SequenceSegment[];
  durationSeconds?: number | undefined | undefined;
  width: number;
  height: number;
  text: string;
  placement?: HookPlacement | undefined;
  fontSize?: number | undefined;
  textColor?: string | undefined;
  backgroundColor?: string | undefined;
  withAudio?: boolean | undefined;
  soundtrackUrl?: string | null | undefined | undefined;
  soundtrackVolume?: number | undefined;
  onProgress?: (percent: number) => void | undefined;
  signal?: AbortSignal | undefined;
}

export interface SequenceRenderResult {
  blob: Blob;
  extension: string;
  mimeType: string;
  thumbnail?: Blob | undefined | undefined;
  actualDuration: number;
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

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RenderCancelledError();
}

function waitFor(
  el: HTMLMediaElement,
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
        ? ` (code ${el.error.code}: ${el.error.message || "media decode error"})`
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
      (event === "seeked" && !("seeking" in el && (el as HTMLVideoElement).seeking) && el.readyState >= 2)
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

interface PreparedSegment {
  video: HTMLVideoElement;
  sourceStart: number;
  sourceEnd: number;
  outputDuration: number;
  speed: number;
  zoom: number;
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

async function prepareVideo(seg: SequenceSegment, withAudio: boolean, signal?: AbortSignal): Promise<PreparedSegment> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = !withAudio;
  video.volume = 1;
  video.playsInline = true;
  video.preload = "auto";
  video.src = seg.url;
  try {
    video.load();
  } catch {
    /* ignore */
  }

  try {
    await waitFor(video, "loadedmetadata", { signal });
    const realDuration = Number.isFinite(video.duration) ? video.duration : seg.sourceOut;
    const start = Math.max(0, Math.min(seg.sourceIn, Math.max(0, realDuration - 0.05)));
    
    await seekVideo(video, start, signal);

    const rate = Math.max(0.25, Math.min(4, seg.speed || 1));
    video.playbackRate = rate;
    const end = Math.max(start + 0.05, Math.min(seg.sourceOut, realDuration));
    const outputDuration = Math.max(0.2, (end - start) / rate);

    return {
      video,
      sourceStart: start,
      sourceEnd: end,
      outputDuration,
      speed: rate,
      zoom: seg.zoom ?? 1,
    };
  } catch (err) {
    try {
      video.pause();
      video.src = "";
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function renderSequence(opts: SequenceRenderOptions): Promise<SequenceRenderResult> {
  const { segments, width, height, text, withAudio, soundtrackUrl, signal } = opts;
  throwIfAborted(signal);

  if (!segments.length) {
    throw new Error("Cannot render an empty sequence: 0 segments provided.");
  }

  try {
    if (typeof document !== "undefined" && "fonts" in document) {
      await document.fonts.load(fontFor(64));
      await document.fonts.ready;
    }
  } catch {
    /* fallback cleanly */
  }

  const prepared: PreparedSegment[] = [];
  for (const seg of segments) {
    throwIfAborted(signal);
    const p = await prepareVideo(seg, withAudio ?? false, signal);
    prepared.push(p);
  }

  const plannedTotal = prepared.reduce((sum, p) => sum + p.outputDuration, 0);
  const targetDuration = Math.max(1, opts.durationSeconds || plannedTotal);
  const totalDuration = Math.min(plannedTotal, targetDuration);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    prepared.forEach((p) => {
      p.video.src = "";
    });
    throw new Error("Canvas 2D context is not available.");
  }

  const overlay = layoutOverlay(ctx, text.trim() || "…", width, height, opts.placement ?? "top");
  const drawFont = fontFor(overlay.fontSize);

  const drawCurrentFrame = (currentSeg: PreparedSegment) => {
    const v = currentSeg.video;
    const vw = v.videoWidth || width;
    const vh = v.videoHeight || height;

    const baseScale = Math.max(width / vw, height / vh);
    const zoomScale = baseScale * (currentSeg.zoom || 1);
    const dw = vw * zoomScale;
    const dh = vh * zoomScale;
    const dx = (width - dw) / 2;
    const dy = (height - dw) / 2;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    try {
      ctx.drawImage(v, dx, dy, dw, dh);
    } catch {
      /* ignore empty frame */
    }

    drawOverlay(ctx, overlay, drawFont);
  };

  drawCurrentFrame(prepared[0]!);

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

    if (AudioContextClass && soundtrackUrl) {
      audioCtx = new AudioContextClass();
      const dest = audioCtx.createMediaStreamDestination();
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
      dest.stream.getAudioTracks().forEach((t) => audioTracks.push(t));
    }
  } catch (err) {
    console.warn("Sequence audio setup failed:", err);
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

  const intervalMs = 1000 / fps;

  return new Promise<SequenceRenderResult>((resolve, reject) => {
    let timer: number | null = null;
    let stopped = false;
    let segIdx = 0;
    let segStartWallTime = 0;
    let totalElapsedWallTime = 0;

    const stop = (err?: Error) => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearInterval(timer);

      prepared.forEach((p) => {
        try {
          p.video.pause();
          p.video.src = "";
        } catch {
          /* ignore */
        }
      });
      cleanupAudio();

      if (recorder.state !== "inactive") {
        recorder.onstop = () => {
          if (err) {
            reject(err);
          } else {
            const blob = new Blob(chunks, { type: mimeType });
            resolve({ blob, extension, mimeType, thumbnail, actualDuration: totalElapsedWallTime });
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
        resolve({ blob, extension, mimeType, thumbnail, actualDuration: totalElapsedWallTime });
      }
    };

    recorder.onerror = () => stop(new Error("MediaRecorder encountered an error."));

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

    let active = prepared[0]!;
    active.video.currentTime = active.sourceStart;
    active.video.playbackRate = active.speed;
    active.video.play().catch((e) => stop(e as Error));

    segStartWallTime = performance.now();
    const renderStartWallTime = segStartWallTime;

    timer = window.setInterval(() => {
      if (signal?.aborted) {
        stop(new RenderCancelledError());
        return;
      }

      const now = performance.now();
      totalElapsedWallTime = (now - renderStartWallTime) / 1000;
      const segElapsed = (now - segStartWallTime) / 1000;

      drawCurrentFrame(active);

      const progress = Math.min(100, Math.round((totalElapsedWallTime / totalDuration) * 100));
      opts.onProgress?.(progress);

      const hitDuration = totalElapsedWallTime >= totalDuration;
      const segFinished =
        segElapsed >= active.outputDuration ||
        active.video.currentTime >= active.sourceEnd ||
        active.video.ended;

      if (hitDuration) {
        stop();
        return;
      }

      if (segFinished) {
        try {
          active.video.pause();
        } catch {
          /* ignore */
        }

        segIdx++;
        if (segIdx >= prepared.length) {
          stop();
          return;
        }

        active = prepared[segIdx]!;
        active.video.currentTime = active.sourceStart;
        active.video.playbackRate = active.speed;
        segStartWallTime = performance.now();
        active.video.play().catch((e) => stop(e as Error));
      }
    }, intervalMs);
  });
}
