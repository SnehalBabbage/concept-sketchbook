// Stamps a content hash onto the app's CSS and JS URLs (?v=...) so browsers fetch new files
// after a deploy instead of using a cached copy (GitHub Pages caches them for 10 minutes).
// Run before committing a change to css/ or js/: node scripts/stamp-version.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsFiles = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => join(root, 'js', f));
const files = [join(root, 'css', 'app.css'), ...jsFiles];
const unstamp = (s) => s.replace(/\?v=[0-9a-f]+/g, '');

const hash = createHash('sha256');
for (const f of files) hash.update(unstamp(readFileSync(f, 'utf8')));
const v = hash.digest('hex').slice(0, 10);

for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  const out = unstamp(src).replace(/(from '\.\/[\w-]+\.js)'/g, `$1?v=${v}'`);
  if (out !== src) writeFileSync(f, out);
}
const index = join(root, 'index.html');
const html = readFileSync(index, 'utf8');
const stamped = unstamp(html).replace(/(href="css\/app\.css|src="js\/app\.js)"/g, `$1?v=${v}"`);
if (stamped !== html) writeFileSync(index, stamped);
console.log(`Stamped version ${v}`);
