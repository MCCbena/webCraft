/**
 * WebCraft — Item icons (Phase 2B, [modes]).
 *
 * Icons for the hotbar/inventory are drawn from the procedural texture atlas
 * using the SAME tile mapping as src/engine/renderer.ts (16x16 tiles, 16px
 * each, tile index → (tile % 16) * 16, floor(tile / 16) * 16). The painting
 * code is a faithful copy of the renderer's createAtlasTexture() body because
 * src/engine/* is core-owned (Phase 3 may extract the shared painter into a
 * common module to remove the duplication).
 *
 * Foods and tools (no atlas tile) get small procedural drawings.
 */

import { Item, getBlockDef, getItemDef } from '../world/blocks';

type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Atlas painting (copied from src/engine/renderer.ts — keep in sync)
// ---------------------------------------------------------------------------

function paintNoise(ctx: CanvasRenderingContext2D, tile: number, base: RGB, variance = 18, alpha = 1): void {
  const x0 = (tile % 16) * 16;
  const y0 = Math.floor(tile / 16) * 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (Math.sin((x * 37 + y * 91 + tile * 53) * 12.9898) * 43758.5453) % 1;
      const j = (v - 0.5) * 2 * variance;
      ctx.fillStyle = `rgba(${Math.max(0, Math.min(255, base[0] + j)) | 0},${Math.max(0, Math.min(255, base[1] + j)) | 0},${Math.max(0, Math.min(255, base[2] + j)) | 0},${alpha})`;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}

function speckle(ctx: CanvasRenderingContext2D, tile: number, color: RGB, count: number, size = 2, seed = 1): void {
  const x0 = (tile % 16) * 16;
  const y0 = Math.floor(tile / 16) * 16;
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

/** Build the 256x256 procedural atlas (identical tiles to the renderer). */
export function createAtlasCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const T = (tile: number): [number, number] => [(tile % 16) * 16, Math.floor(tile / 16) * 16];

  paintNoise(ctx, 0, [125, 125, 125], 14); // stone
  paintNoise(ctx, 1, [106, 170, 64], 20); // grass top
  paintNoise(ctx, 2, [134, 96, 67], 16); // grass side
  ctx.fillStyle = 'rgb(106,170,64)';
  const gs = T(2);
  ctx.fillRect(gs[0], gs[1], 16, 4);
  paintNoise(ctx, 3, [134, 96, 67], 16); // dirt
  paintNoise(ctx, 4, [219, 207, 163], 12); // sand
  paintNoise(ctx, 5, [136, 136, 136], 24); // gravel
  paintNoise(ctx, 6, [102, 81, 50], 10); // log side
  const ls = T(6);
  ctx.fillStyle = 'rgba(70,54,30,0.8)';
  for (let x = 2; x < 16; x += 4) ctx.fillRect(ls[0] + x, ls[1], 1, 16);
  paintNoise(ctx, 7, [150, 122, 78], 8); // log top
  const lt = T(7);
  ctx.strokeStyle = 'rgba(102,81,50,0.9)';
  ctx.strokeRect(lt[0] + 3.5, lt[1] + 3.5, 9, 9);
  ctx.strokeRect(lt[0] + 6.5, lt[1] + 6.5, 3, 3);
  paintNoise(ctx, 8, [58, 138, 58], 26, 0.95); // leaves
  const lv = T(8);
  ctx.clearRect(lv[0] + 3, lv[1] + 5, 2, 2);
  ctx.clearRect(lv[0] + 10, lv[1] + 9, 2, 2);
  ctx.clearRect(lv[0] + 6, lv[1] + 12, 1, 1);
  paintNoise(ctx, 9, [162, 130, 78], 10); // planks
  const pl = T(9);
  ctx.fillStyle = 'rgba(90,68,38,0.7)';
  ctx.fillRect(pl[0], pl[1] + 3, 16, 1);
  ctx.fillRect(pl[0], pl[1] + 11, 16, 1);
  paintNoise(ctx, 10, [125, 125, 125], 22); // cobblestone
  speckle(ctx, 10, [95, 95, 95], 6, 3, 2);
  paintNoise(ctx, 11, [210, 235, 255], 0, 0.18); // glass
  const gl = T(11);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeRect(gl[0] + 0.5, gl[1] + 0.5, 15, 15);
  paintNoise(ctx, 12, [47, 93, 197], 14, 0.9); // water
  paintNoise(ctx, 13, [55, 55, 55], 34); // bedrock
  paintNoise(ctx, 14, [151, 155, 165], 8); // clay
  paintNoise(ctx, 15, [240, 248, 255], 6); // snow
  // ores: stone base + speckles
  for (const [tile, color] of [
    [16, [30, 30, 30]],
    [17, [216, 175, 147]],
    [18, [186, 41, 41]],
  ] as [number, RGB][]) {
    paintNoise(ctx, tile, [125, 125, 125], 14);
    speckle(ctx, tile, color, 7, 2, 3);
  }
  // redstone components
  paintNoise(ctx, 19, [45, 40, 40], 8);
  const rd = T(19);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect(rd[0] + 4, rd[1] + 6, 8, 4);
  paintNoise(ctx, 20, [60, 50, 40], 10);
  const rto = T(20);
  ctx.fillStyle = 'rgb(230,40,40)';
  ctx.fillRect(rto[0] + 6, rto[1] + 2, 4, 4);
  paintNoise(ctx, 21, [60, 50, 40], 10);
  const rtf = T(21);
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillRect(rtf[0] + 6, rtf[1] + 2, 4, 4);
  paintNoise(ctx, 22, [155, 31, 31], 16);
  paintNoise(ctx, 23, [122, 112, 92], 10);
  paintNoise(ctx, 24, [255, 190, 60], 16);
  paintNoise(ctx, 25, [120, 100, 80], 10);
  const rp = T(25);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(rp[0] + 2, rp[1] + 2, 12, 12);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect(rp[0] + 6, rp[1] + 6, 4, 4);
  paintNoise(ctx, 26, [120, 100, 80], 10);
  const rpon = T(26);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(rpon[0] + 2, rpon[1] + 2, 12, 12);
  ctx.fillStyle = 'rgb(40,200,80)';
  ctx.fillRect(rpon[0] + 6, rpon[1] + 6, 4, 4);
  paintNoise(ctx, 27, [150, 125, 85], 10);
  const cp = T(27);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect(cp[0] + 6, cp[1] + 5, 4, 6);
  paintNoise(ctx, 28, [165, 165, 165], 10);
  paintNoise(ctx, 29, [125, 125, 125], 14);
  const pb = T(29);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect(pb[0] + 3, pb[1] + 3, 10, 10);
  paintNoise(ctx, 30, [140, 118, 80], 10);
  paintNoise(ctx, 31, [165, 165, 165], 10);
  const sps = T(31);
  ctx.fillStyle = 'rgba(80,180,80,0.5)';
  ctx.fillRect(sps[0], sps[1], 16, 16);
  paintNoise(ctx, 32, [140, 118, 80], 10);
  const sph = T(32);
  ctx.fillStyle = 'rgba(80,180,80,0.5)';
  ctx.fillRect(sph[0], sph[1], 16, 16);
  paintNoise(ctx, 33, [130, 130, 130], 12);
  paintNoise(ctx, 34, [160, 160, 160], 8);
  const of = T(34);
  ctx.fillStyle = 'rgb(40,40,40)';
  ctx.fillRect(of[0] + 3, of[1] + 4, 3, 3);
  ctx.fillRect(of[0] + 10, of[1] + 4, 3, 3);
  paintNoise(ctx, 35, [110, 110, 110], 12);
  paintNoise(ctx, 36, [125, 125, 125], 14);
  const lb = T(36);
  ctx.fillStyle = 'rgb(162,130,78)';
  ctx.fillRect(lb[0] + 7, lb[1] + 4, 2, 8);
  paintNoise(ctx, 37, [125, 125, 125], 18);
  paintNoise(ctx, 38, [162, 130, 78], 10);
  paintNoise(ctx, 39, [125, 125, 125], 18);
  paintNoise(ctx, 40, [162, 130, 78], 10);
  paintNoise(ctx, 41, [162, 130, 78], 10);
  paintNoise(ctx, 42, [130, 100, 70], 12);
  const ds = T(42);
  ctx.fillStyle = 'rgb(90,90,90)';
  ctx.fillRect(ds[0], ds[1], 2, 2);
  ctx.fillRect(ds[0] + 14, ds[1], 2, 2);
  paintNoise(ctx, 43, [130, 100, 70], 12);
  const df = T(43);
  ctx.fillStyle = 'rgb(40,30,20)';
  ctx.beginPath();
  ctx.arc(df[0] + 8, df[1] + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  paintNoise(ctx, 44, [150, 150, 150], 10);
  paintNoise(ctx, 45, [150, 150, 150], 10);
  const dp = T(45);
  ctx.fillStyle = 'rgb(70,70,70)';
  ctx.beginPath();
  ctx.arc(dp[0] + 8, dp[1] + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  paintNoise(ctx, 46, [60, 50, 40], 10);
  const tc = T(46);
  ctx.fillStyle = 'rgb(255,210,80)';
  ctx.fillRect(tc[0] + 6, tc[1] + 2, 4, 4);
  paintNoise(ctx, 47, [162, 130, 78], 10);
  const od = T(47);
  ctx.strokeStyle = 'rgba(90,68,38,0.8)';
  ctx.strokeRect(od[0] + 1.5, od[1] + 1.5, 13, 13);
  return canvas;
}

let atlas: HTMLCanvasElement | null = null;

/** Shared atlas canvas (lazily built, cached). */
export function getAtlasCanvas(): HTMLCanvasElement {
  if (!atlas) atlas = createAtlasCanvas();
  return atlas;
}

// ---------------------------------------------------------------------------
// Item icons
// ---------------------------------------------------------------------------

/** Atlas tile for a block item (the block's side face), or null for non-blocks. */
export function tileForItem(itemId: number): number | null {
  const it = getItemDef(itemId);
  if (!it || it.kind !== 'block' || it.blockId === undefined) return null;
  return getBlockDef(it.blockId).tiles.side;
}

/**
 * Draw an item icon into `size`x`size` px at (x, y).
 * Block items: scaled atlas tile. Foods/tools: procedural drawing.
 */
export function drawItemIcon(ctx: CanvasRenderingContext2D, itemId: number, x: number, y: number, size: number): void {
  const tile = tileForItem(itemId);
  ctx.imageSmoothingEnabled = false;
  if (tile !== null) {
    const a = getAtlasCanvas();
    ctx.clearRect(x, y, size, size);
    ctx.drawImage(a, (tile % 16) * 16, Math.floor(tile / 16) * 16, 16, 16, x, y, size, size);
    return;
  }
  ctx.clearRect(x, y, size, size);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 16, size / 16);
  switch (itemId) {
    case Item.Wheat: {
      ctx.fillStyle = '#e8c33a';
      ctx.fillRect(4, 6, 2, 10);
      ctx.fillRect(8, 4, 2, 12);
      ctx.fillRect(12, 7, 2, 9);
      ctx.fillStyle = '#f5d76e';
      ctx.fillRect(3, 3, 4, 4);
      ctx.fillRect(7, 1, 4, 4);
      ctx.fillRect(11, 4, 4, 4);
      break;
    }
    case Item.Bread: {
      ctx.fillStyle = '#c98a4b';
      ctx.beginPath();
      ctx.ellipse(8, 9.5, 5.5, 3.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(90,60,25,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4.5, 9.5);
      ctx.lineTo(11.5, 9.5);
      ctx.stroke();
      break;
    }
    case Item.Apple: {
      ctx.fillStyle = '#d43b3b';
      ctx.beginPath();
      ctx.arc(8, 9.5, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4a7a2a';
      ctx.fillRect(7.4, 2.5, 1.4, 4);
      ctx.beginPath();
      ctx.ellipse(11, 3.5, 2.2, 1.1, 0.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      const tool = getItemDef(itemId)?.tool;
      if (!tool) break;
      // handle (shared by all tools)
      ctx.strokeStyle = '#8a6a3a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(4, 13);
      ctx.lineTo(11, 6);
      ctx.stroke();
      ctx.strokeStyle = '#c8c8c8';
      ctx.fillStyle = '#c8c8c8';
      ctx.lineWidth = 2;
      switch (tool.type) {
        case 'pickaxe':
          ctx.beginPath();
          ctx.moveTo(6, 4);
          ctx.quadraticCurveTo(11.5, 3, 14.5, 8.5);
          ctx.stroke();
          break;
        case 'axe':
          ctx.beginPath();
          ctx.moveTo(9, 3);
          ctx.lineTo(14, 6.5);
          ctx.lineTo(10.5, 9.5);
          ctx.closePath();
          ctx.fill();
          break;
        case 'sword':
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(6, 11);
          ctx.lineTo(13, 3.5);
          ctx.stroke();
          break;
        case 'shovel':
          ctx.beginPath();
          ctx.ellipse(5, 12.5, 2.8, 2, -0.6, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'hoe':
          ctx.fillRect(2.5, 10.5, 5, 2.5);
          break;
      }
    }
  }
  ctx.restore();
}

/**
 * Inject a <style> tag once (by id) so UI modules can own their CSS without
 * touching index.html (a core-owned file).
 */
export function injectStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}
