/**
 * WebCraft — Sound effects (Phase 2B, [modes]).
 * WebAudio oscillator-based SFX — no asset files.
 * The AudioContext is lazy-initialized on the first user gesture (browser
 * autoplay policy) and is a no-op outside a browser environment (tests).
 */

export type SfxName = 'break' | 'place' | 'hit' | 'eat' | 'mode';

const GAIN = 0.35; // master level per voice

export class Sfx {
  private ctx: AudioContext | null = null;

  /** Create/resume the AudioContext. Safe to call from any user gesture. */
  ensure(): void {
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return;
    if (!this.ctx) {
      try {
        this.ctx = new window.AudioContext();
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Play a sound effect. No-op when no AudioContext is available. */
  play(name: SfxName): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    switch (name) {
      case 'break': // low thud
        this.voice(ctx, 'triangle', 95, 45, t0, 0.14, GAIN);
        break;
      case 'place': // short click
        this.voice(ctx, 'square', 320, 220, t0, 0.05, GAIN * 0.8);
        break;
      case 'hit': // heavier thud
        this.voice(ctx, 'sawtooth', 130, 40, t0, 0.18, GAIN);
        break;
      case 'eat': // two low munches
        this.voice(ctx, 'triangle', 110, 70, t0, 0.06, GAIN);
        this.voice(ctx, 'triangle', 130, 80, t0 + 0.09, 0.06, GAIN);
        break;
      case 'mode': // rising blip
        this.voice(ctx, 'sine', 440, 880, t0, 0.12, GAIN * 0.7);
        break;
    }
  }

  /** Single oscillator + gain envelope, exponential decay to silence. */
  private voice(
    ctx: AudioContext,
    type: OscillatorType,
    freqFrom: number,
    freqTo: number,
    start: number,
    dur: number,
    peak: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freqFrom), start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), start + dur);
    gain.gain.setValueAtTime(peak, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}
