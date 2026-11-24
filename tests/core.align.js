// Mirroring whole ribbons (core/align.js) and what it does to a moving viewer.

import { section, check, num, plain, makeRGBA, mkRand } from './runner.js';
import { misalignment, chooseMirrors } from '../src/core/align.js';
import { ribbonLUT, lightnessLUT, lutAt } from '../src/core/optics.js';
import { runPipeline } from '../src/pipeline.js';

export function run() {
  section('core.align', 'Mirroring a ribbon (every angle negated) keeps every limit. The choice is exact over the row: ' +
    'it must equal brute force.');
  check('misalignment: a path against itself 0; 45° against −45° crossed (1)', misalignment([10, 20], [10, 20]) === 0 && misalignment([45, 45], [-45, -45]) === 1);
  check('misalignment is modulo 180°: 170° against −10° is parallel', misalignment([170], [-10]) < 1e-12);

  // brute force on 6 ribbons with an asymmetric light, so tone matters too
  const s = { ...plain, lightAz: 25, lightEl: 30, ambient: 0.2 };
  const L = lightnessLUT(ribbonLUT(s, 0));
  const rnd = mkRand(3);
  const n = 40, N = 6;
  const paths = Array.from({ length: N }, () => { const a = rnd() * 160 - 80, b = rnd() * 160 - 80; return Float64Array.from({ length: n }, (_, j) => a + ((b - a) * j) / (n - 1)); });
  const targets = paths.map(() => Float32Array.from({ length: n }, () => 0.4 + 0.4 * rnd()));
  const Ls = paths.map(() => L);
  const tone = (th, t, sg) => { let e = 0; for (let j = 0; j < n; j++) e += Math.abs(lutAt(L, sg * th[j]) - t[j]); return (100 * e) / n; };
  for (const w of [1, 0, -1]) {
    const pick = chooseMirrors(paths, Ls, targets, w);
    const cost = (bits) => {
      let c = 0;
      bits.forEach((b, i) => { c += tone(paths[i], targets[i], b ? -1 : 1); });
      for (let i = 1; i < N; i++) c += 2 * w * misalignment(paths[i - 1].map((v) => (bits[i - 1] ? -v : v)), paths[i].map((v) => (bits[i] ? -v : v)));
      return c;
    };
    let best = Infinity;
    for (let m = 0; m < 1 << N; m++) best = Math.min(best, cost(Array.from({ length: N }, (_, i) => !!(m & (1 << i)))));
    check(`alignment ${w > 0 ? '+' : ''}${w}: the choice equals brute force over all ${1 << N} mirrorings`, Math.abs(cost(pick) - best) < 1e-9, `${num(cost(pick), 4)} vs ${num(best, 4)}`);
  }

  // with a lightness that is more than the LUT (as with comb shadows), the choice must use it
  const bias = (i, th, j) => lutAt(L, th) + (Math.sin((th * Math.PI) / 90) > 0 ? 0.05 : 0) * (j % 2);
  for (const w of [1, 0]) {
    const pick = chooseMirrors(paths, Ls, targets, w, null, bias);
    const toneB = (th, t, sg, i) => { let e = 0; for (let j = 0; j < n; j++) e += Math.abs(bias(i, sg * th[j], j) - t[j]); return (100 * e) / n; };
    const cost = (bits) => {
      let c = 0;
      bits.forEach((b, i) => { c += toneB(paths[i], targets[i], b ? -1 : 1, i); });
      for (let i = 1; i < N; i++) c += 2 * w * misalignment(paths[i - 1].map((v) => (bits[i - 1] ? -v : v)), paths[i].map((v) => (bits[i] ? -v : v)));
      return c;
    };
    let best = Infinity;
    for (let m = 0; m < 1 << N; m++) best = Math.min(best, cost(Array.from({ length: N }, (_, i) => !!(m & (1 << i)))));
    check(`with a lightness beyond the LUT (alignment ${w}): still equals brute force`, Math.abs(cost(pick) - best) < 1e-9, `${num(cost(pick), 4)} vs ${num(best, 4)}`);
  }

  section('core.align: a viewer walking past', 'The whole chain on a picture with structure, front light (so mirroring costs no tone), ' +
    'seen 1 m to either side. Aligned neighbours (+1) change together: the fewest stripes, and a steadier blended picture than no ' +
    'preference (0), whose haphazard directions do neither. Opposed ones (−1) change in opposite directions, which cancels where the ' +
    'eye blends them -- the steadiest blended tone -- but is the most stripes up close.');
  const img = makeRGBA(60, 60, (x, y) => { const r = Math.hypot(x - 30, y - 30); const v = Math.round(128 + 110 * Math.cos(r / 4)); return [v, v, v]; });
  const base = { ...plain, widthMm: 600, heightMm: 600, distM: 3, lightAz: 0, lightEl: 30, ambient: 0.3, sheen: 0.1, layout: 'even', rowSpacing: 100 };
  // the toggle: on is +1, off −1 (no `align` given); 0 only through the harness
  const { align: _drop, ...noAlign } = base;
  const pos = runPipeline(img, { ...noAlign, alignTwists: true }), off = runPipeline(img, { ...base, align: 0 }), neg = runPipeline(img, { ...noAlign, alignTwists: false });
  check('the toggle sets the weight: on +1, off −1', pos.s.align === 1 && neg.s.align === -1);
  const o = (p) => p.stats.offAxis;
  check('stripes: aligned (+1) fewest, opposed (−1) most', o(pos).stripes <= o(off).stripes + 1e-9 && o(off).stripes <= o(neg).stripes + 1e-9,
    `+1 ${num(o(pos).stripes, 2)} · 0 ${num(o(off).stripes, 2)} · −1 ${num(o(neg).stripes, 2)}`);
  check('blended tone: opposed (−1) steadiest, and aligned (+1) steadier than no preference (0)', o(neg).tone <= o(pos).tone + 1e-9 && o(pos).tone <= o(off).tone + 1e-9,
    `+1 ${num(o(pos).tone, 2)} · 0 ${num(o(off).tone, 2)} · −1 ${num(o(neg).tone, 2)}`);
  check('…at about the same tone from the design viewpoint (within 0.3)', Math.abs(pos.stats.tone - neg.stats.tone) < 0.3, `${num(pos.stats.tone, 2)} vs ${num(neg.stats.tone, 2)}`);
  const turns = (p) => p.ribbons.slice(1).reduce((a, r, i) => a + misalignment(p.ribbons[i].th, r.th), 0) / (p.ribbons.length - 1);
  check('aligned neighbours are more nearly parallel than opposed ones', turns(pos) < turns(neg), `${num(turns(pos), 3)} vs ${num(turns(neg), 3)}`);
  const flips = pos.ribbons.every((r) => r.knots.every((k, i) => Math.abs(k.a - (i ? r.knots[i].a : k.a)) >= 0));
  check('mirrored ribbons keep their brackets\' heights and the rate limit', flips && pos.stats.rateUse <= 1 + 1e-9 && neg.stats.rateUse <= 1 + 1e-9);
}
