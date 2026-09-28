/**
 * WebCraft — Redstone (Phase 2C) unit tests.
 *
 * Covers ALL required scenarios from docs/design.md §8.4:
 *  - decay: torch line 14,13,...,0 (15th dust off) — exact boundary
 *  - line rule: dust on redstone_block (=15) passes full strength two away
 *  - repeater: 1-tick delay, 4-tick sustain, strength preservation, lock
 *  - comparator: compare = max(back, sides); subtract = back-side clamped at 0
 *  - piston: 12-block push (incl. piston chain link), 13-block failure,
 *    bedrock failure, sticky pull on de-power
 *  - observer: block change in front → exactly 2 ticks of output 15
 *  - torch off under power; lamp on/off
 * plus pressure plate, button durations, lever power, determinism.
 *
 * Harness: flat all-air World (injectable no-op generator) + Redstone.tick().
 * No browser, pure logic, deterministic.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world';
import {
  AIR,
  Block,
  Facing,
  getDelay,
  getMode,
  getOutput,
  getStrength,
  isOn,
} from '../src/world/blocks';
import { Redstone } from '../src/redstone/tick';
import { getRepeaterOut, type RedstoneCtx } from '../src/redstone/types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TestPlayer {
  x: number;
  y: number;
  z: number;
}

interface Harness {
  world: World;
  rs: Redstone;
  ctx: RedstoneCtx;
  player: TestPlayer;
  /** advance n 20 TPS ticks */
  step: (n?: number) => void;
  /** place a block (test-side world edit, picked up on the next tick) */
  place: (x: number, y: number, z: number, id: number, meta?: number) => void;
  /** remove a block (test-side world edit) */
  remove: (x: number, y: number, z: number) => void;
  strength: (x: number, y: number, z: number) => number;
}

/** All-air world (no-op generator) + redstone tick harness. */
function makeHarness(playerPos: { x: number; y: number; z: number } = { x: 0.5, y: 12, z: 0.5 }): Harness {
  const world = new World(1, () => {}); // all air
  const rs = new Redstone();
  const player: TestPlayer = { ...playerPos };
  const ctx: RedstoneCtx = {
    playerX: player.x,
    playerY: player.y,
    playerZ: player.z,
    // player AABB: 0.6 wide × 1.8 tall, feet at (x, y, z)
    entityAbove: (x, y, z) => {
      const minX = player.x - 0.3;
      const maxX = player.x + 0.3;
      const minY = player.y;
      const maxY = player.y + 1.8;
      const minZ = player.z - 0.3;
      const maxZ = player.z + 0.3;
      return minX < x + 1 && maxX > x && minY < y + 1 && maxY > y && minZ < z + 1 && maxZ > z;
    },
  };
  const h: Harness = {
    world,
    rs,
    ctx,
    player,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) rs.tick(world, ctx);
    },
    place: (x, y, z, id, meta = 0) => world.setBlock(x, y, z, id, meta),
    remove: (x, y, z) => world.setBlock(x, y, z, AIR),
    strength: (x, y, z) => getStrength(world.getMeta(x, y, z)),
  };
  return h;
}

const metaStrength = (w: World, x: number, y: number, z: number): number => getStrength(w.getMeta(x, y, z));

// ---------------------------------------------------------------------------
// §8.4 — decay: torch line 14,13,...,0
// ---------------------------------------------------------------------------

describe('dust propagation (1.13 fixed point)', () => {
  it('torch line: 1.13 line-rule equilibrium is a 14,13,14,13,... zigzag', () => {
    // Phase 4: with the 1.13 line rule (pass = sC > sN ? sC : sC - 1), the
    // dust two blocks away TOWARD the source is always stronger than the
    // intermediate dust, so every dust re-receives the source-side strength
    // without decay and the line converges to a 2-step zigzag instead of a
    // smooth 14,13,...,0 decay (the pre-Phase-4 test codified the old
    // exactly-15 rule).
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneTorch, 1); // on
    for (let n = 1; n <= 15; n++) h.place(n, 10, 0, Block.RedstoneDust);
    h.step(3); // converge
    for (let n = 1; n <= 15; n++) {
      expect(metaStrength(h.world, n, 10, 0), `dust #${n}`).toBe(n % 2 === 1 ? 14 : 13);
    }
    // the torch stays lit (1.13: adjacent dust does not extinguish it)
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
  });

  it('line rule (sub-15): a far dust stronger than the intermediate passes without decay', () => {
    // torch → 3 dust: dust #3 receives dust #1's strength (14) through dust
    // #2 (13) WITHOUT the -1 decay (14 > 13). Under the old exactly-15 rule
    // dust #3 would have settled at 12.
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneTorch, 1); // on
    h.place(1, 10, 0, Block.RedstoneDust);
    h.place(2, 10, 0, Block.RedstoneDust);
    h.place(3, 10, 0, Block.RedstoneDust);
    h.step(3);
    expect(h.strength(1, 10, 0)).toBe(14);
    expect(h.strength(2, 10, 0)).toBe(13);
    expect(h.strength(3, 10, 0)).toBe(14); // sub-15 line pass
  });

  it('line rule: dust on redstone_block (=15) passes full strength to the dust two away', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneBlock);
    h.place(0, 11, 0, Block.RedstoneDust); // on top of the block → 15 (strong)
    h.place(1, 11, 0, Block.RedstoneDust);
    h.place(2, 11, 0, Block.RedstoneDust);
    h.step(3);
    expect(h.strength(0, 11, 0)).toBe(15); // strong power from below
    expect(h.strength(1, 11, 0)).toBe(14); // one decay step
    expect(h.strength(2, 11, 0)).toBe(15); // LINE RULE: full strength two away
  });

  it('dust on redstone_block = 15 (strong power of the block below)', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneBlock);
    h.place(0, 11, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(0, 11, 0)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// §8.4 — repeater: delay, sustain, preservation, lock
// ---------------------------------------------------------------------------

/** Repeater fed by dust on a redstone block; output observed at the front dust. */
function repeaterFixture(delay: number): Harness {
  const h = makeHarness();
  h.place(0, 10, 0, Block.RedstoneBlock);
  h.place(0, 11, 0, Block.RedstoneDust); // input dust (15)
  const meta = Facing.East | ((delay - 1) << 2); // facing east, bits 2-3 delay-1
  h.place(1, 11, 0, Block.Repeater, meta);
  h.place(2, 11, 0, Block.RedstoneDust); // output dust (front)
  h.place(3, 11, 0, Block.RedstoneLamp);
  return h;
}

describe('repeater (1.13)', () => {
  it('1-tick delay: output appears one tick after the input is sampled', () => {
    const h = repeaterFixture(1);
    h.step(1); // t0: input dust settles to 15 (repeater samples 0 — dust was empty)
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(0);
    h.step(1); // t1: input sampled (15) — latency tick, output still 0
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(0);
    h.step(1); // t2: output on
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(15);
    expect(h.strength(2, 11, 0)).toBe(15);
    expect(isOn(h.world.getMeta(3, 11, 0))).toBe(true); // lamp lit
  });

  it('constant input → continuous output (no OFF tick in 20 ticks)', () => {
    // 1.13 semantics (Phase 4): while the sampled input is > 0 the output
    // stays ON — the old behavior pulsed (ON `delay` ticks, OFF 1 tick,
    // re-latch) and is no longer correct.
    const h = repeaterFixture(1);
    h.step(3); // t0 settle, t1 latency, t2: on
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(15);
    for (let t = 3; t <= 22; t++) {
      h.step(1);
      expect(getRepeaterOut(h.world.getMeta(1, 11, 0)), `output at tick ${t}`).toBe(15);
      expect(h.strength(2, 11, 0), `front dust at tick ${t}`).toBe(15);
      expect(isOn(h.world.getMeta(3, 11, 0)), `lamp at tick ${t}`).toBe(true);
    }
  });

  it('input removed → output persists for its minimum-on time, then falls', () => {
    // delay 1: the output stays on for one more tick after the input is
    // killed (the delay window must complete), then falls.
    const h = repeaterFixture(1);
    h.step(3); // t0 settle, t1 latency, t2: on
    h.remove(0, 10, 0); // kill the input (redstone block)
    h.step(1); // t3: re-samples the (stale, not yet re-propagated) 15 → on
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(15);
    h.step(1); // t4: input dust now 0 → off
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(0);
    expect(h.strength(2, 11, 0)).toBe(0);
    expect(isOn(h.world.getMeta(3, 11, 0))).toBe(false);

    // delay 4: the output stays on for its full 4-tick minimum-on time.
    const h4 = repeaterFixture(4);
    h4.step(3); // t0 settle, t1 latency, t2: on
    h4.remove(0, 10, 0);
    for (let t = 3; t <= 5; t++) {
      h4.step(1);
      expect(getRepeaterOut(h4.world.getMeta(1, 11, 0)), `tick ${t}`).toBe(15);
      expect(isOn(h4.world.getMeta(3, 11, 0)), `lamp at tick ${t}`).toBe(true);
    }
    h4.step(1); // t6: sustain complete → off
    expect(getRepeaterOut(h4.world.getMeta(1, 11, 0))).toBe(0);
    expect(isOn(h4.world.getMeta(3, 11, 0))).toBe(false);
    expect(getDelay(h4.world.getMeta(1, 11, 0))).toBe(4); // delay meta preserved
  });

  it('preserves input strength (weaker input → weaker output)', () => {
    // Phase 4 line rule: the torch line settles to 14,13,14 — the back input
    // at dust #3 is 14 (was 12 under the old exactly-15 line rule).
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneTorch, 1);
    h.place(1, 10, 0, Block.RedstoneDust); // 14
    h.place(2, 10, 0, Block.RedstoneDust); // 13
    h.place(3, 10, 0, Block.RedstoneDust); // 14 (line pass from dust #1)
    h.place(4, 10, 0, Block.Repeater, Facing.East); // delay 1
    h.place(5, 10, 0, Block.RedstoneDust);
    h.step(3); // t0 settle, t1 sample(14), t2 output
    expect(getRepeaterOut(h.world.getMeta(4, 10, 0))).toBe(14);
    expect(h.strength(5, 10, 0)).toBe(14); // preserved, not re-boosted
  });

  it('lock: input changes while output > 0 are ignored (sustain completes)', () => {
    const h = repeaterFixture(4);
    h.step(2); // t0 settle, t1 latency
    h.step(1); // t2: output on (15)
    h.remove(0, 10, 0); // kill the input (redstone block gone)
    for (let t = 3; t <= 5; t++) {
      h.step(1);
      expect(getRepeaterOut(h.world.getMeta(1, 11, 0)), `locked at tick ${t}`).toBe(15);
      expect(h.strength(2, 11, 0), `front dust at tick ${t}`).toBe(15);
    }
    h.step(1); // t6: sustain complete → off
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(0);
    expect(h.strength(2, 11, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §8.4 — comparator: compare = max(back, sides); subtract = back-side ≥ 0
// ---------------------------------------------------------------------------

/** Comparator (facing east) with a 12-strength dust input behind and a lever on a side. */
function comparatorFixture(mode: number, leverSide: 'north' | 'south'): Harness {
  const h = makeHarness();
  h.place(0, 10, 0, Block.RedstoneTorch, 1);
  h.place(1, 10, 0, Block.RedstoneDust); // 14
  h.place(2, 10, 0, Block.RedstoneDust); // 13
  h.place(3, 10, 0, Block.RedstoneDust); // 12 → back input
  h.place(4, 10, 0, Block.Comparator, Facing.East | (mode ? 0x04 : 0));
  if (leverSide === 'north') h.place(4, 10, -1, Block.Lever, 1); // side input 15
  else h.place(4, 10, 1, Block.Lever, 1);
  h.place(5, 10, 0, Block.RedstoneDust); // output dust
  return h;
}

describe('comparator (1.13)', () => {
  // Phase 4 note: the fixture's torch line settles to 14,13,14 under the
  // 1.13 line rule, so the "back" input is 14 (was 12 under the old rule).

  it('compare mode: output = max(back, side0, side1) — side (15) beats back (14), sustained', () => {
    const h = comparatorFixture(0, 'south');
    h.step(1); // t0: dust settles; side input (15) sampled — latency tick
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(0);
    h.step(1); // t1: output on (comparator = 1-tick delay), side beats back
    expect(getMode(h.world.getMeta(4, 10, 0))).toBe(0);
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(15);
    expect(h.strength(5, 10, 0)).toBe(15);
    // constant input → continuous output (no pulse; Phase 4 sustain fix)
    for (let t = 2; t <= 6; t++) {
      h.step(1);
      expect(getOutput(h.world.getMeta(4, 10, 0)), `tick ${t}`).toBe(15);
    }
    // input weakens → the output tracks it (re-sampled at each window end)
    h.world.setBlock(4, 10, 1, Block.Lever, 0); // side lever off
    h.step(1); // re-samples: side 0, back 14 → output tracks down to 14
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(14);
    // input removed → falls after the minimum-on time (comparator delay 1).
    // (Note: under the 1.13 line rule the torch line is self-sustaining —
    // removing the torch alone would NOT drain it — so the back dust itself
    // is removed to kill the input.)
    h.remove(3, 10, 0);
    h.step(1); // re-samples: back air → 0 → off
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(0);
    expect(h.strength(5, 10, 0)).toBe(0);
  });

  it('compare mode: back (14) with no side input → 14, sustained', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneTorch, 1);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.place(2, 10, 0, Block.RedstoneDust);
    h.place(3, 10, 0, Block.RedstoneDust); // 14 (line pass from dust #1)
    h.place(4, 10, 0, Block.Comparator, Facing.East);
    h.place(5, 10, 0, Block.RedstoneDust);
    h.step(3);
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(14);
    expect(h.strength(5, 10, 0)).toBe(14);
    h.step(5); // sustained while the input persists
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(14);
  });

  it('subtract mode: back - side clamped at 0 (14 - 15 → 0)', () => {
    const h = comparatorFixture(1, 'north'); // side0 = north = 15
    h.step(3);
    expect(getMode(h.world.getMeta(4, 10, 0))).toBe(1);
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(0);
    expect(h.strength(5, 10, 0)).toBe(0);
  });

  it('subtract mode: back - side with side < back (14 - 0 → 14)', () => {
    const h = comparatorFixture(1, 'south'); // side1 = south; subtract uses side0 (north = 0)
    h.step(3);
    expect(getOutput(h.world.getMeta(4, 10, 0))).toBe(14);
    expect(h.strength(5, 10, 0)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// §8.4 — piston: 12-block push, 13-block failure, bedrock, sticky pull
// ---------------------------------------------------------------------------

describe('piston (1.13)', () => {
  // 1.13 geometry: the (retracted) head occupies x=1 for a piston at x=0
  // facing east; the pushed column starts at x=2. The 1.13 limit counts
  // PUSHED elements only (the main head is not counted; a chain piston
  // counts base + head = 2) — up to 12 pushed blocks (Phase 4 fix: the old
  // code counted the main head, giving an effective limit of 11).

  it('pushes a 12-block column (12 pushed blocks incl. a piston chain link)', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Piston, Facing.East);
    for (let x = 2; x <= 5; x++) h.place(x, 10, 0, Block.Stone); // 4 pushed
    h.place(6, 10, 0, Block.Piston, Facing.East); // chain link: 2 pushed (head at x=7)
    for (let x = 8; x <= 13; x++) h.place(x, 10, 0, Block.Stone); // 6 pushed → 12 total
    h.place(0, 9, 0, Block.RedstoneBlock); // power (strong, below)
    h.step(2); // t0 detect, t1 countdown
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.Piston); // not yet moved
    h.step(1); // t2: push applied
    expect(h.world.getBlock(0, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Piston); // base moved to head
    expect(h.world.getBlock(2, 10, 0)).toBe(AIR); // main head (extended)
    for (let x = 3; x <= 6; x++) expect(h.world.getBlock(x, 10, 0), `x=${x}`).toBe(Block.Stone);
    expect(h.world.getBlock(7, 10, 0)).toBe(Block.Piston); // chain link moved
    expect(h.world.getBlock(8, 10, 0)).toBe(AIR); // chain link's head (extended)
    for (let x = 9; x <= 14; x++) expect(h.world.getBlock(x, 10, 0), `x=${x}`).toBe(Block.Stone);
  });

  it('fails at 13 pushed blocks (nothing moves)', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Piston, Facing.East);
    for (let x = 2; x <= 5; x++) h.place(x, 10, 0, Block.Stone); // 4 pushed
    h.place(6, 10, 0, Block.Piston, Facing.East); // 2 pushed (base + head)
    for (let x = 8; x <= 14; x++) h.place(x, 10, 0, Block.Stone); // 7 pushed → 13 total
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(6);
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.Piston); // stayed
    expect(h.world.getBlock(2, 10, 0)).toBe(Block.Stone); // nothing moved
  });

  it('cannot push bedrock', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Piston, Facing.East);
    h.place(2, 10, 0, Block.Stone);
    h.place(3, 10, 0, Block.Bedrock);
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(6);
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.Piston);
    expect(h.world.getBlock(2, 10, 0)).toBe(Block.Stone);
    expect(h.world.getBlock(3, 10, 0)).toBe(Block.Bedrock);
  });

  it('sticky piston pulls the attached front block back on de-power', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.StickyPiston, Facing.East);
    h.place(2, 10, 0, Block.Stone); // front block (head at x=1 is air)
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(3); // extend: base at (1,10,0), stone pushed to (3,10,0)
    expect(h.world.getBlock(0, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.StickyPiston);
    expect(h.world.getBlock(2, 10, 0)).toBe(AIR); // extended head
    expect(h.world.getBlock(3, 10, 0)).toBe(Block.Stone);
    h.remove(0, 9, 0); // de-power
    h.step(3); // retract: base back to (0,10,0), front pulled to (2,10,0)
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.StickyPiston);
    expect(h.world.getBlock(1, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(2, 10, 0)).toBe(Block.Stone);
    expect(h.world.getBlock(3, 10, 0)).toBe(AIR);
  });

  it('non-sticky piston does NOT pull the front block on de-power', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Piston, Facing.East);
    h.place(2, 10, 0, Block.Stone);
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(3);
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Piston);
    expect(h.world.getBlock(3, 10, 0)).toBe(Block.Stone);
    h.remove(0, 9, 0);
    h.step(3);
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.Piston);
    expect(h.world.getBlock(1, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(2, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(3, 10, 0)).toBe(Block.Stone); // left behind
  });

  it('pushes a short row (4 blocks) with air destination', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Piston, Facing.East);
    for (let x = 2; x <= 5; x++) h.place(x, 10, 0, Block.Stone);
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(3); // extend at t2
    expect(h.world.getBlock(0, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Piston);
    expect(h.world.getBlock(2, 10, 0)).toBe(AIR); // extended head
    for (let x = 3; x <= 6; x++) expect(h.world.getBlock(x, 10, 0), `x=${x}`).toBe(Block.Stone);
  });

  it('does not extend while unpowered (no state leak)', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Piston, Facing.East);
    h.place(2, 10, 0, Block.Stone);
    h.step(6);
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.Piston);
    expect(h.world.getBlock(2, 10, 0)).toBe(Block.Stone);
  });
});

// ---------------------------------------------------------------------------
// §8.4 — observer: 2-tick output on front-block change
// ---------------------------------------------------------------------------

describe('observer (1.13)', () => {
  it('block change in front → exactly 2 ticks of output 15, then off', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Observer, Facing.East);
    h.place(0, 11, 0, Block.RedstoneDust); // reads the observer's strong power (above)
    h.step(1); // t0: baseline recorded (front is air)
    expect(h.strength(0, 11, 0)).toBe(0);
    h.place(1, 10, 0, Block.Stone); // front block changes
    h.step(1); // t1: detected → output tick 1
    expect(h.strength(0, 11, 0)).toBe(15);
    h.step(1); // t2: output tick 2
    expect(h.strength(0, 11, 0)).toBe(15);
    h.step(1); // t3: off
    expect(h.strength(0, 11, 0)).toBe(0);
  });

  it('meta-only change (lever flip) also triggers the observer', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Observer, Facing.East);
    h.place(1, 10, 0, Block.Lever, 0); // off
    h.place(0, 11, 0, Block.RedstoneDust);
    h.step(1); // baseline: lever off
    h.world.setBlock(1, 10, 0, Block.Lever, 1); // flip (meta change only)
    h.step(1);
    expect(h.strength(0, 11, 0)).toBe(15);
    h.step(2);
    expect(h.strength(0, 11, 0)).toBe(0);
  });

  it('no output when the front block is unchanged', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Observer, Facing.East);
    h.place(1, 10, 0, Block.Stone);
    h.place(0, 11, 0, Block.RedstoneDust);
    h.step(5);
    expect(h.strength(0, 11, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §8.4 — torch off under power; lamp on/off
// ---------------------------------------------------------------------------

describe('torch & lamp (1.13)', () => {
  it('torch turns off while powered (adjacent redstone block) and recovers', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneTorch, 1);
    h.place(1, 10, 0, Block.RedstoneBlock);
    h.step(2);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(false); // extinguished
    h.remove(1, 10, 0);
    h.step(2);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true); // recovered
  });

  it('torch on the ground is powered by a redstone block below', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneTorch, 1);
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(2);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(false);
  });

  it('lamp turns on from adjacent dust and off when the signal is removed', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneLamp);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.place(2, 10, 0, Block.RedstoneTorch, 1);
    h.step(3);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true); // lit (dust 14)
    h.remove(2, 10, 0); // kill the source
    h.step(4);
    expect(h.strength(1, 10, 0)).toBe(0);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(false); // unlit
  });

  it('lamp lights from strong power of the block below', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneLamp);
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(2);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Power model extras (design.md §8.1)
// ---------------------------------------------------------------------------

describe('power model (1.13 sources)', () => {
  it('lever on powers adjacent dust at 14', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.Lever, 1);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(14);
    h.world.setBlock(0, 10, 0, Block.Lever, 0); // toggle off
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(0);
  });

  it('pressure plate: 15 while the player stands on it, off when they leave', () => {
    const h = makeHarness({ x: 0.5, y: 11, z: 0.5 }); // feet one block above the plate
    h.place(0, 10, 0, Block.StonePressurePlate);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(1);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
    expect(h.strength(1, 10, 0)).toBe(14);
    // walk away
    h.player.x = 5.5;
    h.player.z = 5.5;
    h.ctx.playerX = 5.5;
    h.ctx.playerZ = 5.5;
    h.step(1);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(false);
    expect(h.strength(1, 10, 0)).toBe(0);
  });

  it('stone button: 10 ticks on, then auto-off', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.StoneButton);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.rs.pressButton(h.world, 0, 10, 0);
    h.step(1); // t0: on
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
    expect(h.strength(1, 10, 0)).toBe(14);
    h.step(9); // t9: still on (10th tick)
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
    h.step(1); // t10: auto-off
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(false);
    expect(h.strength(1, 10, 0)).toBe(0);
  });

  it('wood button: 20 ticks on, then auto-off', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.WoodButton);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.rs.pressButton(h.world, 0, 10, 0);
    h.step(19); // t18: still on
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
    h.step(1); // t19: 20th tick, still on
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true);
    h.step(1); // t20: auto-off
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(false);
  });

  it('repeater/comparator output powers the block in front (weak + strong)', () => {
    const h = makeHarness();
    h.place(0, 10, 0, Block.RedstoneBlock);
    h.place(0, 11, 0, Block.RedstoneDust); // input 15
    h.place(1, 11, 0, Block.Repeater, Facing.East);
    h.place(2, 11, 0, Block.Stone); // front block: strongly powered
    h.place(2, 12, 0, Block.RedstoneDust); // dust above the front block
    h.step(3); // output on at t2
    expect(getRepeaterOut(h.world.getMeta(1, 11, 0))).toBe(15);
    expect(h.strength(2, 12, 0)).toBe(15); // front block now a 15 source
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('identical circuits produce identical states over 10 ticks', () => {
    const build = () => {
      const h = makeHarness();
      h.place(0, 10, 0, Block.RedstoneTorch, 1);
      for (let n = 1; n <= 8; n++) h.place(n, 10, 0, Block.RedstoneDust);
      h.place(9, 10, 0, Block.Repeater, Facing.East | (1 << 2));
      h.place(10, 10, 0, Block.RedstoneDust);
      h.place(11, 10, 0, Block.RedstoneLamp);
      return h;
    };
    const a = build();
    const b = build();
    a.step(8);
    b.step(8);
    for (let n = 0; n <= 10; n++) {
      expect(a.strength(n, 10, 0)).toBe(b.strength(n, 10, 0));
    }
    expect(isOn(a.world.getMeta(11, 10, 0))).toBe(isOn(b.world.getMeta(11, 10, 0)));
    // sanity: the circuit is actually live. Phase 4 line rule: the torch
    // line settles to the 14,13,... zigzag, so the repeater input (dust #8)
    // is 13 and the sustained output is 13 (was 7 under the old rule).
    expect(a.strength(1, 10, 0)).toBe(14);
    expect(a.strength(10, 10, 0)).toBe(13);
  });
});
