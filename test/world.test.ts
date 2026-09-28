import { describe, it, expect } from 'vitest';
import { World, WORLD_SIZE_X, WORLD_SIZE_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../src/world/world';
import { AIR, Block } from '../src/world/blocks';

/** World with a flat floor (custom generator — proves injection works). */
function flatWorld(floorY = 10, seed = 1): World {
  return new World(seed, (_w, chunk, cx, cz) => {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y <= floorY; y++) {
          chunk.setBlock(x, y, z, y === floorY ? Block.Stone : Block.Dirt);
        }
      }
    }
  });
}

describe('World structure', () => {
  // NOTE: the approved spec (design.md §1/§5, corrected in Phase 4) is a
  // 16×16 chunk world = 256×256 blocks (16-block chunks × 16×16 grid),
  // height 256. The old 4096×4096 figure in the design doc was a spec error.
  it('is a 16x16 chunk grid (256 chunks) of 256x256x256', () => {
    const w = flatWorld();
    expect(WORLD_SIZE_X).toBe(256);
    expect(WORLD_SIZE_Z).toBe(256);
    expect(w.inChunkRange(-8, -8)).toBe(true);
    expect(w.inChunkRange(7, 7)).toBe(true);
    expect(w.inChunkRange(8, 0)).toBe(false);
    expect(w.inChunkRange(0, -9)).toBe(false);
    // force-generate all 256 chunks
    for (let cx = -8; cx < 8; cx++) {
      for (let cz = -8; cz < 8; cz++) w.ensureChunk(cx, cz);
    }
    expect(w.generatedChunkCount).toBe(256);
  });

  it('world bounds are centered at 0', () => {
    const w = flatWorld();
    expect(WORLD_MIN_X).toBe(-128);
    expect(WORLD_MIN_Z).toBe(-128);
    expect(w.inWorld(-128, 0, -128)).toBe(true);
    expect(w.inWorld(127, 255, 127)).toBe(true);
    expect(w.inWorld(-129, 0, 0)).toBe(false);
    expect(w.inWorld(128, 0, 0)).toBe(false);
    expect(w.inWorld(0, -1, 0)).toBe(false);
    expect(w.inWorld(0, 256, 0)).toBe(false);
  });
});

describe('World get/set across chunk borders', () => {
  it('reads and writes blocks in adjacent chunks', () => {
    const w = flatWorld();
    // (7, 50, 7) is in chunk (0,0); (8, 50, 8) is in chunk (1,1)
    w.setBlock(7, 50, 7, Block.IronOre);
    w.setBlock(8, 50, 8, Block.CoalOre);
    expect(w.getBlock(7, 50, 7)).toBe(Block.IronOre);
    expect(w.getBlock(8, 50, 8)).toBe(Block.CoalOre);
    // untouched neighbor stays floor
    expect(w.getBlock(7, 50, 8)).toBe(AIR);
  });

  it('handles negative coordinates (world is centered)', () => {
    const w = flatWorld();
    w.setBlock(-1, 50, -1, Block.RedstoneBlock);
    expect(w.getBlock(-1, 50, -1)).toBe(Block.RedstoneBlock);
    // -16 is the first block of chunk (-1,-1)
    expect(w.getBlock(-16, 10, 0)).toBe(Block.Stone);
  });

  it('meta survives cross-chunk writes', () => {
    const w = flatWorld();
    w.setBlock(15, 50, 15, Block.RedstoneDust, 12);
    expect(w.getBlock(15, 50, 15)).toBe(Block.RedstoneDust);
    expect(w.getMeta(15, 50, 15)).toBe(12);
    expect(w.getMeta(16, 50, 15)).toBe(0);
  });

  it('returns AIR outside the world', () => {
    const w = flatWorld();
    expect(w.getBlock(-2049, 5, 0)).toBe(AIR);
    expect(w.getBlock(2048, 5, 0)).toBe(AIR);
    expect(w.getBlock(0, 300, 0)).toBe(AIR);
  });

  it('marks chunks dirty on set and drains them', () => {
    const w = flatWorld();
    w.drainDirty();
    w.setBlock(3, 50, 3, Block.Sand);
    const dirty = w.drainDirty();
    expect(dirty).toEqual([{ cx: 0, cz: 0 }]);
    expect(w.drainDirty()).toEqual([]);
  });
});

describe('deterministic generation', () => {
  it('same seed → same world', () => {
    const a = new World(42);
    const b = new World(42);
    const samples: [number, number, number][] = [
      [0, 64, 0],
      [100, 64, 100],
      [-500, 70, 300],
      [1023, 55, -1023],
      [2047, 60, 2047],
    ];
    for (const [x, y, z] of samples) {
      expect(a.getBlock(x, y, z)).toBe(b.getBlock(x, y, z));
    }
  });

  it('different seeds → different terrain (surface heights differ)', () => {
    const a = new World(1);
    const b = new World(2);
    const topY = (w: World, x: number, z: number): number => {
      for (let y = 255; y >= 0; y--) {
        const id = w.getBlock(x, y, z);
        if (id !== AIR && id !== Block.Water) return y;
      }
      return -1;
    };
    let diffs = 0;
    for (let i = 0; i < 50; i++) {
      const x = (i % 10) * 25 - 110;
      const z = Math.floor(i / 10) * 25 - 55;
      if (topY(a, x, z) !== topY(b, x, z)) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });

  it('default terrain (Phase 2A generator) has grass/dirt/stone/bedrock and water below sea level', () => {
    const w = new World(1337);
    // scan a few columns: expect bedrock at bottom, stone mid, solid top
    let foundBedrock = false;
    let foundGrass = false;
    let foundWater = false;
    for (let x = -100; x < 100; x += 19) {
      for (let z = -100; z < 100; z += 23) {
        if (w.getBlock(x, 0, z) === Block.Bedrock) foundBedrock = true;
        for (let y = 200; y >= 0; y--) {
          const id = w.getBlock(x, y, z);
          if (id !== AIR && id !== Block.Water) {
            if (id === Block.Grass) {
              foundGrass = true;
              // dirt below grass, stone 4 below
              expect(w.getBlock(x, y - 1, z)).toBe(Block.Dirt);
              if (y > 8) expect(w.getBlock(x, y - 4, z)).toBe(Block.Stone);
            } else if (id === Block.Sand) {
              // near-water columns are sand
              expect(w.getBlock(x, y - 1, z)).toBe(Block.Sand);
            }
            break;
          }
          if (id === Block.Water) foundWater = true;
        }
      }
    }
    expect(foundBedrock).toBe(true);
    expect(foundGrass).toBe(true);
    expect(foundWater).toBe(true);
  });
});

describe('spawn', () => {
  it('findSpawn returns the column top at world center', () => {
    const w = flatWorld(10);
    const s = w.findSpawn();
    expect(s.x).toBe(0.5);
    expect(s.z).toBe(0.5);
    expect(s.y).toBe(11);
  });
});
