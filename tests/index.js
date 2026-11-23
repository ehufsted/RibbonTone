// The ordered section list. Order is part of the contract: the transcript is
// diffed between runs, so a reordering reads as a change.

import { reset, say, getTally } from './runner.js';
import * as optics from './core.optics.js';
import * as twist from './core.twist.js';
import * as target from './core.target.js';
import * as solve from './core.solve.js';
import * as render from './core.render.js';
import * as fab from './core.fab.js';
import * as project from './core.project.js';
import * as scene from './core.scene.js';
import * as pipeline from './pipeline.js';

export const SECTIONS = [
  ['core.optics', optics],
  ['core.twist', twist],
  ['core.target', target],
  ['core.solve', solve],
  ['core.render', render],
  ['core.fab', fab],
  ['core.project', project],
  ['core.scene', scene],
  ['pipeline', pipeline],
];

/** Headless: run every section (or those named) synchronously. */
export function runAll(only = null) {
  reset();
  for (const [name, mod] of SECTIONS) {
    if (only && !only.includes(name)) continue;
    mod.run();
  }
  summary();
}

export function summary() {
  const t = getTally();
  say(`<h2>Summary</h2><p class="${t.fail ? 'fail' : 'pass'}">${t.pass} passed, ${t.fail} failed</p>`);
}
