import { describe, it, expect } from 'vitest';
import { Inventory, MAX_STACK, SLOT_COUNT, HOTBAR_SIZE } from '../src/player/inventory';
import { Block, Item } from '../src/world/blocks';

describe('inventory: basics', () => {
  it('starts empty with 45 slots (9 hotbar + 36 main; Phase 5A expansion)', () => {
    const inv = new Inventory();
    expect(SLOT_COUNT).toBe(45);
    expect(HOTBAR_SIZE).toBe(9);
    expect(MAX_STACK).toBe(64);
    for (let i = 0; i < SLOT_COUNT; i++) expect(inv.get(i)).toBeNull();
    expect(inv.firstEmpty()).toBe(0);
    expect(inv.isFull).toBe(false);
  });

  it('addItem places into the first empty slot', () => {
    const inv = new Inventory();
    expect(inv.addItem(Block.Stone, 5)).toBe(0);
    expect(inv.get(0)).toEqual({ id: Block.Stone, count: 5 });
    expect(inv.get(1)).toBeNull();
  });

  it('addItem stacks into existing stacks first (in slot order)', () => {
    const inv = new Inventory();
    inv.set(3, { id: Block.Dirt, count: 60 });
    inv.set(1, { id: Block.Dirt, count: 10 });
    inv.addItem(Block.Dirt, 70);
    // slot 1 (first in order) fills to 64 (takes 54), slot 3 takes 4 (→64),
    // the remaining 12 goes to the first empty slot (0)
    expect(inv.get(1)).toEqual({ id: Block.Dirt, count: 64 });
    expect(inv.get(3)).toEqual({ id: Block.Dirt, count: 64 });
    expect(inv.get(0)).toEqual({ id: Block.Dirt, count: 12 });
  });

  it('addItem caps stacks at 64 and returns the remainder', () => {
    const inv = new Inventory();
    const left = inv.addItem(Block.Sand, 100);
    expect(inv.get(0)).toEqual({ id: Block.Sand, count: 64 });
    expect(inv.get(1)).toEqual({ id: Block.Sand, count: 36 });
    expect(left).toBe(0);
  });

  it('addItem returns the full remainder when the inventory is full', () => {
    const inv = new Inventory();
    for (let i = 0; i < SLOT_COUNT; i++) inv.set(i, { id: Block.Stone, count: 1 });
    expect(inv.isFull).toBe(true);
    expect(inv.addItem(Block.Stone, 5)).toBe(0); // stones stack
    for (let i = 0; i < SLOT_COUNT; i++) inv.set(i, { id: Block.Dirt, count: 64 });
    expect(inv.addItem(Block.Glass, 7)).toBe(7);
    expect(inv.countItem(Block.Glass)).toBe(0);
  });

  it('removeItem removes from a slot and clears empty stacks', () => {
    const inv = new Inventory();
    inv.set(2, { id: Block.Log, count: 10 });
    expect(inv.removeItem(2, 4)).toBe(4);
    expect(inv.get(2)).toEqual({ id: Block.Log, count: 6 });
    expect(inv.removeItem(2, 100)).toBe(6);
    expect(inv.get(2)).toBeNull();
    expect(inv.removeItem(2, 1)).toBe(0);
  });

  it('countItem sums across stacks', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Cobblestone, count: 64 });
    inv.set(5, { id: Block.Cobblestone, count: 20 });
    inv.set(9, { id: Block.Cobblestone, count: 1 });
    expect(inv.countItem(Block.Cobblestone)).toBe(85);
    expect(inv.countItem(Block.Glass)).toBe(0);
  });
});

describe('inventory: click moves', () => {
  it('moveBetweenSlots moves a stack into an empty slot', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Stone, count: 5 });
    inv.moveBetweenSlots(0, 4);
    expect(inv.get(0)).toBeNull();
    expect(inv.get(4)).toEqual({ id: Block.Stone, count: 5 });
  });

  it('moveBetweenSlots swaps two different items', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Stone, count: 3 });
    inv.set(1, { id: Block.Dirt, count: 7 });
    inv.moveBetweenSlots(0, 1);
    expect(inv.get(0)).toEqual({ id: Block.Dirt, count: 7 });
    expect(inv.get(1)).toEqual({ id: Block.Stone, count: 3 });
  });

  it('moveBetweenSlots merges same items when the total fits in 64', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Sand, count: 50 });
    inv.set(1, { id: Block.Sand, count: 10 });
    inv.moveBetweenSlots(0, 1);
    expect(inv.get(0)).toBeNull();
    expect(inv.get(1)).toEqual({ id: Block.Sand, count: 60 });
  });

  it('moveBetweenSlots swaps (not merges) when the total exceeds 64', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Sand, count: 60 });
    inv.set(1, { id: Block.Sand, count: 10 });
    inv.moveBetweenSlots(1, 0); // 60 + 10 > 64 → swap
    expect(inv.get(0)).toEqual({ id: Block.Sand, count: 10 });
    expect(inv.get(1)).toEqual({ id: Block.Sand, count: 60 });
  });

  it('moveBetweenSlots is a no-op for the same slot or an empty source', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Stone, count: 5 });
    inv.moveBetweenSlots(0, 0);
    expect(inv.get(0)).toEqual({ id: Block.Stone, count: 5 });
    inv.moveBetweenSlots(3, 5);
    expect(inv.get(3)).toBeNull();
    expect(inv.get(5)).toBeNull();
  });

  it('moveBetweenSlots swaps (not merges) when the total is over 64', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Dirt, count: 64 });
    inv.set(1, { id: Block.Dirt, count: 1 });
    inv.moveBetweenSlots(1, 0); // 64 + 1 > 64 → swap
    expect(inv.get(0)).toEqual({ id: Block.Dirt, count: 1 });
    expect(inv.get(1)).toEqual({ id: Block.Dirt, count: 64 });
  });
});

describe('inventory: shift moves', () => {
  it('shiftMove moves a hotbar stack to the first matching main slot', () => {
    const inv = new Inventory();
    inv.set(9, { id: Block.Planks, count: 64 });
    inv.set(12, { id: Block.Planks, count: 10 });
    inv.set(0, { id: Block.Planks, count: 5 });
    expect(inv.shiftMove(0)).toBe(true);
    expect(inv.get(0)).toBeNull();
    expect(inv.get(12)).toEqual({ id: Block.Planks, count: 15 });
    expect(inv.get(9)).toEqual({ id: Block.Planks, count: 64 });
  });

  it('shiftMove moves a hotbar stack to the first empty main slot', () => {
    const inv = new Inventory();
    inv.set(9, { id: Block.Stone, count: 64 });
    inv.set(10, { id: Block.Stone, count: 64 });
    inv.set(0, { id: Block.Glass, count: 2 });
    expect(inv.shiftMove(0)).toBe(true);
    expect(inv.get(0)).toBeNull();
    expect(inv.get(11)).toEqual({ id: Block.Glass, count: 2 });
  });

  it('shiftMove moves a main stack to the first hotbar slot', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Stone, count: 64 });
    inv.set(1, { id: Block.Dirt, count: 64 });
    inv.set(20, { id: Block.Sand, count: 3 });
    expect(inv.shiftMove(20)).toBe(true);
    expect(inv.get(20)).toBeNull();
    expect(inv.get(2)).toEqual({ id: Block.Sand, count: 3 });
  });

  it('shiftMove is a no-op when the target area is full', () => {
    const inv = new Inventory();
    for (let i = HOTBAR_SIZE; i < SLOT_COUNT; i++) inv.set(i, { id: Block.Stone, count: 1 });
    inv.set(0, { id: Block.Glass, count: 1 });
    expect(inv.shiftMove(0)).toBe(false);
    expect(inv.get(0)).toEqual({ id: Block.Glass, count: 1 });
  });

  it('shiftMove is a no-op for an empty source slot', () => {
    const inv = new Inventory();
    expect(inv.shiftMove(3)).toBe(false);
    expect(inv.shiftMove(30)).toBe(false);
  });

  it('round trip: survival mining → shift to main → back to hotbar', () => {
    const inv = new Inventory();
    inv.addItem(Item.Bread, 30); // lands in hotbar slot 0
    expect(inv.get(0)).toEqual({ id: Item.Bread, count: 30 });
    expect(inv.shiftMove(0)).toBe(true);
    expect(inv.get(9)).toEqual({ id: Item.Bread, count: 30 });
    expect(inv.shiftMove(9)).toBe(true);
    expect(inv.get(0)).toEqual({ id: Item.Bread, count: 30 });
  });
});
