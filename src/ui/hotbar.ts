/**
 * WebCraft — Hotbar + status bars + mining progress bar (Phase 2B, [modes]).
 * DOM + Canvas 2D only (no three.js). Item icons come from the procedural
 * texture atlas in ui/icons.ts (same tile mapping as the renderer).
 *
 * - Hotbar: 9 slots bottom-center, selected slot highlighted, item counts.
 *   Number keys / wheel are wired through Input in game.ts; this class also
 *   accepts clicks when the inventory screen is open.
 * - StatusBars: 10 hearts + 10 drumsticks in the row above the hotbar
 *   (survival mode only).
 * - MineBar: small progress bar under the crosshair while mining.
 */

import { drawItemIcon, injectStyle } from './icons';
import type { Inventory } from '../player/inventory';

export const HOTBAR_SLOT_COUNT = 9;

const SLOT = 40; // css px per slot

const CSS = `
  .hotbar {
    position: absolute;
    left: 50%;
    bottom: 8px;
    transform: translateX(-50%);
    display: flex;
    gap: 2px;
    padding: 3px;
    background: rgba(0, 0, 0, 0.45);
    border: 2px solid rgba(255, 255, 255, 0.35);
    pointer-events: none;
  }
  .hotbar-slot {
    position: relative;
    width: ${SLOT}px;
    height: ${SLOT}px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.25);
  }
  .hotbar-slot.selected {
    border: 2px solid #fff;
    background: rgba(255, 255, 255, 0.18);
  }
  .hotbar-slot canvas,
  .status-bars,
  .inv-slot canvas {
    display: block;
    image-rendering: pixelated;
  }
  .hotbar-slot canvas {
    width: 100%;
    height: 100%;
  }
  .hotbar-count {
    position: absolute;
    right: 2px;
    bottom: 0;
    color: #fff;
    font-size: 12px;
    font-family: monospace;
    text-shadow: 1px 1px 0 #000;
  }
  .status-bars {
    position: absolute;
    left: 50%;
    bottom: ${SLOT + 13}px;
    transform: translateX(-50%);
  }
  .mine-bar {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 36px;
    height: 5px;
    transform: translate(-50%, 18px);
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.5);
    visibility: hidden;
  }
  .mine-bar-fill {
    height: 100%;
    width: 0;
    background: #ffd24a;
  }
`;

// ---------------------------------------------------------------------------
// Hotbar
// ---------------------------------------------------------------------------

export class Hotbar {
  onSlotClick?: (index: number, shift: boolean) => void;

  private readonly container: HTMLDivElement;
  private readonly slotEls: HTMLDivElement[] = [];
  private readonly canvases: HTMLCanvasElement[] = [];
  private readonly countEls: HTMLSpanElement[] = [];
  private interactive = false;
  private lastSig = '';

  constructor(root: HTMLElement) {
    injectStyle('wc-hotbar-css', CSS);
    this.container = document.createElement('div');
    this.container.className = 'hotbar';
    for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const cv = document.createElement('canvas');
      cv.width = 48;
      cv.height = 48;
      const cnt = document.createElement('span');
      cnt.className = 'hotbar-count';
      slot.appendChild(cv);
      slot.appendChild(cnt);
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSlotClick?.(i, e.shiftKey);
      });
      this.container.appendChild(slot);
      this.slotEls.push(slot);
      this.canvases.push(cv);
      this.countEls.push(cnt);
    }
    root.appendChild(this.container);
  }

  /** Highlight the selected slot (number keys / wheel via game.ts). */
  setSelected(i: number): void {
    for (let k = 0; k < HOTBAR_SLOT_COUNT; k++) {
      this.slotEls[k].classList.toggle('selected', k === i);
    }
  }

  /** Allow slot clicks (only while the inventory screen is open). */
  setInteractive(on: boolean): void {
    this.interactive = on;
    this.container.style.pointerEvents = on ? 'auto' : 'none';
  }

  get isInteractive(): boolean {
    return this.interactive;
  }

  /** Refresh icons + counts (no-op when nothing changed). */
  update(inv: Inventory, selected: number): void {
    let sig = String(selected);
    for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
      const s = inv.get(i);
      sig += s ? `|${s.id}:${s.count}` : '|_';
    }
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.setSelected(selected);
    for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
      const s = inv.get(i);
      const ctx = this.canvases[i].getContext('2d')!;
      ctx.clearRect(0, 0, 48, 48);
      if (s) drawItemIcon(ctx, s.id, 0, 0, 48);
      this.countEls[i].textContent = s && s.count > 1 ? String(s.count) : '';
    }
  }
}

// ---------------------------------------------------------------------------
// Status bars (hearts + drumsticks, survival only)
// ---------------------------------------------------------------------------

const HEART_EMPTY = 'rgba(70, 15, 15, 0.85)';
const HEART_FULL = '#ff2a2a';
const BAR_W = 160; // 10 x 16px
const BAR_H = 30; // two rows

function heartPath(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x + 7, y + 12);
  ctx.bezierCurveTo(x - 1, y + 5, x + 2, y - 2, x + 7, y + 3);
  ctx.bezierCurveTo(x + 12, y - 2, x + 15, y + 5, x + 7, y + 12);
  ctx.closePath();
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, state: 'full' | 'half' | 'empty'): void {
  if (state === 'empty') {
    heartPath(ctx, x, y);
    ctx.fillStyle = HEART_EMPTY;
    ctx.fill();
    return;
  }
  heartPath(ctx, x, y);
  ctx.fillStyle = HEART_FULL;
  ctx.fill();
  if (state === 'half') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 7, y - 3, 10, 18); // clip to the right half
    ctx.clip();
    heartPath(ctx, x, y);
    ctx.fillStyle = HEART_EMPTY;
    ctx.fill();
    ctx.restore();
  }
}

function drawDrumstick(ctx: CanvasRenderingContext2D, x: number, y: number, filled: boolean): void {
  const meat = filled ? '#c98a4b' : 'rgba(90, 60, 30, 0.85)';
  const bone = filled ? '#e8e0d0' : 'rgba(90, 70, 50, 0.85)';
  ctx.fillStyle = bone;
  ctx.fillRect(x + 8, y + 2, 4, 6);
  ctx.fillStyle = meat;
  ctx.beginPath();
  ctx.ellipse(x + 6, y + 8.5, 5, 4, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

export class StatusBars {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lastKey = '';

  constructor(root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'status-bars';
    this.canvas.width = BAR_W;
    this.canvas.height = BAR_H;
    this.canvas.style.display = 'none';
    this.ctx = this.canvas.getContext('2d')!;
    root.appendChild(this.canvas);
  }

  /** Draw the 10-heart / 10-drumstick row. Hidden in creative mode. */
  update(hp: number, hunger: number, visible: boolean): void {
    if (!visible) {
      this.canvas.style.display = 'none';
      this.lastKey = '';
      return;
    }
    this.canvas.style.display = 'block';
    const key = `${hp}|${hunger}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.ctx.clearRect(0, 0, BAR_W, BAR_H);
    for (let i = 0; i < 10; i++) {
      const x = i * 16;
      drawHeart(this.ctx, x, 1, hp > 2 * i + 1 ? 'full' : hp > 2 * i ? 'half' : 'empty');
      drawDrumstick(this.ctx, x, 15, hunger > i);
    }
  }
}

// ---------------------------------------------------------------------------
// Mining progress bar (near the crosshair)
// ---------------------------------------------------------------------------

export class MineBar {
  private readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private last = -1;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'mine-bar';
    this.fill = document.createElement('div');
    this.fill.className = 'mine-bar-fill';
    this.el.appendChild(this.fill);
    root.appendChild(this.el);
  }

  /** progress in [0, 1]; 0 hides the bar. */
  set(progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    if (p === this.last) return;
    this.last = p;
    this.fill.style.width = `${p * 100}%`;
    this.el.style.visibility = p > 0 ? 'visible' : 'hidden';
  }
}
