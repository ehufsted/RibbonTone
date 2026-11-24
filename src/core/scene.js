// The piece as 3D geometry, for the 3D view: ribbons, combs (or the top and
// bottom bars with pin clips), and the black box. DOM-free:
// app/view3d.js draws it with WebGL, the harness checks it.
//
// WORLD SPACE, mm: x as on the piece (the viewer's right), y UP (the top bar
// at y = H, the bottom bar at 0), z out of the wall toward the viewer, the
// ribbons' centre lines at z = 0. A ribbon at angle θ runs across from
// (x − w/2·cos θ, w/2·sin θ) to (x + w/2·cos θ, −w/2·sin θ) in (x, z), the
// same cross-section core/render.js projects, with face normal (sin θ, 0, cos θ).
//
// THE PARTS AS BUILT:
// - Combs are solid prisms, the comb's own length (core/fab.js) by its row's
//   depth (front to back, centred on the ribbons) by the sheet's thickness,
//   with tabs at the ends into the side panels. A split comb's zigzag is drawn
//   on both faces. Ribbons
//   simply pass through them: with a depth buffer the part inside a solid comb
//   is hidden, which looks exactly like a ribbon through a slot. Slot outlines
//   are drawn on both faces so the angles read.
// - With pins, the top and bottom bars are still combs; each bracket between
//   them is a pin clip (core/fab.js clipShapes): a flat T of the same sheet,
//   a narrow slotted crossbar turned to the ribbon's angle on a stem from the
//   back wall (its tab buried in the back panel). Two prisms each.
// - The box is open at the front: back, sides, top and bottom panels outside
//   the combs' ends (the combs' tabs plug into the sides) and the bars. Its
//   depth is the deepest comb's; with pins the back wall sits `standoff`
//   behind the ribbons instead.

import { slotRect, clipShapes, combLayout, combRowsOf, planDepth, BOX_WALL } from './fab.js';

export { BOX_WALL };

const RAD = Math.PI / 180;

/** A mesh under construction: flat arrays of triangle vertices and their normals. */
function mesh() { return { pos: [], nrm: [] }; }

function tri(m, a, b, c, n) {
  m.pos.push(...a, ...b, ...c);
  m.nrm.push(...n, ...n, ...n);
}

/** An axis-aligned box as 12 outward-facing triangles. */
export function addBox(m, x0, x1, y0, y1, z0, z1) {
  const P = (x, y, z) => [x, y, z];
  const quad = (a, b, c, d, n) => { tri(m, a, b, c, n); tri(m, a, c, d, n); };
  quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1]);
  quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), [0, 0, -1]);
  quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), [1, 0, 0]);
  quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), [-1, 0, 0]);
  quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), [0, 1, 0]);
  quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0]);
}

/** A triangle wound counter-clockwise seen from the side its normal points to. */
function triOut(m, a, b, c, n) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const d = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
  if (d < 0) tri(m, a, c, b, n); else tri(m, a, b, c, n);
}

/**
 * A level prism: a convex polygon in (x, z), from height y0 to y1. Top and
 * bottom are fans; each side's normal points away from the polygon's centre.
 */
export function addPrism(m, poly, y0, y1) {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const P = (q, y) => [q[0], y, q[1]];
  for (let k = 1; k + 1 < poly.length; k++) {
    triOut(m, P(poly[0], y1), P(poly[k], y1), P(poly[k + 1], y1), [0, 1, 0]);
    triOut(m, P(poly[0], y0), P(poly[k], y0), P(poly[k + 1], y0), [0, -1, 0]);
  }
  poly.forEach((q, k) => {
    const r = poly[(k + 1) % poly.length];
    let nx = r[1] - q[1], nz = -(r[0] - q[0]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    if (nx * ((q[0] + r[0]) / 2 - cx) + nz * ((q[1] + r[1]) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
    const n = [nx, 0, nz];
    triOut(m, P(q, y0), P(r, y0), P(r, y1), n);
    triOut(m, P(q, y0), P(r, y1), P(q, y1), n);
  });
}

/**
 * Where one ribbon's surface is cut: every bracket, plus enough samples in
 * each span to follow its turn (one per 2°, at most every sample). A span
 * that holds still needs no samples at all.
 * @returns {{y:number, a:number}[]}  plan y (down from the top bar), angle
 */
export function ribbonStations(plan, r) {
  const out = [];
  const { n, dy } = plan;
  for (let k = 0; k + 1 < r.knots.length; k++) {
    const A = r.knots[k], B = r.knots[k + 1];
    out.push({ y: A.y, a: A.a });
    const j0 = Math.max(0, Math.ceil(A.y / dy - 0.5 + 1e-9)), j1 = Math.min(n - 1, Math.floor(B.y / dy - 0.5 - 1e-9));
    const count = j1 - j0 + 1;
    if (count <= 0) continue;
    const segs = Math.min(count, Math.ceil(Math.abs(B.a - A.a) / 2));
    for (let m = 1; m < segs; m++) {
      const j = j0 + Math.round((m * (count - 1)) / segs);
      out.push({ y: (j + 0.5) * dy, a: r.th[j] });
    }
  }
  const last = r.knots[r.knots.length - 1];
  out.push({ y: last.y, a: last.a });
  return out;
}

/**
 * The whole scene.
 * @param {object} plan  the pipeline's plan
 * @param {object} s  settings (the plan's, with any fabrication changes since)
 * @returns {{ribbons, box, combs: {pos, nrm, center}[], clips, lines, bounds, zBack, zFront, depth}}
 *   each mesh: {pos: Float32Array, nrm: Float32Array}; lines: segment pairs
 */
export function buildScene(plan, s) {
  const H = plan.piece.H, hw = s.ribbonW / 2;
  const Y = (y) => H - y;
  const xs = plan.ribbons.map((r) => r.x);
  const D = planDepth(plan, s), t = s.combThick;
  const pins = s.hold === 'pins';
  const zFront = D / 2;
  const zBack = pins ? -Math.max(s.standoff, D / 2) : -D / 2;
  const bx0 = xs[0] - s.combEnd, bx1 = xs[xs.length - 1] + s.combEnd;

  // ribbons: a strip per ribbon, two triangles between stations
  const rib = mesh();
  for (const r of plan.ribbons) {
    const st = ribbonStations(plan, r);
    const edge = (p) => {
      const c = Math.cos(p.a * RAD), sn = Math.sin(p.a * RAD);
      return { a: [r.x - hw * c, Y(p.y), hw * sn], b: [r.x + hw * c, Y(p.y), -hw * sn], n: [sn, 0, c] };
    };
    let prev = edge(st[0]);
    for (let k = 1; k < st.length; k++) {
      const cur = edge(st[k]);
      rib.pos.push(...prev.a, ...prev.b, ...cur.b, ...prev.a, ...cur.b, ...cur.a);
      rib.nrm.push(...prev.n, ...prev.n, ...cur.n, ...prev.n, ...cur.n, ...cur.n);
      prev = cur;
    }
  }

  // combs: shared rows with combs; only the two bars with pins
  const lines = [];
  const slotLines = (x, yw, th) => {
    const q = slotRect(x, 0, th, s);
    for (const yy of [yw + t / 2 + 0.05, yw - t / 2 - 0.05]) {
      for (let k = 0; k < 4; k++) {
        const p = q[k], u = q[(k + 1) % 4];
        lines.push(p[0], yy, p[1], u[0], yy, u[1]);
      }
    }
  };
  // every comb row (with pins, the two bars): its own depth, tabs into the side panels
  const T = BOX_WALL;
  const combs = combRowsOf(plan).map((row, i) => {
    const yw = Y(row.y), lay = combLayout(xs, row.angles, s), Dr = lay.D;
    const m = mesh();
    addBox(m, bx0, bx1, yw - t / 2, yw + t / 2, -Dr / 2, Dr / 2);
    for (const [c, tw] of lay.tabs) {
      const z = c - Dr / 2;
      addBox(m, bx0 - T, bx0, yw - t / 2, yw + t / 2, z - tw / 2, z + tw / 2);
      addBox(m, bx1, bx1 + T, yw - t / 2, yw + t / 2, z - tw / 2, z + tw / 2);
    }
    xs.forEach((x, k) => slotLines(x, yw, row.angles[k]));
    for (const g of lay.zig) {
      if (g.air) continue;
      for (const yy of [yw + t / 2 + 0.05, yw - t / 2 - 0.05]) lines.push(bx0 + g.p[0], yy, g.p[1] - Dr / 2, bx0 + g.q[0], yy, g.q[1] - Dr / 2);
    }
    return { ...pack(m), center: [(bx0 + bx1) / 2, yw, 0], row: i, depth: Dr };
  });

  // a pin clip for every bracket between the bars: crossbar and stem
  const clips = mesh();
  if (pins) {
    for (const r of plan.ribbons) {
      for (let b = 1; b + 1 < r.knots.length; b++) {
        const kn = r.knots[b], yw = Y(kn.y), sh = clipShapes(kn.a, s);
        const at = (P) => P.map(([x, z]) => [r.x + x, z]);
        addPrism(clips, at(sh.bar), yw - t / 2, yw + t / 2);
        addPrism(clips, at(sh.stem), yw - t / 2, yw + t / 2);
        slotLines(r.x, yw, kn.a);
      }
    }
  }

  // the box: back, sides, top and bottom, open at the front
  const box = mesh();
  const yTop = H + t / 2, yBot = -t / 2;
  addBox(box, bx0 - T, bx1 + T, yBot - T, yTop + T, zBack - T, zBack);
  addBox(box, bx0 - T, bx0, yBot - T, yTop + T, zBack, zFront);
  addBox(box, bx1, bx1 + T, yBot - T, yTop + T, zBack, zFront);
  addBox(box, bx0, bx1, yTop, yTop + T, zBack, zFront);
  addBox(box, bx0, bx1, yBot - T, yBot, zBack, zFront);

  return {
    ribbons: pack(rib), combs, clips: pack(clips), box: pack(box), lines: new Float32Array(lines),
    bounds: { x0: bx0 - T, x1: bx1 + T, y0: yBot - T, y1: yTop + T, z0: zBack - T, z1: zFront },
    zBack, zFront, depth: D,
  };
}

const pack = (m) => ({ pos: new Float32Array(m.pos), nrm: new Float32Array(m.nrm) });
