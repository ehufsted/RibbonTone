// Which way each ribbon turns: mirroring whole ribbons for coherence.
//
// A ribbon's angles can all be negated (θ → −θ, every twist reversed) without
// breaking a single limit: the twist rate is the same, the brackets the same
// heights. With two-sided white ribbons and a light near the front, −θ looks
// almost exactly like +θ from the design viewpoint. What differs is how the
// ribbon answers a MOVING viewer: one who steps sideways sees every ribbon at
// θ − α for a slightly larger α. Neighbours turned the same way then brighten
// or darken together; neighbours turned opposite ways go opposite ways.
//
// MEASURED, the two do not simply rank better and worse (pipeline.js
// offAxisDistortion): opposed neighbours change in opposite directions, which
// CANCELS where the eye blends them -- the blended tone holds best -- but is a
// stripe pattern wherever single ribbons are seen. Aligned neighbours show no
// stripes, but the blended tone moves with the viewer (by more in mid-tones).
// So + suits a piece seen close, or as louvres that should read as one surface;
// − suits a piece seen from far enough that ribbons blend, or one meant to
// shimmer into stripes as people pass.
//
// After the solve, each ribbon is kept or mirrored, chosen exactly over the
// whole row of ribbons (Viterbi over two states per ribbon):
//
//     cost = Σ tone error(ribbon as kept or mirrored)
//          + 2·w · Σ misalignment(neighbours)
//
// tone error: mean |ΔL| × 100 against the target (the units of the stats);
// misalignment: the mean angle between neighbours at each height, modulo 180°,
// as a share of 90° (0 = parallel, 1 = crossed). w is the "Twist alignment"
// setting: +1 prefers neighbours alike, 0 tone only (mirroring can still
// help under a light off to one side), −1 prefers them opposed.

import { lutAt } from './optics.js';

/** Angle between two orientations (mod 180°), as a share of 90°: 0 parallel … 1 crossed. */
function orientGap(a, b) {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d / 90;
}

/** Mean misalignment of two paths, sample by sample. */
export function misalignment(thA, thB) {
  let s = 0;
  for (let j = 0; j < thA.length; j++) s += orientGap(thA[j], thB[j]);
  return s / (thA.length || 1);
}

/** Mean |ΔL| × 100 of a path against a target, through a lightness LUT. */
function toneError(Llut, th, Lt, sign) {
  let e = 0;
  for (let j = 0; j < th.length; j++) e += Math.abs(lutAt(Llut, sign * th[j]) - Lt[j]);
  return (100 * e) / (th.length || 1);
}

/**
 * @param {Float64Array[]|Float32Array[]} paths  each ribbon's angle per sample
 * @param {Float32Array[]} Lluts  each ribbon's lightness LUT
 * @param {Float32Array[]} targets  each ribbon's target lightness
 * @param {number} w  alignment weight, −1 … 1
 * @returns {boolean[]}  mirror this ribbon?
 */
export function chooseMirrors(paths, Lluts, targets, w) {
  const N = paths.length;
  if (!N) return [];
  const unary = paths.map((th, i) => [toneError(Lluts[i], th, targets[i], 1), toneError(Lluts[i], th, targets[i], -1)]);
  // pairwise: only whether the two are mirrored alike matters (negating both keeps the gap)
  const pair = [];
  for (let i = 1; i < N; i++) {
    const neg = Float64Array.from(paths[i], (v) => -v);
    pair.push([misalignment(paths[i - 1], paths[i]), misalignment(paths[i - 1], neg)]);
  }
  let D = [unary[0][0], unary[0][1]];
  const back = [];
  for (let i = 1; i < N; i++) {
    const [same, diff] = pair[i - 1];
    const nd = [0, 0], bk = [0, 0];
    for (let b = 0; b < 2; b++) {
      let best = Infinity;
      for (let a = 0; a < 2; a++) {
        const c = D[a] + 2 * w * (a === b ? same : diff) + unary[i][b];
        if (c < best) { best = c; bk[b] = a; }
      }
      nd[b] = best;
    }
    back.push(bk);
    D = nd;
  }
  const out = new Array(N);
  let s = D[1] < D[0] ? 1 : 0;
  for (let i = N - 1; i >= 0; i--) { out[i] = s === 1; if (i > 0) s = back[i - 1][s]; }
  return out;
}
