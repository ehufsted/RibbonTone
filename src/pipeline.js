// The whole chain, DOM-free: pixels + settings -> a ribbon plan.
// worker.js wraps it; the harness calls it directly.
//
//   tone -> piece and ribbons -> each ribbon's brightness over a half turn
//   (core/optics.js) -> the reachable range and each ribbon's target lightness
//   (core/target.js) -> ideal paths -> bracket heights -> bracket angles
//   (core/solve.js) -> stats and warnings
//
// THE PLAN is what everything downstream reads (preview, bracket view,
// fabrication files): geometry in mm and angles in degrees, plus per-sample
// arrays for the views.
//
//   { piece: {W, H}, imageRect, n, dy, xv,
//     ribbons: [{x, alpha, knots: [{y, a}], th, ideal, Lt, L, Lideal}]
//       knots run from the top bar (y = 0) to the bottom bar (y = H); a is
//       unwrapped degrees, so consecutive knots give the twist's size and
//       direction; th/ideal: angle per sample; Lt/L/Lideal: lightness
//     rows: [y, ...] shared bracket heights (bars included) | null,
//     layout, hold, range, kmaxDeg, quarterTurn, curvePts, s, stats, notes }

import { DEFAULTS, pieceGeometry, toneLuminance, MAX_RIBBONS, MAX_SAMPLES, lenText } from './core/units.js';
import { viewAngle, ribbonLUT, lightnessLUT, parseCurve } from './core/optics.js';
import { sampleColumns, reachRange, toneMap } from './core/target.js';
import { twistModel, maxTwistDeg, quarterTurnLength } from './core/twist.js';
import { idealPath, sampleFrame, knotGrid, spanCosts, placeKnots, solveAngles, pathFromKnots, pathLightness, blur1 } from './core/solve.js';

/** Validation the app also uses, so it can say what is wrong before running. */
export function problemWith(s) {
  if (!(s.widthMm > 0)) return 'enter a width';
  if (!(s.heightMm >= 0)) return 'height must be 0 (from the image) or more';
  if (!(s.ribbonW > 0) || !(s.pitch > 0) || !(s.thickness > 0)) return 'ribbon width, pitch and thickness must be more than 0';
  if (s.pitch < s.ribbonW) return 'the pitch must be at least the ribbon width, or neighbours collide when they turn';
  if (s.ribbonW > s.widthMm) return 'the ribbon is wider than the piece';
  if (!(s.strainPct > 0)) return 'the edge strain limit must be more than 0';
  if (!(s.tensionN > 0)) return 'the bottom bar must pull: tension must be more than 0';
  if (!(s.distM > 0)) return 'the viewing distance must be more than 0';
  if (!(s.minSpacing > 0) || !(s.maxSpan >= s.minSpacing)) return 'brackets: the longest span must be at least the least spacing';
  if (s.layout === 'even' && !(s.rowSpacing > 0)) return 'the row spacing must be more than 0';
  if (!(s.maxRows >= 0) || !(s.maxPerRibbon >= 0)) return 'the most rows and most brackets per ribbon cannot be negative';
  return '';
}

/**
 * @param {{width,height,data}} rgba
 * @param {object} settings  units.DEFAULTS
 * @param {{onProgress?:(stage:string)=>void}} opts
 */
export function runPipeline(rgba, settings, opts = {}) {
  const s = { ...DEFAULTS, ...settings };
  const progress = opts.onProgress || (() => {});
  const bad = problemWith(s);
  if (bad) throw new Error(bad);
  const notes = [];
  const len = (v) => lenText(v, s.units);

  progress('reading the image');
  const lum = toneLuminance(rgba, s.gamma, s.brightness);
  const geo = pieceGeometry(lum, s);
  const { W, H, xs } = geo;
  const N = geo.count;
  if (N > MAX_RIBBONS) {
    const err = new Error(`${N} ribbons is more than ${MAX_RIBBONS}: widen the pitch or narrow the piece`);
    err.code = 'TOO_MANY';
    throw err;
  }
  const n = Math.min(MAX_SAMPLES, Math.max(24, Math.round(H / 2)));
  const dy = H / n;
  const cols = sampleColumns(lum, geo, s.pitch, n);

  progress('modelling the ribbons');
  let curvePts = null;
  if (s.curveOn) {
    const c = parseCurve(s.curve);
    if (c.pts) {
      curvePts = c.pts;
      if (c.mirrored) notes.push('the measured curve was given on one side only, so it was mirrored');
    } else notes.push(`measured curve not used (${c.problems.join('; ')}): the model stands in`);
    if (c.pts && c.problems.length) notes.push(`measured curve: ${c.problems.join('; ')}`);
  }
  const xv = W / 2 + s.viewXMm;
  const alphas = xs.map((x) => viewAngle(x, xv, s.distM));
  const Ylut = alphas.map((al) => ribbonLUT(s, al, curvePts));
  const Llut = Ylut.map(lightnessLUT);
  const range = reachRange(Ylut);
  if (range.Lmax - range.Lmin < 0.02) throw new Error('the ribbons cannot look different from one another at any angle: check the light and the measured curve');
  const Lt = cols.map((col) => Float32Array.from(col, (v) => toneMap(v, range, s.contrast)));

  const model = twistModel(s, H);
  const kmaxDeg = maxTwistDeg(s);
  const frame = sampleFrame(n, H, model);

  progress('finding the ideal twist');
  const ideal = Llut.map((L, i) => idealPath(L, Lt[i], dy, kmaxDeg));

  progress('placing brackets');
  let layout = s.layout;
  if (s.hold === 'combs' && layout === 'perRibbon') {
    layout = 'bunched';
    notes.push('combs hold a whole row, so per-ribbon heights became bunched rows');
  }
  const grid = knotGrid(frame, Math.max(dy, H > 2500 ? 10 : 5), s.minSpacing, s.maxSpan);
  let rows = null;
  if (layout === 'even') {
    const spans = Math.max(1, Math.round(H / s.rowSpacing));
    rows = Array.from({ length: spans + 1 }, (_, k) => (k * H) / spans);
    if (H / spans < s.minSpacing) notes.push(`even rows are ${len(H / spans)} apart, closer than the least spacing (${len(s.minSpacing)})`);
  } else if (layout === 'bunched') {
    const sum = new Float64Array(grid.Q.length * (grid.dmax + 1));
    for (let i = 0; i < N; i++) {
      const c = spanCosts(frame, Llut[i], Lt[i], ideal[i], kmaxDeg, grid);
      for (let k = 0; k < sum.length; k++) sum[k] += c[k];
    }
    const pk = placeKnots(sum, grid, Math.max(0, Math.round(s.maxRows)));
    rows = pk ? [0, ...pk.q.map((q) => q * dy), H] : [0, H];
    if (!pk) notes.push('no row layout fits the spacing limits: one span, bar to bar');
    else if (pk.forced) notes.push(`the longest span (${len(s.maxSpan)}) needs ${pk.count} rows, more than the ${s.maxRows} allowed`);
  }

  progress('choosing angles');
  const ribbons = [];
  let carry = null;
  let forcedRibbons = 0;
  for (let i = 0; i < N; i++) {
    const LtEff = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const v = Lt[i][j] + (carry ? carry[j] : 0);
      LtEff[j] = Math.min(range.Lmax + 0.1, Math.max(range.Lmin - 0.1, v));
    }
    let ys = rows, guide = ideal[i];
    if (!ys) {
      if (carry) guide = idealPath(Llut[i], LtEff, dy, kmaxDeg);
      const pk = placeKnots(spanCosts(frame, Llut[i], LtEff, guide, kmaxDeg, grid), grid, Math.max(0, Math.round(s.maxPerRibbon)));
      ys = pk ? [0, ...pk.q.map((q) => q * dy), H] : [0, H];
      if (pk && pk.forced) forcedRibbons++;
    }
    const centers = ys.map((y) => pathAt(guide, y / dy - 0.5));
    const { angles } = solveAngles(frame, Llut[i], LtEff, ys, centers, kmaxDeg);
    const knots = ys.map((y, k) => ({ y, a: angles[k] }));
    const th = pathFromKnots(frame, knots);
    const L = pathLightness(Llut[i], th);
    if (s.diffusion > 0) {
      const resid = new Float64Array(n);
      for (let j = 0; j < n; j++) resid[j] = LtEff[j] - L[j];
      carry = blur1(resid, s.pitch / dy).map((v) => s.diffusion * v);
    }
    ribbons.push({
      x: xs[i], alpha: alphas[i], knots,
      th: Float32Array.from(th), ideal: Float32Array.from(ideal[i]),
      Lt: Lt[i], L, Lideal: pathLightness(Llut[i], ideal[i]),
    });
  }
  if (forcedRibbons) notes.push(`${forcedRibbons} ribbons need more brackets than allowed to keep every span under ${len(s.maxSpan)}`);

  progress('checking');
  const stats = planStats(ribbons, model, kmaxDeg, n, dy, s.pitch);
  stats.ribbons = N;
  stats.rows = rows ? rows.length - 2 : null;
  if (stats.coil > 0.5) notes.push(`low tension: the most twisted span carries ${Math.round(stats.coil * 100)}% of the torque that can make a ribbon coil — raise the bar's tension`);
  if (stats.rateUse > 1 + 1e-6) notes.push(`a span twists at ${Math.round(stats.rateUse * 100)}% of the limit`);
  if (quarterTurnLength(s) > H) notes.push(`a quarter turn needs ${len(quarterTurnLength(s))}, longer than the ribbons: no ribbon can go from white to black`);
  return {
    piece: { W, H }, imageRect: geo.imageRect, n, dy, xv,
    ribbons, rows, layout, hold: s.hold, range, kmaxDeg, quarterTurn: quarterTurnLength(s),
    curvePts, s, stats, notes,
  };
}

/** A path's angle at fractional sample index u, clamped at the ends. */
function pathAt(th, u) {
  const n = th.length;
  if (u <= 0) return th[0];
  if (u >= n - 1) return th[n - 1];
  const j = Math.floor(u), f = u - j;
  return th[j] + (th[j + 1] - th[j]) * f;
}

/**
 * Errors in lightness ×100 (≈ ΔE for greys). `tone`: sample by sample against
 * the target; `seen`: after the eye's mixing -- neighbouring ribbons 1:2:1 and
 * about a pitch down the ribbon -- which is what error spreading improves.
 * Plus the brackets and the worst span's rate and coiling ratios.
 */
export function planStats(ribbons, model, kmaxDeg, n, dy, pitch) {
  const N = ribbons.length;
  const mix = (key) => {
    const cols = ribbons.map((r) => blur1(r[key], pitch / dy));
    return cols.map((c, i) => {
      const a = cols[Math.max(0, i - 1)], b = cols[Math.min(N - 1, i + 1)];
      return c.map((v, j) => (a[j] + 2 * v + b[j]) / 4);
    });
  };
  const tgt = mix('Lt'), got = mix('L'), idl = mix('Lideal');
  let tone = 0, seen = 0, seenIdeal = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < n; j++) {
      tone += Math.abs(ribbons[i].L[j] - ribbons[i].Lt[j]);
      seen += Math.abs(got[i][j] - tgt[i][j]);
      seenIdeal += Math.abs(idl[i][j] - tgt[i][j]);
    }
  }
  const cnt = N * n || 1;
  let brackets = 0, rateUse = 0, coil = 0, turns = 0;
  for (const r of ribbons) {
    brackets += r.knots.length - 2;
    for (let k = 0; k + 1 < r.knots.length; k++) {
      const A = r.knots[k], B = r.knots[k + 1], d = B.a - A.a;
      rateUse = Math.max(rateUse, model.peakRate(A.y, B.y, d) / kmaxDeg);
      coil = Math.max(coil, model.coilRatio(A.y, B.y, d));
      turns += Math.abs(d);
    }
  }
  return { tone: (100 * tone) / cnt, seen: (100 * seen) / cnt, seenIdeal: (100 * seenIdeal) / cnt, brackets, rateUse, coil, turnDeg: turns };
}
