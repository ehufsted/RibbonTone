// Fabrication: combs to cut, angle lists for pins, a wall template, and the
// calibration comb. Geometry first (DOM-free shapes in mm), then writers for
// SVG and DXF, so both files always hold the same thing.
//
// A COMB is a strip seen from ABOVE, its long side along the wall: x runs as
// on the piece (left to right as the viewer sees it), y runs from the wall side
// (top of the drawing) to the viewer's side (bottom; "FRONT" is engraved
// there). Each ribbon passes through a slot w + clearance long, rotated to the
// ribbon's angle: the ribbon's cross-section runs along (cos θ, −sin θ) in
// (x, z), and with y = z that is the slot's direction in the drawing. Because
// both faces are white, the slot's angle is θ mod 180°: the twist between rows
// (its size and direction) is in the build sheet, not the comb.
//
// A comb longer than the cutter's bed is cut into pieces at the midpoints
// between ribbons; "split" cuts every comb along its centre line as well, so
// the ribbons can be laid into the notches instead of threaded.
//
// Layers: CUT (red in SVG, colour 1 in DXF) and ENGRAVE (blue, colour 5):
// ribbon numbers, the row label, and the FRONT mark.

const RAD = Math.PI / 180;
export const mod180 = (a) => ((a % 180) + 180) % 180;

/** The slot's rectangle, centred on (cx, cy), along the ribbon's cross-section. */
export function slotRect(cx, cy, th, s) {
  const L = s.ribbonW + s.slotClear, Wd = Math.max(s.minSlot, s.thickness + s.slotClear);
  const ux = Math.cos(th * RAD), uy = -Math.sin(th * RAD);
  const vx = -uy, vy = ux;
  const a = L / 2, b = Wd / 2;
  return [
    [cx - a * ux - b * vx, cy - a * uy - b * vy],
    [cx + a * ux - b * vx, cy + a * uy - b * vy],
    [cx + a * ux + b * vx, cy + a * uy + b * vy],
    [cx - a * ux + b * vx, cy - a * uy + b * vy],
  ];
}

/** The comb's depth (front to back). */
export const combDepth = (s) => s.ribbonW + s.slotClear + 2 * s.combMargin;

/**
 * One comb row as pieces.
 * @param {number[]} xs  ribbon centres on the piece, mm
 * @param {number[]} angles  degrees, one per ribbon
 * @param {string[]} labels  engraved beside each slot
 * @param {string} title  engraved at the left end
 * @returns {{pieces: {w, h, cuts, engrave, name}[], web: number}}  web: the
 *   least material between two slots in this row, mm
 */
export function combRow(xs, angles, labels, title, s) {
  const D = combDepth(s);
  const x0 = xs[0] - s.combEnd, total = xs[xs.length - 1] - xs[0] + 2 * s.combEnd;
  const slots = xs.map((x, i) => slotRect(x - x0, D / 2, angles[i], s));
  let web = Infinity;
  for (let i = 0; i + 1 < slots.length; i++) web = Math.min(web, polyDistance(slots[i], slots[i + 1]));
  const cutsAt = splitPoints(xs.slice(1).map((x, i) => (xs[i] + x) / 2 - x0), total, s.bedMm);
  const pieces = [];
  for (let p = 0; p + 1 < cutsAt.length; p++) {
    const a = cutsAt[p], b = cutsAt[p + 1], w = b - a;
    const cuts = [{ kind: 'poly', pts: [[0, 0], [w, 0], [w, D], [0, D]] }];
    const engrave = [];
    xs.forEach((x, i) => {
      const cx = x - x0;
      if (cx < a || cx >= b) return;
      cuts.push({ kind: 'poly', pts: slots[i].map(([px, py]) => [px - a, py]) });
      engrave.push({ x: cx - a, y: D - 1.5, h: Math.min(3, s.combMargin * 0.45), text: labels[i], anchor: 'middle' });
    });
    if (p === 0) cuts.push({ kind: 'circle', cx: s.combEnd / 2, cy: D / 2, r: s.holeDia / 2 });
    if (p === cutsAt.length - 2) cuts.push({ kind: 'circle', cx: w - s.combEnd / 2, cy: D / 2, r: s.holeDia / 2 });
    if (s.splitComb) cuts.push({ kind: 'line', x1: 0, y1: D / 2, x2: w, y2: D / 2 });
    const name = cutsAt.length > 2 ? `${title} ${String.fromCharCode(97 + p)}` : title;
    engrave.push({ x: 2, y: Math.min(3.5, s.combMargin * 0.6), h: Math.min(3, s.combMargin * 0.45), text: name, anchor: 'start' });
    // at the left end, under the title: the slots' labels run along the front edge
    engrave.push({ x: 2, y: D - 1.5, h: Math.min(3, s.combMargin * 0.45), text: 'FRONT', anchor: 'start' });
    pieces.push({ w, h: D, cuts, engrave, name });
  }
  return { pieces, web };
}

/**
 * Where to cut a comb `total` long into pieces no longer than `bed`, at the
 * given candidate points (midpoints between ribbons): as few pieces as the bed
 * allows, each cut at the candidate nearest an equal share, falling back to
 * cutting as late as possible when equal shares do not fit.
 * @returns {number[]}  0, the cuts, total
 */
export function splitPoints(mids, total, bed) {
  if (total <= bed) return [0, total];
  const k = Math.ceil(total / bed);
  const even = [0];
  for (let m = 1; m < k; m++) {
    const want = (m * total) / k;
    let best = null;
    for (const c of mids) if (c > even[even.length - 1] && (best === null || Math.abs(c - want) < Math.abs(best - want))) best = c;
    if (best !== null) even.push(best);
  }
  even.push(total);
  if (even.every((v, i) => i === 0 || v - even[i - 1] <= bed + 1e-9)) return even;
  const out = [0];
  let start = 0;
  mids.forEach((mid, i) => {
    const next = i + 1 < mids.length ? mids[i + 1] : total;
    if (next - start > bed && mid > start) { out.push(mid); start = mid; }
  });
  out.push(total);
  return out;
}

/** Every comb of a plan: one row per shared bracket height, bars included. */
export function planCombs(plan) {
  const s = plan.s, xs = plan.ribbons.map((r) => r.x);
  const labels = plan.ribbons.map((r, i) => String(i + 1));
  const rows = plan.rows || [];
  let web = Infinity;
  const all = [];
  rows.forEach((y, k) => {
    const angles = plan.ribbons.map((r) => r.knots[k].a);
    const title = k === 0 ? 'TOP BAR' : k === rows.length - 1 ? 'BOTTOM BAR' : `ROW ${k} @ ${Math.round(y)}`;
    const row = combRow(xs, angles, labels, title, s);
    web = Math.min(web, row.web);
    all.push(...row.pieces);
  });
  return { pieces: all, web };
}

/** The calibration comb: one slot per test angle, at the design pitch. Cut two. */
export function calibrationCombs(s, step = 15) {
  const angles = [];
  for (let a = -90; a <= 90 + 1e-9; a += step) angles.push(a);
  const xs = angles.map((_, i) => i * s.pitch);
  const labels = angles.map((a) => `${a > 0 ? '+' : ''}${Math.round(a)}`);
  const top = combRow(xs, angles, labels, 'CAL TOP', { ...s, bedMm: Infinity });
  const bot = combRow(xs, angles, labels, 'CAL BOTTOM', { ...s, bedMm: Infinity });
  return { pieces: [...top.pieces, ...bot.pieces], angles, web: top.web };
}

/** Pieces stacked down a sheet, `gap` apart; returns placements and the sheet size. */
export function stackPieces(pieces, gap = 4) {
  let y = 0, w = 0;
  const placed = pieces.map((p) => { const at = { p, x: 0, y }; y += p.h + gap; w = Math.max(w, p.w); return at; });
  return { placed, W: w, H: Math.max(0, y - gap) };
}

// ---------------------------------------------------------------- writers
const f2 = (v) => (Math.abs(v) < 5e-5 ? '0' : (Math.round(v * 1e4) / 1e4).toString());
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Placed pieces as an SVG in mm: CUT in red hairlines, ENGRAVE text in blue. */
export function piecesSVG(sheet, title = 'RibbonTone') {
  const { placed, W, H } = sheet;
  const m = 2;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f2(W + 2 * m)}mm" height="${f2(H + 2 * m)}mm" viewBox="${f2(-m)} ${f2(-m)} ${f2(W + 2 * m)} ${f2(H + 2 * m)}">\n` +
    `<title>${esc(title)}</title>\n<g id="CUT" fill="none" stroke="#ff0000" stroke-width="0.1">\n`;
  for (const { p, x, y } of placed) {
    for (const c of p.cuts) out += shapeSVG(c, x, y);
  }
  out += '</g>\n<g id="ENGRAVE" fill="#0000ff" stroke="none" font-family="sans-serif">\n';
  for (const { p, x, y } of placed) {
    for (const t of p.engrave) {
      out += `<text x="${f2(x + t.x)}" y="${f2(y + t.y)}" font-size="${f2(t.h)}" text-anchor="${t.anchor === 'middle' ? 'middle' : 'start'}">${esc(t.text)}</text>\n`;
    }
  }
  return out + '</g>\n</svg>\n';
}

function shapeSVG(c, x, y) {
  if (c.kind === 'circle') return `<circle cx="${f2(x + c.cx)}" cy="${f2(y + c.cy)}" r="${f2(c.r)}"/>\n`;
  if (c.kind === 'line') return `<line x1="${f2(x + c.x1)}" y1="${f2(y + c.y1)}" x2="${f2(x + c.x2)}" y2="${f2(y + c.y2)}"/>\n`;
  return `<path d="M${c.pts.map(([px, py]) => `${f2(x + px)} ${f2(y + py)}`).join(' L')} Z"/>\n`;
}

const pair = (code, value) => `${code}\n${value}\n`;

/**
 * Placed pieces as AutoCAD R12 DXF, in mm. DXF's y runs up, so y becomes
 * H − y (written as-is the combs would come out mirrored, slot angles and
 * text included). Text is TEXT entities on ENGRAVE.
 */
export function piecesDXF(sheet) {
  const { placed, W, H } = sheet;
  const X = (v) => f2(v), Y = (v) => f2(H - v);
  let s = pair(0, 'SECTION') + pair(2, 'HEADER') + pair(9, '$ACADVER') + pair(1, 'AC1009') +
    pair(9, '$INSUNITS') + pair(70, 4) + pair(9, '$EXTMIN') + pair(10, 0) + pair(20, 0) +
    pair(9, '$EXTMAX') + pair(10, f2(W)) + pair(20, f2(H)) + pair(0, 'ENDSEC');
  s += pair(0, 'SECTION') + pair(2, 'TABLES') + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, 2) +
    pair(0, 'LAYER') + pair(2, 'CUT') + pair(70, 0) + pair(62, 1) + pair(6, 'CONTINUOUS') +
    pair(0, 'LAYER') + pair(2, 'ENGRAVE') + pair(70, 0) + pair(62, 5) + pair(6, 'CONTINUOUS') +
    pair(0, 'ENDTAB') + pair(0, 'ENDSEC');
  s += pair(0, 'SECTION') + pair(2, 'ENTITIES');
  for (const { p, x, y } of placed) {
    for (const c of p.cuts) {
      if (c.kind === 'circle') {
        s += pair(0, 'CIRCLE') + pair(8, 'CUT') + pair(10, X(x + c.cx)) + pair(20, Y(y + c.cy)) + pair(30, 0) + pair(40, f2(c.r));
      } else if (c.kind === 'line') {
        s += pair(0, 'LINE') + pair(8, 'CUT') + pair(10, X(x + c.x1)) + pair(20, Y(y + c.y1)) + pair(30, 0) +
          pair(11, X(x + c.x2)) + pair(21, Y(y + c.y2)) + pair(31, 0);
      } else {
        s += pair(0, 'POLYLINE') + pair(8, 'CUT') + pair(66, 1) + pair(70, 1) + pair(10, 0) + pair(20, 0) + pair(30, 0);
        for (const [px, py] of c.pts) s += pair(0, 'VERTEX') + pair(8, 'CUT') + pair(10, X(x + px)) + pair(20, Y(y + py)) + pair(30, 0);
        s += pair(0, 'SEQEND') + pair(8, 'CUT');
      }
    }
    for (const t of p.engrave) {
      const mid = t.anchor === 'middle';
      s += pair(0, 'TEXT') + pair(8, 'ENGRAVE') + pair(10, X(x + t.x)) + pair(20, Y(y + t.y)) + pair(30, 0) +
        pair(40, f2(t.h)) + pair(1, t.text) + (mid ? pair(72, 1) + pair(11, X(x + t.x)) + pair(21, Y(y + t.y)) + pair(31, 0) : '');
    }
  }
  return s + pair(0, 'ENDSEC') + pair(0, 'EOF');
}

// ---------------------------------------------------------------- pins
/**
 * Every bracket of a plan, top bar to bottom bar, ribbon by ribbon: what the
 * pin list, the build sheet and the wall template read.
 *   slot: θ mod 180 (the angle to fix);  turn: signed degrees of twist since
 *   the bracket above (+ = clockwise seen from above, the face turning right)
 */
export function bracketList(plan) {
  const out = [];
  plan.ribbons.forEach((r, i) => {
    r.knots.forEach((k, b) => {
      out.push({
        ribbon: i + 1, x: r.x, bracket: b, y: k.y, slot: mod180(k.a),
        turn: b ? k.a - r.knots[b - 1].a : 0,
        kind: b === 0 ? 'top bar' : b === r.knots.length - 1 ? 'bottom bar' : 'bracket',
      });
    });
  });
  return out;
}

/** The bracket list as CSV, lengths in the chosen units. */
export function bracketCSV(plan, units = 'mm') {
  const k = units === 'in' ? 1 / 25.4 : 1, dp = units === 'in' ? 3 : 1;
  const rows = [`ribbon,x_${units},bracket,kind,y_from_top_${units},slot_angle_deg,turn_from_above_deg,turn_direction`];
  for (const b of bracketList(plan)) {
    const dir = b.bracket === 0 ? '' : Math.abs(b.turn) < 0.05 ? 'none' : b.turn > 0 ? 'clockwise from above' : 'counterclockwise from above';
    rows.push([b.ribbon, (b.x * k).toFixed(dp), b.bracket, b.kind, (b.y * k).toFixed(dp), b.slot.toFixed(1), b.turn.toFixed(1), dir].join(','));
  }
  return rows.join('\n') + '\n';
}

/**
 * A 1:1 wall template (SVG, mm): the piece's outline, each ribbon's centre
 * line, and at every bracket a cross with a dial showing the slot angle as
 * seen from above (needle along the slot, the wall at the dial's top).
 */
export function wallTemplateSVG(plan) {
  const { W, H } = plan.piece, s = plan.s;
  const r = Math.min(8, s.pitch * 0.3);
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f2(W)}mm" height="${f2(H)}mm" viewBox="0 0 ${f2(W)} ${f2(H)}">\n` +
    `<title>RibbonTone wall template</title>\n<g fill="none" stroke="#000" stroke-width="0.3">\n<rect x="0" y="0" width="${f2(W)}" height="${f2(H)}"/>\n`;
  for (const rb of plan.ribbons) out += `<line x1="${f2(rb.x)}" y1="0" x2="${f2(rb.x)}" y2="${f2(H)}" stroke="#999" stroke-dasharray="2 2"/>\n`;
  out += '</g>\n<g font-family="sans-serif" font-size="3">\n';
  for (const b of bracketList(plan)) {
    const ux = Math.cos(b.slot * RAD), uy = -Math.sin(b.slot * RAD);
    out += `<g transform="translate(${f2(b.x)} ${f2(b.y)})" stroke="#000" stroke-width="0.25" fill="none">` +
      `<circle r="${f2(r)}"/><line x1="${f2(-r)}" y1="0" x2="${f2(r)}" y2="0" stroke="#bbb"/>` +
      `<line x1="${f2(-r * ux)}" y1="${f2(-r * uy)}" x2="${f2(r * ux)}" y2="${f2(r * uy)}" stroke-width="0.6"/></g>\n` +
      `<text x="${f2(b.x + r + 1)}" y="${f2(b.y + 1)}">${b.ribbon}.${b.bracket} ${b.slot.toFixed(0)}°${b.bracket ? ` ${b.turn >= 0 ? '↻' : '↺'}${Math.abs(b.turn).toFixed(0)}` : ''}</text>\n`;
  }
  return out + '</g>\n</svg>\n';
}

// ------------------------------------------------------------ geometry
/** Least distance between two convex polygons (0 if they overlap). */
export function polyDistance(A, B) {
  if (overlaps(A, B)) return 0;
  let d = Infinity;
  for (const p of A) for (let i = 0; i < B.length; i++) d = Math.min(d, segDist(p, B[i], B[(i + 1) % B.length]));
  for (const p of B) for (let i = 0; i < A.length; i++) d = Math.min(d, segDist(p, A[i], A[(i + 1) % A.length]));
  return d;
}

function segDist([px, py], [ax, ay], [bx, by]) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
  return Math.hypot(px - ax - t * ex, py - ay - t * ey);
}

/** Separating-axis test for two convex polygons. */
function overlaps(A, B) {
  for (const P of [A, B]) {
    for (let i = 0; i < P.length; i++) {
      const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length];
      const nx = by - ay, ny = ax - bx;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of A) { const v = x * nx + y * ny; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
      for (const [x, y] of B) { const v = x * nx + y * ny; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}
