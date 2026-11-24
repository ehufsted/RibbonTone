import { section, check, num, plain, flatRGBA, vRamp, makeRGBA } from './runner.js';
import { runPipeline, problemWith } from '../src/pipeline.js';
import { planDepth, combDepth } from '../src/core/fab.js';

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
  check('the box\'s depth used for the backdrop is the deepest comb that came out', Math.abs(ramp.s.backDepth - planDepth(ramp)) < 1e-9 && ramp.s.backDepth <= combDepth(ramp.s) + 1e-9,
    `${num(ramp.s.backDepth, 2)} mm`);
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

  section('pipeline: limits and bad input', 'Shared rows sum every ribbon\'s cost, so the price that stops brackets must scale with them: ' +
    'a wide piece held to one row must get one row. Half-typed settings get a message, not a crash.');
  const wide = runPipeline(detail, { ...sB, widthMm: 1500, maxRows: 1, maxSpan: 1500 });
  check(`${wide.ribbons.length} ribbons, at most 1 row: one row, and no note blaming the span`, wide.rows.length - 2 <= 1 && !wide.notes.some((t) => t.includes('longest span')),
    `${wide.rows.length - 2} rows`);
  const msg = (over) => { try { runPipeline(detail, { ...plain, ...over }); return ''; } catch (e) { return e.message; } };
  check('row spacing 0: a message, not "Invalid array length"', /row spacing/.test(msg({ rowSpacing: 0 })), msg({ rowSpacing: 0 }));
  check('pitch 0: a message', /pitch/.test(msg({ pitch: 0 })), msg({ pitch: 0 }));

  section('pipeline: zero and negative inputs', 'Every number a person can type has a range (problemWith): values that would ' +
    'hang the solver, write NaN into a file, or quietly cut nonsense are refused with a message.');
  const why = (over) => problemWith({ ...plain, ...over });
  const refused = [
    ['comb margin 0', { combMargin: 0 }], ['comb margin −5', { combMargin: -5 }], ['comb ends −1', { combEnd: -1 }],
    ['clip wall 0', { clipWall: 0 }], ['least web 0', { minWeb: 0 }], ['slot clearance −0.5', { slotClear: -0.5 }],
    ['least slot width −1', { minSlot: -1 }], ['stand-off −5', { standoff: -5 }], ['sheet thickness 0', { combThick: 0 }],
    ['sheen tightness 0', { gloss: 0 }], ['sheen tightness −3', { gloss: -3 }], ['sheen −0.1', { sheen: -0.1 }],
    ['bending modulus 0', { E: 0 }], ['shear modulus −1', { G: -1 }], ['areal density −10', { density: -10 }],
    ['reflectance 1.2', { reflectance: 1.2 }], ['backdrop −0.1', { bgReflectance: -0.1 }], ['viewing distance 0.01 m', { distM: 0.01 }],
    ['row spacing 0.01 (even rows)', { layout: 'even', rowSpacing: 0.01 }],
  ];
  const missed = refused.filter(([, o]) => !why(o));
  check(`refused with a message: ${refused.map(([l]) => l).join(', ')}`, missed.length === 0, missed.map(([l]) => l).join(', ') || 'all refused');
  const fine = [['comb ends 0', { combEnd: 0 }], ['stand-off 0', { standoff: 0 }], ['slot clearance 0', { slotClear: 0 }], ['least slot width 0', { minSlot: 0 }],
    ['shear modulus 0', { G: 0 }], ['areal density 0', { density: 0 }], ['cutter bed 0', { bedMm: 0 }], ['cutter bed −1', { bedMm: -1 }]];
  const wrongly = fine.filter(([, o]) => why(o));
  check(`allowed: ${fine.map(([l]) => l).join(', ')}`, wrongly.length === 0, wrongly.map(([l, o]) => `${l}: ${why(o)}`).join('; ') || 'all allowed');
  const err = (over, img = flatRGBA(40, 80, 128)) => { try { runPipeline(img, { ...plain, ...over }); return ''; } catch (e) { return e.message; } };
  check('a piece 10 mm tall is refused (a sliver once made the solver ask for 173 MB)', /at least/.test(err({ heightMm: 10 })), err({ heightMm: 10 }));
  check('even rows 5 mm apart down a 3 m piece: refused as too many rows, not 600 combs', /rows/.test(err({ heightMm: 3000, layout: 'even', rowSpacing: 5 })),
    err({ heightMm: 3000, layout: 'even', rowSpacing: 5 }));

  section('pipeline: dark ribbons on white', 'The same solver with the reflectances swapped: now a dark part of the image wants a ' +
    'ribbon face-on and a light part wants it edge-on, the reverse of white on black.');
  const dk = runPipeline(vRamp(40, 80), { ...plain, darkRibbons: true, reflectance: 0.05, bgReflectance: 0.85 });
  const rd = dk.ribbons[4];
  // (the image's near-black top rows map a little above the darkest lightness, so "face-on" is within 25°)
  check('dark ramp top (black) is near face-on, its bottom (white) near edge-on', offFace(rd.th[2]) < 25 && offFace(rd.th[dk.n - 3]) > 70,
    `${num(offFace(rd.th[2]), 1)}° → ${num(offFace(rd.th[dk.n - 3]), 1)}°`);
  check('dark scheme: still within the rate limit, tone error small', dk.stats.rateUse <= 1 + 1e-9 && dk.stats.tone < 3, `rate ${num(dk.stats.rateUse * 100, 1)}%, tone ${num(dk.stats.tone, 2)}`);
}
