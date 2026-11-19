// Builds the sample map database (samples/*.json and samples/index.json) from samples/src.
// Every sample must pass the same gates as a generated map, then gets a precomputed layout.
// Run: node scripts/build-samples.mjs
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELATIONS, MIN_CONCEPTS, MAX_CONCEPTS, MAX_EXPLANATION } from '../js/config.js';
import { layout } from '../js/layout.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'samples', 'src');
const outDir = join(root, 'samples');
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

function clusters(names, links) {
  const parent = new Map(names.map((n) => [n, n]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const [a, , b] of links) parent.set(find(a), find(b));
  return new Set(names.map(find)).size;
}

function check(s) {
  const errors = [];
  const err = (m) => errors.push(`${s.slug}: ${m}`);
  const names = s.concepts.map((c) => c[0]);
  if (names.length < MIN_CONCEPTS || names.length > MAX_CONCEPTS) err(`${names.length} concepts`);
  if (new Set(names).size !== names.length) err('duplicate concept names');
  for (const [name, group, expl, caveat, q, phrases] of s.concepts) {
    if (![name, group, expl, caveat, q].every((x) => typeof x === 'string' && x.trim())) err(`"${name}" has an empty field`);
    if (expl.length > MAX_EXPLANATION) err(`"${name}" explanation is ${expl.length} chars`);
    if (!Array.isArray(phrases) || phrases.length < 1 || phrases.length > 3) err(`"${name}" needs 1 to 3 phrases`);
    if ([name, expl, caveat, q, ...phrases].some((t) => URL_RE.test(t))) err(`"${name}" contains a URL`);
  }
  const seen = new Set();
  for (const [a, rel, b] of s.links) {
    if (!names.includes(a) || !names.includes(b)) err(`link ${a} -> ${b} names an unknown concept`);
    if (!RELATIONS.includes(rel)) err(`link ${a} -> ${b} has relation "${rel}"`);
    if (a === b) err(`self link on ${a}`);
    const k = [a, b].sort().join('|');
    if (seen.has(k)) err(`duplicate link ${a} / ${b}`);
    seen.add(k);
  }
  const linked = new Set(s.links.flatMap(([a, , b]) => [a, b]));
  const lonely = names.filter((n) => !linked.has(n));
  if (lonely.length) err(`unlinked: ${lonely.join(', ')}`);
  const k = clusters(names, s.links);
  if (k > 1) err(`${k} disconnected clusters`); // samples are held to "fully connected"
  return errors;
}

function toMap(s) {
  const ids = new Map(s.concepts.map((c, i) => [c[0], `c${i}`]));
  const concepts = s.concepts.map(([name, group, explanation, caveat, question, phrases]) => ({
    id: ids.get(name), name, group, explanation, caveat, question, phrases,
    status: 'unchecked', origin: 'ai', guess: '', revealed: false, notes: '', flag: '', x: 0, y: 0,
  }));
  const links = s.links.map(([from, relation, to], i) => ({
    id: `l${i}`, from: ids.get(from), to: ids.get(to), relation, status: 'unchecked', origin: 'ai',
  }));
  layout(concepts, links);
  return { app: 'concept-sketchbook', version: 1, sample: s.slug, topic: s.topic, models: ['sample, written by Claude'], concepts, links };
}

const sets = [];
for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.mjs')).sort()) {
  sets.push(...(await import(pathToFileURL(join(srcDir, f)))).default);
}

const errors = sets.flatMap(check);
if (new Set(sets.map((s) => s.slug)).size !== sets.length) errors.push('duplicate slugs');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const index = sets.map((s) => {
  writeFileSync(join(outDir, `${s.slug}.json`), JSON.stringify(toMap(s)) + '\n');
  return { slug: s.slug, topic: s.topic, field: s.field, blurb: s.blurb, concepts: s.concepts.length, links: s.links.length };
});
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ version: 1, samples: index }, null, 2) + '\n');
console.log(`Built ${index.length} samples: ${index.map((s) => `${s.slug} (${s.concepts}/${s.links})`).join(', ')}`);
