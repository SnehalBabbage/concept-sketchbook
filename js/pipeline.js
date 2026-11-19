// Staged generation: three model stages that return short, scoped JSON, then a code stage
// that runs the quality gates and lays the map out. Finished stages are kept, so a failed
// stage can be retried without redoing the others (FR-13).
import { RELATIONS, MIN_CONCEPTS, MAX_CONCEPTS, MAX_EXPLANATION, DETAIL_BATCH, MAX_CALLS_PER_GRAPH } from './config.js?v=32d83d848e';
import { ask } from './openrouter.js?v=32d83d848e';
import { layout } from './layout.js?v=32d83d848e';

export const STAGES = [
  { id: 'outline', label: 'Outline the concepts' },
  { id: 'details', label: 'Draft explanations, caveats and test questions' },
  { id: 'links', label: 'Connect the concepts' },
  { id: 'check', label: 'Check the draft and lay it out' },
];

const SYSTEM = `You draft concept maps for self-directed learners. Your map is a rough first sketch that the learner will check, doubt and edit, not an authority.
Rules:
- Never write URLs, web addresses or citations. Suggest search phrases only.
- Be concrete and plain. Prefer the ideas a beginner must grasp to see the shape of the subject.
- Where experts disagree or a simplification misleads, say so.
- If the topic asks for help causing serious harm (weapons, self-harm, attacks, abuse), decline.
- Reply with JSON that matches the given schema and nothing else.`;

const str = { type: 'string' };

const SCHEMAS = {
  outline: {
    type: 'object',
    additionalProperties: false,
    required: ['declined', 'decline_reason', 'concepts'],
    properties: {
      declined: { type: 'boolean' },
      decline_reason: str,
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'group'],
          properties: { name: str, group: str },
        },
      },
    },
  },
  details: {
    type: 'object',
    additionalProperties: false,
    required: ['concepts'],
    properties: {
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'explanation', 'caveat', 'test_question', 'search_phrases'],
          properties: {
            name: str,
            explanation: str,
            caveat: str,
            test_question: str,
            search_phrases: { type: 'array', items: str },
          },
        },
      },
    },
  },
  links: {
    type: 'object',
    additionalProperties: false,
    required: ['links'],
    properties: {
      links: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to', 'relation'],
          properties: { from: str, to: str, relation: { type: 'string', enum: RELATIONS } },
        },
      },
    },
  },
  single: {
    type: 'object',
    additionalProperties: false,
    required: ['explanation', 'caveat', 'test_question', 'search_phrases'],
    properties: {
      explanation: str,
      caveat: str,
      test_question: str,
      search_phrases: { type: 'array', items: str },
    },
  },
};

// --- Helpers ---
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isStr = (s) => typeof s === 'string' && s.trim().length > 0;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|ai|co|uk|info|dev)(?:\/\S*)?/gi;

export function stripUrls(text) {
  if (typeof text !== 'string') return { text: '', removed: false };
  const out = text.replace(URL_RE, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  return { text: out, removed: out !== text.trim() };
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')) + '…';
}

// Union-find count of clusters.
export function countClusters(names, links) {
  const parent = new Map(names.map((n) => [n, n]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  for (const l of links) if (parent.has(l.from) && parent.has(l.to)) parent.set(find(l.from), find(l.to));
  return new Set(names.map(find)).size;
}

// --- Validators (gates per stage) ---
function checkOutline(d) {
  if (!d || typeof d !== 'object') return ['Reply is not an object.'];
  if (d.declined === true) return [];
  const p = [];
  if (!Array.isArray(d.concepts)) return ['"concepts" must be an array.'];
  const n = d.concepts.length;
  if (n < MIN_CONCEPTS || n > MAX_CONCEPTS) p.push(`Give between ${MIN_CONCEPTS} and ${MAX_CONCEPTS} concepts (you gave ${n}). Aim for 16 to 20.`);
  const seen = new Set();
  for (const c of d.concepts) {
    if (!isStr(c?.name) || !isStr(c?.group)) { p.push('Every concept needs a name and a group.'); break; }
    if (c.name.length > 60) p.push(`Shorten the name "${c.name.slice(0, 40)}…" to under 60 characters.`);
    if (seen.has(norm(c.name))) p.push(`Duplicate concept "${c.name}".`);
    seen.add(norm(c.name));
  }
  return p;
}

function checkDetails(names) {
  return (d) => {
    if (!Array.isArray(d?.concepts)) return ['"concepts" must be an array.'];
    const got = new Map(d.concepts.map((c) => [norm(c?.name), c]));
    const p = [];
    for (const name of names) {
      const c = got.get(norm(name));
      if (!c) { p.push(`Missing concept "${name}" (use the exact name).`); continue; }
      if (!isStr(c.explanation) || !isStr(c.caveat) || !isStr(c.test_question)) p.push(`"${name}" needs an explanation, caveat and test question.`);
      else if (c.explanation.length > MAX_EXPLANATION * 1.5) p.push(`Explanation of "${name}" must be ${MAX_EXPLANATION} characters or fewer.`);
      const phrases = Array.isArray(c.search_phrases) ? c.search_phrases.filter(isStr) : [];
      if (phrases.length < 1) p.push(`"${name}" needs 1 to 3 search phrases.`);
    }
    return p;
  };
}

function resolveLinks(names, raw) {
  const byNorm = new Map(names.map((n) => [norm(n), n]));
  const out = [];
  const bad = [];
  const seen = new Set();
  for (const l of raw || []) {
    const from = byNorm.get(norm(l?.from));
    const to = byNorm.get(norm(l?.to));
    if (!from || !to) { bad.push(`Link "${l?.from}" → "${l?.to}" names a concept that does not exist.`); continue; }
    if (from === to) { bad.push(`Link from "${from}" to itself.`); continue; }
    if (!RELATIONS.includes(l.relation)) { bad.push(`Link "${from}" → "${to}" uses an unknown relation "${l.relation}".`); continue; }
    const k = [from, to].sort().join('\u0000');
    if (seen.has(k)) continue; // duplicates are dropped silently
    seen.add(k);
    out.push({ from, to, relation: l.relation });
  }
  return { links: out, bad };
}

function linkProblems(names, links) {
  const p = [];
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const lonely = names.filter((n) => !linked.has(n));
  if (lonely.length) p.push(`These concepts have no link: ${lonely.map((n) => `"${n}"`).join(', ')}.`);
  const clusters = countClusters(names, links);
  if (clusters > 2) p.push(`The map falls into ${clusters} disconnected groups; connect them so there are at most 2.`);
  return p;
}

function checkLinks(names) {
  return (d) => {
    if (!Array.isArray(d?.links)) return ['"links" must be an array.'];
    const { links, bad } = resolveLinks(names, d.links);
    // Bad links are dropped later; they only fail the stage when they are a large share.
    const tooManyBad = bad.length > Math.max(2, d.links.length * 0.25);
    return [...(tooManyBad ? bad.slice(0, 6) : []), ...linkProblems(names, links)];
  };
}

// --- Prompts ---
const outlinePrompt = (topic) => `Topic: ${JSON.stringify(topic)}
List the 16 to 20 key concepts a beginner needs to see the shape of this topic (never fewer than ${MIN_CONCEPTS} or more than ${MAX_CONCEPTS}).
- name: a short noun phrase, under 6 words, unique.
- group: one of 3 to 5 short group labels you choose (e.g. "Foundations", "Mechanisms", "Applications", "Debates").
If the topic is vague or ambiguous, pick the most common learner meaning and include a concept that names the ambiguity.
Set declined=false and decline_reason="" unless you must decline.`;

const detailsPrompt = (topic, all, batch) => `Topic: ${JSON.stringify(topic)}
All concepts on the map: ${all.map((c) => c.name).join('; ')}.
For each of these concepts only: ${batch.map((c) => JSON.stringify(c.name)).join(', ')}
write:
- name: exactly as given.
- explanation: a plain draft explanation, ${MAX_EXPLANATION} characters or fewer.
- caveat: "where this may mislead" - a common misconception, an oversimplification in your explanation, or a point experts dispute.
- test_question: a "try to break it" question that would expose a shallow understanding.
- search_phrases: 1 to 3 search phrases a learner could type to check the explanation. No URLs.`;

const linksPrompt = (topic, names) => `Topic: ${JSON.stringify(topic)}
Concepts (use these names exactly): ${names.map((n) => JSON.stringify(n)).join(', ')}
Write the links between concepts. Each link is {from, to, relation} where relation is one of: ${RELATIONS.join(', ')}.
Read a link as "from <relation> to", e.g. "Antibody" part of "Adaptive immunity".
- Every concept must have at least one link; the whole map must be connected.
- Prefer specific relations over "related to". About 1.3 to 2 links per concept. No duplicate pairs.`;

const singlePrompt = (topic, concept, neighbours) => `Topic: ${JSON.stringify(topic)}
Concept: ${JSON.stringify(concept)}. Nearby concepts on the map: ${neighbours.join('; ') || 'none'}.
Write a fresh draft for this one concept:
- explanation: ${MAX_EXPLANATION} characters or fewer.
- caveat: where this may mislead.
- test_question: a "try to break it" question.
- search_phrases: 1 to 3 search phrases, no URLs.`;

const user = (content) => [{ role: 'system', content: SYSTEM }, { role: 'user', content }];

// --- Pipeline ---
let nextId = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(nextId++).toString(36)}`;

export class Pipeline {
  constructor(topic) {
    this.topic = topic;
    this.outline = null;
    this.details = new Map(); // norm(name) -> details
    this.links = null;
    this.budget = { used: 0, max: MAX_CALLS_PER_GRAPH };
    this.models = new Set();
  }

  // opts: { key, models, dailyCap, signal, onStage(id, state, note) }
  async run(opts) {
    const { onStage } = opts;
    this.budget.used = 0; // each run (including a user-pressed Retry) gets the full per-graph budget
    const base = { key: opts.key, models: opts.models, dailyCap: opts.dailyCap, budget: this.budget, signal: opts.signal };
    let current = null;
    const stage = (id, note) => { current = id; onStage(id, 'active', note); };
    const askWith = (id, args) => ask({ ...base, ...args, onStatus: (s) => onStage(id, 'active', s) });

    try {
      if (!this.outline) {
        stage('outline');
        const { data, model } = await askWith('outline', {
          schemaName: 'concept_outline', schema: SCHEMAS.outline, messages: user(outlinePrompt(this.topic)), validate: checkOutline,
        });
        this.models.add(model);
        if (data.declined) {
          const e = new Error(data.decline_reason || 'The model declined this topic.');
          e.declined = true;
          throw e;
        }
        this.outline = data.concepts.map((c) => ({ name: c.name.trim(), group: c.group.trim() }));
      }
      onStage('outline', 'done', `${this.outline.length} concepts`);

      const todo = this.outline.filter((c) => !this.details.has(norm(c.name)));
      if (todo.length) {
        stage('details');
        for (let i = 0; i < todo.length; i += DETAIL_BATCH) {
          const batch = todo.slice(i, i + DETAIL_BATCH);
          onStage('details', 'active', `${this.details.size} of ${this.outline.length} drafted`);
          const { data, model } = await askWith('details', {
            schemaName: 'concept_details', schema: SCHEMAS.details,
            messages: user(detailsPrompt(this.topic, this.outline, batch)), validate: checkDetails(batch.map((c) => c.name)),
          });
          this.models.add(model);
          for (const c of data.concepts) this.details.set(norm(c.name), c);
        }
      }
      onStage('details', 'done', `${this.outline.length} drafted`);

      const names = this.outline.map((c) => c.name);
      if (!this.links) {
        stage('links');
        const { data, model } = await askWith('links', {
          schemaName: 'concept_links', schema: SCHEMAS.links, messages: user(linksPrompt(this.topic, names)), validate: checkLinks(names),
          acceptLast: true, // keep the best structure we got; stage 4 reports the failed gates
        });
        this.models.add(model);
        this.links = resolveLinks(names, data.links).links;
      }
      onStage('links', 'done', `${this.links.length} links`);

      stage('check');
      const result = this.assemble();
      onStage('check', 'done', result.report.failed.length ? `${result.report.failed.length} check(s) need attention` : 'all checks passed');
      return result;
    } catch (err) {
      err.stage = current;
      throw err;
    }
  }

  // Stage 4: code only. Builds the map, strips any URL from model text, runs the gates, lays it out.
  assemble() {
    const idByName = new Map();
    let flaggedCount = 0;
    const concepts = this.outline.map((c) => {
      const d = this.details.get(norm(c.name)) || {};
      let flagged = false;
      const clean = (t) => { const r = stripUrls(t); flagged ||= r.removed; return r.text; };
      const concept = {
        id: uid('c'),
        name: clean(c.name),
        group: clean(c.group),
        explanation: clip(clean(d.explanation || ''), MAX_EXPLANATION),
        caveat: clean(d.caveat || ''),
        question: clean(d.test_question || ''),
        phrases: (d.search_phrases || []).map(clean).filter(Boolean).slice(0, 3),
        status: 'unchecked',
        origin: 'ai',
        guess: '',
        revealed: false,
        notes: '',
        flag: '',
        x: 0, y: 0,
      };
      if (flagged) { concept.flag = 'A web address in the model text was removed. Treat this concept with extra care.'; flaggedCount++; }
      idByName.set(c.name, concept.id);
      return concept;
    });

    const links = this.links.map((l) => ({
      id: uid('l'), from: idByName.get(l.from), to: idByName.get(l.to), relation: l.relation, status: 'unchecked', origin: 'ai',
    }));

    const names = this.outline.map((c) => c.name);
    const passed = [];
    const failed = [];
    const gate = (ok, label, why) => (ok ? passed : failed).push(ok ? label : `${label}: ${why}`);
    gate(true, 'Schema');
    const sizeOk = concepts.length >= MIN_CONCEPTS && concepts.length <= MAX_CONCEPTS
      && concepts.every((c) => c.name && c.group && c.explanation && c.caveat && c.question && c.phrases.length);
    gate(sizeOk, 'Size', 'some concepts are missing fields or the count is out of range');
    const lp = linkProblems(names, this.links);
    gate(!lp.some((p) => p.startsWith('These')), 'Links', lp[0]);
    gate(countClusters(names, this.links) <= 2, 'Shape', 'more than two disconnected clusters');
    gate(flaggedCount === 0, 'Sources', `${flaggedCount} concept(s) had a URL removed and are flagged`);

    layout(concepts, links);
    return {
      map: {
        version: 1,
        id: uid('m'),
        topic: this.topic,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        models: [...this.models],
        concepts,
        links,
      },
      report: { passed, failed, calls: this.budget.used },
    };
  }
}

// FR-14: regenerate one concept without changing the rest.
export async function regenerateConcept({ map, concept, key, models, dailyCap, signal }) {
  const neighbours = map.links
    .filter((l) => l.from === concept.id || l.to === concept.id)
    .map((l) => map.concepts.find((c) => c.id === (l.from === concept.id ? l.to : l.from))?.name)
    .filter(Boolean);
  const { data } = await ask({
    key, models, dailyCap, signal,
    budget: { used: 0, max: 3 },
    schemaName: 'concept_single', schema: SCHEMAS.single,
    messages: user(singlePrompt(map.topic, concept.name, neighbours)),
    validate: (d) => checkDetails([concept.name])({ concepts: [{ ...d, name: concept.name }] }),
  });
  let flagged = false;
  const clean = (t) => { const r = stripUrls(t); flagged ||= r.removed; return r.text; };
  return {
    explanation: clip(clean(data.explanation), MAX_EXPLANATION),
    caveat: clean(data.caveat),
    question: clean(data.test_question),
    phrases: data.search_phrases.map(clean).filter(Boolean).slice(0, 3),
    flag: flagged ? 'A web address in the model text was removed. Treat this concept with extra care.' : '',
  };
}

export { uid };
