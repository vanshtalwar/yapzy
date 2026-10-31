// Self-hosts the NSFWJS MobileNetV2 model (MIT, bundled in the nsfwjs package) under
// public/models/nsfw/ in the standard TensorFlow.js layout (model.json + binary shard), so
// the browser loads it from our own origin (CSP connect-src 'self'), never from a CDN.
// Runs before `next dev` / `next build`; no network access needed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const outDir = path.join(import.meta.dirname, '..', 'public', 'models', 'nsfw');

/** The package root (dist/cjs and dist/esm carry their own package.json files). */
function packageRoot(name) {
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package root of ${name} not found`);
    dir = parent;
  }
}

const root = packageRoot('nsfwjs');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const stamp = path.join(outDir, 'VERSION');
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) process.exit(0);

const source = path.join(root, 'dist', 'models', 'mobilenet_v2');
const loaded = require(path.join(source, 'model.min.js'));
const model = loaded.default ?? loaded;
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'model.json'), JSON.stringify(model));
for (const group of model.weightsManifest) {
  for (const shard of group.paths) {
    const base64 = require(path.join(source, `${shard}.min.js`));
    writeFileSync(path.join(outDir, shard), Buffer.from(base64.default ?? base64, 'base64'));
  }
}
writeFileSync(stamp, version);
process.stdout.write(`nsfw model ${version} → ${path.relative(process.cwd(), outDir)}\n`);
