/**
 * WebCraft — Input (Phase 1, [core]).
 * Keyboard state, pointer lock + mouse look deltas, edge-triggered mouse
 * buttons, wheel scrolling. Clicking the canvas requests pointer lock.
 */

export interface InputHandlers {
  /** slot select 0..8 (keys 1-9) */
  onSlot?: (index: number) => void;
  /** wheel delta: +1 up, -1 down */
  onScroll?: (delta: number) => void;
  /** F3 pressed (debug overlay toggle) */
  onF3?: () => void;
  /** F pressed (mode toggle) */
  onMode?: () => void;
  onLockChange?: (locked: boolean) => void;
}

export class Input {
  private readonly keys = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private leftQueued = 0;
  private rightQueued = 0;
  private scroll = 0;
  locked = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: InputHandlers;
  private attached = false;

  constructor(canvas: HTMLCanvasElement, handlers: InputHandlers = {}) {
    this.canvas = canvas;
    this.handlers = handlers;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
    this.canvas.addEventListener('click', this.onClick);
    document.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('wheel', this.onWheel, { passive: true });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.canvas.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('wheel', this.onWheel);
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Consume accumulated mouse-look deltas since last call. */
  consumeMouse(): { dx: number; dy: number } {
    const out = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  /** Edge-triggered left click (break). */
  consumeLeft(): boolean {
    const had = this.leftQueued > 0;
    this.leftQueued = 0;
    return had;
  }

  /** Edge-triggered right click (place). */
  consumeRight(): boolean {
    const had = this.rightQueued > 0;
    this.rightQueued = 0;
    return had;
  }

  consumeScroll(): number {
    const out = this.scroll;
    this.scroll = 0;
    return out;
  }

  // --- event handlers ---

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space') e.preventDefault();
    this.keys.add(e.code);
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) this.handlers.onSlot?.(n - 1);
    }
    if (e.code === 'F3') {
      e.preventDefault();
      this.handlers.onF3?.();
    }
    if (e.code === 'KeyF') this.handlers.onMode?.();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    this.handlers.onLockChange?.(this.locked);
    if (!this.locked) this.keys.clear();
  };

  private onClick = (): void => {
    if (!this.locked) this.canvas.requestPointerLock();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    if (e.button === 0) this.leftQueued++;
    else if (e.button === 2) this.rightQueued++;
  };

  private onWheel = (e: WheelEvent): void => {
    if (e.deltaY > 0) this.scroll -= 1;
    else if (e.deltaY < 0) this.scroll += 1;
  };
}
