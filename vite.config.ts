import { defineConfig } from 'vite';

// Relative base so the build works from a GitHub Pages project subpath
// (https://<user>.github.io/<repo>/) as well as from the domain root.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: false },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
});
