/**
 * WebCraft — Sound effects (Phase 2B, [modes]; Phase 5B: boom + note block).
 * WebAudio oscillator/noise-based SFX — no asset files.
 * The AudioContext is lazy-initialized on the first user gesture (browser
 * autoplay policy) and is a no-op outside a browser environment (tests).
 */

import { Block } from '../world/blocks';

export type SfxName = 'break' | 'place' | 'hit' | 'eat' | 'mode' | 'boom';

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
      case 'boom': // Phase 5B: TNT explosion — low sine thump + decaying noise burst
        this.voice(ctx, 'sine', 120, 30, t0, 0.5, GAIN);
        this.noise(ctx, t0, 0.4, GAIN * 0.8);
        break;
    }
  }

  /**
   * Phase 5B: play a note block note. Frequency = `80 * 2^(pitch/12)` Hz
   * (pitch 0-24); timbre by the block directly above (1.13 note block):
   *   wood/log/planks → triangle ("guitar"), snow → sine ("bass"),
   *   stone/cobble → square ("snare"), iron/glass → square ("hi-hat"),
   *   anything else → sine ("basal").
   */
  playNote(pitch: number, blockAbove: number): void {
    this.ensure();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const freq = 80 * Math.pow(2, pitch / 12);
    let type: OscillatorType = 'sine'; // basal
    let dur = 0.4;
    switch (blockAbove) {
      case Block.Log:
      case Block.Planks:
        type = 'triangle'; // guitar
        dur = 0.35;
        break;
      case Block.Snow:
        type = 'sine'; // bass (low, long)
        dur = 0.5;
        break;
      case Block.Stone:
      case Block.Cobblestone:
        type = 'square'; // snare
        dur = 0.2;
        break;
      case Block.IronOre:
      case Block.Glass:
        type = 'square'; // hi-hat (very short)
        dur = 0.1;
        break;
      default:
        type = 'sine'; // basal
        dur = 0.4;
    }
    this.voice(ctx, type, freq, freq, t0, dur, GAIN * 0.8);
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

  /** Phase 5B: decaying white-noise burst through a low-pass filter (explosion). */
  private noise(ctx: AudioContext, start: number, dur: number, peak: number): void {
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, start);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(start);
    src.stop(start + dur);
  }
}
