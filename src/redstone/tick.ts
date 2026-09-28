/**
 * WebCraft — Redstone 20 TPS tick (Phase 2C, [redstone]).
 *
 * `Redstone.tick(world, ctx)` is called once per 20 TPS tick from
 * game.ts (Game.tickRedstone()). Synchronous, deterministic, no timers.
 *
 * Per-tick order (task spec / design.md §8.4):
 *   1. Scan the universe: redstone blocks in the player's 3×3 chunk region
 *      (bounded like Minecraft's active-redstone radius; blocks outside are
 *      not ticked while the player is far away).
 *   2. Component state machines (pistons, observers, repeaters, comparators,
 *      buttons, pressure plates) — deterministic sorted order.
 *   3. Apply resulting block changes (piston moves; component meta writes
 *      already applied via ctx.write).
 *   4. Recompute the dust network to a fixed point (capped), then re-evaluate
 *      the passive components (torch, lamp) that depend on the new dust
 *      strengths; bounded convergence rounds.
 *   5. Prune runtime state for blocks left the universe.
 *
 * Performance: the universe scan is a tight typed-array loop over at most
 * 9 chunks × 65536 ids (~0.5 ms). Dust/component work is proportional to
 * the number of redstone blocks in the region.
 */

import { AIR, Block, setOn } from '../world/blocks';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_VOLUME } from '../world/chunk';
import type { World } from '../world/world';
import {
  BUTTON_TICKS_STONE,
  BUTTON_TICKS_WOOD,
  DUST_MAX_ROUNDS,
  isRedstoneBlock,
  posKey,
  type RedstoneCtx,
  type UniverseBlock,
} from './types';
import { propagateDustToFixedPoint, type ObserverState } from './network';
import {
  tickButton,
  tickDelayed,
  tickLamp,
  tickObserver,
  tickPlate,
  tickPiston,
  tickTorch,
  type ComponentCtx,
  type DelayedState,
  type ObserverEntry,
  type PistonState,
  type PistonWrite,
} from './components';

export class Redstone {
  /** repeater/comparator runtime delay states (position key → state) */
  private readonly repeaters = new Map<number, DelayedState>();
  private readonly comparators = new Map<number, DelayedState>();
  /** observer: position key → previous front state + output countdown */
  private readonly observers = new Map<number, ObserverEntry>();
  /** piston: position key → extension state */
  private readonly pistons = new Map<number, PistonState>();
  /** button: position key → remaining on ticks */
  private readonly buttons = new Map<number, number>();

  private readonly obsState: ObserverState = {
    isOutputting: (x, y, z) => (this.observers.get(posKey(x, y, z))?.ticks ?? 0) > 0,
  };

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
    // (1) Universe scan — player's 3×3 chunk region.
    const universe = this.scanUniverse(world, ctx);
    const keys = new Set<number>();
    const positions: UniverseBlock[] = [];
    for (const u of universe.values()) {
      keys.add(posKey(u.x, u.y, u.z));
      positions.push(u);
    }
    positions.sort((a, b) => posKey(a.x, a.y, a.z) - posKey(b.x, b.y, b.z));

    const c: ComponentCtx = {
      world,
      observers: this.obsState,
      write: (x, y, z, id, meta) => this.write(world, x, y, z, id, meta),
    };
    const moves: PistonWrite[] = [];

    // (2) Component state machines (deterministic order).
    for (const p of positions) {
      switch (p.id) {
        case Block.Piston:
        case Block.StickyPiston:
          tickPiston(c, p.x, p.y, p.z, this.pistons, moves);
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
      }
    }

    // (3) Apply piston moves; patch the universe (and keep `keys` in sync —
    // pruning runs later and must not drop state that just moved).
    if (moves.length > 0) {
      for (const m of moves) {
        world.setBlock(m.x, m.y, m.z, m.id, m.meta);
        world.markDirtyAround(m.x, m.y, m.z); // shared helper (Phase 4 DRY)
        this.patchUniverse(universe, m.x, m.y, m.z, m.id);
        keys.add(posKey(m.x, m.y, m.z));
      }
      // Read the front block of just-extended pistons (after the push).
      for (const st of this.pistons.values()) {
        if (st.frontId === -1) {
          st.frontId = world.getBlock(st.frontX, st.frontY, st.frontZ);
          st.frontMeta = world.getMeta(st.frontX, st.frontY, st.frontZ);
        }
      }
    }

    // (4) Dust fixed point + passive components, bounded convergence.
    let dust = this.dustList(universe);
    for (let round = 0; round < DUST_MAX_ROUNDS; round++) {
      let changed = propagateDustToFixedPoint(world, dust, this.obsState);
      for (const p of positions) {
        if (p.id === Block.RedstoneTorch) changed = tickTorch(c, p.x, p.y, p.z) || changed;
        else if (p.id === Block.RedstoneLamp) changed = tickLamp(c, p.x, p.y, p.z) || changed;
      }
      if (!changed) break;
      // A torch/lamp change can alter the dust (torch) — refresh lists and
      // run one more round (capped by DUST_MAX_ROUNDS).
      dust = this.dustList(universe);
    }

    // (5) Prune runtime state for blocks that left the universe.
    for (const map of [this.repeaters, this.comparators, this.observers, this.pistons, this.buttons]) {
      for (const k of [...map.keys()]) {
        if (!keys.has(k)) map.delete(k);
      }
    }
  }

  // --- helpers -------------------------------------------------------------

  /** Write a block and mark this chunk (plus border neighbors) for remesh. */
  private write(world: World, x: number, y: number, z: number, id: number, meta: number): void {
    world.setBlock(x, y, z, id, meta);
    world.markDirtyAround(x, y, z); // shared helper (Phase 4 DRY)
  }

  /** Redstone blocks (id 18..34) in the player's 3×3 chunk region. */
  private scanUniverse(world: World, ctx: RedstoneCtx): Map<number, UniverseBlock> {
    const map = new Map<number, UniverseBlock>();
    const cx0 = Math.floor(ctx.playerX / CHUNK_SIZE_X);
    const cz0 = Math.floor(ctx.playerZ / CHUNK_SIZE_Z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const chunk = world.getChunk(cx0 + dx, cz0 + dz);
        if (!chunk) continue;
        const ids = chunk.ids;
        const bx = (cx0 + dx) * CHUNK_SIZE_X;
        const bz = (cz0 + dz) * CHUNK_SIZE_Z;
        for (let i = 0; i < CHUNK_VOLUME; i++) {
          const id = ids[i];
          if (!isRedstoneBlock(id)) continue;
          const x = bx + (i & 15);
          const z = bz + ((i >> 4) & 15);
          const y = i >> 8;
          map.set(posKey(x, y, z), { x, y, z, id });
        }
      }
    }
    return map;
  }

  private patchUniverse(universe: Map<number, UniverseBlock>, x: number, y: number, z: number, id: number): void {
    const k = posKey(x, y, z);
    if (isRedstoneBlock(id)) universe.set(k, { x, y, z, id });
    else universe.delete(k);
  }

  /** Sorted dust list (deterministic forward sweep). */
  private dustList(universe: Map<number, UniverseBlock>): UniverseBlock[] {
    const dust: UniverseBlock[] = [];
    for (const u of universe.values()) if (u.id === Block.RedstoneDust) dust.push(u);
    dust.sort((a, b) => posKey(a.x, a.y, a.z) - posKey(b.x, b.y, b.z));
    return dust;
  }
}
