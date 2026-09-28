/**
 * WebCraft — screenshot tool (Phase 1, [core]).
 *
 * Starts the Vite dev server, opens it in headless Chrome (puppeteer-core),
 * waits for the world to generate + first render, and saves
 * screenshots/phase1.png at 1280x720.
 *
 * Run: npm run screenshot   (node screenshot.ts, Node 24 type stripping)
 */

import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const PORT = 5199;
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'screenshots/phase1.png';

console.log('[screenshot] starting vite dev server on port', PORT);
const server = await createServer({
  root: process.cwd(),
  server: { port: PORT, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
});
await server.listen();
const url = `http://127.0.0.1:${PORT}/`;
console.log('[screenshot] dev server at', url);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1280,720',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', (e as Error).message));

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  // deterministic wait for world generation + first rendered frame
  await page
    .waitForFunction(() => (window as unknown as { __WECRAFT_READY__?: boolean }).__WECRAFT_READY__ === true, {
      timeout: 30000,
    })
    .catch(() => console.log('[screenshot] warning: ready flag not set, continuing'));

  // let a few frames render so the HUD text is visible
  await new Promise((r) => setTimeout(r, 5000));

  mkdirSync('screenshots', { recursive: true });
  await page.screenshot({ path: OUT });
  console.log('[screenshot] saved', OUT);
} finally {
  await browser.close();
  await server.close();
}
process.exit(0);
