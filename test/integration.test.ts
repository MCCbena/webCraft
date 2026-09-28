import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world';
import { Player } from '../src/player/player';
import { stepPlayer, emptyInput } from '../src/player/physics';
import { buildChunkMeshData } from '../src/world/mesher';
import { Block } from '../src/world/blocks';

/**
 * End-to-end Phase 1 pipeline in plain Node (no DOM/WebGL):
 * deterministic world gen → spawn scan → physics settle → mesh the
 * ±3-chunk render distance around the player.
 */

describe('Phase 1 pipeline (headless)', () => {
  it('world gen + spawn + 1000 physics ticks settles the player on the ground', () => {
    const w = new World(1337);
    const spawn = w.findSpawn();
    expect(spawn.y).toBeGreaterThan(0);
    const p = new Player(spawn.x, spawn.y, spawn.z);
    for (let i = 0; i < 1000; i++) {
      stepPlayer(p, emptyInput(), (x, y, z) => w.getBlock(x, y, z), 0.05);
    }
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    expect(p.onGround).toBe(true);
    expect(p.y).toBeLessThan(spawn.y + 0.1); // fell to (or at) the spawn surface
    // feet must not be inside a solid block
    const footBlock = w.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    expect(footBlock).not.toBe(Block.Stone);
  }, 30000);

  it('meshes the 49-chunk render distance around spawn with real geometry', () => {
    const w = new World(1337);
    const spawn = w.findSpawn();
    const pcx = Math.floor(spawn.x / 16);
    const pcz = Math.floor(spawn.z / 16);
    let verts = 0;
    let waterVerts = 0;
    let chunks = 0;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!w.inChunkRange(cx, cz)) continue;
        const c = w.ensureChunk(cx, cz);
        if (!c) continue;
        const data = buildChunkMeshData(c, cx, cz, (x, y, z) => w.getBlock(x, y, z));
        verts += data.opaque.vertexCount;
        waterVerts += data.water.vertexCount;
        chunks++;
      }
    }
    expect(chunks).toBe(49);
    expect(verts).toBeGreaterThan(10000); // a real terrain surface, not empty
  }, 30000);
});
