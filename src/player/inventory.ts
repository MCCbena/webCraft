/**
 * WebCraft — Player inventory (Phase 2B, [modes]).
 * Pure TS, no DOM — fully unit-testable.
 *
 * 36 slots: 0-8 hotbar, 9-35 main storage.
 * Stacks max MAX_STACK (64). Item ids come from src/world/blocks.ts
 * (block items share the block id; foods/tools use the Item ids).
 */

export const MAX_STACK = 64;
export const SLOT_COUNT = 36;
export const HOTBAR_SIZE = 9;

export interface ItemStack {
  id: number;
  count: number;
}

export class Inventory {
  private readonly slots: (ItemStack | null)[] = new Array(SLOT_COUNT).fill(null);

  /** Stack in a slot (null when empty). Out-of-range slots read as empty. */
  get(slot: number): ItemStack | null {
    if (slot < 0 || slot >= SLOT_COUNT) return null;
    return this.slots[slot];
  }

  set(slot: number, stack: ItemStack | null): void {
    if (slot < 0 || slot >= SLOT_COUNT) return;
    this.slots[slot] = stack;
  }

  /**
   * Add items: fill existing stacks of the same id first (in slot order),
   * then the first empty slots. Returns the number of items that did not fit.
   */
  addItem(id: number, count: number): number {
    let remaining = count;
    for (let i = 0; i < SLOT_COUNT && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < MAX_STACK) {
        const take = Math.min(MAX_STACK - s.count, remaining);
        s.count += take;
        remaining -= take;
      }
    }
    for (let i = 0; i < SLOT_COUNT && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const take = Math.min(MAX_STACK, remaining);
        this.slots[i] = { id, count: take };
        remaining -= take;
      }
    }
    return remaining;
  }

  /** Remove up to `count` items from one slot. Returns how many were removed. */
  removeItem(slot: number, count: number): number {
    const s = this.slots[slot];
    if (!s) return 0;
    const take = Math.min(count, s.count);
    s.count -= take;
    if (s.count <= 0) this.slots[slot] = null;
    return take;
  }

  /**
   * Simple click move between two slots:
   *  - empty target  → move the whole stack
   *  - same id fitting under MAX_STACK → merge into target
   *  - otherwise     → swap the two stacks
   */
  moveBetweenSlots(from: number, to: number): void {
    if (from === to) return;
    const a = this.get(from);
    if (!a) return;
    const b = this.get(to);
    if (!b) {
      this.slots[to] = a;
      this.slots[from] = null;
      return;
    }
    if (b.id === a.id && a.count + b.count <= MAX_STACK) {
      b.count += a.count;
      this.slots[from] = null;
      return;
    }
    this.slots[to] = a;
    this.slots[from] = b;
  }

  /**
   * Shift-move: hotbar <-> main storage.
   * Merges into existing stacks of the same id (up to MAX_STACK each);
   * whatever does not fit goes to the first empty slot.
   * Returns true when at least one item moved.
   */
  shiftMove(from: number): boolean {
    const s = this.get(from);
    if (!s) return false;
    const inHotbar = from < HOTBAR_SIZE;
    const start = inHotbar ? HOTBAR_SIZE : 0;
    const end = inHotbar ? SLOT_COUNT : HOTBAR_SIZE;
    let remaining = s.count;
    for (let i = start; i < end && remaining > 0; i++) {
      const t = this.slots[i];
      if (t && t.id === s.id && t.count < MAX_STACK) {
        const take = Math.min(MAX_STACK - t.count, remaining);
        t.count += take;
        remaining -= take;
      }
    }
    if (remaining > 0) {
      for (let i = start; i < end; i++) {
        if (this.slots[i] === null) {
          this.slots[i] = { id: s.id, count: remaining };
          remaining = 0;
          break;
        }
      }
    }
    if (remaining < s.count) this.slots[from] = null;
    return remaining < s.count;
  }

  /** Total count of an item id across all slots. */
  countItem(id: number): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** First empty slot index, or -1 when full. */
  firstEmpty(): number {
    for (let i = 0; i < SLOT_COUNT; i++) if (this.slots[i] === null) return i;
    return -1;
  }

  get isFull(): boolean {
    return this.firstEmpty() === -1;
  }

  clear(): void {
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = null;
  }
}
