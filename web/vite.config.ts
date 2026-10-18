import { defineConfig } from 'vite'

const backend = 'http://localhost:8080'

export default defineConfig({
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      '/ws': { target: backend, ws: true },
      '/maps': backend,
    },
  },
})
