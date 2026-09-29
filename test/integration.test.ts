import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world';
import { Player } from '../src/player/player';
import { stepPlayer, emptyInput } from '../src/player/physics';
import { buildChunkMeshData } from '../src/world/mesher';
import { Block } from '../src/world/blocks';
import { FallTracker, Vitals, fallDamage } from '../src/player/damage';

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
      stepPlayer(p, emptyInput(), (x, y, z) => ({ id: w.getBlock(x, y, z), meta: w.getMeta(x, y, z) }), 0.05);
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

/**
 * Fall damage through the REAL game tick order (Phase 4 integration test):
 * Game.tick() runs stepPlayer, then tickEntity, which MUST evaluate the
 * landing branch (fallTracker.land) BEFORE fallTracker.update — the old
 * order reset the peak on the landing tick and fall damage was dead at
 * runtime. Game itself needs a DOM, so the exact tickEntity sequence is
 * replicated here against a real world + physics step.
 */
describe('fall damage (game tick order)', () => {
  it('a ~20-block fall applies fall damage (17 for ~20.9 blocks → 3 HP left)', () => {
    // flat floor, top surface at y=11
    const w = new World(1, (_w, chunk) => {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          for (let y = 0; y <= 10; y++) chunk.setBlock(x, y, z, Block.Stone);
        }
      }
    });
    const getBlock = (x: number, y: number, z: number): { id: number; meta: number } => ({
      id: w.getBlock(x, y, z),
      meta: w.getMeta(x, y, z),
    });
    const p = new Player(0.5, 32, 0.5); // ~21-block fall to y=11
    const tracker = new FallTracker();
    const vitals = new Vitals(); // 20 HP
    let wasOnGround = p.onGround;
    let damageApplied = 0;
    for (let i = 0; i < 400; i++) {
      stepPlayer(p, emptyInput(), getBlock, 0.05);
      // exact Game.tickEntity order (Phase 4 fix): land() BEFORE update()
      if (p.onGround && !wasOnGround) {
        const dist = tracker.land(p.y);
        const dmg = fallDamage(dist);
        if (dmg > 0) {
          damageApplied = dmg;
          vitals.damage(dmg);
        }
      }
      tracker.update(p.y, p.vy, p.onGround);
      wasOnGround = p.onGround;
      if (p.onGround && i > 5) break;
    }
    expect(p.onGround).toBe(true);
    expect(p.y).toBeCloseTo(11, 1);
    // fall ≈ 31.925 (peak after the first air tick) - 11 = 20.9 blocks
    // → floor(20.9 - 3) = 17 damage → 20 - 17 = 3 HP
    expect(damageApplied).toBe(17);
    expect(vitals.hp).toBe(3);
  });
});
