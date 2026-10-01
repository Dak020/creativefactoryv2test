/**
 * Clip DNA duration solver — plain deterministic arithmetic, no AI.
 *
 * Given role-tagged clips (start / middle / end), each clip's REAL source
 * duration and its allowed playback speeds, produce an ordered list of
 * segments whose output durations sum to the target duration.
 *
 * Hard rules:
 *  - `source_out - source_in` can NEVER exceed the clip's real duration.
 *    Footage is never manufactured, stretched or looped.
 *  - `speed` must be one of that clip's own allowed speeds.
 *  - every segment's output duration is at least MIN_SEGMENT_SECONDS.
 *  - the solver picks RANDOMLY among valid solutions so repeat renders from
 *    the same clip pool produce genuinely different edits.
 */

import type { SeekOptions } from "@/lib/render/browser-render";

export type DnaRole = "start" | "middle" | "end";

export const DNA_SPEEDS = [1.0, 1.5, 1.7, 2.0] as const;
export const MIN_SEGMENT_SECONDS = 0.5;
export const DURATION_TOLERANCE = 0.05;

/**
 * The opening segment carries the hook, so it is never a random sliver or a
 * sprawling half of the edit. It stays inside a tight, readable window.
 */
export const START_MIN_SECONDS = 1.2;
export const START_MAX_SECONDS = 3;

export type SolverClip = {
  id: string;
  role: DnaRole;
  /** Real duration of the source file, in seconds. */
  duration: number;
  allowedSpeeds: number[];
  hookPlacement?: string | null;
  filename?: string;
  seekMode?: "random" | "beginning" | "manual";
  seekSeconds?: number;
};

export type DnaSegment = {
  media_asset_id: string;
  role: DnaRole;
  source_in: number;
  source_out: number;
  speed: number;
  output_duration: number;
};

export type RoleCheck =
  | { ok: true; sequence: DnaRole[] }
  | { ok: false; reason: string };

/** The only role combinations DNA can build, in priority order. */
const VALID_COMBOS: { roles: DnaRole[]; sequence: DnaRole[] }[] = [
  { roles: ["start", "middle", "end"], sequence: ["start", "middle", "end"] },
  { roles: ["start", "middle"], sequence: ["start", "middle"] },
  { roles: ["middle", "end"], sequence: ["middle", "end"] },
  { roles: ["start", "end"], sequence: ["start", "end"] },
  { roles: ["middle"], sequence: ["middle"] },
];

function sameSet(a: DnaRole[], b: DnaRole[]) {
  return a.length === b.length && a.every((r) => b.includes(r));
}

/**
 * Decide whether the roles present in a project form a buildable combination.
 * Never falls back to non-DNA behavior silently — an unsupported set returns
 * an explicit reason naming the missing role(s).
 */
export function checkRoles(clips: SolverClip[]): RoleCheck {
  const present = Array.from(new Set(clips.map((c) => c.role))) as DnaRole[];
  if (present.length === 0) {
    return { ok: false, reason: "No clips are tagged with a DNA role yet. Tag at least one clip as Start, Middle or End." };
  }
  const combo = VALID_COMBOS.find((c) => sameSet(c.roles, present));
  if (combo) return { ok: true, sequence: combo.sequence };

  if (sameSet(present, ["start"])) {
    return { ok: false, reason: "Only a Start clip is tagged. Add a Middle or End clip to build a DNA render." };
  }
  if (sameSet(present, ["end"])) {
    return { ok: false, reason: "Only an End clip is tagged. Add a Start or Middle clip to build a DNA render." };
  }
  return { ok: false, reason: `Roles ${present.join(" + ")} aren't a supported combination.` };
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function normalizeSpeeds(speeds: number[] | null | undefined) {
  const list = (speeds ?? []).map(Number).filter((s) => Number.isFinite(s) && s > 0);
  return list.length > 0 ? list : [...DNA_SPEEDS];
}

/**
 * Choose one clip per role in the sequence. When several clips share a role
 * the pick is random — more variety across repeated renders.
 */
export function pickSequenceClips(clips: SolverClip[], sequence: DnaRole[]): SolverClip[] {
  return sequence.map((role) => pick(clips.filter((c) => c.role === role)));
}

type Bounds = { min: number; max: number };

/**
 * Randomly split `target` across N slots, each within its own [min, max].
 * Slots are filled in random order so no position is systematically favoured.
 */
function randomSplit(target: number, bounds: Bounds[]): number[] | null {
  const totalMin = bounds.reduce((s, b) => s + b.min, 0);
  const totalMax = bounds.reduce((s, b) => s + b.max, 0);
  if (target < totalMin - 1e-9 || target > totalMax + 1e-9) return null;

  const order = bounds.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  const out = new Array<number>(bounds.length).fill(0);
  let remaining = target;
  let remainingMin = totalMin;
  let remainingMax = totalMax;

  order.forEach((idx, position) => {
    const b = bounds[idx]!;
    remainingMin -= b.min;
    remainingMax -= b.max;
    if (position === order.length - 1) {
      out[idx] = remaining;
      return;
    }
    const lo = Math.max(b.min, remaining - remainingMax);
    const hi = Math.min(b.max, remaining - remainingMin);
    const value = hi <= lo ? lo : lo + Math.random() * (hi - lo);
    out[idx] = value;
    remaining -= value;
  });

  return out.every((v, i) => v >= bounds[i]!.min - 1e-6 && v <= bounds[i]!.max + 1e-6) ? out : null;
}

export type SolveResult =
  | { ok: true; segments: DnaSegment[]; finalDuration: number }
  | { ok: false; reason: string };

/**
 * Solve one DNA edit. Attempts random speed combinations until one admits a
 * valid duration split; returns a different valid solution most times it runs.
 * Each clip respects its own seekMode and seekSeconds.
 */
export function solveDna(
  orderedClips: SolverClip[],
  targetDuration: number,
  attempts = 400,
  defaultSeek: SeekOptions = { mode: "random" }
): SolveResult {
  if (orderedClips.length === 0) return { ok: false, reason: "No clips to combine." };
  const target = Number(targetDuration);
  if (!Number.isFinite(target) || target <= 0) return { ok: false, reason: "Invalid target duration." };

  const clips = orderedClips.map((c) => ({
    ...c,
    duration: Number(c.duration) || 0,
    allowedSpeeds: normalizeSpeeds(c.allowedSpeeds),
  }));

  const unusable = clips.find((c) => c.duration <= 0);
  if (unusable) {
    return { ok: false, reason: `"${unusable.filename ?? "A clip"}" has no readable duration — re-upload it.` };
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const speeds = clips.map((c) => pick(c.allowedSpeeds));
    const bounds: Bounds[] = clips.map((c, i) => {
      // Never more real footage than the clip actually has.
      const capacity = c.duration / speeds[i]!;
      if (c.role !== "start" || clips.length === 1) {
        return { min: MIN_SEGMENT_SECONDS, max: capacity };
      }
      // Opening segment: clamped to the hook window, but always feasible.
      const min = Math.min(Math.max(MIN_SEGMENT_SECONDS, START_MIN_SECONDS), capacity);
      const max = Math.max(min, Math.min(capacity, START_MAX_SECONDS));
      return { min, max };
    });
    const split = randomSplit(target, bounds);
    if (!split) continue;

    const segments: DnaSegment[] = clips.map((c, i) => {
      const speed = speeds[i]!;
      const outputDuration = split[i]!;
      const sourceSpan = Math.min(c.duration, outputDuration * speed);
      const maxStart = Math.max(0, c.duration - sourceSpan);

      // Respect the clip's individual seek setting; fall back to defaultSeek if unset.
      const mode = c.seekMode ?? defaultSeek.mode;
      const manualSec = c.seekSeconds ?? defaultSeek.manualSeconds ?? 0;

      const sourceIn =
        mode === "beginning"
          ? 0
          : mode === "manual"
            ? round2(Math.min(maxStart, Math.max(0, Number(manualSec) || 0)))
            : round2(Math.random() * maxStart);

      const sourceOut = round2(Math.min(c.duration, sourceIn + sourceSpan));
      return {
        media_asset_id: c.id,
        role: c.role,
        source_in: sourceIn,
        source_out: sourceOut,
        speed,
        output_duration: round2((sourceOut - sourceIn) / speed),
      };
    });

    // Rounding can shift the total by a few hundredths — absorb it in the
    // longest segment, which always has the headroom for it.
    const total = segments.reduce((s, seg) => s + seg.output_duration, 0);
    const drift = round2(target - total);
    if (Math.abs(drift) > 1e-9) {
      // Prefer a non-start segment so the opener keeps its clamped length.
      const candidates = segments.some((s) => s.role !== "start")
        ? segments.map((s, i) => [s, i] as const).filter(([s]) => s.role !== "start")
        : segments.map((s, i) => [s, i] as const);
      const idx = candidates.reduce((best, [seg, i]) => (seg.output_duration > segments[best]!.output_duration ? i : best), candidates[0]![1]);
      const seg = segments[idx]!;
      const clip = clips[idx]!;
      const newOut = round2(seg.source_in + (seg.output_duration + drift) * seg.speed);
      if (newOut <= clip.duration + 1e-6 && newOut > seg.source_in) {
        seg.source_out = round2(Math.min(clip.duration, newOut));
        seg.output_duration = round2((seg.source_out - seg.source_in) / seg.speed);
      }
    }

    const finalDuration = round2(segments.reduce((s, seg) => s + seg.output_duration, 0));
    const valid =
      Math.abs(finalDuration - target) <= DURATION_TOLERANCE &&
      segments.every(
        (seg, i) =>
          seg.output_duration >= MIN_SEGMENT_SECONDS - 1e-6 &&
          seg.source_out - seg.source_in <= clips[i]!.duration + 1e-6 &&
          seg.source_in >= 0,
      );
    if (valid) return { ok: true, segments, finalDuration };
  }

  const capacity = round2(clips.reduce((s, c) => s + c.duration / Math.min(...c.allowedSpeeds), 0));
  const floor = round2(clips.length * MIN_SEGMENT_SECONDS);
  return {
    ok: false,
    reason: `No valid cut fits ${target}s with these clips (they can produce between ${floor}s and ${capacity}s). Adjust the target duration or the allowed speeds.`,
  };
}

/** Solve straight from a project's tagged clips: roles check + clip pick + solve. */
export function solveForProject(clips: SolverClip[], targetDuration: number, seek?: SeekOptions): SolveResult & { picked?: SolverClip[] } {
  const roles = checkRoles(clips);
  if (!roles.ok) return { ok: false, reason: roles.reason };
  const picked = pickSequenceClips(clips, roles.sequence);
  const result = solveDna(picked, targetDuration, 400, seek);
  return result.ok ? { ...result, picked } : result;
}
