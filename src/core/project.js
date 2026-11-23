// Projects: the image and every setting in one file (.rtone.json), so a design
// can be reopened and re-solved to the same plan.
//
// The image is kept as the ORIGINAL file's bytes (a data URL), or a sample's
// name: a re-encode could shift the samples and so the angles. Settings are
// merged onto the defaults one key at a time; a key of the wrong type, or one
// this version does not know, is dropped with a note rather than refusing the
// file.

import { DEFAULTS } from './units.js';

export const PROJECT_VERSION = 1;
export const APP = 'RibbonTone';

/** @param {{image, settings}} p */
export function projectJSON(p) {
  return JSON.stringify({ app: APP, version: PROJECT_VERSION, image: p.image || null, settings: p.settings }, null, 1);
}

/**
 * @returns {{project: {image, settings}, problems: string[]}}
 * @throws when the text is not a RibbonTone project at all
 */
export function parseProject(json) {
  let o;
  try { o = JSON.parse(json); } catch { throw new Error('not JSON'); }
  if (!o || o.app !== APP) throw new Error('not a RibbonTone project');
  const problems = [];
  if (o.version > PROJECT_VERSION) problems.push(`made by a newer version (${o.version})`);
  const settings = { ...DEFAULTS };
  const given = o.settings && typeof o.settings === 'object' ? o.settings : {};
  for (const [k, v] of Object.entries(given)) {
    if (!(k in DEFAULTS)) { problems.push(`unknown setting "${k}" ignored`); continue; }
    const want = typeof DEFAULTS[k];
    if (want === 'number' ? !(typeof v === 'number' && isFinite(v)) : typeof v !== want) {
      problems.push(`setting "${k}" has the wrong type, default used`);
      continue;
    }
    settings[k] = v;
  }
  let image = null;
  const im = o.image;
  if (im && im.kind === 'sample' && typeof im.name === 'string') image = { kind: 'sample', name: im.name };
  else if (im && im.kind === 'file' && typeof im.dataURL === 'string' && im.dataURL.startsWith('data:image/')) image = { kind: 'file', name: String(im.name || 'image'), dataURL: im.dataURL };
  else if (im) problems.push('the image could not be read');
  return { project: { image, settings }, problems };
}
