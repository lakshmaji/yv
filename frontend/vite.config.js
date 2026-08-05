import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Unit tests cover pure logic only (no DOM), so the node environment is enough.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
