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
// DEPTH, PER ROW. A comb is as deep as its own row needs: the farthest any of
// its slots reaches in front of or behind the ribbons' line, plus the margin
// on each side. Rows of near face-on ribbons are slim. Every comb is centred
// on the ribbons' line, so only the deepest touches the box's back wall.
//
// ENDS. Each comb ends in tabs that plug into slots in the box's side panels
// (sidePanelPiece), which so also set the row heights.
//
// A comb longer than the cutter's bed is cut into pieces at the midpoints
// between ribbons. "Split" cuts every comb in two, front and back, along a
// zigzag: through each slot along its length, then up to a peak between
// ribbons. The back half so has a V at every ribbon whose sides lead down into
// the half-slot, so a ribbon laid in from the front settles in place before
// the front half closes over it. Peaks stop short of the front edge by the
// larger of the least web and half the margin.
//
// Layers: CUT (red in SVG, colour 1 in DXF) and ENGRAVE (blue, colour 5):
// ribbon numbers, the row label, and the FRONT mark.
//
// A PIN CLIP holds one bracket when each ribbon has its own heights: a flat T
// cut from the same sheet, lying level. Its crossbar is a narrow clip around
// the slot (clipWall on every side), turned to the ribbon's angle; its stem
// runs straight back to the wall, through the box's back panel as a tab (the
// back panel gets a matching slot), and ends inside the clip's wall, half that
// wall short of the slot at any angle. Seen from above it is drawn like a comb: wall at the
// top, viewer at the bottom.

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

/** The deepest any comb can be: a slot turned straight front to back, plus the margins. */
export const combDepth = (s) => s.ribbonW + s.slotClear + 2 * s.combMargin;

/** How far a slot at angle th reaches in front of (or behind) the ribbons' line. */
export function slotReach(th, s) {
  const L = s.ribbonW + s.slotClear, Wd = Math.max(s.minSlot, s.thickness + s.slotClear);
  return (L / 2) * Math.abs(Math.sin(th * RAD)) + (Wd / 2) * Math.abs(Math.cos(th * RAD));
}

/**
 * Where every comb starts and ends on the piece: `combEnd` beyond the farthest
 * the outer ribbons' slots can reach sideways (half a slot, face-on). One
 * length for all rows, since every comb's tabs plug into the same side panels.
 */
export function combEnds(xs, s) {
  const reach = (s.ribbonW + s.slotClear) / 2 + s.combEnd;
  return [xs[0] - reach, xs[xs.length - 1] + reach];
}

/** A comb row's depth: its farthest-reaching slot, plus the margin front and back. */
export const rowDepth = (angles, s) => 2 * Math.max(...angles.map((a) => slotReach(a, s))) + 2 * s.combMargin;

/**
 * The tabs at each end of a comb: [centre (from the back edge), width]. One in
 * the middle, or one per half of a split comb.
 */
export function combTabs(D, s) {
  // material kept beside each tab: the least web (2 mm at least), shrinking on
  // a slim comb so a tab always keeps at least half its strip
  const keep = (strip) => Math.min(Math.max(2, s.minWeb), strip / 4);
  return s.splitComb
    ? [[D / 4, Math.min(10, D / 2 - 2 * keep(D / 2))], [(3 * D) / 4, Math.min(10, D / 2 - 2 * keep(D / 2))]]
    : [[D / 2, Math.min(12, D - 2 * keep(D))]];
}

/**
 * One comb row laid out in its own frame: x from the comb's left end (tabs
 * excluded), y from the back edge (0) to the front (D), slots on y = D/2.
 * @returns {{D, x0, total, slots, zig, tabs}}
 *   x0: the comb's left end on the piece; zig: the split's cut as segments
 *   {p, q, air} (air: inside a slot, nothing to cut), [] unless split
 */
export function combLayout(xs, angles, s) {
  const D = rowDepth(angles, s);
  const [x0, x1] = combEnds(xs, s), total = x1 - x0;
  const cx = xs.map((x) => x - x0);
  const slots = cx.map((x, i) => slotRect(x, D / 2, angles[i], s));
  const zig = s.splitComb ? zigzag(cx, angles, D, total, s) : [];
  return { D, x0, total, slots, zig, tabs: combTabs(D, s) };
}

/**
 * The split comb's cut: through each slot along its length, peaks between
 * ribbons. A leg between a slot's end and a peak must not cut back through the
 * slot: a steep slot's back end lies below the slot and its peak above, so
 * there the cut first runs straight on out of the slot's end (a dogleg, at
 * least the least web long) before it turns toward the peak.
 */
function zigzag(cx, angles, D, total, s) {
  const zc = D / 2, peakY = D - Math.max(s.minWeb, s.combMargin / 2), half = (s.ribbonW + s.slotClear) / 2;
  const segs = [];
  const n = cx.length, pitch = n > 1 ? cx[1] - cx[0] : s.pitch;
  let prev = [0, zc];
  const go = (q, air = false) => {
    if (Math.hypot(q[0] - prev[0], q[1] - prev[1]) < 1e-12) return;
    segs.push({ p: prev, q, air }); prev = q;
  };
  const d = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  if (cx[0] - pitch / 2 > 1) go([cx[0] - pitch / 2, peakY]);
  for (let i = 0; i < n; i++) {
    const ux = Math.cos(angles[i] * RAD), uy = -Math.sin(angles[i] * RAD);
    const ea = [cx[i] - half * ux, zc - half * uy], eb = [cx[i] + half * ux, zc + half * uy];
    const after = i + 1 < n ? [(cx[i] + cx[i + 1]) / 2, peakY] : (cx[i] + pitch / 2 < total - 1 ? [cx[i] + pitch / 2, peakY] : [total, zc]);
    const [e1, e2] = d(prev, ea) + d(eb, after) <= d(prev, eb) + d(ea, after) ? [ea, eb] : [eb, ea];
    const slot = slotRect(cx[i], zc, angles[i], s);
    const v1 = dogleg(e1, [cx[i], zc], prev, slot, D, total, s);
    const v2 = dogleg(e2, [cx[i], zc], after, slot, D, total, s);
    go(v1);
    go(e1);
    go(e2, true);
    go(v2);
    go(after);
  }
  if (prev[0] < total) go([total, zc]);
  return segs;
}

/**
 * Where the cut turns after leaving slot end e toward `far`: e itself if the
 * straight leg clears the slot, or the nearest point straight on from e (at
 * least the least web out, half-millimetre steps) from which it does.
 */
function dogleg(e, centre, far, slot, D, total, s) {
  let ox = e[0] - centre[0], oy = e[1] - centre[1];
  const l = Math.hypot(ox, oy) || 1;
  ox /= l; oy /= l;
  const keep = s.minWeb;
  const inComb = (v) => v[1] >= keep && v[1] <= D - keep && v[0] >= 0 && v[0] <= total;
  const clears = (v, dd) => {
    const L = Math.hypot(far[0] - v[0], far[1] - v[1]) || 1, t = 1e-3 / L;
    const start = [v[0] + (far[0] - v[0]) * t, v[1] + (far[1] - v[1]) * t];
    const dist = polyDistance([start, far], slot);
    return dd === 0 ? dist > 0 : dist >= Math.min(dd, keep) - 1e-9;
  };
  if (clears(e, 0)) return e;
  let best = e;
  for (let dd = keep; dd < D; dd += 0.5) {
    const v = [e[0] + ox * dd, e[1] + oy * dd];
    if (!inComb(v)) break;
    best = v;
    if (clears(v, dd)) return v;
  }
  return best;
}

/**
 * One comb row as pieces.
 * @param {number[]} xs  ribbon centres on the piece, mm
 * @param {number[]} angles  degrees, one per ribbon
 * @param {string[]} labels  engraved beside each slot
 * @param {string} title  engraved at the left end
 * @returns {{pieces: {w, h, cuts, engrave, name}[], web: number, D: number}}  web:
 *   the least material between two slots, or between the split's cut and a
 *   slot it does not pass through, in this row, mm
 */
export function combRow(xs, angles, labels, title, s) {
  const { D, x0, total, slots, zig, tabs } = combLayout(xs, angles, s);
  let web = Infinity;
  for (let i = 0; i + 1 < slots.length; i++) web = Math.min(web, polyDistance(slots[i], slots[i + 1]));
  for (const g of zig) {
    if (g.air) continue;
    slots.forEach((P) => {
      // the slots the segment starts or ends at are touched on purpose
      if (onSlotEnd(g.p, P) || onSlotEnd(g.q, P)) return;
      web = Math.min(web, polyDistance([g.p, g.q], P));
    });
  }
  const T = BOX_WALL;
  const cutsAt = splitPoints(xs.slice(1).map((x, i) => (xs[i] + x) / 2 - x0), total, s.bedMm);
  const pieces = [];
  for (let p = 0; p + 1 < cutsAt.length; p++) {
    const a = cutsAt[p], b = cutsAt[p + 1], w = b - a;
    const left = p === 0, right = p === cutsAt.length - 2;
    const off = left ? T : 0;                     // the left tabs reach to x = 0
    const X = (x) => x - a + off;
    const cuts = [{ kind: 'poly', pts: tabbedOutline(w, D, left ? tabs : [], right ? tabs : [], T).map(([x, y]) => [x + off, y]) }];
    const engrave = [];
    xs.forEach((x, i) => {
      const cxi = x - x0;
      if (cxi < a || cxi >= b) return;
      cuts.push({ kind: 'poly', pts: slots[i].map(([px, py]) => [X(px), py]) });
      engrave.push({ x: X(cxi), y: D - 1.5, h: Math.min(3, s.combMargin * 0.45), text: labels[i], anchor: 'middle' });
    });
    for (const run of clipRuns(zig, a, b)) cuts.push({ kind: 'path', pts: run.map(([px, py]) => [X(px), py]) });
    const name = cutsAt.length > 2 ? `${title} ${String.fromCharCode(97 + p)}` : title;
    engrave.push({ x: off + 2, y: Math.min(3.5, s.combMargin * 0.6), h: Math.min(3, s.combMargin * 0.45), text: name, anchor: 'start' });
    // at the comb's left end, under the title (later pieces start beside a ribbon's label)
    if (left) engrave.push({ x: off + 2, y: D - 1.5, h: Math.min(3, s.combMargin * 0.45), text: 'FRONT', anchor: 'start' });
    pieces.push({ w: w + off + (right ? T : 0), h: D, cuts, engrave, name });
  }
  return { pieces, web, D };
}

/** Is point q one of slot P's two end midpoints (where the split's cut enters it)? */
function onSlotEnd(q, P) {
  const m1 = [(P[0][0] + P[3][0]) / 2, (P[0][1] + P[3][1]) / 2], m2 = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
  return Math.hypot(q[0] - m1[0], q[1] - m1[1]) < 1e-6 || Math.hypot(q[0] - m2[0], q[1] - m2[1]) < 1e-6;
}

/** A w × D rectangle with tabs ([centre, width] from the back edge) T long on its left and right ends. */
function tabbedOutline(w, D, leftTabs, rightTabs, T) {
  const pts = [[0, 0], [w, 0]];
  for (const [c, tw] of [...rightTabs].sort((u, v) => u[0] - v[0])) pts.push([w, c - tw / 2], [w + T, c - tw / 2], [w + T, c + tw / 2], [w, c + tw / 2]);
  pts.push([w, D], [0, D]);
  for (const [c, tw] of [...leftTabs].sort((u, v) => v[0] - u[0])) pts.push([0, c + tw / 2], [-T, c + tw / 2], [-T, c - tw / 2], [0, c - tw / 2]);
  return pts;
}

/** The split's cut, inside [a, b] in x, as open runs of points (segments in a slot dropped). */
function clipRuns(segs, a, b) {
  const runs = [];
  let cur = null;
  const lerp = (p, q, x) => [x, p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0] || 1)];
  for (const g of segs) {
    if (g.air) { cur = null; continue; }
    let { p, q } = g;
    const lo = Math.min(p[0], q[0]), hi = Math.max(p[0], q[0]);
    if (hi < a || lo > b) { cur = null; continue; }
    if (p[0] < a) p = lerp(p, q, a); else if (p[0] > b) p = lerp(p, q, b);
    if (q[0] < a) q = lerp(g.p, g.q, a); else if (q[0] > b) q = lerp(g.p, g.q, b);
    if (!cur || Math.hypot(cur[cur.length - 1][0] - p[0], cur[cur.length - 1][1] - p[1]) > 1e-9) { cur = [p]; runs.push(cur); }
    cur.push(q);
  }
  return runs.filter((r) => r.length > 1);
}

/**
 * Where to cut a comb `total` long into pieces no longer than `bed`, at the
 * given candidate points (midpoints between ribbons): as few pieces as the bed
 * allows, each cut at the candidate nearest an equal share, falling back to
 * cutting as late as possible when equal shares do not fit. A bed of 0 (or
 * blank) means no limit; a bed shorter than a pitch cuts at every midpoint
 * (no more pieces exist), and the pieces are then longer than the bed.
 * @returns {number[]}  0, the cuts, total
 */
export function splitPoints(mids, total, bed) {
  if (!(bed > 0) || total <= bed) return [0, total];
  // a piece per gap between ribbons at most: ceil(total / bed) alone runs away as the bed shrinks
  const k = Math.min(Math.ceil(total / bed), mids.length + 1);
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

/**
 * A plan's comb rows, top to bottom: every shared row, or with pins (or
 * per-ribbon heights) just the two bars. {y, angles, title}
 */
export function combRowsOf(plan) {
  const top = (r) => r.knots[0], bottom = (r) => r.knots[r.knots.length - 1];
  const picks = plan.hold === 'pins' || !plan.rows ? [top, bottom] : plan.rows.map((_, k) => (r) => r.knots[k]);
  return picks.map((pick, k) => {
    const y = pick(plan.ribbons[0]).y;
    const title = k === 0 ? 'TOP BAR' : k === picks.length - 1 ? 'BOTTOM BAR' : `ROW ${k} @ ${Math.round(y)}`;
    return { y, angles: plan.ribbons.map((r) => pick(r).a), title };
  });
}

/** The deepest comb of a plan: the box's depth. */
export const planDepth = (plan, s = plan.s) => Math.max(...combRowsOf(plan).map((r) => rowDepth(r.angles, s)));

/** Every comb of a plan, bars included. */
export function planCombs(plan) {
  const s = plan.s, xs = plan.ribbons.map((r) => r.x);
  const labels = plan.ribbons.map((r, i) => String(i + 1));
  let web = Infinity;
  const all = [];
  for (const row of combRowsOf(plan)) {
    const c = combRow(xs, row.angles, labels, row.title, s);
    web = Math.min(web, c.web);
    all.push(...c.pieces);
  }
  return { pieces: all, web };
}

/**
 * A side panel of the box (cut two): one slot per comb tab at every row
 * height, seen from inside with the back edge at the left. Its depth runs from
 * the back wall to the front of the deepest comb; its height takes in the top
 * and bottom panels.
 */
export function sidePanelPiece(plan) {
  const s = plan.s, H = plan.piece.H, T = BOX_WALL, t = s.combThick;
  const Dmax = planDepth(plan);
  const zFront = Dmax / 2, zBack = -wallDepth({ ...s, backDepth: Dmax });
  const yTop = H + t / 2 + T, yBot = -t / 2 - T;
  const w = zFront - zBack, h = yTop - yBot;
  const cuts = [{ kind: 'poly', pts: [[0, 0], [w, 0], [w, h], [0, h]] }], engrave = [];
  const rows = combRowsOf(plan);
  for (const row of rows) {
    const D = rowDepth(row.angles, s), cy = yTop - (H - row.y);
    for (const [c, tw] of combTabs(D, s)) {
      const cz = c - D / 2 - zBack, sw = tw + s.slotClear, sh = t + s.slotClear;
      cuts.push({ kind: 'poly', pts: [[cz - sw / 2, cy - sh / 2], [cz + sw / 2, cy - sh / 2], [cz + sw / 2, cy + sh / 2], [cz - sw / 2, cy + sh / 2]] });
    }
    engrave.push({ x: w - 1.5, y: cy - t / 2 - 1.2, h: 2, text: row.title, anchor: 'end' });
  }
  // between the first two rows, clear of the tab slots; rotated text's letters lie to the baseline's left
  const between = rows.length > 1 ? yTop - (H - (rows[0].y + rows[1].y) / 2) : h / 2;
  engrave.push({ x: 4.5, y: between, h: 3, text: 'BACK', anchor: 'middle', rot: 90 });
  engrave.push({ x: w / 2 + 1.5, y: between, h: 3, text: 'SIDE PANEL - CUT 2', anchor: 'middle', rot: 90 });
  return { w, h, cuts, engrave, name: 'SIDE PANEL' };
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

/**
 * With pins, how far behind the ribbons' centre line the back wall is: the
 * stand-off is the least gap between a ribbon's edge and the wall, and an edge
 * comes nearest when the ribbon is turned end-on, half its width back.
 */
export const pinWallDepth = (s) => s.standoff + s.ribbonW / 2;

/**
 * THE back wall: how far behind the ribbons' centre line it is. It backs the
 * deepest comb (`backDepth`, the plan's, set by the pipeline; the deepest a
 * comb could be until then) and, with pins, is at least pinWallDepth away.
 * The solver's backdrop shadows, the 3D box, the side panel and the pin
 * clips' stems all read it, so they cannot disagree.
 */
export function wallDepth(s) {
  const D = s.backDepth > 0 ? s.backDepth : combDepth(s);
  return s.hold === 'pins' ? Math.max(pinWallDepth(s), D / 2) : D / 2;
}

/** The box's panels, mm (also the length of the clip stems' tabs through the back panel). */
export const BOX_WALL = 6;

/** Signed area, positive for counter-clockwise in a y-up frame. */
export const polyArea = (P) => P.reduce((a, [x, y], i) => { const [u, v] = P[(i + 1) % P.length]; return a + x * v - u * y; }, 0) / 2;

/**
 * One pin clip's shapes, centred on the ribbon, in (x, z): z toward the viewer
 * (the wall is at z = −wallDepth). All counter-clockwise in the drawing's sense.
 * @returns {{bar, slot, stem, outline, reach, stemW, join}}
 *   reach: how far the clip reaches toward the wall along the stem's line;
 *   join: the stem's furthest point toward the viewer (z); outline: bar ∪ stem, the cut path
 */
export function clipShapes(th, s) {
  const slotW = Math.max(s.minSlot, s.thickness + s.slotClear);
  const a = (s.ribbonW + s.slotClear) / 2 + s.clipWall, b = slotW / 2 + s.clipWall;
  const ux = Math.cos(th * RAD), uz = -Math.sin(th * RAD), vx = -uz, vz = ux;
  const rect = (ha, hb) => [[-ha * ux - hb * vx, -ha * uz - hb * vz], [ha * ux - hb * vx, ha * uz - hb * vz], [ha * ux + hb * vx, ha * uz + hb * vz], [-ha * ux + hb * vx, -ha * uz + hb * vz]];
  const bar = orient(rect(a, b)), slot = orient(rect(a - s.clipWall, b - s.clipWall));
  // a little narrower than the clip: equal widths put the stem's sides on the clip's when it is end-on
  const stemW = 1.6 * b;
  // how far the bar reaches toward the wall along the stem's line (−z)
  const reach = Math.min(Math.abs(uz) > 1e-9 ? a / Math.abs(uz) : Infinity, Math.abs(vz) > 1e-9 ? b / Math.abs(vz) : Infinity);
  const wallZ = -wallDepth(s) - BOX_WALL;
  // The stem's end is cut parallel to the face of the clip it meets -- the long
  // side, or the short end when the clip is turned nearly end-on -- half a clip
  // wall short of the slot. That line separates stem and slot, so the gap holds
  // at every angle (a square end clipped the slot's corner on a tilted clip).
  // It never runs past the clip's centre line (z = 0).
  const longFace = b / Math.max(1e-9, Math.abs(vz)) <= a / Math.max(1e-9, Math.abs(uz));
  const [nx, nz] = longFace ? (vz < 0 ? [vx, vz] : [-vx, -vz]) : (uz < 0 ? [ux, uz] : [-ux, -uz]);   // toward the wall
  const keep = (longFace ? b : a) - s.clipWall / 2;          // n·p ≥ keep: behind the line
  let stem = [[-stemW / 2, wallZ], [stemW / 2, wallZ], [stemW / 2, 0], [-stemW / 2, 0]];
  stem = clipHalfPlane(stem, ([x, z]) => nx * x + nz * z - keep);
  stem = orient(stem);
  const join = Math.max(...stem.map((q) => q[1]));
  const outline = unionConvex(bar, stem) || bar;
  return { bar, slot, stem, outline, reach, stemW, join };
}

/** Sutherland–Hodgman: the part of a convex polygon where f(p) ≥ 0 (f linear). */
function clipHalfPlane(P, f) {
  const out = [];
  P.forEach((p, i) => {
    const q = P[(i + 1) % P.length], fp = f(p), fq = f(q);
    if (fp >= 0) out.push(p);
    if ((fp >= 0) !== (fq >= 0)) { const t = fp / (fp - fq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  });
  return out;
}

/** A convex polygon turned counter-clockwise (positive area). */
function orient(P) { return polyArea(P) < 0 ? P.slice().reverse() : P; }

/**
 * The union of two convex polygons, both counter-clockwise, as one outline
 * (Weiler–Atherton: walk one outside the other, switch at each crossing).
 * null when they do not touch.
 */
export function unionConvex(A, B) {
  const inside = (P, [x, y]) => P.every(([ax, ay], i) => { const [bx, by] = P[(i + 1) % P.length]; return (bx - ax) * (y - ay) - (by - ay) * (x - ax) > 1e-9; });
  const hits = [];
  A.forEach((a0, i) => {
    const a1 = A[(i + 1) % A.length];
    B.forEach((b0, j) => {
      const b1 = B[(j + 1) % B.length];
      const rx = a1[0] - a0[0], ry = a1[1] - a0[1], sx = b1[0] - b0[0], sy = b1[1] - b0[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) return;
      const qx = b0[0] - a0[0], qy = b0[1] - a0[1];
      const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) hits.push({ p: [a0[0] + t * rx, a0[1] + t * ry], i, t, j, u, id: hits.length });
    });
  });
  if (!hits.length) return inside(B, A[0]) ? B : inside(A, B[0]) ? A : null;
  const augment = (P, key, par) => {
    const out = [];
    P.forEach((v, k) => {
      out.push({ p: v });
      hits.filter((h) => h[key] === k).sort((g, h) => g[par] - h[par]).forEach((h) => out.push({ p: h.p, id: h.id }));
    });
    return out;
  };
  const LA = augment(A, 'i', 't'), LB = augment(B, 'j', 'u');
  const start = LA.findIndex((n) => n.id === undefined && !inside(B, n.p));
  if (start < 0) return B;
  const out = [];
  let list = LA, other = LB, k = start;
  for (let guard = 0; guard < 4 * (LA.length + LB.length); guard++) {
    const n = list[k];
    if (list === LA && k === start && out.length) break;
    out.push(n.p);
    if (n.id !== undefined) {
      const m = other.findIndex((o) => o.id === n.id);
      [list, other] = [other, list];
      k = (m + 1) % list.length;
    } else k = (k + 1) % list.length;
  }
  return out;
}

/** Every pin clip of a plan, one piece each, the wall at the top. */
export function pinClipPieces(plan) {
  const s = { ...plan.s, backDepth: planDepth(plan) }, out = [];
  plan.ribbons.forEach((r, i) => {
    for (let b = 1; b + 1 < r.knots.length; b++) {
      const sh = clipShapes(r.knots[b].a, s);
      const all = sh.outline;
      const x0 = Math.min(...all.map((q) => q[0])), z0 = Math.min(...all.map((q) => q[1]));
      const w = Math.max(...all.map((q) => q[0])) - x0, h = Math.max(...all.map((q) => q[1])) - z0;
      const at = (P) => P.map(([x, z]) => [x - x0, z - z0]);
      const label = `${i + 1}.${b}`;
      const th = Math.min(2.2, sh.stemW * 0.7);
      out.push({
        w, h, name: label,
        cuts: [{ kind: 'poly', pts: at(sh.outline) }, { kind: 'poly', pts: at(sh.slot) }],
        // along the stem, reading up toward the wall
        // the wall end is at the top (y = 0); past the tab that goes through the back panel
        engrave: [{ x: -x0 + th * 0.35, y: BOX_WALL + 1.5 + label.length * th * 0.65, h: th, text: label, anchor: 'start', rot: 90 }],
      });
    }
  });
  return out;
}

/**
 * The box's back panel for pins: its outline and one slot per clip, where the
 * clip's stem passes through (stem width by sheet thickness, plus clearance),
 * seen from the front.
 */
export function backPanelPiece(plan) {
  const s = plan.s, H = plan.piece.H, xs = plan.ribbons.map((r) => r.x);
  const [e0, e1] = combEnds(xs, s), x0 = e0 - BOX_WALL, x1 = e1 + BOX_WALL;
  const yTop = H + s.combThick / 2 + BOX_WALL, yBot = -s.combThick / 2 - BOX_WALL;
  const w = x1 - x0, h = yTop - yBot;
  const cuts = [{ kind: 'poly', pts: [[0, 0], [w, 0], [w, h], [0, h]] }], engrave = [];
  plan.ribbons.forEach((r, i) => {
    for (let b = 1; b + 1 < r.knots.length; b++) {
      const sw = clipShapes(r.knots[b].a, s).stemW + s.slotClear, sh = s.combThick + s.slotClear;
      const cx = r.x - x0, cy = yTop - (H - r.knots[b].y);
      cuts.push({ kind: 'poly', pts: [[cx - sw / 2, cy - sh / 2], [cx + sw / 2, cy - sh / 2], [cx + sw / 2, cy + sh / 2], [cx - sw / 2, cy + sh / 2]] });
      engrave.push({ x: cx + sw / 2 + 0.8, y: cy + 1, h: 2, text: `${i + 1}.${b}`, anchor: 'start' });
    }
  });
  return { w, h, cuts, engrave, name: 'BACK PANEL' };
}

/**
 * Pieces in rows across a sheet `width` wide (tallest first), `gap` apart. A
 * width of 0 (or blank: a cutter bed with no limit) makes the sheet about
 * square, never narrower than the widest piece.
 */
export function packPieces(pieces, width, gap = 3) {
  if (!(width > 0)) {
    const area = pieces.reduce((a, p) => a + (p.w + gap) * (p.h + gap), 0);
    width = Math.max(Math.sqrt(area) * 1.1, ...pieces.map((p) => p.w), 1);
  }
  const order = pieces.map((p, i) => i).sort((a, b) => pieces[b].h - pieces[a].h);
  const placed = [];
  let x = 0, y = 0, rowH = 0, W = 0;
  for (const i of order) {
    const p = pieces[i];
    if (x > 0 && x + p.w > width) { x = 0; y += rowH + gap; rowH = 0; }
    placed.push({ p, x, y });
    x += p.w + gap; rowH = Math.max(rowH, p.h); W = Math.max(W, x - gap);
  }
  return { placed, W, H: y + rowH };
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
      const rot = t.rot ? ` transform="rotate(${f2(-t.rot)} ${f2(x + t.x)} ${f2(y + t.y)})"` : '';
      out += `<text x="${f2(x + t.x)}" y="${f2(y + t.y)}" font-size="${f2(t.h)}" text-anchor="${t.anchor === 'middle' || t.anchor === 'end' ? t.anchor : 'start'}"${rot}>${esc(t.text)}</text>\n`;
    }
  }
  return out + '</g>\n</svg>\n';
}

function shapeSVG(c, x, y) {
  if (c.kind === 'circle') return `<circle cx="${f2(x + c.cx)}" cy="${f2(y + c.cy)}" r="${f2(c.r)}"/>\n`;
  if (c.kind === 'line') return `<line x1="${f2(x + c.x1)}" y1="${f2(y + c.y1)}" x2="${f2(x + c.x2)}" y2="${f2(y + c.y2)}"/>\n`;
  return `<path d="M${c.pts.map(([px, py]) => `${f2(x + px)} ${f2(y + py)}`).join(' L')}${c.kind === 'path' ? '' : ' Z'}"/>\n`;
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
        s += pair(0, 'POLYLINE') + pair(8, 'CUT') + pair(66, 1) + pair(70, c.kind === 'path' ? 0 : 1) + pair(10, 0) + pair(20, 0) + pair(30, 0);
        for (const [px, py] of c.pts) s += pair(0, 'VERTEX') + pair(8, 'CUT') + pair(10, X(x + px)) + pair(20, Y(y + py)) + pair(30, 0);
        s += pair(0, 'SEQEND') + pair(8, 'CUT');
      }
    }
    for (const t of p.engrave) {
      const mid = t.anchor === 'middle' || t.anchor === 'end';
      s += pair(0, 'TEXT') + pair(8, 'ENGRAVE') + pair(10, X(x + t.x)) + pair(20, Y(y + t.y)) + pair(30, 0) +
        pair(40, f2(t.h)) + pair(1, t.text) + (t.rot ? pair(50, f2(t.rot)) : '') +
        (mid ? pair(72, t.anchor === 'end' ? 2 : 1) + pair(11, X(x + t.x)) + pair(21, Y(y + t.y)) + pair(31, 0) : '');
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
