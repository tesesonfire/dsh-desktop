import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Renderer-only config; the main/preload bundles are produced by build.mjs (esbuild).
export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
});
