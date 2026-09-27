/**
 * Clip DNA sequence renderer.
 *
 * Plays an ordered list of segments (each a cut of a different source clip, at
 * that clip's chosen speed) back-to-back into ONE canvas + ONE MediaRecorder,
 * producing a single continuous export.
 *
 * Hook rule for DNA renders: the hook is burned in ONLY over the FIRST segment,
 * using the placement frozen on the recipe. Later segments carry no overlay.
 * The standalone single-clip path (renderVariant) is untouched.
 */

import {
  attachAudioSources,
  fontFor,
  layoutOverlay,
  pickMimeType,
  prepareSoundtrack,
  waitFor,
  RenderCancelledError,
  type BrowserRenderResult,
  type HookPlacement,
} from "./browser-render";

export type SequenceSegment = {
  /** Playable URL for this segment's source clip. */
  url: string;
  /** Cut boundaries in the ORIGINAL clip timeline (seconds). */
  sourceIn: number;
  sourceOut: number;
  /** Playback speed; output_duration = (sourceOut - sourceIn) / speed. */
  speed: number;
  /** Wall-clock length of this segment in the export. */
  outputDuration: number;
};

export type SequenceRenderOptions = {
  segments: SequenceSegment[];
  width: number;
  height: number;
  /** Hook text — drawn over the first segment only. */
  text: string;
  placement?: HookPlacement;
  withAudio?: boolean;
  /** Fully-resolved, CORS-readable URL of a soundtrack to bake into the export. */
  soundtrackUrl?: string | undefined;
  /** Soundtrack level, 0..1 (defaults to 1). */
  soundtrackVolume?: number | undefined;
  onProgress?: (pct: number) => void;

  /** Abort the render early — used for user-initiated cancellation. Checked
   *  between segments and inside the per-segment frame loop so a cancel
   *  actually stops within a second, not at the end of the current segment. */
  signal?: AbortSignal | undefined;
};

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new RenderCancelledError();
}

async function prepareVideo(seg: SequenceSegment, withAudio: boolean, signal?: AbortSignal) {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = !withAudio;
  video.volume = 1;
  video.playsInline = true;
  video.preload = "auto";
  video.src = seg.url;
  try {
    await waitFor(video, "loadedmetadata", { signal });
    const realDuration = Number.isFinite(video.duration) ? video.duration : seg.sourceOut;
    // Hard rule: never read past what the clip actually has.
    const start = Math.max(0, Math.min(seg.sourceIn, Math.max(0, realDuration - 0.05)));
    video.currentTime = start;
    await waitFor(video, "seeked", { signal });
    const rate = Math.max(0.25, Math.min(4, seg.speed || 1));
    video.playbackRate = rate;
    // Freeze-frame guard: the solver's cut can ask for more footage than the
    // file actually holds (metadata duration vs. planned duration), and the
    // old loop then held the LAST decoded frame for the leftover wall-clock
    // time — that's exactly the frozen tail the user is seeing. Clamp the cut
    // to real footage and shrink this segment's output length to match, so
    // every recorded frame comes from real playback.
    const end = Math.max(start + 0.05, Math.min(seg.sourceOut, realDuration));
    const outputDuration = Math.max(0.2, (end - start) / rate);
    return { video, start, end, outputDuration };
  } catch (e) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    throw e;
  }
}

export async function renderSequence(opts: SequenceRenderOptions): Promise<BrowserRenderResult> {
  const { segments, width, height, text, withAudio, signal } = opts;
  if (segments.length === 0) throw new Error("No segments to render.");
  throwIfAborted(signal);

  try {
    if (typeof document !== "undefined" && "fonts" in document) {
      await document.fonts.load(fontFor(64));
      await document.fonts.ready;
    }
  } catch {
    /* fall back to resolved fonts */
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  // ---- Hook layout (first segment only) -----------------------------------
  const overlay = layoutOverlay(ctx, text.trim() || "…", width, height, opts.placement ?? "top");
  const centerX = Math.round(width / 2);
  const hardMaxWidth = width - 40;
  let drawSize = overlay.size;
  let font = fontFor(drawSize);
  ctx.font = font;
  while (
    Math.max(...overlay.lines.map((l) => ctx.measureText(l).width), 0) > hardMaxWidth &&
    drawSize > 20
  ) {
    drawSize -= 2;
    font = fontFor(drawSize);
    ctx.font = font;
  }
  const drawLineHeight = Math.round(drawSize * 1.16);
  const drawLines = overlay.lines.map((line) => {
    const m = ctx.measureText(line);
    const inkLeft = Number.isFinite(m.actualBoundingBoxLeft)
      ? m.actualBoundingBoxLeft
      : m.width / 2;
    const inkRight = Number.isFinite(m.actualBoundingBoxRight)
      ? m.actualBoundingBoxRight
      : m.width / 2;
    return { text: line, x: centerX - (inkRight - inkLeft) / 2 };
  });

  // ---- Recorder ------------------------------------------------------------
  const mimeType = pickMimeType();
  const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const manualFrames = typeof track?.requestFrame === "function";
  const captureStream = manualFrames ? stream : canvas.captureStream(30);

  // Real total is only known after the clips report their true durations
  // (see prepareVideo) — computed below from the clamped segment lengths.

  // Load every segment's video up front so cuts are instant (no black gap
  // between them) and so all audio sources can be wired before recording
  // starts — tracks added to a stream after MediaRecorder.start() are not
  // captured. Loading them CONCURRENTLY (not one after another) matters: a
  // DNA render can combine 2-3 full clips, and loading them sequentially
  // meant the wait before any recording (or progress feedback) even began
  // was the SUM of every clip's load time — which looked exactly like a
  // stall, especially on a slower connection. Concurrent loading cuts that
  // wait down to roughly the slowest single clip instead.
  opts.onProgress?.(0);
  const prepared = await Promise.all(
    segments.map(async (seg) => {
      const p = await prepareVideo(seg, !!withAudio, signal);
      return { ...p, seg };
    }),
  );

  const totalDuration = prepared.reduce((s, p) => s + p.outputDuration, 0);

  throwIfAborted(signal);

  // Same mixing approach as the single-clip renderer: every prepared clip's
  // own audio (when kept) plus the chosen soundtrack are mixed into ONE
  // recorded track, all wired up before the recorder starts — a track added
  // to the stream after MediaRecorder.start() is never captured.
  const soundtrack = opts.soundtrackUrl
    ? await prepareSoundtrack(opts.soundtrackUrl, signal)
    : null;
  if (withAudio || soundtrack) {
    const audioSources: { el: HTMLMediaElement; volume?: number }[] = [];
    if (withAudio) {
      for (const p of prepared) {
        audioSources.push({ el: p.video, volume: soundtrack ? 0.35 : 1 });
      }
    }
    if (soundtrack) {
      audioSources.push({ el: soundtrack, volume: opts.soundtrackVolume ?? 1 });
    }
    attachAudioSources(captureStream, audioSources);
  }

  const recorder = new MediaRecorder(captureStream, { mimeType, videoBitsPerSecond: 6_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  let elapsedBefore = 0;
  let currentVideo: HTMLVideoElement = prepared[0]!.video;
  let showHook = true;

  function drawFrame() {
    ctx!.fillStyle = "#000000";
    ctx!.fillRect(0, 0, width, height);
    const vw = currentVideo.videoWidth || width;
    const vh = currentVideo.videoHeight || height;
    const scale = Math.max(width / vw, height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx!.drawImage(currentVideo, (width - dw) / 2, (height - dh) / 2, dw, dh);

    if (showHook) {
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
    }

    if (manualFrames) track!.requestFrame();
  }

  // Warm the first segment's decoder before opening the recorder, otherwise the
  // opening chunk can land on a blank pre-play frame. The wait is capped so a
  // decoder that never produces a frame can't hang the whole render.
  await currentVideo.play();
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    const t = setTimeout(done, 4000);
    const finish = () => {
      clearTimeout(t);
      done();
    };
    if (typeof currentVideo.requestVideoFrameCallback === "function") {
      currentVideo.requestVideoFrameCallback(() => finish());
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => finish()));
    }
  });
  throwIfAborted(signal);
  currentVideo.pause();
  currentVideo.currentTime = prepared[0]!.start;
  await waitFor(currentVideo, "seeked", { signal, timeoutMs: 15_000 });

  drawFrame();
  recorder.start(200);
  if (soundtrack) {
    soundtrack.currentTime = 0;
    await soundtrack.play().catch(() => undefined);
  }

  try {
    for (let index = 0; index < prepared.length; index++) {
      throwIfAborted(signal);
      const { video, start, end, outputDuration } = prepared[index]!;
      currentVideo = video;
      // Hook stays burned in for the WHOLE edit, not just the opening cut.
      showHook = true;

      if (index > 0) {
        video.currentTime = start;
        await waitFor(video, "seeked", { signal, timeoutMs: 15_000 });
      }
      const willWaitForFrame = index > 0;
      await video.play();
      // Some browsers silently reset playbackRate back to 1.0 across a
      // seek+play cycle (video.currentTime = ...; then .play()) even though
      // it was correctly set once in prepareVideo before any of that
      // happened. If that reset occurs, the video plays at normal speed
      // while the stop condition below still expects the INTENDED (faster)
      // rate's timing — video.currentTime then can't keep up with the
      // wall-clock elapsed check, which reads as the segment stalling for a
      // few seconds before it "catches up" and the cut finally registers.
      // Re-asserting it right after play() (and once more after the frame
      // actually confirms decoding, in case the reset happens later than
      // that) removes this as a possible cause entirely.
      const rate = Math.max(0.25, Math.min(4, prepared[index]!.seg.speed || 1));
      video.playbackRate = rate;
      // Wait for a REAL decoded frame before drawing this segment, not just
      // the 'seeked' event — 'seeked' can fire slightly before the browser
      // has actually decoded and is ready to present a frame at that
      // position, which showed up as the segment holding on a stale/black
      // frame for a beat before playback visibly started. This is the same
      // fix already applied to the very first segment below; every segment
      // needs it, not just the opener.
      if (willWaitForFrame) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2000);
          const finish = () => {
            clearTimeout(t);
            resolve();
          };
          if (typeof video.requestVideoFrameCallback === "function") {
            video.requestVideoFrameCallback(() => finish());
          } else {
            requestAnimationFrame(() => requestAnimationFrame(() => finish()));
          }
        });
        throwIfAborted(signal);
      }
      // Captured AFTER the frame-wait so that wait is never silently counted
      // as elapsed segment playback time (it would make the stop condition
      // below fire a bit early relative to what's actually been recorded).
      video.playbackRate = rate;
      console.log("[freeze-debug] segment start", {
        segmentIndex: index,
        rate,
        outputDuration,
        start,
        end,
        actualPlaybackRate: video.playbackRate,
      });
      const segStartedAt = performance.now();

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
          // Defensive: if playbackRate has drifted from the intended value
          // at any point (not just at the initial play() call), correct it
          // immediately. Left uncorrected, the video advances at the wrong
          // speed relative to what the stop condition below expects, which
          // is exactly what produced multi-second-looking stalls before.
          if (Math.abs(video.playbackRate - rate) > 0.01) {
            console.log("[freeze-debug] playbackRate drift corrected", {
              segmentIndex: index,
              expected: rate,
              actual: video.playbackRate,
              currentTime: video.currentTime,
            });
            video.playbackRate = rate;
          }
          // End the segment the moment its real footage runs out, instead of
          // pausing and holding the final frame for the leftover time — that
          // hold is what showed up as a freeze frame mid-edit.
          const reachedCut = video.ended || video.currentTime >= end - 0.03;
          drawFrame();
          const segElapsed = (performance.now() - segStartedAt) / 1000;
          const pct =
            ((elapsedBefore + Math.min(segElapsed, outputDuration)) / totalDuration) * 100;
          opts.onProgress?.(Math.min(99, Math.round(pct)));
          if (reachedCut || segElapsed >= outputDuration) {
            if (!video.paused) video.pause();
            console.log("[freeze-debug] segment end", {
              segmentIndex: index,
              segElapsed,
              outputDuration,
              finalCurrentTime: video.currentTime,
              finalPlaybackRate: video.playbackRate,
              reachedCut,
            });
            finish();
          }
        };
        const FALLBACK_GAP_MS = 120;
        const timer = setInterval(() => {
          if (done) return;
          if (performance.now() - lastRafAt >= FALLBACK_GAP_MS) tick();
        }, 1000 / 30);
        const raf = () => {
          if (done) return;
          lastRafAt = performance.now();
          tick();
          if (!done) requestAnimationFrame(raf);
        };
        requestAnimationFrame(raf);
        // Also react immediately to an abort fired between frames, instead
        // of waiting for the next tick (~33ms fallback, or up to one rAF).
        signal?.addEventListener("abort", cancel, { once: true });
      });

      video.pause();
      elapsedBefore += outputDuration;
    }
  } catch (e) {
    // Cancelled mid-render: stop the recorder and tear everything down, but
    // never write out a partial file — the caller checks for this error and
    // skips the upload step entirely.
    if (recorder.state !== "inactive") recorder.stop();
    captureStream.getTracks().forEach((t) => t.stop());
    if (captureStream !== stream) stream.getTracks().forEach((t) => t.stop());
    prepared.forEach((p) => {
      p.video.pause();
      p.video.src = "";
    });
    if (soundtrack) {
      soundtrack.pause();
      soundtrack.removeAttribute("src");
    }
    throw e;
  }

  const thumbnail = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8);
    } catch {
      resolve(null);
    }
  });

  if (recorder.state === "recording") recorder.requestData();
  recorder.stop();
  await stopped;

  captureStream.getTracks().forEach((t) => t.stop());
  if (captureStream !== stream) stream.getTracks().forEach((t) => t.stop());
  prepared.forEach((p) => {
    p.video.pause();
    p.video.src = "";
  });
  if (soundtrack) {
    soundtrack.pause();
    soundtrack.removeAttribute("src");
  }

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) throw new Error("Recorder produced an empty file.");
  return { blob, extension, mimeType, thumbnail };
}
