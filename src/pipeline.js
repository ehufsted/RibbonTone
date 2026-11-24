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
import { viewAngle, ribbonLUT, lightnessLUT, parseCurve, backdropDistance, lutAt } from './core/optics.js';
import { planDepth, combDepth, combRowsOf, rowDepth } from './core/fab.js';
import { shadeSlope, makeShade, shadeCutoffs, shades } from './core/combshade.js';
import { chooseMirrors } from './core/align.js';
import { sampleColumns, reachRange, toneMap } from './core/target.js';
import { twistModel, maxTwistDeg, quarterTurnLength } from './core/twist.js';
import { idealPath, sampleFrame, knotGrid, spanCosts, placeKnots, solveAngles, pathFromKnots, pathLightness, blur1 } from './core/solve.js';

/**
 * Validation the app also uses, so it can say what is wrong before running --
 * or before writing a cutting file, for the settings that only change those.
 * Every number a person can type has its range here: zero and negative
 * values that would hang the solver, write NaN into a file, or quietly cut
 * nonsense get a message instead.
 */
export function problemWith(s) {
  if (!(s.widthMm > 0)) return 'enter a width';
  if (!(s.heightMm >= 0)) return 'height must be 0 (from the image) or more';
  if (!(s.ribbonW > 0) || !(s.pitch > 0) || !(s.thickness > 0)) return 'ribbon width, pitch and thickness must be more than 0';
  if (s.pitch < s.ribbonW) return 'the pitch must be at least the ribbon width, or neighbours collide when they turn';
  if (s.ribbonW > s.widthMm) return 'the ribbon is wider than the piece';
  if (!(s.strainPct > 0)) return 'the edge strain limit must be more than 0';
  if (!(s.tensionN > 0)) return 'the bottom bar must pull: tension must be more than 0';
  if (!(s.distM >= 0.3)) return 'the viewing distance must be at least 0.3 m';
  if (!(s.reflectance >= 0 && s.reflectance <= 1) || !(s.bgReflectance >= 0 && s.bgReflectance <= 1)) return 'reflectances run from 0 to 1';
  if (!(s.sheen >= 0)) return 'the sheen cannot be negative';
  if (!(s.gloss >= 1)) return 'the sheen tightness must be at least 1';
  if (!(s.density >= 0) || !(s.G >= 0)) return 'areal density and shear modulus cannot be negative';
  if (!(s.E > 0)) return 'the bending modulus must be more than 0';
  if (!(s.minSpacing > 0) || !(s.maxSpan >= s.minSpacing)) return 'brackets: the longest span must be at least the least spacing';
  if (s.layout === 'even' && !(s.rowSpacing >= 5)) return 'the row spacing must be at least 5 mm';
  if (!(s.maxRows >= 0) || !(s.maxPerRibbon >= 0)) return 'the most rows and most brackets per ribbon cannot be negative';
  // the cutting files
  if (!(s.slotClear >= 0) || !(s.minSlot >= 0)) return 'slot clearance and least slot width cannot be negative';
  if (!(s.combMargin > 0)) return 'the comb margin must be more than 0, or the deepest slot cuts the comb in two';
  if (!(s.combEnd >= 0)) return 'the comb ends cannot be negative';
  if (!(s.minWeb > 0)) return 'the least web must be more than 0';
  if (!(s.combThick > 0)) return 'the sheet thickness must be more than 0';
  if (!(s.clipWall > 0)) return 'the clip wall must be more than 0';
  if (!(s.standoff >= 0)) return 'the pin stand-off cannot be negative';
  return '';
}

/** The shortest piece, and the most even rows, a plan may have. */
export const MIN_HEIGHT = 50;
export const MAX_EVEN_ROWS = 400;

/**
 * @param {{width,height,data}} rgba
 * @param {object} settings  units.DEFAULTS
 * @param {{onProgress?:(stage:string)=>void}} opts
 */
export function runPipeline(rgba, settings, opts = {}) {
  // The box's back wall sits against the deepest comb, and comb depths follow
  // the angles (core/fab.js rowDepth): solve with the deepest a comb can be,
  // then once more with the depth that came out, if it moved the wall.
  // With comb shadows, each comb's own depth sets its shadow, so the second
  // solve always runs, with every row's depth from the first.
  const first = solveOnce(rgba, settings, opts);
  const deepest = planDepth(first);
  const wallMoved = Math.abs(backdropDistance({ ...first.s, backDepth: deepest }) - backdropDistance(first.s)) >= 0.25;
  if (!wallMoved && !first.combShade) {
    first.s.backDepth = deepest;
    return first;
  }
  if (opts.onProgress) opts.onProgress(first.combShade ? 'again, with each comb\'s depth' : 'again, for the box\'s depth');
  const rowDepths = combRowsOf(first).map((r) => ({ y: r.y, D: rowDepth(r.angles, first.s) }));
  const second = solveOnce(rgba, { ...settings, backDepth: deepest, rowDepths }, opts);
  // the wall the solve assumed stays, unless this solve's combs came out deeper still
  const deeper = planDepth(second);
  second.s.backDepth = Math.max(deepest, deeper);
  if (deeper > deepest + 0.25) {
    second.notes.push(`the deepest comb came out ${lenText(deeper - deepest, second.s.units)} deeper than the solve assumed: the back wall sits there, a little behind what the shadows were modelled for`);
  }
  return second;
}

function solveOnce(rgba, settings, opts = {}) {
  const s = { ...DEFAULTS, ...settings };
  // the alignment weight: the toggle's ±1 (the harness may set `align` itself, 0 for none)
  if (!(typeof s.align === 'number')) s.align = s.alignTwists ? 1 : -1;
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
  if (!(H >= MIN_HEIGHT)) throw new Error(`the piece is ${lenText(H, s.units)} tall: it must be at least ${lenText(MIN_HEIGHT, s.units)}`);
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
  // comb shadows (core/combshade.js): a light from above and in front, and the model, not a measured curve
  const slope = shadeSlope(s);
  if (s.combShadows && curvePts) notes.push('comb shadows are not modelled with a measured curve: it cannot be split into direct and ambient light');
  if (s.combShadows && s.combLook === 'clear') notes.push('clear combs cast almost no shadow: comb shadows are not modelled');
  const shadeOn = !!(s.combShadows && slope && !curvePts && s.combLook !== 'clear');
  // a comb's front edge: its own depth from the first solve, else the deepest a comb can be
  const zfAt = (y) => {
    const hit = (s.rowDepths || []).find((e) => Math.abs(e.y - y) < 1);
    return (hit ? hit.D : s.backDepth > 0 ? s.backDepth : combDepth(s)) / 2;
  };
  const alphas = xs.map((x) => viewAngle(x, xv, s.distM));
  const Ylut = alphas.map((al) => ribbonLUT(s, al, curvePts));
  const Llut = Ylut.map(lightnessLUT);
  const shadeModels = shadeOn ? alphas.map((al) => makeShade(s, al, backdropDistance(s))) : null;
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
    if (spans > MAX_EVEN_ROWS) throw new Error(`a row spacing of ${len(s.rowSpacing)} gives ${spans} rows: widen it (at most ${MAX_EVEN_ROWS} rows)`);
    rows = Array.from({ length: spans + 1 }, (_, k) => (k * H) / spans);
    if (H / spans < s.minSpacing) notes.push(`even rows are ${len(H / spans)} apart, closer than the least spacing (${len(s.minSpacing)})`);
  } else if (layout === 'bunched') {
    const sum = new Float64Array(grid.Q.length * (grid.dmax + 1));
    for (let i = 0; i < N; i++) {
      // with comb shadows, a candidate row's cost includes the shadow its comb casts
      // (no row's own depth yet, so the deepest: zfAt finds no row at y = −1)
      const so = shadeOn && s.hold === 'combs' ? { shade: shadeModels[i], zf: zfAt(-1), k: slope, t: s.combThick } : {};
      const c = spanCosts(frame, Llut[i], Lt[i], ideal[i], kmaxDeg, grid, so);
      for (let k = 0; k < sum.length; k++) sum[k] += c[k];
    }
    const pk = placeKnots(sum, grid, Math.max(0, Math.round(s.maxRows)));
    rows = pk ? [0, ...pk.q.map((q) => q * dy), H] : [0, H];
    if (!pk) notes.push('no row layout fits the spacing limits: one span, bar to bar');
    else if (pk.forced) notes.push(`the longest span (${len(s.maxSpan)}) needs ${pk.count} rows, more than the ${s.maxRows} allowed`);
  }

  // the combs that cast shadows: every shared row with combs; with pins, the two bars
  const combYs = s.hold === 'combs' && rows ? rows : [0, H];
  const zcAll = slope ? shadeCutoffs(combYs.map((y) => ({ y, zf: zfAt(y) })), n, dy, s) : null;
  const zc = shadeOn ? zcAll : null;

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
    // with alignment, every ribbon leans toward (or away from) the one on its left
    const al = s.align && i > 0 ? { prev: ribbons[i - 1].th, alignK: s.align * ALIGN_K } : {};
    let ys = rows, guide = ideal[i];
    // the angle search centres on the ideal path; it is solved again for this ribbon
    // when it leans on its left neighbour (alignment, always with the toggle), or
    // takes spread error with its own bracket heights; shared rows without
    // alignment keep the plain one
    const so = shadeOn ? { shade: shadeModels[i], zc } : {};
    if ((carry && !rows) || al.prev || shadeOn) guide = idealPath(Llut[i], LtEff, dy, kmaxDeg, { ...al, ...so });
    if (!ys) {
      const pk = placeKnots(spanCosts(frame, Llut[i], LtEff, guide, kmaxDeg, grid), grid, Math.max(0, Math.round(s.maxPerRibbon)));
      ys = pk ? [0, ...pk.q.map((q) => q * dy), H] : [0, H];
      if (pk && pk.forced) forcedRibbons++;
    }
    const centers = ys.map((y) => pathAt(guide, y / dy - 0.5));
    const { angles } = solveAngles(frame, Llut[i], LtEff, ys, centers, kmaxDeg, { ...al, ...so });
    const knots = ys.map((y, k) => ({ y, a: angles[k] }));
    const th = pathFromKnots(frame, knots);
    const L = pathLightness(Llut[i], th, so.shade, so.zc);
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

  progress('choosing twist directions');
  // mirror whole ribbons where it helps the tone, or lines neighbours up (core/align.js)
  // scored with the comb shadows where they are modelled (mirroring changes how much a shadow covers)
  const lightAt = shadeOn ? (i, th, j) => (shades(zc[j], shadeModels[i]) ? shadeModels[i].L(th, zc[j]) : lutAt(Llut[i], th)) : null;
  const mirror = chooseMirrors(ribbons.map((r) => r.th), Llut, Lt, s.align, alphas, lightAt);
  let mirrored = 0;
  ribbons.forEach((r, i) => {
    if (!mirror[i]) return;
    mirrored++;
    // about the direction to the viewer: the ribbon looks the same from the design viewpoint
    const m = (v) => 2 * r.alpha - v;
    r.knots = r.knots.map((k) => ({ y: k.y, a: m(k.a) }));
    r.th = r.th.map(m);
    r.ideal = r.ideal.map(m);
    r.L = pathLightness(Llut[i], r.th, shadeOn ? shadeModels[i] : null, zc);
    r.Lideal = pathLightness(Llut[i], r.ideal);
  });

  if (zcAll && s.hold === 'combs') {
    let n0 = 0;
    for (const v of zcAll) if (v >= 0) n0++;
    const pct = Math.round((100 * n0) / n);
    if (pct > 0) {
      notes.push(shadeOn
        ? `comb shadows cover ${pct}% of the ribbons' height (face-on): the solver allows for them`
        : s.combLook === 'clear' ? `solid combs would shade ${pct}% of the ribbons' height (face-on); clear ones hardly any`
          : `solid combs would shade ${pct}% of the ribbons' height (face-on) under this light: tick "Model comb shadows", use clear combs, or light from lower down`);
    }
  }

  progress('checking');
  const stats = planStats(ribbons, model, kmaxDeg, n, dy, s.pitch);
  stats.mirrored = mirrored;
  stats.offAxis = offAxisDistortion(ribbons, s, xv, curvePts, n, dy, OFF_AXIS_MM, shadeOn ? { zc, W: backdropDistance(s) } : null);
  stats.ribbons = N;
  stats.rows = rows ? rows.length - 2 : null;
  if (stats.coil > 0.5) notes.push(`low tension: the most twisted span carries ${Math.round(stats.coil * 100)}% of the torque that can make a ribbon coil — raise the bar's tension`);
  if (stats.rateUse > 1 + 1e-6) notes.push(`a span twists at ${Math.round(stats.rateUse * 100)}% of the limit`);
  if (quarterTurnLength(s) > H) notes.push(`a quarter turn needs ${len(quarterTurnLength(s))}, longer than the ribbons: no ribbon can go from white to black`);
  return {
    combShade: shadeOn ? { zc, W: backdropDistance(s), reach: s.ribbonW / 2 } : null,
    piece: { W, H }, imageRect: geo.imageRect, n, dy, xv,
    ribbons, rows, layout, hold: s.hold, range, kmaxDeg, quarterTurn: quarterTurnLength(s),
    curvePts, s, stats, notes,
  };
}

/**
 * The alignment cost per sample at Twist alignment ±1 (core/solve.js
 * alignCost): about the squared error of 1.4 lightness units for neighbours
 * crossed at 90°, so it settles which way a ribbon turns but seldom trades
 * away tone.
 */
export const ALIGN_K = 2e-4;

/** How far to either side the off-axis figure looks from, mm. */
export const OFF_AXIS_MM = 1000;

/**
 * What happens for a viewer `walk` mm to either side (at the design distance),
 * against what the design viewpoint shows. Two measures, lightness × 100, the
 * mean of the two sides:
 *
 *   tone:    the change as the eye blends neighbours (see planStats), a
 *            uniform shift taken out (a whole picture a little brighter or
 *            darker is still the picture);
 *   stripes: how differently NEIGHBOURS change, each ribbon on its own (a
 *            pitch down it, no blending): the stripe pattern a viewer close
 *            enough to see single ribbons gets.
 *
 * Opposed neighbours (core/align.js) brighten and darken by turns, which
 * cancels in the blend (steady tone) but is exactly a stripe pattern up
 * close. Aligned ones change together: few stripes, and a steadier blend than
 * ribbons turned every which way.
 */
export function offAxisDistortion(ribbons, s, xv, curvePts, n, dy, walk, combShade = null) {
  const here = ribbons.map((r) => r.L);
  const hereMix = seenMix(here, dy, s.pitch);
  let tone = 0, stripes = 0;
  for (const dx of [-walk, walk]) {
    // the moved viewer sees the same comb shadows (the design view's L has them): only the view changes
    const there = ribbons.map((r) => {
      const al = viewAngle(r.x, xv + dx, s.distM);
      const shade = combShade ? makeShade(s, al, combShade.W) : null;
      return pathLightness(lightnessLUT(ribbonLUT(s, al, curvePts)), r.th, shade, combShade && combShade.zc);
    });
    const thereMix = seenMix(there, dy, s.pitch);
    let mean = 0, cnt = 0;
    thereMix.forEach((c, i) => c.forEach((v, j) => { mean += v - hereMix[i][j]; cnt++; }));
    mean /= cnt || 1;
    let e = 0;
    thereMix.forEach((c, i) => c.forEach((v, j) => { e += Math.abs(v - hereMix[i][j] - mean); }));
    tone += (100 * e) / (cnt || 1);
    const change = there.map((c, i) => blur1(Float64Array.from(c, (v, j) => v - here[i][j]), s.pitch / dy));
    let d = 0, pairs = 0;
    for (let i = 1; i < change.length; i++) for (let j = 0; j < n; j++) { d += Math.abs(change[i][j] - change[i - 1][j]); pairs++; }
    stripes += (100 * d) / (pairs || 1);
  }
  return { tone: tone / 2, stripes: stripes / 2 };
}

/** Columns as the eye mixes them: a pitch down each, then neighbours 1:2:1. */
function seenMix(cols, dy, pitch) {
  const blurred = cols.map((c) => blur1(c, pitch / dy));
  const N = blurred.length;
  return blurred.map((c, i) => {
    const a = blurred[Math.max(0, i - 1)], b = blurred[Math.min(N - 1, i + 1)];
    return c.map((v, j) => (a[j] + 2 * v + b[j]) / 4);
  });
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
  const mix = (key) => seenMix(ribbons.map((r) => r[key]), dy, pitch);
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
