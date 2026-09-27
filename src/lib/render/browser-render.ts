/**
 * Browser-side deterministic renderer.
 *
 * Draws the source clip into a 1080x1920 canvas (cover crop), burns the hook
 * text in as heavy white type with a strong black outline — TikTok caption
 * style, no background box — inside the placement zone chosen for the clip,
 * and records exactly `durationSeconds` of output via MediaRecorder.
 *
 * The overlay is composited into every recorded frame, so the hook is
 * physically present in the exported file — not drawn by the UI player.
 */

export type HookPlacement = "top" | "middle" | "bottom";

export type BrowserRenderOptions = {
  sourceUrl: string;
  startSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
  text: string;
  placement?: HookPlacement;
  fontSize?: number;
  /** Keep the clip's original audio in the exported file. */
  withAudio?: boolean;
  /** Fully-resolved, CORS-readable URL of a soundtrack to bake into the export. */
  soundtrackUrl?: string | undefined;
  /** Soundtrack level, 0..1 (defaults to 1). */
  soundtrackVolume?: number | undefined;
  onProgress?: (pct: number) => void;
  /** Abort the render early — used for user-initiated cancellation. */
  signal?: AbortSignal | undefined;
};


/** Thrown when a render is stopped via its AbortSignal, so callers can tell
 *  a user cancellation apart from a genuine render failure. */
export class RenderCancelledError extends Error {
  constructor() {
    super("Render cancelled.");
    this.name = "RenderCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RenderCancelledError();
}

/**
 * Route a video element's audio into a recordable stream WITHOUT sending it to
 * the speakers (we never connect to ctx.destination, so the preview stays silent).
 */
export function attachAudioTrack(video: HTMLVideoElement, stream: MediaStream) {
  const Ctor: typeof AudioContext | undefined =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createMediaElementSource(video);
    source.connect(dest);
    const audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) stream.addTrack(audioTrack);
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Mix several media elements (clip audio + a chosen soundtrack) into ONE audio
 * track on the recorded stream. Nothing is connected to ctx.destination, so the
 * render stays silent for the person watching it happen.
 */
export function attachAudioSources(
  stream: MediaStream,
  sources: { el: HTMLMediaElement; volume?: number }[],
) {
  if (sources.length === 0) return null;
  const Ctor: typeof AudioContext | undefined =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    const ctx = new Ctor();
    const dest = ctx.createMediaStreamDestination();
    for (const { el, volume } of sources) {
      const node = ctx.createMediaElementSource(el);
      if (volume !== undefined && volume !== 1) {
        const gain = ctx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, volume));
        node.connect(gain);
        gain.connect(dest);
      } else {
        node.connect(dest);
      }
    }
    const audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) stream.addTrack(audioTrack);
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Load a soundtrack ready for recording. It loops, so a short sound covers a
 * longer edit, and it is never routed to the speakers.
 */
export async function prepareSoundtrack(url: string, signal?: AbortSignal) {
  const audio = document.createElement("audio");
  audio.crossOrigin = "anonymous";
  audio.loop = true;
  audio.preload = "auto";
  audio.src = url;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", ok);
      audio.removeEventListener("error", fail);
      signal?.removeEventListener("abort", onAbort);
    };
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("The selected sound could not be loaded."));
    };
    const onAbort = () => {
      cleanup();
      reject(new RenderCancelledError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out loading the selected sound."));
    }, 30_000);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    audio.addEventListener("loadedmetadata", ok, { once: true });
    audio.addEventListener("error", fail, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  audio.currentTime = 0;
  return audio;
}



export type BrowserRenderResult = {
  blob: Blob;
  extension: string;
  mimeType: string;
  thumbnail: Blob | null;
};

/**
 * Normalized 9:16 safe zones, measured against the platform UI:
 * the top bar / following-for-you tabs, the right-hand interaction rail and
 * the bottom caption + progress bar area.
 */
export const SAFE_ZONES: Record<HookPlacement, { top: number; bottom: number; width: number }> = {
  top: { top: 0.12, bottom: 0.32, width: 0.8 },
  middle: { top: 0.38, bottom: 0.62, width: 0.8 },
  bottom: { top: 0.6, bottom: 0.78, width: 0.72 },
};

export function pickMimeType(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}

export function fontFor(size: number) {
  return `900 ${size}px "Inter", "Helvetica Neue", system-ui, -apple-system, "Segoe UI", sans-serif`;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Lay the hook out as ONE cohesive centered text block at natural TikTok
 * caption scale, shrinking until it fits entirely inside its safe zone.
 */
export function layoutOverlay(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
  placement: HookPlacement,
) {
  const zone = SAFE_ZONES[placement];
  // Leave real headroom below the nominal max width/height instead of running
  // flush against the limit. Font metrics for the same font string can differ
  // by a pixel or two across browsers/GPUs/font-rendering backends, so a wrap
  // decision that just barely fits in one environment can just barely NOT fit
  // in another — producing a different line count/break for identical input
  // text. A consistent margin means small measurement variance never flips
  // the outcome.
  const WIDTH_MARGIN = 0.94;
  const maxTextWidth = Math.round(width * zone.width * WIDTH_MARGIN);
  const zoneTop = Math.round(height * zone.top);
  const zoneBottom = Math.round(height * zone.bottom);
  const maxBlockHeight = zoneBottom - zoneTop;
  const minSize = 26;

  // Natural caption scale: modest to begin with, smaller as the hook grows.
  const chars = text.trim().length;
  const startRatio = chars <= 40 ? 0.056 : chars <= 90 ? 0.05 : 0.045;
  let size = Math.max(minSize, Math.round(width * startRatio));
  let lines: string[] = [];
  let lineHeight = Math.round(size * 1.16);

  for (;;) {
    ctx.font = fontFor(size);
    lines = wrapLines(ctx, text, maxTextWidth);
    lineHeight = Math.round(size * 1.16);
    const total = lines.length * lineHeight;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
    if ((total <= maxBlockHeight && widest <= maxTextWidth) || size <= minSize) break;
    size -= 2;
  }

  const blockHeight = lines.length * lineHeight;
  // Center the block vertically inside its own zone; never overflow it.
  const blockTop = Math.max(zoneTop, zoneTop + Math.round((maxBlockHeight - blockHeight) / 2));

  return { size, lines, lineHeight, blockTop, strokeWidth: Math.max(6, Math.round(size * 0.18)) };
}


export function waitFor(
  el: HTMLVideoElement,
  event: string,
  opts?: { signal?: AbortSignal | undefined; timeoutMs?: number },
) {
  return new Promise<void>((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`Video failed to ${event}.`));
    };
    // A cancel must interrupt loading/seeking too — otherwise the UI sits on
    // "loading" while a stalled network fetch never settles.
    const onAbort = () => {
      cleanup();
      reject(new RenderCancelledError());
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for the clip to ${event}.`));
    }, opts?.timeoutMs ?? 45_000);
    const cleanup = () => {
      clearTimeout(timeout);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", fail);
      opts?.signal?.removeEventListener("abort", onAbort);
    };
    if (opts?.signal?.aborted) {
      onAbort();
      return;
    }
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", fail, { once: true });
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
  });
}



export async function renderVariant(opts: BrowserRenderOptions): Promise<BrowserRenderResult> {
  const { sourceUrl, durationSeconds, width, height, text, withAudio, soundtrackUrl, signal } = opts;
  throwIfAborted(signal);

  // layoutOverlay measures text to decide wrapping and font size, and
  // drawFrame paints with the same font string — but if the "Inter" webfont
  // hasn't actually finished loading yet, the canvas silently measures with
  // a narrower fallback font while still painting with the real (wider,
  // heavier) one once it loads. That mismatch lets a word fit during
  // wrapping that no longer fits once actually drawn, so the last line can
  // end up wider than intended and push off-center toward the right edge.
  // Loading the exact weight/family string used for rendering first, and
  // waiting on `document.fonts.ready`, guarantees measurement and drawing
  // both use the real metrics.
  try {
    if (typeof document !== "undefined" && "fonts" in document) {
      await document.fonts.load(fontFor(64));
      await document.fonts.ready;
    }
  } catch {
    // If font loading APIs aren't available/throw, fall back to whatever
    // font is already resolved rather than blocking the render.
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = !withAudio;
  video.volume = 1;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;

  await waitFor(video, "loadedmetadata");

  const sourceDuration = Number.isFinite(video.duration) ? video.duration : durationSeconds;
  const maxStart = Math.max(0, sourceDuration - durationSeconds);
  const start = Math.min(Math.max(0, opts.startSeconds), maxStart);

  video.currentTime = start;
  await waitFor(video, "seeked");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const overlay = layoutOverlay(ctx, text.trim() || "…", width, height, opts.placement ?? "top");

  // Resolve the final draw font ONCE (not per frame) and anchor every line to
  // the same fixed center X of the block.
  //
  // Why not textAlign="center": canvas centers a line on its *advance width*.
  // For lines containing emoji / ZWJ sequences (and some fallback-font glyphs)
  // the painted ink is not symmetric around the advance box, so such a line —
  // typically the short final one — ends up visibly offset from the lines
  // above. Measuring the ink box (actualBoundingBoxLeft/Right) and drawing
  // left-aligned at an x derived from the SAME centerX makes every line share
  // one center axis regardless of its glyphs or width.
  const centerX = Math.round(width / 2);
  const hardMaxWidth = width - 40;
  let drawSize = overlay.size;
  let font = fontFor(drawSize);
  ctx.font = font;
  while (Math.max(...overlay.lines.map((l) => ctx.measureText(l).width), 0) > hardMaxWidth && drawSize > 20) {
    drawSize -= 2;
    font = fontFor(drawSize);
    ctx.font = font;
  }
  const drawLineHeight = Math.round(drawSize * 1.16);
  const drawLines = overlay.lines.map((line) => {
    const m = ctx.measureText(line);
    const inkLeft = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : m.width / 2;
    const inkRight = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width / 2;
    // Ink spans [-inkLeft, inkRight] around the draw origin; shift so the ink
    // midpoint lands exactly on centerX.
    return { text: line, x: centerX - (inkRight - inkLeft) / 2 };
  });


  const mimeType = pickMimeType();
  const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";

  // Manual-frame capture: the canvas emits a frame only when we ask for one,
  // and every emitted frame is timestamped at real wall-clock time. With the
  // old fixed-rate captureStream(30) a slow 1080x1920 draw loop produced far
  // fewer than 30 fps while the muxer still assumed 30 fps, so the whole clip
  // was packed into a short, sped-up file (a 7s source came out ~2s).
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const manualFrames = typeof track?.requestFrame === "function";
  const captureStreamToUse = manualFrames ? stream : canvas.captureStream(30);
  // Sound baked into the file: the chosen soundtrack (and the clip's own audio
  // when the user kept it) are mixed into one recorded audio track.
  const soundtrack = soundtrackUrl ? await prepareSoundtrack(soundtrackUrl, signal) : null;
  if (soundtrack) soundtrack.volume = 1;
  const audioSources: { el: HTMLMediaElement; volume?: number }[] = [];
  if (withAudio) audioSources.push({ el: video, volume: soundtrack ? 0.35 : 1 });
  if (soundtrack) audioSources.push({ el: soundtrack, volume: opts.soundtrackVolume ?? 1 });
  attachAudioSources(captureStreamToUse, audioSources);

  const recorder = new MediaRecorder(captureStreamToUse, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  function drawFrame() {
    ctx!.fillStyle = "#000000";
    ctx!.fillRect(0, 0, width, height);

    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx!.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);

    // Burn the hook in on every single frame: heavy white type, hard black
    // outline, one cohesive block, every line sharing one center axis.
    ctx!.font = font;
    ctx!.textBaseline = "middle";
    ctx!.textAlign = "left";
    ctx!.lineJoin = "round";
    ctx!.miterLimit = 2;
    ctx!.lineWidth = overlay.strokeWidth;
    ctx!.strokeStyle = "#000000";
    ctx!.fillStyle = "#FFFFFF";
    drawLines.forEach((line, i) => {
      const y = overlay.blockTop + i * drawLineHeight + drawLineHeight / 2;
      ctx!.strokeText(line.text, line.x, y);
      ctx!.fillText(line.text, line.x, y);
    });

    if (manualFrames) track!.requestFrame();
  }


  // Start actual playback first and confirm at least one real video frame has
  // decoded before we open the recorder. Otherwise the first ~200ms chunk can
  // land on a blank/pre-play frame — the export would open on empty video
  // with only the hook text visible for a beat.
  await video.play();
  await new Promise<void>((resolve) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => resolve());
    } else {
      // Fallback for browsers without requestVideoFrameCallback: one rAF
      // after play() is enough for the decoder to have produced a frame.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }
  });

  // Playback keeps running while we wait for that first decoded frame, so by
  // now `currentTime` has drifted past `start` (often several hundred ms).
  // Recording from there both loses the head of the clip AND makes the media
  // hit its end-of-range before the wall-clock budget is spent — a 7s source
  // came out ~6s. Rewind to the exact start offset before opening the
  // recorder: the decoder is warm, so this seek is instant and the first
  // recorded frame is real footage at t=0 of the range.
  video.pause();
  if (Math.abs(video.currentTime - start) > 0.005) {
    video.currentTime = start;
    await waitFor(video, "seeked");
  }
  drawFrame();
  recorder.start(200);
  const startedAt = performance.now();
  if (soundtrack) {
    soundtrack.currentTime = 0;
    await soundtrack.play().catch(() => undefined);
  }
  await video.play();


  try {
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let lastRafAt = performance.now();
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        resolve();
      };
      const cancel = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        reject(new RenderCancelledError());
      };

      const tick = () => {
        if (done) return;
        if (signal?.aborted) {
          cancel();
          return;
        }
        // When the source runs out we keep drawing its final frame so the export
        // is always exactly `durationSeconds` long.
        if (video.ended || video.currentTime >= start + durationSeconds - 0.03) {
          if (!video.paused) video.pause();
        }
        drawFrame();
        const elapsed = (performance.now() - startedAt) / 1000;
        opts.onProgress?.(Math.min(99, Math.round((elapsed / durationSeconds) * 100)));
        if (elapsed >= durationSeconds) finish();
      };
      // requestAnimationFrame is the primary driver — it's tied to real paint
      // timing, so frames come out evenly spaced. The interval is a fallback
      // ONLY: it steps in solely if rAF has gone quiet (a backgrounded tab
      // throttles rAF), so the two never draw/capture the same moment twice.
      const FALLBACK_GAP_MS = 120;
      const timer = setInterval(() => {
        if (done) return;
        if (performance.now() - lastRafAt >= FALLBACK_GAP_MS) {
          tick();
        }
      }, 1000 / 30);
      const raf = () => {
        if (done) return;
        lastRafAt = performance.now();
        tick();
        if (!done) requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  } catch (e) {
    if (recorder.state !== "inactive") recorder.stop();
    captureStreamToUse.getTracks().forEach((t) => t.stop());
    if (captureStreamToUse !== stream) stream.getTracks().forEach((t) => t.stop());
    video.pause();
    video.src = "";
    if (soundtrack) {
      soundtrack.pause();
      soundtrack.src = "";
    }
    throw e;
  }



  // Poster frame (with the overlay already composited) for the result card.
  const thumbnail = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8);
    } catch {
      resolve(null);
    }
  });

  video.pause();
  // Flush whatever is buffered in the current timeslice so the tail of the
  // clip isn't dropped with the final partial chunk.
  if (recorder.state === "recording") recorder.requestData();
  recorder.stop();
  await stopped;

  captureStreamToUse.getTracks().forEach((t) => t.stop());
  if (captureStreamToUse !== stream) stream.getTracks().forEach((t) => t.stop());

  video.src = "";

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) throw new Error("Recorder produced an empty file.");
  return { blob, extension, mimeType, thumbnail };
}

/** Evenly spread N start offsets across a source clip, skipping the first beat. */
export function planStartOffsets(sourceDuration: number, count: number, clipLength: number) {
  const usable = Math.max(0, (sourceDuration || clipLength) - clipLength);
  if (usable <= 0.1) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, i) => Number(((usable * i) / Math.max(1, count - 1)).toFixed(2)));
}
