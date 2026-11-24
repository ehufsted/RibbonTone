import { section, check, num, plain } from './runner.js';
import { pitchModel, backdropY, viewAngle, parseCurve, curveAt, ribbonLUT, lutAt, backdropLit, backdropDistance } from '../src/core/optics.js';

export function run() {
  section('core.optics', 'One pitch\'s brightness: coverage times face plus backdrop. Front light, no sheen, ' +
    'a distant viewer: face-on gives c = w/p = 2/3 of ρ = 0.85 plus 1/3 of the backdrop (0.04), Y = 0.58; ' +
    'edge-on the face is unlit and covers only t/p.');
  const s = plain;
  const y0 = pitchModel(0, 0, s).Y;
  check('face-on Y = (2/3)·0.85 + (1/3)·0.04 = 0.580', Math.abs(y0 - 0.58) < 1e-9, `Y = ${num(y0, 6)}`);
  const m90 = pitchModel(90, 0, s);
  check('edge-on coverage is t/p = 0.25/30', Math.abs(m90.c - 0.25 / 30) < 1e-9, `c = ${num(m90.c, 6)}`);
  check('edge-on Y is the backdrop through the rest', Math.abs(m90.Y - (1 - 0.25 / 30) * backdropY(s)) < 1e-9, `Y = ${num(m90.Y, 6)}`);
  let sym = 0, mono = true, per = 0;
  let prev = Infinity;
  for (let a = 0; a <= 90; a += 1) {
    const inRange = a <= 85;
    const ya = pitchModel(a, 0, s).Y;
    sym = Math.max(sym, Math.abs(ya - pitchModel(-a, 0, s).Y));
    per = Math.max(per, Math.abs(ya - pitchModel(a + 180, 0, s).Y));
    if (inRange && ya > prev + 1e-12) mono = false;
    prev = ya;
  }
  check('front light: +θ and −θ look the same', sym < 1e-12, `max diff ${sym.toExponential(1)}`);
  check('front light: darker every degree from face-on to 85° (past that the unlit face is darker than the backdrop, so covering less brightens)', mono);
  check('both faces white: θ and θ + 180° look the same', per < 1e-12, `max diff ${per.toExponential(1)}`);

  const side = { ...s, lightAz: 40, ambient: 0.2 };
  const yp = pitchModel(30, 0, side).Y, ym = pitchModel(-30, 0, side).Y;
  check('light from the right: turning the face right (+30°) is brighter than left (−30°)', yp > ym, `${num(yp)} vs ${num(ym)}`);
  const sheen = { ...s, sheen: 0.3, gloss: 20, lightEl: 0 };
  check('a sheen brightens the face-on ribbon under a front light', pitchModel(0, 0, sheen).Y > y0, `${num(pitchModel(0, 0, sheen).Y)} vs ${num(y0)}`);

  check('view angle: a ribbon 1 m left of a viewer 1 m away sees it at +45°', Math.abs(viewAngle(0, 1000, 1) - 45) < 1e-9, `${num(viewAngle(0, 1000, 1), 6)}°`);
  const lut = ribbonLUT(side, 3);
  let lerr = 0;
  for (const a of [0.25, 17.3, 44.9, 91.7, 179.6, -33.3]) lerr = Math.max(lerr, Math.abs(lutAt(lut, a) - pitchModel(a, 3, side).Y));
  check('the half-turn LUT matches the model between its entries (0.5° apart) to 1e-3', lerr < 1e-3, `max err ${num(lerr, 5)}`);

  section('core.optics: measured curve', 'Given on 0…90° only, the curve is mirrored; it repeats every 180°; values over 1 are 0–255 photo readings.');
  const c = parseCurve('0 1\n90 0');
  check('one-sided curve is mirrored (0° and ±90°: two points per half turn)', c.mirrored && c.pts.length === 2, JSON.stringify(c.pts));
  check('halfway between points: 0.5 at ±45°', Math.abs(curveAt(c.pts, 45) - 0.5) < 1e-9 && Math.abs(curveAt(c.pts, -45) - 0.5) < 1e-9);
  check('periodic: 135° reads as −45°', Math.abs(curveAt(c.pts, 135) - curveAt(c.pts, -45)) < 1e-12);
  const ph = parseCurve('0 255\n45 128\n90 0');
  check('photo readings are linearized: 255 → 1, 128 → about 0.216', ph.photo && Math.abs(curveAt(ph.pts, 0) - 1) < 1e-9 && Math.abs(curveAt(ph.pts, 45) - 0.2158) < 1e-3, `${num(curveAt(ph.pts, 45), 4)}`);
  const bad = parseCurve('zero one');
  check('a curve with no points is refused with a reason', bad.pts === null && bad.problems.length > 0, bad.problems.join('; '));

  section('core.optics: shadows on the backdrop', 'Each ribbon\'s shadow on the backdrop (the box\'s back wall, half a comb depth ' +
    'behind) is its cross-section dropped along the light. Lit from where the viewer stands, every shadow hides behind its own ribbon; ' +
    'from the side, shadows show in the gaps. A ribbon lying along the light casts only a sliver; one edge-on to the viewer can be broadside to a side light.');
  const L = (az, el = 0) => [Math.cos(el * Math.PI / 180) * Math.sin(az * Math.PI / 180), Math.cos(el * Math.PI / 180) * Math.cos(az * Math.PI / 180)];
  const ws = { ...plain, slotClear: 0.6, combMargin: 8 };
  check('combs: the backdrop is half a comb depth behind (18.3 mm)', Math.abs(backdropDistance(ws) - 18.3) < 1e-9 && backdropDistance({ ...ws, hold: 'pins', standoff: 45 }) === 45);
  check('light from the viewer\'s direction: no shadow shows', backdropLit(0, 0, ws, ...L(0)) === 1 && Math.abs(backdropLit(30, 20, ws, ...L(20)) - 1) < 1e-12);
  // by hand, face-on: ribbons cover [−10, 10] of every 30 mm, the gap is [10, 20]; the shadows are the
  // same 20 mm shifted left by 18.3·tan(az) -- at 15° that is 4.90 mm, so they cover [15.10, 20] of the gap
  const sideLit = backdropLit(0, 0, ws, ...L(15));
  check('light 15° to the side, face-on: 18.3·tan 15° = 4.90 mm of the 10 mm gap is shaded', Math.abs((1 - sideLit) * 10 - 18.3 * Math.tan(15 * Math.PI / 180)) < 1e-9,
    `${num((1 - sideLit) * 10, 3)} mm`);
  check('at 40° the shifted shadows (20 mm each) cover the whole 10 mm gap', backdropLit(0, 0, ws, ...L(40)) === 0);
  check('edge-on to the viewer is broadside to a side light: a wide shadow', backdropLit(90, 0, ws, ...L(40)) < 0.6, `lit ${num(backdropLit(90, 0, ws, ...L(40)), 3)}`);
  check('a ribbon lying along a 40° light casts only a sliver', backdropLit(-50, 0, ws, ...L(40)) > 0.97, `lit ${num(backdropLit(-50, 0, ws, ...L(40)), 3)}`);
  const white = { ...ws, reflectance: 0.05, bgReflectance: 0.85, lightAz: 40, ambient: 0.2 };
  check('a white backdrop: the shadow darkens the pitch', pitchModel(0, 0, white).Y < pitchModel(0, 0, { ...white, combMargin: -10.3 }).Y,
    `${num(pitchModel(0, 0, white).Y, 3)} with the backdrop 18.3 mm back, ${num(pitchModel(0, 0, { ...white, combMargin: -10.3 }).Y, 3)} right behind`);
  const dark = { ...plain, reflectance: 0.05, bgReflectance: 0.85 };
  check('dark ribbons on white: face-on is the darkest, edge-on the lightest', pitchModel(0, 0, dark).Y < pitchModel(45, 0, dark).Y && pitchModel(45, 0, dark).Y < pitchModel(88, 0, dark).Y,
    `${num(pitchModel(0, 0, dark).Y, 3)} < ${num(pitchModel(45, 0, dark).Y, 3)} < ${num(pitchModel(88, 0, dark).Y, 3)}`);
}
