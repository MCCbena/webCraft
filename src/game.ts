/**
 * WebCraft — Game orchestrator (Phase 1, [core]).
 * Wires World + Player + Renderer + Input + Loop + HUD together.
 *
 * tick() runs at fixed 20 TPS. The redstone module (Phase 2C) plugs into
 * tickRedstone() — currently a stub.
 */

import { Renderer } from './engine/renderer';
import { GameLoop, TICK_DT } from './engine/loop';
import { Input } from './engine/input';
import { World } from './world/world';
import { Player } from './player/player';
import { stepPlayer } from './player/physics';
import { Hud } from './ui/hud';
import { AIR, WATER, Block, getBlockDef, isPlaceable, isSolidBlock, itemBlockId, blockName } from './world/blocks';

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

export type GameMode = 'survival' | 'creative';

export class Game {
  readonly world: World;
  readonly player: Player;
  readonly renderer: Renderer;
  readonly input: Input;
  readonly hud: Hud;
  readonly loop: GameLoop;
  mode: GameMode = 'survival';
  selectedSlot = 0;
  /** minimal Phase 1 hotbar: item ids (Phase 2B replaces with inventory.ts) */
  readonly slots: number[];
  fps = 60;
  ready = false;
  onReady?: () => void;

  private f3 = false;
  private lastFrame = performance.now();
  private fpsSmooth = 60;

  constructor(canvas: HTMLCanvasElement, seed?: number) {
    this.world = new World(seed);
    const spawn = this.world.findSpawn();
    this.player = new Player(spawn.x, spawn.y, spawn.z);
    this.renderer = new Renderer(canvas, this.world);
    const hudEl = document.getElementById('hud');
    this.hud = new Hud(hudEl ?? document.body);
    this.slots = [Block.Stone, Block.Dirt, Block.Grass, Block.Sand, Block.Log, Block.Planks, Block.Glass, Block.Cobblestone, Block.Torch];
    this.input = new Input(canvas, {
      onSlot: (i) => {
        this.selectedSlot = i;
      },
      onScroll: (d) => {
        this.selectedSlot = (this.selectedSlot + d + this.slots.length) % this.slots.length;
      },
      onF3: () => {
        this.f3 = !this.f3;
      },
      onMode: () => this.toggleMode(),
    });
    this.input.attach();
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
    this.renderer.dispose();
  }

  toggleMode(): void {
    this.mode = this.mode === 'survival' ? 'creative' : 'survival';
  }

  /** Fixed 20 TPS simulation tick. */
  tick(): void {
    const input = {
      forward: this.input.isDown('KeyW'),
      back: this.input.isDown('KeyS'),
      left: this.input.isDown('KeyA'),
      right: this.input.isDown('KeyD'),
      jump: this.input.isDown('Space'),
    };
    stepPlayer(this.player, input, (x, y, z) => this.world.getBlock(x, y, z), TICK_DT);
    this.tickRedstone();
  }

  /**
   * EXTENSION POINT for Phase 2C (redstone, 20 TPS, synchronous):
   * call the redstone network/component tick here.
   */
  tickRedstone(): void {
    // stub — Phase 2C fills this in
  }

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
    if (this.input.consumeLeft()) this.breakTarget();
    if (this.input.consumeRight()) this.placeTarget();

    this.renderer.update(this.player);
    this.renderer.render(this.player);

    const now = performance.now();
    const dtf = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dtf > 0) this.fpsSmooth = this.fpsSmooth * 0.95 + (1 / dtf) * 0.05;
    this.fps = this.fpsSmooth;

    this.hud.update(this.hudText());

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

  /** Phase 1: instant break (hardness timing comes in Phase 2B). */
  private breakTarget(): void {
    const hit = this.targetBlock();
    if (!hit) return;
    const def = getBlockDef(this.world.getBlock(hit.x, hit.y, hit.z));
    if (def.hardness < 0) return; // unbreakable
    this.setBlock(hit.x, hit.y, hit.z, AIR);
  }

  /** Right-click place of the currently selected block item. */
  private placeTarget(): void {
    const hit = this.targetBlock();
    if (!hit) return;
    const px = hit.x + hit.nx;
    const py = hit.y + hit.ny;
    const pz = hit.z + hit.nz;
    const item = this.slots[this.selectedSlot];
    if (!isPlaceable(item)) return;
    const bid = itemBlockId(item);
    const cur = this.world.getBlock(px, py, pz);
    if (cur !== AIR && cur !== WATER) return;
    // never place a solid block into the player's AABB
    if (isSolidBlock(bid)) {
      const box = { minX: px, minY: py, minZ: pz, maxX: px + 1, maxY: py + 1, maxZ: pz + 1 };
      if (Player.boxesIntersect(this.player.getAABB(), box)) return;
    }
    this.setBlock(px, py, pz, bid);
  }

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

  private hudText(): string {
    const p = this.player;
    const sel = blockName(this.slots[this.selectedSlot]);
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
