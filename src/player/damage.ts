/**
 * WebCraft — Damage & survival vitals (Phase 2B, [modes]).
 * Pure TS, no DOM — fully unit-testable.
 *
 * 20 TPS tick math (design.md §7):
 *  - fall damage: distance > 5 blocks → damage = floor(distance - 3) (1.13 style)
 *  - void: 4 HP per 20 TPS tick while y < -10
 *  - drowning: 15 s air supply (300 ticks), then 1 HP/s with the head underwater
 *  - hunger: slow passive drain, extra cost per jump;
 *    hunger 0 → HP drains slowly; hunger >= 18 → HP regens slowly
 */

export const TPS = 20;
export const TICK = 1 / TPS;

export const MAX_HP = 20;
export const MAX_HUNGER = 20;
/** 15 seconds of air at 20 TPS. */
export const MAX_AIR_TICKS = 300;

export const FALL_DAMAGE_THRESHOLD = 5;
export const FALL_DAMAGE_OFFSET = 3;

export const VOID_Y_LIMIT = -10;
export const VOID_DMG_PER_TICK = 4;

export const DROWN_DMG_PER_S = 1;
/** 1 HP per 4 s while starved. */
export const STARVE_DMG_PER_S = 0.25;
/** 1 HP per 4 s while well fed. */
export const REGEN_HP_PER_S = 0.25;
export const REGEN_HUNGER_MIN = 18;
/** 1 hunger point per 8 s. */
export const HUNGER_DRAIN_PER_S = 0.125;
export const JUMP_HUNGER_COST = 0.1;

/** 1.13-style fall damage: 0 up to 5 blocks, then floor(distance - 3). */
export function fallDamage(fallDistance: number): number {
  if (fallDistance <= FALL_DAMAGE_THRESHOLD) return 0;
  return Math.max(0, Math.floor(fallDistance - FALL_DAMAGE_OFFSET));
}

export class Vitals {
  hp = MAX_HP;
  hunger = MAX_HUNGER;
  air = MAX_AIR_TICKS;

  reset(): void {
    this.hp = MAX_HP;
    this.hunger = MAX_HUNGER;
    this.air = MAX_AIR_TICKS;
  }

  /** Apply damage. Returns true when the player is now dead (hp <= 0). */
  damage(amount: number): boolean {
    if (amount > 0) this.hp = Math.max(0, this.hp - amount);
    return this.hp <= 0;
  }

  heal(amount: number): void {
    this.hp = Math.min(MAX_HP, this.hp + amount);
  }

  get dead(): boolean {
    return this.hp <= 0;
  }
}

export interface VitalsEnv {
  /** head block is water */
  headInWater: boolean;
  /** player y < VOID_Y_LIMIT */
  inVoid: boolean;
  /** creative mode: no damage/hunger at all, air stays full */
  creative: boolean;
  /** the player started a jump this tick */
  justJumped: boolean;
}

/**
 * Advance vitals by dt seconds (call once per 20 TPS tick, dt = 1/20).
 * Mutates v. Creative: air refilled, nothing else changes.
 * Returns true when the player is dead after the tick.
 */
export function tickVitals(v: Vitals, env: VitalsEnv, dt: number): boolean {
  if (env.creative) {
    v.air = MAX_AIR_TICKS;
    return v.dead;
  }
  if (env.inVoid) v.damage(VOID_DMG_PER_TICK * (dt / TICK));
  if (env.headInWater) {
    v.air -= dt * TPS;
    if (v.air <= 0) v.damage(DROWN_DMG_PER_S * dt);
  } else {
    v.air = MAX_AIR_TICKS;
  }
  if (env.justJumped) v.hunger = Math.max(0, v.hunger - JUMP_HUNGER_COST);
  v.hunger = Math.max(0, v.hunger - HUNGER_DRAIN_PER_S * dt);
  if (v.hunger <= 0) {
    v.damage(STARVE_DMG_PER_S * dt);
  } else if (v.hunger >= REGEN_HUNGER_MIN) {
    v.heal(REGEN_HP_PER_S * dt);
  }
  return v.dead;
}

/** Tracks the peak height while the player is airborne (for fall damage). */
export class FallTracker {
  private peakY: number | null = null;

  /** Call once per tick after physics. */
  update(y: number, vy: number, onGround: boolean): void {
    if (onGround) {
      this.peakY = null;
      return;
    }
    if (vy >= 0 || this.peakY === null) this.peakY = y;
  }

  /** Call when the player lands. Returns the fall distance in blocks and resets. */
  land(y: number): number {
    const d = this.peakY === null ? 0 : Math.max(0, this.peakY - y);
    this.peakY = null;
    return d;
  }

  reset(): void {
    this.peakY = null;
  }
}
