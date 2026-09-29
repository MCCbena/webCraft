/**
 * WebCraft — Phase 5A redstone unit tests (design.md §8, "Complete 1.13").
 *
 * Covers the 5A additions on top of the Phase 2C suite (redstone.test.ts):
 *  - a pressure plate on powered dust stays OFF (plates are pure sensors:
 *    entity on top only, 1.13)
 *  - full-world active region (a circuit >3 chunks from the player runs)
 *  - daylight detector (time 6000 → 15, 18000 → 0, inverted 18000 → 15,
 *    0/12000 → 0; output propagates to a dust line; weak-powers the block
 *    below it)
 *  - oak door (power below/side → open + non-solid; remove → close + solid;
 *    right-click toggle)
 *  - tripwire (hook connection fills string cells; player intersection
 *    trips BOTH hooks to 15 (adjacent dust 14); leaving un-trips; placing a
 *    solid block mid-string clears the string + hooks)
 *  - powered rail (unpowered → no output; powered from below → dust 14)
 *  - hopper (hasItems hook → weak 15 to the block BEHIND only)
 *  - TNT (primeTnt 5B entry point sets the primed meta bit)
 *
 * Harness: all-air World (no-op generator) + Redstone.tick() with a mutable
 * player, world time and the 5B hasItems hook. No browser, deterministic.
 */

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world';
import {
  AIR,
  Block,
  Facing,
  getStrength,
  isOn,
  isDoorOpen,
  isSolidBlockAt,
  isDaylightInverted,
} from '../src/world/blocks';
import { Redstone } from '../src/redstone/tick';
import type { RedstoneCtx } from '../src/redstone/types';

// ---------------------------------------------------------------------------
// Harness (5A: mutable player + worldTime + hasItems hook)
// ---------------------------------------------------------------------------

interface Harness5A {
  world: World;
  rs: Redstone;
  ctx: RedstoneCtx;
  /** mutable player feet position (AABB 0.6 × 1.8) */
  player: { x: number; y: number; z: number };
  /** advance n 20 TPS ticks */
  step: (n?: number) => void;
  place: (x: number, y: number, z: number, id: number, meta?: number) => void;
  remove: (x: number, y: number, z: number) => void;
  strength: (x: number, y: number, z: number) => number;
}

function makeHarness5A(opts: {
  player?: { x: number; y: number; z: number };
  worldTime?: number;
  hasItems?: (x: number, y: number, z: number) => boolean;
} = {}): Harness5A {
  const world = new World(1, () => {}); // all air
  const rs = new Redstone();
  const player = { x: 0.5, y: 12, z: 0.5, ...opts.player };
  let worldTime = opts.worldTime ?? 0;
  const hasItems = opts.hasItems ?? (() => false);
  const ctx: RedstoneCtx = {
    playerX: player.x,
    playerY: player.y,
    playerZ: player.z,
    get worldTime() {
      return worldTime;
    },
    hasItems,
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
  const h: Harness5A = {
    world,
    rs,
    ctx,
    player,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) rs.tick(world, ctx);
    },
    place: (x, y, z, id, meta = 0) => world.setBlock(x, y, z, id, meta),
    remove: (x, y, z) => world.setBlock(x, y, z, AIR),
    strength: (x, y, z) => getStrength(world.getMeta(x, y, z)),
  };
  // Expose the world-time setter through the harness (tests mutate it).
  Object.assign(h, { setWorldTime: (t: number) => (worldTime = t) });
  return h;
}

/** Place a full door (bottom + top half) at (x, y, z). */
function placeDoor(h: Harness5A, x: number, y: number, z: number): void {
  h.place(x, y, z, Block.OakDoor, 0); // bottom: closed
  h.place(x, y + 1, z, Block.OakDoor, 0x02); // top half
}

// ---------------------------------------------------------------------------
// Dust powers the block above (pressure plate is a pure sensor, 1.13)
// ---------------------------------------------------------------------------

describe('dust powers the block above (Phase 5A)', () => {
  it('powered dust below does NOT activate a pressure plate (plates are sensors, 1.13)', () => {
    const h = makeHarness5A({ player: { x: 20.5, y: 12, z: 20.5 } }); // far away
    h.place(0, 9, 0, Block.RedstoneTorch, 1); // source
    h.place(0, 10, 0, Block.RedstoneDust); // dust below the plate
    h.place(0, 11, 0, Block.StonePressurePlate);
    h.step(3);
    expect(h.strength(0, 10, 0)).toBeGreaterThan(0); // dust is live (14)
    expect(isOn(h.world.getMeta(0, 11, 0))).toBe(false); // plate stays OFF (sensor only)
    // ...and it DOES output 15 when an entity stands on top (the 1.13 rule)
    h.player.x = 0.5;
    h.player.y = 12.0; // feet on the plate (plate at y=11)
    h.player.z = 0.5;
    h.ctx.playerX = 0.5;
    h.ctx.playerY = 12.0;
    h.ctx.playerZ = 0.5;
    h.step(1);
    expect(isOn(h.world.getMeta(0, 11, 0))).toBe(true); // entity on top → 15
    h.player.x = 20.5;
    h.ctx.playerX = 20.5;
    h.step(1);
    expect(isOn(h.world.getMeta(0, 11, 0))).toBe(false); // entity leaves → off
  });
});

// ---------------------------------------------------------------------------
// Full-world active region (no player 3×3 chunk limit)
// ---------------------------------------------------------------------------

describe('full-world active region (Phase 5A)', () => {
  it('a circuit >3 chunks from the player still runs (lamp lights)', () => {
    const h = makeHarness5A({ player: { x: 0.5, y: 12, z: 0.5 } });
    // circuit at x=48..51 — chunk 3, far outside the old ±3 chunk window
    // around the player (x ∈ [-16, 47] at chunk granularity).
    h.place(48, 10, 0, Block.RedstoneTorch, 1);
    for (let n = 49; n <= 50; n++) h.place(n, 10, 0, Block.RedstoneDust);
    h.place(51, 10, 0, Block.RedstoneLamp);
    h.step(3);
    expect(h.strength(49, 10, 0)).toBe(14);
    expect(h.strength(50, 10, 0)).toBe(13);
    expect(isOn(h.world.getMeta(51, 10, 0))).toBe(true); // lamp lit
    // and it drains when the source dies (the region is truly live, not
    // just "on")
    h.remove(48, 10, 0);
    h.step(3);
    expect(isOn(h.world.getMeta(51, 10, 0))).toBe(false);
  });

  it('a repeater far from the player sustains its output', () => {
    const h = makeHarness5A({ player: { x: -120, y: 12, z: -120 } });
    h.place(100, 10, 0, Block.RedstoneBlock);
    h.place(100, 11, 0, Block.RedstoneDust); // input 15
    h.place(101, 11, 0, Block.Repeater, Facing.East);
    h.place(102, 11, 0, Block.RedstoneDust); // output dust
    h.place(103, 11, 0, Block.RedstoneLamp);
    h.step(4);
    expect(h.strength(102, 11, 0)).toBe(15); // front dust 15
    expect(isOn(h.world.getMeta(103, 11, 0))).toBe(true);
    h.step(10); // sustained while the input persists
    expect(h.strength(102, 11, 0)).toBe(15);
    expect(isOn(h.world.getMeta(103, 11, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Daylight detector
// ---------------------------------------------------------------------------

describe('daylight detector (Phase 5A, §8.6)', () => {
  it('time 6000 (noon) → output 15 → adjacent dust 14', () => {
    const h = makeHarness5A({ worldTime: 6000 });
    h.place(0, 10, 0, Block.DaylightDetector);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(14);
  });

  it('time 18000 (night) → 0; time 0 and 12000 → 0', () => {
    for (const t of [0, 12000, 18000]) {
      const h = makeHarness5A({ worldTime: t });
      h.place(0, 10, 0, Block.DaylightDetector);
      h.place(1, 10, 0, Block.RedstoneDust);
      h.step(2);
      expect(h.strength(1, 10, 0), `t=${t}`).toBe(0);
    }
  });

  it('inverted at night (18000) → 15 → adjacent dust 14', () => {
    const h = makeHarness5A({ worldTime: 18000 });
    h.place(0, 10, 0, Block.DaylightDetector, 0x02); // inverted bit
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(isDaylightInverted(h.world.getMeta(0, 10, 0))).toBe(true);
    expect(h.strength(1, 10, 0)).toBe(14);
  });

  it('output changes propagate to a dust line as time advances', () => {
    const h = makeHarness5A({ worldTime: 6000 });
    h.place(0, 10, 0, Block.DaylightDetector);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.place(2, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(14);
    expect(h.strength(2, 10, 0)).toBe(13);
    (h as unknown as { setWorldTime: (t: number) => void }).setWorldTime(18000);
    h.step(3);
    expect(h.strength(1, 10, 0)).toBe(0);
    expect(h.strength(2, 10, 0)).toBe(0);
  });

  it('weak-powers the block directly below it (dust under the detector)', () => {
    const h = makeHarness5A({ worldTime: 6000 });
    h.place(0, 10, 0, Block.RedstoneDust); // below
    h.place(0, 11, 0, Block.DaylightDetector);
    h.step(2);
    expect(h.strength(0, 10, 0)).toBe(15); // detector output 15 → dust 15
  });
});

// ---------------------------------------------------------------------------
// Oak door
// ---------------------------------------------------------------------------

describe('oak door (Phase 5A, §8.4)', () => {
  it('strong power below opens the door (both halves), removing it closes', () => {
    const h = makeHarness5A();
    placeDoor(h, 0, 10, 0);
    h.place(0, 9, 0, Block.RedstoneBlock); // strong power from below
    h.step(2);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true);
    expect(isDoorOpen(h.world.getMeta(0, 11, 0))).toBe(true);
    expect(isSolidBlockAt(Block.OakDoor, h.world.getMeta(0, 10, 0))).toBe(false); // open = non-solid
    h.remove(0, 9, 0);
    h.step(2);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(false);
    expect(isDoorOpen(h.world.getMeta(0, 11, 0))).toBe(false);
    expect(isSolidBlockAt(Block.OakDoor, h.world.getMeta(0, 10, 0))).toBe(true); // closed = solid
  });

  it('weak power from a horizontal neighbor (lever) opens the door', () => {
    const h = makeHarness5A();
    placeDoor(h, 0, 10, 0);
    h.place(1, 10, 0, Block.Lever, 1);
    h.step(2);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true);
    h.world.setBlock(1, 10, 0, Block.Lever, 0);
    h.step(2);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(false);
  });

  it('right-click toggles open/close when unpowered', () => {
    const h = makeHarness5A();
    placeDoor(h, 0, 10, 0);
    expect(isSolidBlockAt(Block.OakDoor, h.world.getMeta(0, 10, 0))).toBe(true);
    h.rs.toggleDoor(h.world, 0, 10, 0); // open
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true);
    expect(isSolidBlockAt(Block.OakDoor, h.world.getMeta(0, 10, 0))).toBe(false);
    h.step(3); // stays open (manual state, no power)
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true);
    h.rs.toggleDoor(h.world, 0, 11, 0); // toggle via the TOP half too
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(false);
    expect(isSolidBlockAt(Block.OakDoor, h.world.getMeta(0, 10, 0))).toBe(true);
  });

  it('a powered door cannot be closed by right-click (locked open)', () => {
    const h = makeHarness5A();
    placeDoor(h, 0, 10, 0);
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.step(2);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true);
    h.rs.toggleDoor(h.world, 0, 10, 0); // ignored while powered
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true);
    h.remove(0, 9, 0);
    h.step(2);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(false);
  });

  it('powered dust below opens the door (weak power from below counts, 1.13)', () => {
    const h = makeHarness5A();
    placeDoor(h, 0, 10, 0);
    h.place(0, 8, 0, Block.RedstoneTorch, 1);
    h.place(0, 9, 0, Block.RedstoneDust); // dust below the door (weak power)
    h.step(3);
    expect(h.strength(0, 9, 0)).toBe(15); // dust on a lit torch = 15
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(true); // 1.13: dust powers the block above
    h.remove(0, 8, 0); // kill the source: dust drains, door closes
    h.step(3);
    expect(isDoorOpen(h.world.getMeta(0, 10, 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tripwire
// ---------------------------------------------------------------------------

describe('tripwire (Phase 5A, §8.7)', () => {
  /** Two hooks at (0,10,0) and (4,10,0) on a stone floor at y=9. */
  function hookFixture(): Harness5A {
    const h = makeHarness5A();
    for (let x = -2; x <= 6; x++) h.place(x, 9, 0, Block.Stone);
    h.place(0, 10, 0, Block.TripwireHook, Facing.East);
    h.place(4, 10, 0, Block.TripwireHook, Facing.West);
    return h;
  }

  it('connecting with the string item fills the intermediate cells', () => {
    const h = hookFixture();
    // eye just west of hook 1, looking +X along the hook line
    const ok = h.rs.tryConnectTripwire(h.world, 0, 10, 0, -0.5, 10.5, 0.5, 1, 0, 0);
    expect(ok).toBe(true);
    for (let x = 1; x <= 3; x++) expect(h.world.getBlock(x, 10, 0), `x=${x}`).toBe(Block.Tripwire);
    // hooks are flagged "has string" (facingOnOff on bit)
    expect(h.world.getMeta(0, 10, 0) & 0x04).toBe(0x04);
    expect(h.world.getMeta(4, 10, 0) & 0x04).toBe(0x04);
  });

  it('connection fails when a solid block sits mid-line', () => {
    const h = hookFixture();
    h.place(2, 10, 0, Block.Stone); // obstruction
    const ok = h.rs.tryConnectTripwire(h.world, 0, 10, 0, -0.5, 10.5, 0.5, 1, 0, 0);
    expect(ok).toBe(false);
    expect(h.world.getBlock(1, 10, 0)).toBe(AIR); // no string created
  });

  it('player intersecting a string cell trips BOTH hooks (output 15, dust 14)', () => {
    const h = hookFixture();
    expect(h.rs.tryConnectTripwire(h.world, 0, 10, 0, -0.5, 10.5, 0.5, 1, 0, 0)).toBe(true);
    h.place(-1, 10, 0, Block.RedstoneDust); // observe hook 1's output
    // un-tripped: no output
    h.step(2);
    expect(h.strength(-1, 10, 0)).toBe(0);
    expect(h.rs.isHookTripped(0, 10, 0)).toBe(false);
    // player walks into the string cell at (2,10,0)
    h.player.x = 2.5;
    h.player.y = 10.0;
    h.player.z = 0.5;
    h.ctx.playerX = 2.5;
    h.ctx.playerY = 10.0;
    h.ctx.playerZ = 0.5;
    h.step(1);
    expect(h.rs.isHookTripped(0, 10, 0)).toBe(true);
    expect(h.rs.isHookTripped(4, 10, 0)).toBe(true); // BOTH endpoints
    expect(h.strength(-1, 10, 0)).toBe(14); // hook 1 → 15 → dust 14
    // player moves away → un-tripped
    h.player.x = 20.5;
    h.ctx.playerX = 20.5;
    h.step(1);
    expect(h.rs.isHookTripped(0, 10, 0)).toBe(false);
    expect(h.rs.isHookTripped(4, 10, 0)).toBe(false);
    h.step(2);
    expect(h.strength(-1, 10, 0)).toBe(0);
  });

  it('placing a solid block mid-string clears the string and the hooks', () => {
    const h = hookFixture();
    expect(h.rs.tryConnectTripwire(h.world, 0, 10, 0, -0.5, 10.5, 0.5, 1, 0, 0)).toBe(true);
    // the player trips it, then a block is placed into the string
    h.player.x = 1.5;
    h.player.y = 10.0;
    h.ctx.playerX = 1.5;
    h.ctx.playerY = 10.0;
    h.step(1);
    expect(h.rs.isHookTripped(0, 10, 0)).toBe(true);
    h.rs.worldEdit(h.world, 2, 10, 0, Block.Stone, 0); // solid onto a string cell
    // string cells cleared, hooks un-flagged
    for (let x = 1; x <= 3; x++) expect(h.world.getBlock(x, 10, 0), `x=${x}`).not.toBe(Block.Tripwire);
    expect(h.world.getBlock(2, 10, 0)).toBe(Block.Stone);
    expect(h.world.getMeta(0, 10, 0) & 0x04).toBe(0);
    expect(h.world.getMeta(4, 10, 0) & 0x04).toBe(0);
    h.step(2);
    expect(h.rs.isHookTripped(0, 10, 0)).toBe(false);
    expect(h.rs.isHookTripped(4, 10, 0)).toBe(false);
  });

  it('mining a hook clears its string', () => {
    const h = hookFixture();
    expect(h.rs.tryConnectTripwire(h.world, 0, 10, 0, -0.5, 10.5, 0.5, 1, 0, 0)).toBe(true);
    h.rs.worldEdit(h.world, 0, 10, 0, AIR, 0); // mine hook 1
    for (let x = 1; x <= 3; x++) expect(h.world.getBlock(x, 10, 0), `x=${x}`).toBe(AIR);
    expect(h.world.getMeta(4, 10, 0) & 0x04).toBe(0); // partner un-flagged
  });
});

// ---------------------------------------------------------------------------
// Powered rail
// ---------------------------------------------------------------------------

describe('powered rail (Phase 5A, §8.8)', () => {
  it('unpowered: no output to adjacent dust', () => {
    const h = makeHarness5A();
    h.place(0, 10, 0, Block.PoweredRail);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(0);
  });

  it('redstone block below powers the rail → adjacent dust 14', () => {
    const h = makeHarness5A();
    h.place(0, 9, 0, Block.RedstoneBlock);
    h.place(0, 10, 0, Block.PoweredRail);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(14);
    // and the rail strong-powers the block above (dust on the rail = 15)
    h.place(0, 11, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(0, 11, 0)).toBe(15);
  });

  it('adjacent powered dust powers the rail', () => {
    const h = makeHarness5A();
    h.place(2, 10, 0, Block.RedstoneTorch, 1);
    h.place(1, 10, 0, Block.RedstoneDust); // 14
    h.place(0, 10, 0, Block.PoweredRail);
    h.place(-1, 10, 0, Block.RedstoneDust); // observe the rail's output
    h.step(3);
    expect(h.strength(-1, 10, 0)).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Hopper (5B hasItems hook contract)
// ---------------------------------------------------------------------------

describe('hopper power (Phase 5A, §8.1 — 5B hasItems contract)', () => {
  it('empty hopper: no power; with items: weak 15 to the block BEHIND only', () => {
    const h = makeHarness5A();
    h.place(0, 10, 0, Block.Hopper, Facing.East); // spout faces +X
    h.place(-1, 10, 0, Block.RedstoneDust); // behind
    h.place(1, 10, 0, Block.RedstoneDust); // in front
    h.step(2);
    expect(h.strength(-1, 10, 0)).toBe(0);
    expect(h.strength(1, 10, 0)).toBe(0);
    // 5B wires real containers here; the hook contract is hasItems():
    const ctx = h.ctx;
    ctx.hasItems = (x, y, z) => x === 0 && y === 10 && z === 0;
    h.step(2);
    expect(h.strength(-1, 10, 0)).toBe(14); // behind → 15 → dust 14
    expect(h.strength(1, 10, 0)).toBe(0); // front NOT powered (1.13)
  });
});

// ---------------------------------------------------------------------------
// TNT (5B priming entry point)
// ---------------------------------------------------------------------------

describe('TNT (Phase 5A: block + 5B priming entry point)', () => {
  it('primeTnt sets the primed meta bit; non-TNT is ignored', () => {
    const h = makeHarness5A();
    h.place(0, 10, 0, Block.Tnt);
    h.place(1, 10, 0, Block.Stone);
    h.rs.primeTnt(h.world, 0, 10, 0);
    expect(isOn(h.world.getMeta(0, 10, 0))).toBe(true); // primed (litTiles → white)
    h.rs.primeTnt(h.world, 1, 10, 0);
    expect(h.world.getMeta(1, 10, 0)).toBe(0); // stone untouched
  });
});

// ---------------------------------------------------------------------------
// Registry hygiene
// ---------------------------------------------------------------------------

describe('registry hygiene (Phase 5A)', () => {
  it('components placed, removed, and re-placed keep ticking correctly', () => {
    const h = makeHarness5A();
    h.place(0, 10, 0, Block.RedstoneTorch, 1);
    h.place(1, 10, 0, Block.RedstoneDust);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(14);
    h.remove(0, 10, 0);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(0);
    // re-place at the same position → ticks again (registry re-syncs)
    h.place(0, 10, 0, Block.RedstoneTorch, 1);
    h.step(2);
    expect(h.strength(1, 10, 0)).toBe(14);
  });
});
