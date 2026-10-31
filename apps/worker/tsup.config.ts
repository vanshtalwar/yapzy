import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so they are bundled; npm dependencies stay
  // external and must be listed in this package's dependencies.
  noExternal: [/^@app\//],
});
