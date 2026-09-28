/**
 * WebCraft — entry point (Phase 1, [core]).
 */

import { Game } from './game';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('canvas #game not found');
}

const params = new URLSearchParams(window.location.search);
const seedParam = params.get('seed');
const seed = seedParam !== null && seedParam !== '' && !Number.isNaN(Number(seedParam)) ? Number(seedParam) : undefined;

const game = new Game(canvas, seed);
console.log(`[webcraft] started — seed=${game.world.seed}, spawn y=${game.player.y.toFixed(1)}`);

declare global {
  interface Window {
    __WECRAFT_READY__?: boolean;
  }
}

game.onReady = () => {
  console.log(`[webcraft] ready — first frame rendered (meshed chunks: ${game.renderer.meshedChunkCount})`);
  window.__WECRAFT_READY__ = true;
};

game.start();
