import { section, check, num, plain } from './runner.js';
import { ribbonLUT, lightnessLUT, lutAt } from '../src/core/optics.js';
import { twistModel, maxTwistDeg } from '../src/core/twist.js';
import { reachRange } from '../src/core/target.js';
import { idealPath, sampleFrame, knotGrid, spanCosts, placeKnots, solveAngles, pathFromKnots, pathLightness } from '../src/core/solve.js';

export function run() {
  const s = { ...plain, lightAz: 25, ambient: 0.2, lightEl: 30 };
  const H = 600, n = 300, dy = H / n;
  const Y = ribbonLUT(s, 0), L = lightnessLUT(Y);
  const range = reachRange([Y]);
  const kmax = maxTwistDeg(s);
  const model = twistModel(s, H);
  const frame = sampleFrame(n, H, model);

  section('core.solve: ideal path', 'Viterbi under the rate limit alone. A reachable flat grey should be matched almost exactly ' +
    'and held still; a white-to-black step cannot be followed faster than κmax, so no sample-to-sample turn may exceed κmax·dy, ' +
    'and far from the step both tones are met.');
  const mid = (range.Lmin + range.Lmax) / 2;
  const flat = new Float32Array(n).fill(mid);
  const pf = idealPath(L, flat, dy, kmax);
  const lf = pathLightness(L, pf);
  const errF = Math.max(...Array.from(lf, (v) => Math.abs(v - mid)));
  check('flat grey: every sample within 0.01 lightness', errF < 0.01, `max |ΔL| ${num(errF, 4)}`);
  check('flat grey: the path holds still', Math.max(...pf) - Math.min(...pf) < 1.01, `range ${num(Math.max(...pf) - Math.min(...pf), 2)}°`);
  const step = Float32Array.from({ length: n }, (_, j) => (j < n / 2 ? range.Lmax : range.Lmin));
  const ps = idealPath(L, step, dy, kmax);
  let worst = 0;
  for (let j = 1; j < n; j++) worst = Math.max(worst, Math.abs(ps[j] - ps[j - 1]));
  check('step: no turn faster than κmax·dy', worst <= kmax * dy + 1e-9, `${num(worst, 3)}° vs ${num(kmax * dy, 3)}°`);
  const ls = pathLightness(L, ps);
  check('step: white near the top, black near the bottom', Math.abs(ls[10] - range.Lmax) < 0.02 && Math.abs(ls[n - 10] - range.Lmin) < 0.02, `${num(ls[10])} / ${num(ls[n - 10])}`);

  section('core.solve: bracket heights', 'Shortest path over a grid of candidate heights. Every span must lie within ' +
    '[minSpacing, maxSpan] and the count within the limit; with no limit the DP must equal brute force over every subset.');
  const target = Float32Array.from({ length: n }, (_, j) => range.Lmin + (range.Lmax - range.Lmin) * (0.5 + 0.5 * Math.sin(j / 25)));
  const th = idealPath(L, target, dy, kmax);
  const grid = knotGrid(frame, 10, 40, 200);
  const cost = spanCosts(frame, L, target, th, kmax, grid);
  const pk = placeKnots(cost, grid, 6);
  const ys = [0, ...pk.q.map((q) => q * dy), H];
  const gaps = ys.slice(1).map((y, k) => y - ys[k]);
  check('at most 6 brackets between the bars', pk.count <= 6 && pk.q.length === pk.count, `${pk.count}`);
  check('every span within 40…200 mm', gaps.every((g) => g >= 40 - 1e-9 && g <= 200 + 1e-9), gaps.map((g) => num(g, 0)).join(' '));
  // brute force on a coarse grid, no count limit
  const g2 = knotGrid(frame, 60, 60, 240);
  const c2 = spanCosts(frame, L, target, th, kmax, g2);
  const P = g2.Q.length, D = g2.dmax + 1;
  let brute = Infinity;
  for (let mask = 0; mask < 1 << (P - 2); mask++) {
    const idx = [0];
    for (let b = 0; b < P - 2; b++) if (mask & (1 << b)) idx.push(b + 1);
    idx.push(P - 1);
    let c = 0;
    for (let k = 0; k + 1 < idx.length && c < Infinity; k++) {
      const d = idx[k + 1] - idx[k];
      c += d >= g2.dmin && d <= g2.dmax ? c2[idx[k] * D + d] : Infinity;
    }
    brute = Math.min(brute, c);
  }
  const dp = placeKnots(c2, g2, 99);
  check(`DP equals brute force over all ${1 << (P - 2)} subsets`, Math.abs(dp.cost - brute) < 1e-6 * Math.max(1, brute), `${num(dp.cost, 6)} vs ${num(brute, 6)}`);

  section('core.solve: angles', 'Viterbi over each bracket\'s angle with the exact span cost. Every span\'s PEAK rate (tension-weighted) ' +
    'must stay within κmax, and on a small case the result must equal exhaustive search.');
  const centers = ys.map((y) => th[Math.min(n - 1, Math.round(y / dy))]);
  const sol = solveAngles(frame, L, target, ys, centers, kmax);
  const knots = ys.map((y, k) => ({ y, a: sol.angles[k] }));
  let peak = 0;
  for (let k = 0; k + 1 < knots.length; k++) peak = Math.max(peak, model.peakRate(knots[k].y, knots[k + 1].y, knots[k + 1].a - knots[k].a));
  check('no span\'s peak rate exceeds κmax', peak <= kmax * (1 + 1e-9), `${num(peak, 4)} vs ${num(kmax, 4)} °/mm`);
  const path = pathFromKnots(frame, knots);
  const lp = pathLightness(L, path);
  let sse = 0;
  for (let j = 0; j < n; j++) sse += (lp[j] - target[j]) ** 2;
  check('the reported cost is the path\'s squared error', Math.abs(sse - sol.cost) < 1e-6, `${num(sse, 6)} vs ${num(sol.cost, 6)}`);
  // exhaustive: 3 brackets, window ±12° in 4° steps -> 7 states each
  const ys3 = [0, 150, 300], tgt3 = target.slice(0, 150);
  const fr3 = sampleFrame(150, 300, twistModel(s, 300));
  const c3 = [10, 20, 5];
  const small = solveAngles(fr3, L, tgt3, ys3, c3, kmax, { window: 12, res: 4 });
  let best = Infinity;
  const m3 = twistModel(s, 300);
  for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) for (let c = -3; c <= 3; c++) {
    const ang = [c3[0] + 4 * a, c3[1] + 4 * b, c3[2] + 4 * c];
    const kn = ys3.map((y, k) => ({ y, a: ang[k] }));
    if (m3.peakRate(0, 150, ang[1] - ang[0]) > kmax * (1 + 1e-9) || m3.peakRate(150, 300, ang[2] - ang[1]) > kmax * (1 + 1e-9)) continue;
    const p = pathFromKnots(fr3, kn);
    let e = 0;
    for (let j = 0; j < 150; j++) e += (lutAt(L, p[j]) - tgt3[j]) ** 2;
    best = Math.min(best, e);
  }
  check('equals exhaustive search over 7³ angle choices', Math.abs(small.cost - best) < 1e-4 * Math.max(1e-3, best), `${num(small.cost, 6)} vs ${num(best, 6)}`);
}
