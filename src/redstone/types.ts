/**
 * WebCraft — Redstone shared types & constants (Phase 2C, [redstone]).
 *
 * Java Edition 1.13 redstone semantics per docs/design.md §8.
 * Pure TS — no DOM/three.js — synchronous, deterministic, no timers/promises.
 *
 * META BYTE LAYOUT (see src/world/blocks.ts header for the full table):
 *   - dust:            bits 0-3 = signal strength 0-15
 *   - repeater:        bits 0-1 facing, bits 2-3 delay-1,
 *                      bits 4-7 = current output strength (written by this
 *                      module; not documented in blocks.ts — Phase 2C addition)
 *   - comparator:      bits 0-1 facing, bit 2 mode, bits 3-6 output
 *   - torch/lamp/lever/button/plate: bit 0 = on
 *
 * NOTE on the 1.13 "line rule" (design.md §8.2(d)): this implementation
 * transmits full strength (15) without decay along a straight dust line
 * (Dust D ← Dust N ← Dust C, C two blocks away) ONLY when C is at full
 * strength 15. Weaker signals decay 1 per block. This is the reading that
 * satisfies both required §8.4 scenarios: the exact torch-line decay test
 * (14,13,...,0 at the 15th dust) and the "dust on redstone_block = 15 passes
 * full strength to the dust two away" test. A plain "two-away at any
 * strength" rule would make straight lines oscillate (14,13,14,13,...) and
 * fail the decay test. See memory.md (Phase 2C notes).
 */

/**
 * Context the game (game.ts) provides to Redstone.tick() each 20 TPS tick.
 * `entityAbove(x,y,z)` reports whether an entity AABB overlaps the block
 * space at (x,y,z) — used for pressure plates (space above the plate).
 */
export interface RedstoneCtx {
  entityAbove(x: number, y: number, z: number): boolean;
  playerX: number;
  playerY: number;
  playerZ: number;
}

/** Full signal strength (design.md §8.1: power sources output 15). */
export const MAX_POWER = 15;
/** Cap on dust fixed-point iterations per round (design.md §8.2). */
export const DUST_MAX_ITERATIONS = 30;
/** Cap on dust+component convergence rounds per tick. */
export const DUST_MAX_ROUNDS = 3;
/** Piston push limit, blocks (head + chain, pistons included) — 1.13. */
export const PISTON_PUSH_LIMIT = 12;
/** Ticks from power change to piston action (≈2 ticks per design.md §8.3). */
export const PISTON_ACTION_TICKS = 2;
/** Observer output duration after a front-block change (design.md §8.3). */
export const OBSERVER_OUTPUT_TICKS = 2;
/** Button auto-off durations (design.md §8.3: stone 10 / wood 20 ticks). */
export const BUTTON_TICKS_STONE = 10;
export const BUTTON_TICKS_WOOD = 20;

/**
 * Block id range of all redstone-logic blocks in blocks.ts
 * (18 = RedstoneDust .. 34 = Dropper). Used for the fast universe scan.
 */
export const REDSTONE_ID_MIN = 18;
export const REDSTONE_ID_MAX = 34;

export function isRedstoneBlock(id: number): boolean {
  return id >= REDSTONE_ID_MIN && id <= REDSTONE_ID_MAX;
}

// --- Facing (blocks.ts convention: 0=south +Z, 1=west -X, 2=north -Z, 3=east +X) ---

/** unit vector X per facing index */
export const FACING_X = [0, -1, 0, 1];
/** unit vector Z per facing index */
export const FACING_Z = [1, 0, -1, 0];

/**
 * Snap a player yaw (radians, engine convention: forward = (-sin, -cos) in
 * X/Z) to the nearest 4-way block facing. Used when placing facing blocks.
 */
export function facingFromYaw(yaw: number): number {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx < 0 ? 1 /* west */ : 3 /* east */;
  return fz < 0 ? 2 /* north */ : 0 /* south */;
}

/**
 * Compact integer key for runtime state maps.
 * Valid for world coords x,z ∈ [-128,127], y ∈ [0,255] (centered world).
 */
export function posKey(x: number, y: number, z: number): number {
  return ((x + 128) << 16) | (y << 8) | (z + 128);
}

export interface Pos {
  x: number;
  y: number;
  z: number;
}

/** A redstone block found by the per-tick universe scan. */
export interface UniverseBlock extends Pos {
  id: number;
}

// --- Repeater output meta (bits 4-7; see file header) ---

export function getRepeaterOut(meta: number): number {
  return (meta & 0xf0) >>> 4;
}
export function setRepeaterOut(meta: number, strength: number): number {
  return (meta & 0x0f) | ((strength & 0x0f) << 4);
}
