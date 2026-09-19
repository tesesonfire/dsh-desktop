import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Consumed by src-tauri/tauri.conf.json: devUrl http://localhost:1420 and
// frontendDist ../dist (see ./FRONTEND.md for the exact contract).
export default defineConfig({
  plugins: [react()],
  // Tauri serves the built assets from a custom-protocol root; absolute
  // asset URLs would 404 in production, so asset paths stay relative.
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
