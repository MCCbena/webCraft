/**
 * WebCraft — Redstone power model & dust propagation (Phase 2C, [redstone]).
 *
 * Java 1.13 semantics per docs/design.md §8.1 / §8.2:
 *  - Weak power: horizontal 4 neighbors. Strong power: the block above a
 *    powered block. A strongly powered block itself becomes a 15 source
 *    (strong power propagates up through a stack).
 *  - Dust: 1.13 fixed-point propagation. Each dust's target strength is the
 *    max of: (a) horizontal dust neighbor s-1; (b) horizontal power-source
 *    neighbor power-1; (c) strong power of the block below; (d) LINE RULE —
 *    a dust two blocks away in a straight line (dust in between) transmits
 *    full strength (15) without decay (see types.ts header for the
 *    simplification note).
 *  - Directional components (repeater/comparator) output only toward their
 *    facing, at full output strength (no -1 decay), weak+strong.
 *
 * Phase 5A additions (design.md §8.1):
 *  - Dust weak-powers the block directly ABOVE it (strength > 0) — via
 *    `weakPowerFromBelow` (used by plates, lamps, rails).
 *  - Hopper/dispenser/dropper with items power ONLY the block BEHIND them
 *    (weak 15) — item presence comes from `PowerCtx.hasItems` (5B contract).
 *  - Tripwire hook powers (weak 4 + strong above) while its string is
 *    tripped — via `PowerCtx.trippedHook` (runtime state in tick.ts).
 *  - Powered rail powers (weak 4 + strong above) when IT is powered: its
 *    block below is strongly powered OR a horizontal neighbor weak-powers
 *    it (dust included).
 *  - Daylight detector outputs 0-15 from the world time (weak 4 + block
 *    below + strong above); inverted = 15 − normal.
 *
 * Pure functions — no state of their own. Runtime state (observer output,
 * tripped hooks, container items, world time) is passed in via PowerCtx.
 */

import { AIR, Block, getFacing, getOutput, getStrength, isDaylightInverted, isOn } from '../world/blocks';
import type { World } from '../world/world';
import { daylightOutput } from '../world/time';
import {
  DUST_MAX_ITERATIONS,
  FACING_X,
  FACING_Z,
  MAX_POWER,
  getRepeaterOut,
  type Pos,
} from './types';

/** Runtime access to observer outputting state (kept in the Redstone class). */
export interface ObserverState {
  isOutputting(x: number, y: number, z: number): boolean;
}

/**
 * Runtime power context (Phase 5A). Built once per tick by the Redstone
 * class (tick.ts) from the RedstoneCtx + runtime state. Pure read access
 * for the power-model functions below.
 */
export interface PowerCtx {
  observers: ObserverState;
  /** 5B contract: container (hopper/dropper/dispenser) item presence. */
  hasItems(x: number, y: number, z: number): boolean;
  /** true while the tripwire hook at (x,y,z) has a tripped string. */
  trippedHook(x: number, y: number, z: number): boolean;
  /** current world time in ticks (0..23999) for the daylight detector. */
  worldTime: number;
}

/** Output strength of a directional component (repeater/comparator) from meta. */
export function componentOutput(id: number, meta: number): number {
  if (id === Block.Repeater) return getRepeaterOut(meta);
  if (id === Block.Comparator) return getOutput(meta);
  return 0;
}

/**
 * Power emitted by the block itself (direct source), 0 when not a source
 * (design.md §8.1). Containers (hopper/dispenser/dropper) are NOT general
 * sources — they power only the block BEHIND them when they have items
 * (handled in `powerFromNeighbor`, 1.13 compliant).
 */
export function directPower(world: World, id: number, meta: number, x: number, y: number, z: number, p: PowerCtx): number {
  switch (id) {
    case Block.RedstoneBlock:
      return MAX_POWER;
    case Block.RedstoneTorch:
    case Block.Lever:
    case Block.StoneButton:
    case Block.WoodButton:
    case Block.StonePressurePlate:
    case Block.WoodPressurePlate:
      return isOn(meta) ? MAX_POWER : 0;
    case Block.Observer:
      return p.observers.isOutputting(x, y, z) ? MAX_POWER : 0;
    case Block.RedstoneDust:
      return getStrength(meta);
    case Block.TripwireHook:
      return p.trippedHook(x, y, z) ? MAX_POWER : 0;
    case Block.PoweredRail:
      return isRailPowered(world, x, y, z, p) ? MAX_POWER : 0;
    case Block.DaylightDetector:
      return daylightOutput(p.worldTime, isDaylightInverted(meta));
    default:
      return 0;
  }
}

/**
 * A powered rail is "powered" (design.md §8.8) when its block below is
 * strongly powered, a horizontal neighbor weak-powers it (dust included),
 * or dust directly below weak-powers it (1.13 dust-above rule).
 */
export function isRailPowered(world: World, x: number, y: number, z: number, p: PowerCtx): boolean {
  if (y > 0 && strongPowerToAbove(world, x, y - 1, z, p) > 0) return true;
  for (let f = 0; f < 4; f++) {
    if (weakPower(world, x + FACING_X[f], y, z + FACING_Z[f], p) > 0) return true;
  }
  return weakPowerFromBelow(world, x, y, z, p) > 0;
}

/**
 * True when the block is strongly powered: the block below is a (transitive)
 * power source, a horizontal neighbor is a redstone block, or a directional
 * component (repeater/comparator) outputs toward it.
 * 1.13 nuance: a lit torch strong-powers ONLY the block below it, never its
 * 4 horizontal neighbors — so torches are not horizontal strong sources
 * (Phase 4 fix). Levers/buttons/plates power their attachment (the block
 * below), NOT horizontal neighbors — so they are excluded here. Dust does
 * not strongly power horizontally (its power is weak).
 */
export function isStronglyPowered(world: World, x: number, y: number, z: number, p: PowerCtx): boolean {
  if (y > 0 && strongPowerToAbove(world, x, y - 1, z, p) > 0) return true;
  for (let f = 0; f < 4; f++) {
    const nx = x + FACING_X[f];
    const nz = z + FACING_Z[f];
    const id = world.getBlock(nx, y, nz);
    if (id === Block.Repeater || id === Block.Comparator) {
      const meta = world.getMeta(nx, y, nz);
      // the component outputs toward us when its facing points from it to us:
      // opposite of the direction f (us → neighbor)
      if (getFacing(meta) === (f ^ 2) && componentOutput(id, meta) > 0) return true;
      continue;
    }
    if (id === Block.RedstoneBlock) return true;
  }
  return false;
}

/** Weak power delivered to horizontal neighbors (0 for directional components). */
export function weakPower(world: World, x: number, y: number, z: number, p: PowerCtx): number {
  const id = world.getBlock(x, y, z);
  if (id === AIR) return 0; // air is not a block — it cannot be (strongly) powered
  if (id === Block.Repeater || id === Block.Comparator) return 0; // output is directional only
  if (id === Block.Hopper || id === Block.Dispenser || id === Block.Dropper) {
    return 0; // containers power only the block BEHIND them (powerFromNeighbor)
  }
  const meta = world.getMeta(x, y, z);
  const d = directPower(world, id, meta, x, y, z, p);
  if (d > 0) return d;
  return isStronglyPowered(world, x, y, z, p) ? MAX_POWER : 0;
}

/** Strong power delivered to the block directly above (0 for directional components). */
export function strongPowerToAbove(world: World, x: number, y: number, z: number, p: PowerCtx): number {
  const id = world.getBlock(x, y, z);
  if (id === AIR) return 0; // air is not a block — it cannot be (strongly) powered
  if (id === Block.Repeater || id === Block.Comparator) return 0; // output goes forward, not up
  if (id === Block.Hopper || id === Block.Dispenser || id === Block.Dropper) {
    return 0; // containers power only the block BEHIND them (powerFromNeighbor)
  }
  const meta = world.getMeta(x, y, z);
  const d = directPower(world, id, meta, x, y, z, p);
  if (d > 0) return d;
  return isStronglyPowered(world, x, y, z, p) ? MAX_POWER : 0;
}

/**
 * Phase 5A: weak power the block BELOW (x, y-1, z) delivers upward.
 * 1.13: redstone dust weak-powers the block directly above it (strength > 0).
 */
export function weakPowerFromBelow(world: World, x: number, y: number, z: number, p: PowerCtx): number {
  if (y <= 0) return 0;
  if (world.getBlock(x, y - 1, z) === Block.RedstoneDust) {
    return getStrength(world.getMeta(x, y - 1, z));
  }
  return 0;
}

/**
 * Power the block at (nx,ny,nz) delivers to the block at (x,y,z)
 * (any of the 6 neighbor directions).
 */
export function powerFromNeighbor(world: World, x: number, y: number, z: number, nx: number, ny: number, nz: number, p: PowerCtx): number {
  const id = world.getBlock(nx, ny, nz);
  if (id === Block.Repeater || id === Block.Comparator) {
    if (ny !== y) return 0;
    const meta = world.getMeta(nx, ny, nz);
    const f = getFacing(meta);
    if (x - nx === FACING_X[f] && z - nz === FACING_Z[f]) return componentOutput(id, meta);
    return 0;
  }
  // Phase 5A: containers (hopper/dispenser/dropper) with items power ONLY
  // the block directly behind them (weak 15, design.md §8.1).
  if (id === Block.Hopper || id === Block.Dispenser || id === Block.Dropper) {
    if (ny !== y || !p.hasItems(nx, ny, nz)) return 0;
    const f = getFacing(world.getMeta(nx, ny, nz));
    // "behind" = opposite of the container's facing (the spout direction)
    return x - nx === -FACING_X[f] && z - nz === -FACING_Z[f] ? MAX_POWER : 0;
  }
  if (ny === y - 1) return strongPowerToAbove(world, nx, ny, nz, p);
  if (ny === y + 1) {
    // Phase 5A: the daylight detector also weak-powers the block directly
    // BELOW it (design.md §8.1: weak = horizontal 4 + below, strong = above).
    if (id === Block.DaylightDetector) {
      return directPower(world, id, world.getMeta(nx, ny, nz), nx, ny, nz, p);
    }
    return 0;
  }
  return weakPower(world, nx, ny, nz, p);
}

/**
 * Phase 5A: total power a block RECEIVES from its 6 neighbors (weak from
 * the 4 horizontal + the block above, strong from the block below) plus the
 * dust-above rule. Used by lamps (1.13: a lamp lights when powered from any
 * direction, including powered dust below). Pressure plates are pure
 * sensors (entity on top only) and intentionally do NOT use this.
 */
export function totalPowerReceived(world: World, x: number, y: number, z: number, p: PowerCtx): number {
  let m = 0;
  for (let f = 0; f < 4; f++) {
    const v = powerFromNeighbor(world, x, y, z, x + FACING_X[f], y, z + FACING_Z[f], p);
    if (v > m) m = v;
  }
  if (y < 255) {
    const v = powerFromNeighbor(world, x, y, z, x, y + 1, z, p);
    if (v > m) m = v;
  }
  if (y > 0) {
    const v = powerFromNeighbor(world, x, y, z, x, y - 1, z, p);
    if (v > m) m = v;
  }
  const v = weakPowerFromBelow(world, x, y, z, p);
  if (v > m) m = v;
  return m;
}

/**
 * Total power available at (x,y,z) as a repeater/comparator input
 * (the block behind the component).
 */
export function inputPowerAt(world: World, x: number, y: number, z: number, p: PowerCtx): number {
  const id = world.getBlock(x, y, z);
  if (id === Block.RedstoneDust) return getStrength(world.getMeta(x, y, z));
  const below = y > 0 ? strongPowerToAbove(world, x, y - 1, z, p) : 0;
  return Math.max(weakPower(world, x, y, z, p), below);
}

/**
 * Target strength for the dust at (x,y,z) — 1.13 fixed-point rule
 * (design.md §8.2). Pure read; no writes.
 */
export function computeDustTarget(world: World, x: number, y: number, z: number, p: PowerCtx): number {
  let m = 0;
  for (let f = 0; f < 4; f++) {
    const nx = x + FACING_X[f];
    const nz = z + FACING_Z[f];
    const idN = world.getBlock(nx, y, nz);
    if (idN === Block.RedstoneDust) {
      const sN = getStrength(world.getMeta(nx, y, nz));
      if (sN > 0) m = Math.max(m, sN - 1);
      // LINE RULE (design.md §8.2(d)): dust C two blocks away in a straight
      // line (dust N in between) transmits full strength without decay ONLY
      // when C is at full strength 15 — the line rule never raises C above
      // what normal neighbor propagation would give (Phase 4b: the
      // "sC > sN ? sC : sC - 1" formula was reverted; it produced
      // 14,13,14,13,... zigzag lines and self-sustaining lines).
      const cx2 = x + 2 * FACING_X[f];
      const cz2 = z + 2 * FACING_Z[f];
      if (world.getBlock(cx2, y, cz2) === Block.RedstoneDust && getStrength(world.getMeta(cx2, y, cz2)) === MAX_POWER) {
        m = MAX_POWER;
      }
    } else if (idN === Block.Repeater || idN === Block.Comparator) {
      // Directional output: full strength, no decay, only toward the facing.
      // The component at N outputs toward us (D) when its facing points from
      // N to D — the opposite of direction f (D → N).
      const metaN = world.getMeta(nx, y, nz);
      if (getFacing(metaN) === (f ^ 2)) m = Math.max(m, componentOutput(idN, metaN));
    } else {
      // powerFromNeighbor (not plain weakPower) so directional container
      // power is honored: a hopper/dispenser/dropper with items powers the
      // dust BEHIND it (design.md §8.1).
      const pw = powerFromNeighbor(world, x, y, z, nx, y, nz, p);
      if (pw > 0) m = Math.max(m, pw - 1);
    }
  }
  // (c) strong power of the block below (e.g. dust on redstone_block = 15)
  if (y > 0) m = Math.max(m, strongPowerToAbove(world, x, y - 1, z, p));
  // (Phase 5A) the daylight detector weak-powers the block directly below it
  // (design.md §8.1). 1.13: no other block powers dust from ABOVE (keeping
  // this detector-specific avoids plate/dust self-sustain loops).
  if (y < 255) {
    const above = world.getBlock(x, y + 1, z);
    if (above === Block.DaylightDetector) {
      m = Math.max(m, directPower(world, above, world.getMeta(x, y + 1, z), x, y + 1, z, p));
    }
  }
  return Math.min(MAX_POWER, m);
}

/** One fixed-point sweep over the dust list (deterministic order). Returns true when any strength changed. */
export function propagateDust(world: World, dust: Pos[], p: PowerCtx): boolean {
  let changed = false;
  for (const d of dust) {
    const t = computeDustTarget(world, d.x, d.y, d.z, p);
    const cur = getStrength(world.getMeta(d.x, d.y, d.z));
    if (t !== cur) {
      world.setBlock(d.x, d.y, d.z, Block.RedstoneDust, t);
      changed = true;
    }
  }
  return changed;
}

/** Iterate to a fixed point, capped at DUST_MAX_ITERATIONS sweeps. Returns true when any change happened. */
export function propagateDustToFixedPoint(world: World, dust: Pos[], p: PowerCtx): boolean {
  let changed = false;
  for (let i = 0; i < DUST_MAX_ITERATIONS; i++) {
    if (!propagateDust(world, dust, p)) break;
    changed = true;
  }
  return changed;
}
