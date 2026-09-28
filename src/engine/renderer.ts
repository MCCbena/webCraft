/**
 * WebCraft — Renderer (Phase 1, [core]).
 * three.js scene, procedural canvas texture atlas (16x16 tiles), per-chunk
 * meshes (opaque + transparent water), render distance ±3 chunks,
 * dirty-chunk remeshing driven by World.drainDirty().
 *
 * This is the ONLY place three.js is imported (mesher stays pure TS).
 */

import * as THREE from 'three';
import { buildChunkMeshData } from '../world/mesher';
import type { FaceData } from '../world/mesher';
import { World } from '../world/world';
import type { Player } from '../player/player';
import { Tile } from '../world/blocks';

export const RENDER_DISTANCE = 3; // ±3 chunks (7x7 = 49 chunks)

type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Procedural texture atlas
// ---------------------------------------------------------------------------

function paintNoise(ctx: CanvasRenderingContext2D, tile: number, base: RGB, variance = 18, alpha = 1): void {
  const x0 = (tile % 16) * 16;
  const y0 = Math.floor(tile / 16) * 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (Math.sin((x * 37 + y * 91 + tile * 53) * 12.9898) * 43758.5453) % 1;
      const j = (v - 0.5) * 2 * variance;
      ctx.fillStyle = `rgba(${Math.max(0, Math.min(255, base[0] + j)) | 0},${Math.max(0, Math.min(255, base[1] + j)) | 0},${Math.max(0, Math.min(255, base[2] + j)) | 0},${alpha})`;
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
  }
}

function speckle(ctx: CanvasRenderingContext2D, tile: number, color: RGB, count: number, size = 2, seed = 1): void {
  const x0 = (tile % 16) * 16;
  const y0 = Math.floor(tile / 16) * 16;
  let s = seed * 7919 + tile * 104729;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  for (let i = 0; i < count; i++) {
    const x = x0 + Math.floor(rnd() * 14);
    const y = y0 + Math.floor(rnd() * 14);
    ctx.fillRect(x, y, size, size);
  }
}

function createAtlasTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // simple terrain
  paintNoise(ctx, Tile.Stone, [125, 125, 125], 14);
  paintNoise(ctx, Tile.GrassTop, [106, 170, 64], 20);
  paintNoise(ctx, Tile.GrassSide, [134, 96, 67], 16);
  ctx.fillStyle = 'rgb(106,170,64)';
  ctx.fillRect((Tile.GrassSide % 16) * 16, Math.floor(Tile.GrassSide / 16) * 16, 16, 4);
  paintNoise(ctx, Tile.Dirt, [134, 96, 67], 16);
  paintNoise(ctx, Tile.Sand, [219, 207, 163], 12);
  paintNoise(ctx, Tile.Gravel, [136, 136, 136], 24);
  paintNoise(ctx, Tile.LogSide, [102, 81, 50], 10);
  ctx.fillStyle = 'rgba(70,54,30,0.8)';
  for (let x = 2; x < 16; x += 4) ctx.fillRect((Tile.LogSide % 16) * 16 + x, Math.floor(Tile.LogSide / 16) * 16, 1, 16);
  paintNoise(ctx, Tile.LogTop, [150, 122, 78], 8);
  ctx.strokeStyle = 'rgba(102,81,50,0.9)';
  ctx.strokeRect((Tile.LogTop % 16) * 16 + 3.5, Math.floor(Tile.LogTop / 16) * 16 + 3.5, 9, 9);
  ctx.strokeRect((Tile.LogTop % 16) * 16 + 6.5, Math.floor(Tile.LogTop / 16) * 16 + 6.5, 3, 3);
  paintNoise(ctx, Tile.Leaves, [58, 138, 58], 26, 0.95);
  ctx.clearRect((Tile.Leaves % 16) * 16 + 3, Math.floor(Tile.Leaves / 16) * 16 + 5, 2, 2);
  ctx.clearRect((Tile.Leaves % 16) * 16 + 10, Math.floor(Tile.Leaves / 16) * 16 + 9, 2, 2);
  ctx.clearRect((Tile.Leaves % 16) * 16 + 6, Math.floor(Tile.Leaves / 16) * 16 + 12, 1, 1);
  paintNoise(ctx, Tile.Planks, [162, 130, 78], 10);
  ctx.fillStyle = 'rgba(90,68,38,0.7)';
  const py = Math.floor(Tile.Planks / 16) * 16;
  ctx.fillRect((Tile.Planks % 16) * 16, py + 3, 16, 1);
  ctx.fillRect((Tile.Planks % 16) * 16, py + 11, 16, 1);
  paintNoise(ctx, Tile.Cobblestone, [125, 125, 125], 22);
  speckle(ctx, Tile.Cobblestone, [95, 95, 95], 6, 3, 2);
  paintNoise(ctx, Tile.Glass, [210, 235, 255], 0, 0.18);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeRect((Tile.Glass % 16) * 16 + 0.5, Math.floor(Tile.Glass / 16) * 16 + 0.5, 15, 15);
  paintNoise(ctx, Tile.Water, [47, 93, 197], 14, 0.9);
  paintNoise(ctx, Tile.Bedrock, [55, 55, 55], 34);
  paintNoise(ctx, Tile.Clay, [151, 155, 165], 8);
  paintNoise(ctx, Tile.Snow, [240, 248, 255], 6);
  // ores: stone base + speckles
  for (const [tile, color] of [
    [Tile.CoalOre, [30, 30, 30]],
    [Tile.IronOre, [216, 175, 147]],
    [Tile.RedstoneOre, [186, 41, 41]],
  ] as [number, RGB][]) {
    paintNoise(ctx, tile, [125, 125, 125], 14);
    speckle(ctx, tile, color, 7, 2, 3);
  }
  // redstone components
  paintNoise(ctx, Tile.RedstoneDust, [45, 40, 40], 8);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect((Tile.RedstoneDust % 16) * 16 + 4, Math.floor(Tile.RedstoneDust / 16) * 16 + 6, 8, 4);
  paintNoise(ctx, Tile.RedstoneTorchOn, [60, 50, 40], 10);
  ctx.fillStyle = 'rgb(230,40,40)';
  ctx.fillRect((Tile.RedstoneTorchOn % 16) * 16 + 6, Math.floor(Tile.RedstoneTorchOn / 16) * 16 + 2, 4, 4);
  paintNoise(ctx, Tile.RedstoneTorchOff, [60, 50, 40], 10);
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillRect((Tile.RedstoneTorchOff % 16) * 16 + 6, Math.floor(Tile.RedstoneTorchOff / 16) * 16 + 2, 4, 4);
  paintNoise(ctx, Tile.RedstoneBlock, [155, 31, 31], 16);
  paintNoise(ctx, Tile.RedstoneLampOff, [122, 112, 92], 10);
  paintNoise(ctx, Tile.RedstoneLampLit, [255, 190, 60], 16);
  paintNoise(ctx, Tile.Repeater, [120, 100, 80], 10);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect((Tile.Repeater % 16) * 16 + 2, Math.floor(Tile.Repeater / 16) * 16 + 2, 12, 12);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect((Tile.Repeater % 16) * 16 + 6, Math.floor(Tile.Repeater / 16) * 16 + 6, 4, 4);
  paintNoise(ctx, Tile.RepeaterOn, [120, 100, 80], 10);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect((Tile.RepeaterOn % 16) * 16 + 2, Math.floor(Tile.RepeaterOn / 16) * 16 + 2, 12, 12);
  ctx.fillStyle = 'rgb(40,200,80)';
  ctx.fillRect((Tile.RepeaterOn % 16) * 16 + 6, Math.floor(Tile.RepeaterOn / 16) * 16 + 6, 4, 4);
  paintNoise(ctx, Tile.Comparator, [150, 125, 85], 10);
  ctx.fillStyle = 'rgb(190,30,30)';
  ctx.fillRect((Tile.Comparator % 16) * 16 + 6, Math.floor(Tile.Comparator / 16) * 16 + 5, 4, 6);
  paintNoise(ctx, Tile.PistonSide, [165, 165, 165], 10);
  paintNoise(ctx, Tile.PistonBase, [125, 125, 125], 14);
  ctx.fillStyle = 'rgb(160,160,160)';
  ctx.fillRect((Tile.PistonBase % 16) * 16 + 3, Math.floor(Tile.PistonBase / 16) * 16 + 3, 10, 10);
  paintNoise(ctx, Tile.PistonHead, [140, 118, 80], 10);
  paintNoise(ctx, Tile.StickyPistonSide, [165, 165, 165], 10);
  ctx.fillStyle = 'rgba(80,180,80,0.5)';
  ctx.fillRect((Tile.StickyPistonSide % 16) * 16, Math.floor(Tile.StickyPistonSide / 16) * 16, 16, 16);
  paintNoise(ctx, Tile.StickyPistonHead, [140, 118, 80], 10);
  ctx.fillStyle = 'rgba(80,180,80,0.5)';
  ctx.fillRect((Tile.StickyPistonHead % 16) * 16, Math.floor(Tile.StickyPistonHead / 16) * 16, 16, 16);
  paintNoise(ctx, Tile.ObserverSide, [130, 130, 130], 12);
  paintNoise(ctx, Tile.ObserverFront, [160, 160, 160], 8);
  ctx.fillStyle = 'rgb(40,40,40)';
  const oy = Math.floor(Tile.ObserverFront / 16) * 16;
  ctx.fillRect((Tile.ObserverFront % 16) * 16 + 3, oy + 4, 3, 3);
  ctx.fillRect((Tile.ObserverFront % 16) * 16 + 10, oy + 4, 3, 3);
  paintNoise(ctx, Tile.ObserverBack, [110, 110, 110], 12);
  paintNoise(ctx, Tile.LeverBase, [125, 125, 125], 14);
  ctx.fillStyle = 'rgb(162,130,78)';
  ctx.fillRect((Tile.LeverBase % 16) * 16 + 7, Math.floor(Tile.LeverBase / 16) * 16 + 4, 2, 8);
  paintNoise(ctx, Tile.ButtonCobble, [125, 125, 125], 18);
  paintNoise(ctx, Tile.ButtonWood, [162, 130, 78], 10);
  paintNoise(ctx, Tile.PlateCobble, [125, 125, 125], 18);
  paintNoise(ctx, Tile.PlateWood, [162, 130, 78], 10);
  paintNoise(ctx, Tile.TripwireHook, [162, 130, 78], 10);
  paintNoise(ctx, Tile.DispenserSide, [130, 100, 70], 12);
  ctx.fillStyle = 'rgb(90,90,90)';
  ctx.fillRect((Tile.DispenserSide % 16) * 16, Math.floor(Tile.DispenserSide / 16) * 16, 2, 2);
  ctx.fillRect((Tile.DispenserSide % 16) * 16 + 14, Math.floor(Tile.DispenserSide / 16) * 16, 2, 2);
  paintNoise(ctx, Tile.DispenserFront, [130, 100, 70], 12);
  ctx.fillStyle = 'rgb(40,30,20)';
  ctx.beginPath();
  ctx.arc((Tile.DispenserFront % 16) * 16 + 8, Math.floor(Tile.DispenserFront / 16) * 16 + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  paintNoise(ctx, Tile.DropperSide, [150, 150, 150], 10);
  paintNoise(ctx, Tile.DropperFront, [150, 150, 150], 10);
  ctx.fillStyle = 'rgb(70,70,70)';
  ctx.beginPath();
  ctx.arc((Tile.DropperFront % 16) * 16 + 8, Math.floor(Tile.DropperFront / 16) * 16 + 8, 3, 0, Math.PI * 2);
  ctx.fill();
  paintNoise(ctx, Tile.Torch, [60, 50, 40], 10);
  ctx.fillStyle = 'rgb(255,210,80)';
  ctx.fillRect((Tile.Torch % 16) * 16 + 6, Math.floor(Tile.Torch / 16) * 16 + 2, 4, 4);
  paintNoise(ctx, Tile.OakDoor, [162, 130, 78], 10);
  ctx.strokeStyle = 'rgba(90,68,38,0.8)';
  ctx.strokeRect((Tile.OakDoor % 16) * 16 + 1.5, Math.floor(Tile.OakDoor / 16) * 16 + 1.5, 13, 13);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface ChunkMeshes {
  opaque: THREE.Mesh | null;
  water: THREE.Mesh | null;
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly group = new THREE.Group();
  private readonly meshes = new Map<number, ChunkMeshes>();
  private readonly opaqueMat: THREE.MeshLambertMaterial;
  private readonly waterMat: THREE.MeshLambertMaterial;
  private readonly world: World;

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.world = world;
    this.three = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const sky = new THREE.Color(0x87ceeb);
    this.scene = new THREE.Scene();
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 48, 110);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 400);
    this.camera.rotation.order = 'YXZ';

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(120, 220, 80);
    this.scene.add(ambient, sun, this.group);

    const atlas = createAtlasTexture();
    this.opaqueMat = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true });
    this.waterMat = new THREE.MeshLambertMaterial({
      map: atlas,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    for (const k of [...this.meshes.keys()]) this.disposeChunk(k);
    this.opaqueMat.map?.dispose();
    this.opaqueMat.dispose();
    this.waterMat.dispose();
    this.three.dispose();
  }

  private resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.three.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private key(cx: number, cz: number): number {
    return (cx + 8) * 16 + (cz + 8);
  }

  private static toGeometry(fd: FaceData): THREE.BufferGeometry | null {
    if (fd.positions.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fd.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(fd.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(fd.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(fd.colors, 3));
    g.setIndex(fd.indices);
    return g;
  }

  private buildChunk(cx: number, cz: number): void {
    const chunk = this.world.ensureChunk(cx, cz);
    if (!chunk) return;
    const blockAt = (x: number, y: number, z: number): number => this.world.getBlock(x, y, z);
    const data = buildChunkMeshData(chunk, cx, cz, blockAt);
    const entry: ChunkMeshes = { opaque: null, water: null };
    const og = Renderer.toGeometry(data.opaque);
    if (og) {
      entry.opaque = new THREE.Mesh(og, this.opaqueMat);
      this.group.add(entry.opaque);
    }
    const wg = Renderer.toGeometry(data.water);
    if (wg) {
      entry.water = new THREE.Mesh(wg, this.waterMat);
      this.group.add(entry.water);
    }
    this.meshes.set(this.key(cx, cz), entry);
  }

  private disposeChunk(key: number): void {
    const e = this.meshes.get(key);
    if (!e) return;
    for (const m of [e.opaque, e.water]) {
      if (m) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.meshes.delete(key);
  }

  /**
   * Per-frame update:
   *  - (re)mesh dirty chunks from World.drainDirty()
   *  - ensure ±RENDER_DISTANCE chunks around the player are meshed
   *  - drop meshes outside the render distance
   */
  update(player: Player): void {
    for (const { cx, cz } of this.world.drainDirty()) {
      const k = this.key(cx, cz);
      if (this.meshes.has(k)) {
        this.disposeChunk(k);
        this.buildChunk(cx, cz);
      }
    }

    const pcx = Math.floor(player.x / 16);
    const pcz = Math.floor(player.z / 16);
    const needed = new Set<number>();
    for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
      for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!this.world.inChunkRange(cx, cz)) continue;
        const k = this.key(cx, cz);
        needed.add(k);
        if (!this.meshes.has(k)) this.buildChunk(cx, cz);
      }
    }
    for (const k of [...this.meshes.keys()]) {
      if (!needed.has(k)) this.disposeChunk(k);
    }
  }

  render(player: Player): void {
    this.camera.position.set(player.x, player.eyeY, player.z);
    this.camera.rotation.y = player.yaw;
    this.camera.rotation.x = player.pitch;
    this.three.render(this.scene, this.camera);
  }

  get meshedChunkCount(): number {
    return this.meshes.size;
  }
}
