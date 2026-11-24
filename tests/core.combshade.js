// Comb shadows (core/combshade.js) and the solver's use of them.

import { section, check, num, plain, flatRGBA } from './runner.js';
import { shadeSlope, makeShade, shadeCutoffs } from '../src/core/combshade.js';
import { pitchModel, backdropY } from '../src/core/optics.js';
import { runPipeline } from '../src/pipeline.js';
import { blur1 } from '../src/core/solve.js';

const wrap90 = (a) => ((((a + 90) % 180) + 180) % 180) - 90;

export function run() {
  section('core.combshade', 'A comb lit from above shades what lies below it and behind its front edge: under a 45° light straight on ' +
    '(Lz/Ly = 1) the cut-off falls 1 mm per mm down, so a face-on ribbon is shaded for D/2 below the comb\'s underside. Unshaded, the model ' +
    'is the optics model exactly; fully shaded, a face keeps only its ambient light.');
  const s = { ...plain, lightAz: 0, lightEl: 45, ambient: 0.3, combThick: 3, slotClear: 0.6, combMargin: 8 };
  check('45° straight on: slope Lz/Ly = 1; a level light or one from below shades nothing', Math.abs(shadeSlope(s) - 1) < 1e-12 &&
    shadeSlope({ ...s, lightEl: 0 }) === null && shadeSlope({ ...s, lightAz: 95 }) === null);
  const n = 200, dy = 1;
  const zc = shadeCutoffs([{ y: 50, zf: 18.3 }], n, dy, s);
  const at = (y) => zc[Math.round(y / dy - 0.5)];
  check('above the comb: no shadow', at(40) === -Infinity);
  // the sample centred at 57.5 mm is 57.5 − 50 − 1.5 (half the comb's thickness) = 6 mm below its underside
  check('6 mm below the comb\'s underside: the cut-off is 18.3 − 6 = 12.3 mm', Math.abs(at(57.5) - 12.3) < 1e-6, num(at(57.5), 3));
  let band = 0;
  for (let j = 0; j < n; j++) if (zc[j] >= 0) band++;
  check('a face-on ribbon is shaded for about D/2 = 18.3 mm below the comb', Math.abs(band * dy - 18.3) <= 1, `${band} mm`);
  const sh = makeShade(s, 3, 18.3);
  let worst = 0;
  for (let a = -90; a < 90; a += 7) worst = Math.max(worst, Math.abs(sh.Y(a, -Infinity) - pitchModel(a, 3, s).Y));
  check('no shadow: the pitch model exactly', worst < 1e-5, `max diff ${worst.toExponential(1)}`);
  const m = pitchModel(20, 3, s);
  const full = m.c * m.Famb + (1 - m.c) * s.bgReflectance * s.ambient;
  check('deep in shadow: the face and backdrop keep only ambient light', Math.abs(sh.Y(20, 1000) - full) < 1e-5, `${num(sh.Y(20, 1000), 4)} vs ${num(full, 4)}`);
  const m60 = pitchModel(60, 3, s);
  const halfY = m60.c * (m60.Famb + m60.Fdir * 0.5) + (1 - m60.c) * s.bgReflectance * s.ambient;
  check('cut-off through the ribbon\'s middle: half its face loses the direct light', Math.abs(sh.Y(60, 0) - halfY) < 1e-5, `${num(sh.Y(60, 0), 4)} vs ${num(halfY, 4)}`);
  void backdropY;

  section('core.combshade: in the solver', 'With the toggle on, the solver knows the bands are darker and turns ribbons more face-on there ' +
    'to make up for it. Judged by the shadowed truth, its plan should do better on what it minimises (squared error) and as the eye blends ' +
    'it; sample by sample in absolute terms it may not, since the twist limit makes it spread a band\'s shortfall over the span ' +
    '(first predicted as "better on every measure"). Without the toggle the plan\'s own figure is far too optimistic.');
  const base = { ...plain, widthMm: 300, heightMm: 600, lightAz: 0, lightEl: 45, ambient: 0.3, layout: 'even', rowSpacing: 100, combThick: 3, combMargin: 8, distM: 4 };
  const grey = flatRGBA(40, 80, 150);
  const on = runPipeline(grey, { ...base, combShadows: true }), off = runPipeline(grey, { ...base, combShadows: false });
  check('on: the plan carries the shading; off: it does not', !!on.combShade && off.combShade === null);
  check('off: a note says how much of the height the combs would shade', off.notes.some((t) => /would shade \d+%/.test(t)), off.notes.find((t) => /shade/.test(t)));
  const cut = on.combShade.zc;
  // judge both plans by the shadowed truth
  const shadedL = (p) => p.ribbons.map((r) => { const model = makeShade(p.s, r.alpha, on.combShade.W); return Float64Array.from(r.th, (t, j) => model.L(t, cut[j])); });
  const sqErr = (p) => { let e = 0, c = 0; shadedL(p).forEach((L, i) => L.forEach((v, j) => { e += (v - p.ribbons[i].Lt[j]) ** 2; c++; })); return (1e4 * e) / c; };
  const seenErr = (p) => {
    const sig = p.s.pitch / p.dy;
    let e = 0, c = 0;
    shadedL(p).forEach((L, i) => { const a = blur1(L, sig), b = blur1(p.ribbons[i].Lt, sig); a.forEach((v, j) => { e += Math.abs(v - b[j]); c++; }); });
    return (100 * e) / c;
  };
  check('judged with the shadows: lower squared error (what the solver minimises)', sqErr(on) < sqErr(off), `${num(sqErr(on), 2)} vs ${num(sqErr(off), 2)}`);
  check('judged with the shadows: lower error as the eye blends a pitch down the ribbon', seenErr(on) < seenErr(off), `${num(seenErr(on), 2)} vs ${num(seenErr(off), 2)}`);
  check('without the toggle, the plan\'s own tone figure misses the shadows', off.stats.tone < 0.5 * seenErr(off), `reports ${num(off.stats.tone, 2)}, blended truth ${num(seenErr(off), 2)}`);
  const faceOn = (p) => {
    let a = 0, c = 0;
    p.ribbons.forEach((r) => { for (let j = 0; j < p.n; j++) if (cut[j] >= 0) { a += Math.abs(wrap90(r.th[j] - r.alpha)); c++; } });
    return a / (c || 1);
  };
  check('in the bands, ribbons turn more face-on to make up for the lost light', faceOn(on) < faceOn(off), `${num(faceOn(on), 1)}° vs ${num(faceOn(off), 1)}° from face-on`);
  const glass = runPipeline(grey, { ...base, combShadows: true, combLook: 'clear' });
  check('clear combs: nothing modelled, with a note', glass.combShade === null && glass.notes.some((t) => /clear combs cast almost no shadow/.test(t)));
  const level = runPipeline(grey, { ...base, combShadows: true, lightEl: 0 });
  check('a level light: nothing to model', level.combShade === null);
  const curved = runPipeline(grey, { ...base, combShadows: true, curveOn: true, curve: '0 200\n90 20' });
  check('a measured curve: not modelled, with a note', curved.combShade === null && curved.notes.some((t) => /not modelled with a measured curve/.test(t)));
}
