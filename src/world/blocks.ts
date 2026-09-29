/**
 * WebCraft — Block & item definitions (Phase 1, [core]).
 *
 * COMPLETE per design.md §4. Phase 2 teams (terrain / modes / redstone) rely
 * on this file being final: every block and item listed in the design exists
 * here with solid/opaque/hardness/drop/meta semantics and atlas tile indices.
 *
 * META BYTE LAYOUT (0-15 stored in a single Uint8):
 *   bits 0-1  facing: 0=south(+Z) 1=west(-X) 2=north(-Z) 3=east(+X)
 *   bit  0    on/lit/primed  (kind: onOff — incl. TNT primed bit, Phase 5A)
 *   bit  2    on/open        (kind: facingOnOff — tripwire_hook "has string")
 *   bits 0-3  strength 0-15  (kind: strength — redstone dust, full byte)
 *   bits 2-3  delay-1 → 1..4 tick (kind: facingDelay — repeater)
 *   bit  2    mode 0=compare 1=subtract (kind: facingModeOutput — comparator)
 *   bits 3-6  output strength 0-15      (comparator, written by redstone tick)
 *   bits 4-7  output strength 0-15      (repeater, written by redstone tick)
 *   Phase 5A:
 *   bit  1    door top half (kind: door — bit 2 = open; closed = solid)
 *   bit  1    daylight detector inverted mode (kind: daylight)
 *   bits 0-4  note block pitch 0-24      (kind: note; 5B cycles it on RMB)
 *
 * Redstone 1.13 power conventions used by the Phase 2C module:
 *   - Weak power: horizontal 4 neighbors (dust on/beside, components behind)
 *   - Strong power: the block directly above a powered block
 *   - "on" state of a block is always readable via the meta helpers below.
 */

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------

export const AIR = 0;
export const WATER = 11;
export const BEDROCK = 12;

export const Block = {
  Air: 0,
  Stone: 1,
  Grass: 2,
  Dirt: 3,
  Sand: 4,
  Gravel: 5,
  Log: 6, // oak log
  Leaves: 7,
  Planks: 8,
  Cobblestone: 9,
  Glass: 10,
  Water: 11,
  Bedrock: 12,
  Clay: 13,
  Snow: 14,
  CoalOre: 15,
  IronOre: 16,
  RedstoneOre: 17,
  RedstoneDust: 18,
  RedstoneTorch: 19,
  RedstoneBlock: 20,
  RedstoneLamp: 21,
  Repeater: 22,
  Comparator: 23,
  Piston: 24,
  StickyPiston: 25,
  Observer: 26,
  Lever: 27,
  StoneButton: 28,
  WoodButton: 29,
  StonePressurePlate: 30,
  WoodPressurePlate: 31,
  TripwireHook: 32,
  Dispenser: 33,
  Dropper: 34,
  Torch: 35,
  OakDoor: 36,
  // Phase 5A (existing ids above are stable; new ones appended):
  Hopper: 37,
  DaylightDetector: 38,
  Tnt: 39,
  NoteBlock: 40,
  Rail: 41,
  PoweredRail: 42,
  Tripwire: 43, // the string line block (non-solid, thin render)
} as const;

// ---------------------------------------------------------------------------
// Meta specs & helpers
// ---------------------------------------------------------------------------

export type MetaSpec =
  | { kind: 'none' }
  | { kind: 'facing' }
  | { kind: 'facingOnOff' }
  | { kind: 'onOff' }
  | { kind: 'strength' }
  | { kind: 'facingDelay' }
  | { kind: 'facingModeOutput' }
  | { kind: 'door' }
  | { kind: 'daylight' }
  | { kind: 'note' };

export const Facing = { South: 0, West: 1, North: 2, East: 3 } as const;

export function getFacing(meta: number): number {
  return meta & 0x03;
}
export function setFacing(meta: number, facing: number): number {
  return (meta & ~0x03) | (facing & 0x03);
}
/** bit 0 — onOff blocks (lever, buttons, plates, lamp lit) */
export function isOn(meta: number): boolean {
  return (meta & 0x01) !== 0;
}
export function setOn(meta: number, on: boolean): number {
  return on ? meta | 0x01 : meta & ~0x01;
}
/** bit 2 — facingOnOff blocks (tripwire_hook) and doors (open) */
export function isSideOn(meta: number): boolean {
  return (meta & 0x04) !== 0;
}
export function setSideOn(meta: number, on: boolean): number {
  return on ? meta | 0x04 : meta & ~0x04;
}
/** bits 0-3 — signal strength 0-15 */
export function getStrength(meta: number): number {
  return meta & 0x0f;
}
export function setStrength(meta: number, strength: number): number {
  return (meta & ~0x0f) | (strength & 0x0f);
}
/** bits 2-3 — repeater delay, 1..4 ticks */
export function getDelay(meta: number): number {
  return ((meta & 0x0c) >> 2) + 1;
}
export function setDelay(meta: number, delay: number): number {
  const d = Math.min(4, Math.max(1, delay));
  return (meta & ~0x0c) | (((d - 1) & 0x03) << 2);
}
/** bit 2 — comparator mode: 0=compare, 1=subtract */
export function getMode(meta: number): number {
  return (meta & 0x04) >> 2;
}
export function setMode(meta: number, mode: number): number {
  return mode ? meta | 0x04 : meta & ~0x04;
}
/** bits 3-6 — comparator output strength 0-15 */
export function getOutput(meta: number): number {
  return (meta & 0x78) >> 3;
}
export function setOutput(meta: number, strength: number): number {
  return (meta & ~0x78) | ((strength & 0x0f) << 3);
}
/**
 * bits 4-7 — repeater output strength (written by the redstone tick).
 * Single source of truth for the repeater-output meta mask (Phase 4 DRY:
 * previously duplicated in redstone/types.ts, world/mesher.ts and
 * tools/verify-render.ts).
 */
export function getRepeaterOut(meta: number): number {
  return (meta & 0xf0) >>> 4;
}
export function setRepeaterOut(meta: number, strength: number): number {
  return (meta & 0x0f) | ((strength & 0x0f) << 4);
}

// --- Door meta (Phase 5A, design.md §8.4) ---------------------------------
// bit 1 = top half, bit 2 = open (shared with the facingOnOff "on" bit).
// A door is SOLID while closed (both halves form the 1×2 AABB); open =
// non-solid. See `isSolidBlockAt`.

export const DOOR_TOP_BIT = 0x02;
export const DOOR_OPEN_BIT = 0x04;

/** bit 1 — upper door half */
export function isDoorTop(meta: number): boolean {
  return (meta & DOOR_TOP_BIT) !== 0;
}
export function setDoorTop(meta: number, top: boolean): number {
  return top ? meta | DOOR_TOP_BIT : meta & ~DOOR_TOP_BIT;
}
/** bit 2 — door open */
export function isDoorOpen(meta: number): boolean {
  return (meta & DOOR_OPEN_BIT) !== 0;
}
export function setDoorOpen(meta: number, open: boolean): number {
  return open ? meta | DOOR_OPEN_BIT : meta & ~DOOR_OPEN_BIT;
}

// --- Daylight detector meta (Phase 5A, design.md §8.1/§8.6) ----------------
/** bit 1 — inverted mode (output = 15 − normal) */
export function isDaylightInverted(meta: number): boolean {
  return (meta & DOOR_TOP_BIT) !== 0;
}
export function setDaylightInverted(meta: number, inverted: boolean): number {
  return inverted ? meta | DOOR_TOP_BIT : meta & ~DOOR_TOP_BIT;
}

// --- Note block meta (Phase 5A; behavior 5B) --------------------------------
/** bits 0-4 — pitch 0-24 (1.13 note range) */
export function getNotePitch(meta: number): number {
  return meta & 0x1f;
}
export function setNotePitch(meta: number, pitch: number): number {
  return (meta & ~0x1f) | (Math.min(24, Math.max(0, Math.round(pitch))) & 0x1f);
}
/** 1.13 default pitch of a newly placed note block (C4). */
export const NOTE_DEFAULT_PITCH = 12;

/**
 * Default placement meta for a block id (pure — used by game.placeTarget):
 * a note block starts at the 1.13 default pitch 12; every other block is 0.
 */
export function defaultMeta(id: number): number {
  return id === Block.NoteBlock ? setNotePitch(0, NOTE_DEFAULT_PITCH) : 0;
}

// ---------------------------------------------------------------------------
// Shapes (local box 0..1 used by the mesher)
// ---------------------------------------------------------------------------

export type BlockShape =
  | 'full'
  | 'slab'
  | 'half'
  | 'dust'
  | 'torch'
  | 'hook'
  // Phase 5A:
  | 'hopper' // small open-top box
  | 'rail' // thin flat piece on the ground
  | 'string'; // tripwire: thin 1/8-wide full-height line (connects cell to cell)

export const SHAPE_BOXES: Record<BlockShape, { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }> = {
  full: { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 },
  slab: { x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.125, z1: 1 },
  half: { x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.5, z1: 1 },
  dust: { x0: 0.03, y0: 0, z0: 0.03, x1: 0.97, y1: 0.125, z1: 0.97 },
  torch: { x0: 0.375, y0: 0.125, z0: 0.375, x1: 0.625, y1: 0.875, z1: 0.625 },
  hook: { x0: 0.375, y0: 0.5, z0: 0.375, x1: 0.625, y1: 1.0, z1: 0.625 },
  hopper: { x0: 0.05, y0: 0, z0: 0.05, x1: 0.95, y1: 0.95, z1: 0.95 },
  rail: { x0: 0.03, y0: 0, z0: 0.03, x1: 0.97, y1: 0.125, z1: 0.97 },
  string: { x0: 0.4375, y0: 0, z0: 0.4375, x1: 0.5625, y1: 1, z1: 0.5625 },
};

// ---------------------------------------------------------------------------
// Texture atlas tiles (16x16 tiles, 16px each — see engine/renderer.ts)
// ---------------------------------------------------------------------------

export const Tile = {
  Stone: 0,
  GrassTop: 1,
  GrassSide: 2,
  Dirt: 3,
  Sand: 4,
  Gravel: 5,
  LogSide: 6,
  LogTop: 7,
  Leaves: 8,
  Planks: 9,
  Cobblestone: 10,
  Glass: 11,
  Water: 12,
  Bedrock: 13,
  Clay: 14,
  Snow: 15,
  CoalOre: 16,
  IronOre: 17,
  RedstoneOre: 18,
  RedstoneDust: 19,
  RedstoneTorchOn: 20,
  RedstoneTorchOff: 21,
  RedstoneBlock: 22,
  RedstoneLampOff: 23,
  RedstoneLampLit: 24,
  Repeater: 25,
  RepeaterOn: 26,
  Comparator: 27,
  ComparatorOn: 48, // Phase 3: lit comparator tile (pair for Repeater/RepeaterOn)
  PistonSide: 28,
  PistonBase: 29,
  PistonHead: 30,
  StickyPistonSide: 31,
  StickyPistonHead: 32,
  ObserverSide: 33,
  ObserverFront: 34,
  ObserverBack: 35,
  LeverBase: 36,
  ButtonCobble: 37,
  ButtonWood: 38,
  PlateCobble: 39,
  PlateWood: 40,
  TripwireHook: 41,
  DispenserSide: 42,
  DispenserFront: 43,
  DropperSide: 44,
  DropperFront: 45,
  Torch: 46,
  OakDoor: 47,
  // Phase 5A (appended; ComparatorOn=48 already defined above):
  Hopper: 49,
  DaylightDetector: 50,
  TntSide: 51,
  TntTop: 52,
  TntPrimed: 53, // lit (primed) TNT — bright white
  NoteBlock: 54,
  Rail: 55,
  PoweredRail: 56,
  TripwireString: 57,
  DoorBottom: 58,
  DoorTop: 59,
} as const;

// ---------------------------------------------------------------------------
// Block definitions
// ---------------------------------------------------------------------------

export interface BlockDef {
  id: number;
  name: string;
  /** collision: physics treats it as solid */
  solid: boolean;
  /** fully occludes neighboring faces (face culling) */
  opaque: boolean;
  /** seconds to break by hand; -1 = unbreakable (bedrock, water) */
  hardness: number;
  /** item id dropped when broken */
  drop: number;
  /** atlas tile indices per face */
  tiles: { top: number; side: number; bottom: number };
  /** alternate tiles used when the block is powered/lit/on */
  litTiles?: { top: number; side: number; bottom: number };
  /** meta byte semantics */
  meta: MetaSpec;
  /** local box shape for meshing */
  shape: BlockShape;
}

const NONE: MetaSpec = { kind: 'none' };

function def(
  id: number,
  name: string,
  opts: Partial<BlockDef> & Pick<BlockDef, 'solid' | 'opaque' | 'hardness' | 'drop' | 'tiles' | 'meta' | 'shape'>,
): BlockDef {
  return { id, name, ...opts };
}

export const BLOCK_DEFS: BlockDef[] = [
  def(Block.Air, 'air', { solid: false, opaque: false, hardness: 0, drop: Block.Air, tiles: { top: 0, side: 0, bottom: 0 }, meta: NONE, shape: 'full' }),
  def(Block.Stone, 'stone', { solid: true, opaque: true, hardness: 1.5, drop: Block.Stone, tiles: { top: Tile.Stone, side: Tile.Stone, bottom: Tile.Stone }, meta: NONE, shape: 'full' }),
  def(Block.Grass, 'grass', { solid: true, opaque: true, hardness: 0.6, drop: Block.Dirt, tiles: { top: Tile.GrassTop, side: Tile.GrassSide, bottom: Tile.Dirt }, meta: NONE, shape: 'full' }),
  def(Block.Dirt, 'dirt', { solid: true, opaque: true, hardness: 0.5, drop: Block.Dirt, tiles: { top: Tile.Dirt, side: Tile.Dirt, bottom: Tile.Dirt }, meta: NONE, shape: 'full' }),
  def(Block.Sand, 'sand', { solid: true, opaque: true, hardness: 0.5, drop: Block.Sand, tiles: { top: Tile.Sand, side: Tile.Sand, bottom: Tile.Sand }, meta: NONE, shape: 'full' }),
  def(Block.Gravel, 'gravel', { solid: true, opaque: true, hardness: 0.6, drop: Block.Gravel, tiles: { top: Tile.Gravel, side: Tile.Gravel, bottom: Tile.Gravel }, meta: NONE, shape: 'full' }),
  def(Block.Log, 'log', { solid: true, opaque: true, hardness: 2.0, drop: Block.Log, tiles: { top: Tile.LogTop, side: Tile.LogSide, bottom: Tile.LogTop }, meta: NONE, shape: 'full' }),
  def(Block.Leaves, 'leaves', { solid: true, opaque: false, hardness: 0.2, drop: Block.Leaves, tiles: { top: Tile.Leaves, side: Tile.Leaves, bottom: Tile.Leaves }, meta: NONE, shape: 'full' }),
  def(Block.Planks, 'planks', { solid: true, opaque: true, hardness: 1.5, drop: Block.Planks, tiles: { top: Tile.Planks, side: Tile.Planks, bottom: Tile.Planks }, meta: NONE, shape: 'full' }),
  def(Block.Cobblestone, 'cobblestone', { solid: true, opaque: true, hardness: 1.5, drop: Block.Cobblestone, tiles: { top: Tile.Cobblestone, side: Tile.Cobblestone, bottom: Tile.Cobblestone }, meta: NONE, shape: 'full' }),
  def(Block.Glass, 'glass', { solid: true, opaque: false, hardness: 0.3, drop: 0, tiles: { top: Tile.Glass, side: Tile.Glass, bottom: Tile.Glass }, meta: NONE, shape: 'full' }),
  def(Block.Water, 'water', { solid: false, opaque: false, hardness: -1, drop: 0, tiles: { top: Tile.Water, side: Tile.Water, bottom: Tile.Water }, meta: NONE, shape: 'full' }),
  def(Block.Bedrock, 'bedrock', { solid: true, opaque: true, hardness: -1, drop: 0, tiles: { top: Tile.Bedrock, side: Tile.Bedrock, bottom: Tile.Bedrock }, meta: NONE, shape: 'full' }),
  def(Block.Clay, 'clay', { solid: true, opaque: true, hardness: 0.6, drop: Block.Clay, tiles: { top: Tile.Clay, side: Tile.Clay, bottom: Tile.Clay }, meta: NONE, shape: 'full' }),
  def(Block.Snow, 'snow', { solid: true, opaque: true, hardness: 0.1, drop: 0, tiles: { top: Tile.Snow, side: Tile.Snow, bottom: Tile.Snow }, meta: NONE, shape: 'full' }),
  def(Block.CoalOre, 'coal_ore', { solid: true, opaque: true, hardness: 3.0, drop: Block.CoalOre, tiles: { top: Tile.CoalOre, side: Tile.CoalOre, bottom: Tile.CoalOre }, meta: NONE, shape: 'full' }),
  def(Block.IronOre, 'iron_ore', { solid: true, opaque: true, hardness: 3.0, drop: Block.IronOre, tiles: { top: Tile.IronOre, side: Tile.IronOre, bottom: Tile.IronOre }, meta: NONE, shape: 'full' }),
  def(Block.RedstoneOre, 'redstone_ore', { solid: true, opaque: true, hardness: 3.0, drop: Block.RedstoneDust, tiles: { top: Tile.RedstoneOre, side: Tile.RedstoneOre, bottom: Tile.RedstoneOre }, meta: NONE, shape: 'full' }),
  def(Block.RedstoneDust, 'redstone_dust', { solid: false, opaque: false, hardness: 0.0, drop: Block.RedstoneDust, tiles: { top: Tile.RedstoneDust, side: Tile.RedstoneDust, bottom: Tile.RedstoneDust }, meta: { kind: 'strength' }, shape: 'dust' }),
  def(Block.RedstoneTorch, 'redstone_torch', { solid: false, opaque: false, hardness: 0.0, drop: Block.RedstoneTorch, tiles: { top: Tile.RedstoneTorchOff, side: Tile.RedstoneTorchOff, bottom: Tile.RedstoneTorchOff }, litTiles: { top: Tile.RedstoneTorchOn, side: Tile.RedstoneTorchOn, bottom: Tile.RedstoneTorchOn }, meta: { kind: 'onOff' }, shape: 'torch' }),
  def(Block.RedstoneBlock, 'redstone_block', { solid: true, opaque: true, hardness: 1.5, drop: Block.RedstoneBlock, tiles: { top: Tile.RedstoneBlock, side: Tile.RedstoneBlock, bottom: Tile.RedstoneBlock }, meta: NONE, shape: 'full' }),
  def(Block.RedstoneLamp, 'redstone_lamp', { solid: true, opaque: true, hardness: 0.3, drop: Block.RedstoneLamp, tiles: { top: Tile.RedstoneLampOff, side: Tile.RedstoneLampOff, bottom: Tile.RedstoneLampOff }, litTiles: { top: Tile.RedstoneLampLit, side: Tile.RedstoneLampLit, bottom: Tile.RedstoneLampLit }, meta: { kind: 'onOff' }, shape: 'full' }),
  def(Block.Repeater, 'repeater', { solid: false, opaque: false, hardness: 0.0, drop: Block.Repeater, tiles: { top: Tile.Repeater, side: Tile.Repeater, bottom: Tile.Repeater }, litTiles: { top: Tile.RepeaterOn, side: Tile.RepeaterOn, bottom: Tile.RepeaterOn }, meta: { kind: 'facingDelay' }, shape: 'slab' }),
  def(Block.Comparator, 'comparator', { solid: false, opaque: false, hardness: 0.0, drop: Block.Comparator, tiles: { top: Tile.Comparator, side: Tile.Comparator, bottom: Tile.Comparator }, litTiles: { top: Tile.ComparatorOn, side: Tile.ComparatorOn, bottom: Tile.ComparatorOn }, meta: { kind: 'facingModeOutput' }, shape: 'slab' }),
  def(Block.Piston, 'piston', { solid: true, opaque: true, hardness: 1.5, drop: Block.Piston, tiles: { top: Tile.PistonBase, side: Tile.PistonSide, bottom: Tile.PistonBase }, meta: { kind: 'facing' }, shape: 'full' }),
  def(Block.StickyPiston, 'sticky_piston', { solid: true, opaque: true, hardness: 1.5, drop: Block.StickyPiston, tiles: { top: Tile.PistonBase, side: Tile.StickyPistonSide, bottom: Tile.PistonBase }, meta: { kind: 'facing' }, shape: 'full' }),
  def(Block.Observer, 'observer', { solid: true, opaque: true, hardness: 1.5, drop: Block.Observer, tiles: { top: Tile.ObserverBack, side: Tile.ObserverSide, bottom: Tile.ObserverBack }, meta: { kind: 'facing' }, shape: 'full' }),
  def(Block.Lever, 'lever', { solid: false, opaque: false, hardness: 0.0, drop: Block.Lever, tiles: { top: Tile.LeverBase, side: Tile.LeverBase, bottom: Tile.LeverBase }, meta: { kind: 'onOff' }, shape: 'torch' }),
  def(Block.StoneButton, 'stone_button', { solid: false, opaque: false, hardness: 0.0, drop: Block.StoneButton, tiles: { top: Tile.ButtonCobble, side: Tile.ButtonCobble, bottom: Tile.ButtonCobble }, meta: { kind: 'onOff' }, shape: 'slab' }),
  def(Block.WoodButton, 'wood_button', { solid: false, opaque: false, hardness: 0.0, drop: Block.WoodButton, tiles: { top: Tile.ButtonWood, side: Tile.ButtonWood, bottom: Tile.ButtonWood }, meta: { kind: 'onOff' }, shape: 'slab' }),
  def(Block.StonePressurePlate, 'stone_pressure_plate', { solid: false, opaque: false, hardness: 0.0, drop: Block.StonePressurePlate, tiles: { top: Tile.PlateCobble, side: Tile.PlateCobble, bottom: Tile.PlateCobble }, meta: { kind: 'onOff' }, shape: 'slab' }),
  def(Block.WoodPressurePlate, 'wood_pressure_plate', { solid: false, opaque: false, hardness: 0.0, drop: Block.WoodPressurePlate, tiles: { top: Tile.PlateWood, side: Tile.PlateWood, bottom: Tile.PlateWood }, meta: { kind: 'onOff' }, shape: 'slab' }),
  def(Block.TripwireHook, 'tripwire_hook', { solid: false, opaque: false, hardness: 0.0, drop: Block.TripwireHook, tiles: { top: Tile.TripwireHook, side: Tile.TripwireHook, bottom: Tile.TripwireHook }, meta: { kind: 'facingOnOff' }, shape: 'hook' }),
  def(Block.Dispenser, 'dispenser', { solid: true, opaque: true, hardness: 1.5, drop: Block.Dispenser, tiles: { top: Tile.DispenserSide, side: Tile.DispenserSide, bottom: Tile.DispenserSide }, meta: { kind: 'facing' }, shape: 'full' }),
  def(Block.Dropper, 'dropper', { solid: true, opaque: true, hardness: 1.5, drop: Block.Dropper, tiles: { top: Tile.DropperSide, side: Tile.DropperSide, bottom: Tile.DropperSide }, meta: { kind: 'facing' }, shape: 'full' }),
  def(Block.Torch, 'torch', { solid: false, opaque: false, hardness: 0.0, drop: Block.Torch, tiles: { top: Tile.Torch, side: Tile.Torch, bottom: Tile.Torch }, meta: NONE, shape: 'torch' }),
  def(Block.OakDoor, 'oak_door', { solid: true, opaque: false, hardness: 1.5, drop: Block.OakDoor, tiles: { top: Tile.DoorBottom, side: Tile.DoorBottom, bottom: Tile.DoorBottom }, meta: { kind: 'door' }, shape: 'full' }),
  // --- Phase 5A (design.md §4/§8) ---
  def(Block.Hopper, 'hopper', { solid: true, opaque: true, hardness: 1.5, drop: Block.Hopper, tiles: { top: Tile.Hopper, side: Tile.Hopper, bottom: Tile.Hopper }, meta: { kind: 'facing' }, shape: 'hopper' }),
  def(Block.DaylightDetector, 'daylight_detector', { solid: false, opaque: true, hardness: 0.5, drop: Block.DaylightDetector, tiles: { top: Tile.DaylightDetector, side: Tile.DaylightDetector, bottom: Tile.DaylightDetector }, meta: { kind: 'daylight' }, shape: 'slab' }),
  def(Block.Tnt, 'tnt', { solid: true, opaque: true, hardness: 0.0, drop: Block.Tnt, tiles: { top: Tile.TntTop, side: Tile.TntSide, bottom: Tile.TntTop }, litTiles: { top: Tile.TntPrimed, side: Tile.TntPrimed, bottom: Tile.TntPrimed }, meta: { kind: 'onOff' }, shape: 'full' }),
  def(Block.NoteBlock, 'note_block', { solid: true, opaque: true, hardness: 1.5, drop: Block.NoteBlock, tiles: { top: Tile.NoteBlock, side: Tile.NoteBlock, bottom: Tile.NoteBlock }, meta: { kind: 'note' }, shape: 'full' }),
  def(Block.Rail, 'rail', { solid: false, opaque: false, hardness: 0.5, drop: Block.Rail, tiles: { top: Tile.Rail, side: Tile.Rail, bottom: Tile.Rail }, meta: NONE, shape: 'rail' }),
  def(Block.PoweredRail, 'powered_rail', { solid: false, opaque: false, hardness: 0.5, drop: Block.PoweredRail, tiles: { top: Tile.PoweredRail, side: Tile.PoweredRail, bottom: Tile.PoweredRail }, meta: NONE, shape: 'rail' }),
  def(Block.Tripwire, 'tripwire', { solid: false, opaque: false, hardness: 0.0, drop: 0, tiles: { top: Tile.TripwireString, side: Tile.TripwireString, bottom: Tile.TripwireString }, meta: NONE, shape: 'string' }),
];

const BLOCKS: Record<number, BlockDef> = {};
for (const b of BLOCK_DEFS) BLOCKS[b.id] = b;

export function getBlockDef(id: number): BlockDef {
  return BLOCKS[id] ?? BLOCKS[AIR];
}
export function isSolidBlock(id: number): boolean {
  return getBlockDef(id).solid;
}
/**
 * Meta-aware solidity (Phase 5A): the oak door is solid only while CLOSED
 * (bit 2 of its meta unset); every other block uses its static def.
 * Physics (src/player/physics.ts) consults this so a closed door blocks the
 * player and an open door does not.
 */
export function isSolidBlockAt(id: number, meta: number): boolean {
  if (id === Block.OakDoor) return !isDoorOpen(meta);
  return getBlockDef(id).solid;
}
export function isOpaqueBlock(id: number): boolean {
  return getBlockDef(id).opaque;
}
export function blockName(id: number): string {
  return getBlockDef(id).name;
}

// ---------------------------------------------------------------------------
// Item definitions (design.md §4)
// ---------------------------------------------------------------------------

export interface ToolDef {
  type: 'pickaxe' | 'axe' | 'sword' | 'shovel' | 'hoe';
  /** mining speed multiplier */
  speed: number;
  durability: number;
}

export interface ItemDef {
  id: number;
  name: string;
  kind: 'block' | 'food' | 'tool' | 'material';
  /** set when the item can be placed as a block */
  blockId?: number;
  /** hunger restored (design: bread +5, apple +4) */
  foodValue?: number;
  tool?: ToolDef;
}

export const Item = {
  Wheat: 128,
  Bread: 129,
  Apple: 130,
  StonePickaxe: 131,
  StoneAxe: 132,
  StoneSword: 133,
  StoneShovel: 134,
  StoneHoe: 135,
  TripwireString: 136, // Phase 5A: string item for connecting tripwire hooks
} as const;

const ITEMS: Record<number, ItemDef> = {};

// Every placeable block has a matching item with the same id.
// Phase 5A: the tripwire STRING block has no placeable item — it is created
// by connecting two hooks with the `tripwire` item (design.md §8.7).
for (const b of BLOCK_DEFS) {
  if (b.id === AIR || b.id === Block.Tripwire) continue;
  ITEMS[b.id] = { id: b.id, name: b.name, kind: 'block', blockId: b.id };
}

ITEMS[Item.Wheat] = { id: Item.Wheat, name: 'wheat', kind: 'material' };
ITEMS[Item.Bread] = { id: Item.Bread, name: 'bread', kind: 'food', foodValue: 5 };
ITEMS[Item.Apple] = { id: Item.Apple, name: 'apple', kind: 'food', foodValue: 4 };
ITEMS[Item.StonePickaxe] = { id: Item.StonePickaxe, name: 'stone_pickaxe', kind: 'tool', tool: { type: 'pickaxe', speed: 4, durability: 131 } };
ITEMS[Item.StoneAxe] = { id: Item.StoneAxe, name: 'stone_axe', kind: 'tool', tool: { type: 'axe', speed: 4, durability: 131 } };
ITEMS[Item.StoneSword] = { id: Item.StoneSword, name: 'stone_sword', kind: 'tool', tool: { type: 'sword', speed: 3, durability: 131 } };
ITEMS[Item.StoneShovel] = { id: Item.StoneShovel, name: 'stone_shovel', kind: 'tool', tool: { type: 'shovel', speed: 4, durability: 131 } };
ITEMS[Item.StoneHoe] = { id: Item.StoneHoe, name: 'stone_hoe', kind: 'tool', tool: { type: 'hoe', speed: 4, durability: 131 } };
// Phase 5A: the tripwire string is NOT a placeable block — it is used by
// right-clicking a tripwire hook to connect it to another hook (§8.7).
ITEMS[Item.TripwireString] = { id: Item.TripwireString, name: 'tripwire', kind: 'material' };

export function getItemDef(id: number): ItemDef | null {
  return ITEMS[id] ?? null;
}
/** true when the item can be placed as a block (right-click) */
export function isPlaceable(id: number): boolean {
  const it = ITEMS[id];
  return it !== undefined && it.kind === 'block' && it.blockId !== undefined;
}
export function itemBlockId(id: number): number {
  const it = ITEMS[id];
  return it && it.kind === 'block' ? (it.blockId as number) : AIR;
}

export const ALL_BLOCK_IDS: number[] = BLOCK_DEFS.map((b) => b.id);
export const ALL_ITEM_IDS: number[] = Object.keys(ITEMS).map(Number);
