import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API owns port 7005 (it matches MS_REDIRECT_URI and serves the built SPA).
// The dev server runs alongside it on 7006 and proxies /api across.
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 loopback explicitly. Vite's default "localhost" resolves to the
    // IPv6 ::1 on Windows, so a browser that resolves localhost to 127.0.0.1
    // gets ERR_CONNECTION_REFUSED. 127.0.0.1 keeps it local-only (never exposed
    // to the network) and works whichever way the browser resolves localhost.
    host: '127.0.0.1',
    port: 7006,
    strictPort: true, // fail loudly instead of silently moving to another port
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7005',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
