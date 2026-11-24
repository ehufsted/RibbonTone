// Choosing the angles, the twist directions and (when spacing is uneven) the
// bracket heights. Three exact dynamic programs, each small enough to run per
// ribbon in a worker:
//
// 1. THE IDEAL PATH (`idealPath`). With brackets everywhere, what is the best
//    angle at every sample, if the angle may change by at most κmax per mm?
//    Viterbi over angle states (one half turn, ≤ 1° apart; both faces are
//    white, so the state is θ mod 180° and the path is unwrapped as it goes).
//    Each step moves at most κmax·dy, in either direction, so the path chooses
//    its own twist directions. It is the best any bracket layout can do, the
//    "Ideal" view, and the guide for the next two.
//
// 2. WHERE THE BRACKETS GO (`placeKnots`). Candidate heights on a grid; a span
//    between two candidates costs the tone error of a ribbon whose angle runs
//    between the ideal path's values at its ends, along the tension-weighted
//    profile (core/twist.js). Shortest path over the grid, with spans between
//    minSpacing and maxSpan, and a price λ per bracket, bisected until the count
//    fits. Shared rows sum the span costs of every ribbon, so the rows bunch
//    where the image changes most; per-ribbon heights run it per ribbon.
//
// 3. THE ANGLES AT THE BRACKETS (`solveAngles`). Heights fixed, the true
//    objective: Viterbi over each bracket's angle, in a window around the
//    ideal path's value, where a transition is allowed only if the span's PEAK
//    rate stays within κmax and costs the tone error along the span exactly.
//    The sign of each span's twist falls out of it.
//
// The tone error everywhere is the squared difference in lightness (OKLab L,
// core/optics.js) between what the ribbon shows and what it should.
//
// ALIGNMENT (opts.prev, opts.alignK). Ribbons are solved left to right; 1 and
// 3 may add, at every sample, a small cost for turning differently from the
// ribbon on the left (alignK > 0: k·gap², gap = the angle between them modulo
// 180° as a share of 90°) or alike (alignK < 0: |k|·(1 − gap)²). It is small
// beside the tone error, so it decides between angles that look about the
// same -- above all a ribbon's choice of turning one way or the other.

import { LUT_N, LUT_STEP } from './optics.js';

const INV_STEP = 1 / LUT_STEP;

/** The alignment cost of angle th beside the left neighbour's angle p (see above). */
export function alignCost(th, p, k) {
  let d = Math.abs(th - p) % 180;
  if (d > 90) d = 180 - d;
  const g = d / 90;
  return k > 0 ? k * g * g : -k * (1 - g) * (1 - g);
}

/** Lightness LUT at an unwrapped angle (degrees), linear between entries. */
function lutL(L, th) {
  let u = th * INV_STEP;
  u -= LUT_N * Math.floor(u / LUT_N);
  // a hair below a multiple of 180° wraps to exactly LUT_N in floating point
  if (u >= LUT_N) u -= LUT_N;
  const k = u | 0, f = u - k;
  const a = L[k], b = L[k + 1 === LUT_N ? 0 : k + 1];
  return a + (b - a) * f;
}

/**
 * 1. The best angle at every sample under the rate limit alone.
 * @param {Float32Array} Llut  lightness over a half turn (optics.lightnessLUT)
 * @param {ArrayLike<number>} Lt  target lightness per sample
 * @param {number} dy  sample spacing, mm
 * @param {number} kmaxDeg  degrees per mm
 * @returns {Float64Array} θ per sample, degrees, unwrapped
 */
export function idealPath(Llut, Lt, dy, kmaxDeg, opts = {}) {
  const prev = opts.prev, alignK = opts.alignK || 0, aligned = !!(prev && alignK);
  const n = Lt.length;
  const stepMax = kmaxDeg * dy;                      // degrees one sample may turn
  const M = Math.ceil(180 / Math.min(1, stepMax));
  // a backstop: the pipeline keeps pieces tall enough that this never trips
  if (!(M <= 7200)) throw new Error('the samples are too close together to solve (the piece is too short)');
  const r = 180 / M;
  const mMax = Math.max(1, Math.floor(stepMax / r + 1e-9));
  const Ls = new Float64Array(M);
  for (let a = 0; a < M; a++) Ls[a] = lutL(Llut, a * r);
  // a whisper of cost per degree turned, so a flat tone holds still
  const turn = 1e-7;
  let D = new Float64Array(M), D2 = new Float64Array(M);
  const back = new Int8Array(n * M);
  for (let a = 0; a < M; a++) { const e = Ls[a] - Lt[0]; D[a] = e * e + (aligned ? alignCost(a * r, prev[0], alignK) : 0); }
  for (let j = 1; j < n; j++) {
    const t = Lt[j], row = j * M;
    for (let a = 0; a < M; a++) {
      let best = Infinity, bm = 0;
      for (let m = -mMax; m <= mMax; m++) {
        let p = a - m;
        if (p < 0) p += M; else if (p >= M) p -= M;
        const c = D[p] + turn * (m < 0 ? -m : m);
        if (c < best) { best = c; bm = m; }
      }
      const e = Ls[a] - t;
      D2[a] = best + e * e + (aligned ? alignCost(a * r, prev[j], alignK) : 0);
      back[row + a] = bm;
    }
    const tmp = D; D = D2; D2 = tmp;
  }
  let a = 0;
  for (let k = 1; k < M; k++) if (D[k] < D[a]) a = k;
  // walk back, then unwrap forward from the first state
  const states = new Int32Array(n), moves = new Int8Array(n);
  for (let j = n - 1; j >= 0; j--) {
    states[j] = a;
    if (j > 0) { const m = back[j * M + a]; moves[j] = m; a -= m; if (a < 0) a += M; else if (a >= M) a -= M; }
  }
  const th = new Float64Array(n);
  th[0] = wrapNear(states[0] * r, 0);
  for (let j = 1; j < n; j++) th[j] = th[j - 1] + moves[j] * r;
  return th;
}

/** a + k·180° nearest to `near`. */
export const wrapNear = (a, near) => a - 180 * Math.round((a - near) / 180);

/** The ideal path's angle at sample boundary q (0…n): the mean of its neighbours. */
export function pathAtBoundary(th, q) {
  const n = th.length;
  if (q <= 0) return th[0];
  if (q >= n) return th[n - 1];
  return (th[q - 1] + th[q]) / 2;
}

/**
 * Precomputed sample geometry: centres, F at centres and boundaries.
 * @param {object} model  core/twist.js twistModel
 */
export function sampleFrame(n, H, model) {
  const dy = H / n;
  const yc = new Float64Array(n), Fc = new Float64Array(n), Fb = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) { yc[j] = (j + 0.5) * dy; Fc[j] = model.F(yc[j]); }
  for (let q = 0; q <= n; q++) Fb[q] = model.F(q * dy);
  return { n, H, dy, yc, Fc, Fb, model };
}

/**
 * The candidate bracket heights (sample boundaries, `g` samples apart, both bars
 * included) and the cost of every allowed span between them, for one ribbon.
 * The span's angle runs between the ideal path's values at its ends; where the
 * peak rate would break the limit, the twist is clamped to it (the angle DP
 * later fixes the ends for real).
 */
export function spanCosts(frame, Llut, Lt, th, kmaxDeg, grid) {
  const { yc, Fc, Fb, model } = frame;
  const { Q, dmin, dmax } = grid;
  const P = Q.length, D = dmax + 1;
  const cost = new Float64Array(P * D).fill(Infinity);
  const thb = Q.map((q) => pathAtBoundary(th, q));
  for (let ia = 0; ia < P - 1; ia++) {
    const qa = Q[ia];
    for (let d = dmin; d <= dmax && ia + d < P; d++) {
      const qb = Q[ia + d];
      const yb = qb * frame.dy;
      let delta = thb[ia + d] - thb[ia];
      const den = Fb[qb] - Fb[qa];
      const peak = Math.abs(delta) / (model.k(yb) * den);
      if (peak > kmaxDeg) delta *= kmaxDeg / peak;
      let c = 0;
      for (let j = qa; j < qb; j++) {
        const e = lutL(Llut, thb[ia] + (delta * (Fc[j] - Fb[qa])) / den) - Lt[j];
        c += e * e;
      }
      cost[ia * D + d] = c;
    }
  }
  return cost;
}

/**
 * The candidate grid: sample boundaries about gridMm apart (both bars always
 * in), and the least and most grid steps a span may take.
 */
export function knotGrid(frame, gridMm, minSpacing, maxSpan) {
  const { n, dy } = frame;
  const g = Math.max(1, Math.round(gridMm / dy));
  const Q = [];
  for (let q = 0; q < n; q += g) Q.push(q);
  if (Q[Q.length - 1] !== n) {
    // the last step would be a sliver: end on the bar instead
    if (Q.length > 1 && n - Q[Q.length - 1] < g / 2) Q[Q.length - 1] = n; else Q.push(n);
  }
  const step = (frame.H / n) * g;
  const dmin = Math.max(1, Math.ceil(minSpacing / step - 1e-9));
  const dmax = Math.max(dmin, Math.floor(maxSpan / step + 1e-9));
  return { Q, g, dmin, dmax, step };
}

/**
 * 2. Bracket heights: the cheapest chain of spans from the top bar to the
 * bottom one with at most maxCount brackets between them.
 * @param {Float64Array} cost  spanCosts (summed over ribbons for shared rows)
 * @returns {{q: number[], count: number, cost: number, forced: boolean}}
 *   q: the interior brackets' sample boundaries; forced: maxSpan needs more
 *   brackets than maxCount allows, so the count was exceeded
 */
export function placeKnots(cost, grid, maxCount) {
  const { Q, dmax } = grid;
  const P = Q.length, D = dmax + 1, last = P - 1;
  const best = new Float64Array(P), cnt = new Int32Array(P), from = new Int32Array(P);
  const run = (lambda) => {
    best.fill(Infinity); best[0] = 0; cnt[0] = 0;
    for (let ib = 1; ib < P; ib++) {
      const extra = ib < last ? lambda : 0;
      for (let d = 1; d <= dmax && d <= ib; d++) {
        const ia = ib - d, c = cost[ia * D + d];
        if (c === Infinity || best[ia] === Infinity) continue;
        const v = best[ia] + c + extra;
        if (v < best[ib]) { best[ib] = v; cnt[ib] = cnt[ia] + (ib < last ? 1 : 0); from[ib] = ia; }
      }
    }
    if (best[last] === Infinity) return null;
    const q = [];
    for (let i = from[last]; i > 0; i = from[i]) q.push(Q[i]);
    q.reverse();
    return { q, count: cnt[last], cost: best[last] - lambda * cnt[last] };
  };
  const lo0 = 1e-9;
  let sol = run(lo0);
  if (!sol) return null;
  if (sol.count <= maxCount) return { ...sol, forced: false };
  // a price that no bracket can repay: a bracket saves at most the cost of the
  // chain without it, which is at most every finite span cost added up (summed
  // over all the ribbons, for shared rows)
  let total = 0;
  for (const c of cost) if (c !== Infinity) total += c;
  let hi = 1 + total, hiSol = run(hi);
  if (hiSol.count > maxCount) return { ...hiSol, forced: true };
  let lo = lo0;
  for (let it = 0; it < 40; it++) {
    const mid = Math.sqrt(lo * hi);
    const s = run(mid);
    if (s.count <= maxCount) { hi = mid; hiSol = s; } else lo = mid;
    if (hi / lo < 1.0001) break;
  }
  return { ...hiSol, forced: false };
}

/**
 * 3. The angles at fixed bracket heights, exactly, for one ribbon.
 * @param {number[]} ys  bracket heights from 0 (top bar) to H (bottom bar), mm
 * @param {number[]} centers  each bracket's window centre (the ideal path there), degrees
 * @param {{window?: number, res?: number}} opts  half-width and step of the window, degrees
 * @returns {{angles: number[], cost: number}}  unwrapped degrees per bracket
 */
export function solveAngles(frame, Llut, Lt, ys, centers, kmaxDeg, opts = {}) {
  const prev = opts.prev, alignK = opts.alignK || 0, aligned = !!(prev && alignK);
  const { yc, Fc, model, dy } = frame;
  const half = opts.window ?? 30, res = opts.res ?? 1;
  const S = Math.round(half / res), M = 2 * S + 1;
  const K = ys.length;
  const spans = [];
  for (let k = 0; k + 1 < K; k++) {
    // the samples whose centres fall in [ya, yb); the last span takes the rest
    const ya = ys[k], yb = ys[k + 1];
    const j0 = Math.max(0, Math.ceil(ya / dy - 0.5 - 1e-9));
    const j1 = k + 2 === K ? frame.n : Math.max(j0, Math.ceil(yb / dy - 0.5 - 1e-9));
    const Fa = model.F(ya), den = model.F(yb) - Fa;
    const f = new Float64Array(Math.max(0, j1 - j0));
    for (let j = j0; j < j1; j++) f[j - j0] = den > 0 ? Math.min(1, Math.max(0, (Fc[j] - Fa) / den)) : 0;
    spans.push({ j0, j1, f, kb: model.k(yb) * den });
  }
  const ctr = centers.slice();
  const stateAt = (k, s) => ctr[k] + (s - S) * res;
  let D = new Float64Array(M).fill(0);
  const back = [];
  for (let k = 0; k + 1 < K; k++) {
    const sp = spans[k], next = new Float64Array(M).fill(Infinity), bk = new Int32Array(M).fill(-1);
    const fill = () => {
      for (let b = 0; b < M; b++) {
        const tb = stateAt(k + 1, b);
        for (let a = 0; a < M; a++) {
          if (D[a] === Infinity) continue;
          const ta = stateAt(k, a), delta = tb - ta;
          if (sp.kb > 0 ? Math.abs(delta) / sp.kb > kmaxDeg * (1 + 1e-9) : delta !== 0) continue;
          let c = D[a];
          for (let j = sp.j0; j < sp.j1 && c < next[b]; j++) {
            const th = ta + delta * sp.f[j - sp.j0];
            const e = lutL(Llut, th) - Lt[j];
            c += e * e + (aligned ? alignCost(th, prev[j], alignK) : 0);
          }
          if (c < next[b]) { next[b] = c; bk[b] = a; }
        }
      }
    };
    fill();
    if (!next.some(isFinite)) {
      // the window drifted out of reach: re-centre it on the best reachable angle
      let a0 = 0;
      for (let a = 1; a < M; a++) if (D[a] < D[a0]) a0 = a;
      ctr[k + 1] = stateAt(k, a0);
      fill();
    }
    back.push(bk);
    D = next;
  }
  let s = 0;
  for (let b = 1; b < M; b++) if (D[b] < D[s]) s = b;
  const cost = D[s];
  const idx = new Int32Array(K);
  idx[K - 1] = s;
  for (let k = K - 2; k >= 0; k--) { s = back[k][s]; idx[k] = s; }
  return { angles: Array.from(idx, (v, k) => stateAt(k, v)), cost };
}

/**
 * The angle at every sample, from brackets: within each span along the
 * tension-weighted profile.
 * @param {{y:number, a:number}[]} knots  top bar to bottom bar
 */
export function pathFromKnots(frame, knots) {
  const { n, yc, model } = frame;
  const th = new Float64Array(n);
  let k = 0;
  for (let j = 0; j < n; j++) {
    while (k + 2 < knots.length && yc[j] >= knots[k + 1].y) k++;
    const A = knots[k], B = knots[k + 1];
    const f = Math.min(1, Math.max(0, model.profile(A.y, B.y, yc[j])));
    th[j] = A.a + (B.a - A.a) * f;
  }
  return th;
}

/** Lightness along a path. */
export function pathLightness(Llut, th) {
  const out = new Float32Array(th.length);
  for (let j = 0; j < th.length; j++) out[j] = lutL(Llut, th[j]);
  return out;
}

/** Gaussian blur of a 1-D signal, sigma in samples, edges clamped. */
export function blur1(v, sigma) {
  if (!(sigma > 0.3)) return Float64Array.from(v);
  const r = Math.ceil(3 * sigma), w = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const g = Math.exp(-(i * i) / (2 * sigma * sigma)); w.push(g); sum += g; }
  const n = v.length, out = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += w[i + r] * v[Math.min(n - 1, Math.max(0, j + i))];
    out[j] = acc / sum;
  }
  return out;
}
