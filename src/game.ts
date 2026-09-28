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
import { Player } from './player/player';
import { stepPlayer, GRAVITY } from './player/physics';
import { Hud } from './ui/hud';
import {
  AIR,
  WATER,
  Block,
  Item,
  getBlockDef,
  getDelay,
  getMode,
  isOn,
  isPlaceable,
  isSolidBlock,
  itemBlockId,
  blockName,
  getItemDef,
  setDelay,
  setMode,
  setOn,
} from './world/blocks';
import { Redstone } from './redstone/tick';
import { facingFromYaw, type RedstoneCtx } from './redstone/types';
import { Inventory } from './player/inventory';
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
import { DebugPanel, facingName } from './ui/debug';

export const REACH = 6.0; // eye reach, design.md §7

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
  readonly debug: DebugPanel;
  readonly mineBar: MineBar;
  readonly redstone = new Redstone();
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
    this.debug = new DebugPanel(hudRoot);
    this.mineBar = new MineBar(hudRoot);
    this.inventoryUI.onSlotClick = (i, shift) => this.onSlotClick(i, shift);
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
    stepPlayer(p, input, (x, y, z) => this.world.getBlock(x, y, z), TICK_DT);
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
    this.fallTracker.update(p.y, p.vy, p.onGround);
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
    const headInWater = this.world.getBlock(Math.floor(p.x), Math.floor(p.y + 1.5), Math.floor(p.z)) === WATER;
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
   * component tick. `entityAbove` reports the player AABB overlap for
   * pressure plates; player position bounds the active-redstone region.
   */
  tickRedstone(): void {
    const p = this.player;
    const ctx: RedstoneCtx = {
      playerX: p.x,
      playerY: p.y,
      playerZ: p.z,
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
      const sens = 0.0022;
      this.player.yaw -= dx * sens;
      this.player.pitch -= dy * sens;
      const lim = Math.PI / 2 - 0.01;
      this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
    }
    if (this.input.consumeLeft()) this.onLeftClick();
    if (this.input.consumeRight()) this.onRightClick();

    const now = performance.now();
    const dtf = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dtf > 0) this.fpsSmooth = this.fpsSmooth * 0.95 + (1 / dtf) * 0.05;
    this.fps = this.fpsSmooth;
    const dt = Math.min(Math.max(dtf, 0), 0.1); // clamp for stable mining progress

    this.tickMining(dt);
    this.refreshHud();

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
    this.setBlock(x, y, z, AIR);
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
    this.placeTarget();
    if (this.world.getBlock(px, py, pz) !== before) this.sfx.play('place');
  }

  /**
   * Right-click component interactions (Phase 2C): lever toggle, button
   * press, repeater delay cycle (1→2→3→4→1), comparator mode toggle.
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
      default:
        return false;
    }
  }

  /**
   * Right-click place of the currently selected block item. Facing blocks
   * (Phase 2C) store a facing meta snapped from the player yaw.
   */
  private placeTarget(): void {
    const hit = this.targetBlock();
    if (!hit) return;
    const px = hit.x + hit.nx;
    const py = hit.y + hit.ny;
    const pz = hit.z + hit.nz;
    const stack = this.inventory.get(this.selectedSlot);
    if (!stack || !isPlaceable(stack.id)) return;
    const bid = itemBlockId(stack.id);
    const cur = this.world.getBlock(px, py, pz);
    if (cur !== AIR && cur !== WATER) return;
    // never place a solid block into the player's AABB
    if (isSolidBlock(bid)) {
      const box = { minX: px, minY: py, minZ: pz, maxX: px + 1, maxY: py + 1, maxZ: pz + 1 };
      if (Player.boxesIntersect(this.player.getAABB(), box)) return;
    }
    // facing meta for facing blocks (piston, sticky_piston, observer,
    // repeater, comparator); redstone torch stores its on-state (its meta
    // is onOff — a facing would clobber the on bit; see memory.md 2C notes).
    let meta = 0;
    if (
      bid === Block.Piston ||
      bid === Block.StickyPiston ||
      bid === Block.Observer ||
      bid === Block.Repeater ||
      bid === Block.Comparator
    ) {
      meta = facingFromYaw(this.player.yaw);
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

  // --- extra input (mining hold, double-Space fly, inventory, SFX unlock) -----

  private onKeyDownExtra = (e: KeyboardEvent): void => {
    this.sfx.ensure();
    if (e.repeat) return;
    if (e.code === 'KeyE') this.toggleInventoryUI();
    if (e.code === 'Escape' && this.inventoryUI.isOpen()) this.closeInventoryUI();
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

  /** Set a block and mark this chunk (plus neighbors on borders) for remesh. */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    this.world.setBlock(x, y, z, id, meta);
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const lx = x - cx * 16;
    const lz = z - cz * 16;
    const onBorder = lx === 0 || lx === 15 || lz === 0 || lz === 15;
    this.world.markDirty(cx, cz, onBorder);
  }

  // --- HUD ----------------------------------------------------------------------

  private refreshHud(): void {
    this.hotbar.update(this.inventory, this.selectedSlot);
    this.inventoryUI.update(this.inventory, this.invSelection);
    this.status.update(this.vitals.hp, this.vitals.hunger, !this.modes.isCreative);
    this.debug.update({
      x: this.player.x,
      y: this.player.y,
      z: this.player.z,
      facing: facingName(this.player.yaw),
      chunkX: Math.floor(this.player.x / 16),
      chunkZ: Math.floor(this.player.z / 16),
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
      lines.push(`chunk: ${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}   fps: ${this.fps.toFixed(0)}`);
      lines.push(`meshed chunks: ${this.renderer.meshedChunkCount}   seed: ${this.world.seed}`);
    }
    return lines.join('\n');
  }
}
