/**
 * WebCraft — Phase 5B redstone unit tests (design.md §8.4/§8.5, "Complete 1.13").
 *
 * Covers the 5B additions on top of the 5A suite:
 *  - container content system (hopper 5 / dropper / dispenser 9 slots):
 *    hopper above→hopper→below transfer, hopper powers the block behind,
 *    dropper ejection (air front places a block; container front inserts;
 *    solid front keeps the item), dispenser "use" (place block, prime TNT),
 *    contents survive a piston move, breaking returns contents to inventory.
 *  - TNT: primeTnt → 80-tick fuse → explosion (radius-4 destroy, bedrock
 *    intact, no drops, distance-falloff damage), power rising-edge prime,
 *    fuse cannot be cancelled.
 *  - note block: pitch meta persistence + right-click cycle (24→0) + power
 *    rising-edge play (pitch + block above).
 *  - piston: extension into the player deals exactly 2 HP; the block moves.
 *
 * Harness: all-air World (no-op generator) + Redstone.tick() with a mutable
 * player and the 5B hooks (hasItems wired to the real container registry,
 * damage/explosion/note recorders). No browser, deterministic.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world';
import {
  AIR,
  Block,
  Facing,
  getStrength,
  getNotePitch,
  setNotePitch,
  isOn,
} from '../src/world/blocks';
import { Redstone } from '../src/redstone/tick';
import type { RedstoneCtx } from '../src/redstone/types';
import type { ItemStack } from '../src/player/inventory';

// ---------------------------------------------------------------------------
// Harness (5B: player + hasItems + damage/explosion/note recorders)
// ---------------------------------------------------------------------------

interface Harness5B {
  world: World;
  rs: Redstone;
  ctx: RedstoneCtx;
  player: { x: number; y: number; z: number };
  /** recorded player damage amounts (in order) */
  damage: number[];
  /** recorded explosions { x, y, z, dist } */
  explosions: { x: number; y: number; z: number; dist: number }[];
  /** recorded note plays { pitch, blockAbove } */
  notes: { pitch: number; blockAbove: number }[];
  /** move the player (updates both the AABB source and the ctx) */
  movePlayer: (x: number, y: number, z: number) => void;
  /** advance n 20 TPS ticks */
  step: (n?: number) => void;
  /** place a block via the redstone world-edit path (creates container state) */
  place: (x: number, y: number, z: number, id: number, meta?: number) => void;
  remove: (x: number, y: number, z: number) => void;
  strength: (x: number, y: number, z: number) => number;
  /** total item count in the container at (x,y,z) */
  total: (x: number, y: number, z: number) => number;
  /** put a stack in a container slot (the container must already be placed) */
  setItem: (x: number, y: number, z: number, slot: number, id: number, count: number) => void;
}

function makeHarness5B(opts: { player?: { x: number; y: number; z: number } } = {}): Harness5B {
  const world = new World(1, () => {}); // all air
  const rs = new Redstone();
  const player = { x: 0.5, y: 12, z: 0.5, ...opts.player };
  const damage: number[] = [];
  const explosions: { x: number; y: number; z: number; dist: number }[] = [];
  const notes: { pitch: number; blockAbove: number }[] = [];
  const ctx: RedstoneCtx = {
    playerX: player.x,
    playerY: player.y,
    playerZ: player.z,
    worldTime: 0,
    // 5B: wire the real container item system into the power model.
    hasItems: (x, y, z) => rs.containers.hasItems(x, y, z),
    onPlayerDamage: (amount) => damage.push(amount),
    onExplosion: (x, y, z, dist) => explosions.push({ x, y, z, dist }),
    onNotePlay: (pitch, blockAbove) => notes.push({ pitch, blockAbove }),
    entityAbove: (x, y, z) => {
      const minX = player.x - 0.3;
      const maxX = player.x + 0.3;
      const minY = player.y;
      const maxY = player.y + 1.8;
      const minZ = player.z - 0.3;
      const maxZ = player.z + 0.3;
      return minX < x + 1 && maxX > x && minY < y + 1 && maxY > y && minZ < z + 1 && maxZ > z;
    },
  };
  const h: Harness5B = {
    world,
    rs,
    ctx,
    player,
    damage,
    explosions,
    notes,
    movePlayer: (x, y, z) => {
      player.x = x;
      player.y = y;
      player.z = z;
      ctx.playerX = x;
      ctx.playerY = y;
      ctx.playerZ = z;
    },
    step: (n = 1) => {
      for (let i = 0; i < n; i++) rs.tick(world, ctx);
    },
    place: (x, y, z, id, meta = 0) => rs.worldEdit(world, x, y, z, id, meta),
    remove: (x, y, z) => rs.worldEdit(world, x, y, z, AIR, 0),
    strength: (x, y, z) => getStrength(world.getMeta(x, y, z)),
    total: (x, y, z) => rs.containers.totalItems(x, y, z),
    setItem: (x, y, z, slot, id, count) => {
      const st = rs.containers.get(x, y, z);
      if (!st) throw new Error('container not placed: ' + x + ',' + y + ',' + z);
      st.slots[slot] = { id, count } as ItemStack;
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// Hopper
// ---------------------------------------------------------------------------

describe('hopper (Phase 5B, §8.5)', () => {
  it('transfers items: container above → hopper → container below', () => {
    const h = makeHarness5B();
    h.place(0, 11, 0, Block.Dropper, Facing.East); // above
    h.place(0, 10, 0, Block.Hopper, Facing.East); // hopper
    h.place(0, 9, 0, Block.Dropper, Facing.East); // below
    h.setItem(0, 11, 0, 0, Block.Stone, 3);
    h.step(2);
    expect(h.total(0, 11, 0)).toBe(0); // above drained
    expect(h.total(0, 10, 0)).toBe(0); // hopper empty (transit only)
    expect(h.total(0, 9, 0)).toBe(3); // below received all 3
  });

  it('with items powers the block BEHIND it (dust → 14), not the front', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Hopper, Facing.East); // spout +X → behind is -X
    h.place(-1, 10, 0, Block.RedstoneDust); // behind
    h.place(1, 10, 0, Block.RedstoneDust); // in front
    h.step(2);
    expect(h.strength(-1, 10, 0)).toBe(0);
    expect(h.strength(1, 10, 0)).toBe(0);
    h.setItem(0, 10, 0, 0, Block.Stone, 1);
    h.step(2);
    expect(h.strength(-1, 10, 0)).toBe(14); // behind powered (15 → 14)
    expect(h.strength(1, 10, 0)).toBe(0); // front NOT powered (1.13)
  });
});

// ---------------------------------------------------------------------------
// Dropper
// ---------------------------------------------------------------------------

describe('dropper (Phase 5B, §8.5)', () => {
  it('powered dropper ejects a block item into an air front after 8 ticks', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Dropper, Facing.East);
    h.place(-1, 10, 0, Block.RedstoneBlock); // power from behind
    h.setItem(0, 10, 0, 0, Block.Stone, 3);
    h.step(7);
    expect(h.world.getBlock(1, 10, 0)).toBe(AIR); // not yet (7 < 8)
    h.step(1); // 8th tick
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Stone); // placed
    expect(h.total(0, 10, 0)).toBe(2); // one consumed
  });

  it('does not eject when the front is a solid (non-container) block', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Dropper, Facing.East);
    h.place(-1, 10, 0, Block.RedstoneBlock);
    h.place(1, 10, 0, Block.Stone); // front blocked
    h.setItem(0, 10, 0, 0, Block.Dirt, 3);
    h.step(8);
    expect(h.total(0, 10, 0)).toBe(3); // nothing ejected
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Stone); // front unchanged
  });

  it('inserts into a container in front (if it has room)', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Dropper, Facing.East);
    h.place(1, 10, 0, Block.Dropper, Facing.East); // container in front
    h.place(-1, 10, 0, Block.RedstoneBlock);
    h.setItem(0, 10, 0, 0, Block.Stone, 3);
    h.step(8);
    expect(h.total(0, 10, 0)).toBe(2); // one inserted
    expect(h.total(1, 10, 0)).toBe(1); // one in the front container
  });
});

// ---------------------------------------------------------------------------
// Dispenser
// ---------------------------------------------------------------------------

describe('dispenser (Phase 5B, §8.5)', () => {
  it('powered dispenser places a block item in front', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Dispenser, Facing.East);
    h.place(-1, 10, 0, Block.RedstoneBlock);
    h.setItem(0, 10, 0, 0, Block.Cobblestone, 1);
    h.step(8);
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Cobblestone);
    expect(h.total(0, 10, 0)).toBe(0);
  });

  it('primes a TNT when the front is air and it holds a tnt item', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Dispenser, Facing.East);
    h.place(-1, 10, 0, Block.RedstoneBlock);
    h.setItem(0, 10, 0, 0, Block.Tnt, 1);
    h.step(8);
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Tnt); // placed
    expect(isOn(h.world.getMeta(1, 10, 0))).toBe(true); // primed
  });
});

// ---------------------------------------------------------------------------
// Container contents + piston / breaking
// ---------------------------------------------------------------------------

describe('container lifecycle (Phase 5B)', () => {
  it('contents survive a piston move (the items travel with the block)', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Piston, Facing.East); // base, head at (1,10,0)
    h.place(2, 10, 0, Block.Dropper, Facing.East); // pushed column
    h.setItem(2, 10, 0, 0, Block.Stone, 5);
    h.place(-1, 10, 0, Block.RedstoneBlock); // power the piston
    h.step(5);
    expect(h.world.getBlock(3, 10, 0)).toBe(Block.Dropper); // pushed to (3,10,0)
    expect(h.world.getBlock(2, 10, 0)).toBe(AIR); // original cell cleared
    expect(h.total(3, 10, 0)).toBe(5); // items moved with the dropper
    expect(h.total(2, 10, 0)).toBe(0);
  });

  it('breaking a container returns its contents to the inventory', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Dropper, Facing.East);
    h.setItem(0, 10, 0, 0, Block.Stone, 10);
    h.setItem(0, 10, 0, 1, Block.Dirt, 5);
    const got: [number, number][] = [];
    const returned = h.rs.drainContainerToInventory(0, 10, 0, (id, count) => got.push([id, count]));
    expect(returned).toBe(15);
    expect(got).toContainEqual([Block.Stone, 10]);
    expect(got).toContainEqual([Block.Dirt, 5]);
    expect(h.rs.containers.has(0, 10, 0)).toBe(false); // state destroyed
  });

  it('placing then removing a container creates then destroys its state', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Hopper, Facing.East);
    expect(h.rs.containers.has(0, 10, 0)).toBe(true);
    expect(h.rs.containerSlotCount(0, 10, 0)).toBe(5); // hopper = 5 slots
    h.remove(0, 10, 0);
    expect(h.rs.containers.has(0, 10, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TNT
// ---------------------------------------------------------------------------

describe('TNT (Phase 5B, §8.4)', () => {
  it('primeTnt → 80 ticks → explosion: radius-4 destroy, bedrock intact, no drops', () => {
    const h = makeHarness5B({ player: { x: 50.5, y: 12, z: 50.5 } }); // far away
    h.place(0, 10, 0, Block.Tnt);
    h.place(1, 10, 0, Block.Stone);
    h.place(-1, 10, 0, Block.Stone);
    h.place(0, 11, 0, Block.Stone);
    h.place(0, 9, 0, Block.Stone);
    h.place(4, 10, 0, Block.Stone); // exactly distance 4 → destroyed
    h.place(5, 10, 0, Block.Stone); // distance 5 → survives
    h.place(0, 10, 4, Block.Bedrock); // bedrock within radius → intact
    h.rs.primeTnt(h.world, 0, 10, 0);
    h.step(79);
    expect(h.world.getBlock(0, 10, 0)).toBe(Block.Tnt); // not yet (79 < 80)
    h.step(1); // 80th tick → detonate
    expect(h.world.getBlock(0, 10, 0)).toBe(AIR); // TNT gone
    expect(h.world.getBlock(1, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(-1, 10, 0)).toBe(AIR);
    expect(h.world.getBlock(0, 11, 0)).toBe(AIR);
    expect(h.world.getBlock(4, 10, 0)).toBe(AIR); // distance 4 destroyed
    expect(h.world.getBlock(5, 10, 0)).toBe(Block.Stone); // distance 5 survives
    expect(h.world.getBlock(0, 10, 4)).toBe(Block.Bedrock); // bedrock intact
    expect(h.explosions.length).toBe(1);
  });

  it('player at the center takes ~12 damage; a player at distance 5 takes 0', () => {
    // player AABB center coincides with the TNT center
    const h1 = makeHarness5B();
    h1.movePlayer(0.5, 10.5 - 0.9, 0.5);
    h1.place(0, 10, 0, Block.Tnt);
    h1.rs.primeTnt(h1.world, 0, 10, 0);
    h1.step(80);
    expect(h1.damage).toContain(12); // max damage at the center

    // player 5 blocks away (AABB center at distance 5)
    const h2 = makeHarness5B();
    h2.movePlayer(5.5, 10.5 - 0.9, 0.5);
    h2.place(0, 10, 0, Block.Tnt);
    h2.rs.primeTnt(h2.world, 0, 10, 0);
    h2.step(80);
    expect(h2.damage.length).toBe(0); // zero damage at distance 5
  });

  it('power rising edge primes a normal TNT; the fuse cannot be cancelled', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Tnt);
    h.place(-1, 10, 0, Block.RedstoneTorch, 1); // power ON
    h.step(1);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true); // primed after 1 tick
    // remove the power before the fuse expires
    h.world.setBlock(-1, 10, 0, Block.RedstoneTorch, 0);
    h.step(10);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true); // still primed
    h.step(70); // let the fuse run out
    expect(h.world.getBlock(0, 10, 0)).toBe(AIR); // exploded
  });
});

// ---------------------------------------------------------------------------
// Note block
// ---------------------------------------------------------------------------

describe('note block (Phase 5B, §8.4)', () => {
  it('plays on a power rising edge (pitch + block above for timbre)', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.NoteBlock, setNotePitch(0, 12)); // default pitch 12
    h.place(0, 11, 0, Block.Log); // wood above → "guitar"
    h.place(-1, 10, 0, Block.RedstoneBlock); // power
    h.step(2);
    expect(h.notes.length).toBe(1);
    expect(h.notes[0].pitch).toBe(12);
    expect(h.notes[0].blockAbove).toBe(Block.Log);
    // sustained power does not re-trigger (rising edge only)
    h.step(5);
    expect(h.notes.length).toBe(1);
  });

  it('pitch meta persists and the right-click cycle wraps 24 → 0', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.NoteBlock, setNotePitch(0, 12));
    expect(getNotePitch(h.world.getMeta(0, 10, 0))).toBe(12);
    // replicate the game.ts right-click cycle: (pitch + 1) % 25 over 0..24
    let meta = h.world.getMeta(0, 10, 0);
    for (let p = 13; p <= 24; p++) {
      meta = setNotePitch(meta, (getNotePitch(meta) + 1) % 25);
      expect(getNotePitch(meta), `pitch ${p}`).toBe(p);
    }
    meta = setNotePitch(meta, (getNotePitch(meta) + 1) % 25);
    expect(getNotePitch(meta)).toBe(0); // 24 wraps to 0
  });
});

// ---------------------------------------------------------------------------
// Piston push damage
// ---------------------------------------------------------------------------

describe('piston push damage (Phase 5B, §8.3)', () => {
  it('extension into the player deals exactly 2 HP and the block still moves', () => {
    const h = makeHarness5B();
    h.place(0, 10, 0, Block.Piston, Facing.East); // head extends to (2,10,0)
    h.place(-1, 10, 0, Block.RedstoneBlock); // power
    // player standing in the head's destination cell (2,10,0)
    h.movePlayer(2.5, 10.0, 0.5);
    h.step(5);
    const twos = h.damage.filter((d) => d === 2);
    expect(twos.length).toBe(1); // exactly 2 HP, once
    // the piston still extended: the base moved to the head position (1,10,0)
    expect(h.world.getBlock(1, 10, 0)).toBe(Block.Piston);
    expect(h.world.getBlock(0, 10, 0)).toBe(AIR); // original base cleared
  });
});
