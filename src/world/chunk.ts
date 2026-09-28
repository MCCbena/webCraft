/**
 * WebCraft — Chunk data (Phase 1, [core]).
 *
 * 16(X) x 256(Y) x 16(Z) blocks, two Uint8Arrays (id + meta).
 * index = (y*16 + z)*16 + x   (design.md §5)
 *
 * Pure TS — no DOM/three.js — fully unit-testable.
 */

import { AIR } from './blocks';

export const CHUNK_SIZE_X = 16;
export const CHUNK_SIZE_Y = 256;
export const CHUNK_SIZE_Z = 16;
export const CHUNK_VOLUME = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;

/** index = (y*16+z)*16+x */
export function chunkIndex(x: number, y: number, z: number): number {
  return (y * CHUNK_SIZE_Z + z) * CHUNK_SIZE_X + x;
}

export function inChunkBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < CHUNK_SIZE_X && y >= 0 && y < CHUNK_SIZE_Y && z >= 0 && z < CHUNK_SIZE_Z;
}

export class Chunk {
  readonly ids: Uint8Array;
  readonly metas: Uint8Array;
  /** vertical span of non-air content (for fast meshing); updated on setBlock */
  minY = CHUNK_SIZE_Y;
  maxY = -1;

  constructor() {
    this.ids = new Uint8Array(CHUNK_VOLUME);
    this.metas = new Uint8Array(CHUNK_VOLUME);
  }

  getBlock(x: number, y: number, z: number): number {
    if (!inChunkBounds(x, y, z)) return AIR;
    return this.ids[chunkIndex(x, y, z)];
  }

  getMeta(x: number, y: number, z: number): number {
    if (!inChunkBounds(x, y, z)) return 0;
    return this.metas[chunkIndex(x, y, z)];
  }

  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    if (!inChunkBounds(x, y, z)) return;
    const i = chunkIndex(x, y, z);
    const old = this.ids[i];
    this.ids[i] = id & 0xff;
    this.metas[i] = meta & 0xff;
    if (id !== AIR && old === AIR) {
      if (y < this.minY) this.minY = y;
      if (y > this.maxY) this.maxY = y;
    } else if (id === AIR && old !== AIR) {
      // Recompute span only when the extremes might have emptied.
      if (y === this.minY || y === this.maxY) this.recomputeSpan();
    }
  }

  private recomputeSpan(): void {
    let minY = CHUNK_SIZE_Y;
    let maxY = -1;
    const ids = this.ids;
    for (let y = 0; y < CHUNK_SIZE_Y; y++) {
      const row = y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
      let any = false;
      for (let i = 0; i < CHUNK_SIZE_X * CHUNK_SIZE_Z; i++) {
        if (ids[row + i] !== AIR) {
          any = true;
          break;
        }
      }
      if (any) {
        if (y < minY) minY = y;
        maxY = y;
      }
    }
    this.minY = minY;
    this.maxY = maxY;
  }

  /** true when the chunk contains no non-air block */
  isEmpty(): boolean {
    const ids = this.ids;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== AIR) return false;
    }
    return true;
  }
}
