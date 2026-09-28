/**
 * WebCraft — Chunk mesher (Phase 1, [core]).
 *
 * PURE TS (no three.js): builds flat per-vertex arrays.
 * engine/renderer.ts converts the result into THREE.BufferGeometry.
 *
 * - Face culling: a face is skipped when the neighbor is opaque,
 *   or the same non-opaque block (water/water, leaves/leaves).
 * - Opaque and water go to separate face buffers (phase-separated mesh).
 * - Per-vertex color = face brightness (top > sides > bottom) + small
 *   deterministic jitter for texture feel.
 * - Only the chunk's non-air vertical span (minY..maxY ±1) is scanned.
 */

import { AIR, WATER, SHAPE_BOXES, getBlockDef, isOn, isSideOn, getStrength, getOutput } from './blocks';
import type { BlockDef } from './blocks';
import { Chunk, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, chunkIndex } from './chunk';

export const ATLAS_TILES_X = 16;
export const ATLAS_TILES_Y = 16;

export interface FaceData {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
  vertexCount: number;
}

export interface ChunkMeshData {
  opaque: FaceData;
  water: FaceData;
}

/** World-coord block lookup used for neighbor queries across chunk borders. */
export type BlockAt = (wx: number, wy: number, wz: number) => number;

export function createFaceData(): FaceData {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [], vertexCount: 0 };
}

interface FaceDef {
  axis: 0 | 1 | 2; // 0=x 1=y 2=z
  sign: 1 | -1;
  corners: number[][]; // 4 x [x,y,z], local box coords 0..1 (CCW from outside)
  uvs: number[][]; // 4 x [u,v], 0..1 within the tile (v=1 at block top)
  brightness: number;
}

const FACES: FaceDef[] = [
  { axis: 0, sign: 1, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], uvs: [[0, 0], [0, 1], [1, 1], [1, 0]], brightness: 0.8 },
  { axis: 0, sign: -1, corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], uvs: [[0, 0], [0, 1], [1, 1], [1, 0]], brightness: 0.8 },
  { axis: 1, sign: 1, corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], uvs: [[0, 1], [0, 0], [1, 0], [1, 1]], brightness: 1.0 },
  { axis: 1, sign: -1, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uvs: [[0, 1], [1, 1], [1, 0], [0, 0]], brightness: 0.55 },
  { axis: 2, sign: 1, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]], brightness: 0.65 },
  { axis: 2, sign: -1, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]], brightness: 0.65 },
];

/** Face visibility rule (see file header). */
export function shouldRenderFace(selfId: number, neighborId: number): boolean {
  if (neighborId === AIR) return true;
  if (neighborId === selfId) return false;
  return !getBlockDef(neighborId).opaque;
}

/**
 * bits 4-7 — repeater output strength (written by the redstone tick; see
 * src/redstone/types.ts getRepeaterOut). Not a blocks.ts helper because the
 * output bits were added by Phase 2C.
 */
function getRepeaterOutput(meta: number): number {
  return (meta & 0xf0) >>> 4;
}

/**
 * Is the block in a powered/lit/on state (for litTiles)?
 *
 * Phase 3: repeaters (`facingDelay`) light up from their output strength
 * (meta bits 4-7) and comparators (`facingModeOutput`) from their output
 * strength (meta bits 3-6, `getOutput`). Facing/delay/mode bits alone never
 * power a component.
 */
export function isPowered(id: number, meta: number): boolean {
  const kind = getBlockDef(id).meta.kind;
  if (kind === 'onOff') return isOn(meta);
  if (kind === 'facingOnOff') return isSideOn(meta);
  if (kind === 'strength') return getStrength(meta) > 0;
  if (kind === 'facingDelay') return getRepeaterOutput(meta) > 0;
  if (kind === 'facingModeOutput') return getOutput(meta) > 0;
  return false;
}

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function addFace(fd: FaceData, face: FaceDef, wx: number, wy: number, wz: number, box: (typeof SHAPE_BOXES)['full'], tile: { top: number; side: number; bottom: number }): void {
  const tileIndex = face.axis === 1 ? (face.sign === 1 ? tile.top : tile.bottom) : tile.side;
  const col = tileIndex % ATLAS_TILES_X;
  const row = Math.floor(tileIndex / ATLAS_TILES_Y);
  const u0 = col / ATLAS_TILES_X;
  const vTop = 1 - row / ATLAS_TILES_Y;
  const span = 1 / ATLAS_TILES_X;
  const base = fd.positions.length / 3;
  const jitter = (hash3(wx, wy, wz) - 0.5) * 0.08;
  const b = face.brightness * (1 + jitter);
  const nx = face.axis === 0 ? face.sign : 0;
  const ny = face.axis === 1 ? face.sign : 0;
  const nz = face.axis === 2 ? face.sign : 0;
  for (let i = 0; i < 4; i++) {
    const c = face.corners[i];
    const [u, v] = face.uvs[i];
    fd.positions.push(wx + box.x0 + c[0] * (box.x1 - box.x0), wy + box.y0 + c[1] * (box.y1 - box.y0), wz + box.z0 + c[2] * (box.z1 - box.z0));
    fd.normals.push(nx, ny, nz);
    fd.uvs.push(u0 + u * span, vTop - (1 - v) * span);
    fd.colors.push(b, b, b);
  }
  fd.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Build the mesh data for one chunk.
 * @param chunk chunk to mesh (local coords)
 * @param chunkX world chunk coordinate (block origin = chunkX*16)
 * @param chunkZ world chunk coordinate (block origin = chunkZ*16)
 * @param blockAt world-coord block id lookup (crosses chunk borders)
 */
export function buildChunkMeshData(chunk: Chunk, chunkX: number, chunkZ: number, blockAt: BlockAt): ChunkMeshData {
  const opaque = createFaceData();
  const water = createFaceData();
  const originX = chunkX * CHUNK_SIZE_X;
  const originZ = chunkZ * CHUNK_SIZE_Z;
  const y0 = Math.max(0, chunk.minY - 1);
  const y1 = Math.min(CHUNK_SIZE_Y - 1, chunk.maxY + 1);

  for (let y = y0; y <= y1; y++) {
    for (let z = 0; z < CHUNK_SIZE_Z; z++) {
      for (let x = 0; x < CHUNK_SIZE_X; x++) {
        const i = chunkIndex(x, y, z);
        const id = chunk.ids[i];
        if (id === AIR) continue;
        const def: BlockDef = getBlockDef(id);
        const meta = chunk.metas[i];
        const target = id === WATER ? water : opaque;
        const tiles = def.litTiles && isPowered(id, meta) ? def.litTiles : def.tiles;
        const box = SHAPE_BOXES[def.shape];
        const wx = originX + x;
        const wz = originZ + z;
        for (const face of FACES) {
          const nx = wx + (face.axis === 0 ? face.sign : 0);
          const ny = y + (face.axis === 1 ? face.sign : 0);
          const nz = wz + (face.axis === 2 ? face.sign : 0);
          if (!shouldRenderFace(id, blockAt(nx, ny, nz))) continue;
          addFace(target, face, wx, y, wz, box, tiles);
        }
      }
    }
  }

  opaque.vertexCount = opaque.positions.length / 3;
  water.vertexCount = water.positions.length / 3;
  return { opaque, water };
}
