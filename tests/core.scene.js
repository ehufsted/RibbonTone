// The 3D scene (core/scene.js). Mesh coordinates are Float32, so extents compare to 1e-4 mm.

import { section, check, num, plain, vRamp, makeRGBA } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { buildScene, ribbonStations, addBox, BOX_WALL } from '../src/core/scene.js';
import { combDepth } from '../src/core/fab.js';
import { camBasis, eyeOf } from '../src/app/view3d.js';

/** Every triangle's winding agrees with its normal (counter-clockwise seen from outside). */
function windingOK(m) {
  for (let i = 0; i < m.pos.length; i += 9) {
    const a = m.pos.slice(i, i + 3), b = m.pos.slice(i + 3, i + 6), c = m.pos.slice(i + 6, i + 9);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * m.nrm[i] + n[1] * m.nrm[i + 1] + n[2] * m.nrm[i + 2] <= 0) return false;
  }
  return true;
}

const extent = (pos, k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); } return [lo, hi]; };

export function run() {
  section('core.scene', 'The 3D geometry. Ribbons are cut at every bracket and often enough to follow each turn, and their ' +
    'cross-section is the one core/render.js projects. Combs are prisms the comb\'s own length and depth; with pins only the two bars ' +
    'stay combs and every bracket between gets a tab and a rod to the back wall. The box is open at the front and holds everything. ' +
    'Prism triangles wind counter-clockwise seen from outside, which the clear combs\' two-pass drawing relies on.');
  const s = { ...plain, combThick: 3, standoff: 45 };
  const plan = runPipeline(vRamp(40, 80), s);
  const r = plan.ribbons[3];
  const st = ribbonStations(plan, r);
  check('stations run top to bottom and include every bracket', st.every((p, i) => i === 0 || p.y >= st[i - 1].y) && r.knots.every((k) => st.some((p) => p.y === k.y && p.a === k.a)),
    `${st.length} stations for ${r.knots.length} brackets`);
  check('fewer stations than samples (spans that hold still need none)', st.length < plan.n, `${st.length} of ${plan.n}`);

  const sc = buildScene(plan, plan.s);
  const D = combDepth(plan.s), hw = plan.s.ribbonW / 2;
  // the first triangle of ribbon 0 starts at the top bar's left end
  const r0 = plan.ribbons[0], a0 = r0.knots[0].a * Math.PI / 180;
  const p = sc.ribbons.pos;
  check('ribbon cross-section as in render.js: left end (x − w/2·cos θ, w/2·sin θ) at the top', Math.abs(p[0] - (r0.x - hw * Math.cos(a0))) < 1e-3 &&
    Math.abs(p[1] - plan.piece.H) < 1e-3 && Math.abs(p[2] - hw * Math.sin(a0)) < 1e-3, `${num(p[0], 2)}, ${num(p[1], 1)}, ${num(p[2], 2)}`);
  check(`one comb per row (${plan.rows.length}), each 12 triangles`, sc.combs.length === plan.rows.length && sc.combs.every((c) => c.pos.length === 108));
  const cx = extent(sc.combs[1].pos, 0), cz = extent(sc.combs[1].pos, 2), cy = extent(sc.combs[1].pos, 1);
  const xs = plan.ribbons.map((q) => q.x);
  check('a comb spans the outer ribbons plus its ends, the comb depth, and the sheet thickness',
    Math.abs(cx[0] - (xs[0] - plan.s.combEnd)) < 1e-3 && Math.abs(cx[1] - (xs[xs.length - 1] + plan.s.combEnd)) < 1e-3 &&
    Math.abs(cz[1] - cz[0] - D) < 1e-3 && Math.abs(cy[1] - cy[0] - 3) < 1e-3,
    `x ${num(cx[0], 1)}…${num(cx[1], 1)}, depth ${num(cz[1] - cz[0], 2)}, thick ${num(cy[1] - cy[0], 2)}`);
  check('slot outlines: 4 edges on each face of every slot', sc.lines.length === plan.rows.length * xs.length * 2 * 4 * 6);
  const bz = extent(sc.box.pos, 2), bx = extent(sc.box.pos, 0);
  check('combs: the box\'s depth is the combs\', open at the front', Math.abs(sc.zBack + D / 2) < 1e-9 && Math.abs(bz[1] - D / 2) < 1e-4 && Math.abs(bz[0] - (-D / 2 - BOX_WALL)) < 1e-4,
    `z ${num(bz[0], 1)}…${num(bz[1], 1)}`);
  check('the combs reach the box\'s sides', Math.abs(bx[0] - (cx[0] - BOX_WALL)) < 1e-4 && Math.abs(bx[1] - (cx[1] + BOX_WALL)) < 1e-4);
  const rx = extent(sc.ribbons.pos, 0), rz = extent(sc.ribbons.pos, 2), ry = extent(sc.ribbons.pos, 1);
  const b = sc.bounds;
  check('every ribbon is inside the box', rx[0] > b.x0 + BOX_WALL && rx[1] < b.x1 - BOX_WALL && rz[0] > sc.zBack && rz[1] <= sc.zFront && ry[0] >= b.y0 + BOX_WALL && ry[1] <= b.y1 - BOX_WALL);
  check('the box is back, two sides, top and bottom: 5 panels', sc.box.pos.length === 5 * 108);
  check('prisms wind counter-clockwise seen from outside', windingOK(sc.box) && sc.combs.every(windingOK));
  const one = { pos: [], nrm: [] };
  addBox(one, 0, 1, 0, 1, 0, 1);
  check('a unit box: 12 triangles, unit normals', one.pos.length === 108 && one.nrm.every((v) => [0, 1, -1].includes(v)));

  // pins, per-ribbon heights
  const detail = makeRGBA(40, 80, (x, y) => { const v = (Math.floor(y / 12) + Math.floor(x / 10)) % 2 ? 220 : 30; return [v, v, v]; });
  const pp = runPipeline(detail, { ...s, hold: 'pins', layout: 'perRibbon', maxPerRibbon: 5, minSpacing: 40, maxSpan: 400 });
  const ps = buildScene(pp, pp.s);
  const inner = pp.ribbons.reduce((a, q) => a + q.knots.length - 2, 0);
  check('pins: only the two bars are combs', ps.combs.length === 2);
  check(`pins: one clip per bracket between the bars (${inner}), two prisms of at least 12 triangles each`, ps.clips.pos.length >= inner * 2 * 12 * 9 && ps.clips.pos.length <= inner * 2 * 16 * 9);
  check('pins: the clips\' stems reach into the back panel (45 mm + the panel behind the ribbons)', Math.abs(extent(ps.clips.pos, 2)[0] + 45 + BOX_WALL) < 1e-4,
    `stems reach z = ${num(extent(ps.clips.pos, 2)[0], 1)}`);
  check('pins: the box\'s back wall is the stand-off behind', Math.abs(ps.zBack + 45) < 1e-9 && Math.abs(extent(ps.box.pos, 2)[0] + 45 + BOX_WALL) < 1e-4);
  check('pins: clips wind counter-clockwise too', windingOK(ps.clips));

  section('core.scene: settings and camera', 'The back wall\'s distance feeds the solver (backdrop shadows), so the settings that set it ' +
    '(stand-off, comb margin, slot clearance) must re-solve, not just redraw. The orbit camera\'s frame must stay orthonormal and turn ' +
    'smoothly through looking straight down: a fixed world up once flipped the picture past 88°.');
  const sd = { ...s, hold: 'pins', layout: 'even', darkRibbons: true, reflectance: 0.05, bgReflectance: 0.85, lightAz: 30, ambient: 0.2 };
  const near = runPipeline(vRamp(40, 80), { ...sd, standoff: 20 }), far = runPipeline(vRamp(40, 80), { ...sd, standoff: 80 });
  const diff = near.ribbons[4].knots.some((k, i) => Math.abs(k.a - far.ribbons[4].knots[i].a) > 0.5);
  check('dark on white, side light: moving the back wall from 20 to 80 mm changes the solved angles', diff,
    `${near.ribbons[4].knots.map((k) => num(k.a, 0)).join(' ')} vs ${far.ribbons[4].knots.map((k) => num(k.a, 0)).join(' ')}`);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let ortho = 0, aim = 0;
  for (const yaw of [0, 0.7, 1.57, -2.5]) for (const pitch of [-1.55, -0.6, 0, 0.9, 1.55]) {
    const cam = { target: [10, 20, 30], yaw, pitch, dist: 500 };
    const { fwd, right, up } = camBasis(cam);
    ortho = Math.max(ortho, Math.abs(dot(fwd, right)), Math.abs(dot(fwd, up)), Math.abs(dot(right, up)), Math.abs(dot(up, up) - 1), Math.abs(dot(right, right) - 1));
    const e = eyeOf(cam), t = cam.target, d = Math.hypot(t[0] - e[0], t[1] - e[1], t[2] - e[2]);
    aim = Math.max(aim, Math.abs(dot(fwd, [(t[0] - e[0]) / d, (t[1] - e[1]) / d, (t[2] - e[2]) / d]) - 1));
  }
  check('camera frame orthonormal at every yaw and pitch, and looking at the target', ortho < 1e-12 && aim < 1e-12, `${ortho.toExponential(1)}, ${aim.toExponential(1)}`);
  const u88 = camBasis({ yaw: 1.57, pitch: 88 * Math.PI / 180 }).up, u89 = camBasis({ yaw: 1.57, pitch: 89 * Math.PI / 180 }).up;
  const turn = Math.acos(Math.min(1, dot(u88, u89))) * 180 / Math.PI;
  check('yaw 90°, tilting from 88° to 89°: up turns by about that 1°, no flip', turn < 1.5, `${num(turn, 2)}°`);
  check('front view: up is +y, right is +x', JSON.stringify(camBasis({ yaw: 0, pitch: 0 }).up.map((v) => Math.round(v * 1e9) / 1e9)) === JSON.stringify([0, 1, 0]) &&
    camBasis({ yaw: 0, pitch: 0 }).right[0] === 1);
}
