// The preview, slice by slice: where each ribbon appears from the design
// viewpoint and how bright its visible face is. DOM-free; app.js fills the
// shapes on a canvas and the harness checks the numbers.
//
// A SLICE is one sample's horizontal cut through every ribbon: a segment w long
// at angle θ, centred on the ribbon's x in the wall's plane. Its two ends are
// projected onto the wall plane from the eye (perspective, so a ribbon off to
// the side shows its edge sooner), and its face is shaded by the same model the
// solver uses (core/optics.js) with one thing the solver leaves out: SHADOWS
// cast by the neighbours. Rays from a few points along the face go toward the
// light; the share that reaches it scales the direct light. Neighbours are
// tested in the same slice (a light above shifts the true shadow down by a few
// mm, which this ignores). Occlusion by neighbours needs no test: app.js paints
// the ribbons farthest from the viewer first.
//
// With a measured curve the face brightness comes from the curve instead,
// backed out of the pitch's measured Y with the model's coverage; the curve
// was measured with neighbours, so no shadow is applied on top.

import { pitchModel, backdropY, curveAt } from './optics.js';

const RAD = Math.PI / 180;
const RAYS = 5;

/**
 * @param {object} plan  the pipeline's plan
 * @param {'th'|'ideal'} which  the bracketed path or the ideal one
 * @returns {{xl: Float32Array, xr: Float32Array, F: Float32Array}[]}  per
 *   ribbon, per sample: projected left and right edges (mm on the wall plane)
 *   and the visible face's brightness (relative Y)
 */
export function ribbonSlices(plan, which = 'th') {
  const s = plan.s, n = plan.n, ribbons = plan.ribbons, N = ribbons.length;
  const ybg = backdropY(s), Dm = s.distM * 1000, xv = plan.xv, hw = s.ribbonW / 2;
  const curve = plan.curvePts;
  const shadows = !curve && Math.cos(s.lightEl * RAD) > 1e-3;
  const lx = Math.sin(s.lightAz * RAD), lz = Math.cos(s.lightAz * RAD);
  const out = ribbons.map(() => ({ xl: new Float32Array(n), xr: new Float32Array(n), F: new Float32Array(n) }));
  const ax = new Float64Array(N), az = new Float64Array(N), bx = new Float64Array(N), bz = new Float64Array(N);
  const proj = (x, z) => xv + ((x - xv) * Dm) / (Dm - z);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < N; i++) {
      const th = ribbons[i][which][j] * RAD, x = ribbons[i].x;
      const c = Math.cos(th), sn = Math.sin(th);
      // the segment runs along u = (cos θ, −sin θ), perpendicular to the normal (sin θ, cos θ)
      ax[i] = x - hw * c; az[i] = hw * sn;
      bx[i] = x + hw * c; bz[i] = -hw * sn;
    }
    for (let i = 0; i < N; i++) {
      const r = ribbons[i], th = r[which][j];
      const m = pitchModel(th, r.alpha, s, ybg);
      let F;
      if (curve) {
        F = m.c > 0 ? Math.max(0, (curveAt(curve, th - r.alpha) - (1 - m.c) * ybg) / m.c) : 0;
      } else if (shadows && m.Fdir > 0) {
        F = m.Famb + m.Fdir * litShare(i, ax, az, bx, bz, lx, lz, th, r.alpha);
      } else {
        F = m.F;
      }
      const pa = proj(ax[i], az[i]), pb = proj(bx[i], bz[i]);
      let l = Math.min(pa, pb), rr = Math.max(pa, pb);
      // edge-on, the thickness still shows
      const minW = s.thickness * Math.abs(Math.sin((th - r.alpha) * RAD));
      if (rr - l < minW) { const mid = (l + rr) / 2; l = mid - minW / 2; rr = mid + minW / 2; }
      out[i].xl[j] = l; out[i].xr[j] = rr; out[i].F[j] = F;
    }
  }
  return out;
}

/** The share of RAYS points on ribbon i's visible face that see the light past ribbons i±1, i±2. */
function litShare(i, ax, az, bx, bz, lx, lz, thDeg, alDeg) {
  const N = ax.length;
  // the visible side's normal, to start each ray just off the face
  const th = thDeg * RAD, side = Math.cos((thDeg - alDeg) * RAD) >= 0 ? 1 : -1;
  const nx = side * Math.sin(th), nz = side * Math.cos(th);
  let lit = 0;
  for (let k = 0; k < RAYS; k++) {
    const u = (k + 0.5) / RAYS;
    const ox = ax[i] + u * (bx[i] - ax[i]) + 1e-4 * nx, oz = az[i] + u * (bz[i] - az[i]) + 1e-4 * nz;
    let blocked = false;
    for (let d = -2; d <= 2 && !blocked; d++) {
      const m = i + d;
      if (d === 0 || m < 0 || m >= N) continue;
      blocked = rayHits(ox, oz, lx, lz, ax[m], az[m], bx[m], bz[m]);
    }
    if (!blocked) lit++;
  }
  return lit / RAYS;
}

/** Does the ray o + t·d (t > 0) cross the segment a–b? */
export function rayHits(ox, oz, dx, dz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-12) return false;
  const wx = ax - ox, wz = az - oz;
  const t = (wx * ez - wz * ex) / den;
  const u = (wx * dz - wz * dx) / den;
  return t > 0 && u >= 0 && u <= 1;
}

/** Painting order: farthest from the viewer's line first, so nearer ribbons cover them. */
export function paintOrder(plan) {
  return plan.ribbons.map((r, i) => i).sort((a, b) => Math.abs(plan.ribbons[b].x - plan.xv) - Math.abs(plan.ribbons[a].x - plan.xv));
}
