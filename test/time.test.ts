/**
 * WebCraft — Day/night cycle unit tests (Phase 5A).
 *
 * design.md §8.6: 24000 ticks/day, start at 1000, detector output
 * clamp(round(15 · max(0, sin(π·t/12000))), 0, 15) for day (0≤t≤12000),
 * 0 at night; inverted = 15 − output. Sun elevation drives the sky lerp.
 */

import { describe, it, expect } from 'vitest';
import {
  DAY_LENGTH_TICKS,
  START_TIME,
  WorldClock,
  daylightOutput,
  sunElevation,
  wrapTime,
} from '../src/world/time';

describe('daylight detector output (pure function)', () => {
  it('noon (t=6000) → 15, midnight (t=18000) → 0', () => {
    expect(daylightOutput(6000, false)).toBe(15);
    expect(daylightOutput(18000, false)).toBe(0);
  });

  it('sunrise (t=0) and sunset (t=12000) → 0', () => {
    expect(daylightOutput(0, false)).toBe(0);
    expect(daylightOutput(12000, false)).toBe(0);
  });

  it('inverted mode = 15 − normal (inverted at night → 15)', () => {
    expect(daylightOutput(18000, true)).toBe(15);
    expect(daylightOutput(6000, true)).toBe(0);
    expect(daylightOutput(0, true)).toBe(15);
    expect(daylightOutput(12000, true)).toBe(15);
  });

  it('rises monotonically through the day and falls symmetrically', () => {
    const day = [daylightOutput(0, false), daylightOutput(2000, false), daylightOutput(4000, false), daylightOutput(6000, false), daylightOutput(8000, false), daylightOutput(10000, false), daylightOutput(12000, false)];
    expect(day[1]).toBeGreaterThan(day[0]);
    expect(day[2]).toBeGreaterThan(day[1]);
    expect(day[3]).toBe(15);
    expect(day[4]).toBeLessThan(day[3]);
    expect(day[5]).toBeLessThan(day[4]);
    expect(day[6]).toBe(0);
    // symmetry around noon
    expect(daylightOutput(4000, false)).toBe(daylightOutput(8000, false));
  });

  it('wraps times beyond one day (and negative times)', () => {
    expect(daylightOutput(6000 + DAY_LENGTH_TICKS, false)).toBe(daylightOutput(6000, false));
    expect(daylightOutput(-6000, false)).toBe(daylightOutput(DAY_LENGTH_TICKS - 6000, false));
  });
});

describe('sun elevation (sky lerp driver)', () => {
  it('noon +1, midnight −1, sunrise/sunset 0 (matches the detector day span)', () => {
    expect(sunElevation(6000)).toBeCloseTo(1, 5);
    expect(sunElevation(18000)).toBeCloseTo(-1, 5);
    expect(sunElevation(0)).toBeCloseTo(0, 5);
    expect(sunElevation(12000)).toBeCloseTo(0, 5);
  });

  it('positive exactly during the detector day (0,12000) and negative at night', () => {
    for (const t of [1000, 3000, 6000, 9000, 11000]) expect(sunElevation(t)).toBeGreaterThan(0);
    for (const t of [13000, 16000, 18000, 21000, 23000]) expect(sunElevation(t)).toBeLessThan(0);
  });
});

describe('WorldClock', () => {
  it('starts at the 1.13 default (1000) and advances 1 tick per tick()', () => {
    const c = new WorldClock();
    expect(c.time).toBe(START_TIME);
    expect(START_TIME).toBe(1000);
    c.tick();
    expect(c.time).toBe(1001);
  });

  it('wraps at the day boundary (23999 → 0)', () => {
    const c = new WorldClock(DAY_LENGTH_TICKS - 1);
    c.tick();
    expect(c.time).toBe(0);
  });

  it('wrapTime normalizes arbitrary values into [0, 24000)', () => {
    expect(wrapTime(0)).toBe(0);
    expect(wrapTime(23999)).toBe(23999);
    expect(wrapTime(24000)).toBe(0);
    expect(wrapTime(48001)).toBe(1);
    expect(wrapTime(-1)).toBe(23999);
  });
});
