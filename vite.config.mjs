// NOTE: plain .mjs on purpose — the dev sandbox blocks Vite's subprocess
// bundling of .ts config files (spawn EPERM on piped stdio). Keep this file
// dependency-free ESM JS.
export default {
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    // 'threads' (worker_threads) instead of the default 'forks': the dev
    // sandbox blocks child-process spawning with piped/IPC stdio.
    pool: 'threads',
    include: ['test/**/*.test.ts'],
  },
};
