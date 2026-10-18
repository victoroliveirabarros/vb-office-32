import { defineConfig } from 'vite'

// changeOrigin: false keeps the browser's Host, which the server's
// same-origin checks compare with Origin.
const backend = { target: 'http://localhost:8080', changeOrigin: false }

export default defineConfig({
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      '/ws': { ...backend, ws: true },
      '/maps': backend,
      '/auth': backend,
      '/api': backend,
    },
  },
})
