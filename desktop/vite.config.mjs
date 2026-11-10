import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The main window UI. Built into ui-dist/ and loaded by Electron from disk,
// so asset paths must be relative.
export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: { outDir: '../ui-dist', emptyOutDir: true, target: 'chrome130', sourcemap: false },
});
