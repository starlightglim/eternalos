import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vite plugin to handle /@username SPA routes.
 * Vite reserves /@* for internal routes (/@vite/, /@fs/, /@id/),
 * so /@username requests may not reach the SPA fallback.
 * This middleware intercepts them and serves index.html.
 */
function atSignRoutePlugin(): Plugin {
  return {
    name: 'at-sign-route',
    configureServer(server) {
      // Run before Vite's internal middleware
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.startsWith('/@')) {
          // Don't rewrite Vite's internal /@* routes
          const viteInternal =
            req.url.startsWith('/@vite/') ||
            req.url.startsWith('/@fs/') ||
            req.url.startsWith('/@id/') ||
            req.url.startsWith('/@react-refresh')
          if (!viteInternal) {
            // Rewrite to / so Vite serves index.html (SPA fallback)
            req.url = '/'
          }
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [atSignRoutePlugin(), react()],
  build: {
    // Output to dist folder for Cloudflare Pages
    outDir: 'dist',
    // Generate source maps for debugging (optional, can be disabled in prod)
    sourcemap: false,
    // Minify for production
    minify: 'esbuild',
    // Target modern browsers
    target: 'es2020',
    // Rollup options
    rollupOptions: {
      output: {
        // Chunk vendor dependencies separately
        manualChunks: {
          // zustand (<1KB) stays in the entry chunk: its own chunk only
          // added a request.
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  // Preview server config (for local testing of production build)
  preview: {
    port: 4173,
  },
  // Dev server config
  server: {
    port: 5173,
    // Proxy API requests to the Worker in development
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
