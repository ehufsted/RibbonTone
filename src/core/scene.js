// The piece as 3D geometry, for the 3D view: ribbons, combs (or the top and
// bottom bars with pin tabs and stand-off rods), and the black box. DOM-free:
// app/view3d.js draws it with WebGL, the harness checks it.
//
// WORLD SPACE, mm: x as on the piece (the viewer's right), y UP (the top bar
// at y = H, the bottom bar at 0), z out of the wall toward the viewer, the
// ribbons' centre lines at z = 0. A ribbon at angle θ runs across from
// (x − w/2·cos θ, w/2·sin θ) to (x + w/2·cos θ, −w/2·sin θ) in (x, z), the
// same cross-section core/render.js projects, with face normal (sin θ, 0, cos θ).
//
// THE PARTS AS BUILT:
// - Combs are solid prisms, the comb's own length (core/fab.js) by its depth
//   (front to back, centred on the ribbons) by the sheet's thickness. Ribbons
//   simply pass through them: with a depth buffer the part inside a solid comb
//   is hidden, which looks exactly like a ribbon through a slot. Slot outlines
//   are drawn on both faces so the angles read.
// - With pins, the top and bottom bars are still combs; each bracket between
//   them is a pin tab (a one-slot comb, square) on a stand-off rod from the
//   back wall to the tab's back edge.
// - The box is open at the front: back, sides, top and bottom panels outside
//   the combs' ends (the combs mount to the sides) and the bars. Its depth is
//   the combs' depth; with pins the back wall sits `standoff` behind the
//   ribbons instead.

import { combDepth, slotRect } from './fab.js';

const RAD = Math.PI / 180;
export const BOX_WALL = 6;   // mm, the box's panels
export const ROD_R = 2;      // mm, pin stand-off rods

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

/** A cylinder along z from z0 to z1 (open ends: the wall and the tab cover them). */
function addRod(m, x, y, z0, z1, r, sides = 10) {
  for (let k = 0; k < sides; k++) {
    const a = (2 * Math.PI * k) / sides, b = (2 * Math.PI * (k + 1)) / sides, mid = (a + b) / 2;
    const n = [Math.cos(mid), Math.sin(mid), 0];
    const pa = [x + r * Math.cos(a), y + r * Math.sin(a)], pb = [x + r * Math.cos(b), y + r * Math.sin(b)];
    tri(m, [pa[0], pa[1], z0], [pb[0], pb[1], z0], [pb[0], pb[1], z1], n);
    tri(m, [pa[0], pa[1], z0], [pb[0], pb[1], z1], [pa[0], pa[1], z1], n);
  }
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
 * @returns {{ribbons, box, combs: {pos, nrm, center}[], tabs, rods, lines, bounds, zBack, zFront, depth}}
 *   each mesh: {pos: Float32Array, nrm: Float32Array}; lines: segment pairs
 */
export function buildScene(plan, s) {
  const H = plan.piece.H, hw = s.ribbonW / 2;
  const Y = (y) => H - y;
  const xs = plan.ribbons.map((r) => r.x);
  const D = combDepth(s), t = s.combThick;
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
  // each row picks one knot per ribbon (with per-ribbon heights only the bars line up)
  const top = (r) => r.knots[0], bottom = (r) => r.knots[r.knots.length - 1];
  const rows = pins || !plan.rows ? [top, bottom] : plan.rows.map((_, k) => (r) => r.knots[k]);
  const combs = rows.map((pick, i) => {
    const yw = Y(pick(plan.ribbons[0]).y);
    const m = mesh();
    addBox(m, bx0, bx1, yw - t / 2, yw + t / 2, -D / 2, D / 2);
    plan.ribbons.forEach((r) => slotLines(r.x, yw, pick(r).a));
    return { ...pack(m), center: [(bx0 + bx1) / 2, yw, 0], row: i };
  });

  // pin tabs and rods for every bracket between the bars
  const tabs = mesh(), rods = mesh();
  if (pins) {
    const half = D / 2;
    for (const r of plan.ribbons) {
      for (let b = 1; b + 1 < r.knots.length; b++) {
        const kn = r.knots[b], yw = Y(kn.y);
        addBox(tabs, r.x - half, r.x + half, yw - t / 2, yw + t / 2, -half, half);
        if (zBack < -half) addRod(rods, r.x, yw, zBack, -half, ROD_R);
        slotLines(r.x, yw, kn.a);
      }
    }
  }

  // the box: back, sides, top and bottom, open at the front
  const box = mesh();
  const T = BOX_WALL;
  const yTop = H + t / 2, yBot = -t / 2;
  addBox(box, bx0 - T, bx1 + T, yBot - T, yTop + T, zBack - T, zBack);
  addBox(box, bx0 - T, bx0, yBot - T, yTop + T, zBack, zFront);
  addBox(box, bx1, bx1 + T, yBot - T, yTop + T, zBack, zFront);
  addBox(box, bx0, bx1, yTop, yTop + T, zBack, zFront);
  addBox(box, bx0, bx1, yBot - T, yBot, zBack, zFront);

  return {
    ribbons: pack(rib), combs, tabs: pack(tabs), rods: pack(rods), box: pack(box), lines: new Float32Array(lines),
    bounds: { x0: bx0 - T, x1: bx1 + T, y0: yBot - T, y1: yTop + T, z0: zBack - T, z1: zFront },
    zBack, zFront, depth: D,
  };
}

const pack = (m) => ({ pos: new Float32Array(m.pos), nrm: new Float32Array(m.nrm) });
