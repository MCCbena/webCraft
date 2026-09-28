/**
 * WebCraft — World (Phase 1, [core]).
 *
 * 16x16 chunk grid = 256 chunks, world 256x256 blocks, height 256
 * (approved spec — docs/design.md §1/§5).
 * World block coordinates are CENTERED: x,z in [-128, 127], y in [0, 255].
 * Chunk coords cx,cz in [-8, 7]; block x = cx*16 + localX.
 *
 * The terrain generator is INJECTABLE; the default is the Phase 2A terrain
 * generator (src/world/terrain.ts):
 *
 *     const world = new World(seed);                  // terrain generator
 *     const world = new World(seed, myChunkGenerator); // custom generator
 *
 * Pure TS — no DOM/three.js — fully unit-testable.
 */

import { AIR, WATER } from './blocks';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Z } from './chunk';
import { createTerrainGenerator } from './terrain';

export const WORLD_CHUNKS_X = 16;
export const WORLD_CHUNKS_Z = 16;
export const WORLD_SIZE_X = WORLD_CHUNKS_X * CHUNK_SIZE_X; // 256
export const WORLD_SIZE_Z = WORLD_CHUNKS_Z * CHUNK_SIZE_Z; // 256
export const WORLD_MIN_X = -WORLD_SIZE_X / 2; // -128
export const WORLD_MIN_Z = -WORLD_SIZE_Z / 2; // -128
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

  constructor(seed: number = DEFAULT_SEED, generator: ChunkGenerator = createTerrainGenerator(seed)) {
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
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const c = this.ensureChunk(cx, cz);
    if (!c) return AIR;
    return c.getBlock(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z);
  }

  getMeta(x: number, y: number, z: number): number {
    if (!this.inWorld(x, y, z)) return 0;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const c = this.ensureChunk(cx, cz);
    if (!c) return 0;
    return c.getMeta(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z);
  }

  /** Set a block, crossing chunk borders transparently. Marks the chunk dirty. */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    if (!this.inWorld(x, y, z)) return;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const c = this.ensureChunk(cx, cz);
    if (!c) return;
    c.setBlock(x - cx * CHUNK_SIZE_X, y, z - cz * CHUNK_SIZE_Z, id, meta);
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

  /**
   * Mark the chunk containing (x, y, z) for remesh — plus its neighbors when
   * the edit is on a chunk border (cross-border faces). Shared by game.ts
   * setBlock and redstone tick writes (Phase 4 DRY: previously two copies of
   * the lx/lz === 0/15 logic).
   */
  markDirtyAround(x: number, y: number, z: number): void {
    if (!this.inWorld(x, y, z)) return;
    const cx = Math.floor(x / CHUNK_SIZE_X);
    const cz = Math.floor(z / CHUNK_SIZE_Z);
    const lx = x - cx * CHUNK_SIZE_X;
    const lz = z - cz * CHUNK_SIZE_Z;
    const onBorder = lx === 0 || lx === CHUNK_SIZE_X - 1 || lz === 0 || lz === CHUNK_SIZE_Z - 1;
    this.markDirty(cx, cz, onBorder);
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
// The Phase 1 placeholder generator (value-noise flat-ish terrain) was
// removed in Phase 4: the game always injects createTerrainGenerator
// (src/world/terrain.ts), which is also the constructor default now.
