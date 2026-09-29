/**
 * WebCraft — Container content system (Phase 5B, [redstone], design.md §8.5).
 *
 * Per-position item storage for the three container blocks:
 *   - Hopper     : 5 slots
 *   - Dropper    : 9 slots
 *   - Dispenser  : 9 slots
 *
 * State is a sparse `Map<posKey, ContainerState>` owned by the Redstone class
 * (tick.ts). It FOLLOWS THE BLOCKS:
 *   - created (empty) when a container block is placed,
 *   - destroyed when the block is broken/replaced,
 *   - moved with the block when a piston pushes it (the tick pre-pass calls
 *     `move()` before the world write so the contents travel intact).
 *
 * Pure TS — no DOM/three.js, synchronous, deterministic, no timers/promises.
 * The per-tick BEHAVIOR (hopper transfer, dropper ejection, dispenser "use",
 * incl. the calls into primeTnt / toggleDoor) lives in tick.ts; this file is
 * only the content storage + item math.
 */

import { Block } from '../world/blocks';
import { MAX_STACK, type ItemStack } from '../player/inventory';
import { posKey } from './types';

export const HOPPER_SLOTS = 5;
export const DROPPER_SLOTS = 9;
export const DISPENSER_SLOTS = 9;

/**
 * 1.13 hopper moves a bounded number of items per transfer. The task spec
 * (Phase 5B) prescribes "every tick … up to 2 items" — so the hopper runs
 * every tick with a 2-item cap (a real 1.13 hopper uses a 2-tick cooldown;
 * every-tick is kept for deterministic, testable behavior — see memory.md).
 */
export const HOPPER_TRANSFER_PER_TICK = 2;
/** 1.13 dropper/dispenser: eject/use one item every N ticks while powered. */
export const DROPPER_COOLDOWN_TICKS = 8;
export const DISPENSER_COOLDOWN_TICKS = 8;

/** true for the three container block ids (hopper / dropper / dispenser). */
export function isContainerId(id: number): boolean {
  return id === Block.Hopper || id === Block.Dropper || id === Block.Dispenser;
}

/** Number of item slots a container block has (hopper 5, dropper/dispenser 9). */
export function containerSlotCount(id: number): number {
  return id === Block.Hopper ? HOPPER_SLOTS : 9;
}

export interface ContainerState {
  slots: (ItemStack | null)[];
}

export class ContainerRegistry {
  private readonly map = new Map<number, ContainerState>();

  has(x: number, y: number, z: number): boolean {
    return this.map.has(posKey(x, y, z));
  }

  get(x: number, y: number, z: number): ContainerState | undefined {
    return this.map.get(posKey(x, y, z));
  }

  /** The live slots array (mutated in place by the GUI) or undefined. */
  slots(x: number, y: number, z: number): (ItemStack | null)[] | undefined {
    return this.map.get(posKey(x, y, z))?.slots;
  }

  slotCount(x: number, y: number, z: number): number {
    return this.map.get(posKey(x, y, z))?.slots.length ?? 0;
  }

  /** Create an empty container (no-op when one already exists here). */
  createEmpty(x: number, y: number, z: number, id: number): void {
    const key = posKey(x, y, z);
    if (this.map.has(key)) return;
    this.map.set(key, { slots: new Array(containerSlotCount(id)).fill(null) });
  }

  /** Remove the state, returning its slots (the contents) or null. */
  destroy(x: number, y: number, z: number): (ItemStack | null)[] | null {
    const key = posKey(x, y, z);
    const st = this.map.get(key);
    this.map.delete(key);
    return st ? st.slots : null;
  }

  /** Move the whole state (contents included) from one position to another. */
  move(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    const fk = posKey(fx, fy, fz);
    const tk = posKey(tx, ty, tz);
    if (fk === tk) return;
    const st = this.map.get(fk);
    if (!st) return;
    this.map.delete(fk);
    this.map.set(tk, st);
  }

  /**
   * Reconcile container state after a world write at (x,y,z) with the
   * old/new block ids. Creates an empty container when a container block is
   * placed; destroys the state when a container block is removed/replaced.
   * When BOTH old and new are containers the state is left untouched — piston
   * moves perform the `move()` in a pre-pass before the write, so this must
   * not clobber or duplicate the relocated state.
   */
  reconcile(x: number, y: number, z: number, oldId: number, newId: number): void {
    const newC = isContainerId(newId);
    const oldC = isContainerId(oldId);
    if (newC && !oldC && !this.has(x, y, z)) this.createEmpty(x, y, z, newId);
    if (oldC && !newC) this.destroy(x, y, z);
  }

  /** 5B power hook: does this container hold any items? */
  hasItems(x: number, y: number, z: number): boolean {
    const st = this.map.get(posKey(x, y, z));
    if (!st) return false;
    return st.slots.some((s) => s !== null);
  }

  /** Total item count (by quantity) across all slots. */
  totalItems(x: number, y: number, z: number): number {
    const st = this.map.get(posKey(x, y, z));
    if (!st) return 0;
    let n = 0;
    for (const s of st.slots) if (s) n += s.count;
    return n;
  }

  /** Does the container have room for at least one more item? */
  hasRoom(x: number, y: number, z: number): boolean {
    const st = this.map.get(posKey(x, y, z));
    if (!st) return false;
    return st.slots.some((s) => s === null || s.count < MAX_STACK);
  }

  /**
   * Move up to `maxItems` items (by quantity) from the container at
   * (fx,fy,fz) into the container at (tx,ty,tz). Merges into matching stacks
   * first, then the first empty slot. Returns the number moved.
   */
  transfer(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, maxItems: number): number {
    const from = this.map.get(posKey(fx, fy, fz));
    const to = this.map.get(posKey(tx, ty, tz));
    if (!from || !to) return 0;
    let moved = 0;
    for (let i = 0; i < from.slots.length && moved < maxItems; i++) {
      const s = from.slots[i];
      if (!s) continue;
      const want = Math.min(s.count, maxItems - moved);
      let placed = 0;
      for (let j = 0; j < to.slots.length && placed < want; j++) {
        const t = to.slots[j];
        if (t && t.id === s.id && t.count < MAX_STACK) {
          const take = Math.min(MAX_STACK - t.count, want - placed);
          t.count += take;
          placed += take;
        }
      }
      if (placed < want) {
        for (let j = 0; j < to.slots.length && placed < want; j++) {
          if (to.slots[j] === null) {
            const take = Math.min(MAX_STACK, want - placed);
            to.slots[j] = { id: s.id, count: take };
            placed += take;
          }
        }
      }
      if (placed > 0) {
        s.count -= placed;
        if (s.count <= 0) from.slots[i] = null;
        moved += placed;
      }
    }
    return moved;
  }

  /** The first non-empty stack (peek, no mutation) or null. */
  firstItem(x: number, y: number, z: number): ItemStack | null {
    const st = this.map.get(posKey(x, y, z));
    if (!st) return null;
    for (const s of st.slots) if (s) return s;
    return null;
  }

  /** Remove a single item from the first non-empty slot; returns it (or null). */
  removeOne(x: number, y: number, z: number): ItemStack | null {
    const st = this.map.get(posKey(x, y, z));
    if (!st) return null;
    for (let i = 0; i < st.slots.length; i++) {
      const s = st.slots[i];
      if (s) {
        s.count--;
        if (s.count <= 0) st.slots[i] = null;
        return { id: s.id, count: 1 };
      }
    }
    return null;
  }

  /** Insert a single item of `id`; returns true when it fit. */
  insertOne(x: number, y: number, z: number, id: number): boolean {
    const st = this.map.get(posKey(x, y, z));
    if (!st) return false;
    for (let i = 0; i < st.slots.length; i++) {
      const s = st.slots[i];
      if (s && s.id === id && s.count < MAX_STACK) {
        s.count++;
        return true;
      }
    }
    for (let i = 0; i < st.slots.length; i++) {
      if (st.slots[i] === null) {
        st.slots[i] = { id, count: 1 };
        return true;
      }
    }
    return false;
  }
}
