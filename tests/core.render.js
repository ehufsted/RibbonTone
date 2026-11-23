import { section, check, num, plain } from './runner.js';
import { ribbonSlices, paintOrder, rayHits } from '../src/core/render.js';

/** A minimal plan: ribbons at xs, every sample at the angles given. */
function fakePlan(s, xs, angles, xv, n = 4) {
  return {
    s, n, xv, curvePts: null,
    ribbons: xs.map((x, i) => ({ x, alpha: (Math.atan2(xv - x, s.distM * 1000) * 180) / Math.PI, th: new Float32Array(n).fill(angles[i]) })),
  };
}

export function run() {
  section('core.render', 'Projected widths from the eye: face-on a ribbon shows w, edge-on only its thickness; ' +
    'turned to face an off-axis viewer, its shadow on the wall plane is w / cos α. Shadows: under a grazing light from the right, ' +
    'every ribbon but the rightmost is partly shaded by its neighbour.');
  const s = { ...plain, distM: 1000 };
  const far = ribbonSlices(fakePlan(s, [100, 200], [0, 90], 150), 'th');
  check('face-on: width w = 20', Math.abs(far[0].xr[0] - far[0].xl[0] - 20) < 1e-3, num(far[0].xr[0] - far[0].xl[0], 4));
  check('edge-on: width = thickness', Math.abs(far[1].xr[0] - far[1].xl[0] - 0.25) < 1e-3, num(far[1].xr[0] - far[1].xl[0], 4));
  const near = { ...plain, distM: 1 };
  const al = (Math.atan2(1000, 1000) * 180) / Math.PI;
  const off = ribbonSlices(fakePlan(near, [0], [al], 1000), 'th');
  const wOff = off[0].xr[0] - off[0].xl[0];
  check('facing a viewer at 45°: width on the wall ≈ w / cos 45° = 28.28', Math.abs(wOff - 20 / Math.cos(Math.PI / 4)) < 0.3, num(wOff, 3));

  const lightS = { ...plain, lightAz: 85, lightEl: 0, ambient: 0, sheen: 0 };
  const xs = [0, 30, 60, 90];
  const sl = ribbonSlices(fakePlan(lightS, xs, [60, 60, 60, 60], 45), 'th');
  const shaded = sl.slice(0, 3).every((r) => r.F[0] < sl[3].F[0] - 1e-6);
  check('grazing light from the right: the three left ribbons are darker than the rightmost', shaded, sl.map((r) => num(r.F[0], 3)).join(' '));
  check('ray–segment test: a ray along +x hits a vertical segment ahead, not one behind', rayHits(0, 0, 1, 0, 5, -1, 5, 1) && !rayHits(0, 0, 1, 0, -5, -1, -5, 1));
  const order = paintOrder(fakePlan(s, [0, 30, 60, 90, 120], [0, 0, 0, 0, 0], 60));
  check('painting order ends with the ribbon nearest the viewer\'s line', order[order.length - 1] === 2, order.join(','));
}
