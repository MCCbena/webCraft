/**
 * WebCraft — Inventory screen (Phase 2B, [modes]).
 * E opens a 9x4 grid (main storage, inventory slots 9-35) above the hotbar
 * row. Simple click-to-move: click a slot to pick it up, click a target to
 * move/swap/merge; Shift-click = shift-move (hotbar <-> main).
 * E or Esc closes the screen and re-locks the pointer (game.ts handles the
 * pointer lock transition).
 */

import { drawItemIcon, injectStyle } from './icons';
import type { Inventory } from '../player/inventory';
import { HOTBAR_SIZE, SLOT_COUNT } from '../player/inventory';

const CSS = `
  .inventory-panel {
    position: absolute;
    left: 50%;
    bottom: 98px;
    transform: translateX(-50%);
    padding: 8px;
    background: rgba(15, 15, 15, 0.88);
    border: 2px solid rgba(255, 255, 255, 0.35);
    /* #hud is pointer-events:none; re-enable so slot clicks register
       (slots inherit auto from this panel — same pattern as the hotbar). */
    pointer-events: auto;
  }
  .inv-grid {
    display: grid;
    grid-template-columns: repeat(9, 40px);
    gap: 2px;
  }
  .inv-slot {
    position: relative;
    width: 40px;
    height: 40px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.25);
    cursor: pointer;
  }
  .inv-slot.selected {
    border: 2px solid #ffd24a;
    background: rgba(255, 210, 74, 0.18);
  }
  .inv-slot canvas {
    width: 100%;
    height: 100%;
  }
  .inv-count {
    position: absolute;
    right: 2px;
    bottom: 0;
    color: #fff;
    font-size: 12px;
    font-family: monospace;
    text-shadow: 1px 1px 0 #000;
  }
`;

export class InventoryUI {
  /** Click on a main-storage slot (index 9..35). */
  onSlotClick?: (index: number, shift: boolean) => void;

  private readonly root: HTMLElement;
  private panel: HTMLDivElement | null = null;
  private slotEls: HTMLDivElement[] = [];
  private canvases: HTMLCanvasElement[] = [];
  private countEls: HTMLSpanElement[] = [];
  private lastKey = '';

  constructor(root: HTMLElement) {
    this.root = root;
    injectStyle('wc-inventory-css', CSS);
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  /** Build and show the 9x4 grid (no-op when already open). */
  open(): void {
    if (this.panel) return;
    this.slotEls = [];
    this.canvases = [];
    this.countEls = [];
    const panel = document.createElement('div');
    panel.className = 'inventory-panel';
    const grid = document.createElement('div');
    grid.className = 'inv-grid';
    for (let i = 0; i < SLOT_COUNT - HOTBAR_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'inv-slot';
      const cv = document.createElement('canvas');
      cv.width = 48;
      cv.height = 48;
      const cnt = document.createElement('span');
      cnt.className = 'inv-count';
      slot.appendChild(cv);
      slot.appendChild(cnt);
      const slotIndex = i + HOTBAR_SIZE;
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSlotClick?.(slotIndex, e.shiftKey);
      });
      grid.appendChild(slot);
      this.slotEls.push(slot);
      this.canvases.push(cv);
      this.countEls.push(cnt);
    }
    panel.appendChild(grid);
    this.root.appendChild(panel);
    this.panel = panel;
    this.lastKey = '';
  }

  /** Remove the grid from the DOM. */
  close(): void {
    if (!this.panel) return;
    this.root.removeChild(this.panel);
    this.panel = null;
    this.slotEls = [];
    this.canvases = [];
    this.countEls = [];
    this.lastKey = '';
  }

  /** Refresh icons + counts + selection highlight (no-op when closed/unchanged). */
  update(inv: Inventory, selected: number): void {
    if (!this.panel) return;
    let key = String(selected);
    for (let i = HOTBAR_SIZE; i < SLOT_COUNT; i++) {
      const s = inv.get(i);
      key += s ? `|${s.id}:${s.count}` : '|_';
    }
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (let i = 0; i < this.canvases.length; i++) {
      const slot = i + HOTBAR_SIZE;
      const s = inv.get(slot);
      const ctx = this.canvases[i].getContext('2d')!;
      ctx.clearRect(0, 0, 48, 48);
      if (s) drawItemIcon(ctx, s.id, 0, 0, 48);
      this.countEls[i].textContent = s && s.count > 1 ? String(s.count) : '';
      this.slotEls[i].classList.toggle('selected', slot === selected);
    }
  }
}
