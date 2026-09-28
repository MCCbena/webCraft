/**
 * WebCraft — Game modes (Phase 2B, [modes]).
 * Pure TS, no DOM — fully unit-testable.
 *
 * SURVIVAL: HP 20, hunger 20, fall/void/drown damage, hunger drain,
 *           eating (see Game.tryEat), hardness-based mining.
 * CREATIVE: double-Space toggles fly (Space up / Shift down), no damage,
 *           instant break, unlimited items (inventory pre-filled with all
 *           placeable blocks; placing never decrements).
 * F key toggles the mode (wired to the existing Input.onMode hook).
 */

import { MAX_STACK } from './inventory';
import type { Inventory } from './inventory';
import { ALL_ITEM_IDS, isPlaceable } from '../world/blocks';

export type GameMode = 'survival' | 'creative';

/** Creative fly vertical speed (blocks/s). */
export const FLY_SPEED = 8;
/** Vertical velocity smoothing rate (1/s) for smooth takeoff/descent. */
export const FLY_SMOOTH = 8;
/** Max ms between two Space presses to count as a double press. */
export const DOUBLE_PRESS_MS = 300;

export class ModeManager {
  mode: GameMode = 'survival';
  /** creative fly (toggled with double Space) */
  fly = false;

  get isCreative(): boolean {
    return this.mode === 'creative';
  }

  get isFlying(): boolean {
    return this.mode === 'creative' && this.fly;
  }

  /** F key. Switching back to survival cancels fly. Returns the new mode. */
  toggleMode(): GameMode {
    this.mode = this.mode === 'survival' ? 'creative' : 'survival';
    if (this.mode === 'survival') this.fly = false;
    return this.mode;
  }

  /** Double Space. Only works in creative. */
  toggleFly(): void {
    if (this.mode === 'creative') this.fly = !this.fly;
  }

  setFly(on: boolean): void {
    this.fly = on && this.mode === 'creative';
  }
}

/** Detects a double press of a key within a time window. */
export class DoublePressTracker {
  private last = -Infinity;

  constructor(private readonly windowMs: number = DOUBLE_PRESS_MS) {}

  /** Call on each key press with a monotonic timestamp (ms). True on double press. */
  press(nowMs: number): boolean {
    const doubled = nowMs - this.last <= this.windowMs;
    this.last = nowMs;
    return doubled;
  }

  reset(): void {
    this.last = -Infinity;
  }
}

/**
 * Ensure the creative inventory holds a full stack of every placeable block
 * item. Called when entering creative; ids the player already owns are left
 * untouched. Returns the number of items added.
 */
export function fillCreativeInventory(inv: Inventory): number {
  let added = 0;
  for (const id of ALL_ITEM_IDS) {
    if (!isPlaceable(id)) continue;
    if (inv.countItem(id) === 0) added += MAX_STACK - inv.addItem(id, MAX_STACK);
  }
  return added;
}
