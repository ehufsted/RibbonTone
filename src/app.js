// UI wiring. Compute happens in worker.js; this module gathers settings, paints
// the plan and exports it. The only file that knows what a DOM is.
//
// SETTINGS LIVE IN `state.set`, IN MILLIMETERS. Every control is a FIELDS
// entry; length fields (class "len") show their value in the chosen units and
// write millimeters back, so switching units only rewrites what is displayed.
// The same object is what the worker gets, what localStorage keeps and what a
// project file holds.
//
// THE PREVIEW IS DRAWN FROM THE PLAN: per-sample angles, shaded here by
// core/render.js (the same optics the solver used, plus neighbours' shadows),
// so every view is crisp at any zoom.

import { DEFAULTS, MATERIALS, materialSettings, toMm, fromMm, pieceGeometry, toneLuminance, lenText } from './core/units.js';
import { toEncoded, hexToLinear } from './core/color.js';
import { quarterTurnLength, maxTwistDeg } from './core/twist.js';
import { toneMap } from './core/target.js';
import { backdropY, pitchModel, viewAngle } from './core/optics.js';
import { ribbonSlices, paintOrder } from './core/render.js';
import { planCombs, planDepth, sidePanelPiece, calibrationCombs, stackPieces, packPieces, pinClipPieces, backPanelPiece, piecesSVG, piecesDXF, bracketCSV, wallTemplateSVG, mod180 } from './core/fab.js';
import { shrinkLinear, meanDeltaE, apparentPx, SCREEN_M } from './core/distance.js';
import { projectJSON, parseProject } from './core/project.js';
import { problemWith } from './pipeline.js';
import { generateSample } from './app/samples.js';
import { buildScene } from './core/scene.js';
import { createView3D, preset } from './app/view3d.js';

const $ = (id) => document.getElementById(id);
const STORE = 'ribbontone.v1';

const LEN = ['clipWall', 'widthMm', 'heightMm', 'ribbonW', 'pitch', 'thickness', 'viewXMm', 'rowSpacing', 'minSpacing', 'maxSpan',
  'slotClear', 'minSlot', 'combMargin', 'combEnd', 'bedMm', 'minWeb', 'combThick', 'standoff'];
const NUM = ['reflectance', 'sheen', 'gloss', 'strainPct', 'tensionN', 'density', 'G', 'E', 'bgReflectance', 'distM', 'maxRows', 'maxPerRibbon'];
const RANGE = { gamma: (v) => v.toFixed(2), brightness: (v) => v.toFixed(2), contrast: (v) => v.toFixed(2),
  lightAz: (v) => `${v}°`, lightEl: (v) => `${v}°`, ambient: (v) => v.toFixed(2), diffusion: (v) => v.toFixed(2) };
const CHECK = ['curveOn', 'splitComb', 'box3d', 'shadows3d', 'alignTwists', 'combShadows'];
const SELECT = ['material', 'layout'];
/** Settings that only change the cutting files: no new solve. */
// (not slotClear, minSlot, combMargin or standoff: they set the comb depths and so
// how far the back wall is behind the ribbons, which the solver's backdrop shadows use)
const FAB_ONLY = new Set(['combEnd', 'bedMm', 'minWeb', 'splitComb', 'combThick', 'clipWall']);
/** Settings that only change how the 3D view looks. */
const VIEW_ONLY = new Set(['box3d', 'combLook', 'combColor', 'shadows3d', 'exportFormat']);
/** The default comb colour in the dark-ribbon scheme. */
const LIGHT_COMB = '#e4e4e4';
/** The material preset's settings: editing one makes the material "custom". */
const MATERIAL_KEYS = Object.keys(materialSettings('satin'));

const state = {
  rgba: null,
  imageName: 'ribbons',
  imageSrc: null,       // {kind:'sample', name} | {kind:'file', name, dataURL}
  lum: null,            // toned luminance, for the Target view
  set: { ...DEFAULTS },  // ONE object for the page's life: bindFields holds it, so Reset and Open project assign into it
  view: 'preview',
  plan: null,
  slices: null,         // core/render.js, per view
  exposure: 1,          // relative Y shown as white (exposureOf)
  scene: null,          // core/scene.js, built when the 3D view needs it
  cam: null,            // the 3D view's orbit camera
  idealSlices: null,
  walkDeg: 0,           // the viewer, turned this far about the piece's centre from the design viewpoint (Viewer slider)
  walkSlices: new Map(), // core/render.js slices for a moved viewer, by view and position
  targetCanvas: null,
  jobId: 0,
  pending: false,
  alerted: false,
};
window.ribbonTone = state;   // for driving the app from DevTools / the CDP harness

// ------------------------------------------------------------------ persistence
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state.set)); } catch { /* storage unavailable */ }
}

function restore() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { o = null; }
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) if (k in DEFAULTS && typeof v === typeof DEFAULTS[k] && (typeof v !== 'number' || isFinite(v))) state.set[k] = v;
}

// ------------------------------------------------------------------ worker
let worker = null;

function spawnWorker() {
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => setStatus(`worker error: ${e.message}`, 'bad');
    return w;
  } catch (err) {
    setStatus('module workers unavailable — see console', 'bad');
    console.error(err);
    return null;
  }
}
worker = spawnWorker();

/** A busy worker cannot see a stop message; terminating it is the only cancel. */
function cancelInFlight() {
  if (!worker || !state.pending) return;
  worker.terminate();
  worker = spawnWorker();
  state.pending = false;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.jobId !== state.jobId) return;
  if (msg.type === 'progress') { setStatus(msg.stage + '…'); return; }
  if (msg.type === 'error') {
    state.pending = false;
    setStatus(`error: ${msg.message}`, 'bad');
    console.error(msg.stack || msg.message);
    if (msg.code === 'TOO_MANY' && !state.alerted) { state.alerted = true; window.alert(msg.message); }
    return;
  }
  if (msg.type === 'done') {
    state.pending = false;
    state.alerted = false;
    state.plan = msg.plan;
    state.slices = ribbonSlices(msg.plan, 'th');
    state.exposure = exposureOf(msg.plan, state.slices);
    state.idealSlices = null;
    state.walkSlices.clear();
    state.scene = null;
    state.targetCanvas = null;
    setStatus(`ready · ${(msg.ms / 1000).toFixed(1)} s`);
    paint();
    updateStats();
    updateNotes();
  }
}

function run() {
  if (!state.rgba || !worker) return;
  updatePieceNote();
  const problem = problemWith(state.set);
  if (problem) { updateNotes(); return; }   // the message, and no file written until it is fixed
  save();
  cancelInFlight();
  if (!worker) return;
  state.jobId++;
  state.pending = true;
  setStatus('working…');
  worker.postMessage({ type: 'run', jobId: state.jobId, rgba: state.rgba, settings: { ...state.set } });
}

let runTimer = null;
function scheduleRun(delay = 300) {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, delay);
}

// ------------------------------------------------------------------ fields
const L = (mm, dp) => (state.set.units === 'in' ? +(fromMm(mm, 'in')).toFixed(dp ?? 3) : +(+mm).toFixed(dp ?? 1));
const unitLabel = () => (state.set.units === 'in' ? 'in' : 'mm');
const lenTxt = (mm) => lenText(mm, state.set.units);

/** Every control from state.set. */
function showFields() {
  const s = state.set;
  for (const id of LEN) $(id).value = L(s[id], s.units === 'in' ? 4 : 2);
  for (const id of NUM) $(id).value = s[id];
  for (const [id, fmt] of Object.entries(RANGE)) { $(id).value = s[id]; $(`${id}Val`).textContent = fmt(s[id]); }
  for (const id of CHECK) $(id).checked = !!s[id];
  $('material').value = MATERIALS[s.material] ? s.material : 'custom';
  $('layout').value = s.layout;
  $('curve').value = s.curve;
  $('combLook').value = s.combLook;
  $('darkRibbons').checked = !!s.darkRibbons;
  $('combColor').value = s.combColor;
  for (const el of document.querySelectorAll('.u')) el.textContent = unitLabel();
  for (const b of document.querySelectorAll('#unitSeg button')) b.setAttribute('aria-pressed', String(b.dataset.units === s.units));
  for (const b of document.querySelectorAll('#holdSeg button')) b.setAttribute('aria-pressed', String(b.dataset.hold === s.hold));
  for (const b of document.querySelectorAll('#fmtSeg button')) b.setAttribute('aria-pressed', String(b.dataset.fmt === s.exportFormat));
  showLayout();
}

function changed(id) {
  save();
  // the comb look decides whether comb shadows are modelled, so with that on it re-solves
  if (id === 'combLook') showLayout();
  // the comb look and the sheet's thickness feed the comb-shadow model: with it on, they re-solve
  const shading = state.set.combShadows && (id === 'combLook' || id === 'combThick');
  if ((FAB_ONLY.has(id) || VIEW_ONLY.has(id)) && !shading) {
    if (FAB_ONLY.has(id)) { updateNotes(); state.scene = null; }
    if (state.view === 'view3d') paint();
    return;
  }
  scheduleRun();
}

function bindFields() {
  const s = state.set;
  const markCustom = (id) => { if (MATERIAL_KEYS.includes(id) && s.material !== 'custom') { s.material = 'custom'; $('material').value = 'custom'; } };
  for (const id of LEN) {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value);
      if (!isFinite(v)) return;
      s[id] = toMm(v, s.units);
      markCustom(id);
      updatePieceNote();
      changed(id);
    });
  }
  for (const id of NUM) {
    $(id).addEventListener('input', () => {
      const v = parseFloat($(id).value);
      if (!isFinite(v)) return;
      s[id] = v;
      markCustom(id);
      updatePieceNote();
      changed(id);
    });
  }
  for (const [id, fmt] of Object.entries(RANGE)) {
    $(id).addEventListener('input', () => {
      s[id] = parseFloat($(id).value);
      $(`${id}Val`).textContent = fmt(s[id]);
      if (id === 'gamma' || id === 'brightness') updateLum();
      changed(id);
    });
  }
  for (const id of CHECK) {
    $(id).addEventListener('change', () => { s[id] = $(id).checked; showLayout(); changed(id); });
  }
  $('material').innerHTML = Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('') +
    '<option value="custom">Custom</option>';
  $('material').addEventListener('change', () => {
    s.material = $('material').value;
    Object.assign(s, materialSettings(s.material, s.darkRibbons));
    showFields();
    updatePieceNote();
    changed('material');
  });
  $('darkRibbons').addEventListener('change', () => {
    // the scheme swaps the ribbon's and the backdrop's reflectance, and a
    // default comb colour with them (dark combs vanish in a black box, light ones in a white one)
    s.darkRibbons = $('darkRibbons').checked;
    [s.reflectance, s.bgReflectance] = [s.bgReflectance, s.reflectance];
    if (s.combColor === (s.darkRibbons ? DEFAULTS.combColor : LIGHT_COMB)) s.combColor = s.darkRibbons ? LIGHT_COMB : DEFAULTS.combColor;
    showFields();
    changed('darkRibbons');
  });
  $('layout').addEventListener('change', () => { s.layout = $('layout').value; showLayout(); changed('layout'); });
  let curveTimer = null;
  $('curve').addEventListener('input', () => { clearTimeout(curveTimer); curveTimer = setTimeout(() => { s.curve = $('curve').value; changed('curve'); }, 400); });
  for (const b of document.querySelectorAll('#unitSeg button')) {
    b.addEventListener('click', () => { s.units = b.dataset.units; showFields(); updatePieceNote(); updateStats(); updateNotes(); save(); });
  }
  for (const b of document.querySelectorAll('#holdSeg button')) {
    b.addEventListener('click', () => { s.hold = b.dataset.hold; showFields(); changed('hold'); });
  }
}

const BLURBS = {
  even: 'Rows of brackets at one spacing, shared by every ribbon: the simplest to build, and what combs are for.',
  bunched: 'Shared rows, placed where the image changes most: the same parts as even rows, a better image for the count.',
  perRibbon: 'Every ribbon gets its own bracket heights: the best image and no horizontal lines, but one pin pair per bracket.',
};

/** Show the controls that apply to this layout and hold. */
function showLayout() {
  const s = state.set;
  const layout = s.hold === 'combs' && s.layout === 'perRibbon' ? 'bunched' : s.layout;
  $('layout').querySelector('option[value=perRibbon]').disabled = s.hold === 'combs';
  if (s.hold === 'combs' && s.layout === 'perRibbon') { s.layout = 'bunched'; $('layout').value = 'bunched'; }
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(layout);
  $('layoutBlurb').textContent = BLURBS[layout] + (s.hold === 'combs' ? ' Combs hold whole rows, so each ribbon\'s own heights need wall pins.' : '');
  $('curveBody').hidden = !s.curveOn;
  // wall pins: their settings, and their cut files
  const pins = s.hold === 'pins';
  $('pinFab').hidden = !pins;
  $('exportClips').hidden = $('exportPanel').hidden = !pins;
  // clear combs cast almost no shadow: nothing to model
  const clear = s.combLook === 'clear';
  $('combShadows').disabled = clear;
  $('combShadowsLabel').style.opacity = clear ? 0.5 : '';
  $('combShadowsLabel').title = clear ? 'clear combs (the 3D view\'s comb look) cast almost no shadow, so there is nothing to model'
    : 'solid combs shade a band of ribbon and backdrop below them when lit from above: model it, so the solver turns ribbons to make up for it (and bunched rows avoid where it costs most)';

}

function updatePieceNote() {
  const s = state.set;
  if (state.rgba) {
    const geo = pieceGeometry(state.rgba, s);
    const n = geo.count;
    $('pieceNote').innerHTML = `<b>${n} ribbons</b> on a piece <b>${L(geo.W)} × ${L(geo.H)} ${unitLabel()}</b>` +
      (s.heightMm > 0 ? ' · image cropped to cover' : '') + ` · ribbon length ${lenTxt(geo.H)} each, ${lenTxt(n * geo.H)} in all`;
  }
  if (s.ribbonW > 0 && s.strainPct > 0) {
    $('twistNote').innerHTML = `Fastest twist <b>${s.units === 'in' ? `${(maxTwistDeg(s) * 25.4).toFixed(1)}°/in` : `${maxTwistDeg(s).toFixed(2)}°/mm`}</b>: white to black (a quarter turn) needs at least <b>${lenTxt(quarterTurnLength(s))}</b>.`;
  }
}

// ------------------------------------------------------------------ painting
const MAX_BACKING = 8192;
const GREYS = Array.from({ length: 256 }, (_, v) => `rgb(${v},${v},${v})`);

function sizeCanvas(W, H) {
  const canvas = $('view'), stage = $('stage');
  const fit = Math.min((stage.clientWidth - 28) / W, (stage.clientHeight - 28) / H);
  const zoom = parseFloat($('zoom').value) || 1;
  let cssPerMm = Math.max(0.02, fit * zoom);
  const dpr = window.devicePixelRatio || 1;
  let k = cssPerMm * dpr;
  if (Math.max(W, H) * k > MAX_BACKING) { k = MAX_BACKING / Math.max(W, H); cssPerMm = k / dpr; }
  canvas.width = Math.max(1, Math.round(W * k));
  canvas.height = Math.max(1, Math.round(H * k));
  canvas.style.width = `${Math.round(W * cssPerMm)}px`;
  canvas.style.height = `${Math.round(H * cssPerMm)}px`;
  return k;
}

/**
 * Relative Y -> an 8-bit grey. The exposure is the brightest FACE any ribbon
 * shows (sheen included), so nothing in the Preview clips: a face shown as
 * white beside a backdrop shown dark then averages, from a distance, to exactly
 * the pitch Y the Target shows.
 */
const greyOf = (Y, exposure) => Math.round(255 * toEncoded(Y / exposure));

/** The brightest thing in view: the brightest face any ribbon can show (the model's, before shadows; or the slices', with a measured curve), or a white backdrop. */
function exposureOf(plan, slices) {
  let ex = backdropY(plan.s);
  if (plan.curvePts) {
    for (const r of slices) for (const v of r.F) if (v > ex) ex = v;
    return ex;
  }
  for (const r of plan.ribbons) for (let a = 0; a < 180; a += 0.5) ex = Math.max(ex, pitchModel(a, r.alpha, plan.s).F);
  return ex;
}

/**
 * The ribbons as seen, farthest from the viewer first. Each ribbon is ONE
 * polygon (left edges down, right edges back up) filled with a vertical
 * gradient stopped at every sample: drawn as separate slices, antialiasing
 * leaves a hairline seam between each pair.
 */
function drawRibbons(ctx, plan, slices) {
  const { W, H } = plan.piece, n = plan.n, dy = plan.dy;
  const ex = state.exposure;
  ctx.fillStyle = GREYS[greyOf(backdropY(plan.s), ex)];
  ctx.fillRect(0, 0, W, H);
  const cb = slices.combBands;
  if (cb && cb.length) {
    // the combs' shadows on the backdrop, seen from the eye
    const look = slices.combBandLook, Yb = (y) => look.ye + (y - look.ye) * look.k;
    ctx.fillStyle = GREYS[greyOf(look.Y, ex)];
    for (const [y0, y1] of cb) ctx.fillRect(0, Yb(y0), W, Yb(y1) - Yb(y0));
  }
  const sh = slices.shadow;
  if (sh) {
    // the ribbons' shadows on the backdrop, under everything else
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    ctx.fillStyle = GREYS[greyOf(sh.Y, ex)];
    const Ys = (y) => sh.ye + (y + sh.dy - sh.ye) * sh.k;
    for (const { sl, sr } of slices) {
      ctx.beginPath();
      ctx.moveTo(sl[0], Ys(0));
      for (let j = 0; j < n; j++) ctx.lineTo(sl[j], Ys((j + 0.5) * dy));
      ctx.lineTo(sl[n - 1], Ys(H)); ctx.lineTo(sr[n - 1], Ys(H));
      for (let j = n - 1; j >= 0; j--) ctx.lineTo(sr[j], Ys((j + 0.5) * dy));
      ctx.lineTo(sr[0], Ys(0));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  for (const i of paintOrder(plan)) {
    const { xl, xr, F } = slices[i];
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    for (let j = 0; j < n; j++) grad.addColorStop(((j + 0.5) * dy) / H, GREYS[greyOf(F[j], ex)]);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xl[0], 0);
    for (let j = 0; j < n; j++) ctx.lineTo(xl[j], (j + 0.5) * dy);
    ctx.lineTo(xl[n - 1], H);
    ctx.lineTo(xr[n - 1], H);
    for (let j = n - 1; j >= 0; j--) ctx.lineTo(xr[j], (j + 0.5) * dy);
    ctx.lineTo(xr[0], 0);
    ctx.closePath();
    ctx.fill();
  }
}

/** The image fitted into the reachable range, per pixel, as the ribbons should show it. */
function targetCanvas(plan) {
  if (state.targetCanvas) return state.targetCanvas;
  const lum = state.lum;
  const c = document.createElement('canvas');
  c.width = lum.width; c.height = lum.height;
  const g = c.getContext('2d');
  const img = g.createImageData(lum.width, lum.height);
  const ex = state.exposure, k = plan.s.contrast;
  for (let i = 0, q = 0; i < lum.data.length; i++, q += 4) {
    const Lt = toneMap(lum.data[i], plan.range, k);
    const v = greyOf(Lt * Lt * Lt, ex);
    img.data[q] = img.data[q + 1] = img.data[q + 2] = v; img.data[q + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  state.targetCanvas = c;
  return c;
}

function drawTarget(ctx, plan) {
  const R = plan.imageRect;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, plan.piece.W, plan.piece.H); ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(targetCanvas(plan), R.x, R.y, R.w, R.h);
  ctx.restore();
}

/** Lightness error per ribbon and sample: blue = too dark, orange = too light, white = on target. */
function drawDiff(ctx, plan) {
  const { W, H } = plan.piece, p = plan.s.pitch, dy = plan.dy;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  for (const r of plan.ribbons) {
    for (let j = 0; j < plan.n; j++) {
      const d = Math.max(-1, Math.min(1, ((r.L[j] - r.Lt[j]) * 100) / 15));
      if (Math.abs(d) < 0.02) continue;
      const t = Math.abs(d);
      const col = d < 0 ? [255 - 215 * t, 255 - 135 * t, 255] : [255, 255 - 115 * t, 255 - 235 * t];
      ctx.fillStyle = `rgb(${col.map(Math.round).join(',')})`;
      ctx.fillRect(r.x - p / 2, j * dy, p, dy + 0.05);
    }
  }
}

/** Where the brackets go: spans coloured by twist direction (orange clockwise from above, cyan counter), brighter = faster; a dial per bracket shows its slot angle from above (wall at the top). */
function drawBrackets(ctx, plan, k) {
  const { W, H } = plan.piece, s = plan.s;
  ctx.fillStyle = '#15161b';
  ctx.fillRect(0, 0, W, H);
  const px = 1 / k;
  if (plan.rows) {
    ctx.strokeStyle = '#ababff55';
    ctx.lineWidth = 1.5 * px;
    for (const y of plan.rows) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }
  const rDial = Math.min(s.pitch * 0.42, 12);
  for (const r of plan.ribbons) {
    for (let b = 0; b + 1 < r.knots.length; b++) {
      const A = r.knots[b], B = r.knots[b + 1], d = B.a - A.a;
      const rate = Math.abs(d) / Math.max(1e-9, B.y - A.y) / plan.kmaxDeg;
      const t = Math.min(1, 0.25 + 0.75 * rate);
      ctx.strokeStyle = Math.abs(d) < 0.5 ? '#777' : d > 0 ? `rgba(255,170,60,${t})` : `rgba(80,210,255,${t})`;
      ctx.lineWidth = Math.max(2 * px, s.ribbonW * 0.18);
      ctx.beginPath(); ctx.moveTo(r.x, A.y); ctx.lineTo(r.x, B.y); ctx.stroke();
    }
    for (const kn of r.knots) {
      const a = mod180(kn.a) * Math.PI / 180;
      const ux = Math.cos(a), uy = -Math.sin(a);
      ctx.fillStyle = '#15161b';
      ctx.strokeStyle = '#e6e7ea';
      ctx.lineWidth = 1 * px;
      ctx.beginPath(); ctx.arc(r.x, kn.y, rDial, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.lineWidth = Math.max(1.5 * px, rDial * 0.18);
      ctx.beginPath(); ctx.moveTo(r.x - rDial * ux, kn.y - rDial * uy); ctx.lineTo(r.x + rDial * ux, kn.y + rDial * uy); ctx.stroke();
    }
  }
}

/**
 * Where the viewer stands: the design viewpoint turned `state.walkDeg` about
 * the piece's centre, keeping its distance from the centre -- in the Distance
 * view, the distance chosen there.
 * @returns {{xv: number, distM: number}}  across the piece, mm; out from the wall, m
 */
function viewerAt(plan) {
  const xc = plan.piece.W / 2, off = plan.xv - xc, dz = plan.s.distM * 1000;
  const R = state.view === 'distance' ? parseFloat($('distView').value) * 1000 : Math.hypot(off, dz);
  const phi = Math.atan2(off, dz) + (state.walkDeg * Math.PI) / 180;
  return { xv: xc + R * Math.sin(phi), distM: (R * Math.cos(phi)) / 1000 };
}

/** The plan as the viewer (viewerAt) sees it: the same ribbons, each seen from its new direction. */
function walked(plan) {
  const v = viewerAt(plan);
  if (Math.abs(v.xv - plan.xv) < 1e-6 && Math.abs(v.distM - plan.s.distM) < 1e-9) return plan;
  return {
    ...plan, xv: v.xv, s: { ...plan.s, distM: v.distM },
    ribbons: plan.ribbons.map((r) => ({ ...r, alpha: viewAngle(r.x, v.xv, v.distM) })),
  };
}

/** The slices for a view (the bracketed or the ideal path), from where the viewer stands. */
function slicesFor(plan, which) {
  const w = walked(plan);
  if (w === plan) {
    if (which === 'th') return state.slices;
    state.idealSlices ||= ribbonSlices(plan, 'ideal');
    return state.idealSlices;
  }
  const key = `${which}@${w.xv.toFixed(2)},${w.s.distM.toFixed(5)}`;
  if (!state.walkSlices.has(key)) {
    if (state.walkSlices.size > 8) state.walkSlices.clear();
    state.walkSlices.set(key, ribbonSlices(w, which));
  }
  return state.walkSlices.get(key);
}

const HINTS = {
  preview: 'the ribbons from the design viewpoint, the brightest face shown as white',
  ideal: 'with a bracket everywhere: the best the twist limit allows; the gap to Preview is what the brackets cost',
  target: 'the image fitted into the range the ribbons can reach',
  diff: 'lightness error: blue = too dark, orange = too light (full colour = 15), white = on target',
  brackets: 'dials: slot angle seen from above, wall at the top · spans: orange = clockwise from above, cyan = counter, brighter = faster',
};

function paint() {
  const plan = state.plan;
  if (!plan) return;
  const is3d = state.view === 'view3d';
  $('distControls').hidden = state.view !== 'distance';
  $('walkCtl').hidden = !['preview', 'ideal', 'distance'].includes(state.view);
  $('ctl3d').hidden = !is3d;
  $('zoomCtl').hidden = is3d;
  $('wrap').hidden = is3d;
  $('view3d').hidden = !is3d;
  $('stage').classList.toggle('is3d', is3d);
  if (is3d) { paint3D(plan); return; }
  if (state.view === 'distance') { paintDistance(plan); return; }
  const k = sizeCanvas(plan.piece.W, plan.piece.H);
  const ctx = $('view').getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawView(ctx, plan, state.view, k);
  const shifted = state.walkDeg && (state.view === 'preview' || state.view === 'ideal');
  $('hint').textContent = shifted
    ? `as a viewer ${Math.abs(state.walkDeg)}° ${state.walkDeg > 0 ? 'right' : 'left'} of the design viewpoint sees it, at the same distance from the piece's centre (double-click the slider to go back)`
    : HINTS[state.view] || '';
}

function drawView(ctx, plan, view, k) {
  if (view === 'preview') drawRibbons(ctx, walked(plan), slicesFor(plan, 'th'));
  else if (view === 'ideal') drawRibbons(ctx, walked(plan), slicesFor(plan, 'ideal'));
  else if (view === 'target') drawTarget(ctx, plan);
  else if (view === 'diff') drawDiff(ctx, plan);
  else if (view === 'brackets') drawBrackets(ctx, plan, k);
}

/**
 * The Distance view (core/distance.js): the preview at the size it subtends
 * from D meters, averaged into CSS pixels in linear light, beside the target
 * shrunk the same way.
 */
function paintDistance(plan) {
  const D = parseFloat($('distView').value);
  $('distViewVal').textContent = `${D} m`;
  const { W, H } = plan.piece;
  const full = Math.max(8, Math.min(3000, Math.round(apparentPx(W, D))));
  const th = Math.max(8, Math.round((full * H) / W));
  // seen from off to the side, the piece (and the image it stands for) looks narrower by cos φ
  const v = viewerAt(plan), dz = v.distM * 1000;
  const tw = Math.max(8, Math.round(full * (dz / Math.hypot(v.xv - W / 2, dz))));
  const k = Math.min(8, (4 * full) / W, Math.sqrt(12e6 / (W * H)));
  const hw = Math.max(1, Math.round(W * k)), hh = Math.max(1, Math.round(H * k));
  const render = (view) => {
    const c = document.createElement('canvas');
    c.width = hw; c.height = hh;
    const g = c.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    drawView(g, plan, view, k);
    return shrinkLinear(g.getImageData(0, 0, hw, hh).data, hw, hh, tw, th);
  };
  const seen = render('preview');
  const compare = $('distCompare').checked;
  const tgt = render('target');
  const gap = compare ? 16 : 0;
  const canvas = $('view');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round((compare ? 2 * tw + gap : tw) * dpr);
  canvas.height = Math.round(th * dpr);
  canvas.style.width = `${compare ? 2 * tw + gap : tw}px`;
  canvas.style.height = `${th}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1d1f26';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const put = (px, x) => {
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    c.getContext('2d').putImageData(new ImageData(px, tw, th), 0, 0);
    ctx.drawImage(c, 0, 0, tw, th, x * dpr, 0, tw * dpr, th * dpr);
  };
  put(seen, 0);
  if (compare) put(tgt, tw + gap);
  const merge = (plan.s.pitch * SCREEN_M) / (25.4 / 96);
  $('hint').textContent = `as seen from ${D} m${state.walkDeg ? `, ${Math.abs(state.walkDeg)}° ${state.walkDeg > 0 ? 'right' : 'left'} of the design viewpoint` : ''}, if you sit ${SCREEN_M} m from a 96 dpi screen${compare ? ' (the target on the right)' : ''}: ` +
    `ΔE ${meanDeltaE(seen, tgt).toFixed(1)} pixel for pixel; ` +
    (D < merge ? `the ribbons still show as stripes (they merge from about ${Math.round(merge)} m)` : 'the ribbons have merged into tone');
}

// ------------------------------------------------------------------ hover
function bindHover() {
  $('view').addEventListener('mousemove', (e) => {
    const plan = state.plan;
    if (!plan || state.view === 'distance') return;
    const rect = $('view').getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * plan.piece.W, y = ((e.clientY - rect.top) / rect.height) * plan.piece.H;
    const rb = plan.ribbons;
    let i = 0;
    for (let m = 1; m < rb.length; m++) if (Math.abs(rb[m].x - x) < Math.abs(rb[i].x - x)) i = m;
    const r = rb[i];
    if (!r || Math.abs(r.x - x) > plan.s.pitch / 2) { $('hint').textContent = HINTS[state.view] || ''; return; }
    const j = Math.max(0, Math.min(plan.n - 1, Math.floor(y / plan.dy)));
    let near = null;
    for (const [b, kn] of r.knots.entries()) if (Math.abs(kn.y - y) < Math.max(plan.s.pitch * 0.45, 6)) near = { b, kn };
    let t = `ribbon ${i + 1} · ${lenTxt(y)} from the top · angle ${mod180(r.th[j]).toFixed(0)}° · lightness ${(100 * r.L[j]).toFixed(0)} (target ${(100 * r.Lt[j]).toFixed(0)})`;
    if (near) {
      const turn = near.b ? near.kn.a - r.knots[near.b - 1].a : 0;
      const kind = near.b === 0 ? 'top bar' : near.b === r.knots.length - 1 ? 'bottom bar' : `bracket ${near.b}`;
      t = `ribbon ${i + 1}, ${kind} at ${lenTxt(near.kn.y)}: slot ${mod180(near.kn.a).toFixed(1)}°` +
        (near.b ? `, turned ${Math.abs(turn).toFixed(1)}° ${turn >= 0 ? 'clockwise' : 'counterclockwise'} (from above) since the one before` : '');
    }
    $('hint').textContent = t;
  });
  $('view').addEventListener('mouseleave', () => { if (state.view !== 'distance') $('hint').textContent = HINTS[state.view] || ''; });
}

// ------------------------------------------------------------------ stats
function setStat(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = cls; }

function updateStats() {
  const plan = state.plan;
  if (!plan) return;
  const st = plan.stats;
  setStat('statRibbons', String(st.ribbons));
  setStat('statPiece', `${L(plan.piece.W)} × ${L(plan.piece.H)} ${unitLabel()}`);
  setStat('statBrackets', plan.rows ? `${st.brackets} (${st.rows} rows)` : String(st.brackets));
  setStat('statTone', st.tone.toFixed(1), st.tone > 8 ? 'warn' : '');
  setStat('statSeen', `${st.seen.toFixed(1)} (${st.seenIdeal.toFixed(1)})`, st.seen > 5 ? 'warn' : '');
  setStat('statOff', `${st.offAxis.stripes.toFixed(1)} / ${st.offAxis.tone.toFixed(1)}`);
  setStat('statRate', `${Math.round(st.rateUse * 100)}%`, st.rateUse > 1 + 1e-6 ? 'bad' : '');
}



// ------------------------------------------------------------------ 3D
// The scene is rebuilt only when the plan or a fabrication setting changes;
// the camera persists across plans (reset with the presets) and starts at the
// three-quarter view.
let v3 = undefined;

function paint3D(plan) {
  if (v3 === undefined) {
    try { v3 = createView3D($('view3d')); } catch (err) { console.error(err); v3 = null; }
    if (v3) v3.controls(() => state.cam, () => draw3D());
  }
  if (!v3) { $('hint').textContent = 'this browser has no WebGL, so there is no 3D view'; return; }
  if (!state.scene) {
    state.scene = buildScene(plan, { ...plan.s, ...fabSettings() });
    v3.setScene(state.scene);
  }
  if (!state.cam) state.cam = camPreset('quarter');
  draw3D();
  // touch screens get their own words
  $('hint').textContent = window.matchMedia && window.matchMedia('(pointer: coarse)').matches
    ? 'drag to orbit · two fingers to pan and pinch to zoom'
    : 'drag to orbit · right- or shift-drag to pan · wheel or pinch to zoom';
}

function camPreset(name) {
  const plan = state.plan, c = $('view3d');
  return preset(name, state.scene, { xv: plan.xv, H: plan.piece.H, distM: plan.s.distM }, (c.clientWidth || 4) / (c.clientHeight || 3));
}

function draw3D() {
  const plan = state.plan, s = plan.s, v = state.set;
  if (!v3 || !state.scene || !state.cam) return;
  const RADN = Math.PI / 180, ce = Math.cos(s.lightEl * RADN);
  v3.render(state.cam, {
    light: [ce * Math.sin(s.lightAz * RADN), Math.sin(s.lightEl * RADN), ce * Math.cos(s.lightAz * RADN)],
    ambient: s.ambient, exposure: state.exposure,
    ribbon: { albedo: [s.reflectance, s.reflectance, s.reflectance], sheen: s.sheen, gloss: s.gloss },
    box: { on: v.box3d, albedo: [s.bgReflectance, s.bgReflectance, s.bgReflectance] },
    comb: { look: v.combLook, albedo: hexToLinear(v.combColor) },
    background: [0.114, 0.122, 0.149],
    shadows: v.shadows3d,
  });
}

/** The plan's notes, plus the comb check (settings may have changed since the solve). */
function updateNotes() {
  const plan = state.plan;
  const items = plan ? plan.notes.slice() : [];
  let combMsg = '';
  // a setting out of range (problemWith): no file is written until it is fixed
  const bad = problemWith(state.set);
  for (const id of EXPORT_IDS) $(id).disabled = !!bad;
  if (bad) {
    items.unshift(bad);
    setStatus(bad, 'bad');
    state.badShown = true;
    $('combNote').textContent = '';
    showNotes(items);
    return;
  }
  if (state.badShown) {
    // the setting is fixed: clear its message (a re-solve, if one is needed, says its own)
    state.badShown = false;
    if (!state.pending) setStatus('ready');
  }
  if (plan) {
    const fp = { ...plan, s: { ...plan.s, ...fabSettings() } };
    const c = planCombs(fp);
    combMsg = `${c.pieces.length} comb pieces${plan.rows && plan.hold !== 'pins' ? '' : ' (the top and bottom bars)'} · ` +
      `deepest ${lenTxt(planDepth(fp))} · least web ${lenTxt(c.web)}`;
    // the panels' sizes, as information: they are usually cut from board or on a bigger machine
    const bed = state.set.bedMm, side = sidePanelPiece(fp);
    const panels = [['side panels (2)', side], ...(plan.hold === 'pins' ? [['back panel', backPanelPiece(fp)]] : [])];
    combMsg += ' · ' + panels.map(([name, pc]) => `${name} ${lenTxt(pc.w)} × ${lenTxt(pc.h)}${bed > 0 && Math.max(pc.w, pc.h) > bed ? ' (longer than the bed)' : ''}`).join(' · ');
    if (c.web < state.set.minWeb) {
      items.push(`comb material comes down to ${lenTxt(c.web)} (between slots${state.set.splitComb ? ', or the split\'s cut and a slot' : ''}), under the least web (${lenTxt(state.set.minWeb)}): widen the pitch`);
    }
  }
  if (plan && state.set.hold === 'pins') {
    // a clip turned end-on reaches back past the ribbon's edge by the slot's clearance, the clip's wall
    // and a little more at its corners; the stem needs some length beyond that
    const st = state.set, slotW = Math.max(st.minSlot, st.thickness + st.slotClear);
    const past = Math.hypot((st.ribbonW + st.slotClear) / 2 + st.clipWall, slotW / 2 + st.clipWall) - st.ribbonW / 2;
    if (st.standoff < past + 2) items.push(`the pin stand-off (${lenTxt(st.standoff)}) leaves a clip turned end-on (it reaches ${lenTxt(past)} past the ribbon's edge) almost no stem: make it ${lenTxt(past + 10)} or more`);
  }
  $('combNote').textContent = [combMsg, ...(plan && plan.info ? plan.info : [])].filter(Boolean).join(' · ');
  showNotes(items);
  for (const id of EXPORT_IDS) $(id).disabled = !plan && id !== 'calExport';
  const clips = plan && plan.hold === 'pins' && plan.ribbons.some((r) => r.knots.length > 2);
  $('exportClips').disabled = $('exportPanel').disabled = !clips;
}

/** The warnings, in the strip under the view bar (hidden when there are none). */
function showNotes(items) {
  $('notes').innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  $('notes').hidden = !items.length;
}

/** Every button that writes a file. */
const EXPORT_IDS = ['exportCombs', 'exportSide', 'exportClips', 'exportPanel', 'exportCSV', 'exportTemplate', 'exportJson', 'exportPng', 'calExport'];

/** A cut file in the chosen format (Export: SVG or DXF). */
function downloadCut(sheet, name, title) {
  if (state.set.exportFormat === 'dxf') downloadFile(piecesDXF(sheet), `${name}.dxf`, 'application/dxf');
  else downloadFile(piecesSVG(sheet, title), `${name}.svg`, 'image/svg+xml');
}

const fabSettings = () => Object.fromEntries([...FAB_ONLY].map((k) => [k, state.set[k]]));

// ------------------------------------------------------------------ exports
function downloadFile(text, filename, type) {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const base = () => `${state.imageName}-ribbons`;

function bindExports() {
  const combSheet = () => {
    const plan = state.plan;
    return stackPieces(planCombs({ ...plan, s: { ...plan.s, ...fabSettings() } }).pieces);
  };
  $('exportCombs').addEventListener('click', () => { if (state.plan) downloadCut(combSheet(), `${base()}-combs`, `${base()} combs`); });
  const sideSheet = () => stackPieces([sidePanelPiece({ ...state.plan, s: { ...state.plan.s, ...fabSettings() } })]);
  $('exportSide').addEventListener('click', () => { if (state.plan) downloadCut(sideSheet(), `${base()}-side-panel`, `${base()} side panel`); });
  $('exportCSV').addEventListener('click', () => { if (state.plan) downloadFile(bracketCSV(state.plan, state.set.units), `${base()}-brackets.csv`, 'text/csv'); });
  $('exportTemplate').addEventListener('click', () => { if (state.plan) downloadFile(wallTemplateSVG(state.plan), `${base()}-wall-template.svg`, 'image/svg+xml'); });
  $('exportJson').addEventListener('click', () => {
    if (!state.plan) return;
    const p = state.plan;
    const out = {
      app: 'RibbonTone', piece: p.piece, layout: p.layout, hold: p.hold, rows: p.rows, stats: p.stats, notes: p.notes,
      settings: { ...p.s, curve: p.s.curveOn ? p.s.curve : '' },
      ribbons: p.ribbons.map((r, i) => ({ ribbon: i + 1, x: r.x, brackets: r.knots.map((k) => ({ y: +k.y.toFixed(2), angle: +k.a.toFixed(2), slot: +mod180(k.a).toFixed(2) })) })),
    };
    downloadFile(JSON.stringify(out, null, 1), `${base()}-plan.json`, 'application/json');
  });
  $('exportPng').addEventListener('click', () => {
    if (!state.plan) return;
    if (state.view === 'view3d') { draw3D(); $('view3d').toBlob((b) => downloadFile(b, `${base()}-3d.png`, 'image/png')); return; }
    // a Preview from a shifted viewer says so in its name
    const where = state.walkDeg && state.view !== 'target' && state.view !== 'diff' && state.view !== 'brackets'
      ? `-viewer${state.walkDeg > 0 ? '+' : '-'}${Math.abs(state.walkDeg)}deg` : '';
    const p = state.plan, k = 2400 / Math.max(p.piece.W, p.piece.H);
    const c = document.createElement('canvas');
    c.width = Math.round(p.piece.W * k); c.height = Math.round(p.piece.H * k);
    const g = c.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    drawView(g, p, state.view === 'distance' ? 'preview' : state.view, k);
    c.toBlob((b) => downloadFile(b, `${base()}-${state.view}${where}.png`, 'image/png'));
  });
  const pinPlan = () => ({ ...state.plan, s: { ...state.plan.s, ...fabSettings() } });
  const clipSheet = () => packPieces(pinClipPieces(pinPlan()), state.set.bedMm);
  const panelSheet = () => stackPieces([backPanelPiece(pinPlan())]);
  const hasClips = () => state.plan && state.plan.hold === 'pins' && state.plan.ribbons.some((r) => r.knots.length > 2);
  $('exportClips').addEventListener('click', () => { if (hasClips()) downloadCut(clipSheet(), `${base()}-pin-clips`, `${base()} pin clips`); });
  $('exportPanel').addEventListener('click', () => { if (hasClips()) downloadCut(panelSheet(), `${base()}-back-panel`, `${base()} back panel`); });
  const cal = () => stackPieces(calibrationCombs({ ...state.set }, parseFloat($('calStep').value)).pieces);
  $('calExport').addEventListener('click', () => downloadCut(cal(), 'ribbontone-calibration-combs', 'RibbonTone calibration combs'));
  for (const b of document.querySelectorAll('#fmtSeg button')) {
    b.addEventListener('click', () => { state.set.exportFormat = b.dataset.fmt; showFields(); changed('exportFormat'); });
  }
}

// ------------------------------------------------------------------- image
function loadImage(url, maxDim = 3000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ width: w, height: h, data: ctx.getImageData(0, 0, w, h).data });
    };
    img.onerror = () => reject(new Error('could not read that image'));
    img.src = url;
  });
}

function setImage(rgba, name, src) {
  state.rgba = rgba;
  state.imageName = name;
  state.imageSrc = src;
  updateLum();
  updatePieceNote();
  run();
}

function updateLum() {
  if (!state.rgba) return;
  state.lum = toneLuminance(state.rgba, state.set.gamma, state.set.brightness);
  state.targetCanvas = null;
}

async function loadSample(kind) {
  if (kind === 'rhino') {
    try { setImage(await loadImage('assets/rhino.jpg'), 'rhino', { kind: 'sample', name: 'rhino' }); return; } catch { kind = 'sphere'; }
  }
  setImage(generateSample(kind).gray, kind, { kind: 'sample', name: kind });
}

function bindImage() {
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  $('file').addEventListener('change', () => { const f = $('file').files[0]; if (f) openFile(f); $('file').value = ''; });
  for (const b of document.querySelectorAll('[data-sample]')) b.addEventListener('click', () => loadSample(b.dataset.sample));
}

async function openFile(f) {
  try {
    // the original bytes, kept for projects: a re-encode could shift the samples
    const dataURL = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('could not read that file'));
      r.readAsDataURL(f);
    });
    setImage(await loadImage(dataURL), f.name.replace(/\.[^.]+$/, '') || 'ribbons', { kind: 'file', name: f.name, dataURL });
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

// ----------------------------------------------------------------- projects
function bindProjects() {
  $('resetAll').addEventListener('click', () => {
    if (!window.confirm('Reset every control to its default?\n\nThe image stays.')) return;
    Object.assign(state.set, DEFAULTS);
    showFields();
    updateLum();
    updatePieceNote();
    $('zoom').value = '1';
    setView('preview');
    run();
    setStatus('every control reset to its default');
  });
  $('saveProject').addEventListener('click', () => {
    if (!state.imageSrc) return;
    downloadFile(projectJSON({ image: state.imageSrc, settings: state.set }), `${state.imageName}.rtone.json`, 'application/json');
  });
  $('openProject').addEventListener('click', () => $('projectFile').click());
  $('projectFile').addEventListener('change', async () => {
    const f = $('projectFile').files[0];
    $('projectFile').value = '';
    if (!f) return;
    try {
      const { project, problems } = parseProject(await f.text());
      Object.assign(state.set, project.settings);
      showFields();
      const im = project.image;
      if (im && im.kind === 'sample') await loadSample(im.name);
      else if (im) setImage(await loadImage(im.dataURL), im.name.replace(/\.[^.]+$/, '') || 'ribbons', im);
      else { updateLum(); run(); }
      if (problems.length) setStatus(`project opened (with problems: ${problems.join('; ')})`, 'warn');
    } catch (err) {
      setStatus(`could not open the project: ${err.message}`, 'bad');
    }
  });
}

// ------------------------------------------------------------------- misc
function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#viewSeg button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
  paint();
}

function bindViews() {
  for (const b of document.querySelectorAll('#viewSeg button')) b.addEventListener('click', () => setView(b.dataset.view));
  let distTimer = null;
  $('distView').addEventListener('input', () => { $('distViewVal').textContent = `${$('distView').value} m`; clearTimeout(distTimer); distTimer = setTimeout(paint, 80); });
  $('distCompare').addEventListener('change', paint);
  let walkTimer = null;
  const showWalk = () => {
    const v = state.walkDeg;
    $('walkVal').textContent = v === 0 ? 'design' : `${v > 0 ? '+' : '−'}${Math.abs(v)}°`;
  };
  $('walkDeg').addEventListener('input', () => { state.walkDeg = parseFloat($('walkDeg').value) || 0; showWalk(); clearTimeout(walkTimer); walkTimer = setTimeout(paint, 60); });
  $('walkDeg').addEventListener('dblclick', () => { $('walkDeg').value = 0; state.walkDeg = 0; showWalk(); paint(); });
  showWalk();
  $('zoom').addEventListener('change', paint);
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(paint, 120); });
}

function bind3D() {
  $('camPreset').addEventListener('change', () => {
    const name = $('camPreset').value;
    $('camPreset').value = '';
    if (!name || !state.scene) return;
    state.cam = camPreset(name);
    draw3D();
  });
  $('combLook').addEventListener('change', () => { state.set.combLook = $('combLook').value; changed('combLook'); });
  $('combColor').addEventListener('input', () => { state.set.combColor = $('combColor').value; changed('combColor'); });
}

function init() {
  restore();
  bind3D();
  bindFields();
  showFields();
  bindProjects();
  bindViews();
  bindHover();
  bindExports();
  bindImage();
  updatePieceNote();
  loadSample('sphere');
}

init();
