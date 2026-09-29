/**
 * WebCraft — Item icons (Phase 2B, [modes]).
 *
 * Icons for the hotbar/inventory are drawn from the procedural texture atlas
 * (16x16 tiles, 16px each, tile index → (tile % 16) * 16, floor(tile / 16) *
 * 16). Phase 3 DRY refactor: the painting code was extracted to the shared
 * src/engine/atlas.ts `paintAtlas()` (also used by engine/renderer.ts), so
 * the tile indices/colors are defined exactly once.
 *
 * Foods and tools (no atlas tile) get small procedural drawings.
 */

import { Item, getBlockDef, getItemDef } from '../world/blocks';
import { paintAtlas, ATLAS_SIZE, TILE_PX, ATLAS_TILES_PER_ROW } from '../engine/atlas';

/** Build the 256x256 procedural atlas (identical tiles to the renderer). */
export function createAtlasCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  paintAtlas(canvas.getContext('2d')!);
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
    ctx.drawImage(a, (tile % ATLAS_TILES_PER_ROW) * TILE_PX, Math.floor(tile / ATLAS_TILES_PER_ROW) * TILE_PX, TILE_PX, TILE_PX, x, y, size, size);
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
    case Item.TripwireString: {
      // Phase 5A: a small string spool (the hook-connection item)
      ctx.strokeStyle = '#96825f';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(4, 5);
      ctx.quadraticCurveTo(8, 2, 12, 5);
      ctx.stroke();
      ctx.fillStyle = '#96825f';
      ctx.beginPath();
      ctx.ellipse(8, 10, 5, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#6b5c3e';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(8, 10, 5, 3.4, 0, 0, Math.PI * 2);
      ctx.stroke();
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
