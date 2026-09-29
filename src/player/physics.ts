/**
 * WebCraft — Player physics (Phase 1, [core]).
 * Pure TS. Fixed-step integration (called at 20 TPS from the game loop).
 *
 * - WASD movement relative to camera yaw, exponential friction/accel
 * - gravity + jump; water slowdown (reduced speed + buoyancy)
 * - axis-separated AABB collision resolution against solid blocks
 * - world bounds clamp (the 256x256 world has hard edges)
 */

import { PLAYER_WIDTH, PLAYER_HEIGHT, Player, blockAABB } from './player';
import type { AABB } from './player';
import { isSolidBlockAt, WATER } from '../world/blocks';
import { WORLD_MIN_X, WORLD_MIN_Z, WORLD_SIZE_X, WORLD_SIZE_Z, WORLD_MAX_Y } from '../world/world';

/**
 * Phase 5A: the physics block probe returns id AND meta so solidity can be
 * meta-aware (a closed oak door is solid; an open one is not — see
 * blocks.isSolidBlockAt). Callers pass e.g.
 *   (x, y, z) => ({ id: world.getBlock(x, y, z), meta: world.getMeta(x, y, z) })
 */
export type BlockProbe = (x: number, y: number, z: number) => { id: number; meta: number };

export const GRAVITY = 30; // blocks/s^2
export const JUMP_VELOCITY = 8.5; // ~1.2 block jump
export const WALK_SPEED = 4.3; // blocks/s
export const WATER_SPEED = 2.4;
export const WATER_GRAVITY = 8;
export const WATER_FALL_LIMIT = -3;
export const WATER_JUMP_VELOCITY = 9; // full-strength kick while holding jump in water (9^2/(2*30) = 1.35 blocks: clears a 1-block bank); set every tick, so holding jump also swims to the surface
const GROUND_ACCEL = 12; // velocity lerp rate (1/s)
const AIR_ACCEL = 2.5;
const WATER_ACCEL = 5;
const EPS = 0.001;

export interface MoveInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

export function emptyInput(): MoveInput {
  return { forward: false, back: false, left: false, right: false, jump: false };
}

/** Does the AABB overlap any solid block? */
export function aabbHitsSolid(aabb: AABB, getBlock: BlockProbe): boolean {
  const x0 = Math.floor(aabb.minX);
  const x1 = Math.floor(aabb.maxX - EPS);
  const y0 = Math.floor(aabb.minY);
  const y1 = Math.floor(aabb.maxY - EPS);
  const z0 = Math.floor(aabb.minZ);
  const z1 = Math.floor(aabb.maxZ - EPS);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const b = getBlock(x, y, z);
        if (isSolidBlockAt(b.id, b.meta)) return true;
      }
    }
  }
  return false;
}

/** Advance the player by one fixed tick (dt in seconds, normally 0.05). */
export function stepPlayer(p: Player, input: MoveInput, getBlock: BlockProbe, dt: number): void {
  // --- environment ---
  const body = getBlock(Math.floor(p.x), Math.floor(p.y + 0.4), Math.floor(p.z));
  p.inWater = body.id === WATER;

  // --- horizontal wish direction (camera-relative) ---
  const sin = Math.sin(p.yaw);
  const cos = Math.cos(p.yaw);
  // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
  let wx = 0;
  let wz = 0;
  if (input.forward) {
    wx -= sin;
    wz -= cos;
  }
  if (input.back) {
    wx += sin;
    wz += cos;
  }
  if (input.right) {
    wx += cos;
    wz -= sin;
  }
  if (input.left) {
    wx -= cos;
    wz += sin;
  }

  let targetSpeed = WALK_SPEED;
  let accel = p.onGround ? GROUND_ACCEL : AIR_ACCEL;
  if (p.inWater) {
    targetSpeed = WATER_SPEED;
    accel = WATER_ACCEL;
  }
  const len = Math.hypot(wx, wz);
  if (len > 0) {
    wx = (wx / len) * targetSpeed;
    wz = (wz / len) * targetSpeed;
  } else {
    wx = 0;
    wz = 0;
  }
  const t = 1 - Math.exp(-accel * dt);
  p.vx += (wx - p.vx) * t;
  p.vz += (wz - p.vz) * t;

  // --- vertical (onGround from the previous tick is used for the jump) ---
  if (p.inWater) {
    p.vy -= WATER_GRAVITY * dt;
    if (p.vy < WATER_FALL_LIMIT) p.vy = WATER_FALL_LIMIT;
    if (input.jump) p.vy = WATER_JUMP_VELOCITY;
  } else {
    p.vy -= GRAVITY * dt;
    if (input.jump && p.onGround) {
      p.vy = JUMP_VELOCITY;
    }
  }
  p.onGround = false; // re-set by collision resolution below

  // --- integrate with per-axis collision ---
  moveAxis(p, 'x', p.vx * dt, getBlock);
  moveAxis(p, 'y', p.vy * dt, getBlock);
  moveAxis(p, 'z', p.vz * dt, getBlock);

  // --- world bounds (hard edges) ---
  const hw = PLAYER_WIDTH / 2;
  if (p.x < WORLD_MIN_X + hw) {
    p.x = WORLD_MIN_X + hw;
    p.vx = Math.max(0, p.vx);
  }
  if (p.x > WORLD_MIN_X + WORLD_SIZE_X - hw) {
    p.x = WORLD_MIN_X + WORLD_SIZE_X - hw;
    p.vx = Math.min(0, p.vx);
  }
  if (p.z < WORLD_MIN_Z + hw) {
    p.z = WORLD_MIN_Z + hw;
    p.vz = Math.max(0, p.vz);
  }
  if (p.z > WORLD_MIN_Z + WORLD_SIZE_Z - hw) {
    p.z = WORLD_MIN_Z + WORLD_SIZE_Z - hw;
    p.vz = Math.min(0, p.vz);
  }
  if (p.y < 0) {
    p.y = 0;
    p.vy = Math.max(0, p.vy);
  }
  if (p.y > WORLD_MAX_Y - PLAYER_HEIGHT) {
    p.y = WORLD_MAX_Y - PLAYER_HEIGHT;
    p.vy = Math.min(0, p.vy);
  }
}

function moveAxis(p: Player, axis: 'x' | 'y' | 'z', amount: number, getBlock: BlockProbe): void {
  if (amount === 0) return;
  p[axis] += amount;
  for (;;) {
    const box = p.getAABB();
    const x0 = Math.floor(box.minX);
    const x1 = Math.floor(box.maxX - EPS);
    const y0 = Math.floor(box.minY);
    const y1 = Math.floor(box.maxY - EPS);
    const z0 = Math.floor(box.minZ);
    const z1 = Math.floor(box.maxZ - EPS);
    let resolved = false;
    for (let x = x0; x <= x1 && !resolved; x++) {
      for (let y = y0; y <= y1 && !resolved; y++) {
        for (let z = z0; z <= z1 && !resolved; z++) {
          const blk = getBlock(x, y, z);
          if (!isSolidBlockAt(blk.id, blk.meta)) continue;
          const b = blockAABB(x, y, z);
          if (!Player.boxesIntersect(box, b)) continue;
          if (axis === 'x') {
            p.x = amount > 0 ? b.minX - PLAYER_WIDTH / 2 - EPS : b.maxX + PLAYER_WIDTH / 2 + EPS;
            p.vx = 0;
          } else if (axis === 'y') {
            if (amount > 0) {
              p.y = b.minY - PLAYER_HEIGHT - EPS;
            } else {
              p.y = b.maxY + EPS;
              p.onGround = true;
            }
            p.vy = 0;
          } else {
            p.z = amount > 0 ? b.minZ - PLAYER_WIDTH / 2 - EPS : b.maxZ + PLAYER_WIDTH / 2 + EPS;
            p.vz = 0;
          }
          resolved = true;
        }
      }
    }
    if (!resolved) return;
  }
}
