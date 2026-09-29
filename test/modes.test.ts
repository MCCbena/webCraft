import { describe, it, expect } from 'vitest';
import {
  Vitals,
  tickVitals,
  fallDamage,
  FallTracker,
  VitalsEnv,
  MAX_HP,
  MAX_HUNGER,
  MAX_AIR_TICKS,
  TICK,
} from '../src/player/damage';
import { ModeManager, DoublePressTracker, fillCreativeInventory } from '../src/player/modes';
import { Inventory } from '../src/player/inventory';
import { Block, isPlaceable, ALL_ITEM_IDS } from '../src/world/blocks';
import { Sfx } from '../src/audio/sfx';

const DT = TICK; // 0.05 s (one 20 TPS tick)

function env(partial: Partial<VitalsEnv> = {}): VitalsEnv {
  return { headInWater: false, inVoid: false, creative: false, justJumped: false, ...partial };
}

function tick(v: Vitals, e: VitalsEnv, n = 1): void {
  for (let i = 0; i < n; i++) tickVitals(v, e, DT);
}

describe('fall damage (1.13 style)', () => {
  it('no damage for falls of 5 blocks or less', () => {
    expect(fallDamage(0)).toBe(0);
    expect(fallDamage(3)).toBe(0);
    expect(fallDamage(5)).toBe(0);
    expect(fallDamage(4.9)).toBe(0);
  });

  it('damage = floor(distance - 3) above 5 blocks', () => {
    expect(fallDamage(5.5)).toBe(2);
    expect(fallDamage(6)).toBe(3);
    expect(fallDamage(10)).toBe(7);
    expect(fallDamage(23)).toBe(20); // capped at full HP by the caller
  });
});

describe('FallTracker', () => {
  it('measures the fall from the peak height', () => {
    const t = new FallTracker();
    t.update(70, 0, false); // leaves the ground
    t.update(68, -4, false);
    t.update(65, -4, false);
    expect(t.land(65)).toBe(5);
  });

  it('tracks the apex of a jump before the fall', () => {
    const t = new FallTracker();
    t.update(70, 5, false); // rising
    t.update(71, 1, false); // apex
    t.update(69, -4, false);
    expect(t.land(69)).toBe(2);
  });

  it('returns 0 when consumed twice and resets on ground', () => {
    const t = new FallTracker();
    t.update(70, 0, false);
    expect(t.land(65)).toBe(5);
    expect(t.land(65)).toBe(0);
    t.update(65, 0, true);
    expect(t.land(65)).toBe(0);
  });
});

describe('void damage', () => {
  it('deals 4 HP per 20 TPS tick below y = -10', () => {
    const v = new Vitals();
    v.hunger = 10; // below the regen threshold, so no healing interferes
    tick(v, env({ inVoid: true }), 1);
    expect(v.hp).toBe(16);
    tick(v, env({ inVoid: true }), 3);
    expect(v.hp).toBe(4);
  });

  it('kills in 5 ticks and reports death', () => {
    const v = new Vitals();
    v.hunger = 10;
    let died = false;
    for (let i = 0; i < 6 && !died; i++) died = tickVitals(v, env({ inVoid: true }), DT);
    expect(died).toBe(true);
    expect(v.hp).toBe(0);
  });

  it('no void damage at/above the limit', () => {
    const v = new Vitals();
    tick(v, env(), 10); // inVoid false
    expect(v.hp).toBe(MAX_HP);
  });
});

describe('drowning', () => {
  it('air depletes one tick per 50 ms while the head is underwater', () => {
    const v = new Vitals();
    tick(v, env({ headInWater: true }), 100);
    expect(v.air).toBe(MAX_AIR_TICKS - 100);
  });

  it('air refills when the head is out of the water', () => {
    const v = new Vitals();
    tick(v, env({ headInWater: true }), 200);
    tick(v, env(), 1);
    expect(v.air).toBe(MAX_AIR_TICKS);
  });

  it('no damage before the 15 s air supply runs out', () => {
    const v = new Vitals();
    tick(v, env({ headInWater: true }), 299); // 14.95 s
    expect(v.hp).toBe(MAX_HP);
  });

  it('deals 1 HP/s once the air supply is exhausted', () => {
    const v = new Vitals();
    v.hunger = 10; // keep regen from interfering
    tick(v, env({ headInWater: true }), 319); // 15.95 s → 20 damage ticks
    expect(v.hp).toBeCloseTo(19, 5);
  });
});

describe('hunger & HP regen', () => {
  it('hunger drains slowly over time (1 point per 8 s)', () => {
    const v = new Vitals();
    tick(v, env(), 160); // 8 s
    expect(v.hunger).toBeCloseTo(19, 5);
  });

  it('jumping costs extra hunger', () => {
    const a = new Vitals();
    const b = new Vitals();
    tick(a, env(), 40);
    tick(b, env({ justJumped: true }), 40); // 2 s of constant jumping
    expect(b.hunger).toBeLessThan(a.hunger);
    expect(a.hunger - b.hunger).toBeCloseTo(4, 5);
  });

  it('starves: at hunger 0 HP drains (1 HP per 4 s)', () => {
    const v = new Vitals();
    v.hunger = 0;
    tick(v, env(), 80); // 4 s → 1 HP
    expect(v.hp).toBeCloseTo(19, 5);
  });

  it('regens HP slowly at hunger >= 18 (1 HP per 4 s)', () => {
    const v = new Vitals();
    v.hp = 10;
    v.hunger = 20;
    tick(v, env(), 80); // 4 s (hunger drifts 20 → 19.5, stays >= 18)
    expect(v.hp).toBeCloseTo(11, 5);
  });

  it('does not regen at hunger < 18', () => {
    const v = new Vitals();
    v.hp = 10;
    v.hunger = 17;
    tick(v, env(), 80);
    expect(v.hp).toBe(10);
  });

  it('does not heal above full HP', () => {
    const v = new Vitals();
    tick(v, env(), 160);
    expect(v.hp).toBe(MAX_HP);
  });

  it('hunger never goes below 0', () => {
    const v = new Vitals();
    tick(v, env(), 3200); // 160 s → 20 points drained
    expect(v.hunger).toBe(0);
  });
});

describe('mode manager', () => {
  it('F toggles between survival and creative', () => {
    const m = new ModeManager();
    expect(m.mode).toBe('survival');
    expect(m.toggleMode()).toBe('creative');
    expect(m.toggleMode()).toBe('survival');
    expect(m.isCreative).toBe(false);
  });

  it('flying is creative-only and cancelled when leaving creative', () => {
    const m = new ModeManager();
    m.toggleFly(); // survival: ignored
    expect(m.fly).toBe(false);
    expect(m.isFlying).toBe(false);
    m.toggleMode(); // → creative
    m.toggleFly();
    expect(m.isFlying).toBe(true);
    m.toggleMode(); // → survival
    expect(m.fly).toBe(false);
    expect(m.isFlying).toBe(false);
  });

  it('setFly is rejected in survival', () => {
    const m = new ModeManager();
    m.setFly(true);
    expect(m.fly).toBe(false);
    m.toggleMode();
    m.setFly(true);
    expect(m.fly).toBe(true);
  });

  it('creative tickVitals never damages (void + drowning + starve)', () => {
    const v = new Vitals();
    v.hunger = 0;
    tick(v, env({ creative: true, inVoid: true, headInWater: true }), 100);
    expect(v.hp).toBe(MAX_HP);
    expect(v.hunger).toBe(0);
    expect(v.air).toBe(MAX_AIR_TICKS);
  });
});

describe('DoublePressTracker', () => {
  it('detects a double press within the window', () => {
    const t = new DoublePressTracker(300);
    expect(t.press(0)).toBe(false);
    expect(t.press(250)).toBe(true);
  });

  it('ignores presses outside the window and after reset', () => {
    const t = new DoublePressTracker(300);
    t.press(0);
    expect(t.press(400)).toBe(false); // 400 ms > window
    t.press(500);
    t.reset();
    expect(t.press(600)).toBe(false); // first press after reset
    expect(t.press(950)).toBe(false); // 350 ms after 600 > window
  });

  it('regression: real key sequence — keydown(0)→keyup(50)→keydown(200) double-presses', () => {
    // Mirrors the game wiring in src/game.ts: press() is called on keydown only;
    // nothing happens on keyup. A normal double-tap is press→release→press, so
    // the second keydown must still see the first within the 300 ms window.
    const t = new DoublePressTracker(300);
    const firstKeyDown = t.press(0); // keydown t=0
    // keyup t=50 → no-op (the keyup reset was removed; press-on-keydown only)
    const secondKeyDown = t.press(200); // keydown t=200
    expect(firstKeyDown).toBe(false);
    expect(secondKeyDown).toBe(true);
  });

  it('regression: a slow tap (keydown t=0, keydown t=500) does not double', () => {
    const t = new DoublePressTracker(300);
    expect(t.press(0)).toBe(false);
    expect(t.press(500)).toBe(false); // 500 ms > 300 ms window
  });
});

describe('creative inventory prefill', () => {
  it('prefills a full stack of every placeable block item', () => {
    const inv = new Inventory();
    const added = fillCreativeInventory(inv);
    const placeable = ALL_ITEM_IDS.filter((id) => isPlaceable(id));
    // Phase 5A: the full 1.13 block set → 42 placeable blocks (the tripwire
    // string block has no item); the 45-slot inventory (Phase 5A expansion)
    // fits them all with 3 slots to spare.
    expect(placeable.length).toBe(42);
    expect(added).toBe(42 * 64);
    for (const id of placeable) expect(inv.countItem(id)).toBe(64);
    expect(inv.isFull).toBe(false);
    expect(inv.firstEmpty()).toBe(42);
  });

  it('leaves existing items untouched (idempotent top-up)', () => {
    const inv = new Inventory();
    inv.set(0, { id: Block.Stone, count: 3 });
    fillCreativeInventory(inv);
    expect(inv.get(0)).toEqual({ id: Block.Stone, count: 3 });
    expect(inv.countItem(Block.Dirt)).toBe(64);
    expect(inv.countItem(Block.Stone)).toBe(3);
  });
});

describe('sfx (non-browser safety)', () => {
  it('play() is a no-op outside a browser (no throw)', () => {
    const sfx = new Sfx();
    expect(() => {
      sfx.ensure();
      sfx.play('break');
      sfx.play('place');
      sfx.play('hit');
      sfx.play('eat');
      sfx.play('mode');
    }).not.toThrow();
  });
});
