// How a ribbon twists between two brackets, and how fast it may.
//
// THE RATE LIMIT. A ribbon twisting at κ radians per mm runs its edges along
// helices: an edge w/2 from the centre line is longer by the factor
// √(1 + (κ·w/2)²), a stretch of about ε = (κ·w/2)²/2 over the centre. The
// material takes ε up to strainPct before it overstretches, so
//
//     κmax = (2/w)·√(2ε)
//
// 0.55 % at 20 mm gives 90° per 150 mm, and the length for a turn grows with
// the width: 40 mm needs 300 mm. The limit applies to the PEAK rate in a span,
// not its average -- see below.
//
// THE TWIST BETWEEN BRACKETS. A bracket holds the ribbon's angle; between two,
// the ribbon carries one torque M down the whole span. Hanging under tension, a
// strip resists twist mostly through that tension (the trapeze effect: the
// stretched edges pull back toward the axis), plus its own shear stiffness:
//
//     k(y) = G·J + T(y)·w²/12,      J = w·t³/3,      dθ/dy = M / k(y)
//
// The tension is the bottom bar's pull plus the weight of the ribbon below:
// T(y) = T0 + λ·g·(H − y), so k falls linearly toward the bottom and the twist
// crowds into the LOWER part of every span. Integrating, with F(y) = ∫ dy/k,
//
//     θ(y) = θa + (θb − θa)·(F(y) − F(ya)) / (F(yb) − F(ya))
//
// and the peak rate, at the span's bottom where k is least, is
// |θb − θa| / (k(yb)·(F(yb) − F(ya))) -- at least the average, more the softer
// the bottom. Units: N and mm throughout (G, E in GPa = 1000 N/mm²).
//
// COILING. A twisted strip under too little tension can throw a loop (twist
// turning into writhe, like a phone cord). The rod criterion: it stays straight
// while the torque is below 2·√(B·T), B = E·w·t³/12 the bending stiffness about
// its weak axis. With a fixed bottom bar the tension never vanishes, so this is
// a check, not a design driver: `coilRisk` reports the worst ratio.

const RAD = Math.PI / 180;
export const G_ACC = 9.81;

/** The most twist per mm the edges allow, in radians. */
export const maxTwistRate = (s) => (2 / s.ribbonW) * Math.sqrt((2 * s.strainPct) / 100);

/** The same in degrees per mm. */
export const maxTwistDeg = (s) => maxTwistRate(s) / RAD;

/** The shortest length that turns a ribbon a quarter turn (white to black), mm. */
export const quarterTurnLength = (s) => (Math.PI / 2) / maxTwistRate(s);

/**
 * The twist model for ribbons H mm long.
 * @returns {{T, k, F, profile, peakRate, torque, coilRatio}}
 *   T(y)  tension, N;  k(y)  torsional stiffness, N·mm²;  F(y) = ∫₀^y ds/k
 *   profile(ya, yb, y)  share of the span's twist done by y, 0…1
 *   peakRate(ya, yb, dDeg)  the span's greatest twist rate, deg/mm
 *   coilRatio(ya, yb, dDeg)  the span's torque over the coiling torque at its bottom
 */
export function twistModel(s, H) {
  const w = s.ribbonW, t = s.thickness;
  const lambda = (s.density * w) / 1e6;                // kg per m of ribbon
  const perMm = (lambda * G_ACC) / 1000;               // N of tension per mm of ribbon below
  const T = (y) => s.tensionN + perMm * (H - y);
  const GJ = s.G * 1000 * w * t * t * t / 3;
  const B = s.E * 1000 * w * t * t * t / 12;
  const k0 = GJ + (T(0) * w * w) / 12;
  const beta = -(perMm * w * w) / 12;                  // dk/dy
  const k = (y) => k0 + beta * y;
  const linear = Math.abs((beta * H) / k0) < 1e-9;
  const F = linear ? (y) => y / k0 : (y) => Math.log(k(y) / k0) / beta;
  const profile = (ya, yb, y) => {
    const d = F(yb) - F(ya);
    return d > 0 ? (F(y) - F(ya)) / d : 0;
  };
  const peakRate = (ya, yb, dDeg) => {
    const d = F(yb) - F(ya);
    return d > 0 ? Math.abs(dDeg) / (k(yb) * d) : (dDeg ? Infinity : 0);
  };
  const torque = (ya, yb, dDeg) => {
    const d = F(yb) - F(ya);
    return d > 0 ? (Math.abs(dDeg) * RAD) / d : 0;
  };
  const coilRatio = (ya, yb, dDeg) => torque(ya, yb, dDeg) / (2 * Math.sqrt(B * Math.max(1e-12, T(yb))));
  return { T, k, F, profile, peakRate, torque, coilRatio, k0, beta };
}
