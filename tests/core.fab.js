import { section, check, num, plain, vRamp } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { slotRect, planCombs, combRow, calibrationCombs, stackPieces, piecesSVG, piecesDXF, bracketList, bracketCSV, wallTemplateSVG, polyDistance, combDepth } from '../src/core/fab.js';

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
}
