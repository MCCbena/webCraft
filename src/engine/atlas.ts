/**
 * WebCraft — Procedural texture atlas painter (Phase 3 [core], shared).
 *
 * The 256x256 atlas (16x16 tiles, 16px each) is painted by pure canvas 2D —
 * NO three.js, NO DOM assumptions beyond a 2D context. Both
 * engine/renderer.ts (WebGL texture) and ui/icons.ts (item icons) call
 * `paintAtlas(ctx)` on their own canvases, so the tile indices and colors are
 * defined exactly once (Phase 3 DRY refactor; previously this ~200-line
 * sequence was copy-pasted in both files).
 *
 * Tile layout follows src/world/blocks.ts `Tile` (tile index → (tile % 16,
 * floor(tile / 16)) * 16px).
 */

import { Tile } from '../world/blocks';

export const ATLAS_SIZE = 256;
export const TILE_PX = 16;
export const ATLAS_TILES_PER_ROW = 16;

type RGB = [number, number, number];

/** Top-left pixel of a tile. */
function tileOrigin(tile: number): [number, number] {
  return [(tile % ATLAS_TILES_PER_ROW) * TILE_PX, Math.floor(tile / ATLAS_TILES_PER_ROW) * TILE_PX];
}

/** Deterministic per-pixel noise fill (same sin-hash as the Phase 1 atlas). */
function paintNoise(ctx: CanvasRenderingContext2D, tile: number, base: RGB, variance = 18, alpha = 1): void {
  const [x0, y0] = tileOrigin(tile);
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const v = (Math.sin((x * 37 + y * 91 + tile * 53) * 12.9898) * 43758.5453) % 1;
      const j = (v - 0.5) * 2 * variance;
      ctx.fillStyle = `rgba(${Math.max(0, Math.min(255, base[0] + j)) | 0},${Math.max(0, Math.min(255, base[1] + j)) | 0},${Math.max(0, Math.min(255, base[2] + j)) | 0},${alpha})`;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}

/** Deterministic speckle overlay (LCG random, same as the Phase 1 atlas). */
function speckle(ctx: CanvasRenderingContext2D, tile: number, color: RGB, count: number, size = 2, seed = 1): void {
  const [x0, y0] = tileOrigin(tile);
  let s = seed * 7919 + tile * 104729;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  for (let i = 0; i < count; i++) {
    const x = x0 + Math.floor(rnd() * 14);
    const y = y0 + Math.floor(rnd() * 14);
    ctx.fillRect(x, y, size, size);
  }
}

/**
 * Paint the full procedural atlas into a 2D context. The canvas must already
 * be ATLAS_SIZE x ATLAS_SIZE. Deterministic — identical output every run.
 */
export function paintAtlas(ctx: CanvasRenderingContext2D): void {
  // simple terrain
  paintNoise(ctx, Tile.Stone, [125, 125, 125], 14);
  paintNoise(ctx, Tile.GrassTop, [106, 170, 64], 20);
  paintNoise(ctx, Tile.GrassSide, [134, 96, 67], 16);
  ctx.fillStyle = 'rgb(106,170,64)';
  const gs = tileOrigin(Tile.GrassSide);
  ctx.fillRect(gs[0], gs[1], 16, 4);
  paintNoise(ctx, Tile.Dirt, [134, 96, 67], 16);
  paintNoise(ctx, Tile.Sand, [219, 207, 163], 12);
  paintNoise(ctx, Tile.Gravel, [136, 136, 136], 24);
  paintNoise(ctx, Tile.LogSide, [102, 81, 50], 10);
  const ls = tileOrigin(Tile.LogSide);
  ctx.fillStyle = 'rgba(70,54,30,0.8)';
  for (let x = 2; x < 16; x += 4) ctx.fillRect(ls[0] + x, ls[1], 1, 16);
  paintNoise(ctx, Tile.LogTop, [150, 122, 78], 8);
  const lt = tileOrigin(Tile.LogTop);
  ctx.strokeStyle = 'rgba(102,81,50,0.9)';
  ctx.strokeRect(lt[0] + 3.5, lt[1] + 3.5, 9, 9);
  ctx.strokeRect(lt[0] + 6.5, lt[1] + 6.5, 3, 3);
  paintNoise(ctx, Tile.Leaves, [58, 138, 58], 26, 0.95);
  const lv = tileOrigin(Tile.Leaves);
  ctx.clearRect(lv[0] + 3, lv[1] + 5, 2, 2);
  ctx.clearRect(lv[0] + 10, lv[1] + 9, 2, 2);
  ctx.clearRect(lv[0] + 6, lv[1] + 12, 1, 1);
  paintNoise(ctx, Tile.Planks, [162, 130, 78], 10);
  const pl = tileOrigin(Tile.Planks);
  ctx.fillStyle = 'rgba(90,68,38,0.7)';
  ctx.fillRect(pl[0], pl[1] + 3, 16, 1);
  ctx.fillRect(pl[0], pl[1] + 11, 16, 1);
  paintNoise(ctx, Tile.Cobblestone, [125, 125, 125], 22);
  speckle(ctx, Tile.Cobblestone, [95, 95, 95], 6, 3, 2);
  paintNoise(ctx, Tile.Glass, [210, 235, 255], 0, 0.18);
  const gl = tileOrigin(Tile.Glass);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeRect(gl[0] + 0.5, gl[1] + 0.5, 15, 15);
  paintNoise(ctx, Tile.Water, [47, 93, 197], 14, 0.9);
  paintNoise(ctx, Tile.Bedrock, [55, 55, 55], 34);
  paintNoise(ctx, Tile.Clay, [151, 155, 165], 8);
  paintNoise(ctx, Tile.Snow, [240, 248, 255], 6);
  // ores: stone base + speckles
  for (const [tile, color] of [
    [Tile.CoalOre, [30, 30, 30]],
    [Tile.IronOre, [216, 175, 147]],
    [Tile.RedstoneOre, [186, 41, 41]],
  ] as [number, RGB][]) {
    paintNoise(ctx, tile, [125, 125, 125], 14);
    speckle(ctx, tile, color, 7, 2, 3);
  }
  // redstone components
  paintNoise(ctx, Tile.RedstoneDust, [45, 40, 40], 8);
  const rd = tileOrigin(Tile.RedstoneDust);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect(rd[0] + 4, rd[1] + 6, 8, 4);
  paintNoise(ctx, Tile.RedstoneTorchOn, [60, 50, 40], 10);
  const rto = tileOrigin(Tile.RedstoneTorchOn);
  ctx.fillStyle = 'rgb(230,40,40)';
  ctx.fillRect(rto[0] + 6, rto[1] + 2, 4, 4);
  paintNoise(ctx, Tile.RedstoneTorchOff, [60, 50, 40], 10);
  const rtf = tileOrigin(Tile.RedstoneTorchOff);
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillRect(rtf[0] + 6, rtf[1] + 2, 4, 4);
  paintNoise(ctx, Tile.RedstoneBlock, [155, 31, 31], 16);
  paintNoise(ctx, Tile.RedstoneLampOff, [122, 112, 92], 10);
  paintNoise(ctx, Tile.RedstoneLampLit, [255, 190, 60], 16);
  paintNoise(ctx, Tile.Repeater, [120, 100, 80], 10);
  const rp = tileOrigin(Tile.Repeater);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(rp[0] + 2, rp[1] + 2, 12, 12);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect(rp[0] + 6, rp[1] + 6, 4, 4);
  paintNoise(ctx, Tile.RepeaterOn, [120, 100, 80], 10);
  const rpon = tileOrigin(Tile.RepeaterOn);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(rpon[0] + 2, rpon[1] + 2, 12, 12);
  ctx.fillStyle = 'rgb(40,200,80)';
  ctx.fillRect(rpon[0] + 6, rpon[1] + 6, 4, 4);
  paintNoise(ctx, Tile.Comparator, [150, 125, 85], 10);
  const cp = tileOrigin(Tile.Comparator);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect(cp[0] + 6, cp[1] + 5, 4, 6);
  paintNoise(ctx, Tile.ComparatorOn, [150, 125, 85], 10);
  const cpOn = tileOrigin(Tile.ComparatorOn);
  ctx.fillStyle = 'rgb(255,80,80)';
  ctx.fillRect(cpOn[0] + 6, cpOn[1] + 5, 4, 6);
  paintNoise(ctx, Tile.PistonSide, [165, 165, 165], 10);
  paintNoise(ctx, Tile.PistonBase, [125, 125, 125], 14);
  const pb = tileOrigin(Tile.PistonBase);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(pb[0] + 3, pb[1] + 3, 10, 10);
  paintNoise(ctx, Tile.PistonHead, [140, 118, 80], 10);
  paintNoise(ctx, Tile.StickyPistonSide, [165, 165, 165], 10);
  const sps = tileOrigin(Tile.StickyPistonSide);
  ctx.fillStyle = 'rgba(80,180,80,0.5)';
  ctx.fillRect(sps[0], sps[1], 16, 16);
  paintNoise(ctx, Tile.StickyPistonHead, [140, 118, 80], 10);
  const sph = tileOrigin(Tile.StickyPistonHead);
  ctx.fillStyle = 'rgba(80,180,80,0.5)';
  ctx.fillRect(sph[0], sph[1], 16, 16);
  paintNoise(ctx, Tile.ObserverSide, [130, 130, 130], 12);
  paintNoise(ctx, Tile.ObserverFront, [160, 160, 160], 8);
  const of = tileOrigin(Tile.ObserverFront);
  ctx.fillStyle = 'rgb(40,40,40)';
  ctx.fillRect(of[0] + 3, of[1] + 4, 3, 3);
  ctx.fillRect(of[0] + 10, of[1] + 4, 3, 3);
  paintNoise(ctx, Tile.ObserverBack, [110, 110, 110], 12);
  paintNoise(ctx, Tile.LeverBase, [125, 125, 125], 14);
  const lb = tileOrigin(Tile.LeverBase);
  ctx.fillStyle = 'rgb(162,130,78)';
  ctx.fillRect(lb[0] + 7, lb[1] + 4, 2, 8);
  paintNoise(ctx, Tile.ButtonCobble, [125, 125, 125], 18);
  paintNoise(ctx, Tile.ButtonWood, [162, 130, 78], 10);
  paintNoise(ctx, Tile.PlateCobble, [125, 125, 125], 18);
  paintNoise(ctx, Tile.PlateWood, [162, 130, 78], 10);
  paintNoise(ctx, Tile.TripwireHook, [162, 130, 78], 10);
  paintNoise(ctx, Tile.DispenserSide, [130, 100, 70], 12);
  const ds = tileOrigin(Tile.DispenserSide);
  ctx.fillStyle = 'rgb(90,90,90)';
  ctx.fillRect(ds[0], ds[1], 2, 2);
  ctx.fillRect(ds[0] + 14, ds[1], 2, 2);
  paintNoise(ctx, Tile.DispenserFront, [130, 100, 70], 12);
  const df = tileOrigin(Tile.DispenserFront);
  ctx.fillStyle = 'rgb(40,30,20)';
  ctx.beginPath();
  ctx.arc(df[0] + 8, df[1] + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  paintNoise(ctx, Tile.DropperSide, [150, 150, 150], 10);
  paintNoise(ctx, Tile.DropperFront, [150, 150, 150], 10);
  const dp = tileOrigin(Tile.DropperFront);
  ctx.fillStyle = 'rgb(70,70,70)';
  ctx.beginPath();
  ctx.arc(dp[0] + 8, dp[1] + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  paintNoise(ctx, Tile.Torch, [60, 50, 40], 10);
  const tc = tileOrigin(Tile.Torch);
  ctx.fillStyle = 'rgb(255,210,80)';
  ctx.fillRect(tc[0] + 6, tc[1] + 2, 4, 4);
  paintNoise(ctx, Tile.OakDoor, [162, 130, 78], 10);
  const od = tileOrigin(Tile.OakDoor);
  ctx.strokeStyle = 'rgba(90,68,38,0.8)';
  ctx.strokeRect(od[0] + 1.5, od[1] + 1.5, 13, 13);
}
