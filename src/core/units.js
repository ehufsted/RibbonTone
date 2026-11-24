// Settings, units, materials, and where the image lies on the piece.
//
// EVERYTHING INSIDE IS MILLIMETERS AND DEGREES. Inches exist only at the app's
// edges: `toMm` / `fromMm` are the only conversions, so a plan made in inches is
// the same plan as one made in the equivalent millimeters (the harness checks it).
//
// THE PIECE. The ribbons hang between a top bar (y = 0) and a fixed bottom bar
// (y = H), in front of a black backdrop W wide. The image covers the piece: its
// height is the image's aspect at width W unless heightMm is given, in which case
// the image is scaled to COVER and centred (cropped, never stretched), as in
// Photo2Mosaic. Ribbons are centred on the piece at the pitch.
//
// ANGLES. A ribbon's angle θ is the direction of its face normal, measured in the
// horizontal plane from straight out of the wall (+z, toward the viewer) toward
// +x (the viewer's right). Seen from above, positive θ turns the face to the
// right: clockwise looking down. Both faces are white, so θ and θ + 180° look the
// same and a slot cut at θ holds either.

import { toLinear, toEncoded, luminance } from './color.js';

export const MM_PER_IN = 25.4;
export const toMm = (v, units) => (units === 'in' ? v * MM_PER_IN : v);
export const fromMm = (v, units) => (units === 'in' ? v / MM_PER_IN : v);

/** A length for a note: '20 mm' or '0.787 in'. */
export const lenText = (mm, units) => (units === 'in'
  ? `${Math.round((mm / MM_PER_IN) * 1000) / 1000} in`
  : `${Math.round(mm * 10) / 10} mm`);

/**
 * Ribbon materials. Optics: reflectance and a satin sheen (Blinn-Phong strength
 * and exponent). Mechanics: thickness, areal density (the ribbon's own weight
 * adds tension above the bottom bar), shear and bending moduli (only the coiling
 * check uses them), and the edge strain the material takes before it overstretches
 * (it sets the twist-rate limit, core/twist.js). Fabric moduli are effective
 * values for a woven tape, far below the fibre's: treat them as rough.
 */
export const MATERIALS = {
  satin:     { label: 'Satin ribbon (polyester)', reflectance: 0.85, sheen: 0.2,  gloss: 10, thickness: 0.25, density: 80,  G: 0.02, E: 0.5, strainPct: 0.55 },
  grosgrain: { label: 'Grosgrain (matte)',        reflectance: 0.8,  sheen: 0.03, gloss: 4,  thickness: 0.4,  density: 150, G: 0.03, E: 0.3, strainPct: 0.55 },
  tyvek:     { label: 'Tyvek strip',              reflectance: 0.9,  sheen: 0.05, gloss: 6,  thickness: 0.15, density: 55,  G: 0.2,  E: 0.6, strainPct: 0.8 },
  paper:     { label: 'Paper strip (80 gsm)',     reflectance: 0.85, sheen: 0.02, gloss: 4,  thickness: 0.1,  density: 80,  G: 1.5,  E: 4,   strainPct: 0.3 },
  pet:       { label: 'White PET film',           reflectance: 0.88, sheen: 0.3,  gloss: 30, thickness: 0.1,  density: 140, G: 1.5,  E: 4,   strainPct: 0.4 },
};

export const DEFAULTS = {
  units: 'mm',
  widthMm: 1000,        // backdrop width
  heightMm: 0,          // ribbon length between the bars; 0 = from the image's aspect
  ribbonW: 20,          // mm
  pitch: 30,            // mm, centre to centre
  thickness: 0.25,      // mm
  material: 'satin',
  darkRibbons: false,   // dark ribbons on a white backdrop: swaps the two reflectances
  reflectance: 0.85,
  sheen: 0.2,
  gloss: 10,
  density: 80,          // g/m²
  G: 0.02,              // GPa, effective shear modulus
  E: 0.5,               // GPa, effective bending modulus
  strainPct: 0.55,      // % edge strain allowed (0.55 % = 90° per 150 mm at 20 mm)
  tensionN: 2,          // N per ribbon, held by the bottom bar
  bgReflectance: 0.04,  // the black backdrop
  lightAz: 0,           // degrees, + = light from the viewer's right
  lightEl: 45,          // degrees above horizontal
  ambient: 0.3,         // share of the light that comes from everywhere
  distM: 4,             // design viewpoint: distance from the ribbons, m
  viewXMm: 0,           // and offset from the piece's centre line, mm (+ = right)
  curveOn: false,       // use the measured brightness curve instead of the model
  curve: '',            // its text: "angle value" lines (core/optics.js)
  gamma: 1,
  brightness: 1,
  contrast: 1,
  // brackets
  hold: 'combs',        // 'combs' | 'pins'
  layout: 'even',       // 'even' | 'bunched' | 'perRibbon'
  rowSpacing: 120,      // mm, even rows
  maxRows: 12,          // bunched rows: most rows besides the two bars
  maxPerRibbon: 12,     // per-ribbon: most brackets per ribbon besides the bars
  minSpacing: 40,       // mm, least distance between brackets
  maxSpan: 400,         // mm, longest span between brackets
  diffusion: 0.6,       // share of each ribbon's tone error passed to the next
  alignTwists: false,   // on: neighbours turn alike (alignment +1); off: opposite (−1). core/align.js
  // fabrication
  slotClear: 0.6,       // mm added to the slot's length and width
  minSlot: 1.0,         // mm, narrowest slot the laser should cut
  combMargin: 10,       // mm of comb in front of and behind each row's farthest-reaching slot (1 cm to the back wall)
  combEnd: 10,          // mm of comb beyond the outer ribbons' farthest slot ends (core/fab.js combEnds): 1 cm to the sides
  bedMm: 600,           // mm, longest comb piece the cutter takes
  splitComb: false,     // cut every comb along its centre line for assembly
  minWeb: 2,            // mm of material between neighbouring slots
  combThick: 3,         // mm, sheet the combs and pin tabs are cut from
  standoff: 10,         // mm, pins: the least gap from a ribbon's edge to the back wall (fab.pinWallDepth)
  clipWall: 1.5,        // mm, pins: clip material around the slot (core/fab.js clipShapes)
  // the 3D view
  box3d: true,          // the black box around the back, sides, top and bottom
  combLook: 'solid',    // 'solid' | 'clear'
  combColor: '#222222', // solid combs and tabs
  shadows3d: true,      // cast shadows in the 3D view
};

/** A dyed-black ribbon's reflectance, for the dark scheme. */
export const DARK_RIBBON = 0.05;

/** The settings a material preset sets (a dyed-black ribbon in the dark scheme). */
export const materialSettings = (id, dark = false) => {
  const m = MATERIALS[id];
  if (!m) return {};
  const { label, ...rest } = m;
  return dark ? { ...rest, reflectance: DARK_RIBBON } : rest;
};

/** The most ribbons, and samples down a ribbon, a plan may have. */
export const MAX_RIBBONS = 400;
export const MAX_SAMPLES = 700;

/**
 * The piece's size, the image's place on it, and the ribbons' centres.
 * Settings a person is still typing (a pitch of 0 on the way to 0.5) give no
 * ribbons rather than an endless loop; past MAX_RIBBONS the centres are not
 * listed at all, only counted.
 * @returns {{W, H, imageRect:{x,y,w,h}, xs:number[], count:number}}
 */
export function pieceGeometry(img, s) {
  const W = s.widthMm;
  const H = s.heightMm > 0 ? s.heightMm : (W * img.height) / img.width;
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale, h = img.height * scale;
  const ok = W > 0 && s.pitch > 0 && s.ribbonW > 0 && isFinite(W / s.pitch);
  const count = ok ? Math.max(0, Math.floor((W - s.ribbonW) / s.pitch + 1e-9) + 1) : 0;
  const xs = [];
  if (count <= MAX_RIBBONS) for (let i = 0; i < count; i++) xs.push(W / 2 + (i - (count - 1) / 2) * s.pitch);
  return { W, H, imageRect: { x: (W - w) / 2, y: (H - h) / 2, w, h }, xs, count };
}

/**
 * Gamma and brightness on the raw pixels, giving LINEAR LUMINANCE per pixel (a
 * Float32Array): the ribbons are white, so only lightness matters. Gamma is a
 * darkness curve on the encoded value and brightness a multiplier in linear
 * light, as in HalftoneCuttable; contrast is applied later, in lightness
 * (core/target.js), where it is symmetric about mid-grey.
 */
export function toneLuminance(rgba, gamma = 1, brightness = 1) {
  const { width: w, height: h, data } = rgba;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(1 - Math.pow(1 - i / 255, gamma));
  const out = new Float32Array(w * h);
  for (let i = 0, q = 0; i < w * h; i++, q += 4) {
    out[i] = Math.min(1, brightness * luminance(lut[data[q]], lut[data[q + 1]], lut[data[q + 2]]));
  }
  return { width: w, height: h, data: out };
}

/** The toned luminance as grey RGBA, for the Source view. */
export function lumToRGBA(lum) {
  const { width: w, height: h, data } = lum;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, q = 0; i < w * h; i++, q += 4) {
    const v = Math.round(255 * toEncoded(data[i]));
    out[q] = out[q + 1] = out[q + 2] = v; out[q + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
