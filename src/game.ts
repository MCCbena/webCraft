/**
 * WebCraft — Game orchestrator.
 * Phase 1 [core]: World + Player + Renderer + Input + Loop + HUD wiring,
 * DDA raycast (reach 6).
 * Phase 2B [modes]: survival/creative modes, inventory (replaces the Phase 1
 * `slots` stub), hardness-based mining with drops + progress bar, 20 TPS
 * entity tick (fall/void/drown damage, hunger, HP regen, death/respawn),
 * hotbar/status/debug UI, eating, creative fly, SFX.
 *
 * Ownership notes for Phase 2C/3:
 *  - tick() runs at fixed 20 TPS. tickRedstone() is the Phase 2C hook
 *    (currently a stub) and is left untouched.
 *  - The right-click *interact* path is placeTarget(); Phase 2B only swapped
 *    its item source from the `slots` stub to Inventory (plus the
 *    creative no-decrement) and added SFX around the call site in
 *    onRightClick(). Phase 2C may extend placeTarget() for component
 *    interactions.
 */

import { Renderer } from './engine/renderer';
import { GameLoop, TICK_DT } from './engine/loop';
import { Input } from './engine/input';
import { World, DEFAULT_SEED } from './world/world';
import { createTerrainGenerator } from './world/terrain';
import { WorldClock } from './world/time';
import { Player } from './player/player';
import { stepPlayer, GRAVITY } from './player/physics';
import { Hud } from './ui/hud';
import {
  AIR,
  WATER,
  Block,
  Item,
  Facing,
  getBlockDef,
  getDelay,
  getMode,
  isOn,
  isPlaceable,
  isSolidBlock,
  itemBlockId,
  blockName,
  getItemDef,
  DOOR_TOP_BIT,
  isDoorTop,
  setDaylightInverted,
  isDaylightInverted,
  getNotePitch,
  setNotePitch,
  setDelay,
  setMode,
  setOn,
} from './world/blocks';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './world/chunk';
import { Redstone } from './redstone/tick';
import { isContainerId } from './redstone/containers';
import { facingFromYaw, type RedstoneCtx } from './redstone/types';
import { Inventory, MAX_STACK, SLOT_COUNT, HOTBAR_SIZE, type ItemStack } from './player/inventory';
import {
  ModeManager,
  GameMode,
  DoublePressTracker,
  fillCreativeInventory,
  FLY_SPEED,
  FLY_SMOOTH,
} from './player/modes';
import {
  Vitals,
  tickVitals,
  fallDamage,
  FallTracker,
  VOID_Y_LIMIT,
  MAX_HUNGER,
} from './player/damage';
import { Sfx } from './audio/sfx';
import { Hotbar, StatusBars, MineBar } from './ui/hotbar';
import { InventoryUI } from './ui/inventoryUI';
import { ContainerUI } from './ui/containerUI';
import { DebugPanel, facingName } from './ui/debug';

export const REACH = 6.0; // eye reach, design.md §7

/** Mouse-look sensitivity (radians per pixel). */
const MOUSE_SENSITIVITY = 0.0022;
/** Pitch clamp (no full upside-down; small epsilon below ±90°). */
const PITCH_LIMIT = Math.PI / 2 - 0.01;
/** Frame-dt clamp for stable mining progress after tab switches. */
const MAX_FRAME_DT = 0.1;
/** Exponential smoothing factor for the FPS readout (per frame). */
const FPS_SMOOTHING = 0.05;
/** Head probe offset above the feet for the drowning check. */
const HEAD_IN_WATER_OFFSET = 1.5;

export interface RayHit {
  x: number;
  y: number;
  z: number;
  /** face normal of the hit block */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Step-based DDA raycast (Amanatides & Woo), max REACH blocks.
 * Returns the first non-air, non-water block hit.
 */
export function raycast(
  getBlock: (x: number, y: number, z: number) => number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist = REACH,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  // up to ~6 blocks per axis + start block
  for (let i = 0; i < 40; i++) {
    const id = getBlock(x, y, z);
    if (id !== AIR && id !== WATER) return { x, y, z, nx, ny, nz };
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      if (tMaxX > maxDist) return null;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY <= tMaxZ) {
      if (tMaxY > maxDist) return null;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      if (tMaxZ > maxDist) return null;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
  }
  return null;
}

export type { GameMode };

interface MiningState {
  x: number;
  y: number;
  z: number;
  id: number;
  progress: number;
}

export class Game {
  readonly world: World;
  readonly player: Player;
  readonly renderer: Renderer;
  readonly input: Input;
  readonly hud: Hud;
  readonly loop: GameLoop;
  readonly inventory: Inventory;
  readonly modes: ModeManager;
  readonly vitals: Vitals;
  readonly sfx: Sfx;
  readonly hotbar: Hotbar;
  readonly status: StatusBars;
  readonly inventoryUI: InventoryUI;
  readonly containerUI: ContainerUI;
  readonly debug: DebugPanel;
  readonly mineBar: MineBar;
  readonly redstone = new Redstone();
  /** Phase 5A: world day/night clock (24000 ticks/day, starts at 1000). */
  readonly clock = new WorldClock();
  selectedSlot = 0;
  fps = 60;
  ready = false;
  onReady?: () => void;

  /** Current mode (survival | creative) — delegated to ModeManager. */
  get mode(): GameMode {
    return this.modes.mode;
  }

  private readonly canvas: HTMLCanvasElement;
  private f3 = false;
  private lastFrame = performance.now();
  private fpsSmooth = 60;
  private leftDown = false;
  private mining: MiningState | null = null;
  private fallTracker = new FallTracker();
  private spaceTracker = new DoublePressTracker();
  private flyVel = 0;
  private invSelection = -1;
  // Phase 5B: container GUI state (which container is open + pick-up selection)
  private containerPos: { x: number; y: number; z: number } | null = null;
  private containerSelection = -1;

  constructor(canvas: HTMLCanvasElement, seed?: number) {
    this.canvas = canvas;
    // Phase 3: wire the Phase 2A terrain generator (replaces the Phase 1
    // placeholder inside World). Spawn is found on the real terrain.
    const s = seed ?? DEFAULT_SEED;
    this.world = new World(s, createTerrainGenerator(s));
    const spawn = this.world.findSpawn();
    this.player = new Player(spawn.x, spawn.y, spawn.z);
    this.renderer = new Renderer(canvas, this.world);
    const hudRoot: HTMLElement = document.getElementById('hud') ?? document.body;
    this.hud = new Hud(hudRoot);
    this.inventory = new Inventory();
    this.modes = new ModeManager();
    this.vitals = new Vitals();
    this.sfx = new Sfx();
    this.hotbar = new Hotbar(hudRoot);
    this.status = new StatusBars(hudRoot);
    this.inventoryUI = new InventoryUI(hudRoot);
    this.containerUI = new ContainerUI(hudRoot);
    this.debug = new DebugPanel(hudRoot);
    this.mineBar = new MineBar(hudRoot);
    this.inventoryUI.onSlotClick = (i, shift) => this.onSlotClick(i, shift);
    this.containerUI.onSlotClick = (i, shift) => this.onContainerSlotClick(i, shift);
    this.hotbar.onSlotClick = (i, shift) => this.onSlotClick(i, shift);
    this.giveStarterKit();
    this.input = new Input(canvas, {
      onSlot: (i) => this.selectSlot(i),
      onScroll: (d) => this.selectSlot((this.selectedSlot + d + 9) % 9),
      onF3: () => {
        this.f3 = !this.f3;
        this.debug.setVisible(this.f3);
      },
      onMode: () => this.toggleMode(),
    });
    this.input.attach();
    window.addEventListener('keydown', this.onKeyDownExtra);
    window.addEventListener('keyup', this.onKeyUpExtra);
    window.addEventListener('mousedown', this.onMouseDownExtra);
    window.addEventListener('mouseup', this.onMouseUpExtra);
    this.loop = new GameLoop({
      tick: () => this.tick(),
      frame: () => this.frame(),
    });
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.detach();
    window.removeEventListener('keydown', this.onKeyDownExtra);
    window.removeEventListener('keyup', this.onKeyUpExtra);
    window.removeEventListener('mousedown', this.onMouseDownExtra);
    window.removeEventListener('mouseup', this.onMouseUpExtra);
    this.renderer.dispose();
  }

  // -------------------------------------------------------------------------
  // Modes & inventory
  // -------------------------------------------------------------------------

  /** F key: toggle survival/creative. Entering creative pre-fills items. */
  toggleMode(): void {
    this.modes.toggleMode();
    if (this.modes.isCreative) fillCreativeInventory(this.inventory);
    this.sfx.play('mode');
    this.refreshHud();
  }

  /** Double Space: toggle creative fly. */
  toggleFly(): void {
    this.modes.toggleFly();
    this.sfx.play('mode');
  }

  selectSlot(i: number): void {
    this.selectedSlot = i;
    this.refreshHud();
  }

  /**
   * Eating (survival): right-click with no block targeted and a food item
   * selected consumes one item and restores hunger (bread +5, apple +4).
   * Returns true when something was eaten.
   */
  tryEat(): boolean {
    if (this.modes.isCreative) return false;
    const stack = this.inventory.get(this.selectedSlot);
    if (!stack) return false;
    const def = getItemDef(stack.id);
    if (!def || def.kind !== 'food' || !def.foodValue) return false;
    this.inventory.removeItem(this.selectedSlot, 1);
    this.vitals.hunger = Math.min(MAX_HUNGER, this.vitals.hunger + def.foodValue);
    this.sfx.play('eat');
    this.refreshHud();
    return true;
  }

  /** Starter kit so survival is immediately playable. */
  private giveStarterKit(): void {
    const kit: Array<[number, number]> = [
      [Block.Stone, 32],
      [Block.Dirt, 32],
      [Block.Grass, 16],
      [Block.Sand, 16],
      [Block.Log, 16],
      [Block.Planks, 32],
      [Block.Glass, 16],
      [Block.Cobblestone, 32],
      [Block.Torch, 16],
      [Item.Bread, 4],
      [Item.Apple, 2],
      [Item.StonePickaxe, 1],
    ];
    for (const [id, n] of kit) this.inventory.addItem(id, n);
  }

  // -------------------------------------------------------------------------
  // Simulation (20 TPS)
  // -------------------------------------------------------------------------

  /** Fixed 20 TPS simulation tick. */
  tick(): void {
    this.clock.tick(); // Phase 5A: advance the day/night cycle
    const p = this.player;
    const jump = this.input.isDown('Space');
    const input = {
      forward: this.input.isDown('KeyW'),
      back: this.input.isDown('KeyS'),
      left: this.input.isDown('KeyA'),
      right: this.input.isDown('KeyD'),
      jump,
    };
    const wasOnGround = p.onGround;
    if (this.modes.isFlying) {
      // Creative fly: Space up / Shift down, smooth vertical velocity.
      const down = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
      const dir = (jump ? 1 : 0) - (down ? 1 : 0);
      const target = dir * FLY_SPEED;
      const t = 1 - Math.exp(-FLY_SMOOTH * TICK_DT);
      this.flyVel += (target - this.flyVel) * t;
      // Pre-compensate the gravity applied inside stepPlayer so the net
      // vertical velocity this tick is exactly flyVel.
      p.vy = this.flyVel + GRAVITY * TICK_DT;
    }
    // Phase 5A: meta-aware block probe (closed oak doors block the player).
    stepPlayer(p, input, (x, y, z) => ({ id: this.world.getBlock(x, y, z), meta: this.world.getMeta(x, y, z) }), TICK_DT);
    if (this.modes.isFlying) p.vy = this.flyVel;
    this.tickEntity(jump, wasOnGround);
    this.tickRedstone();
  }

  /**
   * 20 TPS entity tick (Phase 2B): fall damage, void, drowning, hunger,
   * HP regen/starvation, death/respawn.
   */
  private tickEntity(jumpHeld: boolean, wasOnGround: boolean): void {
    const p = this.player;
    // Phase 4 fix: evaluate the landing branch BEFORE fallTracker.update() —
    // update() with onGround=true resets the peak, so calling it first made
    // land() return 0 and fall damage was dead at runtime.
    if (p.onGround && !wasOnGround) {
      const dist = this.fallTracker.land(p.y);
      if (dist > 0 && !this.modes.isCreative) {
        const dmg = fallDamage(dist);
        if (dmg > 0) {
          this.sfx.play('hit');
          if (this.vitals.damage(dmg)) this.respawn();
        }
      }
    }
    this.fallTracker.update(p.y, p.vy, p.onGround);
    const headInWater = this.world.getBlock(Math.floor(p.x), Math.floor(p.y + HEAD_IN_WATER_OFFSET), Math.floor(p.z)) === WATER;
    const justJumped = wasOnGround && jumpHeld && !p.inWater;
    tickVitals(this.vitals, {
      headInWater,
      inVoid: p.y < VOID_Y_LIMIT,
      creative: this.modes.isCreative,
      justJumped,
    }, TICK_DT);
    if (this.vitals.dead) this.respawn();
  }

  /** Death: respawn at world spawn with full vitals (inventory kept). */
  private respawn(): void {
    const spawn = this.world.findSpawn();
    const p = this.player;
    p.x = spawn.x;
    p.y = spawn.y;
    p.z = spawn.z;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    this.vitals.reset();
    this.fallTracker.reset();
    this.flyVel = 0;
    this.mining = null;
    this.mineBar.set(0);
  }

  /**
   * Phase 2C (redstone, 20 TPS, synchronous): drives the redstone network +
   * component tick. `entityAbove` reports the player AABB overlap (pressure
   * plates + tripwire tripping). Phase 5A: the active region is the FULL
   * world (no player bound); `worldTime` drives the daylight detector and
   * `hasItems` is the 5B container hook (no content system in 5A → false).
   */
  tickRedstone(): void {
    const p = this.player;
    const ctx: RedstoneCtx = {
      playerX: p.x,
      playerY: p.y,
      playerZ: p.z,
      worldTime: this.clock.time,
      // 5B: wire the real container item system (content presence → power).
      hasItems: (x, y, z) => this.redstone.containers.hasItems(x, y, z),
      // 5B: TNT / piston player damage (survival only).
      onPlayerDamage: (amount, cause) => {
        if (this.modes.isCreative) return;
        this.sfx.play(cause === 'tnt' ? 'boom' : 'hit');
        if (this.vitals.damage(amount)) this.respawn();
      },
      // 5B: TNT explosion SFX + distance-scaled screen flash.
      onExplosion: (_x, _y, _z, dist) => {
        this.sfx.play('boom');
        this.flash(Math.max(0, 1 - dist / 8));
      },
      // 5B: note block plays a note (pitch + block above for timbre).
      onNotePlay: (pitch, blockAbove) => {
        this.sfx.playNote(pitch, blockAbove);
      },
      entityAbove: (x, y, z) =>
        Player.boxesIntersect(p.getAABB(), { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 }),
    };
    this.redstone.tick(this.world, ctx);
  }

  // -------------------------------------------------------------------------
  // Frame: interaction + HUD + render
  // -------------------------------------------------------------------------

  /** Called once per animation frame: interaction + render. */
  frame(): void {
    const { dx, dy } = this.input.consumeMouse();
    if (this.input.locked) {
      this.player.yaw -= dx * MOUSE_SENSITIVITY;
      this.player.pitch -= dy * MOUSE_SENSITIVITY;
      this.player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.player.pitch));
    }
    if (this.input.consumeLeft()) this.onLeftClick();
    if (this.input.consumeRight()) this.onRightClick();

    const now = performance.now();
    const dtf = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dtf > 0) this.fpsSmooth = this.fpsSmooth * (1 - FPS_SMOOTHING) + (1 / dtf) * FPS_SMOOTHING;
    this.fps = this.fpsSmooth;
    const dt = Math.min(Math.max(dtf, 0), MAX_FRAME_DT); // clamp for stable mining progress

    this.tickMining(dt);
    this.refreshHud();

    this.renderer.updateSky(this.clock.time); // Phase 5A: day/night sky + fog
    this.renderer.update(this.player);
    this.renderer.render(this.player);

    if (!this.ready) {
      this.ready = true;
      this.onReady?.();
    }
  }

  private eyeDir(): { dx: number; dy: number; dz: number } {
    const cp = Math.cos(this.player.pitch);
    return {
      dx: -Math.sin(this.player.yaw) * cp,
      dy: Math.sin(this.player.pitch),
      dz: -Math.cos(this.player.yaw) * cp,
    };
  }

  targetBlock(): RayHit | null {
    const d = this.eyeDir();
    return raycast(this.world.getBlock.bind(this.world), this.player.x, this.player.eyeY, this.player.z, d.dx, d.dy, d.dz);
  }

  // --- left click: mining ---------------------------------------------------

  /** Left click: creative breaks instantly; survival mines while held. */
  private onLeftClick(): void {
    if (!this.modes.isCreative) return;
    const hit = this.targetBlock();
    if (!hit) return;
    const id = this.world.getBlock(hit.x, hit.y, hit.z);
    if (getBlockDef(id).hardness < 0) return;
    this.breakBlock(hit.x, hit.y, hit.z, id);
  }

  /**
   * Mining with hardness (survival only): while LMB is held on a block,
   * progress accumulates over hardness / toolSpeed seconds; on completion
   * the block's drop goes to the inventory. The progress bar (mineBar)
   * shows the fraction near the crosshair.
   */
  private tickMining(dt: number): void {
    if (this.modes.isCreative) {
      if (this.mining) {
        this.mining = null;
        this.mineBar.set(0);
      }
      return;
    }
    if (!this.leftDown) {
      if (this.mining) {
        this.mining = null;
        this.mineBar.set(0);
      }
      return;
    }
    const hit = this.targetBlock();
    if (!hit) {
      this.mining = null;
      this.mineBar.set(0);
      return;
    }
    const id = this.world.getBlock(hit.x, hit.y, hit.z);
    const def = getBlockDef(id);
    if (def.hardness < 0) {
      this.mining = null;
      this.mineBar.set(0);
      return;
    }
    if (
      !this.mining ||
      this.mining.x !== hit.x ||
      this.mining.y !== hit.y ||
      this.mining.z !== hit.z ||
      this.mining.id !== id
    ) {
      this.mining = { x: hit.x, y: hit.y, z: hit.z, id, progress: 0 };
    }
    this.mining.progress = Math.min(1, this.mining.progress + (dt * this.selectedToolSpeed()) / def.hardness);
    this.mineBar.set(this.mining.progress);
    if (this.mining.progress >= 1) {
      const m = this.mining;
      this.mining = null;
      this.breakBlock(m.x, m.y, m.z, m.id);
    }
  }

  /** Mining speed multiplier of the selected item (tools, else 1). */
  private selectedToolSpeed(): number {
    const stack = this.inventory.get(this.selectedSlot);
    if (!stack) return 1;
    const it = getItemDef(stack.id);
    return it?.tool ? it.tool.speed : 1;
  }

  /** Break a block, add its drop item to the inventory, play SFX. */
  private breakBlock(x: number, y: number, z: number, id: number): void {
    const def = getBlockDef(id);
    if (id === Block.OakDoor) {
      // 1.13: a door is one 2-block entity — breaking either half removes
      // both (Phase 5A). Read the meta BEFORE clearing.
      const otherY = isDoorTop(this.world.getMeta(x, y, z)) ? y - 1 : y + 1;
      if (this.world.getBlock(x, otherY, z) === Block.OakDoor) {
        this.setBlock(x, otherY, z, AIR);
      }
    }
    // Phase 5B: breaking a container returns its CONTENTS to the player
    // inventory (survival only; creative breaks instantly with no drops).
    if (isContainerId(id) && !this.modes.isCreative) {
      this.redstone.drainContainerToInventory(x, y, z, (itemId, count) => this.inventory.addItem(itemId, count));
    }
    this.setBlock(x, y, z, AIR); // → worldEdit → reconcile destroys the state
    if (def.drop !== 0) this.inventory.addItem(def.drop, 1);
    this.sfx.play('break');
    this.mineBar.set(0);
    this.refreshHud();
  }

  // --- right click: place / eat ----------------------------------------------

  /**
   * Right click: interact with a redstone component (Phase 2C) when targeted,
   * otherwise place the selected block item, or eat when the raycast hits
   * nothing.
   */
  private onRightClick(): void {
    const hit = this.targetBlock();
    if (!hit) {
      this.tryEat();
      return;
    }
    if (this.interactWith(hit)) return;
    const px = hit.x + hit.nx;
    const py = hit.y + hit.ny;
    const pz = hit.z + hit.nz;
    const before = this.world.getBlock(px, py, pz);
    // Phase 4: pass the raycast hit through — no second targetBlock() call.
    this.placeTarget(hit);
    if (this.world.getBlock(px, py, pz) !== before) this.sfx.play('place');
  }

  /**
   * Right-click component interactions (Phase 2C + 5A): lever toggle,
   * button press, repeater delay cycle (1→2→3→4→1), comparator mode toggle,
   * door open/close toggle (5A), tripwire hook string connection while
   * holding the string item (5A), daylight detector inversion toggle (5A).
   * Returns true when the target was interacted with (no placement).
   */
  private interactWith(hit: RayHit): boolean {
    const id = this.world.getBlock(hit.x, hit.y, hit.z);
    const meta = this.world.getMeta(hit.x, hit.y, hit.z);
    switch (id) {
      case Block.Lever:
        this.setBlock(hit.x, hit.y, hit.z, id, setOn(meta, !isOn(meta)));
        return true;
      case Block.StoneButton:
      case Block.WoodButton:
        this.redstone.pressButton(this.world, hit.x, hit.y, hit.z);
        return true;
      case Block.Repeater:
        this.setBlock(hit.x, hit.y, hit.z, id, setDelay(meta, getDelay(meta) % 4 + 1));
        return true;
      case Block.Comparator:
        this.setBlock(hit.x, hit.y, hit.z, id, setMode(meta, 1 - getMode(meta)));
        return true;
      case Block.OakDoor:
        this.redstone.toggleDoor(this.world, hit.x, hit.y, hit.z);
        return true;
      case Block.DaylightDetector:
        this.setBlock(hit.x, hit.y, hit.z, id, setDaylightInverted(meta, !isDaylightInverted(meta)));
        return true;
      case Block.TripwireHook: {
        const stack = this.inventory.get(this.selectedSlot);
        if (stack && stack.id === Item.TripwireString) {
          const d = this.eyeDir();
          const ok = this.redstone.tryConnectTripwire(
            this.world, hit.x, hit.y, hit.z,
            this.player.x, this.player.eyeY, this.player.z,
            d.dx, d.dy, d.dz,
          );
          if (ok && !this.modes.isCreative) this.inventory.removeItem(this.selectedSlot, 1);
          this.refreshHud();
          return true;
        }
        return false;
      }
      case Block.NoteBlock: {
        // 1.13: right-click cycles the pitch +1 over the 0..24 range (24→0)
        // AND plays the note at the new pitch.
        const next = (getNotePitch(meta) + 1) % 25;
        this.setBlock(hit.x, hit.y, hit.z, id, setNotePitch(meta, next));
        this.sfx.playNote(next, this.world.getBlock(hit.x, hit.y + 1, hit.z));
        return true;
      }
      case Block.Hopper:
      case Block.Dropper:
      case Block.Dispenser:
        // 1.13 (§8.5): right-click opens the container GUI.
        this.openContainerUI(hit.x, hit.y, hit.z);
        return true;
      default:
        return false;
    }
  }

  /**
   * Right-click place of the currently selected block item (the raycast hit
   * is passed in from onRightClick — Phase 4: no duplicate raycast). Facing
   * blocks (Phase 2C) store a facing meta snapped from the player yaw.
   * Phase 5A: the oak door places BOTH halves (bottom + top) as one item;
   * hoppers/dispensers/droppers get a yaw facing; tripwire hooks face their
   * support block (the hit block).
   */
  private placeTarget(hit: RayHit): void {
    const px = hit.x + hit.nx;
    const py = hit.y + hit.ny;
    const pz = hit.z + hit.nz;
    const stack = this.inventory.get(this.selectedSlot);
    if (!stack || !isPlaceable(stack.id)) return;
    const bid = itemBlockId(stack.id);
    const cur = this.world.getBlock(px, py, pz);
    if (cur !== AIR && cur !== WATER) return;
    // --- Phase 5A: door places both halves (bottom meta 0, top meta top-bit) ---
    if (bid === Block.OakDoor) {
      const topCur = this.world.getBlock(px, py + 1, pz);
      if (topCur !== AIR && topCur !== WATER) return;
      const pabb = this.player.getAABB();
      for (const dy of [0, 1]) {
        const box = { minX: px, minY: py + dy, minZ: pz, maxX: px + 1, maxY: py + dy + 1, maxZ: pz + 1 };
        if (Player.boxesIntersect(pabb, box)) return; // closed door is solid
      }
      this.setBlock(px, py, pz, bid, 0); // bottom: closed, not top
      this.setBlock(px, py + 1, pz, bid, DOOR_TOP_BIT); // top half
      if (!this.modes.isCreative) this.inventory.removeItem(this.selectedSlot, 1);
      this.refreshHud();
      return;
    }
    // never place a solid block into the player's AABB
    if (isSolidBlock(bid)) {
      const box = { minX: px, minY: py, minZ: pz, maxX: px + 1, maxY: py + 1, maxZ: pz + 1 };
      if (Player.boxesIntersect(this.player.getAABB(), box)) return;
    }
    // facing meta for facing blocks (piston, sticky_piston, observer,
    // repeater, comparator; Phase 5A: hopper, dispenser, dropper); redstone
    // torch stores its on-state (its meta is onOff — a facing would clobber
    // the on bit; see memory.md 2C notes). Tripwire hooks face their support
    // block (the opposite of the placement face normal).
    let meta = 0;
    if (
      bid === Block.Piston ||
      bid === Block.StickyPiston ||
      bid === Block.Observer ||
      bid === Block.Repeater ||
      bid === Block.Comparator ||
      bid === Block.Hopper ||
      bid === Block.Dispenser ||
      bid === Block.Dropper
    ) {
      meta = facingFromYaw(this.player.yaw);
    } else if (bid === Block.TripwireHook) {
      const sx = -hit.nx; // support direction = toward the hit block
      const sz = -hit.nz;
      if (sz === 1) meta = Facing.South;
      else if (sx === -1) meta = Facing.West;
      else if (sz === -1) meta = Facing.North;
      else if (sx === 1) meta = Facing.East;
      else meta = Facing.South; // vertical placement: default
    } else if (bid === Block.RedstoneTorch) {
      meta = 1; // placed lit
    }
    this.setBlock(px, py, pz, bid, meta);
    if (!this.modes.isCreative) this.inventory.removeItem(this.selectedSlot, 1);
    this.refreshHud();
  }

  // --- inventory screen (E / Esc) --------------------------------------------

  toggleInventoryUI(): void {
    if (this.inventoryUI.isOpen()) this.closeInventoryUI();
    else this.openInventoryUI();
  }

  private openInventoryUI(): void {
    this.invSelection = -1;
    this.inventoryUI.open();
    this.hotbar.setInteractive(true);
    if (document.pointerLockElement) document.exitPointerLock();
    this.refreshHud();
  }

  private closeInventoryUI(): void {
    this.invSelection = -1;
    this.inventoryUI.close();
    this.hotbar.setInteractive(false);
    try {
      this.canvas.requestPointerLock();
    } catch {
      // pointer lock can be refused right after release; user clicks canvas
    }
    this.refreshHud();
  }

  /** Click on a hotbar/main slot while the inventory screen is open. */
  private onSlotClick(slot: number, shift: boolean): void {
    if (!this.inventoryUI.isOpen()) return;
    if (shift) {
      this.inventory.shiftMove(slot);
    } else if (this.invSelection === -1) {
      if (this.inventory.get(slot)) this.invSelection = slot;
    } else if (this.invSelection === slot) {
      this.invSelection = -1;
    } else {
      this.inventory.moveBetweenSlots(this.invSelection, slot);
      this.invSelection = -1;
    }
    this.refreshHud();
  }

  // --- container GUI (E / Esc, Phase 5B §8.5) --------------------------------

  /** Right-click a hopper/dropper/dispenser: open its content GUI. */
  private openContainerUI(x: number, y: number, z: number): void {
    if (this.inventoryUI.isOpen() || !this.redstone.getContainerSlots(x, y, z)) return;
    this.containerPos = { x, y, z };
    this.containerSelection = -1;
    this.containerUI.open(this.redstone.containerSlotCount(x, y, z));
    this.hotbar.setInteractive(false);
    if (document.pointerLockElement) document.exitPointerLock();
    this.refreshHud();
  }

  private closeContainerUI(): void {
    if (!this.containerPos) return;
    this.containerPos = null;
    this.containerSelection = -1;
    this.containerUI.close();
    try {
      this.canvas.requestPointerLock();
    } catch {
      // pointer lock can be refused right after release; user clicks canvas
    }
    this.refreshHud();
  }

  /**
   * Click on a container GUI slot. Global index space: 0..N-1 = the container's
   * slots, N..N+35 = the player's main storage (inventory slots 9..44; the
   * hotbar is shown separately). Supports pick-up, move/swap/merge (both
   * directions) and shift-move between the two.
   */
  private onContainerSlotClick(slot: number, shift: boolean): void {
    const pos = this.containerPos;
    if (!pos) return;
    const N = this.redstone.containerSlotCount(pos.x, pos.y, pos.z);
    const cont = this.redstone.getContainerSlots(pos.x, pos.y, pos.z);
    if (!cont) return;
    const MAIN = SLOT_COUNT - HOTBAR_SIZE; // 36 main-storage slots
    const playerIdx = (g: number) => g - N + HOTBAR_SIZE; // global → inventory slot
    const getStack = (g: number): ItemStack | null => (g < N ? cont[g] : this.inventory.get(playerIdx(g)));
    const setStack = (g: number, s: ItemStack | null): void => {
      if (g < N) cont[g] = s;
      else this.inventory.set(playerIdx(g), s);
    };
    if (shift) {
      const a = getStack(slot);
      if (!a) return;
      // merge `a` into the opposite side (container → player, player → container)
      const toPlayer = slot < N;
      const start = toPlayer ? N : 0;
      const end = toPlayer ? N + MAIN : N;
      let remaining = a.count;
      for (let i = start; i < end && remaining > 0; i++) {
        const t = getStack(i);
        if (t && t.id === a.id && t.count < MAX_STACK) {
          const take = Math.min(MAX_STACK - t.count, remaining);
          t.count += take;
          remaining -= take;
        }
      }
      for (let i = start; i < end && remaining > 0; i++) {
        if (!getStack(i)) {
          setStack(i, { id: a.id, count: remaining });
          remaining = 0;
          break;
        }
      }
      if (remaining < a.count) setStack(slot, null);
    } else if (this.containerSelection === -1) {
      if (getStack(slot)) this.containerSelection = slot;
    } else if (this.containerSelection === slot) {
      this.containerSelection = -1;
    } else {
      const a = getStack(this.containerSelection);
      const b = getStack(slot);
      if (a) {
        if (!b) {
          setStack(slot, a);
          setStack(this.containerSelection, null);
        } else if (b.id === a.id && a.count + b.count <= MAX_STACK) {
          b.count += a.count;
          setStack(this.containerSelection, null);
        } else {
          setStack(slot, a);
          setStack(this.containerSelection, b);
        }
      }
      this.containerSelection = -1;
    }
    this.refreshHud();
  }

  /**
   * Phase 5B: a brief full-screen white flash for TNT explosions. UI-only — a
   * CSS-transition div on the HUD root that fades out (intensity 0..1 scales
   * by distance). No effect on game logic.
   */
  private flash(intensity: number): void {
    if (typeof document === 'undefined' || intensity <= 0) return;
    const root = document.getElementById('hud') ?? document.body;
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;inset:0;background:#fff;opacity:${Math.min(1, intensity).toFixed(3)};pointer-events:none;transition:opacity 0.3s ease-out;z-index:9999;`;
    root.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '0';
    });
    setTimeout(() => {
      root.removeChild(el);
    }, 350);
  }

  // --- extra input (mining hold, double-Space fly, inventory, SFX unlock) -----

  private onKeyDownExtra = (e: KeyboardEvent): void => {
    this.sfx.ensure();
    if (e.repeat) return;
    if (e.code === 'KeyE') {
      // Phase 5B: E toggles the container GUI when it is open, else the inventory.
      if (this.containerUI.isOpen()) this.closeContainerUI();
      else this.toggleInventoryUI();
      return;
    }
    if (e.code === 'Escape') {
      if (this.containerUI.isOpen()) this.closeContainerUI();
      else if (this.inventoryUI.isOpen()) this.closeInventoryUI();
      return;
    }
    if (e.code === 'Space' && this.input.locked && this.modes.isCreative) {
      if (this.spaceTracker.press(performance.now())) this.toggleFly();
    }
  };

  private onKeyUpExtra = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.spaceTracker.reset();
  };

  private onMouseDownExtra = (e: MouseEvent): void => {
    this.sfx.ensure();
    if (e.button === 0 && this.input.locked) this.leftDown = true;
  };

  private onMouseUpExtra = (e: MouseEvent): void => {
    if (e.button === 0) this.leftDown = false;
  };

  // --- world edits -------------------------------------------------------------

  /**
   * Set a block (Phase 5A: routed through Redstone.worldEdit so the
   * redstone registry and tripwire strings stay in sync with every player
   * world edit — mining a hook or placing a block on a string clears it).
   */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    this.redstone.worldEdit(this.world, x, y, z, id, meta);
  }

  // --- HUD ----------------------------------------------------------------------

  private refreshHud(): void {
    this.hotbar.update(this.inventory, this.selectedSlot);
    this.inventoryUI.update(this.inventory, this.invSelection);
    if (this.containerPos) {
      this.containerUI.update(this.redstone.getContainerSlots(this.containerPos.x, this.containerPos.y, this.containerPos.z), this.inventory, this.containerSelection);
    }
    this.status.update(this.vitals.hp, this.vitals.hunger, !this.modes.isCreative);
    this.debug.update({
      x: this.player.x,
      y: this.player.y,
      z: this.player.z,
      facing: facingName(this.player.yaw),
      chunkX: Math.floor(this.player.x / CHUNK_SIZE_X),
      chunkZ: Math.floor(this.player.z / CHUNK_SIZE_Z),
      fps: this.fps,
      mode: this.mode,
      seed: this.world.seed,
    });
    this.hud.update(this.hudText());
  }

  private hudText(): string {
    const p = this.player;
    const stack = this.inventory.get(this.selectedSlot);
    const sel = stack ? blockName(stack.id) : 'air';
    const lines = [
      `x: ${p.x.toFixed(1)}  y: ${p.y.toFixed(1)}  z: ${p.z.toFixed(1)}`,
      `mode: ${this.mode}   selected: ${sel}`,
    ];
    if (this.f3) {
      lines.push(`chunk: ${Math.floor(p.x / CHUNK_SIZE_X)},${Math.floor(p.z / CHUNK_SIZE_Z)}   fps: ${this.fps.toFixed(0)}`);
      lines.push(`meshed chunks: ${this.renderer.meshedChunkCount}   seed: ${this.world.seed}`);
    }
    return lines.join('\n');
  }
}
