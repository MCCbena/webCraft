/**
 * WebCraft — Basic HUD (Phase 1, [core]).
 * Crosshair + top-left text overlay (position / mode / selected block).
 * Phase 2B owns hotbar.ts / inventoryUI.ts / debug.ts — this file stays
 * the minimal crosshair + text HUD.
 */

export class Hud {
  private readonly info: HTMLDivElement;
  private readonly hint: HTMLDivElement;

  constructor(container: HTMLElement) {
    const crosshair = document.createElement('div');
    crosshair.className = 'hud-crosshair';
    this.info = document.createElement('div');
    this.info.className = 'hud-info';
    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint';
    container.appendChild(crosshair);
    container.appendChild(this.info);
    container.appendChild(this.hint);
    this.setHint('click to capture mouse — WASD move, Space jump, LMB break, RMB place, 1-9/scroll select, F mode, F3 debug');
  }

  /** Top-left multi-line text. */
  update(text: string): void {
    this.info.textContent = text;
  }

  setHint(text: string): void {
    this.hint.textContent = text;
  }
}
