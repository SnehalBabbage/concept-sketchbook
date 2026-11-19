// SVG rendering of the map: pencil-style marks, drag, pan, zoom and keyboard moves.
import { WIDTH, HEIGHT } from './layout.js?v=32d83d848e';

const NS = 'http://www.w3.org/2000/svg';
const R = 22; // concept circle radius
const D = 27; // user diamond half-size

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function wrap(name, max = 18) {
  const words = String(name).split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if ((cur + ' ' + w).length <= max) lines[lines.length - 1] = cur + ' ' + w;
    else lines.push(w);
  }
  if (lines.length > 2) lines.splice(2, lines.length, lines[1] + '…');
  return lines.map((l) => (l.length > max + 4 ? l.slice(0, max + 2) + '…' : l));
}

const STATUS_WORD = { unchecked: 'draft, unchecked', checked: 'checked by you', doubted: 'doubted by you', added: 'added by you' };
const GLYPH = { unchecked: '?', checked: '✓', doubted: '!', added: '+' };

export function createMapView(svg, { onSelect, onMoved }) {
  const view = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
  let map = null;
  let refs = { nodes: new Map(), links: new Map() };
  const groupClass = new Map();

  const defs = el('defs');
  for (const kind of ['plain', 'doubted', 'mine']) {
    const m = el('marker', { id: `arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M0 1 L10 5 L0 9 z', class: `arrow ${kind}` }));
    defs.append(m);
  }
  const linkLayer = el('g', { class: 'links' });
  const nodeLayer = el('g', { class: 'nodes' });
  svg.append(defs, linkLayer, nodeLayer);

  const applyView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  applyView();

  const toSvg = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };

  const byId = (id) => map.concepts.find((c) => c.id === id);
  const radius = (c) => (c.origin === 'user' ? D * 0.8 : R);

  function linkGeometry(l) {
    const a = byId(l.from);
    const b = byId(l.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const x1 = a.x + ux * (radius(a) + 3);
    const y1 = a.y + uy * (radius(a) + 3);
    const x2 = b.x - ux * (radius(b) + 6);
    const y2 = b.y - uy * (radius(b) + 6);
    return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 - 4 };
  }

  function positionNode(c) {
    refs.nodes.get(c.id)?.setAttribute('transform', `translate(${c.x} ${c.y})`);
  }
  function positionLink(l) {
    const r = refs.links.get(l.id);
    if (!r) return;
    const g = linkGeometry(l);
    r.hit.setAttribute('d', g.d);
    r.path.setAttribute('d', g.d);
    r.rel.setAttribute('x', g.mx.toFixed(1));
    r.rel.setAttribute('y', g.my.toFixed(1));
  }
  function moveConcept(c, x, y) {
    c.x = Math.round(x);
    c.y = Math.round(y);
    positionNode(c);
    for (const l of map.links) if (l.from === c.id || l.to === c.id) positionLink(l);
  }

  function render(next, selected) {
    map = next;
    linkLayer.replaceChildren();
    nodeLayer.replaceChildren();
    refs = { nodes: new Map(), links: new Map() };
    groupClass.clear();
    for (const c of map.concepts) if (!groupClass.has(c.group)) groupClass.set(c.group, `g${(groupClass.size % 6) + 1}`);

    for (const l of map.links) {
      const a = byId(l.from);
      const b = byId(l.to);
      if (!a || !b) continue;
      const mine = l.origin === 'user';
      const status = l.status === 'doubted' ? 'doubted' : l.status === 'checked' ? 'checked' : 'unchecked';
      const g = el('g', {
        class: `link ${status}${mine ? ' mine' : ''}${selected?.type === 'link' && selected.id === l.id ? ' selected' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': `Link: ${a.name} ${l.relation} ${b.name}. ${mine ? 'Added by you' : status === 'doubted' ? 'Doubted by you' : status === 'checked' ? 'Checked by you' : 'Draft'}.`,
      });
      const hit = el('path', { class: 'hit' });
      const path = el('path', { class: 'path', 'marker-end': `url(#arrow-${status === 'doubted' ? 'doubted' : mine ? 'mine' : 'plain'})` });
      const rel = el('text', { class: 'rel' }, l.relation);
      g.append(hit, path, rel);
      g.addEventListener('click', () => onSelect({ type: 'link', id: l.id }));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ type: 'link', id: l.id }); }
      });
      linkLayer.append(g);
      refs.links.set(l.id, { g, hit, path, rel });
      positionLink(l);
    }

    for (const c of map.concepts) {
      const status = c.origin === 'user' ? 'added' : c.status;
      const g = el('g', {
        class: `node ${status}${c.flag ? ' flagged' : ''}${selected?.type === 'concept' && selected.id === c.id ? ' selected' : ''}`,
        tabindex: 0,
        role: 'button',
        'aria-label': `Concept: ${c.name}. ${STATUS_WORD[status]}. Group: ${c.group || 'none'}.${c.flag ? ' Flagged.' : ''}`,
        'data-id': c.id,
      });
      const gc = groupClass.get(c.group);
      if (c.origin === 'user') {
        g.append(el('path', { class: 'halo', d: `M0 ${-D - 5} L${D + 5} 0 L0 ${D + 5} L${-D - 5} 0z` }));
        g.append(el('path', { class: `shape ${gc}`, d: `M0 ${-D} L${D} 0 L0 ${D} L${-D} 0z` }));
      } else {
        g.append(el('circle', { class: 'halo', r: R + 5 }));
        g.append(el('circle', { class: `shape ${gc}`, r: R }));
      }
      g.append(el('text', { class: 'glyph', y: 1 }, GLYPH[status]));
      if (c.flag) g.append(el('text', { class: 'flag', x: R - 2, y: -R + 4 }, '⚑'));
      const lines = wrap(c.name);
      const label = el('text', { class: 'label', y: R + 22 });
      lines.forEach((line, i) => label.append(el('tspan', { x: 0, dy: i ? 20 : 0 }, line)));
      g.append(label);
      attachNodeHandlers(g, c);
      nodeLayer.append(g);
      refs.nodes.set(c.id, g);
      positionNode(c);
    }
  }

  function attachNodeHandlers(g, c) {
    let start = null;
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const p = toSvg(e);
      start = { px: p.x, py: p.y, cx: c.x, cy: c.y, moved: false };
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = toSvg(e);
      const dx = p.x - start.px;
      const dy = p.y - start.py;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      moveConcept(c, start.cx + dx, start.cy + dy);
    });
    const end = () => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      if (moved) onMoved(c);
      else onSelect({ type: 'concept', id: c.id });
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', () => { start = null; });
    g.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 50 : 10;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ type: 'concept', id: c.id }); }
      else if (moves[e.key]) {
        e.preventDefault();
        moveConcept(c, c.x + moves[e.key][0], c.y + moves[e.key][1]);
        onMoved(c);
      }
    });
  }

  // Pan on the background, zoom with the wheel or a pinch.
  const pointers = new Map();
  let pan = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.link')) return; // let link clicks through
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('panning');
    } else {
      pan = null;
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0) zoomAt(before / after, { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      return;
    }
    if (!pan) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.max(view.w / rect.width, view.h / rect.height);
    view.x = pan.vx - (e.clientX - pan.x) * scale;
    view.y = pan.vy - (e.clientY - pan.y) * scale;
    applyView();
  });
  const endPan = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) { pan = null; svg.classList.remove('panning'); }
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(Math.exp(e.deltaY * 0.0015), e);
  }, { passive: false });

  function zoomAt(factor, evt) {
    const nw = Math.min(WIDTH * 4, Math.max(250, view.w * factor));
    const f = nw / view.w;
    const p = evt ? toSvg(evt) : { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    view.x = p.x - (p.x - view.x) * f;
    view.y = p.y - (p.y - view.y) * f;
    view.w *= f;
    view.h *= f;
    applyView();
  }

  function fit() {
    if (!map?.concepts.length) return;
    const xs = map.concepts.map((c) => c.x);
    const ys = map.concepts.map((c) => c.y);
    const pad = 80;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(400, Math.max(...xs) - minX + pad);
    const h = Math.max(300, Math.max(...ys) - minY + pad + 30);
    Object.assign(view, { x: minX, y: minY, w, h });
    applyView();
  }

  function focusConcept(id) {
    refs.nodes.get(id)?.focus();
  }

  function centre() {
    return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  }

  return { render, fit, zoom: (f) => zoomAt(f), focusConcept, centre };
}
