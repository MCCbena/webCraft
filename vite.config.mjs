// NOTE: plain .mjs on purpose — the dev sandbox blocks Vite's subprocess
// bundling of .ts config files (spawn EPERM on piped stdio). Keep this file
// dependency-free ESM JS.
export default {
  // Relative base so the built site works on GitHub Pages
  // (https://<user>.github.io/<repo>/) as well as any sub-path.
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    // The root index.html is a runtime loader (dev vs Pages) whose import is
    // intentionally opaque to the bundler, so the game entry is declared
    // explicitly here. Fixed (hashless) output name: the built bundle is
    // committed to the repo root (assets/) for GitHub Pages, which serves the
    // main branch directly (legacy Pages build in this environment).
    rolldownOptions: {
      input: {
        game: 'src/main.ts',
      },
      output: {
        entryFileNames: 'assets/game.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: {
    environment: 'node',
    // 'threads' (worker_threads) instead of the default 'forks': the dev
    // sandbox blocks child-process spawning with piped/IPC stdio.
    pool: 'threads',
    include: ['test/**/*.test.ts'],
  },
};
