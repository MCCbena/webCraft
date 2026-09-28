/**
 * WebCraft — World (Phase 1, [core]).
 *
 * 16x16 chunk grid = 256 chunks, world 4096x4096 blocks, height 256.
 * World block coordinates are CENTERED: x,z in [-2048, 2047], y in [0, 255].
 * Chunk coords cx,cz in [-8, 7]; block x = cx*16 + localX.
 *
 * The terrain generator is INJECTABLE (Phase 2A replaces
 * generateSimpleTerrain with src/world/terrain.ts):
 *
 *     const world = new World(seed, myChunkGenerator);
 *
 * Pure TS — no DOM/three.js — fully unit-testable.
 */

import { AIR, WATER, Block } from './blocks';
import { Chunk } from './chunk';

export const WORLD_CHUNKS_X = 16;
export const WORLD_CHUNKS_Z = 16;
export const WORLD_SIZE_X = WORLD_CHUNKS_X * 16; // 4096
export const WORLD_SIZE_Z = WORLD_CHUNKS_Z * 16; // 4096
export const WORLD_MIN_X = -WORLD_SIZE_X / 2; // -2048
export const WORLD_MIN_Z = -WORLD_SIZE_Z / 2; // -2048
export const WORLD_MAX_Y = 256;

export const DEFAULT_SEED = 1337;

/** Generator signature: fill one chunk (local coords 0..15, world y 0..255). */
export type ChunkGenerator = (world: World, chunk: Chunk, cx: number, cz: number) => void;

export interface DirtyChunk {
  cx: number;
  cz: number;
}

export class World {
  readonly seed: number;
  private readonly chunks: (Chunk | null)[] = new Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z).fill(null);
  /** chunks whose mesh needs rebuilding (drained by the renderer) */
  private readonly dirty = new Set<number>();
  /** injectable terrain generator (Phase 2A extension point) */
  generator: ChunkGenerator;

  constructor(seed: number = DEFAULT_SEED, generator: ChunkGenerator = generateSimpleTerrain) {
    this.seed = seed;
    this.generator = generator;
  }

  private static chunkSlot(cx: number, cz: number): number {
    return (cx + 8) * WORLD_CHUNKS_Z + (cz + 8);
  }

  inWorld(x: number, y: number, z: number): boolean {
    return x >= WORLD_MIN_X && x < WORLD_MIN_X + WORLD_SIZE_X && y >= 0 && y < WORLD_MAX_Y && z >= WORLD_MIN_Z && z < WORLD_MIN_Z + WORLD_SIZE_Z;
  }

  inChunkRange(cx: number, cz: number): boolean {
    return cx >= -8 && cx < 8 && cz >= -8 && cz < 8;
  }

  getChunk(cx: number, cz: number): Chunk | null {
    if (!this.inChunkRange(cx, cz)) return null;
    return this.chunks[World.chunkSlot(cx, cz)] ?? null;
  }

  /** Get (lazily generating) the chunk. Returns null outside the world. */
  ensureChunk(cx: number, cz: number): Chunk | null {
    if (!this.inChunkRange(cx, cz)) return null;
    const slot = World.chunkSlot(cx, cz);
    let c = this.chunks[slot];
    if (!c) {
      c = new Chunk();
      this.chunks[slot] = c;
      this.generator(this, c, cx, cz);
    }
    return c;
  }

  getBlock(x: number, y: number, z: number): number {
    if (!this.inWorld(x, y, z)) return AIR;
    const c = this.ensureChunk(Math.floor(x / 16), Math.floor(z / 16));
    if (!c) return AIR;
    return c.getBlock(x - Math.floor(x / 16) * 16, y, z - Math.floor(z / 16) * 16);
  }

  getMeta(x: number, y: number, z: number): number {
    if (!this.inWorld(x, y, z)) return 0;
    const c = this.ensureChunk(Math.floor(x / 16), Math.floor(z / 16));
    if (!c) return 0;
    return c.getMeta(x - Math.floor(x / 16) * 16, y, z - Math.floor(z / 16) * 16);
  }

  /** Set a block, crossing chunk borders transparently. Marks the chunk dirty. */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    if (!this.inWorld(x, y, z)) return;
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const c = this.ensureChunk(cx, cz);
    if (!c) return;
    c.setBlock(x - cx * 16, y, z - cz * 16, id, meta);
    this.markDirty(cx, cz);
  }

  /** Mark a chunk (and optionally its neighbors, for border edits) for remesh. */
  markDirty(cx: number, cz: number, includeNeighbors = false): void {
    if (this.inChunkRange(cx, cz)) this.dirty.add(World.chunkSlot(cx, cz));
    if (includeNeighbors) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          this.markDirty(cx + dx, cz + dz);
        }
      }
    }
  }

  /** Drain and return all dirty chunks (renderer calls this every frame). */
  drainDirty(): DirtyChunk[] {
    const out: DirtyChunk[] = [];
    for (const slot of this.dirty) {
      out.push({ cx: Math.floor(slot / WORLD_CHUNKS_Z) - 8, cz: (slot % WORLD_CHUNKS_Z) - 8 });
      this.dirty.delete(slot);
    }
    return out;
  }

  /** Number of chunks currently generated. */
  get generatedChunkCount(): number {
    let n = 0;
    for (const c of this.chunks) if (c) n++;
    return n;
  }

  /**
   * Find the spawn point at world center (0, topY+1, 0) by scanning down
   * from the top. Falls back to y=255 when the column is empty.
   */
  findSpawn(): { x: number; y: number; z: number } {
    for (let y = WORLD_MAX_Y - 1; y >= 0; y--) {
      const id = this.getBlock(0, y, 0);
      if (id !== AIR && id !== WATER) {
        return { x: 0.5, y: y + 1, z: 0.5 };
      }
    }
    return { x: 0.5, y: WORLD_MAX_Y - 1, z: 0.5 };
  }
}

// ---------------------------------------------------------------------------
// Placeholder terrain generator (Phase 1).
// Phase 2A (src/world/terrain.ts) will replace this with the full
// biome/ore/tree/water implementation — keep the ChunkGenerator contract.
// ---------------------------------------------------------------------------

/** mulberry32 seeded PRNG (deterministic). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** integer 2D lattice hash → [0,1), deterministic in (x, z, seed) */
function hash2(x: number, z: number, seed: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise in [0,1) */
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = smooth(x - xi);
  const zf = smooth(z - zi);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * xf + (c - a) * zf + (a - b - c + d) * xf * zf;
}

/** 3-octave fractal value noise in [0,1) */
export function fbmNoise(x: number, z: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1 / 128;
  for (let o = 0; o < 3; o++) {
    sum += valueNoise(x * freq, z * freq, seed + o * 1013) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum; // ~[0,1)
}

export const SEA_LEVEL = 60;
export const BASE_HEIGHT = 64;

/** Height at world (x, z) for the placeholder generator. */
export function placeholderHeight(x: number, z: number, seed: number): number {
  const n = fbmNoise(x, z, seed);
  // base 64, amplitude ±24 → roughly 40..88
  return Math.max(1, Math.min(255, Math.round(BASE_HEIGHT + (n - 0.5) * 2 * 24)));
}

/** Sparse oak tree: trunk 4-6, leaf canopy. Deterministic from (x, z, seed). */
function plantTree(chunk: Chunk, lx: number, topY: number, lz: number, seed: number): void {
  const trunkH = 4 + Math.floor(hash2(lx, lz, seed + 7777) * 3); // 4..6
  const top = topY + trunkH;
  // trunk
  for (let y = topY + 1; y <= top; y++) {
    chunk.setBlock(lx, y, lz, Block.Log);
  }
  // canopy: two 5x5 layers (skip some corners), then a 3x3 cap
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0 && dy === 0) continue; // trunk top
        const corner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
        if (corner && hash2(lx + dx, lz + dz, seed + 991) < 0.5) continue;
        const wx = lx + dx;
        const wz = lz + dz;
        if (wx < 0 || wx > 15 || wz < 0 || wz > 15) continue;
        const y = top + dy;
        if (y < 0 || y > 255) continue;
        if (chunk.getBlock(wx, y, wz) === AIR) chunk.setBlock(wx, y, wz, Block.Leaves);
      }
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const wx = lx + dx;
      const wz = lz + dz;
      if (wx < 0 || wx > 15 || wz < 0 || wz > 15) continue;
      const y = top + 1;
      if (y > 255) continue;
      if (chunk.getBlock(wx, y, wz) === AIR) chunk.setBlock(wx, y, wz, Block.Leaves);
    }
  }
}

/**
 * SIMPLE placeholder terrain (Phase 1):
 *  - value-noise heightmap, base y≈64
 *  - grass on top, 3 dirt below, stone below that
 *  - bedrock y<4, sand near/below sea level, water fills to y=60
 *  - sparse oak trees (trunk 4-6)
 * Deterministic for a given seed.
 */
export function generateSimpleTerrain(world: World, chunk: Chunk, cx: number, cz: number): void {
  const seed = world.seed;
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const h = placeholderHeight(wx, wz, seed);
      const nearWater = h <= SEA_LEVEL + 1;
      const topBlock = nearWater ? Block.Sand : Block.Grass;
      const midBlock = nearWater ? Block.Sand : Block.Dirt;
      for (let y = 0; y <= h; y++) {
        let id: number;
        if (y < 4) id = Block.Bedrock;
        else if (y < h - 3) id = Block.Stone;
        else if (y < h) id = midBlock;
        else id = topBlock;
        chunk.setBlock(lx, y, lz, id);
      }
      // water from h+1 up to sea level
      for (let y = h + 1; y <= SEA_LEVEL; y++) {
        chunk.setBlock(lx, y, lz, WATER);
      }
      // sparse trees on grass, fully inside the chunk (Phase 2A handles borders)
      if (!nearWater && h < 240 && lx >= 2 && lx <= 13 && lz >= 2 && lz <= 13) {
        if (hash2(wx, wz, seed + 4242) < 0.006) {
          plantTree(chunk, lx, h, lz, seed);
        }
      }
    }
  }
}
