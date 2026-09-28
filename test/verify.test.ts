/**
 * Phase 3 — CPU rasterizer smoke test.
 *
 * Renders a tiny 1x1-chunk flat world with the software rasterizer
 * (tools/rasterizer.ts) and asserts the output is a valid PNG with a
 * recognizable (non-sky) portion of the image.
 */

import { describe, it, expect } from 'vitest';
import { Chunk } from '../src/world/chunk';
import { Block, AIR } from '../src/world/blocks';
import { buildChunkMeshData } from '../src/world/mesher';
import { renderScene, encodePng, buildSoftwareAtlas, PNG_SIGNATURE } from '../tools/rasterizer';
import type { Camera } from '../tools/rasterizer';

const SKY: [number, number, number] = [135, 206, 235];

describe('CPU rasterizer (Phase 3 verification tool)', () => {
  it('renders a 1x1-chunk flat world to a valid PNG with >5% non-sky pixels', () => {
    const c = new Chunk();
    // 8x8 grass pad at y=0, centered in the chunk
    for (let x = 4; x <= 11; x++) {
      for (let z = 4; z <= 11; z++) {
        c.setBlock(x, 0, z, Block.Grass);
      }
    }
    const airWorld = (): number => AIR;
    const data = buildChunkMeshData(c, 0, 0, airWorld).opaque;
    expect(data.vertexCount).toBeGreaterThan(0);

    // camera: 10 blocks out, ~30° down, looking at the pad center
    const camera: Camera = {
      x: 14,
      y: 5,
      z: 14,
      yaw: Math.PI / 4,
      pitch: -0.5,
      fovY: (75 * Math.PI) / 180,
    };
    const result = renderScene([data], camera, {
      width: 320,
      height: 180,
      sky: SKY,
      fog: null,
      atlas: buildSoftwareAtlas(),
    });
    expect(result.triangleCount).toBeGreaterThan(0);
    expect(result.rasterizedTriangles).toBeGreaterThan(0);

    const png = encodePng(result.width, result.height, result.pixels);
    // PNG signature + a plausible file size
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.length).toBeGreaterThan(100);

    // the grass pad must be visible: >5% of the image is not sky
    const total = result.width * result.height;
    expect(result.nonSkyPixels / total).toBeGreaterThan(0.05);
  });

  it('empty scene renders as pure sky (0% non-sky)', () => {
    const c = new Chunk();
    const data = buildChunkMeshData(c, 0, 0, () => AIR).opaque;
    expect(data.vertexCount).toBe(0);
    const result = renderScene([data], { x: 0, y: 5, z: 0, yaw: 0, pitch: 0, fovY: 1 }, {
      width: 64,
      height: 48,
      sky: SKY,
      fog: null,
      atlas: null,
    });
    expect(result.nonSkyPixels).toBe(0);
  });
});
