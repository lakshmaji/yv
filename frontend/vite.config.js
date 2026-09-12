import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// The version anchor is the root package.json, deliberately not
// frontend/package.json (which has none, see its own description field) —
// reusing it here means the release tag Sentry sees on uploaded source maps
// is the same one the running app reports at init.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

// A source map only needs to exist long enough for the plugin to upload it.
// Gated on SENTRY_AUTH_TOKEN so a build without it (local dev, forks, PRs)
// behaves exactly as before — nothing is generated or shipped.
const sentryEnabled = !!process.env.SENTRY_AUTH_TOKEN;

export default defineConfig({
  plugins: [
    solidPlugin(),
    sentryEnabled &&
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        release: { name: pkg.version },
        sourcemaps: { filesToDeleteAfterUpload: ['**/*.map'] },
      }),
  ].filter(Boolean),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: sentryEnabled,
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
