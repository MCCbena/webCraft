/**
 * WebCraft — F3 debug panel (Phase 2B, [modes]).
 * Shows position, facing, chunk coords, FPS, mode and seed.
 * A separate DOM panel — the core Hud (ui/hud.ts) is left untouched.
 */

import { injectStyle } from './icons';

export interface DebugInfo {
  x: number;
  y: number;
  z: number;
  facing: string;
  chunkX: number;
  chunkZ: number;
  fps: number;
  mode: string;
  seed: number;
}

const FACING_8 = ['north', 'northwest', 'west', 'southwest', 'south', 'southeast', 'east', 'northeast'] as const;

/**
 * Cardinal/intercardinal facing from a yaw angle.
 * yaw 0 = looking toward -Z (north); positive yaw turns left (toward -X/west).
 */
export function facingName(yaw: number): string {
  const deg = ((yaw * 180) / Math.PI) % 360;
  const norm = (deg + 360) % 360;
  return FACING_8[Math.round(norm / 45) % 8];
}

const CSS = `
  .debug-panel {
    position: absolute;
    left: 8px;
    bottom: 8px;
    color: #fff;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.9);
    white-space: pre;
    pointer-events: none;
  }
`;

export class DebugPanel {
  private readonly el: HTMLDivElement;
  private visible = false;

  constructor(root: HTMLElement) {
    injectStyle('wc-debug-css', CSS);
    this.el = document.createElement('div');
    this.el.className = 'debug-panel';
    this.el.style.display = 'none';
    root.appendChild(this.el);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  update(info: DebugInfo): void {
    if (!this.visible) return;
    this.el.textContent = [
      `pos:   ${info.x.toFixed(2)}, ${info.y.toFixed(2)}, ${info.z.toFixed(2)}`,
      `face:  ${info.facing}`,
      `chunk: ${info.chunkX}, ${info.chunkZ}`,
      `fps:   ${info.fps.toFixed(0)}`,
      `mode:  ${info.mode}`,
      `seed:  ${info.seed}`,
    ].join('\n');
  }
}
