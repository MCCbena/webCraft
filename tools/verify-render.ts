/**
 * WebCraft — CPU render verification (Phase 3).
 *
 * No browser (the sandbox cannot launch Chrome). This script:
 *   1. builds the REAL world (seed 1337, full terrain generator, all 256
 *      chunks), finds spawn, meshes the ±3 chunk neighborhood with the real
 *      mesher, software-rasterizes it from the spawn viewpoint and writes
 *      screenshots/verify-terrain.png;
 *   2. builds a small all-air flat world, places a redstone scene
 *      (torch → 8 dust → repeater → lamp), runs Redstone.tick() a few ticks,
 *      meshes it and writes screenshots/verify-redstone.png.
 *
 * Run: `npm run verify` (tsx).
 *
 * Only pure-TS modules are imported (World/terrain/mesher/redstone) — no
 * DOM, no three.js.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/world/world';
import { createTerrainGenerator, columnProfile } from '../src/world/terrain';
import { buildChunkMeshData } from '../src/world/mesher';
import type { FaceData } from '../src/world/mesher';
import { Block, AIR, getRepeaterOut, setDelay } from '../src/world/blocks';
import { Redstone } from '../src/redstone/tick';
import type { RedstoneCtx } from '../src/redstone/types';
import { renderScene, encodePng, buildSoftwareAtlas } from './rasterizer';
import type { Camera } from './rasterizer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCREENSHOTS = path.join(ROOT, 'screenshots');

const SKY: [number, number, number] = [135, 206, 235]; // 0x87ceeb (renderer sky)
const FOG = { start: 48, end: 110, color: SKY }; // renderer fog
const FOV_Y = (75 * Math.PI) / 180; // renderer camera fov
const EYE_HEIGHT = 1.62; // player eye height

function writePng(name: string, png: Buffer): string {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  const out = path.join(SCREENSHOTS, name);
  fs.writeFileSync(out, png);
  return path.relative(ROOT, out);
}

/** Concatenate opaque FaceData from many chunks into one buffer. */
function mergeOpaque(datas: FaceData[]): FaceData {
  const out: FaceData = { positions: [], normals: [], uvs: [], colors: [], indices: [], vertexCount: 0 };
  let vertexOffset = 0;
  for (const d of datas) {
    out.positions.push(...d.positions);
    out.normals.push(...d.normals);
    out.uvs.push(...d.uvs);
    out.colors.push(...d.colors);
    for (const i of d.indices) out.indices.push(i + vertexOffset);
    vertexOffset += d.vertexCount;
  }
  out.vertexCount = out.positions.length / 3;
  return out;
}

// ---------------------------------------------------------------------------
// Scene 1: real terrain from the spawn viewpoint
// ---------------------------------------------------------------------------

function renderTerrainScene(): void {
  const t0 = performance.now();
  const SEED = 1337;
  const world = new World(SEED, createTerrainGenerator(SEED));

  // all 256 chunks
  for (let cx = -8; cx < 8; cx++) {
    for (let cz = -8; cz < 8; cz++) world.ensureChunk(cx, cz);
  }
  const chunkCount = world.generatedChunkCount;
  const spawn = world.findSpawn();
  const view = pickViewpoint(world, spawn, SEED);

  // mesh the ±3 chunk neighborhood around the spawn chunk
  const spawnCx = Math.floor(spawn.x / 16);
  const spawnCz = Math.floor(spawn.z / 16);
  const datas: FaceData[] = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const cx = spawnCx + dx;
      const cz = spawnCz + dz;
      if (!world.inChunkRange(cx, cz)) continue;
      const chunk = world.ensureChunk(cx, cz);
      if (!chunk) continue;
      datas.push(buildChunkMeshData(chunk, cx, cz, (x, y, z) => world.getBlock(x, y, z)).opaque);
    }
  }
  const meshMs = performance.now() - t0;

  const pitch = -0.32; // ~18° down: horizon + mountains in frame
  const camera: Camera = { x: view.x, y: view.y, z: view.z, yaw: view.yaw, pitch, fovY: FOV_Y };

  const t1 = performance.now();
  const result = renderScene([mergeOpaque(datas)], camera, {
    width: 1280,
    height: 720,
    sky: SKY,
    fog: FOG,
    atlas: buildSoftwareAtlas(),
  });
  const renderMs = performance.now() - t1;
  const png = encodePng(result.width, result.height, result.pixels);
  const rel = writePng('verify-terrain.png', png);

  console.log(`[terrain] seed=${SEED} chunks=${chunkCount} (meshed 7x7 neighborhood)`);
  console.log(`[terrain] spawn=(${spawn.x.toFixed(2)}, ${spawn.y.toFixed(2)}, ${spawn.z.toFixed(2)})  tallest nearby column y=${view.targetH}`);
  console.log(`[terrain] camera yaw=${view.yaw.toFixed(3)} rad pitch=${pitch.toFixed(2)} rad  eye=(${camera.x.toFixed(1)}, ${camera.y.toFixed(1)}, ${camera.z.toFixed(1)})  (vantage y=${view.vantageH})`);
  console.log(`[terrain] triangles=${result.triangleCount} rasterized=${result.rasterizedTriangles} non-sky=${result.nonSkyPixels} (${((100 * result.nonSkyPixels) / (result.width * result.height)).toFixed(1)}%)`);
  console.log(`[terrain] mesh=${meshMs.toFixed(0)}ms render=${renderMs.toFixed(0)}ms png=${png.length}B -> ${rel}`);
}

/** Terrain column height with a margin for trees. */
function terrainTop(seed: number, wx: number, wz: number): number {
  return columnProfile(seed, Math.round(wx), Math.round(wz)).height + 6;
}

/**
 * Pick a scenic camera near the spawn:
 *  1. vantage = the highest clear column within 24 blocks of the spawn
 *     (stands ON the surface, eye 1.62 above);
 *  2. yaw faces the tallest nearby mountain; rotated in 45° steps when the
 *     near terrain (16 blocks) does not drop away, so the frame shows sky +
 *     receding terrain + a mountain, not a cliff face.
 */
function pickViewpoint(
  world: World,
  spawn: { x: number; y: number; z: number },
  seed: number,
): { x: number; y: number; z: number; yaw: number; vantageH: number; targetH: number } {
  const S = 24;
  // --- vantage candidates: prefer mid-elevation (plains/forest, colorful)
  //     columns near the spawn over high stone peaks ---
  const candidates: Array<{ x: number; z: number; h: number; score: number }> = [];
  for (let wz = -S; wz <= S; wz += 2) {
    for (let wx = -S; wx <= S; wx += 2) {
      const x = Math.floor(spawn.x) + wx;
      const z = Math.floor(spawn.z) + wz;
      const h = columnProfile(seed, x, z).height;
      const dist = Math.hypot(wx, wz);
      const score = Math.abs(h - 64) + 0.02 * dist;
      candidates.push({ x, z, h, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score);

  const airAround = (x: number, y: number, z: number): boolean => {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (world.getBlock(bx + dx, by + dy, bz + dz) !== AIR) return false;
        }
      }
    }
    return true;
  };

  let vantage: { x: number; y: number; z: number; h: number } | null = null;
  for (const c of candidates) {
    const x = c.x + 0.5;
    const y = c.h + 1 + EYE_HEIGHT;
    const z = c.z + 0.5;
    if (airAround(x, y, z)) {
      vantage = { x, y, z, h: c.h };
      break;
    }
  }
  if (!vantage) {
    // Fallback: exact spawn column.
    const h = columnProfile(seed, Math.floor(spawn.x), Math.floor(spawn.z)).height;
    vantage = { x: spawn.x, y: h + 1 + EYE_HEIGHT, z: spawn.z, h };
  }

  // --- target: tallest column within 100 blocks (the mountain) ---
  let bestH = -1;
  let bestX = 0;
  let bestZ = -1; // default: -Z
  for (let wz = -100; wz <= 100; wz += 5) {
    for (let wx = -100; wx <= 100; wx += 5) {
      if (Math.abs(wx - vantage.x) < 12 && Math.abs(wz - vantage.z) < 12) continue;
      const h = columnProfile(seed, wx, wz).height;
      if (h > bestH) {
        bestH = h;
        bestX = wx;
        bestZ = wz;
      }
    }
  }
  const len = Math.hypot(bestX - vantage.x, bestZ - vantage.z) || 1;
  const fx = (bestX - vantage.x) / len;
  const fz = (bestZ - vantage.z) / len;
  const baseYaw = Math.atan2(-fx, -fz); // forward = (-sin yaw, -cos yaw)

  // --- yaw: face a direction where the terrain drops away, so the frame
  //     shows sky + receding terrain + the mountain on the horizon. Score =
  //     elevation of the terrain at 48 blocks (lower = more open view). ---
  let yaw = baseYaw;
  let bestScore = Infinity;
  for (let step = 0; step < 8; step++) {
    const y = baseYaw + (step * Math.PI) / 4;
    const dfx = -Math.sin(y);
    const dfz = -Math.cos(y);
    const nearTop = terrainTop(seed, vantage.x + dfx * 16, vantage.z + dfz * 16);
    const midTop = terrainTop(seed, vantage.x + dfx * 48, vantage.z + dfz * 48);
    const nearElev = Math.atan2(nearTop - vantage.y, 16);
    const midElev = Math.atan2(midTop - vantage.y, 48);
    const score = midElev + (nearElev > -0.06 ? 1 : 0); // penalize looming cliffs
    if (score < bestScore) {
      bestScore = score;
      yaw = y;
    }
  }

  return { x: vantage.x, y: vantage.y, z: vantage.z, yaw, vantageH: vantage.h, targetH: bestH };
}

// ---------------------------------------------------------------------------
// Scene 2: redstone circuit (torch → 8 dust → repeater → lamp)
// ---------------------------------------------------------------------------

function renderRedstoneScene(): void {
  const t0 = performance.now();
  // all-air flat world (no generator)
  const world = new World(42, () => {});

  // 12x12 stone floor at y=0 (x 0..11, z 0..11) — inside chunk (0,0)
  for (let x = 0; x <= 11; x++) {
    for (let z = 0; z <= 11; z++) world.setBlock(x, 0, z, Block.Stone);
  }

  // circuit on y=1, along z=2:
  //   torch (2) → dust (3..10) → repeater (11, facing east) → lamp (12)
  world.setBlock(2, 1, 2, Block.RedstoneTorch, 1); // placed lit
  for (let x = 3; x <= 10; x++) world.setBlock(x, 1, 2, Block.RedstoneDust);
  // facing east (+X), delay 1 tick — with the 1.13 sustain semantics (Phase 4:
  // the output stays ON while the input is powered) a delay-1 repeater keeps
  // the lamp stably lit; the old delay-4 workaround is obsolete.
  world.setBlock(11, 1, 2, Block.Repeater, setDelay(3, 1));
  world.setBlock(12, 1, 2, Block.RedstoneLamp);

  // tick the network a few ticks (repeater delay = 1 tick default)
  const redstone = new Redstone();
  const ctx: RedstoneCtx = {
    entityAbove: () => false,
    playerX: 6,
    playerY: 3,
    playerZ: 6,
  };
  for (let i = 0; i < 10; i++) redstone.tick(world, ctx);

  const lampMeta = world.getMeta(12, 1, 2);
  const repeaterOut = getRepeaterOut(world.getMeta(11, 1, 2));
  const dustStrengths: number[] = [];
  for (let x = 3; x <= 10; x++) dustStrengths.push(world.getMeta(x, 1, 2));

  // mesh the single chunk containing the scene
  const chunk = world.ensureChunk(0, 0);
  if (!chunk) throw new Error('scene chunk missing');
  const data = buildChunkMeshData(chunk, 0, 0, (x, y, z) => world.getBlock(x, y, z)).opaque;
  const meshMs = performance.now() - t0;

  // camera: 10 blocks from the scene center, 30° downward
  const tx = 7, ty = 1, tz = 2; // look-at target
  const dist = 10;
  const elev = Math.PI / 6; // 30°
  const horiz = dist * Math.cos(elev);
  const up = dist * Math.sin(elev);
  const camera: Camera = {
    x: tx + horiz / Math.SQRT2,
    y: ty + up,
    z: tz + horiz / Math.SQRT2,
    yaw: Math.PI / 4, // looking toward -X -Z (north-west)
    pitch: -elev,
    fovY: FOV_Y,
  };

  const result = renderScene([data], camera, {
    width: 1280,
    height: 720,
    sky: SKY,
    fog: null,
    atlas: buildSoftwareAtlas(),
  });
  const renderMs = performance.now() - t0 - meshMs;
  const png = encodePng(result.width, result.height, result.pixels);
  const rel = writePng('verify-redstone.png', png);

  console.log(`[redstone] dust strengths=${JSON.stringify(dustStrengths)}`);
  console.log(`[redstone] repeater output=${repeaterOut} lamp lit=${lampMeta === 1}`);
  console.log(`[redstone] triangles=${result.triangleCount} rasterized=${result.rasterizedTriangles} non-sky=${result.nonSkyPixels} (${((100 * result.nonSkyPixels) / (result.width * result.height)).toFixed(1)}%)`);
  console.log(`[redstone] mesh=${meshMs.toFixed(0)}ms render=${renderMs.toFixed(0)}ms png=${png.length}B -> ${rel}`);
}

// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('verify-render.ts') || process.argv[1]?.endsWith('verify-render.mjs')) {
  console.log('WebCraft CPU render verification (no browser)');
  console.log('='.repeat(60));
  renderTerrainScene();
  console.log('-'.repeat(60));
  renderRedstoneScene();
  console.log('='.repeat(60));
  console.log('done.');
}
