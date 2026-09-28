import { describe, it, expect } from 'vitest';
import { Chunk, chunkIndex, CHUNK_VOLUME, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '../src/world/chunk';
import { AIR, Block } from '../src/world/blocks';

describe('chunk index math', () => {
  it('uses (y*16+z)*16+x', () => {
    expect(chunkIndex(0, 0, 0)).toBe(0);
    expect(chunkIndex(1, 0, 0)).toBe(1);
    expect(chunkIndex(0, 0, 1)).toBe(16);
    expect(chunkIndex(0, 1, 0)).toBe(256);
    expect(chunkIndex(15, 255, 15)).toBe(16 * 256 * 16 - 1);
  });

  it('matches the design.md formula for random samples', () => {
    for (let i = 0; i < 100; i++) {
      const x = (i * 7) % 16;
      const y = (i * 37) % 256;
      const z = (i * 13) % 16;
      expect(chunkIndex(x, y, z)).toBe((y * 16 + z) * 16 + x);
    }
  });

  it('volume is 16*256*16', () => {
    expect(CHUNK_VOLUME).toBe(16 * 256 * 16);
    expect(CHUNK_SIZE_X).toBe(16);
    expect(CHUNK_SIZE_Y).toBe(256);
    expect(CHUNK_SIZE_Z).toBe(16);
  });
});

describe('Chunk get/set with bounds', () => {
  it('stores and reads blocks inside bounds', () => {
    const c = new Chunk();
    c.setBlock(3, 64, 5, Block.Stone);
    expect(c.getBlock(3, 64, 5)).toBe(Block.Stone);
    c.setBlock(3, 64, 5, Block.Stone, 7);
    expect(c.getMeta(3, 64, 5)).toBe(7);
  });

  it('returns AIR for out-of-bounds reads', () => {
    const c = new Chunk();
    c.setBlock(0, 0, 0, Block.Stone);
    expect(c.getBlock(-1, 0, 0)).toBe(AIR);
    expect(c.getBlock(16, 0, 0)).toBe(AIR);
    expect(c.getBlock(0, -1, 0)).toBe(AIR);
    expect(c.getBlock(0, 256, 0)).toBe(AIR);
    expect(c.getBlock(0, 0, 16)).toBe(AIR);
  });

  it('ignores out-of-bounds writes', () => {
    const c = new Chunk();
    c.setBlock(-1, 0, 0, Block.Stone);
    c.setBlock(16, 0, 0, Block.Stone);
    c.setBlock(0, 256, 0, Block.Stone);
    expect(c.getBlock(0, 0, 0)).toBe(AIR);
  });

  it('isEmpty tracks content', () => {
    const c = new Chunk();
    expect(c.isEmpty()).toBe(true);
    c.setBlock(8, 10, 8, Block.Dirt);
    expect(c.isEmpty()).toBe(false);
    c.setBlock(8, 10, 8, AIR);
    expect(c.isEmpty()).toBe(true);
  });

  it('tracks minY/maxY span', () => {
    const c = new Chunk();
    c.setBlock(0, 5, 0, Block.Stone);
    c.setBlock(0, 90, 0, Block.Stone);
    expect(c.minY).toBe(5);
    expect(c.maxY).toBe(90);
  });
});
