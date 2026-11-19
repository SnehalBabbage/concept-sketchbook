// A small deterministic force layout. Runs once after generation; the learner drags from there.

export const WIDTH = 1400;
export const HEIGHT = 950;

export function layout(concepts, links) {
  const n = concepts.length;
  if (!n) return;
  const groups = [...new Set(concepts.map((c) => c.group))];
  const index = new Map(concepts.map((c, i) => [c.id, i]));

  // Seed: each group gets a sector of a ring, so groups start near each other.
  const pos = concepts.map((c, i) => {
    const g = groups.indexOf(c.group);
    const inGroup = concepts.filter((d) => d.group === c.group);
    const k = inGroup.indexOf(c);
    const a = (2 * Math.PI * g) / groups.length + (k / Math.max(1, inGroup.length)) * (1.6 / groups.length) + i * 0.001;
    const r = 260 + (k % 3) * 70;
    return { x: WIDTH / 2 + Math.cos(a) * r * 1.3, y: HEIGHT / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
  });

  const edges = links.map((l) => [index.get(l.from), index.get(l.to)]).filter(([a, b]) => a != null && b != null);
  const ideal = 190;

  for (let step = 0; step < 450; step++) {
    const cool = 1 - step / 450;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = 42000 / d2;
        const d = Math.sqrt(d2);
        pos[i].vx += (dx / d) * f; pos[i].vy += (dy / d) * f;
        pos[j].vx -= (dx / d) * f; pos[j].vy -= (dy / d) * f;
      }
    }
    for (const [a, b] of edges) {
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - ideal) * 0.05;
      pos[a].vx += (dx / d) * f; pos[a].vy += (dy / d) * f;
      pos[b].vx -= (dx / d) * f; pos[b].vy -= (dy / d) * f;
    }
    for (const p of pos) {
      p.vx += (WIDTH / 2 - p.x) * 0.004;
      p.vy += (HEIGHT / 2 - p.y) * 0.006; // flatter than tall, to suit wide screens
      const max = 30 * cool + 1;
      p.x += Math.max(-max, Math.min(max, p.vx));
      p.y += Math.max(-max, Math.min(max, p.vy));
      p.vx *= 0.5; p.vy *= 0.5;
    }
  }

  // Fit into the canvas with a margin.
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const m = 90;
  const sx = (WIDTH - 2 * m) / Math.max(1, maxX - minX);
  const sy = (HEIGHT - 2 * m) / Math.max(1, maxY - minY);
  const s = Math.min(sx, sy, 1.4);
  concepts.forEach((c, i) => {
    c.x = Math.round(m + (pos[i].x - minX) * s + (WIDTH - 2 * m - (maxX - minX) * s) / 2);
    c.y = Math.round(m + (pos[i].y - minY) * s + (HEIGHT - 2 * m - (maxY - minY) * s) / 2);
  });
}

// A free spot for a concept the learner adds: near the centre of the view, away from others.
export function freeSpot(concepts, near) {
  const cx = near?.x ?? WIDTH / 2;
  const cy = near?.y ?? HEIGHT / 2;
  for (let r = 0; r < 600; r += 40) {
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 6) {
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (concepts.every((c) => (c.x - x) ** 2 + (c.y - y) ** 2 > 110 ** 2)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return { x: Math.round(cx + 60), y: Math.round(cy + 60) };
}
