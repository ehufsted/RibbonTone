// The shadows solid combs cast, for the solver (optional: `combShadows`).
//
// A comb lies level, its depth D centred on the ribbons' line, so its front
// edge is at z = D/2. Lit from above and in front, it shades what lies below
// it and behind its front edge: a point at depth z, Δy below the comb's
// underside, reaches the comb's plane at z + Δy·Lz/Ly on its way to the light,
// so it is in shadow while
//
//     z ≤ zc,   zc = D/2 − Δy·k,   k = Lz/Ly
//
// The cut-off zc falls by k per mm down the span, so the band under a comb is
// about (D/2 + the ribbon's reach)/k deep on the ribbon and (D/2 + the back
// wall's depth)/k on the backdrop. Only the comb just above a point matters.
//
// A ribbon's cross-section runs over z ∈ [−(w/2)|sin θ|, +(w/2)|sin θ|],
// evenly in what the viewer sees, so the shaded share of its visible face is
// the share of that range below zc; shaded face keeps only the ambient light.
// The backdrop behind is shaded where zc reaches the back wall. Everything else
// is core/optics.js's pitch model, split into its parts per angle so the
// shading can be applied to the direct light alone:
//
//     Y = c·(Famb + Fdir·(1 − shaded)) + (1 − c)·Ybg'
//
// Not with a measured curve: it cannot be split into those parts.

import { pitchModel, backdropY, LUT_N, LUT_STEP } from './optics.js';

const RAD = Math.PI / 180;

/** How far toward the viewer a ray to the light moves per mm it rises (Lz/Ly); null when combs shade nothing below them. */
export function shadeSlope(s) {
  const Ly = Math.sin(s.lightEl * RAD), Lz = Math.cos(s.lightEl * RAD) * Math.cos(s.lightAz * RAD);
  return Ly > 1e-6 && Lz > 1e-6 ? Lz / Ly : null;
}

/**
 * One ribbon's brightness with comb shading, from its view angle `al` and the
 * back wall's depth W.
 * @returns {{L: (th, zc) => number, Y: (th, zc) => number, reach: number, W: number}}
 *   zc: the shadow's cut-off at that sample (−Infinity: no comb shadow)
 */
export function makeShade(s, al, W) {
  const C = new Float32Array(LUT_N), FA = new Float32Array(LUT_N), FD = new Float32Array(LUT_N), BL = new Float32Array(LUT_N);
  const ybg = backdropY(s);
  for (let k = 0; k < LUT_N; k++) {
    const m = pitchModel(k * LUT_STEP, al, s, ybg);
    C[k] = m.c; FA[k] = m.Famb; FD[k] = m.Fdir; BL[k] = m.backLit;
  }
  const hw = s.ribbonW / 2, bgAmb = s.bgReflectance * s.ambient;
  const Y = (th, zc) => {
    let u = th / LUT_STEP;
    u -= LUT_N * Math.floor(u / LUT_N);
    if (u >= LUT_N) u -= LUT_N;
    const k = u | 0, f = u - k, k1 = k + 1 === LUT_N ? 0 : k + 1;
    const c = C[k] + (C[k1] - C[k]) * f, fa = FA[k] + (FA[k1] - FA[k]) * f, fd = FD[k] + (FD[k1] - FD[k]) * f, bl = BL[k] + (BL[k1] - BL[k]) * f;
    const half = hw * Math.abs(Math.sin(th * RAD));
    const shaded = half < 1e-6 ? (zc >= 0 ? 1 : 0) : Math.min(1, Math.max(0, (zc + half) / (2 * half)));
    const bg = zc >= -W ? bgAmb : bl * ybg + (1 - bl) * bgAmb;
    return c * (fa + fd * (1 - shaded)) + (1 - c) * bg;
  };
  return { Y, L: (th, zc) => Math.cbrt(Math.max(0, Y(th, zc))), reach: hw, W };
}

/** Does a cut-off zc shade anything (the ribbon or the backdrop)? */
export const shades = (zc, sh) => zc >= -Math.max(sh.reach, sh.W);

/**
 * The cut-off at every sample, from the comb rows above it.
 * @param {{y: number, zf: number}[]} combs  each comb's plan height and front edge (D/2)
 * @returns {Float32Array}  zc per sample; −Infinity where no comb shades
 */
export function shadeCutoffs(combs, n, dy, s) {
  const out = new Float32Array(n).fill(-Infinity);
  const k = shadeSlope(s);
  if (!k || !combs.length) return out;
  const sorted = [...combs].sort((a, b) => a.y - b.y);
  const t = s.combThick;
  let r = -1;
  for (let j = 0; j < n; j++) {
    const y = (j + 0.5) * dy;
    while (r + 1 < sorted.length && sorted[r + 1].y < y) r++;
    if (r < 0) continue;
    const dyBelow = y - sorted[r].y - t / 2;
    if (dyBelow < 0) continue;      // within the comb's own thickness
    out[j] = sorted[r].zf - dyBelow * k;
  }
  return out;
}
