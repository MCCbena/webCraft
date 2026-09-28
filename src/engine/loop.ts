/**
 * WebCraft — Game loop (Phase 1, [core]).
 * requestAnimationFrame render + fixed 50ms tick accumulator (20 TPS).
 * The tick callback is where Phase 2C redstone (and other systems) plug in
 * via game.ts.
 */

export const TICK_DT = 0.05; // 20 TPS

export interface LoopCallbacks {
  /** fixed 20 TPS simulation tick */
  tick: () => void;
  /** called once per animation frame (render) */
  frame: () => void;
}

export class GameLoop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private readonly maxFrame = 0.25; // avoid spiral of death after tab switch
  private readonly cb: LoopCallbacks;

  constructor(cb: LoopCallbacks) {
    this.cb = cb;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frameCb);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private frameCb = (now: number): void => {
    if (!this.running) return;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > this.maxFrame) dt = this.maxFrame;
    this.acc += dt;
    while (this.acc >= TICK_DT) {
      this.cb.tick();
      this.acc -= TICK_DT;
    }
    this.cb.frame();
    this.raf = requestAnimationFrame(this.frameCb);
  };
}
