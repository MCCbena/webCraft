/**
 * WebCraft — Redstone component state machines (Phase 2C, [redstone]).
 *
 * Java 1.13 semantics per docs/design.md §8.3. All machines are synchronous
 * (20 TPS), deterministic, and operate on: world reads/writes + runtime
 * state maps (held by the Redstone class in tick.ts). No timers/promises.
 *
 * Timing conventions (1 tick = 50 ms):
 *  - Repeater/comparator: 1-tick latency, then `delay` ticks of output
 *    (repeater delay 1..4 from meta; comparator fixed 1). 1.13 sustain:
 *    when the delay window expires the input is RE-SAMPLED — while the
 *    sampled input is still > 0 the output stays ON (strength re-captured,
 *    window restarted); only a sampled input of 0 turns the output off.
 *    Output is captured at the input strength (preserved).
 *  - Piston: 2 ticks to extend / 2 ticks to retract. Pushes up to 12 blocks
 *    (head + chain, piston chain links allowed); fails on bedrock,
 *    non-solid blocks, or a mis-oriented piston in the chain. Sticky pulls
 *    the attached front block on de-power; a front block that changed
 *    during extension is NOT pulled.
 *  - Observer: 2 ticks of output 15 after the watched front block's
 *    id/meta changes (previous state tracked per observer).
 *  - Button: stone 10 / wood 20 ticks, then auto-off.
 *  - Pressure plate: 15 while an entity overlaps the space above.
 *  - Torch: off while powered (4 horizontal neighbors + below; the block
 *    below counts strong power OR powered dust — 1.13: dust weakly powers
 *    the block directly above it; horizontal dust does NOT extinguish);
 *    recovers instantly when power is removed.
 *  - Lamp: on when any of the 6 neighbors powers it.
 */

import {
  AIR,
  BEDROCK,
  Block,
  WATER,
  getBlockDef,
  getFacing,
  getDelay,
  getMode,
  getOutput,
  getStrength,
  isOn,
  isDoorOpen,
  isDoorTop,
  setDoorOpen,
  setOn,
  setOutput,
} from '../world/blocks';
import type { World } from '../world/world';
import {
  FACING_X,
  FACING_Z,
  OBSERVER_OUTPUT_TICKS,
  PISTON_ACTION_TICKS,
  PISTON_PUSH_LIMIT,
  posKey,
  setRepeaterOut,
} from './types';
import {
  componentOutput,
  inputPowerAt,
  powerFromNeighbor,
  strongPowerToAbove,
  totalPowerReceived,
  weakPower,
  type PowerCtx,
} from './network';

/** Batched world write (applied by tick.ts after the state-machine phase). */
export interface PistonWrite {
  x: number;
  y: number;
  z: number;
  id: number;
  meta: number;
}

/** Context shared by all component machines. */
export interface ComponentCtx {
  world: World;
  /** Phase 5A: runtime power context (observers + tripped hooks + items + time). */
  power: PowerCtx;
  /** World write with remesh dirty-marking (provided by tick.ts). */
  write(x: number, y: number, z: number, id: number, meta: number): void;
}

// ---------------------------------------------------------------------------
// Torch & lamp (passive: pure state recomputation, safe to re-evaluate)
// ---------------------------------------------------------------------------

/**
 * Torch: turns off while powered by 4 horizontal neighbors + the block
 * below. In 1.13 the block below counts strong power, or redstone dust
 * with strength > 0 (dust weakly powers the block directly above it).
 * Horizontal dust does NOT extinguish. Returns true when the meta changed.
 */
export function tickTorch(c: ComponentCtx, x: number, y: number, z: number): boolean {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.RedstoneTorch) return false;
  let powered = false;
  for (let f = 0; f < 4 && !powered; f++) {
    const nx = x + FACING_X[f];
    const nz = z + FACING_Z[f];
    if (c.world.getBlock(nx, y, nz) === Block.RedstoneDust) continue;
    if (powerFromNeighbor(c.world, x, y, z, nx, y, nz, c.power) > 0) powered = true;
  }
  if (!powered && y > 0) {
    const below = c.world.getBlock(x, y - 1, z);
    if (below === Block.RedstoneDust) {
      // 1.13: powered dust weakly powers the block directly above it.
      powered = getStrength(c.world.getMeta(x, y - 1, z)) > 0;
    } else {
      powered = strongPowerToAbove(c.world, x, y - 1, z, c.power) > 0;
    }
  }
  const on = !powered;
  const meta = c.world.getMeta(x, y, z);
  if (isOn(meta) !== on) {
    c.write(x, y, z, id, setOn(meta, on));
    return true;
  }
  return false;
}

/**
 * Lamp: on when powered from any of the 6 neighbors (below via strong
 * power) — Phase 5A: including powered dust directly below (1.13 dust-above
 * rule, via totalPowerReceived).
 */
export function tickLamp(c: ComponentCtx, x: number, y: number, z: number): boolean {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.RedstoneLamp) return false;
  const on = totalPowerReceived(c.world, x, y, z, c.power) > 0;
  const meta = c.world.getMeta(x, y, z);
  if (isOn(meta) !== on) {
    c.write(x, y, z, id, setOn(meta, on));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repeater & comparator (1-tick latency + delay-tick sustain + lock)
// ---------------------------------------------------------------------------

/** Runtime delay state. `lat` = latency ticks until the output turns on;
 *  `rem` = remaining output ticks; `s` = captured input strength. */
export interface DelayedState {
  lat: number;
  rem: number;
  s: number;
}

/**
 * Weak power of the side block at `which` (0/1) of the component's facing
 * (design.md §8.3 comparator side inputs).
 */
function sidePower(c: ComponentCtx, x: number, y: number, z: number, facing: number, which: number): number {
  const dx = which === 0 ? FACING_Z[facing] : -FACING_Z[facing];
  const dz = which === 0 ? -FACING_X[facing] : FACING_X[facing];
  return weakPower(c.world, x + dx, y, z + dz, c.power);
}

function applyComponentOutput(c: ComponentCtx, x: number, y: number, z: number, id: number, s: number): void {
  const meta = c.world.getMeta(x, y, z);
  if (id === Block.Repeater) c.write(x, y, z, id, setRepeaterOut(meta, s));
  else c.write(x, y, z, id, setOutput(meta, s));
}

/**
 * Sample the input power at the block behind the component (opposite of
 * facing), applying comparator side-input math. Pure read.
 *  - compare:  max(back, side0, side1)
 *  - subtract: max(back - side0, 0)   (side0 = first side direction)
 */
function sampleInput(c: ComponentCtx, x: number, y: number, z: number, id: number, meta: number): number {
  const f = getFacing(meta);
  const backX = x - FACING_X[f];
  const backZ = z - FACING_Z[f];
  let s = inputPowerAt(c.world, backX, y, backZ, c.power);
  if (id === Block.Comparator) {
    const s1 = sidePower(c, x, y, z, f, 0);
    const s2 = sidePower(c, x, y, z, f, 1);
    s = getMode(meta) ? Math.max(s - s1, 0) : Math.max(s, s1, s2);
  }
  return s;
}

/**
 * Repeater/comparator state machine (1.13 latency + sustain semantics).
 * While the output is on (or latency pending) the component re-samples the
 * input only when the remaining delay expires: a still-powered input keeps
 * the output ON (strength re-captured, window restarted); only a sampled
 * input of 0 turns the output off (after its minimum-on time).
 */
export function tickDelayed(c: ComponentCtx, x: number, y: number, z: number, states: Map<number, DelayedState>): void {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.Repeater && id !== Block.Comparator) return;
  const key = posKey(x, y, z);
  const st = states.get(key);

  if (st) {
    if (st.lat > 0) {
      st.lat--;
      if (st.lat === 0) applyComponentOutput(c, x, y, z, id, st.s);
    } else if (st.rem > 0) {
      st.rem--;
      if (st.rem === 0) {
        // Re-sample BEFORE turning off (1.13: constant input → constant
        // output; the pulse OFF/re-latch behavior is not 1.13).
        const s = sampleInput(c, x, y, z, id, c.world.getMeta(x, y, z));
        if (s > 0) {
          const delay = id === Block.Repeater ? getDelay(c.world.getMeta(x, y, z)) : 1;
          st.s = Math.min(s, 15);
          st.rem = delay;
          applyComponentOutput(c, x, y, z, id, st.s);
        } else {
          applyComponentOutput(c, x, y, z, id, 0);
          states.delete(key);
        }
      }
    }
    return;
  }

  // Unlocked: sample the input.
  const s = sampleInput(c, x, y, z, id, c.world.getMeta(x, y, z));
  if (s > 0) {
    const delay = id === Block.Repeater ? getDelay(c.world.getMeta(x, y, z)) : 1;
    states.set(key, { lat: 1, rem: delay, s: Math.min(s, 15) });
  }
}

// ---------------------------------------------------------------------------
// Observer (2-tick output 15 after a front-block change)
// ---------------------------------------------------------------------------

export interface ObserverEntry {
  /** remaining output ticks (0 = idle) */
  ticks: number;
  /** previous id/meta of the watched front block */
  prevId: number;
  prevMeta: number;
}

export function tickObserver(c: ComponentCtx, x: number, y: number, z: number, states: Map<number, ObserverEntry>): void {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.Observer) return;
  const key = posKey(x, y, z);
  const f = getFacing(c.world.getMeta(x, y, z));
  const wx = x + FACING_X[f];
  const wz = z + FACING_Z[f];
  const curId = c.world.getBlock(wx, y, wz);
  const curMeta = c.world.getMeta(wx, y, wz);
  let e = states.get(key);
  if (!e) {
    // First sight: record the baseline, no output.
    states.set(key, { ticks: 0, prevId: curId, prevMeta: curMeta });
    return;
  }
  if (curId !== e.prevId || curMeta !== e.prevMeta) {
    e.prevId = curId;
    e.prevMeta = curMeta;
    e.ticks = OBSERVER_OUTPUT_TICKS;
  } else if (e.ticks > 0) {
    e.ticks--;
  }
}

// ---------------------------------------------------------------------------
// Button (auto-off after 10 stone / 20 wood ticks)
// ---------------------------------------------------------------------------

export function tickButton(c: ComponentCtx, x: number, y: number, z: number, timers: Map<number, number>): void {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.StoneButton && id !== Block.WoodButton) return;
  const key = posKey(x, y, z);
  const meta = c.world.getMeta(x, y, z);
  if (!isOn(meta)) {
    timers.delete(key);
    return;
  }
  const t = timers.get(key) ?? 0;
  if (t <= 0) {
    c.write(x, y, z, id, setOn(meta, false));
    timers.delete(key);
  } else {
    timers.set(key, t - 1);
  }
}

// ---------------------------------------------------------------------------
// Pressure plate (15 while an entity overlaps the space above)
// ---------------------------------------------------------------------------

export function tickPlate(c: ComponentCtx, x: number, y: number, z: number, entityAbove: (x: number, y: number, z: number) => boolean): void {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.StonePressurePlate && id !== Block.WoodPressurePlate) return;
  // 1.13: the pressure plate is a pure SENSOR — it outputs 15 only while an
  // entity overlaps the space directly above it. Redstone power (powered
  // dust below, a redstone block below, a horizontal source) does NOT
  // activate a pressure plate.
  const on = y < 255 && entityAbove(x, y + 1, z);
  const meta = c.world.getMeta(x, y, z);
  if (isOn(meta) !== on) c.write(x, y, z, id, setOn(meta, on));
}

// ---------------------------------------------------------------------------
// Piston / sticky piston
// ---------------------------------------------------------------------------

export interface PistonState {
  phase: 'extending' | 'extended' | 'retracting';
  ticks: number;
  /** front-block position (head + 1) recorded at the end of extension */
  frontX: number;
  frontY: number;
  frontZ: number;
  /** -1 = "read after the push is applied" sentinel */
  frontId: number;
  frontMeta: number;
}

/** Piston power: 4 horizontal neighbors (weak) + the block below (strong). */
export function isPistonPowered(c: ComponentCtx, x: number, y: number, z: number): boolean {
  for (let f = 0; f < 4; f++) {
    if (powerFromNeighbor(c.world, x, y, z, x + FACING_X[f], y, z + FACING_Z[f], c.power) > 0) return true;
  }
  return y > 0 && strongPowerToAbove(c.world, x, y - 1, z, c.power) > 0;
}

/**
 * 1.13 piston geometry: the base is at P, the (retracted) head occupies
 * P+d, and the pushed column starts at P+2d. Extension moves the head from
 * P+d to P+2d and shifts the column by +d; the base follows (P → P+d).
 * 1.13 limit: up to PISTON_PUSH_LIMIT (12) PUSHED elements — the main head
 * is not counted; a correctly-oriented chain piston contributes its
 * base + head (2). Fails on: a blocked head cell, non-solid blocks,
 * bedrock, a mis-oriented piston, or a pushed column of > 12 elements.
 * The destination must be air (water accepted as destination, simplified).
 */
export function canExtend(c: ComponentCtx, x: number, y: number, z: number, f: number): boolean {
  const dx = FACING_X[f];
  const dz = FACING_Z[f];
  // The pushed column starts at P+2d (the head extends from P+d into P+2d).
  let px = x + 2 * dx;
  let pz = z + 2 * dz;
  let count = 0; // pushed elements only (the main head is not counted)
  let skipHead = false;
  // Each chain piston skips one (its head) position, so the column can span
  // up to 2× the element limit + destination cells.
  for (let i = 0; i <= PISTON_PUSH_LIMIT * 2 + 1; i++) {
    if (skipHead) {
      skipHead = false;
      px += dx;
      pz += dz;
      continue;
    }
    const id = c.world.getBlock(px, y, pz);
    if (id === AIR || id === WATER) return true; // destination found
    if (!getBlockDef(id).solid) return false;
    if (id === BEDROCK) return false;
    if (id === Block.Piston || id === Block.StickyPiston) {
      if (getFacing(c.world.getMeta(px, y, pz)) !== f) return false;
      count += 2; // chain piston: base + head
      skipHead = true; // its head occupies the next position
    } else {
      count++;
    }
    if (count > PISTON_PUSH_LIMIT) return false;
    px += dx;
    pz += dz;
  }
  return false; // more than PISTON_PUSH_LIMIT pushed elements in the column
}

/**
 * Collect the push column (starting at P+2d, head-aware) and enqueue the
 * moves. Re-validates the column first (the world may have changed during
 * the 2-tick extension countdown); returns false (no moves enqueued) when
 * the push is no longer possible.
 */
function extend(c: ComponentCtx, x: number, y: number, z: number, id: number, meta: number, f: number, st: PistonState, moves: PistonWrite[]): boolean {
  if (!canExtend(c, x, y, z, f)) return false;
  const dx = FACING_X[f];
  const dz = FACING_Z[f];
  const els: { x: number; z: number; id: number; meta: number }[] = [];
  let px = x + 2 * dx;
  let pz = z + 2 * dz;
  let skipHead = false;
  for (;;) {
    if (skipHead) {
      skipHead = false;
      px += dx;
      pz += dz;
      continue;
    }
    const bid = c.world.getBlock(px, y, pz);
    if (bid === AIR || bid === WATER) break;
    els.push({ x: px, z: pz, id: bid, meta: c.world.getMeta(px, y, pz) });
    if (bid === Block.Piston || bid === Block.StickyPiston) skipHead = true;
    px += dx;
    pz += dz;
  }
  // Clear original positions (near→far), then shift (far→near) so each
  // element lands on the just-freed cell; finally the base moves to the head
  // position (the head itself extends implicitly to P+2d).
  for (const e of els) moves.push({ x: e.x, y, z: e.z, id: AIR, meta: 0 });
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    moves.push({ x: e.x + dx, y, z: e.z + dz, id: e.id, meta: e.meta });
  }
  moves.push({ x, y, z, id: AIR, meta: 0 });
  moves.push({ x: x + dx, y, z: z + dz, id, meta });
  st.phase = 'extended';
  st.frontX = x + 3 * dx; // the block in front of the extended head
  st.frontY = y;
  st.frontZ = z + 3 * dz;
  st.frontId = -1; // read by tick.ts after the moves are applied
  st.frontMeta = 0;
  return true;
}

function retract(c: ComponentCtx, x: number, y: number, z: number, id: number, f: number, st: PistonState, sticky: boolean, moves: PistonWrite[]): void {
  const dx = FACING_X[f];
  const dz = FACING_Z[f];
  const bx = x - dx;
  const bz = z - dz; // base destination (retracted)
  const fx = x + 2 * dx;
  const fz = z + 2 * dz; // front position (in front of the extended head)
  moves.push({ x, y, z, id: AIR, meta: 0 });
  moves.push({ x: bx, y, z: bz, id, meta: c.world.getMeta(x, y, z) });
  // Sticky: pull the attached front block back to the head position — only
  // when it is unchanged since extension and solid (1.13). Sentinels:
  // -1 = unread, -2 = changed during extension (no pull).
  if (sticky && st.frontId >= 0 && st.frontId !== AIR) {
    const curId = c.world.getBlock(fx, y, fz);
    const curMeta = c.world.getMeta(fx, y, fz);
    if (curId === st.frontId && curMeta === st.frontMeta && getBlockDef(curId).solid) {
      moves.push({ x: fx, y, z: fz, id: AIR, meta: 0 });
      moves.push({ x: x + dx, y, z: z + dz, id: curId, meta: curMeta });
    }
  }
}

// ---------------------------------------------------------------------------
// Oak door (Phase 5A, design.md §8.4)
// ---------------------------------------------------------------------------

/**
 * Door power (design.md §8.4, 1.13): the BOTTOM half opens when it receives
 * ANY signal:
 *  - weak power from its 4 horizontal neighbors,
 *  - weak power from the block directly below (1.13: powered dust weak-powers
 *    the block directly above it — so dust below a door opens it),
 *  - strong power from the block directly below (e.g. a redstone block).
 */
export function doorPowered(c: ComponentCtx, x: number, y: number, z: number): boolean {
  for (let f = 0; f < 4; f++) {
    if (powerFromNeighbor(c.world, x, y, z, x + FACING_X[f], y, z + FACING_Z[f], c.power) > 0) return true;
  }
  if (y > 0) {
    const below = c.world.getBlock(x, y - 1, z);
    if (below === Block.RedstoneDust) return getStrength(c.world.getMeta(x, y - 1, z)) > 0;
    return strongPowerToAbove(c.world, x, y - 1, z, c.power) > 0;
  }
  return false;
}

/**
 * Door state machine: open while powered OR manually opened (right-click,
 * tracked in `manual` keyed by the BOTTOM half's posKey); closes when the
 * power is removed and the door was not manually opened. Only the bottom
 * half drives the door; the top half's open bit is kept in sync. Returns
 * true when a meta change was written.
 */
export function tickDoor(c: ComponentCtx, x: number, y: number, z: number, manual: Map<number, boolean>): boolean {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.OakDoor) return false;
  const meta = c.world.getMeta(x, y, z);
  if (isDoorTop(meta)) return false; // top half is passive
  const open = doorPowered(c, x, y, z) || manual.get(posKey(x, y, z)) === true;
  if (isDoorOpen(meta) === open) return false;
  c.write(x, y, z, id, setDoorOpen(meta, open));
  if (c.world.getBlock(x, y + 1, z) === Block.OakDoor) {
    c.write(x, y + 1, z, Block.OakDoor, setDoorOpen(c.world.getMeta(x, y + 1, z), open));
  }
  return true;
}

export function tickPiston(c: ComponentCtx, x: number, y: number, z: number, states: Map<number, PistonState>, moves: PistonWrite[]): void {
  const id = c.world.getBlock(x, y, z);
  if (id !== Block.Piston && id !== Block.StickyPiston) return;
  const sticky = id === Block.StickyPiston;
  const key = posKey(x, y, z);
  const f = getFacing(c.world.getMeta(x, y, z));
  const st = states.get(key);

  if (!st) {
    if (isPistonPowered(c, x, y, z) && canExtend(c, x, y, z, f)) {
      states.set(key, { phase: 'extending', ticks: PISTON_ACTION_TICKS, frontX: 0, frontY: 0, frontZ: 0, frontId: -1, frontMeta: 0 });
    }
    return;
  }

  if (st.phase === 'extending') {
    // Once started, extension completes even if power is removed (1.13) —
    // unless the push column became invalid (extend() re-validates and
    // aborts; the piston stays put and a fresh extension can start next
    // tick while it is powered).
    if (--st.ticks > 0) return;
    if (!extend(c, x, y, z, id, c.world.getMeta(x, y, z), f, st, moves)) {
      states.delete(key);
      return;
    }
    // The base moves to the head position — the runtime state follows it.
    const newX = x + FACING_X[f];
    const newZ = z + FACING_Z[f];
    states.delete(key);
    states.set(posKey(newX, y, newZ), st);
    return;
  }

  if (st.phase === 'extended') {
    const powered = isPistonPowered(c, x, y, z);
    if (!powered) {
      st.phase = 'retracting';
      st.ticks = PISTON_ACTION_TICKS;
    } else if (st.frontId !== -1) {
      // 1.13: if the front block changed during extension, retract without
      // pulling (mark the recorded front invalid so retract() skips the pull).
      const curId = c.world.getBlock(st.frontX, st.frontY, st.frontZ);
      const curMeta = c.world.getMeta(st.frontX, st.frontY, st.frontZ);
      if (curId !== st.frontId || curMeta !== st.frontMeta) st.frontId = -2;
    }
    return;
  }

  // retracting
  if (--st.ticks > 0) return;
  retract(c, x, y, z, id, f, st, sticky, moves);
  states.delete(key);
}
