import { describe, it, expect } from 'vitest';
import { Chunk } from '../src/world/chunk';
import { Block, Tile, AIR, WATER, setOutput, setDelay, setFacing } from '../src/world/blocks';
import { buildChunkMeshData, shouldRenderFace, isPowered, createFaceData } from '../src/world/mesher';
import type { BlockAt, FaceData } from '../src/world/mesher';

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
    expect(tilesUsed(opaque).size).toBeGreaterThanOrEqual(3);
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

// ---------------------------------------------------------------------------
// Phase 3: lit tile selection for all powered redstone components
// ---------------------------------------------------------------------------

/**
 * Collect the distinct atlas tiles covered by a FaceData. Samples the UV
 * centroid of each triangle: centroids of tile faces are strictly inside the
 * tile, so boundary UVs (which would floor() into the neighboring atlas tile)
 * never misclassify.
 */
function tilesUsed(fd: FaceData): Set<number> {
  const tiles = new Set<number>();
  for (let t = 0; t < fd.indices.length; t += 3) {
    const i0 = fd.indices[t];
    const i1 = fd.indices[t + 1];
    const i2 = fd.indices[t + 2];
    const u = (fd.uvs[i0 * 2] + fd.uvs[i1 * 2] + fd.uvs[i2 * 2]) / 3;
    const v = (fd.uvs[i0 * 2 + 1] + fd.uvs[i1 * 2 + 1] + fd.uvs[i2 * 2 + 1]) / 3;
    const col = Math.min(15, Math.floor(u * 16));
    const row = Math.min(15, Math.floor((1 - v) * 16));
    tiles.add(row * 16 + col);
  }
  return tiles;
}

describe('isPowered: repeater & comparator output bits (Phase 3)', () => {
  it('repeater lights only from output strength (meta bits 4-7)', () => {
    expect(isPowered(Block.Repeater, 0)).toBe(false);
    // facing=3 + delay=4 (meta 7) but output=0 → unlit
    expect(isPowered(Block.Repeater, setDelay(setFacing(0, 3), 4))).toBe(false);
    expect(isPowered(Block.Repeater, 0x10)).toBe(true); // output 1
    expect(isPowered(Block.Repeater, 0xf0)).toBe(true); // output 15
    // facing/delay bits must not leak into the output field
    expect(isPowered(Block.Repeater, setDelay(setFacing(0, 3), 4) | 0x0f)).toBe(false);
  });

  it('comparator lights only from output strength (meta bits 3-6)', () => {
    expect(isPowered(Block.Comparator, 0)).toBe(false);
    expect(isPowered(Block.Comparator, 0x04)).toBe(false); // subtract mode only
    expect(isPowered(Block.Comparator, setOutput(0, 8))).toBe(true);
    expect(isPowered(Block.Comparator, setOutput(setFacing(0, 2) | 0x04, 15))).toBe(true);
  });

  it('lit torch / lamp / repeater / comparator mesh with their lit tiles', () => {
    const cases: Array<[number, number, number, number]> = [
      // [block id, meta, expected lit tile, expected unlit tile]
      [Block.RedstoneTorch, 1, Tile.RedstoneTorchOn, Tile.RedstoneTorchOff],
      [Block.RedstoneLamp, 1, Tile.RedstoneLampLit, Tile.RedstoneLampOff],
      [Block.Repeater, 0x10, Tile.RepeaterOn, Tile.Repeater],
      [Block.Comparator, setOutput(0, 12), Tile.ComparatorOn, Tile.Comparator],
    ];
    for (const [id, meta, lit, unlit] of cases) {
      const c = new Chunk();
      c.setBlock(8, 10, 8, id, meta);
      const { opaque } = buildChunkMeshData(c, 0, 0, airWorld);
      expect(opaque.vertexCount).toBeGreaterThan(0);
      const tiles = tilesUsed(opaque);
      expect(tiles.has(lit), `id=${id} meta=${meta}: lit tile ${lit} present`).toBe(true);
      expect(tiles.has(unlit), `id=${id} meta=${meta}: unlit tile ${unlit} absent`).toBe(false);
    }
  });

  it('unpowered repeater/comparator keep their unlit tiles', () => {
    const c = new Chunk();
    c.setBlock(6, 10, 8, Block.Repeater, setDelay(setFacing(0, 3), 2));
    c.setBlock(10, 10, 8, Block.Comparator, 0x04);
    const { opaque } = buildChunkMeshData(c, 0, 0, airWorld);
    const tiles = tilesUsed(opaque);
    expect(tiles.has(Tile.Repeater)).toBe(true);
    expect(tiles.has(Tile.RepeaterOn)).toBe(false);
    expect(tiles.has(Tile.Comparator)).toBe(true);
    expect(tiles.has(Tile.ComparatorOn)).toBe(false);
  });
});
