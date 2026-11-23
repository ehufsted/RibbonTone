import { section, check } from './runner.js';
import { projectJSON, parseProject } from '../src/core/project.js';
import { DEFAULTS } from '../src/core/units.js';

export function run() {
  section('core.project', 'A project round-trips its image and settings; unknown or mistyped settings are dropped with a note, not fatal; ' +
    'a file that is not a RibbonTone project is refused.');
  const settings = { ...DEFAULTS, widthMm: 1234, hold: 'pins', layout: 'perRibbon', curveOn: true, curve: '0 1\n90 0' };
  const text = projectJSON({ image: { kind: 'sample', name: 'rings' }, settings });
  const { project, problems } = parseProject(text);
  check('round trip: settings and image come back', JSON.stringify(project.settings) === JSON.stringify(settings) && project.image.name === 'rings' && !problems.length);
  const odd = JSON.parse(text);
  odd.settings.widthMm = 'wide';
  odd.settings.colour = 'red';
  const r2 = parseProject(JSON.stringify(odd));
  check('a mistyped and an unknown setting: defaults stand, two notes', r2.project.settings.widthMm === DEFAULTS.widthMm && r2.problems.length === 2, r2.problems.join('; '));
  let refused = false;
  try { parseProject('{"app":"Photo2Mosaic"}'); } catch { refused = true; }
  check('another app\'s file is refused', refused);
}
