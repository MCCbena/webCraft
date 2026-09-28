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
import { paintAtlas, ATLAS_SIZE } from './atlas';

export const RENDER_DISTANCE = 3; // ±3 chunks (7x7 = 49 chunks)

// ---------------------------------------------------------------------------
// Procedural texture atlas (shared painter in ./atlas — Phase 3 DRY refactor)
// ---------------------------------------------------------------------------

function createAtlasTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d')!;
  paintAtlas(ctx);

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
