import { section, check, num, plain, flatRGBA, vRamp, makeRGBA } from './runner.js';
import { runPipeline } from '../src/pipeline.js';

const mod180 = (a) => ((a % 180) + 180) % 180;
/** How far from face-on an angle is, 0…90. */
const offFace = (a) => { const m = mod180(a); return Math.min(m, 180 - m); };

export function run() {
  section('pipeline', 'The whole chain on fixtures. A flat grey should be met everywhere; a ramp dark at the top and white at the ' +
    'bottom should turn every ribbon from near edge-on to face-on; no span may break the rate limit, and the layouts must keep ' +
    'their spacing and count limits.');
  const grey = runPipeline(flatRGBA(40, 80, 128), plain);
  check('flat grey: mean tone error under 1 (×100 lightness)', grey.stats.tone < 1, `${num(grey.stats.tone, 3)}`);
  const ramp = runPipeline(vRamp(40, 80), plain);
  const r0 = ramp.ribbons[4];
  check('ramp: near edge-on at the top, face-on at the bottom', offFace(r0.th[2]) > 70 && offFace(r0.th[ramp.n - 3]) < 20,
    `${num(offFace(r0.th[2]), 1)}° → ${num(offFace(r0.th[ramp.n - 3]), 1)}°`);
  check('ramp: no span over the rate limit', ramp.stats.rateUse <= 1 + 1e-9, `${num(ramp.stats.rateUse * 100, 1)}% of the limit`);
  const evenGaps = ramp.rows.slice(1).map((y, k) => y - ramp.rows[k]);
  check('even rows: every gap the same (600 mm / 6)', evenGaps.every((g) => Math.abs(g - 100) < 1e-9), evenGaps.map((g) => num(g, 1)).join(' '));

  // 1.5 m tall; flat grey for the top 900 mm, then bands 150 mm tall (a quarter
  // turn each at the limit) -- detail the ribbons can follow, in the bottom only
  const tall = { ...plain, heightMm: 1500 };
  const detail = makeRGBA(40, 150, (x, y) => { const v = y < 90 ? 128 : (Math.floor((y - 90) / 15) % 2 ? 235 : 15); return [v, v, v]; });
  const sB = { ...tall, layout: 'bunched', maxRows: 5, minSpacing: 30, maxSpan: 1000 };
  const bunched = runPipeline(detail, sB);
  const inner = bunched.rows.slice(1, -1);
  check('bunched: at most 5 rows between the bars', inner.length <= 5, `${inner.length}`);
  const gapsB = bunched.rows.slice(1).map((y, k) => y - bunched.rows[k]);
  check('bunched: every span within 30…1000 mm', gapsB.every((g) => g >= 30 - 1e-9 && g <= 1000 + 1e-9), gapsB.map((g) => num(g, 0)).join(' '));
  check('bunched: most rows in the banded bottom 600 mm', inner.filter((y) => y > 900).length > inner.length / 2, inner.map((y) => num(y, 0)).join(' '));
  const evenN = runPipeline(detail, { ...tall, layout: 'even', rowSpacing: 1500 / (inner.length + 1) });
  check('bunched rows match the image better than as many even rows', bunched.stats.tone < evenN.stats.tone,
    `${num(bunched.stats.tone, 2)} vs ${num(evenN.stats.tone, 2)} (${evenN.rows.length - 2} even rows)`);

  const sP = { ...tall, hold: 'pins', layout: 'perRibbon', maxPerRibbon: 6, minSpacing: 50, maxSpan: 400 };
  const per = runPipeline(detail, sP);
  const okPer = per.ribbons.every((r) => r.knots.length - 2 <= 6 && r.knots.slice(1).every((k, i) => k.y - r.knots[i].y >= 50 - 1e-9 && k.y - r.knots[i].y <= 400 + 1e-9));
  check('per-ribbon: every ribbon within 6 brackets and 50…400 mm spans', okPer && per.rows === null);
  check('per-ribbon: no span over the rate limit', per.stats.rateUse <= 1 + 1e-9, `${num(per.stats.rateUse * 100, 1)}%`);
  const combs = runPipeline(detail, { ...sP, hold: 'combs' });
  check('combs cannot hold per-ribbon heights: they become bunched rows, with a note', combs.layout === 'bunched' && combs.rows && combs.notes.some((t) => t.includes('combs')));

  const a = JSON.stringify(runPipeline(detail, sB), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  const b = JSON.stringify(runPipeline(detail, sB), (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
  check('deterministic: two runs give the same plan', a === b);
  const inches = runPipeline(detail, { ...sB, units: 'in' });
  check('inches only change the words: the ribbons are the same', JSON.stringify(inches.ribbons.map((r) => r.knots)) === JSON.stringify(bunched.ribbons.map((r) => r.knots)));

  const sD0 = { ...tall, layout: 'even', rowSpacing: 150, diffusion: 0 };
  const noDiff = runPipeline(detail, sD0), withDiff = runPipeline(detail, { ...sD0, diffusion: 0.6 });
  check('spreading the error to the next ribbon lowers the error as the eye mixes it', withDiff.stats.seen <= noDiff.stats.seen,
    `seen ${num(withDiff.stats.seen, 2)} with, ${num(noDiff.stats.seen, 2)} without`);
  check('no bracket layout beats the ideal path (as seen)', ramp.stats.seenIdeal <= ramp.stats.seen + 1e-9, `${num(ramp.stats.seenIdeal, 2)} vs ${num(ramp.stats.seen, 2)}`);
}
