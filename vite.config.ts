import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// `base` defaults to '/stepper/' (this repo's GH Pages URL) on build, '/' in
// dev.  Override with VITE_BASE in CI if the deploy target changes.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.VITE_BASE ?? '/stepper/') : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // meshfix.worker.ts pulls in Pyodide, whose own module graph needs
  // code-splitting — Vite's default worker output ('iife') cannot do that
  // ("UMD and IIFE output formats are not supported for code-splitting
  // builds"), so the worker needs the ES module format explicitly.
  worker: {
    format: 'es',
  },
  // Vite's dev-server pre-bundler (esbuild) copies pyodide.mjs into
  // node_modules/.vite/deps/ but does not relocate the sibling assets it loads
  // by relative dynamic import at runtime, which then 404 from the wrong
  // directory. Excluding it serves pyodide straight from node_modules, where
  // its own relative resolution is intact. Dev-server only; `vite build`
  // bundles the worker correctly without this. Both settings are carried over
  // from Optimizer, which hit each failure in production first.
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  server: {
    port: 5173,
    host: true,
  },
}))
