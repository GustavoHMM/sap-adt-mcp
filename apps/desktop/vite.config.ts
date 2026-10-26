import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The window is loaded from disk (file://), so assets use relative paths.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: false,
    // Loaded from disk, never over the network: one bundle is fine.
    chunkSizeWarningLimit: 4096,
  },
});
