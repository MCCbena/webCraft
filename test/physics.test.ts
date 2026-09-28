import { describe, it, expect } from 'vitest';
import { Player } from '../src/player/player';
import { stepPlayer, emptyInput, aabbHitsSolid } from '../src/player/physics';
import { World } from '../src/world/world';
import { Block, AIR } from '../src/world/blocks';

const DT = 0.05;

/** Flat floor at y=10 (top surface y=11). */
function flatWorld(): World {
  return new World(1, (_w, chunk) => {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y <= 10; y++) {
          chunk.setBlock(x, y, z, Block.Stone);
        }
      }
    }
  });
}

function getBlock(w: World) {
  return (x: number, y: number, z: number): number => w.getBlock(x, y, z);
}

function settle(p: Player, w: World, ticks = 200, input = emptyInput()): void {
  for (let i = 0; i < ticks; i++) {
    stepPlayer(p, input, getBlock(w), DT);
  }
}

describe('player collision', () => {
  it('entity cannot pass through a solid block (wall)', () => {
    const w = flatWorld();
    // wall of stone at x=20, y=0..30, z=-8..8
    for (let y = 0; y <= 30; y++) {
      for (let z = -8; z <= 8; z++) {
        w.setBlock(20, y, z, Block.Stone);
      }
    }
    const p = new Player(5, 15, 0);
    const input = { ...emptyInput(), right: true };
    settle(p, w, 300, input);
    // player center must stay at least half a width away from the wall face
    expect(p.x).toBeLessThan(20 - 0.3);
    expect(p.x).toBeGreaterThan(19); // actually moved toward the wall
  });

  it('entity cannot pass through a block below (falls to the floor)', () => {
    const w = flatWorld();
    const p = new Player(0.5, 30, 0.5);
    settle(p, w);
    expect(p.onGround).toBe(true);
    // feet rest on top of the floor blocks (y=11)
    expect(p.y).toBeCloseTo(11, 1);
    expect(p.vy).toBe(0);
  });

  it('entity cannot pass through a block above (head bump stops ascent)', () => {
    const w = flatWorld();
    // floor top at y=11; ceiling blocks at y=13,14 → 2-block gap (11..13),
    // a 1.8-tall player cannot fit through it (needs 3 blocks)
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        w.setBlock(x, 13, z, Block.Stone);
        w.setBlock(x, 14, z, Block.Stone);
      }
    }
    const p = new Player(0.5, 11.0, 0.5);
    settle(p, w, 10);
    let maxY = p.y;
    for (let i = 0; i < 40; i++) {
      stepPlayer(p, { ...emptyInput(), jump: i < 5 }, getBlock(w), DT);
      if (p.y > maxY) maxY = p.y;
    }
    // head must never cross the ceiling bottom (y=13)
    expect(maxY + 1.8).toBeLessThanOrEqual(13.01);
    // without a ceiling a jump reaches ~12.2; the cap must bite below that
    expect(maxY).toBeLessThan(11.5);
  });

  it('aabbHitsSolid detects overlap with a solid block', () => {
    const w = flatWorld();
    const box = { minX: 0.2, minY: 5, minZ: 0.2, maxX: 0.8, maxY: 6, maxZ: 0.8 };
    expect(aabbHitsSolid(box, getBlock(w))).toBe(true); // y 5..6 is inside the floor
    const airBox = { minX: 0.2, minY: 12, minZ: 0.2, maxX: 0.8, maxY: 14, maxZ: 0.8 };
    expect(aabbHitsSolid(airBox, getBlock(w))).toBe(false);
  });

  it('non-solid blocks (water, dust) do not block movement', () => {
    const w = flatWorld();
    for (let y = 11; y <= 20; y++) {
      for (let z = -1; z <= 1; z++) {
        w.setBlock(0, y, z, Block.Water);
      }
    }
    w.setBlock(0, 11, 0, Block.RedstoneDust);
    const p = new Player(0.5, 20, 0.5);
    settle(p, w, 240); // water fall is slow (3 blocks/s cap)
    // falls through water to the floor
    expect(p.y).toBeCloseTo(11, 1);
  });

  it('jumping moves the player upward then back down', () => {
    const w = flatWorld();
    const p = new Player(0.5, 11, 0.5);
    settle(p, w, 10); // settle on ground
    expect(p.onGround).toBe(true);
    let maxY = p.y;
    for (let i = 0; i < 30; i++) {
      stepPlayer(p, { ...emptyInput(), jump: i < 5 }, getBlock(w), DT);
      if (p.y > maxY) maxY = p.y;
    }
    settle(p, w, 60);
    expect(maxY).toBeGreaterThan(11.5); // jumped at least half a block
    expect(p.y).toBeCloseTo(11, 1); // landed back on the floor
  });

  it('no movement with no input (friction brings velocity to ~0)', () => {
    const w = flatWorld();
    const p = new Player(0.5, 11, 0.5);
    p.vx = 4;
    settle(p, w, 120, emptyInput());
    expect(Math.abs(p.vx)).toBeLessThan(0.01);
    expect(Math.abs(p.x - 0.5)).toBeLessThan(3);
  });

  it('world edge clamps the player (no walking out of the world)', () => {
    const w = flatWorld();
    const p = new Player(-127.9, 11, 0.5);
    settle(p, w, 200, { ...emptyInput(), left: true });
    expect(p.x).toBeGreaterThanOrEqual(-128 + 0.3 - 0.001);
  });
});

/** Flat land (stone y=0..10, surface y=11) with a pool carved at x=0. */
function poolWorld(): World {
  return new World(1, (_w, chunk) => {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y <= 10; y++) {
          chunk.setBlock(x, y, z, Block.Stone);
        }
      }
    }
  });
}

describe('underwater jump', () => {
  it('player in 1-block-deep water jumps out over a 1-block bank', () => {
    const w = poolWorld();
    // carve a 1-wide, 1-block-deep pool at x=0: floor top y=10 (stone y=9),
    // water block at y=10; adjacent land (x=1) has its top block at y=10,
    // i.e. the bank surface is 1 block above the pool floor.
    for (let z = -8; z <= 8; z++) {
      w.setBlock(0, 10, z, AIR);
      w.setBlock(0, 10, z, Block.Water);
    }
    const p = new Player(0.5, 10, 0.5); // feet on the pool floor (y=10)
    const input = { ...emptyInput(), jump: true, right: true };
    for (let i = 0; i < 60; i++) {
      stepPlayer(p, input, getBlock(w), DT); // 3 s of holding jump
    }
    // ended on/above the bank top (y=11), outside the water
    expect(p.inWater).toBe(false);
    expect(p.y).toBeGreaterThanOrEqual(10.99);
  });

  it('player can swim up out of a 5-block-deep pool', () => {
    const w = poolWorld();
    // carve a 5-block-deep pool at x=0: floor top y=6 (stone y=5),
    // water at y=6..10, surface y=11.
    for (let z = -8; z <= 8; z++) {
      for (let y = 6; y <= 10; y++) {
        w.setBlock(0, y, z, Block.Water);
      }
    }
    const p = new Player(0.5, 6, 0.5); // feet on the pool floor (y=6)
    let reachedSurface = false;
    let maxY = 0;
    for (let i = 0; i < 80; i++) {
      stepPlayer(p, { ...emptyInput(), jump: true }, getBlock(w), DT); // 4 s of holding jump
      if (!p.inWater) reachedSurface = true;
      if (p.y > maxY) maxY = p.y;
    }
    // the player broke the surface (y+0.4 body sample above the water column)
    // within the 4 s window; once above the surface it bobs at the top
    expect(reachedSurface).toBe(true);
    expect(maxY).toBeGreaterThanOrEqual(10.6);
  });
});
