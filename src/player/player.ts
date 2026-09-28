/**
 * WebCraft — Player state (Phase 1, [core]).
 * Pure TS. Position is the FEET center of the AABB in world coords.
 * AABB: 0.6 wide (x,z) x 1.8 tall. Eye height 1.62 (design.md §7).
 */

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export class Player {
  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  /** yaw in radians; 0 = looking toward -Z, positive = turning left */
  yaw = 0;
  /** pitch in radians; 0 = horizontal, positive = looking up */
  pitch = 0;
  onGround = false;
  inWater = false;

  constructor(x = 0.5, y = 100, z = 0.5) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  get eyeY(): number {
    return this.y + EYE_HEIGHT;
  }

  /** Current AABB. */
  getAABB(): AABB {
    const hw = PLAYER_WIDTH / 2;
    return {
      minX: this.x - hw,
      minY: this.y,
      minZ: this.z - hw,
      maxX: this.x + hw,
      maxY: this.y + PLAYER_HEIGHT,
      maxZ: this.z + hw,
    };
  }

  /** Axis-aligned box intersection test. */
  static boxesIntersect(a: AABB, b: AABB): boolean {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;
  }
}

export function blockAABB(x: number, y: number, z: number): AABB {
  return { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 };
}
