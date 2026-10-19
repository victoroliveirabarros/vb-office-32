import { defineConfig } from 'vite'

// Builds the development-only harness for the Go server to serve:
//   npx vite build --config e2e/vite.config.ts [--outDir <dir>]
// then run the server with VB_OFFICE32_WEB_DIR=<dir> (default web/e2e/dist).
export default defineConfig({
  root: new URL('..', import.meta.url).pathname,
  build: {
    outDir: 'e2e/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: new URL('intruder.html', import.meta.url).pathname },
  },
})
