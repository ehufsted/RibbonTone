// How bright a twisted ribbon looks: the model the whole design is solved
// against, and the measured curve that can replace it.
//
// ONE PITCH AT A TIME. From a distance the eye averages a ribbon and the gap
// beside it, so the unit of brightness is one pitch: the visible share c of it
// covered by ribbon, at the face's brightness F, plus the rest at the backdrop's:
//
//     Y = c·F + (1 − c)·Ybg,      c = min(1, (w|cos(θ−α)| + t|sin(θ−α)|) / (p·cos α))
//
// where the backdrop's share is darkened by the ribbons' own shadows on it
// (backdropLit, below): little on a black backdrop, a lot on a white one.
//
// α is the direction to the viewer from this ribbon (each ribbon sees the
// viewer from a slightly different side), so the face is seen at θ − α, and the
// pitch itself is foreshortened by cos α.
//
// THE FACE. Lambert plus a satin sheen, under one directional light and an
// ambient share:
//
//     F = ρ·(amb + (1 − amb)·max(0, n_v·L)) + sheen·max(0, n_v·h)^gloss
//
// n_v is the face normal on the side the viewer sees (both faces are white),
// L the light direction (azimuth lightAz from straight on toward the right,
// elevation lightEl), h the half vector between L and the view. A light off to
// one side makes +θ and −θ differ -- one side's face turns away from the light
// and goes dark before it is edge-on -- which is why the solver chooses each
// twist's direction instead of treating the sign as free.
//
// Y is relative luminance: 1 is a perfect white card facing a light that is
// straight on it. Only ratios matter downstream (core/target.js maps the image
// into the range the ribbons can reach), so the absolute scale is irrelevant.
//
// THE MEASURED CURVE. "angle value" lines, read from a photo of the calibration
// comb (core/fab.js) at the viewing distance, each value averaged over one whole
// pitch (ribbon and gap). Values over 1 are taken as 0–255 photo readings and
// linearized; values in [0,1] as linear already. Angles are relative to the
// camera; a curve given only on 0…90° is mirrored. It replaces Y at θ − α, the
// angle the ribbon is seen at, which is exact for the camera's ribbon and an
// approximation for the others (their lighting differs slightly).

import { toLinear } from './color.js';
import { combDepth, pinWallDepth } from './fab.js';

const RAD = Math.PI / 180;
export const LUT_STEP = 0.5;                 // degrees per LUT entry
export const LUT_N = Math.round(180 / LUT_STEP);

/** Direction from a ribbon at x to the viewer, degrees (+ = viewer to its right). */
export const viewAngle = (x, xv, distM) => Math.atan2(xv - x, distM * 1000) / RAD;

/** The backdrop's brightness: a vertical surface facing +z. */
export function backdropY(s) {
  const amb = s.ambient;
  const lz = Math.cos(s.lightEl * RAD) * Math.cos(s.lightAz * RAD);
  return s.bgReflectance * (amb + (1 - amb) * Math.max(0, lz));
}

/**
 * The model at one angle: coverage c, face brightness F, and the pitch's Y.
 * @param {number} th  ribbon angle, degrees
 * @param {number} al  view angle α, degrees
 */
export function pitchModel(th, al, s, ybg = backdropY(s)) {
  const rel = (th - al) * RAD;
  const cr = Math.cos(rel), sr = Math.sin(rel);
  const ca = Math.cos(al * RAD);
  const c = Math.min(1, (s.ribbonW * Math.abs(cr) + s.thickness * Math.abs(sr)) / (s.pitch * ca));
  const side = cr >= 0 ? 1 : -1;                         // the face the viewer sees
  const nx = side * Math.sin(th * RAD), nz = side * Math.cos(th * RAD);
  const ce = Math.cos(s.lightEl * RAD);
  const Lx = ce * Math.sin(s.lightAz * RAD), Ly = Math.sin(s.lightEl * RAD), Lz = ce * Math.cos(s.lightAz * RAD);
  const lit = Math.max(0, nx * Lx + nz * Lz);
  const Famb = s.reflectance * s.ambient;
  let Fdir = s.reflectance * (1 - s.ambient) * lit;
  if (s.sheen > 0) {
    const Vx = Math.sin(al * RAD), Vz = Math.cos(al * RAD);
    let hx = Lx + Vx, hy = Ly, hz = Lz + Vz;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl; hz /= hl;
    const nh = nx * hx + nz * hz;
    if (nh > 0) Fdir += s.sheen * Math.pow(nh, s.gloss);
  }
  const F = Famb + Fdir;
  const lf = backdropLit(th, al, s, Lx, Lz);
  const yb = lf * ybg + (1 - lf) * s.bgReflectance * s.ambient;
  return { c, F, Famb, Fdir, Y: c * F + (1 - c) * yb, backLit: lf };
}

/**
 * How far behind the ribbons' centre lines the backdrop is: the box's back
 * wall, against the deepest comb (or, with pins, the stand-off past a ribbon
 * turned end-on: fab.pinWallDepth). The deepest comb
 * depends on the solved angles, so the pipeline solves once with the deepest
 * a comb can be, then again with `backDepth`, the deepest that came out.
 */
export const backdropDistance = (s) => {
  const D = s.backDepth > 0 ? s.backDepth : combDepth(s);
  return s.hold === 'pins' ? Math.max(pinWallDepth(s), D / 2) : D / 2;
};

/**
 * THE RIBBONS' SHADOWS ON THE BACKDROP. Locally every ribbon of a stretch has
 * about the same angle, so on the backdrop (d behind the ribbons) the pattern
 * repeats every pitch: each ribbon hides an interval from the viewer, V (its
 * cross-section projected along the view, slope tan α), and shades an
 * interval, S (projected along the light, slope Lx/Lz). Seen straight down
 * the light, S hides behind V; from any other side it shows in the gap. The
 * share of the visible gap that is still lit, on a circle one pitch round:
 *
 *     1 − |S ∩ gap| / |gap|,   |S ∩ gap| = |S| − |S ∩ V|
 *
 * Shadowed backdrop keeps only the ambient light. A light no higher than the
 * vertical (Lz ≤ 0) leaves the backdrop unlit already (backdropY).
 */
export function backdropLit(th, al, s, Lx, Lz) {
  if (!(Lz > 1e-6)) return 1;
  const d = backdropDistance(s), p = s.pitch, hw = s.ribbonW / 2;
  const c = Math.cos(th * RAD), sn = Math.sin(th * RAD);
  // the two edges, (−hw·c, hw·s) and (hw·c, −hw·s), dropped onto the backdrop along slope t
  const span = (t) => {
    const u = -hw * c - (hw * sn + d) * t, v = hw * c - (-hw * sn + d) * t;
    return u < v ? [u, v] : [v, u];
  };
  const V = span(Math.tan(al * RAD)), S = span(Lx / Lz);
  const lenV = Math.min(p, V[1] - V[0]), gap = p - lenV;
  if (gap <= 1e-9) return 1;
  const lenS = S[1] - S[0];
  if (lenS >= p) return 0;
  let both = 0;
  const k0 = Math.floor((S[0] - V[1]) / p), k1 = Math.ceil((S[1] - V[0]) / p);
  for (let k = k0; k <= k1; k++) both += Math.max(0, Math.min(S[1], V[1] + k * p) - Math.max(S[0], V[0] + k * p));
  return Math.max(0, Math.min(1, 1 - Math.max(0, lenS - both) / gap));
}

/**
 * The measured curve from its text.
 * @returns {{pts: number[][] | null, problems: string[], mirrored?: boolean, photo?: boolean}}
 *   pts: [angle, Y] sorted, within one period [−90, 90); mirrored: it was
 *   given on one side only; photo: the values were 0–255 readings
 */
export function parseCurve(text) {
  const problems = [];
  const raw = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const t = line.replace(/#.*/, '').trim();
    if (!t) return;
    const parts = t.split(/[\s,;]+/).map(Number);
    if (parts.length < 2 || !parts.slice(0, 2).every(isFinite)) { problems.push(`line ${i + 1} is not "angle value"`); return; }
    raw.push([parts[0], parts[1]]);
  });
  if (raw.length < 2) return { pts: null, problems: problems.concat(['the curve needs at least two points']) };
  const photo = raw.some(([, v]) => v > 1);
  const val = (v) => (photo ? toLinear(Math.min(255, Math.max(0, v)) / 255) : Math.max(0, v));
  // only one side given (everything in 0…90, or −90…0): mirror it
  const mirrored = raw.every(([a]) => a >= 0 && a <= 90) || raw.every(([a]) => a <= 0 && a >= -90);
  const both = mirrored ? raw.concat(raw.map(([a, v]) => [-a, v])) : raw;
  // ±90° are one angle: wrap90 sends both to −90, and duplicates are averaged
  const pts = both.map(([a, v]) => [wrap90(a), val(v)]).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9) { last[2]++; last[1] += (p[1] - last[1]) / last[2]; } else out.push([p[0], p[1], 1]);
  }
  return { pts: out.map(([a, v]) => [a, v]), problems, mirrored, photo };
}

const wrap90 = (a) => ((((a + 90) % 180) + 180) % 180) - 90;

/** The curve at any angle: linear between points, periodic over 180°. */
export function curveAt(pts, a) {
  a = wrap90(a);
  const n = pts.length;
  if (a < pts[0][0]) a += 180;            // in the wrap segment: last point -> first + 180°
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = i + 1 < n ? pts[i + 1] : [pts[0][0] + 180, pts[0][1]];
    if (a >= p[0] && a <= q[0]) return q[0] - p[0] < 1e-9 ? p[1] : p[1] + ((q[1] - p[1]) * (a - p[0])) / (q[0] - p[0]);
  }
  return pts[n - 1][1];
}

/**
 * One ribbon's Y over a half turn, LUT_STEP apart: entry k is θ = k·LUT_STEP.
 * Periodic: θ and θ + 180° are the same entry.
 */
export function ribbonLUT(s, al, curvePts = null) {
  const lut = new Float32Array(LUT_N);
  const ybg = backdropY(s);
  for (let k = 0; k < LUT_N; k++) {
    const th = k * LUT_STEP;
    lut[k] = curvePts ? curveAt(curvePts, th - al) : pitchModel(th, al, s, ybg).Y;
  }
  return lut;
}

/** A LUT at any angle (degrees, unwrapped), linear between entries. */
export function lutAt(lut, th) {
  let u = th / LUT_STEP;
  u -= LUT_N * Math.floor(u / LUT_N);
  const k = Math.floor(u), f = u - k;
  const a = lut[k % LUT_N], b = lut[(k + 1) % LUT_N];
  return a + (b - a) * f;
}

/** Perceived lightness of a grey of relative luminance Y: OKLab's L, which for a grey is ∛Y. */
export const lightness = (Y) => Math.cbrt(Math.max(0, Y));

/** A ribbon's LUT turned into lightness. */
export function lightnessLUT(lut) {
  const out = new Float32Array(lut.length);
  for (let k = 0; k < lut.length; k++) out[k] = lightness(lut[k]);
  return out;
}
