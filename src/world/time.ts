/**
 * WebCraft — World day/night cycle (Phase 5A, [core] per task).
 *
 * Java 1.13 conventions per docs/design.md §8.6:
 *  - 24000 ticks = 1 day (20 TPS), world time starts at 1000.
 *  - Daylight detector output: clamp(round(15 * max(0, sin(π·t/12000))), 0, 15)
 *    for 0 ≤ t ≤ 12000 (day), 0 at night (12000 ≤ t < 24000).
 *    Inverted mode = 15 − output.
 *  - Sky/fog colors lerp between day (light blue) and night (dark) with the
 *    sun elevation (see `sunElevation` for the phase decision note).
 *
 * Pure TS — no DOM — synchronous and deterministic (no timers).
 */

/** One full day in 20 TPS ticks (design.md §8.6). */
export const DAY_LENGTH_TICKS = 24000;
/** The first 12000 ticks of the day are "day" (detector formula). */
export const DAY_HALF_TICKS = 12000;
/** 1.13 default world time at game start (design.md §8.6). */
export const START_TIME = 1000;

/** Wrap a time into [0, DAY_LENGTH_TICKS). */
export function wrapTime(t: number): number {
  return ((t % DAY_LENGTH_TICKS) + DAY_LENGTH_TICKS) % DAY_LENGTH_TICKS;
}

/**
 * Daylight detector output strength 0-15 for world time `t` (design.md §8.6):
 *   day (0 ≤ t ≤ 12000):  round(15 · max(0, sin(π·t/12000)))
 *   night: 0
 * Inverted mode returns 15 − output. Pure function (unit-testable).
 */
export function daylightOutput(t: number, inverted: boolean): number {
  const tt = wrapTime(t);
  let out = 0;
  if (tt <= DAY_HALF_TICKS) {
    out = Math.round(15 * Math.max(0, Math.sin((Math.PI * tt) / DAY_HALF_TICKS)));
  }
  return inverted ? 15 - out : out;
}

/**
 * Sun elevation in [-1, 1] for the sky/fog color lerp: +1 = noon peak,
 * -1 = midnight, 0 = sunrise/sunset.
 *
 * PHASE DECISION (reported): the Phase 5A task text gave
 * `sin(((t/24000)·2π) − π/2)`, which places the peak at t=12000 (sunset) and
 * the minimum at t=6000 (noon) — a half-day phase offset relative to the
 * 1.13 detector formula (0 ≤ t ≤ 12000 = day, peak at t=6000). The
 * unshifted `sin(2π·t/24000)` is used so the sky is bright exactly when the
 * daylight detector says it is day (t=0 sunrise → 0, t=6000 noon → +1,
 * t=12000 sunset → 0, t=18000 midnight → −1).
 */
export function sunElevation(t: number): number {
  const tt = wrapTime(t);
  return Math.sin((tt / DAY_LENGTH_TICKS) * Math.PI * 2);
}

/**
 * Mutable world clock advanced once per 20 TPS tick by the game.
 * Starts at START_TIME (1.13 default) and wraps at DAY_LENGTH_TICKS.
 */
export class WorldClock {
  /** current world time in [0, DAY_LENGTH_TICKS) */
  time: number;

  constructor(start: number = START_TIME) {
    this.time = wrapTime(start);
  }

  /** Advance one 20 TPS tick. */
  tick(): void {
    this.time = (this.time + 1) % DAY_LENGTH_TICKS;
  }
}
