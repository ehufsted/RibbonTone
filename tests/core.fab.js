import { section, check, num, plain, vRamp } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { clipShapes, unionConvex, polyArea, pinClipPieces, backPanelPiece, packPieces, BOX_WALL, slotRect, planCombs, combRow, calibrationCombs, stackPieces, piecesSVG, piecesDXF, bracketList, bracketCSV, wallTemplateSVG, polyDistance, combDepth } from '../src/core/fab.js';

const edgeAngle = (p, q, yUp) => (Math.atan2(yUp ? q[1] - p[1] : p[1] - q[1], q[0] - p[0]) * 180) / Math.PI;

export function run() {
  section('core.fab', 'A slot runs along the ribbon\'s cross-section, (cos θ, −sin θ) with the drawing\'s y toward the viewer: ' +
    'face-on (0°) it lies along the comb, edge-on (90°) across it. Every row cuts one slot per ribbon, split pieces fit the bed, ' +
    'and the DXF (y up) shows the same angles as the SVG (y down), not their mirror images.');
  const s = { ...plain, slotClear: 0.6, minSlot: 1, combMargin: 8, combEnd: 30, holeDia: 5, bedMm: 600, splitComb: false, minWeb: 2 };
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
  check('a 1230 mm comb on a 600 mm bed: three pieces of about equal length, every one fits, no slot lost', long.pieces.length === 3 && Math.min(...long.pieces.map((p) => p.w)) > 350 && long.pieces.every((p) => p.w <= 600 + 1e-9) && pieceSlots === 40,
    `${long.pieces.length} pieces of ${long.pieces.map((p) => num(p.w, 0)).join(', ')} mm`);
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
  const slotD = verts.slice(4, 8);
  const aSvg = edgeAngle(path[0], path[1], false), aDxf = edgeAngle(slotD[0], slotD[1], true);
  check('a 30° slot reads 30° in the SVG and in the DXF', Math.abs(aSvg - 30) < 1e-3 && Math.abs(aDxf - 30) < 1e-3, `SVG ${num(aSvg, 3)}°, DXF ${num(aDxf, 3)}°`);
  check('comb depth = w + clearance + 2 margins = 36.6 mm', Math.abs(combDepth(s) - 36.6) < 1e-9);
  check('split combs get a centre cut', combRow([0, 30], [0, 0], ['1', '2'], 'R', { ...s, splitComb: true }).pieces[0].cuts.some((c) => c.kind === 'line'));

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
