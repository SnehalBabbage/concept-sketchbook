// Concept Sketchbook: app shell, panel, dialogs and generation flow.
import { RELATIONS, SEARCH_SITES, DEFAULT_MODELS, TOPIC_MAX } from './config.js';
import * as store from './store.js';
import { ApiError, fetchFreeModels, startSignIn, finishSignIn } from './openrouter.js';
import { Pipeline, STAGES, regenerateConcept, uid } from './pipeline.js';
import { createMapView } from './map.js';
import { freeSpot } from './layout.js';
import { findReferences, sanitizeRefs } from './sources.js';

const $ = (id) => document.getElementById(id);

// Build DOM safely: strings become text nodes, never HTML.
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

const state = {
  map: null,
  selected: null,
  gen: null, // { pipeline, abort }
  settings: store.getSettings(),
};

let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    if (state.map && !store.saveMap(state.map)) toast('Could not save: browser storage is full or blocked. Export the map to keep it.');
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 300);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function updateCalls() {
  $('calls').textContent = `${store.callsToday()} / ${state.settings.dailyCap} calls today`;
}

// --- Map view ---
const mapView = createMapView($('map'), {
  onSelect: (sel) => select(sel),
  onMoved: () => save(),
});

function showBoard() {
  const has = !!state.map;
  $('board').hidden = !has;
  $('empty').hidden = has;
  $('panel').hidden = !has || !state.selected;
}

function renderBoard() {
  showBoard();
  if (!state.map) return;
  $('map-title').textContent = state.map.topic;
  renderTally();
  renderReport();
  mapView.render(state.map, state.selected);
}

function renderTally() {
  const cs = state.map.concepts;
  const ai = cs.filter((c) => c.origin === 'ai');
  const n = (s) => ai.filter((c) => c.status === s).length;
  const mine = cs.length - ai.length;
  const doubtedLinks = state.map.links.filter((l) => l.status === 'doubted').length;
  const parts = [`${n('checked')} checked`, `${n('doubted')} doubted`, `${n('unchecked')} still drafts`];
  let text = `${ai.length} AI concepts: ${parts.join(', ')}.`;
  if (mine) text += ` ${mine} added by you.`;
  if (doubtedLinks) text += ` ${doubtedLinks} link${doubtedLinks > 1 ? 's' : ''} doubted.`;
  $('tally').textContent = text;
}

function renderReport() {
  const r = state.map.checks;
  const det = $('report');
  det.hidden = !r;
  if (!r) return;
  const total = r.passed.length + r.failed.length;
  det.querySelector('summary').textContent = `Quality checks: ${r.passed.length} of ${total} passed`;
  const ul = det.querySelector('ul');
  ul.replaceChildren(
    ...r.passed.map((p) => h('li', {}, `✓ ${p}`)),
    ...r.failed.map((p) => h('li', { class: 'fail' }, `✕ ${p}`)),
    h('li', { class: 'fine' }, `${r.calls} model calls. Passing checks means the structure is sound, not that the content is true.`),
  );
}

function setMap(map, { fit = true } = {}) {
  state.map = map;
  state.selected = null;
  renderBoard();
  renderPanel();
  if (fit) mapView.fit();
}

function select(sel) {
  state.selected = sel;
  renderBoard();
  renderPanel();
  if (sel && window.matchMedia('(max-width: 900px)').matches) {
    $('panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
}

function changed({ redraw = true, panel = false } = {}) {
  save();
  if (redraw) { renderTally(); mapView.render(state.map, state.selected); }
  if (panel) renderPanel();
}

// --- Panel ---
const conceptById = (id) => state.map.concepts.find((c) => c.id === id);

function renderPanel() {
  const panel = $('panel');
  const sel = state.selected;
  if (!state.map || !sel) { panel.hidden = true; panel.replaceChildren(); return; }
  panel.hidden = false;
  if (sel.type === 'concept') {
    const c = conceptById(sel.id);
    if (!c) { state.selected = null; return renderPanel(); }
    panel.replaceChildren(...conceptPanel(c));
  } else {
    const l = state.map.links.find((x) => x.id === sel.id);
    if (!l) { state.selected = null; return renderPanel(); }
    panel.replaceChildren(...linkPanel(l));
  }
}

const closeBtn = () => h('button', { type: 'button', class: 'btn ghost close', 'aria-label': 'Close details', onclick: () => select(null) }, '✕');

function field(label, value, onInput, { multiline = false, rows = 3, max } = {}) {
  const id = uid('f');
  const input = multiline
    ? h('textarea', { id, rows, maxlength: max, value })
    : h('input', { id, type: 'text', maxlength: max, value });
  input.value = value || '';
  input.addEventListener('input', () => onInput(input.value));
  return [h('label', { for: id }, label), input];
}

function statusButtons(item, kind) {
  const set = (s) => {
    item.status = s;
    changed({ panel: true });
    toast(s === 'checked' ? 'Marked as checked by you.' : s === 'doubted' ? 'Doubted. It stays visible in red.' : 'Back to draft.');
  };
  const b = (s, label) => h('button', { type: 'button', class: `btn${s === 'doubted' ? ' danger' : ''}`, 'aria-pressed': String(item.status === s), onclick: () => set(s) }, label);
  return h('div', { class: 'status-row', role: 'group', 'aria-label': `${kind} status` },
    b('checked', '✓ Mark checked'), b('doubted', '! Doubt it'), b('unchecked', '? Back to draft'));
}

function conceptPanel(c) {
  const mine = c.origin === 'user';
  const statusWord = mine ? 'added by you' : { unchecked: 'draft, unchecked', checked: 'checked by you', doubted: 'doubted by you' }[c.status];
  const out = [
    closeBtn(),
    h('h2', {}, c.name),
    h('p', { class: 'meta' }, h('span', { class: `status-pill ${mine ? 'added' : c.status}` }, statusWord), c.group ? ` · ${c.group}` : ''),
  ];
  if (!mine) out.push(statusButtons(c, 'Concept'));
  if (c.flag) out.push(h('div', { class: 'box flag', role: 'note' }, `⚑ ${c.flag}`));

  if (mine) {
    out.push(...field('Your explanation', c.explanation, (v) => { c.explanation = v; save(); }, { multiline: true, rows: 4 }));
  } else if (state.settings.guessFirst && !c.revealed) {
    const id = uid('g');
    const ta = h('textarea', { id, rows: 3 });
    ta.value = c.guess || '';
    const compare = h('button', { type: 'button', class: 'btn primary', disabled: !c.guess?.trim() }, 'Compare with the draft');
    ta.addEventListener('input', () => { c.guess = ta.value; compare.disabled = !ta.value.trim(); save(); });
    compare.addEventListener('click', () => { c.revealed = true; changed({ redraw: false, panel: true }); });
    out.push(
      h('h3', {}, 'Guess first'),
      h('label', { for: id }, 'In a line, what do you think this is? The draft stays hidden until you compare.'),
      ta,
      h('div', { class: 'row' }, compare),
    );
  } else {
    if (c.guess?.trim()) {
      out.push(h('h3', {}, 'Compare'), h('div', { class: 'compare' },
        h('div', {}, h('strong', {}, 'Your guess'), c.guess),
        h('div', {}, h('strong', {}, 'Draft (an AI guess)'), c.explanation)));
    }
    const [lab, ta] = field('Draft explanation (an AI guess)', c.explanation, (v) => { c.explanation = v; save(); }, { multiline: true, rows: 5 });
    out.push(h('div', { class: 'draft' }, lab, ta));
  }

  if (!mine) {
    if (c.caveat) out.push(h('div', { class: 'box mislead' }, h('strong', {}, 'Where this may mislead'), c.caveat));
    if (c.question) out.push(h('div', { class: 'box breakit' }, h('strong', {}, 'Try to break it'), c.question));
  }

  out.push(
    h('h3', {}, 'Sources to check against'),
    h('p', { class: 'fine' }, 'Real records found in Wikipedia and scholarly catalogues (OpenAlex, Crossref), not written by the AI. Check that each one is really about this concept.'),
    refsBox(c),
  );
  const phrases = c.phrases?.length ? c.phrases : [c.name];
  out.push(
    h('p', { class: 'refs-kind' }, 'Videos and more searches'),
    h('p', { class: 'fine' }, 'Search links, not citations.'),
    h('ul', { class: 'search-list' }, phrases.map((q) => h('li', {},
      h('span', { class: 'q' }, `“${q}”`), h('br'),
      SEARCH_SITES.map((s) => h('a', { href: s.url(`${q}`), target: '_blank', rel: 'noopener noreferrer' }, s.label)),
    ))),
  );

  out.push(h('h3', {}, 'Edit'));
  out.push(...field('Name', c.name, (v) => { c.name = v.trim() || c.name; changed(); }, { max: 120 }));
  out.push(...field('Group', c.group, (v) => { c.group = v; changed(); }, { max: 60 }));
  out.push(...field('My notes', c.notes, (v) => { c.notes = v; save(); }, { multiline: true }));

  out.push(h('h3', {}, 'Links'), linksList(c), addLinkForm(c));

  const actions = h('div', { class: 'row' });
  if (!mine) {
    const regen = h('button', { type: 'button', class: 'btn' }, 'Redraft this concept');
    regen.addEventListener('click', () => redraft(c, regen));
    actions.append(regen);
  }
  actions.append(h('button', { type: 'button', class: 'btn danger', onclick: () => deleteConcept(c) }, 'Delete concept'));
  out.push(h('h3', {}, 'More'), actions);
  return out;
}

const refsLoading = new Set();

function refsBox(c) {
  const box = h('div', { 'aria-live': 'polite' });
  const draw = (note) => {
    const r = c.refs;
    const list = (items) => h('ul', { class: 'refs' }, items.map((x) => h('li', {},
      h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.title),
      x.note ? h('span', { class: 'by' }, x.note) : null)));
    const parts = [];
    if (note) parts.push(h('p', { class: 'fine' }, note));
    if (r) {
      const empty = (kind, what) => h('p', { class: 'fine' }, r.failed?.includes(kind)
        ? `Could not reach the ${what} catalogue just now. Try Search again.` : `No well-matched ${what}s found.`);
      parts.push(h('p', { class: 'refs-kind' }, `Papers${r.papersVia ? ` (${r.papersVia})` : ''}`),
        r.papers.length ? list(r.papers) : empty('papers', 'paper'));
      parts.push(h('p', { class: 'refs-kind' }, 'Articles (Wikipedia)'),
        r.articles.length ? list(r.articles) : empty('articles', 'article'));
      parts.push(h('button', { type: 'button', class: 'btn', onclick: () => load(true) }, 'Search again'));
    }
    box.replaceChildren(...parts);
  };
  const load = async (force) => {
    if (refsLoading.has(c.id)) return;
    if (c.refs && !force) return;
    refsLoading.add(c.id);
    draw('Looking up papers and articles…');
    try {
      c.refs = await findReferences(c, state.map.topic);
      save();
      draw();
    } catch (err) {
      draw(`${err.message} Use the search links below instead.`);
    } finally {
      refsLoading.delete(c.id);
    }
  };
  draw();
  load(false);
  return box;
}

function linkText(l) {
  const a = conceptById(l.from)?.name ?? '?';
  const b = conceptById(l.to)?.name ?? '?';
  return `${a} — ${l.relation} → ${b}`;
}

function linksList(c) {
  const links = state.map.links.filter((l) => l.from === c.id || l.to === c.id);
  if (!links.length) return h('p', { class: 'fine' }, 'No links yet.');
  return h('ul', { class: 'links-list' }, links.map((l) => h('li', { class: l.status },
    h('span', { class: 'txt' }, linkText(l), l.origin === 'user' ? ' (yours)' : l.status === 'doubted' ? ' (doubted)' : ''),
    l.origin === 'ai' ? h('button', {
      type: 'button', class: 'btn', 'aria-pressed': String(l.status === 'doubted'),
      onclick: () => { l.status = l.status === 'doubted' ? 'unchecked' : 'doubted'; changed({ panel: true }); },
    }, l.status === 'doubted' ? 'Undoubt' : 'Doubt') : null,
    h('button', { type: 'button', class: 'btn', onclick: () => select({ type: 'link', id: l.id }) }, 'Open'),
    h('button', { type: 'button', class: 'btn danger', 'aria-label': `Remove link ${linkText(l)}`, onclick: () => removeLink(l) }, 'Remove'),
  )));
}

function addLinkForm(c) {
  const others = state.map.concepts.filter((x) => x.id !== c.id).sort((a, b) => a.name.localeCompare(b.name));
  if (!others.length) return null;
  const relId = uid('r');
  const toId = uid('t');
  const rel = h('select', { id: relId }, RELATIONS.map((r) => h('option', { value: r }, r)));
  const to = h('select', { id: toId }, others.map((o) => h('option', { value: o.id }, o.name)));
  const add = h('button', { type: 'button', class: 'btn' }, '+ Add link');
  add.addEventListener('click', () => {
    const exists = state.map.links.some((l) => (l.from === c.id && l.to === to.value) || (l.to === c.id && l.from === to.value));
    if (exists) { toast('These two concepts are already linked.'); return; }
    state.map.links.push({ id: uid('l'), from: c.id, to: to.value, relation: rel.value, status: 'checked', origin: 'user' });
    changed({ panel: true });
    toast('Link added.');
  });
  return h('div', {},
    h('p', { class: 'fine' }, `New link: “${c.name}” … `),
    h('div', { class: 'add-link' },
      h('div', {}, h('label', { for: relId }, 'Relation'), rel),
      h('div', {}, h('label', { for: toId }, 'To concept'), to),
      add));
}

function linkPanel(l) {
  const a = conceptById(l.from);
  const b = conceptById(l.to);
  const mine = l.origin === 'user';
  const relId = uid('r');
  const rel = h('select', { id: relId }, RELATIONS.map((r) => h('option', { value: r, selected: r === l.relation }, r)));
  rel.value = l.relation;
  rel.addEventListener('change', () => { l.relation = rel.value; changed({ panel: true }); });
  const word = mine ? 'added by you' : { unchecked: 'draft, unchecked', checked: 'checked by you', doubted: 'doubted by you' }[l.status];
  return [
    closeBtn(),
    h('h2', {}, 'Link'),
    h('p', { class: 'meta' }, h('span', { class: `status-pill ${mine ? 'added' : l.status}` }, word)),
    h('p', {}, linkText(l)),
    h('p', { class: 'fine' }, `Read it as: “${a?.name}” ${l.relation} “${b?.name}”. Doubt a single link without doubting either concept.`),
    mine ? null : statusButtons(l, 'Link'),
    h('label', { for: relId }, 'Relation'), rel,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: () => { [l.from, l.to] = [l.to, l.from]; changed({ panel: true }); } }, 'Reverse direction'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => removeLink(l) }, 'Remove link')),
    h('h3', {}, 'Concepts'),
    h('div', { class: 'row' },
      a ? h('button', { type: 'button', class: 'btn', onclick: () => select({ type: 'concept', id: a.id }) }, a.name) : null,
      b ? h('button', { type: 'button', class: 'btn', onclick: () => select({ type: 'concept', id: b.id }) }, b.name) : null),
  ];
}

function removeLink(l) {
  state.map.links = state.map.links.filter((x) => x.id !== l.id);
  if (state.selected?.id === l.id) state.selected = null;
  changed({ panel: true });
  toast('Link removed.');
}

function deleteConcept(c) {
  if (!confirm(`Delete “${c.name}” and its links from this map?`)) return;
  state.map.concepts = state.map.concepts.filter((x) => x.id !== c.id);
  state.map.links = state.map.links.filter((l) => l.from !== c.id && l.to !== c.id);
  state.selected = null;
  changed({ panel: true });
  toast('Concept deleted.');
}

function addConcept() {
  if (!state.map) return;
  const name = prompt('Name of your concept:');
  if (!name?.trim()) return;
  const spot = freeSpot(state.map.concepts, mapView.centre());
  const c = {
    id: uid('c'), name: name.trim().slice(0, 120), group: 'Mine', explanation: '', caveat: '', question: '', phrases: [],
    status: 'added', origin: 'user', guess: '', revealed: true, notes: '', flag: '', ...spot,
  };
  state.map.concepts.push(c);
  save();
  select({ type: 'concept', id: c.id });
  mapView.focusConcept(c.id);
  toast('Added. Connect it to the map from the Links section.');
}

async function redraft(c, btn) {
  const key = store.getKey();
  if (!key) { openSettings('Add a key to redraft concepts.'); return; }
  btn.disabled = true;
  btn.textContent = 'Redrafting…';
  try {
    const fresh = await regenerateConcept({ map: state.map, concept: c, key, models: state.settings.models, dailyCap: state.settings.dailyCap });
    Object.assign(c, fresh, { status: 'unchecked', revealed: false });
    changed({ panel: true });
    toast('New draft written. It starts unchecked.');
  } catch (err) {
    if (err.kind === 'key') openSettings(err.message);
    else toast(err.message);
    btn.disabled = false;
    btn.textContent = 'Redraft this concept';
  } finally {
    updateCalls();
  }
}

// --- Generation ---
function renderStages(states) {
  $('stages').replaceChildren(...STAGES.map((s, i) => {
    const st = states[s.id] || { state: 'pending' };
    return h('li', { 'data-state': st.state },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('span', {}, `${i + 1}. ${s.label}`),
      st.note ? h('span', { class: 'note' }, `(${st.note})`) : null,
      h('span', { class: 'sr-only' }, ` – ${st.state}`));
  }));
}

function setGenerating(on) {
  $('sketch').disabled = on;
  $('topic').disabled = on;
  $('cancel').hidden = !on;
  $('retry').disabled = on;
}

async function runPipeline() {
  const { pipeline } = state.gen;
  const key = store.getKey();
  if (!key) { openSettings('Add an OpenRouter key, then press Retry.'); showGenError('No key yet. Add one in Settings, then retry.', true); return; }
  const abort = new AbortController();
  state.gen.abort = abort;
  const stageStates = state.gen.stageStates;
  $('progress').hidden = false;
  $('gen-error').hidden = true;
  setGenerating(true);
  renderStages(stageStates);
  try {
    const result = await pipeline.run({
      key,
      models: state.settings.models,
      dailyCap: state.settings.dailyCap,
      signal: abort.signal,
      onStage: (id, st, note) => { stageStates[id] = { state: st, note }; renderStages(stageStates); updateCalls(); },
    });
    result.map.checks = result.report;
    store.saveMap(result.map);
    setMap(result.map);
    state.gen = null;
    setTimeout(() => { if (!state.gen) $('progress').hidden = true; }, 4000);
    toast(result.report.failed.length ? 'Draft ready. Some checks need attention: see Quality checks.' : 'Draft ready. Nothing is checked until you check it.');
  } catch (err) {
    if (err.stage) stageStates[err.stage] = { state: 'failed', note: err.kind === 'aborted' ? 'cancelled' : undefined };
    renderStages(stageStates);
    if (err.declined) {
      showGenError(`The model declined this topic: ${err.message}`, false);
      state.gen = null;
    } else if (err instanceof ApiError) {
      if (err.kind === 'key') openSettings(err.message);
      showGenError(err.kind === 'aborted' ? 'Cancelled. Finished stages are kept; Retry carries on from here.' : err.message, true);
    } else {
      console.error(err);
      showGenError('Something went wrong while building the map. Finished stages are kept.', true);
    }
  } finally {
    setGenerating(false);
    updateCalls();
  }
}

function showGenError(text, canRetry) {
  $('gen-error-text').textContent = text;
  $('retry').hidden = !canRetry;
  $('gen-error').hidden = false;
}

function startGeneration(topic) {
  state.gen = { pipeline: new Pipeline(topic), stageStates: {}, abort: null };
  runPipeline();
}

// --- Settings ---
function openSettings(note) {
  const key = store.getKey();
  $('key').value = key;
  $('key').type = 'password';
  $('key-show').textContent = 'Show';
  $('key-show').setAttribute('aria-pressed', 'false');
  $('key-state').textContent = note || (key ? 'A key is set for this tab.' : 'No key set.');
  $('models').value = state.settings.models.join('\n');
  $('cap').value = state.settings.dailyCap;
  $('guess-first').checked = state.settings.guessFirst;
  $('theme').value = state.settings.theme;
  $('models-note').textContent = '';
  if (!$('settings').open) $('settings').showModal();
  $('key').focus();
}

function saveSettingsFromForm() {
  const key = $('key').value.trim();
  if (key && /\s/.test(key)) { toast('That key has spaces in it; check it and try again.'); return false; }
  store.setKey(key);
  const models = $('models').value.split(/\s*\n\s*/).map((m) => m.trim()).filter(Boolean);
  const cap = Math.max(1, Math.min(10000, parseInt($('cap').value, 10) || 50));
  store.saveSettings({ models: models.length ? models : DEFAULT_MODELS, dailyCap: cap, guessFirst: $('guess-first').checked, theme: $('theme').value });
  state.settings = store.getSettings();
  applyTheme();
  updateCalls();
  renderPanel();
  return true;
}

// --- Maps, import, export ---
function openMaps() {
  const list = $('maps-list');
  const maps = store.listMaps();
  list.replaceChildren(...(maps.length ? maps.map((m) => h('li', {},
    h('button', { type: 'button', class: 'open', onclick: () => {
      const map = store.loadMap(m.id);
      if (!map) { toast('That map could not be read.'); return; }
      $('maps').close();
      setMap(map);
    } }, m.topic),
    h('span', { class: 'when' }, `${m.count} concepts · ${new Date(m.updatedAt).toLocaleDateString()}`),
    h('button', { type: 'button', class: 'btn ghost danger', 'aria-label': `Delete map ${m.topic}`, onclick: () => {
      if (!confirm(`Delete the map “${m.topic}” from this browser? Export it first if you want to keep it.`)) return;
      store.deleteMap(m.id);
      if (state.map?.id === m.id) { state.map = null; state.selected = null; renderBoard(); renderPanel(); }
      openMaps();
    } }, 'Delete'),
  )) : [h('li', { class: 'fine' }, 'No saved maps yet.')]));
  $('import-note').textContent = '';
  if (!$('maps').open) $('maps').showModal();
}

function sanitizeMap(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.concepts)) throw new Error('This is not an exported map.');
  const s = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v, d) => (Number.isFinite(v) ? Math.max(-5000, Math.min(10000, v)) : d);
  const seen = new Set();
  const concepts = raw.concepts.slice(0, 200).map((c, i) => {
    let id = s(c?.id, 64) || uid('c');
    if (seen.has(id)) id = uid('c');
    seen.add(id);
    const origin = c?.origin === 'user' ? 'user' : 'ai';
    return {
      id, origin,
      name: s(c?.name, 120) || 'Untitled',
      group: s(c?.group, 60),
      explanation: s(c?.explanation), caveat: s(c?.caveat), question: s(c?.question),
      phrases: Array.isArray(c?.phrases) ? c.phrases.map((p) => s(p, 120)).filter(Boolean).slice(0, 3) : [],
      status: origin === 'user' ? 'added' : ['unchecked', 'checked', 'doubted'].includes(c?.status) ? c.status : 'unchecked',
      guess: s(c?.guess), revealed: !!c?.revealed, notes: s(c?.notes, 5000), flag: s(c?.flag, 200), refs: sanitizeRefs(c?.refs),
      x: num(c?.x, 100 + (i % 6) * 180), y: num(c?.y, 100 + Math.floor(i / 6) * 160),
    };
  });
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .filter((l) => seen.has(l?.from) && seen.has(l?.to) && l.from !== l.to)
    .slice(0, 600)
    .map((l) => ({
      id: uid('l'), from: l.from, to: l.to,
      relation: RELATIONS.includes(l.relation) ? l.relation : 'related to',
      status: ['unchecked', 'checked', 'doubted'].includes(l.status) ? l.status : 'unchecked',
      origin: l.origin === 'user' ? 'user' : 'ai',
    }));
  return {
    version: 1, id: uid('m'), topic: s(raw.topic, TOPIC_MAX) || 'Imported map',
    createdAt: Date.now(), updatedAt: Date.now(),
    models: Array.isArray(raw.models) ? raw.models.map((m) => s(m, 100)).slice(0, 10) : [],
    checks: null, concepts, links,
  };
}

function importMap() {
  try {
    const map = sanitizeMap(JSON.parse($('import-text').value));
    store.saveMap(map);
    $('import-text').value = '';
    $('maps').close();
    setMap(map);
    toast(`Imported “${map.topic}”.`);
  } catch (err) {
    $('import-note').textContent = err instanceof SyntaxError ? 'That text is not valid JSON.' : err.message;
  }
}

function exportJson() {
  const { id, ...rest } = state.map; // eslint-disable-line no-unused-vars
  return JSON.stringify({ app: 'concept-sketchbook', ...rest }, null, 2);
}

function openExport() {
  if (!state.map) return;
  $('export-text').value = exportJson();
  $('export-note').textContent = '';
  $('export-dlg').showModal();
}

// --- Wiring ---
function wire() {
  $('topic-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const topic = $('topic').value.trim().slice(0, TOPIC_MAX);
    if (!topic) return;
    if (!store.getKey()) {
      state.gen = { pipeline: new Pipeline(topic), stageStates: {}, abort: null };
      openSettings('Add an OpenRouter key to sketch your first map. It stays in this tab only.');
      return;
    }
    startGeneration(topic);
  });
  $('cancel').addEventListener('click', () => state.gen?.abort?.abort());
  $('retry').addEventListener('click', () => { if (state.gen) runPipeline(); });
  $('dismiss-error').addEventListener('click', () => { $('progress').hidden = true; });

  const examples = ['How vaccines train the immune system', 'Compound interest', 'The French Revolution', 'Recursion in programming', 'How sourdough rises', 'Contract law basics'];
  $('examples').replaceChildren(...examples.map((t) => h('button', { type: 'button', class: 'chip', onclick: () => { $('topic').value = t; $('topic').focus(); } }, t)));

  $('open-settings').addEventListener('click', () => openSettings());
  $('empty-key').addEventListener('click', () => openSettings());
  $('open-maps').addEventListener('click', openMaps);
  $('empty-maps').addEventListener('click', openMaps);
  $('key-show').addEventListener('click', () => {
    const show = $('key').type === 'password';
    $('key').type = show ? 'text' : 'password';
    $('key-show').textContent = show ? 'Hide' : 'Show';
    $('key-show').setAttribute('aria-pressed', String(show));
  });
  $('key-forget').addEventListener('click', () => { store.setKey(''); $('key').value = ''; $('key-state').textContent = 'Key forgotten.'; });
  $('signin').addEventListener('click', () => startSignIn().catch((e) => { $('key-state').textContent = e.message; }));
  $('models-reset').addEventListener('click', () => { $('models').value = DEFAULT_MODELS.join('\n'); });
  $('find-free').addEventListener('click', async () => {
    $('models-note').textContent = 'Looking up current free models…';
    try {
      const ids = await fetchFreeModels();
      if (!ids.length) { $('models-note').textContent = 'No free models with structured output were listed.'; return; }
      $('models').value = ['openrouter/free', ...ids.slice(0, 6)].join('\n');
      $('models-note').textContent = `${ids.length} free models support structured output; the first six are in the chain. Save to keep them.`;
    } catch (e) {
      $('models-note').textContent = `Could not reach OpenRouter (${e.message}).`;
    }
  });
  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue !== 'save') return;
    if (!saveSettingsFromForm()) return;
    toast('Settings saved.');
    // Carry on with a sketch that was waiting for a key.
    if (state.gen && !state.gen.abort && store.getKey()) runPipeline();
  });

  $('import').addEventListener('click', importMap);
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) { $('import-note').textContent = 'That file is too large for a map.'; return; }
    $('import-text').value = await file.text();
    $('import-note').textContent = `Loaded ${file.name}. Press Import.`;
  });
  $('export').addEventListener('click', openExport);
  $('copy-export').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('export-text').value); $('export-note').textContent = 'Copied.'; }
    catch { $('export-text').select(); $('export-note').textContent = 'Press Ctrl+C or ⌘C to copy.'; }
  });
  $('download-export').addEventListener('click', () => {
    const blob = new Blob([$('export-text').value], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${state.map.topic.replace(/[^\w-]+/g, '-').slice(0, 50) || 'map'}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('add-concept').addEventListener('click', addConcept);
  $('zoom-in').addEventListener('click', () => mapView.zoom(0.8));
  $('zoom-out').addEventListener('click', () => mapView.zoom(1.25));
  $('zoom-fit').addEventListener('click', () => mapView.fit());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selected && !document.querySelector('dialog[open]')) select(null);
  });
}

async function init() {
  applyTheme();
  wire();
  updateCalls();
  try {
    const key = await finishSignIn();
    if (key) { store.setKey(key); toast('Signed in with OpenRouter. The key is kept for this tab only.'); }
  } catch (e) {
    toast(e.message);
  }
  const last = store.listMaps()[0];
  const map = last && store.loadMap(last.id);
  if (map) setMap(map);
  else renderBoard();
}

init();
