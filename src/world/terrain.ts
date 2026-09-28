/**
 * WebCraft — Terrain generation (Phase 2A, [terrain]).
 *
 * Replaces the Phase 1 placeholder (generateSimpleTerrain in world.ts) with
 * a 1.13-style generator: multi-octave Perlin fBm heightmap, a mountain belt,
 * temperature/humidity biomes (plains / forest / desert / mountains / ocean /
 * beaches), ore blobs, gravel patches, bedrock floor and oak trees.
 *
 * CONTRACT (Phase 2A deliverable):
 *
 *     import { createTerrainGenerator } from './world/terrain';
 *     const world = new World(seed, createTerrainGenerator(seed));
 *
 * Determinism: every block is a pure function of (seed, worldX, worldY, worldZ).
 * Chunks are self-contained (no cross-chunk writes, no per-chunk counters), so
 * chunk output is identical regardless of generation order.
 *
 * Pure TS — no DOM, no three.js. All block ids come from ./blocks (no new ids).
 */

import { AIR, WATER, Block } from './blocks';
import type { Chunk } from './chunk';
import type { ChunkGenerator, World } from './world';

// ---------------------------------------------------------------------------
// Tuning constants (1.13-style)
// ---------------------------------------------------------------------------

/** Sea level: water fills from the terrain surface up to this y (inclusive). */
export const TERRAIN_SEA_LEVEL = 60;

const BASE_HEIGHT = 64; // average land height
const HILL_AMPLITUDE = 26; // ±hill amplitude around base
const HILL_FREQUENCY = 1 / 96;

const MOUNTAIN_FREQUENCY = 1 / 160;
const MOUNTAIN_START = 0.15; // mountain noise below this → no mountains
const MOUNTAIN_FULL = 0.55; // at/above this → full mountain factor
const MOUNTAIN_BASE = 80; // extra height once fully in the belt
const MOUNTAIN_VARIANCE = 60; // detail-driven extra height (peaks ≈ y 198)
const MOUNTAIN_CUTOFF = 0.45; // mountain factor above this → mountain biome
const SNOW_LINE = 190; // snow caps in the mountain biome

const BIOME_FREQUENCY = 1 / 192;
const DESERT_TEMP_MIN = 0.62; // hot AND dry → desert
const DESERT_HUM_MAX = 0.42;
const FOREST_HUM_MIN = 0.55; // mid temp AND wet → forest
const FOREST_TEMP_MAX = 0.68;
const BEACH_ABOVE_SEA = 2; // land up to 2 blocks above sea level → sandy

const DIRT_DEPTH = 3; // dirt layers below the surface (incl. surface)
const BEDROCK_RANDOM_MAX_Y = 3; // y 1..3: random bedrock
const BEDROCK_RANDOM_CHANCE = 0.3;
const GRAVEL_FREQUENCY = 1 / 64;
const GRAVEL_NOISE_CUTOFF = 0.72; // in-patch chance that a stone block is gravel
const GRAVEL_PROB = 0.08;
const GRAVEL_MIN_DISTANCE = 6; // gravel only this far below the surface

const ORE_MAX_Y = 128; // no ore above this
const COAL_MIN_Y = 8;
const COAL_PROB = 0.01; // blob seed chance per stone block
const COAL_SIZE = 6; // blob size 4..(4+5)
const IRON_MIN_Y = 8;
const IRON_MAX_Y = 64;
const IRON_PROB = 0.004;
const IRON_SIZE = 6; // blob size 3..8
const REDSTONE_MAX_Y = 16;
const REDSTONE_PROB = 0.003;
const REDSTONE_SIZE = 6; // blob size 2..7

const FOREST_TREE_DENSITY = 0.08; // tree chance per grass column
const PLAINS_TREE_DENSITY = 0.004;

// Hash salts (distinct per random decision)
const SALT_BEDROCK = 0x5eedb0c0;
const SALT_GRAVEL = 0x67a27165;
const SALT_COAL = 0x0c0a11c0;
const SALT_COAL_SIZE = 0x0c0a22c1;
const SALT_IRON = 0x1e0771e5;
const SALT_IRON_SIZE = 0x1e0771e6;
const SALT_REDSTONE = 0xde57ead5;
const SALT_REDSTONE_SIZE = 0xde57ead6;
const SALT_WALK_X = 0xa11ce5a1;
const SALT_WALK_Y = 0xa22ce5a2;
const SALT_WALK_Z = 0xa33ce5a3;
const SALT_TREE = 0x7fee7ee0;
const SALT_TRUNK = 0x7f77c457;
const SALT_LEAF = 0x1ea7ea7e;

// Biome codes (stored per column during generation)
const BIOME_PLAINS = 0;
const BIOME_FOREST = 1;
const BIOME_DESERT = 2;
const BIOME_MOUNTAIN = 3;

// ---------------------------------------------------------------------------
// Seeded PRNG + 2D Perlin noise (own implementation, no dependencies)
// ---------------------------------------------------------------------------

/** mulberry32 — fast deterministic 32-bit PRNG → [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded permutation table (512 entries) for gradient noise. */
function makePermTable(seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 256; i < 512; i++) p[i] = p[i - 256];
  return p;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 8-direction gradient for 2D Perlin. */
function grad2(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return (h & 1 ? -u : u) + (h & 2 ? -2 * v : 2 * v);
}

/** 2D Perlin noise, roughly in [-1,1]. Deterministic in (x, z, perm). */
function perlin2(x: number, z: number, perm: Uint8Array): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const X = xi & 255;
  const Z = zi & 255;
  const xf = x - xi;
  const zf = z - zi;
  const u = fade(xf);
  const v = fade(zf);
  const aa = perm[perm[X] + Z];
  const ba = perm[perm[X + 1] + Z];
  const ab = perm[perm[X] + Z + 1];
  const bb = perm[perm[X + 1] + Z + 1];
  return lerp(
    lerp(grad2(aa, xf, zf), grad2(ba, xf - 1, zf), u),
    lerp(grad2(ab, xf, zf - 1), grad2(bb, xf - 1, zf - 1), u),
    v,
  );
}

/**
 * Fractal Brownian motion: `octaves` (3-5) of Perlin noise, normalized to
 * roughly [-1,1]. Deterministic in (x, z, perm).
 */
export function fbm2(x: number, z: number, perm: Uint8Array, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += perlin2(x * freq, z * freq, perm) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  const v = sum / norm;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Deterministic integer hash (x, y, z, seed) → [0,1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Noise sets (one permutation table per field)
// ---------------------------------------------------------------------------

interface NoiseSet {
  height: Uint8Array;
  mountain: Uint8Array;
  detail: Uint8Array;
  temp: Uint8Array;
  hum: Uint8Array;
  gravel: Uint8Array;
}

const noiseCache = new Map<number, NoiseSet>();

function noiseSetFor(seed: number): NoiseSet {
  const key = seed | 0;
  let n = noiseCache.get(key);
  if (!n) {
    n = {
      height: makePermTable((seed ^ 0x51ed270b) | 0),
      mountain: makePermTable((seed ^ 0x9e3779b9) | 0),
      detail: makePermTable((seed ^ 0x85ebca6b) | 0),
      temp: makePermTable((seed ^ 0xc2b2ae35) | 0),
      hum: makePermTable((seed ^ 0x27d4eb2f) | 0),
      gravel: makePermTable((seed ^ 0x165667b1) | 0),
    };
    if (noiseCache.size >= 16) noiseCache.clear();
    noiseCache.set(key, n);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Per-column profile (shared by the generator and the public sampler)
// ---------------------------------------------------------------------------

export type Biome = 'plains' | 'forest' | 'desert' | 'mountain';

/** Public biome name for a biome code. */
const BIOME_NAMES: Biome[] = ['plains', 'forest', 'desert', 'mountain'];
const BIOME_CODE: Record<Biome, number> = { plains: BIOME_PLAINS, forest: BIOME_FOREST, desert: BIOME_DESERT, mountain: BIOME_MOUNTAIN };

interface ColumnProfile {
  /** top solid block y */
  height: number;
  biome: Biome;
  /** block id at the surface (y = height) */
  surface: number;
  /** block id just below the surface (dirt/sand/stone layers) */
  sub: number;
  /** true when the terrain surface is below sea level (ocean column) */
  underwater: boolean;
}

/**
 * Deterministic terrain profile for one world column. Pure function of
 * (seed, wx, wz) — used both by the chunk generator and by `sampleColumn`.
 */
export function columnProfile(seed: number, wx: number, wz: number): ColumnProfile {
  const noise = noiseSetFor(seed);

  // Height: rolling hills + mountain belt (peaks ≈ y 198)
  const hills = fbm2(wx * HILL_FREQUENCY, wz * HILL_FREQUENCY, noise.height, 4);
  const m = fbm2(wx * MOUNTAIN_FREQUENCY, wz * MOUNTAIN_FREQUENCY, noise.mountain, 3);
  const mf = smoothstep(MOUNTAIN_START, MOUNTAIN_FULL, m);
  const detail = fbm2(wx * HILL_FREQUENCY * 2, wz * HILL_FREQUENCY * 2, noise.detail, 2);
  const raw =
    BASE_HEIGHT +
    hills * HILL_AMPLITUDE * (1 - 0.6 * mf) +
    mf * (MOUNTAIN_BASE + MOUNTAIN_VARIANCE * (0.5 + 0.5 * detail));
  const height = Math.max(1, Math.min(250, Math.round(raw)));

  // Biome: mountains are height-driven; the rest from temperature/humidity
  let biome: Biome;
  if (mf > MOUNTAIN_CUTOFF) {
    biome = 'mountain';
  } else {
    const temp = (fbm2(wx * BIOME_FREQUENCY, wz * BIOME_FREQUENCY, noise.temp, 3) + 1) / 2;
    const hum = (fbm2(wx * BIOME_FREQUENCY, wz * BIOME_FREQUENCY, noise.hum, 3) + 1) / 2;
    if (temp > DESERT_TEMP_MIN && hum < DESERT_HUM_MAX) biome = 'desert';
    else if (hum > FOREST_HUM_MIN && temp < FOREST_TEMP_MAX) biome = 'forest';
    else biome = 'plains';
  }

  const underwater = height < TERRAIN_SEA_LEVEL;
  let surface: number;
  let sub: number;
  if (underwater) {
    // ocean: sandy seafloor
    surface = Block.Sand;
    sub = Block.Sand;
  } else if (biome === 'desert') {
    surface = Block.Sand;
    sub = Block.Sand;
  } else if (biome === 'mountain') {
    surface = height >= SNOW_LINE ? Block.Snow : Block.Stone;
    sub = Block.Stone;
  } else {
    // plains/forest; sandy beach close to the waterline
    const beach = height <= TERRAIN_SEA_LEVEL + BEACH_ABOVE_SEA;
    surface = beach ? Block.Sand : Block.Grass;
    sub = beach ? Block.Sand : Block.Dirt;
  }

  return { height, biome, surface, sub, underwater };
}

/**
 * Deterministic sample of one column (pure, no chunks). Used by tests to
 * assert surface sanity per biome.
 */
export function sampleColumn(seed: number, wx: number, wz: number): ColumnProfile {
  return columnProfile(seed, wx, wz);
}

// ---------------------------------------------------------------------------
// Chunk filling
// ---------------------------------------------------------------------------

/** Fill one column: bedrock floor, stone, dirt/sand layers, surface, water. */
function fillColumn(chunk: Chunk, lx: number, lz: number, p: ColumnProfile, wx: number, wz: number, seed: number, noise: NoiseSet): void {
  const h = p.height;
  const inGravelPatch = fbm2(wx * GRAVEL_FREQUENCY, wz * GRAVEL_FREQUENCY, noise.gravel, 2) > GRAVEL_NOISE_CUTOFF;

  for (let y = 0; y <= h; y++) {
    let id: number;
    if (y === 0) {
      id = Block.Bedrock;
    } else if (y <= BEDROCK_RANDOM_MAX_Y && hash3(wx, y, wz, (seed ^ SALT_BEDROCK) | 0) < BEDROCK_RANDOM_CHANCE) {
      id = Block.Bedrock;
    } else if (y === h) {
      id = p.surface;
    } else if (y >= h - (DIRT_DEPTH - 1)) {
      id = p.sub;
    } else {
      id = Block.Stone;
      if (inGravelPatch && h - y >= GRAVEL_MIN_DISTANCE && hash3(wx, y, wz, (seed ^ SALT_GRAVEL) | 0) < GRAVEL_PROB) {
        id = Block.Gravel;
      }
    }
    chunk.setBlock(lx, y, lz, id);
  }

  if (p.underwater) {
    for (let y = h + 1; y <= TERRAIN_SEA_LEVEL; y++) {
      chunk.setBlock(lx, y, lz, WATER);
    }
  }
}

/**
 * Place ore blobs in the stone part of one column (deterministic per cell).
 * Seeds and blob writes are restricted to y <= h - DIRT_DEPTH so ores never
 * touch the surface/subsurface band of any (possibly taller-neighbor) column.
 */
function placeOres(chunk: Chunk, lx: number, lz: number, wx: number, wz: number, h: number, x0: number, z0: number, seed: number, heights: Int16Array): void {
  const top = Math.min(h - DIRT_DEPTH, ORE_MAX_Y);
  for (let y = 1; y <= top; y++) {
    if (chunk.getBlock(lx, y, lz) !== Block.Stone) continue;

    const rc = hash3(wx, y, wz, (seed ^ SALT_COAL) | 0);
    if (y >= COAL_MIN_Y && rc < COAL_PROB) {
      const size = COAL_SIZE - 2 + Math.floor(hash3(wx, y, wz, (seed ^ SALT_COAL_SIZE) | 0) * COAL_SIZE);
      placeOreBlob(chunk, wx, y, wz, size, Block.CoalOre, x0, z0, seed, heights);
    }
    const ri = hash3(wx, y, wz, (seed ^ SALT_IRON) | 0);
    if (y >= IRON_MIN_Y && y <= IRON_MAX_Y && ri < IRON_PROB) {
      const size = IRON_SIZE - 3 + Math.floor(hash3(wx, y, wz, (seed ^ SALT_IRON_SIZE) | 0) * IRON_SIZE);
      placeOreBlob(chunk, wx, y, wz, size, Block.IronOre, x0, z0, seed, heights);
    }
    const rr = hash3(wx, y, wz, (seed ^ SALT_REDSTONE) | 0);
    if (y <= REDSTONE_MAX_Y && rr < REDSTONE_PROB) {
      const size = REDSTONE_SIZE - 4 + Math.floor(hash3(wx, y, wz, (seed ^ SALT_REDSTONE_SIZE) | 0) * REDSTONE_SIZE);
      placeOreBlob(chunk, wx, y, wz, size, Block.RedstoneOre, x0, z0, seed, heights);
    }
  }
}

/**
 * Random-walk ore blob (horizontal, 1.13-style). Only replaces stone, and only
 * inside the current chunk — neighbor chunks generate their own share of the
 * same blob from their own columns, so the result stays deterministic.
 */
function placeOreBlob(
  chunk: Chunk,
  wx: number,
  y: number,
  wz: number,
  size: number,
  ore: number,
  x0: number,
  z0: number,
  seed: number,
  heights: Int16Array,
): void {
  let bx = 0;
  let bz = 0;
  for (let i = 0; i < size; i++) {
    const ox = wx + bx;
    const oz = wz + bz;
    const lx = ox - x0;
    const lz = oz - z0;
    // Respect the target column's surface band so a blob can never overwrite
    // a neighbor column's surface/subsurface (taller-neighbor case).
    const inBounds = lx >= 0 && lx < 16 && lz >= 0 && lz < 16;
    if (inBounds && y <= heights[lz * 16 + lx] - DIRT_DEPTH && chunk.getBlock(lx, y, lz) === Block.Stone) {
      chunk.setBlock(lx, y, lz, ore);
    }
    const r1 = hash3(ox, y, oz, (seed ^ SALT_WALK_X) | 0);
    const r2 = hash3(ox, y, oz, (seed ^ SALT_WALK_Y) | 0);
    const r3 = hash3(ox, y, oz, (seed ^ SALT_WALK_Z) | 0);
    if (r1 < 0.34) bx += r2 < 0.5 ? 1 : -1;
    else if (r1 < 0.67) bz += r2 < 0.5 ? 1 : -1;
    else {
      bx += r3 < 0.5 ? 1 : -1;
      bz += r3 < 0.5 ? 1 : -1;
    }
  }
}

// ---------------------------------------------------------------------------
// Trees (oak: trunk 4-6, leaf blob) — fully inside the chunk
// ---------------------------------------------------------------------------

function plantTreeIfAny(
  chunk: Chunk,
  lx: number,
  lz: number,
  x0: number,
  z0: number,
  heights: Int16Array,
  biomeCodes: Uint8Array,
  seed: number,
): void {
  const i = lz * 16 + lx;
  const code = biomeCodes[i];
  if (code !== BIOME_PLAINS && code !== BIOME_FOREST) return;
  const h = heights[i];
  if (h <= TERRAIN_SEA_LEVEL || h > 248) return;
  if (chunk.getBlock(lx, h, lz) !== Block.Grass) return;

  const wx = x0 + lx;
  const wz = z0 + lz;
  const density = code === BIOME_FOREST ? FOREST_TREE_DENSITY : PLAINS_TREE_DENSITY;
  if (hash3(wx, 7, wz, (seed ^ SALT_TREE) | 0) >= density) return;

  const trunkH = 4 + Math.floor(hash3(wx, 11, wz, (seed ^ SALT_TRUNK) | 0) * 3); // 4..6
  const top = h + trunkH;
  if (top + 1 > 255) return;

  // trunk
  for (let y = h + 1; y <= top; y++) {
    chunk.setBlock(lx, y, lz, Block.Log);
  }
  // canopy: two 5x5 layers (random corners), then a 3x3 cap
  for (let dy = -1; dy <= 0; dy++) {
    const y = top + dy;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0 && dy === 0) continue; // trunk top
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2 && hash3(wx + dx, y, wz + dz, (seed ^ SALT_LEAF) | 0) < 0.5) continue;
        const x = lx + dx;
        const z = lz + dz;
        if (chunk.getBlock(x, y, z) === AIR) chunk.setBlock(x, y, z, Block.Leaves);
      }
    }
  }
  const capY = top + 1;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const x = lx + dx;
      const z = lz + dz;
      if (chunk.getBlock(x, capY, z) === AIR) chunk.setBlock(x, capY, z, Block.Leaves);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the Phase 2A terrain generator (ChunkGenerator for `new World(seed, gen)`).
 *
 * Deterministic from (seed, cx, cz): every block is computed from world
 * coordinates, so a chunk is identical no matter when/where it is generated.
 */
export function createTerrainGenerator(seed: number): ChunkGenerator {
  const s = seed | 0;
  const noise = noiseSetFor(s);
  return (world: World, chunk: Chunk, cx: number, cz: number): void => {
    void world; // not needed — the generator is purely (seed, cx, cz)
    const x0 = cx * 16;
    const z0 = cz * 16;
    const heights = new Int16Array(256);
    const biomeCodes = new Uint8Array(256);

    // pass 1: columns (terrain, subsurface, water, ores)
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const i = lz * 16 + lx;
        const wx = x0 + lx;
        const wz = z0 + lz;
        const p = columnProfile(s, wx, wz);
        heights[i] = p.height;
        biomeCodes[i] = BIOME_CODE[p.biome];
        fillColumn(chunk, lx, lz, p, wx, wz, s, noise);
        placeOres(chunk, lx, lz, wx, wz, p.height, x0, z0, s, heights);
      }
    }

    // pass 2: trees (canopy radius 2 → keep trunks 2..13 so trees stay in-chunk)
    for (let lz = 2; lz <= 13; lz++) {
      for (let lx = 2; lx <= 13; lx++) {
        plantTreeIfAny(chunk, lx, lz, x0, z0, heights, biomeCodes, s);
      }
    }
  };
}

/** Biome name lookup helper (used by tests/reporting). */
export function biomeName(code: number): Biome {
  return BIOME_NAMES[code] ?? BIOME_NAMES[BIOME_PLAINS];
}
