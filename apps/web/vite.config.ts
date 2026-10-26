import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../server/src/shared', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': {
        // KTV_API: a server on another port (e.g. while the Docker build holds 8686).
        target: process.env.KTV_API ?? 'http://localhost:8686',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // react + router + motion + query land in one vendor chunk (~160 kB gzip); pages are lazy-loaded
    chunkSizeWarningLimit: 900,
  },
})
