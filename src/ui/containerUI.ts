/**
 * WebCraft — Container GUI (Phase 5B, [modes], design.md §8.5).
 *
 * Right-clicking a hopper (5 slots) / dropper / dispenser (9 slots) opens this
 * panel: the container's slots on top, the player's 36-slot main storage below
 * (the hotbar is shown separately by the Hotbar UI). Simple click-to-move,
 * matching the InventoryUI pattern: click a slot to pick it up, click a target
 * to move/swap/merge; Shift-click = shift-move between the two sides. E or Esc
 * closes it and re-locks the pointer (game.ts handles the pointer lock + the
 * actual item math in onContainerSlotClick).
 *
 * Global slot index space emitted to onSlotClick:
 *   0..N-1      = the container's N slots
 *   N..N+35     = the player's main storage (inventory slots 9..44)
 */

import { drawItemIcon, injectStyle } from './icons';
import type { Inventory } from '../player/inventory';
import { HOTBAR_SIZE, SLOT_COUNT, type ItemStack } from '../player/inventory';

const CSS = `
  .container-panel {
    position: absolute;
    left: 50%;
    bottom: 98px;
    transform: translateX(-50%);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: rgba(15, 15, 15, 0.88);
    border: 2px solid rgba(255, 255, 255, 0.35);
    /* #hud is pointer-events:none; re-enable so slot clicks register. */
    pointer-events: auto;
  }
  .container-grid,
  .container-main {
    display: grid;
    grid-template-columns: repeat(9, 40px);
    gap: 2px;
  }
  .container-slot {
    position: relative;
    width: 40px;
    height: 40px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.25);
    cursor: pointer;
  }
  .container-slot.selected {
    border: 2px solid #ffd24a;
    background: rgba(255, 210, 74, 0.18);
  }
  .container-slot canvas {
    width: 100%;
    height: 100%;
  }
  .container-count {
    position: absolute;
    right: 2px;
    bottom: 0;
    color: #fff;
    font-size: 12px;
    font-family: monospace;
    text-shadow: 1px 1px 0 #000;
  }
`;

export class ContainerUI {
  /** Click on a global slot (0..N-1 container, N..N+35 player main). */
  onSlotClick?: (index: number, shift: boolean) => void;

  private readonly root: HTMLElement;
  private panel: HTMLDivElement | null = null;
  private slotEls: HTMLDivElement[] = [];
  private canvases: HTMLCanvasElement[] = [];
  private countEls: HTMLSpanElement[] = [];
  private lastKey = '';
  private slotCount = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    injectStyle('wc-container-css', CSS);
  }

  isOpen(): boolean {
    return this.panel !== null;
  }

  /**
   * Build and show the panel: `slotCount` container slots on top + the player's
   * 36-slot main storage below (no-op when already open).
   */
  open(slotCount: number): void {
    if (this.panel) return;
    this.slotCount = slotCount;
    this.slotEls = [];
    this.canvases = [];
    this.countEls = [];
    const panel = document.createElement('div');
    panel.className = 'container-panel';

    const addSlot = (globalIndex: number): HTMLDivElement => {
      const slot = document.createElement('div');
      slot.className = 'container-slot';
      const cv = document.createElement('canvas');
      cv.width = 48;
      cv.height = 48;
      const cnt = document.createElement('span');
      cnt.className = 'container-count';
      slot.appendChild(cv);
      slot.appendChild(cnt);
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSlotClick?.(globalIndex, e.shiftKey);
      });
      this.slotEls.push(slot);
      this.canvases.push(cv);
      this.countEls.push(cnt);
      return slot;
    };

    const containerGrid = document.createElement('div');
    containerGrid.className = 'container-grid';
    for (let i = 0; i < slotCount; i++) containerGrid.appendChild(addSlot(i));
    panel.appendChild(containerGrid);

    const mainGrid = document.createElement('div');
    mainGrid.className = 'container-main';
    for (let i = 0; i < SLOT_COUNT - HOTBAR_SIZE; i++) mainGrid.appendChild(addSlot(slotCount + i));
    panel.appendChild(mainGrid);

    this.root.appendChild(panel);
    this.panel = panel;
    this.lastKey = '';
  }

  /** Remove the panel from the DOM. */
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
  update(cont: (ItemStack | null)[] | null, inv: Inventory, selected: number): void {
    if (!this.panel) return;
    const N = this.slotCount;
    let key = String(selected);
    for (let i = 0; i < N; i++) {
      const s = cont ? cont[i] : null;
      key += s ? `|c${s.id}:${s.count}` : '|c_';
    }
    for (let i = HOTBAR_SIZE; i < SLOT_COUNT; i++) {
      const s = inv.get(i);
      key += s ? `|p${s.id}:${s.count}` : '|p_';
    }
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (let i = 0; i < this.canvases.length; i++) {
      const s = i < N ? (cont ? cont[i] : null) : inv.get(i - N + HOTBAR_SIZE);
      const ctx = this.canvases[i].getContext('2d')!;
      ctx.clearRect(0, 0, 48, 48);
      if (s) drawItemIcon(ctx, s.id, 0, 0, 48);
      this.countEls[i].textContent = s && s.count > 1 ? String(s.count) : '';
      this.slotEls[i].classList.toggle('selected', i === selected);
    }
  }
}
