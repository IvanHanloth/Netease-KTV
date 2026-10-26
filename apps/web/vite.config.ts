import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
/** Changes with every build, so open pages and the service worker can tell a new release is out. */
const BUILD_ID = `${version}+${Date.now().toString(36)}`

/** Writes version.json and stamps the build id into sw.js (a changed sw.js is what makes browsers install it). */
function buildInfo(): Plugin {
  let outDir = ''
  return {
    name: 'ktv-build-info',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, build: BUILD_ID }) })
    },
    closeBundle() {
      const sw = path.join(outDir, 'sw.js')
      if (fs.existsSync(sw)) fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replaceAll('__BUILD_ID__', BUILD_ID))
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), buildInfo()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
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
