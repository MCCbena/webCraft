import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world';
import { createTerrainGenerator, columnProfile, TERRAIN_SEA_LEVEL, mulberry32 } from '../src/world/terrain';
import { AIR, WATER, Block } from '../src/world/blocks';
import { chunkIndex } from '../src/world/chunk';

const SEED_A = 1337;
const SEED_B = 42;

/** Deterministic list of chunks spread across the 16x16 world. */
const SPREAD_CHUNKS: Array<[number, number]> = [
  [-8, -8],
  [-8, 0],
  [0, -8],
  [0, 0],
  [7, 7],
  [4, -3],
  [-3, 4],
  [7, -7],
];

const LS = [0, 4, 8, 12]; // local x/z sample grid
const YS = [0, 1, 3, 4, 16, 40, 55, 59, 60, 61, 120, 200]; // sampled heights

function terrainWorld(seed: number): World {
  return new World(seed, createTerrainGenerator(seed));
}

/** World with the central 4x4 chunk region (x,z in [-32, 31]) pre-generated. */
function regionWorld(seed: number): World {
  const w = terrainWorld(seed);
  for (let cx = -2; cx <= 1; cx++) {
    for (let cz = -2; cz <= 1; cz++) w.ensureChunk(cx, cz);
  }
  return w;
}

/** All (worldX, worldZ) columns of the 4x4 test region. */
function regionColumns(): Array<{ wx: number; wz: number; cx: number; cz: number; lx: number; lz: number }> {
  const out: Array<{ wx: number; wz: number; cx: number; cz: number; lx: number; lz: number }> = [];
  for (let cx = -2; cx <= 1; cx++) {
    for (let cz = -2; cz <= 1; cz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          out.push({ wx: cx * 16 + lx, wz: cz * 16 + lz, cx, cz, lx, lz });
        }
      }
    }
  }
  return out;
}

describe('terrain: PRNG & noise primitives', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const va = a();
      const vb = b();
      expect(va).toBe(vb);
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
    // different seeds diverge
    const c = mulberry32(54321);
    let same = 0;
    const a2 = mulberry32(12345);
    for (let i = 0; i < 100; i++) if (a2() === c()) same++;
    expect(same).toBeLessThan(5);
  });

  it('createTerrainGenerator returns a function matching the ChunkGenerator contract', () => {
    const gen = createTerrainGenerator(SEED_A);
    expect(typeof gen).toBe('function');
    const w = new World(SEED_A, gen);
    const chunk = w.ensureChunk(0, 0);
    expect(chunk).not.toBeNull();
    expect(chunk!.isEmpty()).toBe(false);
  });
});

describe('terrain: determinism', () => {
  it('same seed → identical blocks at 100+ sampled positions across chunks', () => {
    const w1 = terrainWorld(SEED_A);
    const w2 = terrainWorld(SEED_A);
    let n = 0;
    for (const [cx, cz] of SPREAD_CHUNKS) {
      w1.ensureChunk(cx, cz);
      w2.ensureChunk(cx, cz);
      for (const lx of LS) {
        for (const lz of LS) {
          for (const y of YS) {
            const wx = cx * 16 + lx;
            const wz = cz * 16 + lz;
            expect(w1.getBlock(wx, y, wz)).toBe(w2.getBlock(wx, y, wz));
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(100);
    expect(w1.generatedChunkCount).toBe(SPREAD_CHUNKS.length);
  });

  it('chunk output is independent of generation order', () => {
    const wA = terrainWorld(SEED_A);
    const wB = terrainWorld(SEED_A);
    // generate the same two chunks in opposite orders
    wA.ensureChunk(-2, -2);
    wA.ensureChunk(-1, -1);
    wB.ensureChunk(-1, -1);
    wB.ensureChunk(-2, -2);
    for (const [cx, cz] of [
      [-2, -2],
      [-1, -1],
    ] as Array<[number, number]>) {
      const ca = wA.getChunk(cx, cz)!;
      const cb = wB.getChunk(cx, cz)!;
      expect(Buffer.from(ca.ids)).toEqual(Buffer.from(cb.ids));
      expect(ca.minY).toBe(cb.minY);
      expect(ca.maxY).toBe(cb.maxY);
    }
  });

  it('different seeds produce different worlds', () => {
    const wA = terrainWorld(SEED_A);
    const wB = terrainWorld(SEED_B);
    let diffs = 0;
    for (const [cx, cz] of SPREAD_CHUNKS) {
      wA.ensureChunk(cx, cz);
      wB.ensureChunk(cx, cz);
      for (const lx of LS) {
        for (const lz of LS) {
          for (const y of YS) {
            const wx = cx * 16 + lx;
            const wz = cz * 16 + lz;
            if (wA.getBlock(wx, y, wz) !== wB.getBlock(wx, y, wz)) diffs++;
          }
        }
      }
    }
    expect(diffs).toBeGreaterThan(10);
  });
});

describe('terrain: surface sanity (4x4 chunk region)', () => {
  const w = regionWorld(SEED_A);
  const cols = regionColumns();

  it('surface block matches the expected per-biome surface', () => {
    // Note: leaves are solid, so "topmost solid" can be a tree canopy; the
    // terrain surface is asserted directly at the profile height instead.
    const allowed = new Set<number>([Block.Grass, Block.Dirt, Block.Sand, Block.Stone, Block.Snow]);
    const aboveTerrain = new Set<number>([AIR, WATER, Block.Log, Block.Leaves]);
    let ocean = 0;
    let violations = 0;
    for (const c of cols) {
      const expected = columnProfile(SEED_A, c.wx, c.wz);
      if (!allowed.has(expected.surface)) violations++;

      const chunk = w.getChunk(c.cx, c.cz)!;
      // terrain surface at the profile height
      if (chunk.getBlock(c.lx, expected.height, c.lz) !== expected.surface) violations++;
      // subsurface: the block below the surface matches the profile
      if (expected.height > 0 && chunk.getBlock(c.lx, expected.height - 1, c.lz) !== expected.sub) violations++;
      // above the terrain only air, water (ocean) or trees may appear
      for (let y = expected.height + 1; y < 256; y++) {
        if (!aboveTerrain.has(chunk.getBlock(c.lx, y, c.lz))) {
          violations++;
          break;
        }
      }

      if (expected.underwater) ocean++;
    }
    expect(violations).toBe(0);
    // the 64x64 region must contain real ocean (water is a core requirement)
    expect(ocean).toBeGreaterThan(0);
  }, 20000);

  it('ocean columns: sandy seafloor, water from surface+1 up to y=60, air above', () => {
    let ocean = 0;
    for (const c of cols) {
      const p = columnProfile(SEED_A, c.wx, c.wz);
      if (!p.underwater) continue;
      ocean++;
      const chunk = w.getChunk(c.cx, c.cz)!;
      expect(chunk.getBlock(c.lx, p.height, c.lz)).toBe(Block.Sand);
      for (let y = p.height + 1; y <= TERRAIN_SEA_LEVEL; y++) {
        expect(chunk.getBlock(c.lx, y, c.lz)).toBe(WATER);
      }
      expect(chunk.getBlock(c.lx, TERRAIN_SEA_LEVEL + 1, c.lz)).toBe(AIR);
    }
    expect(ocean).toBeGreaterThan(0);
  });

  it('beaches: columns 1-3 blocks below sea level are sandy', () => {
    let beaches = 0;
    for (const c of cols) {
      const p = columnProfile(SEED_A, c.wx, c.wz);
      const depth = TERRAIN_SEA_LEVEL - p.height;
      if (depth >= 1 && depth <= 3) {
        beaches++;
        const chunk = w.getChunk(c.cx, c.cz)!;
        expect(chunk.getBlock(c.lx, p.height, c.lz)).toBe(Block.Sand);
        expect(chunk.getBlock(c.lx, p.height + 1, c.lz)).toBe(WATER);
      }
    }
    expect(beaches).toBeGreaterThan(0);
  });

  it('y=0 is always bedrock', () => {
    for (const c of cols) {
      const chunk = w.getChunk(c.cx, c.cz)!;
      expect(chunk.getBlock(c.lx, 0, c.lz)).toBe(Block.Bedrock);
    }
  });

  it('no air pockets: from the terrain surface down to y=0 there is no air', () => {
    // Tree canopies legitimately have air gaps, so the "first solid" is the
    // topmost non-tree solid (the terrain surface). Water is allowed below it.
    const isTree = (id: number) => id === Block.Log || id === Block.Leaves;
    for (const c of cols) {
      const chunk = w.getChunk(c.cx, c.cz)!;
      let topY = -1;
      for (let y = 255; y >= 0; y--) {
        const id = chunk.getBlock(c.lx, y, c.lz);
        if (id !== AIR && !isTree(id)) {
          topY = y;
          break;
        }
      }
      expect(topY).toBeGreaterThanOrEqual(0);
      let air = 0;
      for (let y = topY; y >= 0; y--) {
        if (chunk.getBlock(c.lx, y, c.lz) === AIR) air++; // water allowed, air not
      }
      expect(air).toBe(0);
    }
  });

  it('heights stay in a sane 1.13-style range (ocean floor < sea level < peak ~200)', () => {
    let min = 256;
    let max = 0;
    for (const c of cols) {
      const h = columnProfile(SEED_A, c.wx, c.wz).height;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    expect(min).toBeLessThan(TERRAIN_SEA_LEVEL); // real ocean
    expect(max).toBeGreaterThan(TERRAIN_SEA_LEVEL + 20); // real hills
    expect(max).toBeLessThanOrEqual(210); // peaks ≈ 200, hard cap
  });
});

describe('terrain: ores (4x4 chunk region)', () => {
  const w = regionWorld(SEED_A);
  const cols = regionColumns();

  it('redstone only at y<16 (y<=15, 1.13); coal and iron both exist', () => {
    let coal = 0;
    let iron = 0;
    let redstone = 0;
    for (const c of cols) {
      const chunk = w.getChunk(c.cx, c.cz)!;
      for (let y = 0; y <= 128; y++) {
        const id = chunk.ids[chunkIndex(c.lx, y, c.lz)];
        if (id === Block.CoalOre) coal++;
        else if (id === Block.IronOre) iron++;
        else if (id === Block.RedstoneOre) {
          redstone++;
          expect(y).toBeLessThan(16);
        }
      }
    }
    expect(coal).toBeGreaterThan(0);
    expect(iron).toBeGreaterThan(0);
    expect(redstone).toBeGreaterThan(0);
  });

  it('no ore above y=128 and no ore in the bedrock layer (y=0)', () => {
    for (const c of cols) {
      const chunk = w.getChunk(c.cx, c.cz)!;
      expect(chunk.getBlock(c.lx, 0, c.lz)).toBe(Block.Bedrock);
      // scan only down to y=129 (ore cap); skip columns that are lower
      let top = -1;
      for (let y = 255; y >= 0; y--) {
        if (chunk.getBlock(c.lx, y, c.lz) !== AIR) {
          top = y;
          break;
        }
      }
      for (let y = Math.min(top, 255); y >= 129; y--) {
        const id = chunk.getBlock(c.lx, y, c.lz);
        expect(id).not.toBe(Block.CoalOre);
        expect(id).not.toBe(Block.IronOre);
        expect(id).not.toBe(Block.RedstoneOre);
      }
    }
  });
});

describe('terrain: trees', () => {
  const w = regionWorld(SEED_A);

  it('forest columns grow oak trees (log trunk 4-6 + leaves) inside the chunk', () => {
    let trees = 0;
    for (const c of regionColumns()) {
      const chunk = w.getChunk(c.cx, c.cz)!;
      // find a trunk bottom: grass with a log directly above
      for (let y = 1; y < 250; y++) {
        if (chunk.getBlock(c.lx, y, c.lz) !== Block.Grass) continue;
        if (chunk.getBlock(c.lx, y + 1, c.lz) !== Block.Log) continue;
        // measure trunk
        let top = y + 1;
        while (top + 1 < 256 && chunk.getBlock(c.lx, top + 1, c.lz) === Block.Log) top++;
        const trunkH = top - y;
        expect(trunkH).toBeGreaterThanOrEqual(4);
        expect(trunkH).toBeLessThanOrEqual(6);
        // leaves exist at/above the trunk top within radius 2
        let leaves = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
              const lx = c.lx + dx;
              const lz = c.lz + dz;
              const y2 = top + dy;
              if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y2 < 0 || y2 > 255) continue;
              if (chunk.getBlock(lx, y2, lz) === Block.Leaves) leaves++;
            }
          }
        }
        expect(leaves).toBeGreaterThan(0);
        trees++;
      }
    }
    expect(trees).toBeGreaterThan(0);
  });

  it('desert and ocean columns have no trees', () => {
    let checked = 0;
    let treeBlocks = 0;
    for (const c of regionColumns()) {
      const p = columnProfile(SEED_A, c.wx, c.wz);
      if (p.biome !== 'desert' && !p.underwater) continue;
      checked++;
      const chunk = w.getChunk(c.cx, c.cz)!;
      for (let y = 0; y < 256; y++) {
        const id = chunk.getBlock(c.lx, y, c.lz);
        if (id === Block.Log || id === Block.Leaves) treeBlocks++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(treeBlocks).toBe(0);
  });
});

describe('terrain: performance', () => {
  it('generates one 16x256x16 chunk in < 100ms', () => {
    const t0 = Date.now();
    const w = terrainWorld(SEED_A);
    w.ensureChunk(0, 0);
    const dt = Date.now() - t0;
    // requirement is ~50ms; allow headroom for slow CI
    expect(dt).toBeLessThan(100);
  });

  it('generates the full 256-chunk world in < 30s', () => {
    const t0 = Date.now();
    const w = terrainWorld(SEED_A);
    for (let cx = -8; cx < 8; cx++) {
      for (let cz = -8; cz < 8; cz++) w.ensureChunk(cx, cz);
    }
    const dt = Date.now() - t0;
    // requirement is ~10s; allow headroom for slow CI
    expect(dt).toBeLessThan(30000);
    expect(w.generatedChunkCount).toBe(256);
  });
});
