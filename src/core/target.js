// What each ribbon should look like: the image's lightness down its column,
// squeezed into the range the ribbons can actually reach.
//
// SAMPLING. A ribbon stands for one pitch of the image: its column is the box
// [x − p/2, x + p/2] × [y, y + dy], averaged in LINEAR light (that is how the
// eye mixes ribbon and gap from a distance). Box means come from a summed-area
// table read bilinearly, which is exact for an image of constant pixels, so
// boxes that cut pixels in two are averaged correctly.
//
// THE RANGE. No ribbon is darker than edge-on, nor brighter than its best face,
// and those limits differ a little from ribbon to ribbon (each sees the viewer
// and the light from its own angle). The image is mapped, in lightness, onto the
// range every ribbon can reach: [the darkest any can all get to, the brightest
// all can]. Contrast stretches about mid-grey first, so it clips rather than
// shifts.

import { lightness } from './optics.js';

/** Summed-area table of a Float32 image, (w + 1) × (h + 1). */
export function summedArea(img) {
  const { width: w, height: h, data } = img;
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  return { sat, w, h };
}

function satAt({ sat, w, h }, x, y) {
  x = Math.max(0, Math.min(w, x)); y = Math.max(0, Math.min(h, y));
  const x0 = Math.min(w - 1, Math.floor(x)), y0 = Math.min(h - 1, Math.floor(y));
  const fx = x - x0, fy = y - y0, W = w + 1;
  const a = sat[y0 * W + x0], b = sat[y0 * W + x0 + 1], c = sat[(y0 + 1) * W + x0], d = sat[(y0 + 1) * W + x0 + 1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Mean over the pixel-space box [x0, x1] × [y0, y1] (clipped to the image). */
export function boxMean(S, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(S.w, x1); y1 = Math.min(S.h, y1);
  const area = (x1 - x0) * (y1 - y0);
  if (!(area > 0)) {
    // thinner than nothing: the pixel under the box's centre
    const cx = Math.min(S.w - 1e-6, Math.max(0, (x0 + x1) / 2)), cy = Math.min(S.h - 1e-6, Math.max(0, (y0 + y1) / 2));
    return boxMean(S, Math.floor(cx), Math.floor(cy), Math.floor(cx) + 1, Math.floor(cy) + 1);
  }
  return (satAt(S, x1, y1) - satAt(S, x0, y1) - satAt(S, x1, y0) + satAt(S, x0, y0)) / area;
}

/**
 * Each ribbon's column of the image: linear luminance at n samples dy apart.
 * @param {{width,height,data:Float32Array}} lum   toned luminance (core/units.js)
 * @param {{W,H,imageRect,xs}} geo
 * @returns {Float32Array[]}
 */
export function sampleColumns(lum, geo, pitch, n) {
  const S = summedArea(lum);
  const R = geo.imageRect;
  const kx = lum.width / R.w, ky = lum.height / R.h;
  const dy = geo.H / n;
  return geo.xs.map((x) => {
    const out = new Float32Array(n);
    const x0 = (x - pitch / 2 - R.x) * kx, x1 = (x + pitch / 2 - R.x) * kx;
    for (let j = 0; j < n; j++) out[j] = boxMean(S, x0, (j * dy - R.y) * ky, x1, ((j + 1) * dy - R.y) * ky);
    return out;
  });
}

/**
 * The lightness range every ribbon can reach, from their Y LUTs.
 * @returns {{Lmin, Lmax, Ymin, Ymax, YmaxAny}}  YmaxAny: the brightest any
 *   ribbon gets, the preview's exposure
 */
export function reachRange(luts) {
  let Ymin = 0, Ymax = Infinity, YmaxAny = 0;
  for (const lut of luts) {
    let lo = Infinity, hi = 0;
    for (const v of lut) { if (v < lo) lo = v; if (v > hi) hi = v; }
    Ymin = Math.max(Ymin, lo);
    Ymax = Math.min(Ymax, hi);
    YmaxAny = Math.max(YmaxAny, hi);
  }
  if (!(Ymax > Ymin)) Ymax = Ymin;
  return { Ymin, Ymax, YmaxAny, Lmin: lightness(Ymin), Lmax: lightness(Ymax) };
}

/** Image luminance -> the lightness a ribbon should show, in the reachable range. */
export function toneMap(Yimg, range, contrast = 1) {
  const L = Math.min(1, Math.max(0, 0.5 + contrast * (lightness(Yimg) - 0.5)));
  return range.Lmin + (range.Lmax - range.Lmin) * L;
}
