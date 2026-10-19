import { defineConfig } from 'vite'

const devHosts = ['localhost', '127.0.0.1']

// Vite checks Host on plain requests but not on proxied WebSocket upgrades,
// so /ws checks it itself: a DNS-rebound page would reach the server with
// Origin and Host both set to the attacker's name, passing its origin check.
export function isDevHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    return devHosts.includes(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

// changeOrigin: false keeps the browser's Host, which the server's
// same-origin checks compare with Origin.
const backend = { target: 'http://localhost:8080', changeOrigin: false }

export default defineConfig({
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    allowedHosts: devHosts,
    proxy: {
      '/ws': { ...backend, ws: true, bypass: (req) => (isDevHost(req.headers.host) ? undefined : false) },
      '/maps': backend,
      '/auth': backend,
      '/api': backend,
    },
  },
})
