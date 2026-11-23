// Seeing the mosaic from a distance.
//
// THE EYE DOES THE BLURRING. The Distance view draws the piece at the size it
// would look from D meters, for a person SCREEN_M from a screen of CSS_MM per
// CSS pixel (96 dpi), so it subtends the same angle. At that size a CSS pixel
// subtends about 1.5 arcminutes, close to what the eye resolves, so averaging
// the mosaic into those pixels is the blur that distance gives. The size is an
// assumption about the screen and the chair, and the view says so.
//
// AVERAGING IS IN LINEAR LIGHT, because that is how tile and grout mix at a
// distance (core/color.js): a canvas scaled by the browser averages ENCODED
// values, which darkens every joint. `shrinkLinear` box-averages exactly.

import { LINEAR_LUT, toEncoded, rgbToOKLab, deltaE } from './color.js';

export const SCREEN_M = 0.6;          // the viewer's distance from the screen, m
export const CSS_MM = 25.4 / 96;      // one CSS pixel at 96 dpi, mm

/** The CSS-pixel width that `widthMm` subtends from `distanceM`, seen from SCREEN_M. */
export const apparentPx = (widthMm, distanceM) => (widthMm * (SCREEN_M / distanceM)) / CSS_MM;

/**
 * Box-average RGBA pixels down to w2 × h2, in linear light (each source pixel
 * weighted by its overlap with the destination pixel, so non-integer factors
 * are exact too).
 * @returns {Uint8ClampedArray} encoded RGBA
 */
export function shrinkLinear(data, w, h, w2, h2) {
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  const sx = w / w2, sy = h / h2;
  const acc = new Float64Array(3);
  for (let y = 0; y < h2; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < w2; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      acc.fill(0);
      let wsum = 0;
      for (let iy = Math.floor(y0); iy < Math.min(h, Math.ceil(y1)); iy++) {
        const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
        if (wy <= 0) continue;
        for (let ix = Math.floor(x0); ix < Math.min(w, Math.ceil(x1)); ix++) {
          const wx = Math.min(ix + 1, x1) - Math.max(ix, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy, q = 4 * (iy * w + ix);
          acc[0] += wgt * LINEAR_LUT[data[q]]; acc[1] += wgt * LINEAR_LUT[data[q + 1]]; acc[2] += wgt * LINEAR_LUT[data[q + 2]];
          wsum += wgt;
        }
      }
      const p = 4 * (y * w2 + x);
      for (let c = 0; c < 3; c++) out[p + c] = Math.round(255 * toEncoded(wsum ? acc[c] / wsum : 0));
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * The distance (m) from which one pitch (tile + grout, mm) shrinks to one CSS
 * pixel in this view: beyond it the tiles merge into color, nearer they are
 * still seen as tiles (and the pixel-by-pixel ΔE counts that texture).
 */
export const mergeDistance = (pitchMm) => (pitchMm * SCREEN_M) / CSS_MM;

/** Mean ΔE (OKLab × 100) between two encoded RGBA images of the same size. */
export function meanDeltaE(a, b) {
  let sum = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    sum += deltaE(rgbToOKLab(LINEAR_LUT[a[i]], LINEAR_LUT[a[i + 1]], LINEAR_LUT[a[i + 2]]), rgbToOKLab(LINEAR_LUT[b[i]], LINEAR_LUT[b[i + 1]], LINEAR_LUT[b[i + 2]]));
  }
  return sum / n;
}
