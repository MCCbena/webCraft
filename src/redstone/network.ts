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
 * Pure functions — no state of their own. The observer outputting state is
 * runtime and passed in via ObserverState.
 */

import { AIR, Block, getFacing, getOutput, getStrength, isOn } from '../world/blocks';
import type { World } from '../world/world';
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

/** Output strength of a directional component (repeater/comparator) from meta. */
export function componentOutput(id: number, meta: number): number {
  if (id === Block.Repeater) return getRepeaterOut(meta);
  if (id === Block.Comparator) return getOutput(meta);
  return 0;
}

/**
 * Power emitted by the block itself (direct source), 0 when not a source
 * (design.md §8.1). Dispenser/dropper count as sources only when their meta
 * "has content" flag (bit 0) is set — kept simple per task (no content
 * system in this project).
 */
export function directPower(id: number, meta: number, x: number, y: number, z: number, observers: ObserverState): number {
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
      return observers.isOutputting(x, y, z) ? MAX_POWER : 0;
    case Block.RedstoneDust:
      return getStrength(meta);
    case Block.Dispenser:
    case Block.Dropper:
      return isOn(meta) ? MAX_POWER : 0;
    default:
      return 0;
  }
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
export function isStronglyPowered(world: World, x: number, y: number, z: number, observers: ObserverState): boolean {
  if (y > 0 && strongPowerToAbove(world, x, y - 1, z, observers) > 0) return true;
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
export function weakPower(world: World, x: number, y: number, z: number, observers: ObserverState): number {
  const id = world.getBlock(x, y, z);
  if (id === AIR) return 0; // air is not a block — it cannot be (strongly) powered
  if (id === Block.Repeater || id === Block.Comparator) return 0; // output is directional only
  const meta = world.getMeta(x, y, z);
  const d = directPower(id, meta, x, y, z, observers);
  if (d > 0) return d;
  return isStronglyPowered(world, x, y, z, observers) ? MAX_POWER : 0;
}

/** Strong power delivered to the block directly above (0 for directional components). */
export function strongPowerToAbove(world: World, x: number, y: number, z: number, observers: ObserverState): number {
  const id = world.getBlock(x, y, z);
  if (id === AIR) return 0; // air is not a block — it cannot be (strongly) powered
  if (id === Block.Repeater || id === Block.Comparator) return 0; // output goes forward, not up
  const meta = world.getMeta(x, y, z);
  const d = directPower(id, meta, x, y, z, observers);
  if (d > 0) return d;
  return isStronglyPowered(world, x, y, z, observers) ? MAX_POWER : 0;
}

/**
 * Power the block at (nx,ny,nz) delivers to the block at (x,y,z)
 * (any of the 6 neighbor directions).
 */
export function powerFromNeighbor(world: World, x: number, y: number, z: number, nx: number, ny: number, nz: number, observers: ObserverState): number {
  const id = world.getBlock(nx, ny, nz);
  if (id === Block.Repeater || id === Block.Comparator) {
    if (ny !== y) return 0;
    const meta = world.getMeta(nx, ny, nz);
    const f = getFacing(meta);
    if (x - nx === FACING_X[f] && z - nz === FACING_Z[f]) return componentOutput(id, meta);
    return 0;
  }
  if (ny === y - 1) return strongPowerToAbove(world, nx, ny, nz, observers);
  return weakPower(world, nx, ny, nz, observers);
}

/**
 * Total power available at (x,y,z) as a repeater/comparator input
 * (the block behind the component).
 */
export function inputPowerAt(world: World, x: number, y: number, z: number, observers: ObserverState): number {
  const id = world.getBlock(x, y, z);
  if (id === Block.RedstoneDust) return getStrength(world.getMeta(x, y, z));
  const below = y > 0 ? strongPowerToAbove(world, x, y - 1, z, observers) : 0;
  return Math.max(weakPower(world, x, y, z, observers), below);
}

/**
 * Target strength for the dust at (x,y,z) — 1.13 fixed-point rule
 * (design.md §8.2). Pure read; no writes.
 */
export function computeDustTarget(world: World, x: number, y: number, z: number, observers: ObserverState): number {
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
      const p = weakPower(world, nx, y, nz, observers);
      if (p > 0) m = Math.max(m, p - 1);
    }
  }
  // (c) strong power of the block below (e.g. dust on redstone_block = 15)
  if (y > 0) m = Math.max(m, strongPowerToAbove(world, x, y - 1, z, observers));
  return Math.min(MAX_POWER, m);
}

/** One fixed-point sweep over the dust list (deterministic order). Returns true when any strength changed. */
export function propagateDust(world: World, dust: Pos[], observers: ObserverState): boolean {
  let changed = false;
  for (const d of dust) {
    const t = computeDustTarget(world, d.x, d.y, d.z, observers);
    const cur = getStrength(world.getMeta(d.x, d.y, d.z));
    if (t !== cur) {
      world.setBlock(d.x, d.y, d.z, Block.RedstoneDust, t);
      changed = true;
    }
  }
  return changed;
}

/** Iterate to a fixed point, capped at DUST_MAX_ITERATIONS sweeps. Returns true when any change happened. */
export function propagateDustToFixedPoint(world: World, dust: Pos[], observers: ObserverState): boolean {
  let changed = false;
  for (let i = 0; i < DUST_MAX_ITERATIONS; i++) {
    if (!propagateDust(world, dust, observers)) break;
    changed = true;
  }
  return changed;
}
