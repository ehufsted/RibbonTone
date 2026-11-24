import { section, check, num, plain, vRamp, mkRand } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { splitPoints, rowDepth, combLayout, planDepth, sidePanelPiece, clipShapes, unionConvex, polyArea, pinClipPieces, backPanelPiece, packPieces, BOX_WALL, slotRect, planCombs, combRow, calibrationCombs, stackPieces, piecesSVG, piecesDXF, bracketList, bracketCSV, wallTemplateSVG, polyDistance, combDepth } from '../src/core/fab.js';

const edgeAngle = (p, q, yUp) => (Math.atan2(yUp ? q[1] - p[1] : p[1] - q[1], q[0] - p[0]) * 180) / Math.PI;

export function run() {
  section('core.fab', 'A slot runs along the ribbon\'s cross-section, (cos θ, −sin θ) with the drawing\'s y toward the viewer: ' +
    'face-on (0°) it lies along the comb, edge-on (90°) across it. Every row cuts one slot per ribbon, split pieces fit the bed, ' +
    'and the DXF (y up) shows the same angles as the SVG (y down), not their mirror images.');
  const s = { ...plain, slotClear: 0.6, minSlot: 1, combMargin: 8, combEnd: 30, bedMm: 600, splitComb: false, minWeb: 2, combThick: 3 };
  const r0 = slotRect(0, 0, 0, s), r90 = slotRect(0, 0, 90, s);
  check('0°: the slot\'s long side lies along the comb (20.6 mm in x)', Math.abs(r0[1][0] - r0[0][0] - 20.6) < 1e-9 && Math.abs(r0[1][1] - r0[0][1]) < 1e-9);
  check('90°: across the comb (20.6 mm in y)', Math.abs(Math.abs(r90[1][1] - r90[0][1]) - 20.6) < 1e-9 && Math.abs(r90[1][0] - r90[0][0]) < 1e-9);
  check('slot width: max(1, 0.25 + 0.6) = 1 mm', Math.abs(Math.hypot(r0[3][0] - r0[0][0], r0[3][1] - r0[0][1]) - 1) < 1e-9);

  const plan = runPipeline(vRamp(40, 80), plain);
  const N = plan.ribbons.length;
  const combs = planCombs(plan);
  const slots = combs.pieces.reduce((a, p) => a + p.cuts.filter((c) => c.kind === 'poly').length - 1, 0);
  check(`one slot per ribbon per row: ${plan.rows.length} rows × ${N}`, slots === plan.rows.length * N, `${slots}`);
  check('neighbouring slots keep the least web (2 mm)', combs.web >= 2, `${num(combs.web, 2)} mm`);
  const long = combRow(Array.from({ length: 40 }, (_, i) => i * 30), new Array(40).fill(20), new Array(40).fill(''), 'R', s);
  const pieceSlots = long.pieces.reduce((a, p) => a + p.cuts.filter((c) => c.kind === 'poly').length - 1, 0);
  check('a 1250.6 mm comb on a 600 mm bed: three pieces of about equal length, every one fits, no slot lost', long.pieces.length === 3 && Math.min(...long.pieces.map((p) => p.w)) > 350 && long.pieces.every((p) => p.w <= 600 + 1e-9) && pieceSlots === 40,
    `${long.pieces.length} pieces of ${long.pieces.map((p) => num(p.w, 0)).join(', ')} mm`);
  // a bed of 0 once ran ceil(total / 0) = Infinity rounds and froze the page at start-up
  const mids = Array.from({ length: 39 }, (_, i) => 15 + 30 * i);
  check('cutter bed 0, negative or blank: no limit, one piece', [0, -5, NaN, undefined].every((b) => JSON.stringify(splitPoints(mids, 1230, b)) === '[0,1230]'));
  const tiny = splitPoints(mids, 1230, 1);
  check('a 1 mm bed: a cut at every midpoint (40 pieces), not 1230 rounds', tiny.length === 41, `${tiny.length - 1} pieces`);
  const tight = { ...s, pitch: 21 };
  const crowd = combRow([0, 21], [0, 0], ['1', '2'], 'R', tight);
  check('pitch 21 mm, both face-on: slots 0.4 mm apart are flagged by the web', crowd.web < 2, `${num(crowd.web, 2)} mm`);
  check('polygon distance: unit squares 1 apart are 1 apart, overlapping ones 0',
    Math.abs(polyDistance([[0, 0], [1, 0], [1, 1], [0, 1]], [[2, 0], [3, 0], [3, 1], [2, 1]]) - 1) < 1e-12 &&
    polyDistance([[0, 0], [1, 0], [1, 1], [0, 1]], [[0.5, 0.5], [2, 0.5], [2, 2], [0.5, 2]]) === 0);

  const one = combRow([50], [30], ['1'], 'T', s);
  const sheet = stackPieces(one.pieces);
  const svg = piecesSVG(sheet), dxf = piecesDXF(sheet);
  const path = svg.match(/<path d="M([^"]+) Z"\/>/g)[1].match(/[-\d.]+ [-\d.]+/g).map((t) => t.split(' ').map(Number));
  const lines = dxf.split('\n');
  const verts = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === 'VERTEX') verts.push([Number(lines[i + 4]), Number(lines[i + 6])]);
  const nOut = one.pieces[0].cuts[0].pts.length;   // the outline (with its tabs) comes first
  const slotD = verts.slice(nOut, nOut + 4);
  const aSvg = edgeAngle(path[0], path[1], false), aDxf = edgeAngle(slotD[0], slotD[1], true);
  check('a 30° slot reads 30° in the SVG and in the DXF', Math.abs(aSvg - 30) < 1e-3 && Math.abs(aDxf - 30) < 1e-3, `SVG ${num(aSvg, 3)}°, DXF ${num(aDxf, 3)}°`);
  check('the deepest a comb can be: w + clearance + 2 margins = 36.6 mm', Math.abs(combDepth(s) - 36.6) < 1e-9);

  section('core.fab: comb depth, tabs and the split', 'Each comb is only as deep as its own row needs: its farthest-reaching slot ' +
    'plus the margin, front and back. Its ends carry tabs into the side panels. A split comb is cut along a zigzag through every slot ' +
    'and up to a peak between ribbons; the cut must never cross a slot it does not pass through, nor come within the least web of one.');
  check('a face-on row: slot width + 2 margins = 1 + 16 = 17 mm deep', Math.abs(rowDepth([0, 0, 0], s) - 17) < 1e-9, num(rowDepth([0, 0, 0], s), 3));
  check('a row with one ribbon at 90°: slot length + 2 margins = 36.6 mm', Math.abs(rowDepth([0, 90, 10], s) - 36.6) < 1e-9);
  const depths = new Set(combs.pieces.map((p) => Math.round(p.h * 1000)));
  check('the plan\'s combs come in different depths, each its row\'s', depths.size > 1 && combs.pieces.every((p) => p.h <= combDepth(s) + 1e-9), [...depths].map((d) => num(d / 1000, 1)).join(', '));
  const solo = combRow([0, 30, 60], [0, 0, 0], ['1', '2', '3'], 'R', s).pieces[0];
  check('a whole comb: tabs at both ends, 12 corners; its ends 30 mm past the outer slots\' far ends (10.3 mm out), BOX_WALL more for the tabs',
    solo.cuts[0].pts.length === 12 && Math.abs(solo.w - (60 + 2 * (10.3 + 30) + 2 * BOX_WALL)) < 1e-9,
    `${solo.cuts[0].pts.length} corners, ${num(solo.w, 1)} mm`);
  check('no mounting holes any more', !solo.cuts.some((c) => c.kind === 'circle'));
  const sp = { ...s, splitComb: true };
  const twoTabs = combRow([0, 30], [0, 0], ['1', '2'], 'R', sp).pieces[0];
  check('a split comb: a tab for each half at each end (20 corners)', twoTabs.cuts[0].pts.length === 20, `${twoTabs.cuts[0].pts.length}`);
  // the zigzag over many seeded rows
  const rnd = mkRand(7);
  let through = true, crossOwn = false, web = Infinity, inside = true, ends = true;
  for (let k = 0; k < 60; k++) {
    const xsZ = Array.from({ length: 8 }, (_, i) => i * 30);
    const ang = xsZ.map(() => rnd() * 180 - 90);
    const lay = combLayout(xsZ, ang, sp);
    const zig = lay.zig, D = lay.D;
    if (Math.abs(zig[0].p[0]) > 1e-9 || Math.abs(zig[0].p[1] - D / 2) > 1e-9 || Math.abs(zig[zig.length - 1].q[0] - lay.total) > 1e-9) ends = false;
    if (zig.filter((g) => g.air).length !== xsZ.length) through = false;
    for (let i = 1; i < zig.length; i++) if (Math.hypot(zig[i].p[0] - zig[i - 1].q[0], zig[i].p[1] - zig[i - 1].q[1]) > 1e-9) through = false;
    for (const g of zig) {
      if (g.air) continue;
      for (const q of [g.p, g.q]) if (!(q[1] > 0 && q[1] < D)) inside = false;
      lay.slots.forEach((P) => {
        // shorten the segment a hair at each end: touching a slot at its own end is the point
        const dx = g.q[0] - g.p[0], dy = g.q[1] - g.p[1], L = Math.hypot(dx, dy) || 1, e = 1e-3 / L;
        const a = [g.p[0] + dx * e, g.p[1] + dy * e], b = [g.q[0] - dx * e, g.q[1] - dy * e];
        const d = polyDistance([a, b], P);
        if (d === 0) crossOwn = true;
      });
    }
    web = Math.min(web, combRow(xsZ, ang, xsZ.map(() => ''), 'Z', sp).web);
  }
  check('the zigzag runs from end to end through both ends of every slot', ends && through);
  check('the zigzag never crosses a slot (apart from running along inside it)', !crossOwn);
  check('the zigzag stays inside the comb', inside);
  check('60 random rows at 30 mm pitch: the least web is reported and stays above 0', web > 0 && isFinite(web), `${num(web, 2)} mm`);
  const zz = combRow([0, 30], [0, 0], ['1', '2'], 'R', sp).pieces[0];
  check('the split cut is written as open paths (no closing line)', zz.cuts.some((c) => c.kind === 'path') && /<path d="M[^"Z]+"\/>/.test(piecesSVG(stackPieces([zz]))));
  const side = sidePanelPiece(plan);
  const rowsN = plan.rows.length;
  check(`side panel: one slot per comb tab (${rowsN} rows × 1)`, side.cuts.length === rowsN + 1);
  check('side panel: as deep as the deepest comb', Math.abs(side.w - planDepth(plan)) < 1e-9, `${num(side.w, 2)} mm`);
  check('split combs: two tab slots per row', sidePanelPiece({ ...plan, s: { ...plan.s, splitComb: true } }).cuts.length === 2 * rowsN + 1);

  const cal = calibrationCombs(s, 15);
  check('calibration: −90…90 in 15° steps is 13 slots, cut twice', cal.angles.length === 13 && cal.pieces.length === 2);

  const list = bracketList(plan);
  const knots = plan.ribbons.reduce((a, r) => a + r.knots.length, 0);
  check('the bracket list has every knot, bars included', list.length === knots, `${list.length}`);
  const r = plan.ribbons[3];
  const sumTurn = list.filter((b) => b.ribbon === 4).reduce((a, b) => a + b.turn, 0);
  check('the turns down a ribbon add up to its total twist', Math.abs(sumTurn - (r.knots[r.knots.length - 1].a - r.knots[0].a)) < 1e-9, `${num(sumTurn, 2)}°`);
  check('slot angles lie in [0, 180)', list.every((b) => b.slot >= 0 && b.slot < 180));
  const csv = bracketCSV(plan, 'in').trim().split('\n');
  check('CSV: a header and one line per bracket, in inches when asked', csv.length === knots + 1 && csv[0].includes('y_from_top_in'));
  check('wall template: one dial per bracket', (wallTemplateSVG(plan).match(/<circle /g) || []).length === knots);

  section('core.fab: pin clips', 'A pin clip is a flat T: a slotted crossbar at the ribbon\'s angle and a stem straight back to the wall. ' +
    'At every angle it must be one closed outline (the union of the two), the stem must join the bar yet stay half a clip wall from the slot, ' +
    'and the stem must run on through the back panel.');
  const ps = { ...s, standoff: 45, clipWall: 1.5, combThick: 3 };
  let worst = Infinity, joined = true, single = true, areaOK = true, toWall = true;
  for (let a = 0; a < 180; a += 1) {
    const c = clipShapes(a, ps);
    worst = Math.min(worst, polyDistance(c.stem, c.slot));
    if (polyDistance(c.stem, c.bar) > 0) joined = false;
    if (!(c.outline.length > 4)) single = false;
    const A = Math.abs(polyArea(c.outline)), Ab = Math.abs(polyArea(c.bar)), As = Math.abs(polyArea(c.stem));
    if (!(A > Ab + 0.5 * As && A < Ab + As)) areaOK = false;
    if (Math.abs(Math.min(...c.stem.map((q) => q[1])) + 45 + BOX_WALL) > 1e-9) toWall = false;
    if (selfCrosses(c.outline)) single = false;
  }
  check('every angle: the stem joins the bar', joined);
  check('every angle: the stem stays at least half a clip wall (0.75 mm) from the slot', worst >= 0.75 - 1e-6, `least ${num(worst, 3)} mm`);
  check('every angle: one simple outline, bigger than the bar and smaller than bar + stem', single && areaOK);
  check('every angle: the stem reaches through the back panel', toWall);
  const sq = [[0, 0], [2, 0], [2, 2], [0, 2]], sq2 = [[1, 1], [3, 1], [3, 3], [1, 3]];
  check('union of two overlapping 2×2 squares: area 7', Math.abs(polyArea(unionConvex(sq, sq2)) - 7) < 1e-9, num(polyArea(unionConvex(sq, sq2)), 4));
  check('union of disjoint squares: none', unionConvex(sq, [[5, 5], [6, 5], [6, 6], [5, 6]]) === null);

  const pp = runPipeline(vRamp(40, 80), { ...ps, hold: 'pins', layout: 'perRibbon', maxPerRibbon: 4, minSpacing: 50, maxSpan: 400 });
  const inner = pp.ribbons.reduce((a, r) => a + r.knots.length - 2, 0);
  const clips = pinClipPieces(pp);
  check(`one clip piece per bracket between the bars (${inner})`, clips.length === inner);
  const clipSheet = packPieces(clips, 200);
  check('clips packed across a 200 mm bed, none overlapping', clipSheet.W <= 200 + 1e-9 && clipSheet.placed.every((a, i) => clipSheet.placed.every((b, j) => j <= i ||
    a.x + a.p.w <= b.x + 1e-9 || b.x + b.p.w <= a.x + 1e-9 || a.y + a.p.h <= b.y + 1e-9 || b.y + b.p.h <= a.y + 1e-9)), `${num(clipSheet.W, 1)} × ${num(clipSheet.H, 1)} mm`);
  const panel = backPanelPiece(pp);
  check('back panel: its outline and one stem slot per clip', panel.cuts.length === inner + 1);
  const svgC = piecesSVG(clipSheet), dxfC = piecesDXF(clipSheet);
  check('clip labels run along the stem: rotated in the SVG and the DXF', /transform="rotate\(-90 /.test(svgC) && /\n50\n90\n/.test(dxfC));
}

/** Does a closed polygon cross itself? */
function selfCrosses(P) {
  const n = P.length;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = P[i], b = P[(i + 1) % n], c = P[j], d = P[(j + 1) % n];
    if (cross(a, b, c) * cross(a, b, d) < -1e-12 && cross(c, d, a) * cross(c, d, b) < -1e-12) return true;
  }
  return false;
}
