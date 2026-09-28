import { describe, it, expect } from 'vitest';
import { Chunk } from '../src/world/chunk';
import { Block, AIR, WATER } from '../src/world/blocks';
import { buildChunkMeshData, shouldRenderFace, isPowered, createFaceData } from '../src/world/mesher';
import type { BlockAt } from '../src/world/mesher';

/** blockAt that returns AIR everywhere. */
const airWorld: BlockAt = () => AIR;

/** blockAt backed by a single chunk at chunk coords (cx, cz). */
function chunkWorld(chunk: Chunk, cx = 0, cz = 0): BlockAt {
  return (wx: number, wy: number, wz: number): number => {
    const lx = wx - cx * 16;
    const lz = wz - cz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return AIR;
    return chunk.getBlock(lx, wy, lz);
  };
}

describe('face culling rule', () => {
  it('renders against air', () => {
    expect(shouldRenderFace(Block.Stone, AIR)).toBe(true);
  });
  it('culls against opaque neighbors', () => {
    expect(shouldRenderFace(Block.Stone, Block.Dirt)).toBe(false);
  });
  it('culls water against water, renders against air/glass', () => {
    expect(shouldRenderFace(WATER, WATER)).toBe(false);
    expect(shouldRenderFace(WATER, AIR)).toBe(true);
    expect(shouldRenderFace(WATER, Block.Glass)).toBe(true);
  });
  it('renders transparent blocks against each other (glass next to leaves)', () => {
    expect(shouldRenderFace(Block.Glass, Block.Leaves)).toBe(true);
  });
});

describe('mesher output', () => {
  it('produces >0 vertices for a single exposed block', () => {
    const c = new Chunk();
    c.setBlock(8, 10, 8, Block.Stone);
    const { opaque, water } = buildChunkMeshData(c, 0, 0, airWorld);
    expect(opaque.vertexCount).toBe(24); // 6 faces x 4 vertices
    expect(opaque.indices.length).toBe(36); // 6 faces x 6 indices
    expect(water.vertexCount).toBe(0);
    // attribute arrays are consistent
    expect(opaque.positions.length).toBe(opaque.vertexCount * 3);
    expect(opaque.normals.length).toBe(opaque.vertexCount * 3);
    expect(opaque.uvs.length).toBe(opaque.vertexCount * 2);
    expect(opaque.colors.length).toBe(opaque.vertexCount * 3);
  });

  it('culled faces: fully enclosed block produces no geometry', () => {
    const c = new Chunk();
    // 3x3x3 stone cube; center block is fully enclosed
    for (let x = 7; x <= 9; x++) {
      for (let y = 9; y <= 11; y++) {
        for (let z = 7; z <= 9; z++) {
          c.setBlock(x, y, z, Block.Stone);
        }
      }
    }
    const { opaque } = buildChunkMeshData(c, 0, 0, chunkWorld(c));
    // only the 26 surface blocks contribute; each surface block has only
    // its outward faces → total vertices must be far below a full 27 cubes
    const fullCubeVerts = 27 * 24;
    expect(opaque.vertexCount).toBeGreaterThan(0);
    expect(opaque.vertexCount).toBeLessThan(fullCubeVerts);
    // a solid 3x3x3 cube has 6 x (3x3) = 54 exposed faces
    expect(opaque.vertexCount).toBe(54 * 4);
  });

  it('two adjacent blocks share a culled internal face', () => {
    const c = new Chunk();
    c.setBlock(8, 10, 8, Block.Stone);
    c.setBlock(9, 10, 8, Block.Stone);
    const { opaque } = buildChunkMeshData(c, 0, 0, chunkWorld(c));
    // 2 cubes = 12 faces, minus 2 internal (the shared side) = 10 faces
    expect(opaque.vertexCount).toBe(10 * 4);
  });

  it('water goes to the separate buffer', () => {
    const c = new Chunk();
    c.setBlock(8, 10, 8, WATER);
    const { opaque, water } = buildChunkMeshData(c, 0, 0, airWorld);
    expect(opaque.vertexCount).toBe(0);
    expect(water.vertexCount).toBe(24);
  });

  it('grass uses top/side/bottom variants (distinct atlas tiles)', () => {
    const c = new Chunk();
    c.setBlock(8, 10, 8, Block.Grass);
    const { opaque } = buildChunkMeshData(c, 0, 0, airWorld);
    // uvs must cover at least 3 distinct tiles (grass top/side + dirt bottom)
    const tiles = new Set<number>();
    for (let i = 0; i < opaque.uvs.length; i += 2) {
      const col = Math.floor(opaque.uvs[i] * 16);
      const row = Math.floor((1 - opaque.uvs[i + 1]) * 16);
      tiles.add(row * 16 + col);
    }
    expect(tiles.size).toBeGreaterThanOrEqual(3);
  });

  it('respects the chunk minY/maxY span (empty span → no geometry)', () => {
    const c = new Chunk();
    const data = buildChunkMeshData(c, 0, 0, airWorld);
    expect(data.opaque.vertexCount).toBe(0);
    expect(data.water.vertexCount).toBe(0);
  });

  it('neighbor lookups cross chunk borders (block at local 0 with neighbor in previous chunk)', () => {
    const c = new Chunk();
    c.setBlock(0, 10, 0, Block.Stone);
    // neighbor at world (-1, 10, 0) is opaque → -X face culled
    const withNeighbor: BlockAt = (x) => (x === -1 ? Block.Dirt : AIR);
    const withNeighborData = buildChunkMeshData(c, 0, 0, withNeighbor);
    expect(withNeighborData.opaque.vertexCount).toBe(20); // 5 faces
    // without neighbor → 6 faces
    const noNeighborData = buildChunkMeshData(c, 0, 0, airWorld);
    expect(noNeighborData.opaque.vertexCount).toBe(24);
  });

  it('small redstone components mesh with their shape box', () => {
    const c = new Chunk();
    c.setBlock(8, 10, 8, Block.RedstoneDust);
    const { opaque } = buildChunkMeshData(c, 0, 0, airWorld);
    expect(opaque.vertexCount).toBe(24);
    // dust is thin: all y coords within a small range of the block bottom
    const ys = opaque.positions.filter((_, i) => i % 3 === 1);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    expect(maxY - minY).toBeLessThan(0.5);
  });

  it('isPowered drives lit tile selection for lamp', () => {
    expect(isPowered(Block.RedstoneLamp, 0)).toBe(false);
    expect(isPowered(Block.RedstoneLamp, 1)).toBe(true);
    expect(isPowered(Block.RedstoneDust, 0)).toBe(false);
    expect(isPowered(Block.RedstoneDust, 5)).toBe(true);
  });
});
