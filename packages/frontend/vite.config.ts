import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend version (shown in About), read from package.json at build time.
const appVersion: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version

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
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
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
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'state': ['zustand'],
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
