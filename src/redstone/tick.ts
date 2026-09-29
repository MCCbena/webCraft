/**
 * WebCraft — Redstone 20 TPS tick (Phase 2C, [redstone]; Phase 5A: full-world
 * active region + tripwires + doors + new sources).
 *
 * `Redstone.tick(world, ctx)` is called once per 20 TPS tick from
 * game.ts (Game.tickRedstone()). Synchronous, deterministic, no timers.
 *
 * Phase 5A — FULL-WORLD ACTIVE REGION (design.md §8.2): the player 3×3-chunk
 * universe scan is GONE. Redstone state lives in sparse registries:
 *  - `components`: posKey → block for every registered component id
 *    (REDSTONE_COMPONENT_IDS), ticked every tick in sorted order;
 *  - `dust`: posKey → block for every redstone dust (fixed-point sweep).
 * Both are maintained incrementally: World tracks chunks whose block data
 * changed (World.drainChangedChunks); each tick we re-scan only those
 * chunks (budgeted) and rebuild their registry entries. A fresh world pays
 * one full scan (spread over a few ticks); steady state pays ~nothing.
 *
 * Per-tick order:
 *   1. Registry sync (changed chunks only).
 *   2. Tripwire tripping pass (player AABB vs string cells).
 *   3. Component state machines (pistons, observers, repeaters, comparators,
 *      buttons, pressure plates, doors) — deterministic sorted order.
 *   4. Apply resulting block changes (piston moves; component meta writes
 *      already applied via ctx.write).
 *   5. Recompute the dust network to a fixed point (capped), then re-evaluate
 *      the passive components (torch, lamp); bounded convergence rounds.
 *   6. Prune runtime state for blocks that no longer exist.
 *
 * Public game-facing API (5A):
 *  - worldEdit(world, x, y, z, id, meta) — the ONLY world write path the
 *    game/tests should use: applies the write, marks remesh, and maintains
 *    tripwire strings (mined hook / solid placed on a string cell /
 *    string cell replaced → the string is cleared).
 *  - toggleDoor(world, x, y, z) — right-click door toggle (5A owns this).
 *  - tryConnectTripwire(world, hook, eyePos, eyeDir) — string connection.
 *  - primeTnt(world, x, y, z) — 5B TNT priming entry point (sets the primed
 *    meta bit; the fuse/explosion state machine is 5B's).
 *  - isHookTripped(x, y, z) — query the tripped-hook set.
 */

import {
  AIR,
  Block,
  getFacing,
  getNotePitch,
  itemBlockId,
  isOn,
  isSolidBlock,
  isDoorTop,
  isDoorOpen,
  setDoorOpen,
  setOn,
  setSideOn,
} from '../world/blocks';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_VOLUME } from '../world/chunk';
import { WORLD_CHUNKS_Z } from '../world/world';
import type { World } from '../world/world';
import { PLAYER_HEIGHT } from '../player/player';
import type { ItemStack } from '../player/inventory';
import {
  BUTTON_TICKS_STONE,
  BUTTON_TICKS_WOOD,
  DUST_MAX_ROUNDS,
  FACING_X,
  FACING_Z,
  REDSTONE_COMPONENT_IDS,
  posKey,
  type RedstoneCtx,
  type UniverseBlock,
} from './types';
import {
  DISPENSER_COOLDOWN_TICKS,
  DROPPER_COOLDOWN_TICKS,
  HOPPER_TRANSFER_PER_TICK,
  ContainerRegistry,
  isContainerId,
} from './containers';
import {
  propagateDustToFixedPoint,
  totalPowerReceived,
  type ObserverState,
  type PowerCtx,
} from './network';
import {
  tickButton,
  tickDelayed,
  tickDoor,
  tickLamp,
  tickObserver,
  tickPlate,
  tickPiston,
  tickTorch,
  doorPowered,
  type ComponentCtx,
  type DelayedState,
  type ObserverEntry,
  type PistonState,
  type PistonWrite,
} from './components';

/** Max chunks re-scanned for the registry per tick (performance bound). */
const REGISTRY_SCAN_BUDGET = 32;
/** Tripwire string link reach in blocks (design.md §8.7). */
const TRIPWIRE_LINK_REACH = 40;
/**
 * Max DDA steps for the tripwire connection raycast: 4× the reach. A fully
 * diagonal ray through a 40×40×40 cube needs ≤ ~120 cell steps, so this is a
 * safe bound well beyond TRIPWIRE_LINK_REACH.
 */
const TRIPWIRE_DDA_MAX_STEPS = TRIPWIRE_LINK_REACH * 4;

// --- Phase 5B: TNT / piston damage (design.md §8.3/§8.4) --------------------
/** TNT fuse length in ticks (80 = 4 s, 1.13). */
export const TNT_FUSE_TICKS = 80;
/** TNT explosion radius (Euclidean, from the TNT block center, 1.13). */
export const TNT_EXPLOSION_RADIUS = 4;
/** Peak TNT damage at the explosion center (decays to 0 at distance 5). */
export const TNT_MAX_DAMAGE = 12;
/** Distance (blocks) at which TNT damage reaches 0. */
export const TNT_DAMAGE_FALLOFF = 5;
/** Piston-push damage when the head lands on the player (1.13). */
export const PISTON_PUSH_DAMAGE = 2;
/** Player center offset above the feet (half of the 1.8-tall AABB). */
const PLAYER_CENTER_OFFSET = PLAYER_HEIGHT / 2;

/** Decode a posKey back to world coords (inverse of types.posKey). */
function decodeKey(k: number): { x: number; y: number; z: number } {
  return { x: (k >>> 16) - 128, y: (k >>> 8) & 0xff, z: (k & 0xff) - 128 };
}

/**
 * The string cells STRICTLY BETWEEN the two hook endpoints of a valid
 * tripwire link (horizontal same-Y line on one axis, or a straight vertical
 * line). Returns null when the endpoints are not a valid link geometry.
 */
function tripwireCellsBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): { x: number; y: number; z: number }[] | null {
  if (a.y === b.y && (a.x === b.x || a.z === b.z)) {
    const sx = Math.sign(b.x - a.x);
    const sz = Math.sign(b.z - a.z);
    const cells: { x: number; y: number; z: number }[] = [];
    let x = a.x + sx;
    let z = a.z + sz;
    while (x !== b.x || z !== b.z) {
      cells.push({ x, y: a.y, z });
      x += sx;
      z += sz;
    }
    return cells;
  }
  if (a.x === b.x && a.z === b.z) {
    const sy = Math.sign(b.y - a.y);
    const cells: { x: number; y: number; z: number }[] = [];
    let y = a.y + sy;
    while (y !== b.y) {
      cells.push({ x: a.x, y, z: a.z });
      y += sy;
    }
    return cells;
  }
  return null;
}

export class Redstone {
  /** Phase 5A: sparse component registry (posKey → block). */
  private readonly components = new Map<number, UniverseBlock>();
  /** Phase 5A: sparse dust set (posKey → block). */
  private readonly dust = new Map<number, UniverseBlock>();
  /** chunk slot → registry keys owned by that chunk (for rescan cleanup). */
  private readonly chunkReg = new Map<number, Set<number>>();

  /** repeater/comparator runtime delay states (position key → state) */
  private readonly repeaters = new Map<number, DelayedState>();
  private readonly comparators = new Map<number, DelayedState>();
  /** observer: position key → previous front state + output countdown */
  private readonly observers = new Map<number, ObserverEntry>();
  /** piston: position key → extension state */
  private readonly pistons = new Map<number, PistonState>();
  /** button: position key → remaining on ticks */
  private readonly buttons = new Map<number, number>();
  /** door (Phase 5A): bottom-half position key → manually opened (right-click) */
  private readonly doors = new Map<number, boolean>();
  /** tripwire (Phase 5A): hook posKey ↔ partner hook posKey */
  private readonly tripwireLinks = new Map<number, number>();
  /** tripwire (Phase 5A): hooks whose string is currently tripped */
  private trippedHooks = new Set<number>();

  // --- Phase 5B: container contents + TNT + note + dropper/dispenser -------
  /** container content state, keyed by posKey (follows the blocks). */
  readonly containers = new ContainerRegistry();
  /** primed TNT fuse countdown, posKey → ticks remaining. */
  private readonly tntFuse = new Map<number, number>();
  /** TNT power state (rising-edge detection), posKey → was powered last tick. */
  private readonly tntPowered = new Map<number, boolean>();
  /** note block power state (rising-edge detection), posKey → was powered. */
  private readonly notePowered = new Map<number, boolean>();
  /** dropper eject cooldown, posKey → ticks remaining. */
  private readonly dropperCooldown = new Map<number, number>();
  /** dispenser use cooldown, posKey → ticks remaining. */
  private readonly dispenserCooldown = new Map<number, number>();

  /** Runtime power context, rebuilt each tick from the RedstoneCtx. */
  private power: PowerCtx = {
    observers: { isOutputting: () => false },
    hasItems: () => false,
    trippedHook: () => false,
    worldTime: 0,
  };

  private readonly obsState: ObserverState = {
    isOutputting: (x, y, z) => (this.observers.get(posKey(x, y, z))?.ticks ?? 0) > 0,
  };

  /** Query: is the tripwire hook at (x,y,z) currently tripped? */
  isHookTripped(x: number, y: number, z: number): boolean {
    return this.trippedHooks.has(posKey(x, y, z));
  }

  /**
   * 5B contract — prime a TNT (sets the primed meta bit + remesh mark) and
   * arms the fuse countdown (TNT_FUSE_TICKS). The fuse/explosion state machine
   * (Block.Tnt tick case) counts it down and detonates at 0. Idempotent:
   * re-priming an already-primed TNT just refreshes the fuse.
   */
  primeTnt(world: World, x: number, y: number, z: number): void {
    if (world.getBlock(x, y, z) !== Block.Tnt) return;
    if (!isOn(world.getMeta(x, y, z))) {
      world.setBlock(x, y, z, Block.Tnt, setOn(world.getMeta(x, y, z), true));
      world.markDirtyAround(x, y, z);
    }
    this.tntFuse.set(posKey(x, y, z), TNT_FUSE_TICKS);
  }

  /**
   * The game's world-write path (Phase 5A): applies the block write, marks
   * the remesh, and maintains tripwire strings:
   *  - a tripwire hook is removed → its string is cleared;
   *  - a tripwire string cell is replaced (mined, or any block placed on it,
   *    solid or not) → the string is cleared.
   */
  worldEdit(world: World, x: number, y: number, z: number, id: number, meta: number): void {
    const oldId = world.getBlock(x, y, z);
    world.setBlock(x, y, z, id, meta);
    world.markDirtyAround(x, y, z);
    // Phase 5B: keep container contents in lockstep with the blocks.
    this.containers.reconcile(x, y, z, oldId, id);
    if (oldId === Block.TripwireHook) this.clearStringAt(world, x, y, z);
    else if (oldId === Block.Tripwire && id !== Block.Tripwire) this.clearStringAt(world, x, y, z);
  }

  /**
   * Right-click door toggle (Phase 5A, design.md §8.4). Works on either
   * half. A powered door stays open (the toggle is ignored while powered);
   * otherwise the manual-open flag flips and both halves update immediately.
   */
  toggleDoor(world: World, x: number, y: number, z: number): void {
    if (world.getBlock(x, y, z) !== Block.OakDoor) return;
    let by = y;
    if (isDoorTop(world.getMeta(x, y, z))) by = y - 1; // top half → bottom is below
    if (world.getBlock(x, by, z) !== Block.OakDoor) return;
    const key = posKey(x, by, z);
    const c: ComponentCtx = { world, power: this.power, write: (wx, wy, wz, id, m) => world.setBlock(wx, wy, wz, id, m) };
    if (doorPowered(c, x, by, z)) return; // powered doors are locked open
    if (isDoorOpen(world.getMeta(x, by, z))) {
      this.doors.delete(key);
      this.applyDoorOpen(world, x, by, z, false);
    } else {
      this.doors.set(key, true);
      this.applyDoorOpen(world, x, by, z, true);
    }
  }

  /** Set the door open state on both halves (with remesh marks). */
  private applyDoorOpen(world: World, x: number, y: number, z: number, open: boolean): void {
    world.setBlock(x, y, z, Block.OakDoor, setDoorOpen(world.getMeta(x, y, z), open));
    world.markDirtyAround(x, y, z);
    if (world.getBlock(x, y + 1, z) === Block.OakDoor) {
      world.setBlock(x, y + 1, z, Block.OakDoor, setDoorOpen(world.getMeta(x, y + 1, z), open));
      world.markDirtyAround(x, y + 1, z);
    }
  }

  /**
   * Tripwire string connection (Phase 5A, design.md §8.7): from the hook at
   * (hx,hy,hz), raycast up to TRIPWIRE_LINK_REACH blocks along the eye
   * direction. If the ray hits ANOTHER tripwire hook that shares the same Y
   * (horizontal line on one axis) or the same X/Z (vertical line), and every
   * cell in between is air/tripwire, the string is created: tripwire blocks
   * fill the intermediate cells, the link is recorded (both directions),
   * and both hooks get their "has string" meta bit. Returns true on success.
   */
  tryConnectTripwire(
    world: World,
    hx: number, hy: number, hz: number,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): boolean {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
    let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
    let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
    // DDA (same stepping as game.raycast); air/tripwire are passable,
    // anything else blocks the ray; a hook is the only possible target.
    for (let i = 0; i < TRIPWIRE_DDA_MAX_STEPS; i++) {
      const id = world.getBlock(x, y, z);
      if (id === Block.TripwireHook) {
        if (x === hx && y === hy && z === hz) {
          // the source hook's own cell — keep stepping
        } else if (this.canLink(world, hx, hy, hz, x, y, z)) {
          this.createLink(world, hx, hy, hz, x, y, z);
          return true;
        } else {
          return false;
        }
      } else if (id !== AIR && id !== Block.Tripwire) {
        return false; // blocked
      }
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        if (tMaxX > TRIPWIRE_LINK_REACH) return false;
        x += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY <= tMaxZ) {
        if (tMaxY > TRIPWIRE_LINK_REACH) return false;
        y += stepY;
        tMaxY += tDeltaY;
      } else {
        if (tMaxZ > TRIPWIRE_LINK_REACH) return false;
        z += stepZ;
        tMaxZ += tDeltaZ;
      }
    }
    return false;
  }

  /** Valid link geometry + clear intermediate cells + no existing string. */
  private canLink(world: World, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const aKey = posKey(ax, ay, az);
    const bKey = posKey(bx, by, bz);
    if (this.tripwireLinks.has(aKey) || this.tripwireLinks.has(bKey)) return false; // one string per hook
    const cells = tripwireCellsBetween({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz });
    if (!cells || cells.length === 0) return false;
    for (const c of cells) {
      const id = world.getBlock(c.x, c.y, c.z);
      if (id !== AIR && id !== Block.Tripwire) return false;
    }
    return true;
  }

  /** Create the string: fill cells, record the link, flag both hooks. */
  private createLink(world: World, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const aKey = posKey(ax, ay, az);
    const bKey = posKey(bx, by, bz);
    for (const c of tripwireCellsBetween({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz })!) {
      world.setBlock(c.x, c.y, c.z, Block.Tripwire);
      world.markDirtyAround(c.x, c.y, c.z);
    }
    this.tripwireLinks.set(aKey, bKey);
    this.tripwireLinks.set(bKey, aKey);
    for (const h of [
      { x: ax, y: ay, z: az },
      { x: bx, y: by, z: bz },
    ]) {
      const meta = world.getMeta(h.x, h.y, h.z);
      world.setBlock(h.x, h.y, h.z, Block.TripwireHook, setSideOn(meta, true));
      world.markDirtyAround(h.x, h.y, h.z);
    }
  }

  /** Clear the string that involves (x,y,z) (as endpoint or intermediate cell). */
  private clearStringAt(world: World, x: number, y: number, z: number): void {
    const k = posKey(x, y, z);
    const other = this.tripwireLinks.get(k);
    if (other !== undefined) {
      this.clearLink(world, k, other);
      return;
    }
    for (const [aKey, bKey] of this.tripwireLinks) {
      const cells = tripwireCellsBetween(decodeKey(aKey), decodeKey(bKey));
      if (!cells) continue;
      if (cells.some((c) => c.x === x && c.y === y && c.z === z)) {
        this.clearLink(world, aKey, bKey);
        return;
      }
    }
  }

  /** Remove a link: clear the string cells, un-flag both hooks, drop tripped state. */
  private clearLink(world: World, aKey: number, bKey: number): void {
    this.tripwireLinks.delete(aKey);
    this.tripwireLinks.delete(bKey);
    this.trippedHooks.delete(aKey);
    this.trippedHooks.delete(bKey);
    const a = decodeKey(aKey);
    const b = decodeKey(bKey);
    const cells = tripwireCellsBetween(a, b);
    if (cells) {
      for (const c of cells) {
        if (world.getBlock(c.x, c.y, c.z) === Block.Tripwire) {
          world.setBlock(c.x, c.y, c.z, AIR);
          world.markDirtyAround(c.x, c.y, c.z);
        }
      }
    }
    for (const h of [a, b]) {
      if (world.getBlock(h.x, h.y, h.z) === Block.TripwireHook) {
        world.setBlock(h.x, h.y, h.z, Block.TripwireHook, setSideOn(world.getMeta(h.x, h.y, h.z), false));
        world.markDirtyAround(h.x, h.y, h.z);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ticking
  // -------------------------------------------------------------------------

  /**
   * Press a button (called from the game's right-click interact path).
   * Turns it on and arms the auto-off countdown (stone 10 / wood 20 ticks).
   */
  pressButton(world: World, x: number, y: number, z: number): void {
    const id = world.getBlock(x, y, z);
    if (id !== Block.StoneButton && id !== Block.WoodButton) return;
    world.setBlock(x, y, z, id, setOn(world.getMeta(x, y, z), true));
    this.buttons.set(posKey(x, y, z), id === Block.StoneButton ? BUTTON_TICKS_STONE : BUTTON_TICKS_WOOD);
  }

  /** One 20 TPS redstone tick (see file header for the pipeline). */
  tick(world: World, ctx: RedstoneCtx): void {
    // (0) Build the runtime power context for this tick.
    this.power = {
      observers: this.obsState,
      hasItems: (x, y, z) => ctx.hasItems?.(x, y, z) ?? false,
      trippedHook: (x, y, z) => this.trippedHooks.has(posKey(x, y, z)),
      worldTime: ctx.worldTime ?? 0,
    };

    // (1) Registry sync — rescan only the chunks whose data changed.
    this.syncRegistry(world);

    // (2) Tripwire tripping pass (player AABB vs the string cells).
    this.tickTripwires(ctx);

    // (3) Component state machines (deterministic sorted order).
    const positions = [...this.components.values()].sort((a, b) => posKey(a.x, a.y, a.z) - posKey(b.x, b.y, b.z));
    const c: ComponentCtx = {
      world,
      power: this.power,
      write: (x, y, z, id, meta) => this.write(world, x, y, z, id, meta),
    };
    const moves: PistonWrite[] = [];
    const headDests: { x: number; y: number; z: number }[] = [];
    for (const p of positions) {
      switch (p.id) {
        case Block.Piston:
        case Block.StickyPiston:
          tickPiston(c, p.x, p.y, p.z, this.pistons, moves, headDests);
          break;
        case Block.Observer:
          tickObserver(c, p.x, p.y, p.z, this.observers);
          break;
        case Block.Repeater:
          tickDelayed(c, p.x, p.y, p.z, this.repeaters);
          break;
        case Block.Comparator:
          tickDelayed(c, p.x, p.y, p.z, this.comparators);
          break;
        case Block.StoneButton:
        case Block.WoodButton:
          tickButton(c, p.x, p.y, p.z, this.buttons);
          break;
        case Block.StonePressurePlate:
        case Block.WoodPressurePlate:
          tickPlate(c, p.x, p.y, p.z, ctx.entityAbove);
          break;
        case Block.OakDoor:
          tickDoor(c, p.x, p.y, p.z, this.doors);
          break;
        // --- Phase 5B cases -------------------------------------------------
        case Block.Hopper:
          this.tickHopper(p.x, p.y, p.z);
          break;
        case Block.Dropper:
          this.tickDropper(world, p.x, p.y, p.z);
          break;
        case Block.Dispenser:
          this.tickDispenser(world, p.x, p.y, p.z);
          break;
        case Block.Tnt:
          this.tickTnt(world, p.x, p.y, p.z, ctx);
          break;
        case Block.NoteBlock:
          this.tickNote(world, p.x, p.y, p.z, ctx);
          break;
      }
    }

    // (4) Apply piston moves; patch the registries (chunk rescans also
    // reconcile on the next tick — the immediate patch keeps same-tick
    // behavior consistent with the old universe patching).
    if (moves.length > 0) {
      // Phase 5B pre-pass: relocate the runtime state of pushed blocks
      // (container contents + primed-TNT fuse) BEFORE the world writes, so the
      // clear→reconcile that follows does not destroy the moved state first.
      for (const m of moves) {
        const from = m.movedFrom;
        if (!from) continue;
        this.containers.move(from.x, from.y, from.z, m.x, m.y, m.z);
        const fk = posKey(from.x, from.y, from.z);
        const tk = posKey(m.x, m.y, m.z);
        const fuse = this.tntFuse.get(fk);
        if (fuse !== undefined) {
          this.tntFuse.delete(fk);
          this.tntFuse.set(tk, fuse);
        }
        const tntPow = this.tntPowered.get(fk);
        if (tntPow !== undefined) {
          this.tntPowered.delete(fk);
          this.tntPowered.set(tk, tntPow);
        }
      }
      for (const m of moves) {
        const oldId = world.getBlock(m.x, m.y, m.z);
        world.setBlock(m.x, m.y, m.z, m.id, m.meta);
        world.markDirtyAround(m.x, m.y, m.z); // shared helper (Phase 4 DRY)
        this.patchRegistry(world, m.x, m.y, m.z, m.id);
        this.containers.reconcile(m.x, m.y, m.z, oldId, m.id); // Phase 5B
        // A pushed solid landing on a tripwire string cell breaks the string.
        if (m.id !== AIR && m.id !== Block.Tripwire && isSolidBlock(m.id)) {
          this.clearStringAt(world, m.x, m.y, m.z);
        }
      }
      // Phase 5B: piston push damage — if the head's destination AABB
      // overlaps the player, deal PISTON_PUSH_DAMAGE (survival only, via the
      // ctx hook; the piston still extended).
      for (const hd of headDests) {
        if (ctx.entityAbove(hd.x, hd.y, hd.z)) {
          ctx.onPlayerDamage?.(PISTON_PUSH_DAMAGE, 'piston');
          break;
        }
      }
      // Read the front block of just-extended pistons (after the push).
      for (const st of this.pistons.values()) {
        if (st.frontId === -1) {
          st.frontId = world.getBlock(st.frontX, st.frontY, st.frontZ);
          st.frontMeta = world.getMeta(st.frontX, st.frontY, st.frontZ);
        }
      }
    }

    // (5) Dust fixed point + passive components, bounded convergence.
    for (let round = 0; round < DUST_MAX_ROUNDS; round++) {
      const dustList = [...this.dust.values()];
      let changed = propagateDustToFixedPoint(world, dustList, this.power);
      for (const p of positions) {
        if (p.id === Block.RedstoneTorch) changed = tickTorch(c, p.x, p.y, p.z) || changed;
        else if (p.id === Block.RedstoneLamp) changed = tickLamp(c, p.x, p.y, p.z) || changed;
      }
      if (!changed) break;
      // A torch/lamp change can alter the dust — run one more round (capped).
    }

    // (6) Prune runtime state for blocks that no longer exist.
    const live = new Set<number>(this.components.keys());
    for (const k of this.dust.keys()) live.add(k);
    for (const map of [
      this.repeaters,
      this.comparators,
      this.observers,
      this.pistons,
      this.buttons,
      this.doors,
      this.tntFuse,
      this.tntPowered,
      this.notePowered,
      this.dropperCooldown,
      this.dispenserCooldown,
    ]) {
      for (const k of [...map.keys()]) {
        if (!live.has(k)) map.delete(k);
      }
    }
    // Phase 5B: container state is pruned by the world-write reconcile
    // (worldEdit / piston moves / explosion); the registry is not component-keyed.
  }

  // --- helpers -------------------------------------------------------------

  /** Write a block and mark this chunk (plus border neighbors) for remesh. */
  private write(world: World, x: number, y: number, z: number, id: number, meta: number): void {
    world.setBlock(x, y, z, id, meta);
    world.markDirtyAround(x, y, z); // shared helper (Phase 4 DRY)
  }

  /**
   * Rebuild the registry entries for the chunks whose data changed since the
   * last sync (budgeted — the remainder stays queued in the World).
   */
  private syncRegistry(world: World): void {
    const slots = world.drainChangedChunks(REGISTRY_SCAN_BUDGET);
    for (const slot of slots) {
      const cx = Math.floor(slot / WORLD_CHUNKS_Z) - 8;
      const cz = (slot % WORLD_CHUNKS_Z) - 8;
      let set = this.chunkReg.get(slot);
      if (!set) {
        set = new Set<number>();
        this.chunkReg.set(slot, set);
      }
      for (const k of [...set]) {
        this.components.delete(k);
        this.dust.delete(k);
      }
      set.clear();
      const chunk = world.getChunk(cx, cz);
      if (!chunk) return;
      const ids = chunk.ids;
      const bx = cx * CHUNK_SIZE_X;
      const bz = cz * CHUNK_SIZE_Z;
      for (let i = 0; i < CHUNK_VOLUME; i++) {
        const id = ids[i];
        if (id === AIR) continue;
        const x = bx + (i & 15);
        const z = bz + ((i >> 4) & 15);
        const y = i >> 8;
        const k = posKey(x, y, z);
        if (id === Block.RedstoneDust) {
          this.dust.set(k, { x, y, z, id });
        } else if (REDSTONE_COMPONENT_IDS.has(id)) {
          this.components.set(k, { x, y, z, id });
        } else {
          continue;
        }
        set.add(k);
      }
    }
  }

  /** Immediately register/unregister a block after a piston move. */
  private patchRegistry(world: World, x: number, y: number, z: number, id: number): void {
    const k = posKey(x, y, z);
    if (id === Block.RedstoneDust) {
      this.dust.delete(k);
      this.components.delete(k);
      this.dust.set(k, { x, y, z, id });
    } else if (REDSTONE_COMPONENT_IDS.has(id)) {
      this.dust.delete(k);
      this.components.delete(k);
      this.components.set(k, { x, y, z, id });
    } else {
      this.dust.delete(k);
      this.components.delete(k);
    }
    // Keep the per-chunk key set in sync (best effort; the next rescan of
    // the chunk reconciles fully).
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const slot = (cx + 8) * WORLD_CHUNKS_Z + (cz + 8);
    const set = this.chunkReg.get(slot);
    if (set) {
      if (id === Block.RedstoneDust || REDSTONE_COMPONENT_IDS.has(id)) set.add(k);
      else set.delete(k);
    }
  }

  /**
   * Tripwire tripping pass: for every link, if the player AABB overlaps any
   * of the string cells both endpoint hooks are tripped (they then output
   * 15 via the power model until the player leaves all cells of that string).
   */
  private tickTripwires(ctx: RedstoneCtx): void {
    if (this.tripwireLinks.size === 0) {
      this.trippedHooks = new Set<number>();
      return;
    }
    const tripped = new Set<number>();
    for (const [aKey, bKey] of this.tripwireLinks) {
      if (bKey < aKey) continue; // each link once
      const a = decodeKey(aKey);
      const b = decodeKey(bKey);
      const cells = tripwireCellsBetween(a, b);
      if (!cells) continue;
      for (const c of cells) {
        if (ctx.entityAbove(c.x, c.y, c.z)) {
          tripped.add(aKey);
          tripped.add(bKey);
          break;
        }
      }
    }
    this.trippedHooks = tripped;
  }

  // -------------------------------------------------------------------------
  // Phase 5B: containers, TNT, note block (design.md §8.4/§8.5)
  // -------------------------------------------------------------------------

  /** Container slots for the GUI (null when there is no container here). */
  getContainerSlots(x: number, y: number, z: number): (ItemStack | null)[] | null {
    return this.containers.slots(x, y, z) ?? null;
  }

  /** Number of slots the container at (x,y,z) has (0 when none). */
  containerSlotCount(x: number, y: number, z: number): number {
    return this.containers.slotCount(x, y, z);
  }

  /**
   * Phase 5B: break a container — return ALL of its contents to the player via
   * `addItem(id, count)` and destroy the state. Returns the total item count
   * returned. Pure (the caller supplies the inventory sink), so it is directly
   * unit-testable. The game's survival break path uses this (creative just
   * breaks instantly without calling it).
   */
  drainContainerToInventory(x: number, y: number, z: number, addItem: (id: number, count: number) => void): number {
    const slots = this.containers.slots(x, y, z);
    let returned = 0;
    if (slots) {
      for (const s of slots) {
        if (s) {
          addItem(s.id, s.count);
          returned += s.count;
        }
      }
    }
    this.containers.destroy(x, y, z);
    return returned;
  }

  /** Place a block + remesh + reconcile container state (dropper/dispenser). */
  private placeBlock(world: World, x: number, y: number, z: number, id: number, meta: number): void {
    const oldId = world.getBlock(x, y, z);
    world.setBlock(x, y, z, id, meta);
    world.markDirtyAround(x, y, z);
    this.containers.reconcile(x, y, z, oldId, id);
  }

  /** Remove a block (set to air) + remesh + reconcile container state. */
  private removeBlock(world: World, x: number, y: number, z: number): void {
    const oldId = world.getBlock(x, y, z);
    if (oldId === AIR) return;
    world.setBlock(x, y, z, AIR);
    world.markDirtyAround(x, y, z);
    this.containers.reconcile(x, y, z, oldId, AIR);
  }

  /**
   * Hopper (1.13, §8.5): every tick, pull up to HOPPER_TRANSFER_PER_TICK items
   * from the container directly above into itself, then push up to the same
   * into the container directly below. Items enter the top and exit the bottom.
   */
  private tickHopper(x: number, y: number, z: number): void {
    if (this.containers.has(x, y + 1, z) && this.containers.hasRoom(x, y, z)) {
      this.containers.transfer(x, y + 1, z, x, y, z, HOPPER_TRANSFER_PER_TICK);
    }
    if (this.containers.has(x, y - 1, z) && this.containers.hasRoom(x, y - 1, z)) {
      this.containers.transfer(x, y, z, x, y - 1, z, HOPPER_TRANSFER_PER_TICK);
    }
  }

  /**
   * Shared "power gate + N-tick cooldown" preamble for dropper/dispenser (DRY).
   * Returns true when the action (eject/use) should fire this tick and updates
   * the cooldown map:
   *  - unpowered → the key is deleted (the cycle restarts on the next power-on);
   *  - the first powered tick starts the cycle at `ticks`;
   *  - the cycle counts down one per tick; at 0 the action fires and the cycle
   *    restarts at `ticks` (i.e. the action fires every `ticks`-th tick).
   */
  private cooldownGate(map: Map<number, number>, key: number, powered: boolean, ticks: number): boolean {
    if (!powered) {
      map.delete(key);
      return false;
    }
    if (map.get(key) === undefined) map.set(key, ticks);
    const rem = map.get(key)! - 1;
    if (rem > 0) {
      map.set(key, rem);
      return false;
    }
    map.set(key, ticks); // restart the cycle
    return true;
  }

  /**
   * Dropper (1.13, §8.5): while powered, every DROPPER_COOLDOWN_TICKS ticks
   * eject one item in the facing direction. Front air + placeable block item →
   * place the block; front a container → insert one item (if room); otherwise
   * the item stays (no ejection, no cooldown reset).
   */
  private tickDropper(world: World, x: number, y: number, z: number): void {
    const key = posKey(x, y, z);
    const powered = totalPowerReceived(world, x, y, z, this.power) > 0;
    if (!this.cooldownGate(this.dropperCooldown, key, powered, DROPPER_COOLDOWN_TICKS)) return;
    const stack = this.containers.firstItem(x, y, z);
    if (!stack) return; // empty → nothing to eject
    const f = getFacing(world.getMeta(x, y, z));
    const fx = x + FACING_X[f];
    const fz = z + FACING_Z[f];
    const frontId = world.getBlock(fx, y, fz);
    if (frontId === AIR) {
      const bid = itemBlockId(stack.id);
      if (bid !== AIR) {
        this.containers.removeOne(x, y, z);
        this.placeBlock(world, fx, y, fz, bid, 0);
      }
      // non-placeable item on an air front: it stays (no ejection)
    } else if (isContainerId(frontId) && this.containers.hasRoom(fx, y, fz)) {
      this.containers.removeOne(x, y, z);
      this.containers.insertOne(fx, y, fz, stack.id);
    }
    // a blocked/unsuitable front keeps the item (no ejection) — 1.13
  }

  /**
   * Dispenser (1.13, §8.5): while powered, every DISPENSER_COOLDOWN_TICKS
   * ticks "use" one item in the facing direction. The documented 1.13 subset:
   *   - placeable block item → place it (front air);
   *   - TNT item → place AND prime a TNT (front air), or prime an adjacent TNT;
   *   - door in front → toggle it open↔close;
   *   - any other item → no-op (the item is consumed ONLY on a successful use).
   */
  private tickDispenser(world: World, x: number, y: number, z: number): void {
    const key = posKey(x, y, z);
    const powered = totalPowerReceived(world, x, y, z, this.power) > 0;
    if (!this.cooldownGate(this.dispenserCooldown, key, powered, DISPENSER_COOLDOWN_TICKS)) return;
    const stack = this.containers.firstItem(x, y, z);
    if (!stack) return; // empty → nothing to use
    const f = getFacing(world.getMeta(x, y, z));
    const fx = x + FACING_X[f];
    const fz = z + FACING_Z[f];
    const frontId = world.getBlock(fx, y, fz);
    const bid = itemBlockId(stack.id);
    let success = false;
    if (frontId === AIR) {
      if (bid === Block.Tnt) {
        this.placeBlock(world, fx, y, fz, Block.Tnt, 0);
        this.primeTnt(world, fx, y, fz);
        success = true;
      } else if (bid !== AIR) {
        this.placeBlock(world, fx, y, fz, bid, 0);
        success = true;
      }
    } else if (frontId === Block.OakDoor) {
      this.toggleDoor(world, fx, y, fz);
      success = true;
    } else if (frontId === Block.Tnt) {
      this.primeTnt(world, fx, y, fz);
      success = true;
    }
    // other items → no-op (item NOT consumed)
    if (success) this.containers.removeOne(x, y, z);
  }

  /**
   * TNT (1.13, §8.4): a rising edge of power primes a normal (unprimed) TNT;
   * a primed TNT counts its TNT_FUSE_TICKS fuse down and detonates at 0.
   * (A primed fuse cannot be cancelled by removing the power — 1.13.)
   */
  private tickTnt(world: World, x: number, y: number, z: number, ctx: RedstoneCtx): void {
    const key = posKey(x, y, z);
    const powered = totalPowerReceived(world, x, y, z, this.power) > 0;
    const wasPowered = this.tntPowered.get(key) ?? false;
    if (powered && !wasPowered && !isOn(world.getMeta(x, y, z))) {
      this.primeTnt(world, x, y, z);
    }
    this.tntPowered.set(key, powered);
    if (isOn(world.getMeta(x, y, z))) {
      const rem = this.tntFuse.get(key) ?? TNT_FUSE_TICKS; // edge: primed w/o fuse
      if (rem - 1 <= 0) {
        this.tntFuse.delete(key);
        this.explode(world, x, y, z, ctx);
      } else {
        this.tntFuse.set(key, rem - 1);
      }
    } else {
      this.tntFuse.delete(key);
    }
  }

  /**
   * TNT explosion (1.13, §8.4): destroy every non-bedrock block in the
   * TNT_EXPLOSION_RADIUS cube (Euclidean distance from the TNT center), with
   * NO drops; remove the primed TNT itself; deal distance-falloff damage to the
   * player (max(0, round(12·(1 − dist/5))) from the explosion center to the
   * player's AABB center); fire the SFX + flash hook.
   */
  private explode(world: World, x: number, y: number, z: number, ctx: RedstoneCtx): void {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const cz = z + 0.5;
    this.removeBlock(world, x, y, z); // the primed TNT itself
    const R = TNT_EXPLOSION_RADIUS;
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > R) continue;
          if (world.getBlock(x + dx, y + dy, z + dz) === Block.Bedrock) continue;
          this.removeBlock(world, x + dx, y + dy, z + dz);
        }
      }
    }
    const playerCenterY = ctx.playerY + PLAYER_CENTER_OFFSET; // feet + half the AABB
    const dist = Math.sqrt((cx - ctx.playerX) ** 2 + (cy - playerCenterY) ** 2 + (cz - ctx.playerZ) ** 2);
    const dmg = Math.max(0, Math.round(TNT_MAX_DAMAGE * (1 - dist / TNT_DAMAGE_FALLOFF)));
    if (dmg > 0) ctx.onPlayerDamage?.(dmg, 'tnt');
    ctx.onExplosion?.(x, y, z, dist);
  }

  /**
   * Note block (1.13, §8.4): a rising edge of power plays the note at the
   * block's pitch (frequency 80·2^(pitch/12) Hz; timbre by the block above).
   * Pitch cycling on right-click is handled in game.ts (interactWith).
   */
  private tickNote(world: World, x: number, y: number, z: number, ctx: RedstoneCtx): void {
    const key = posKey(x, y, z);
    const powered = totalPowerReceived(world, x, y, z, this.power) > 0;
    const wasPowered = this.notePowered.get(key) ?? false;
    if (powered && !wasPowered) {
      const pitch = getNotePitch(world.getMeta(x, y, z));
      const blockAbove = world.getBlock(x, y + 1, z);
      ctx.onNotePlay?.(pitch, blockAbove);
    }
    this.notePowered.set(key, powered);
  }
}
