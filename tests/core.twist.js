import { section, check, num, plain } from './runner.js';
import { maxTwistDeg, quarterTurnLength, twistModel } from '../src/core/twist.js';

export function run() {
  section('core.twist', 'The rate limit from edge strain: 0.55 % at 20 mm should give a quarter turn in about 150 mm, ' +
    'and twice the width twice the length. Between brackets the twist follows 1/k(y): a weightless ribbon turns evenly, ' +
    'a heavy one under little tension turns more near the bottom of each span.');
  const s = { ...plain, ribbonW: 20, strainPct: 0.55 };
  check('20 mm at 0.55 %: a quarter turn takes 150 ± 1 mm', Math.abs(quarterTurnLength(s) - 150) < 1, `${num(quarterTurnLength(s), 2)} mm (${num(maxTwistDeg(s), 4)}°/mm)`);
  const s40 = { ...s, ribbonW: 40 };
  check('40 mm needs twice the length', Math.abs(quarterTurnLength(s40) / quarterTurnLength(s) - 2) < 1e-9, `${num(quarterTurnLength(s40), 1)} mm`);

  const light = twistModel({ ...s, density: 0 }, 1000);
  check('weightless: the twist is even (half done halfway)', Math.abs(light.profile(200, 400, 300) - 0.5) < 1e-9, `f = ${num(light.profile(200, 400, 300), 9)}`);
  const avg = 30 / 200;
  check('weightless: the peak rate is the average', Math.abs(light.peakRate(200, 400, 30) - avg) < 1e-9, `${num(light.peakRate(200, 400, 30), 6)} vs ${num(avg, 6)} °/mm`);

  const heavy = twistModel({ ...s, density: 400, tensionN: 0.05 }, 3000);
  const f = heavy.profile(2000, 3000, 2500);
  check('heavy, slack: less than half the twist is done halfway down a span', f < 0.5, `f = ${num(f, 4)}`);
  check('heavy, slack: the peak rate exceeds the average', heavy.peakRate(2000, 3000, 30) > (30 / 1000) * 1.01, `${num(heavy.peakRate(2000, 3000, 30), 5)} vs ${num(0.03, 5)} °/mm`);
  check('tension grows upward by the ribbon\'s weight', heavy.T(0) > heavy.T(3000) && Math.abs(heavy.T(3000) - 0.05) < 1e-12, `T(top) ${num(heavy.T(0), 3)} N, T(bottom) ${num(heavy.T(3000), 3)} N`);

  const taut = twistModel(s, 1000), slack = twistModel({ ...s, tensionN: 1e-7, density: 0 }, 1000);
  const rTaut = taut.coilRatio(800, 1000, 90), rSlack = slack.coilRatio(800, 1000, 90);
  check('coiling: safe at 2 N, at risk with almost no tension', rTaut < 1 && rSlack > 1, `ratio ${num(rTaut, 4)} at 2 N, ${num(rSlack, 2)} at 1e-7 N`);
}
