import { section, check, num, hRamp } from './runner.js';
import { summedArea, boxMean, sampleColumns, reachRange, toneMap } from '../src/core/target.js';
import { pieceGeometry, toneLuminance, DEFAULTS } from '../src/core/units.js';

export function run() {
  section('core.target', 'Box means from a summed-area table are exact on constant pixels, even for boxes cutting pixels; ' +
    'columns of a left-to-right ramp brighten left to right; the image maps onto the range every ribbon can reach.');
  const img = { width: 2, height: 1, data: new Float32Array([0, 1]) };
  const S = summedArea(img);
  check('half of a black pixel and half of a white: 0.5', Math.abs(boxMean(S, 0.5, 0, 1.5, 1) - 0.5) < 1e-12, num(boxMean(S, 0.5, 0, 1.5, 1), 6));
  check('a quarter-pixel box inside the white pixel: 1', Math.abs(boxMean(S, 1.2, 0.3, 1.45, 0.55) - 1) < 1e-12);
  const rgba = hRamp(200, 100);
  const lum = toneLuminance(rgba);
  const s = { ...DEFAULTS, widthMm: 300, heightMm: 0, ribbonW: 20, pitch: 30 };
  const geo = pieceGeometry(lum, s);
  check('ribbons: floor((300 − 20)/30) + 1 = 10, centred', geo.xs.length === 10 && Math.abs(geo.xs[0] + geo.xs[9] - 300) < 1e-9, `${geo.xs.length} at ${geo.xs[0]}…${geo.xs[9]}`);
  const cols = sampleColumns(lum, geo, s.pitch, 20);
  const means = cols.map((c) => c.reduce((a, v) => a + v, 0) / c.length);
  check('columns brighten left to right', means.every((v, i) => i === 0 || v > means[i - 1]), means.map((v) => num(v, 2)).join(' '));
  const f32 = (v) => Math.fround(v);
  const r = reachRange([Float32Array.from([0.1, 0.5]), Float32Array.from([0.05, 0.6])]);
  check('reach: darkest all reach is the larger minimum, brightest the smaller maximum', r.Ymin === f32(0.1) && r.Ymax === f32(0.5) && r.YmaxAny === f32(0.6));
  check('black maps to Lmin, white to Lmax', Math.abs(toneMap(0, r) - r.Lmin) < 1e-12 && Math.abs(toneMap(1, r) - r.Lmax) < 1e-12);
  check('contrast 2 clips a dark grey to Lmin', Math.abs(toneMap(0.005, r, 2) - r.Lmin) < 1e-12);
}
