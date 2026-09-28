/**
 * WebCraft — CPU software rasterizer (Phase 3, verification tooling).
 *
 * Renders mesher `FaceData` (pure-TS triangle soup) to an RGBA buffer with:
 *  - perspective projection (three.js YXZ camera convention: yaw/pitch,
 *    forward = (-sin yaw, sin pitch·cos... see project())
 *  - triangle rasterization with barycentric interpolation
 *  - z-buffer (perspective-correct via linear 1/z interpolation per triangle)
 *  - per-vertex brightness (mesher colors) × procedural atlas pixel color
 *  - optional distance fog + sky background
 *
 * PURE TS for Node — no DOM, no three.js. Used by tools/verify-render.ts
 * (screenshots) and test/verify.test.ts (smoke test).
 */

import { deflateSync } from 'node:zlib';
import { Tile } from '../src/world/blocks';
import type { FaceData } from '../src/world/mesher';

// ---------------------------------------------------------------------------
// Camera & scene types
// ---------------------------------------------------------------------------

export interface Camera {
  /** eye position, world coords */
  x: number;
  y: number;
  z: number;
  /** radians, engine convention (forward = (-sin yaw, 0, -cos yaw)) */
  yaw: number;
  /** radians, + = looking up */
  pitch: number;
  /** vertical field of view, radians */
  fovY: number;
}

export type RGB = [number, number, number];

export interface SoftwareAtlas {
  data: Uint8ClampedArray; // RGBA, size*size*4
  size: number;
}

export interface RenderOptions {
  width: number;
  height: number;
  sky: RGB;
  /** distance fog (three.js Fog equivalent); null = off */
  fog?: { start: number; end: number; color: RGB } | null;
  /** atlas for per-pixel texture color; null = flat per-vertex colors */
  atlas?: SoftwareAtlas | null;
}

export interface RenderResult {
  width: number;
  height: number;
  /** RGBA, width*height*4 */
  pixels: Uint8ClampedArray;
  triangleCount: number;
  rasterizedTriangles: number;
  /** pixels whose color differs from the sky */
  nonSkyPixels: number;
}

const NEAR = 0.05;

// ---------------------------------------------------------------------------
// PNG encoder (zlib deflateSync + manual chunks: IHDR/IDAT/IEND + CRC32)
// ---------------------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  return CRC_TABLE;
}

function crc32(buf: Buffer): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA buffer as an 8-bit truecolor PNG. */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // raw scanlines: filter byte 0 + row bytes
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** PNG file signature (8 bytes). */
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------------------------------------------------------------------------
// Software atlas (pure-TS replica of src/engine/atlas.ts painting)
// ---------------------------------------------------------------------------

class SwCanvas {
  readonly size: number;
  readonly data: Uint8ClampedArray;

  constructor(size: number) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
  }

  /** Alpha-composited fill (the painter only uses integer rects). */
  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    const x1 = Math.max(0, x);
    const y1 = Math.max(0, y);
    const x2 = Math.min(this.size, x + w);
    const y2 = Math.min(this.size, y + h);
    for (let yy = y1; yy < y2; yy++) {
      for (let xx = x1; xx < x2; xx++) {
        const i = (yy * this.size + xx) * 4;
        const da = this.data[i + 3] / 255;
        const oa = a + da * (1 - a);
        if (oa <= 0) continue;
        this.data[i] = Math.round((r * a + this.data[i] * da * (1 - a)) / oa);
        this.data[i + 1] = Math.round((g * a + this.data[i + 1] * da * (1 - a)) / oa);
        this.data[i + 2] = Math.round((b * a + this.data[i + 2] * da * (1 - a)) / oa);
        this.data[i + 3] = Math.round(oa * 255);
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const x1 = Math.max(0, x);
    const y1 = Math.max(0, y);
    const x2 = Math.min(this.size, x + w);
    const y2 = Math.min(this.size, y + h);
    for (let yy = y1; yy < y2; yy++) {
      for (let xx = x1; xx < x2; xx++) {
        const i = (yy * this.size + xx) * 4;
        this.data[i] = 0;
        this.data[i + 1] = 0;
        this.data[i + 2] = 0;
        this.data[i + 3] = 0;
      }
    }
  }
}

/** Same per-pixel sin-hash noise as the canvas atlas painter. */
function swPaintNoise(c: SwCanvas, tile: number, base: RGB, variance = 18, alpha = 1): void {
  const x0 = (tile % 16) * 16;
  const y0 = Math.floor(tile / 16) * 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (Math.sin((x * 37 + y * 91 + tile * 53) * 12.9898) * 43758.5453) % 1;
      const j = (v - 0.5) * 2 * variance;
      const r = Math.max(0, Math.min(255, base[0] + j)) | 0;
      const g = Math.max(0, Math.min(255, base[1] + j)) | 0;
      const b = Math.max(0, Math.min(255, base[2] + j)) | 0;
      c.fillRect(x0 + x, y0 + y, 1, 1, r, g, b, alpha);
    }
  }
}

/** Same LCG speckle as the canvas atlas painter. */
function swSpeckle(c: SwCanvas, tile: number, color: RGB, count: number, size = 2, seed = 1): void {
  const x0 = (tile % 16) * 16;
  const y0 = Math.floor(tile / 16) * 16;
  let s = seed * 7919 + tile * 104729;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) {
    c.fillRect(x0 + Math.floor(rnd() * 14), y0 + Math.floor(rnd() * 14), size, size, color[0], color[1], color[2], 1);
  }
}

/**
 * Build the procedural atlas in pure TS (mirror of paintAtlas in
 * src/engine/atlas.ts — same tiles, same base colors; strokeRect details are
 * approximated by 1px outlines).
 *
 * DRIFT WARNING: this is a second copy of the tile layout/colors. When you
 * change a tile in src/engine/atlas.ts, update the matching sw* call here.
 */
export function buildSoftwareAtlas(): SoftwareAtlas {
  const c = new SwCanvas(256);
  const T = (tile: number): [number, number] => [(tile % 16) * 16, Math.floor(tile / 16) * 16];

  swPaintNoise(c, Tile.Stone, [125, 125, 125], 14);
  swPaintNoise(c, Tile.GrassTop, [106, 170, 64], 20);
  swPaintNoise(c, Tile.GrassSide, [134, 96, 67], 16);
  c.fillRect(T(Tile.GrassSide)[0], T(Tile.GrassSide)[1], 16, 4, 106, 170, 64, 1);
  swPaintNoise(c, Tile.Dirt, [134, 96, 67], 16);
  swPaintNoise(c, Tile.Sand, [219, 207, 163], 12);
  swPaintNoise(c, Tile.Gravel, [136, 136, 136], 24);
  swPaintNoise(c, Tile.LogSide, [102, 81, 50], 10);
  {
    const [lx, ly] = T(Tile.LogSide);
    for (let x = 2; x < 16; x += 4) c.fillRect(lx + x, ly, 1, 16, 70, 54, 30, 0.8);
  }
  swPaintNoise(c, Tile.LogTop, [150, 122, 78], 8);
  {
    const [lx, ly] = T(Tile.LogTop);
    c.fillRect(lx + 3, ly + 3, 10, 1, 102, 81, 50, 0.9);
    c.fillRect(lx + 3, ly + 12, 10, 1, 102, 81, 50, 0.9);
    c.fillRect(lx + 3, ly + 3, 1, 10, 102, 81, 50, 0.9);
    c.fillRect(lx + 12, ly + 3, 1, 10, 102, 81, 50, 0.9);
  }
  swPaintNoise(c, Tile.Leaves, [58, 138, 58], 26, 0.95);
  {
    const [lx, ly] = T(Tile.Leaves);
    c.clearRect(lx + 3, ly + 5, 2, 2);
    c.clearRect(lx + 10, ly + 9, 2, 2);
    c.clearRect(lx + 6, ly + 12, 1, 1);
  }
  swPaintNoise(c, Tile.Planks, [162, 130, 78], 10);
  {
    const [lx, ly] = T(Tile.Planks);
    c.fillRect(lx, ly + 3, 16, 1, 90, 68, 38, 0.7);
    c.fillRect(lx, ly + 11, 16, 1, 90, 68, 38, 0.7);
  }
  swPaintNoise(c, Tile.Cobblestone, [125, 125, 125], 22);
  swSpeckle(c, Tile.Cobblestone, [95, 95, 95], 6, 3, 2);
  swPaintNoise(c, Tile.Glass, [210, 235, 255], 0, 0.18);
  swPaintNoise(c, Tile.Water, [47, 93, 197], 14, 0.9);
  swPaintNoise(c, Tile.Bedrock, [55, 55, 55], 34);
  swPaintNoise(c, Tile.Clay, [151, 155, 165], 8);
  swPaintNoise(c, Tile.Snow, [240, 248, 255], 6);
  for (const [tile, color] of [
    [Tile.CoalOre, [30, 30, 30]],
    [Tile.IronOre, [216, 175, 147]],
    [Tile.RedstoneOre, [186, 41, 41]],
  ] as [number, RGB][]) {
    swPaintNoise(c, tile, [125, 125, 125], 14);
    swSpeckle(c, tile, color, 7, 2, 3);
  }
  swPaintNoise(c, Tile.RedstoneDust, [45, 40, 40], 8);
  c.fillRect(T(Tile.RedstoneDust)[0] + 4, T(Tile.RedstoneDust)[1] + 6, 8, 4, 190, 30, 30, 1);
  swPaintNoise(c, Tile.RedstoneTorchOn, [60, 50, 40], 10);
  c.fillRect(T(Tile.RedstoneTorchOn)[0] + 6, T(Tile.RedstoneTorchOn)[1] + 2, 4, 4, 230, 40, 40, 1);
  swPaintNoise(c, Tile.RedstoneTorchOff, [60, 50, 40], 10);
  c.fillRect(T(Tile.RedstoneTorchOff)[0] + 6, T(Tile.RedstoneTorchOff)[1] + 2, 4, 4, 120, 120, 120, 1);
  swPaintNoise(c, Tile.RedstoneBlock, [155, 31, 31], 16);
  swPaintNoise(c, Tile.RedstoneLampOff, [122, 112, 92], 10);
  swPaintNoise(c, Tile.RedstoneLampLit, [255, 190, 60], 16);
  swPaintNoise(c, Tile.Repeater, [120, 100, 80], 10);
  c.fillRect(T(Tile.Repeater)[0] + 2, T(Tile.Repeater)[1] + 2, 12, 12, 160, 160, 160, 1);
  c.fillRect(T(Tile.Repeater)[0] + 6, T(Tile.Repeater)[1] + 6, 4, 4, 190, 30, 30, 1);
  swPaintNoise(c, Tile.RepeaterOn, [120, 100, 80], 10);
  c.fillRect(T(Tile.RepeaterOn)[0] + 2, T(Tile.RepeaterOn)[1] + 2, 12, 12, 160, 160, 160, 1);
  c.fillRect(T(Tile.RepeaterOn)[0] + 6, T(Tile.RepeaterOn)[1] + 6, 4, 4, 40, 200, 80, 1);
  swPaintNoise(c, Tile.Comparator, [150, 125, 85], 10);
  c.fillRect(T(Tile.Comparator)[0] + 6, T(Tile.Comparator)[1] + 5, 4, 6, 190, 30, 30, 1);
  swPaintNoise(c, Tile.ComparatorOn, [150, 125, 85], 10);
  c.fillRect(T(Tile.ComparatorOn)[0] + 6, T(Tile.ComparatorOn)[1] + 5, 4, 6, 255, 80, 80, 1);
  swPaintNoise(c, Tile.PistonSide, [165, 165, 165], 10);
  swPaintNoise(c, Tile.PistonBase, [125, 125, 125], 14);
  c.fillRect(T(Tile.PistonBase)[0] + 3, T(Tile.PistonBase)[1] + 3, 10, 10, 160, 160, 160, 1);
  swPaintNoise(c, Tile.PistonHead, [140, 118, 80], 10);
  swPaintNoise(c, Tile.StickyPistonSide, [165, 165, 165], 10);
  c.fillRect(T(Tile.StickyPistonSide)[0], T(Tile.StickyPistonSide)[1], 16, 16, 80, 180, 80, 0.5);
  swPaintNoise(c, Tile.StickyPistonHead, [140, 118, 80], 10);
  c.fillRect(T(Tile.StickyPistonHead)[0], T(Tile.StickyPistonHead)[1], 16, 16, 80, 180, 80, 0.5);
  swPaintNoise(c, Tile.ObserverSide, [130, 130, 130], 12);
  swPaintNoise(c, Tile.ObserverFront, [160, 160, 160], 8);
  c.fillRect(T(Tile.ObserverFront)[0] + 3, T(Tile.ObserverFront)[1] + 4, 3, 3, 40, 40, 40, 1);
  c.fillRect(T(Tile.ObserverFront)[0] + 10, T(Tile.ObserverFront)[1] + 4, 3, 3, 40, 40, 40, 1);
  swPaintNoise(c, Tile.ObserverBack, [110, 110, 110], 12);
  swPaintNoise(c, Tile.LeverBase, [125, 125, 125], 14);
  c.fillRect(T(Tile.LeverBase)[0] + 7, T(Tile.LeverBase)[1] + 4, 2, 8, 162, 130, 78, 1);
  swPaintNoise(c, Tile.ButtonCobble, [125, 125, 125], 18);
  swPaintNoise(c, Tile.ButtonWood, [162, 130, 78], 10);
  swPaintNoise(c, Tile.PlateCobble, [125, 125, 125], 18);
  swPaintNoise(c, Tile.PlateWood, [162, 130, 78], 10);
  swPaintNoise(c, Tile.TripwireHook, [162, 130, 78], 10);
  swPaintNoise(c, Tile.DispenserSide, [130, 100, 70], 12);
  c.fillRect(T(Tile.DispenserSide)[0], T(Tile.DispenserSide)[1], 2, 2, 90, 90, 90, 1);
  c.fillRect(T(Tile.DispenserSide)[0] + 14, T(Tile.DispenserSide)[1], 2, 2, 90, 90, 90, 1);
  swPaintNoise(c, Tile.DispenserFront, [130, 100, 70], 12);
  swPaintNoise(c, Tile.DropperSide, [150, 150, 150], 10);
  swPaintNoise(c, Tile.DropperFront, [150, 150, 150], 10);
  swPaintNoise(c, Tile.Torch, [60, 50, 40], 10);
  c.fillRect(T(Tile.Torch)[0] + 6, T(Tile.Torch)[1] + 2, 4, 4, 255, 210, 80, 1);
  swPaintNoise(c, Tile.OakDoor, [162, 130, 78], 10);
  return { data: c.data, size: c.size };
}

// ---------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------

/**
 * Render a list of opaque FaceData buffers (mesher output) from `camera`.
 * Water/transparent buffers are NOT rendered (opaque geometry only).
 */
export function renderScene(faceDatas: FaceData[], camera: Camera, opts: RenderOptions): RenderResult {
  const W = opts.width;
  const H = opts.height;
  const atlas = opts.atlas ?? null;
  const sky = opts.sky;
  const fog = opts.fog ?? null;

  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    pixels[p] = sky[0];
    pixels[p + 1] = sky[1];
    pixels[p + 2] = sky[2];
    pixels[p + 3] = 255;
  }
  const invZBuf = new Float64Array(W * H); // 0 = unrendered

  const f = 1 / Math.tan(camera.fovY / 2);
  const aspect = W / H;
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const { x: ex, y: ey, z: ez } = camera;

  let totalTris = 0;
  let rasterizedTris = 0;

  for (const fd of faceDatas) {
    const positions = fd.positions;
    const colors = fd.colors;
    const uvs = fd.uvs;
    const indices = fd.indices;

    for (let t = 0; t < indices.length; t += 3) {
      totalTris++;
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];

      // --- project vertices (world → camera → screen) ---
      // camera space: rotate -yaw about Y, then -pitch about X; forward = -Z
      let x0s = 0, y0s = 0, z0v = 0, i0z = 0;
      let x1s = 0, y1s = 0, z1v = 0, i1z = 0;
      let x2s = 0, y2s = 0, z2v = 0, i2z = 0;
      let ok = true;
      for (let v = 0; v < 3; v++) {
        const vi = (v === 0 ? i0 : v === 1 ? i1 : i2) * 3;
        const dx = positions[vi] - ex;
        const dy = positions[vi + 1] - ey;
        const dz = positions[vi + 2] - ez;
        const x1 = dx * cy - dz * sy;
        const z1 = dx * sy + dz * cy;
        const y2 = dy * cp + z1 * sp;
        const z2 = -dy * sp + z1 * cp;
        if (z2 > -NEAR) {
          ok = false;
          break;
        }
        const invZ = -1 / z2;
        const nx = x1 * invZ * f * aspect;
        const ny = y2 * invZ * f;
        const sxp = (nx + 1) * 0.5 * W;
        const syp = (1 - ny) * 0.5 * H;
        if (v === 0) {
          x0s = sxp;
          y0s = syp;
          z0v = z2;
          i0z = invZ;
        } else if (v === 1) {
          x1s = sxp;
          y1s = syp;
          z1v = z2;
          i1z = invZ;
        } else {
          x2s = sxp;
          y2s = syp;
          z2v = z2;
          i2z = invZ;
        }
      }
      if (!ok) continue;

      // --- backface cull (front faces project CW in screen y-down space) ---
      const area2 = (x1s - x0s) * (y2s - y0s) - (x2s - x0s) * (y1s - y0s);
      if (area2 >= -1e-9) continue;
      const invArea = 1 / area2;

      // --- bounding box (clipped) ---
      const minX = Math.max(0, Math.floor(Math.min(x0s, x1s, x2s)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0s, x1s, x2s)));
      const minY = Math.max(0, Math.floor(Math.min(y0s, y1s, y2s)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0s, y1s, y2s)));
      if (minX > maxX || minY > maxY) continue;

      const c0r = colors[i0 * 3], c0g = colors[i0 * 3 + 1], c0b = colors[i0 * 3 + 2];
      const c1r = colors[i1 * 3], c1g = colors[i1 * 3 + 1], c1b = colors[i1 * 3 + 2];
      const c2r = colors[i2 * 3], c2g = colors[i2 * 3 + 1], c2b = colors[i2 * 3 + 2];
      const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
      const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
      const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];
      // eye distance for fog
      const d0 = Math.sqrt(z0v * z0v); // |z| ≈ eye distance is exact in view space
      const d1 = Math.sqrt(z1v * z1v);
      const d2 = Math.sqrt(z2v * z2v);

      let touched = false;
      for (let py = minY; py <= maxY; py++) {
        const pyf = py + 0.5;
        const rowBase = py * W;
        for (let px = minX; px <= maxX; px++) {
          const pxf = px + 0.5;
          const w0 = ((x1s - x0s) * (pyf - y0s) - (y1s - y0s) * (pxf - x0s)) * invArea;
          if (w0 < 0) continue;
          const w1 = ((x2s - x1s) * (pyf - y1s) - (y2s - y1s) * (pxf - x1s)) * invArea;
          if (w1 < 0) continue;
          const w2 = 1 - w0 - w1;
          if (w2 < 0) continue;
          const invZ = w0 * i0z + w1 * i1z + w2 * i2z;
          if (invZ <= invZBuf[rowBase + px]) continue;
          invZBuf[rowBase + px] = invZ;
          touched = true;

          const r = w0 * c0r + w1 * c1r + w2 * c2r;
          const g = w0 * c0g + w1 * c1g + w2 * c2g;
          const b = w0 * c0b + w1 * c1b + w2 * c2b;

          let fr = r * 255;
          let fg = g * 255;
          let fb = b * 255;
          if (atlas) {
            const uu = w0 * u0 + w1 * u1 + w2 * u2;
            const vv = w0 * v0 + w1 * v1 + w2 * v2;
            const colF = uu * 16;
            const rowF = (1 - vv) * 16;
            let tc = Math.floor(colF);
            let tv = Math.floor(rowF);
            const fx = colF - tc;
            let fy = rowF - tv;
            if (tc >= 16) tc = 15;
            if (tv >= 16) {
              tv = 15;
              fy = 1;
            }
            const ax = tc * 16 + Math.min(15, Math.floor(fx * 16));
            const ay = tv * 16 + Math.min(15, Math.floor(fy * 16));
            const ai = (ay * 256 + ax) * 4;
            const a = atlas.data[ai + 3] / 255;
            fr = atlas.data[ai] * r;
            fg = atlas.data[ai + 1] * g;
            fb = atlas.data[ai + 2] * b;
            if (a < 1) {
              // translucent tile (glass/leaves/water): blend against sky
              fr = fr * a + sky[0] * (1 - a);
              fg = fg * a + sky[1] * (1 - a);
              fb = fb * a + sky[2] * (1 - a);
            }
          }

          if (fog) {
            const dist = w0 * d0 + w1 * d1 + w2 * d2;
            let ft = (dist - fog.start) / (fog.end - fog.start);
            if (ft < 0) ft = 0;
            else if (ft > 1) ft = 1;
            fr = fr + (fog.color[0] - fr) * ft;
            fg = fg + (fog.color[1] - fg) * ft;
            fb = fb + (fog.color[2] - fb) * ft;
          }

          const p = (rowBase + px) * 4;
          pixels[p] = fr > 255 ? 255 : fr < 0 ? 0 : fr;
          pixels[p + 1] = fg > 255 ? 255 : fg < 0 ? 0 : fg;
          pixels[p + 2] = fb > 255 ? 255 : fb < 0 ? 0 : fb;
          pixels[p + 3] = 255;
        }
      }
      if (touched) rasterizedTris++;
    }
  }

  let nonSky = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    if (pixels[p] !== sky[0] || pixels[p + 1] !== sky[1] || pixels[p + 2] !== sky[2]) nonSky++;
  }

  return { width: W, height: H, pixels, triangleCount: totalTris, rasterizedTriangles: rasterizedTris, nonSkyPixels: nonSky };
}
