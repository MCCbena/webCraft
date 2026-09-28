import { describe, it, expect } from 'vitest';
import {
  AIR,
  Block,
  BLOCK_DEFS,
  Item,
  ALL_BLOCK_IDS,
  ALL_ITEM_IDS,
  getBlockDef,
  getItemDef,
  isPlaceable,
  isSolidBlock,
  isOpaqueBlock,
  getFacing,
  setFacing,
  getDelay,
  setDelay,
  getMode,
  setMode,
  getOutput,
  setOutput,
  getStrength,
  setStrength,
  isOn,
  setOn,
} from '../src/world/blocks';

/** Every block name required by design.md §4. */
const REQUIRED_BLOCKS = [
  'air', 'stone', 'grass', 'dirt', 'sand', 'gravel', 'log', 'leaves', 'planks', 'cobblestone',
  'glass', 'water', 'bedrock', 'clay', 'snow',
  'coal_ore', 'iron_ore', 'redstone_ore',
  'redstone_dust', 'redstone_torch', 'redstone_block', 'redstone_lamp', 'repeater', 'comparator',
  'piston', 'sticky_piston', 'observer', 'lever', 'stone_button', 'wood_button',
  'stone_pressure_plate', 'wood_pressure_plate', 'tripwire_hook', 'dispenser', 'dropper',
  'torch', 'oak_door',
];

/** Every item required by design.md §4. */
const REQUIRED_ITEMS = ['wheat', 'bread', 'apple', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel', 'stone_hoe'];

describe('block definition completeness (design.md §4)', () => {
  it('has every required block', () => {
    const names = new Set(BLOCK_DEFS.map((b) => b.name));
    for (const n of REQUIRED_BLOCKS) {
      expect(names.has(n), `missing block: ${n}`).toBe(true);
    }
  });

  it('has every required item', () => {
    const names = new Set(ALL_ITEM_IDS.map((id) => getItemDef(id)?.name));
    for (const n of REQUIRED_ITEMS) {
      expect(names.has(n), `missing item: ${n}`).toBe(true);
    }
  });

  it('has no duplicate block ids and sane ids', () => {
    const ids = new Set<number>();
    for (const b of BLOCK_DEFS) {
      expect(ids.has(b.id), `duplicate id ${b.id}`).toBe(false);
      ids.add(b.id);
      expect(b.id).toBeGreaterThanOrEqual(0);
      expect(b.id).toBeLessThan(256);
    }
  });

  it('every block has sane properties', () => {
    for (const b of BLOCK_DEFS) {
      expect(typeof b.name).toBe('string');
      expect([b.tiles.top, b.tiles.side, b.tiles.bottom].every((t) => t >= 0 && t < 256), `${b.name}: tile out of atlas range`).toBe(true);
      if (b.id !== AIR) {
        expect(b.hardness, `${b.name}: hardness must be set`).toBeGreaterThanOrEqual(-1);
      }
      expect(b.drop).toBeGreaterThanOrEqual(0);
    }
  });

  it('key physical properties are correct', () => {
    expect(isSolidBlock(Block.Stone)).toBe(true);
    expect(isSolidBlock(Block.Bedrock)).toBe(true);
    expect(isSolidBlock(Block.Water)).toBe(false);
    expect(isSolidBlock(Block.RedstoneDust)).toBe(false);
    expect(isSolidBlock(Block.Torch)).toBe(false);
    expect(isSolidBlock(Block.Lever)).toBe(false);
    expect(isOpaqueBlock(Block.Stone)).toBe(true);
    expect(isOpaqueBlock(Block.Glass)).toBe(false);
    expect(isOpaqueBlock(Block.Leaves)).toBe(false);
    expect(isOpaqueBlock(Block.Water)).toBe(false);
    expect(getBlockDef(Block.Bedrock).hardness).toBe(-1);
    expect(getBlockDef(Block.Water).hardness).toBe(-1);
    expect(getBlockDef(Block.Grass).drop).toBe(Block.Dirt);
    expect(getBlockDef(Block.RedstoneOre).drop).toBe(Block.RedstoneDust);
  });

  it('redstone components carry the right meta specs', () => {
    expect(getBlockDef(Block.RedstoneDust).meta.kind).toBe('strength');
    expect(getBlockDef(Block.RedstoneTorch).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.RedstoneLamp).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.Repeater).meta.kind).toBe('facingDelay');
    expect(getBlockDef(Block.Comparator).meta.kind).toBe('facingModeOutput');
    expect(getBlockDef(Block.Piston).meta.kind).toBe('facing');
    expect(getBlockDef(Block.StickyPiston).meta.kind).toBe('facing');
    expect(getBlockDef(Block.Observer).meta.kind).toBe('facing');
    expect(getBlockDef(Block.Lever).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.StoneButton).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.WoodButton).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.StonePressurePlate).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.WoodPressurePlate).meta.kind).toBe('onOff');
    expect(getBlockDef(Block.TripwireHook).meta.kind).toBe('facingOnOff');
    expect(getBlockDef(Block.OakDoor).meta.kind).toBe('door');
  });
});

describe('meta helpers', () => {
  it('facing round-trips (0-3)', () => {
    for (let f = 0; f < 4; f++) {
      const m = setFacing(0, f);
      expect(getFacing(m)).toBe(f);
    }
    // facing does not clobber delay bits
    expect(setFacing(0x0c, 2) & 0x0c).toBe(0x0c);
  });

  it('delay is clamped 1..4 and round-trips', () => {
    expect(getDelay(0)).toBe(1);
    for (const d of [1, 2, 3, 4]) {
      expect(getDelay(setDelay(0, d))).toBe(d);
    }
    expect(getDelay(setDelay(0, 0))).toBe(1);
    expect(getDelay(setDelay(0, 9))).toBe(4);
  });

  it('comparator mode + output round-trip', () => {
    let m = setMode(0, 1);
    expect(getMode(m)).toBe(1);
    m = setOutput(m, 15);
    expect(getOutput(m)).toBe(15);
    expect(getMode(m)).toBe(1);
    m = setMode(m, 0);
    expect(getMode(m)).toBe(0);
    expect(getOutput(m)).toBe(15);
  });

  it('strength round-trips 0-15', () => {
    for (let s = 0; s < 16; s++) {
      expect(getStrength(setStrength(0, s))).toBe(s);
    }
  });

  it('on/off round-trips', () => {
    expect(isOn(0)).toBe(false);
    expect(isOn(setOn(0, true))).toBe(true);
    expect(isOn(setOn(0b1110, true))).toBe(true);
    expect(isOn(setOn(0b1111, false))).toBe(false);
  });
});

describe('items', () => {
  it('block items are placeable and map to their block', () => {
    expect(isPlaceable(Block.Stone)).toBe(true);
    expect(getItemDef(Block.Stone)?.blockId).toBe(Block.Stone);
    expect(isPlaceable(AIR)).toBe(false);
    expect(isPlaceable(999999)).toBe(false);
  });

  it('food items have the design food values (bread +5, apple +4)', () => {
    expect(getItemDef(Item.Bread)?.foodValue).toBe(5);
    expect(getItemDef(Item.Apple)?.foodValue).toBe(4);
    expect(getItemDef(Item.Wheat)?.kind).toBe('material');
  });

  it('stone tools exist with tool data', () => {
    for (const id of [Item.StonePickaxe, Item.StoneAxe, Item.StoneSword, Item.StoneShovel, Item.StoneHoe]) {
      const def = getItemDef(id);
      expect(def, `tool ${id} missing`).not.toBeNull();
      expect(def?.kind).toBe('tool');
      expect(def?.tool).toBeDefined();
      expect(def?.tool?.durability).toBeGreaterThan(0);
    }
    expect(getItemDef(Item.StonePickaxe)?.tool?.type).toBe('pickaxe');
  });
});
