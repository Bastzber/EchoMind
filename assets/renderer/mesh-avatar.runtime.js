(function(){
/*! fflate
MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const te = (a, e, t) => {
  (typeof a != "number" || !Number.isFinite(a)) && t.push(`${e}: expected a finite number`);
}, Ee = (a, e, t) => {
  te(a, e, t), typeof a == "number" && a <= 0 && t.push(`${e}: must be positive`);
}, ye = (a, e, t) => {
  Ee(a, e, t), typeof a == "number" && !Number.isInteger(a) && t.push(`${e}: expected an integer`);
}, Fe = (a, e, t) => {
  te(a, e, t), typeof a == "number" && !Number.isInteger(a) && t.push(`${e}: expected an integer`);
}, gt = (a, e, t) => {
  (typeof a != "string" || !a.trim()) && t.push(`${e}: expected a non-empty string`);
}, me = (a, e = 0, t = 1 / 0) => (r, s, i) => {
  if (!Array.isArray(r)) {
    i.push(`${s}: expected an array`);
    return;
  }
  (r.length < e || r.length > t) && i.push(`${s}: expected ${e}..${t} items`), r.forEach((c, m) => a(c, `${s}[${m}]`, i));
}, pe = me(te, 2, 2), oe = (a, e, t) => {
  pe(a, e, t), Array.isArray(a) && a.length === 2 && a[0] >= a[1] && t.push(`${e}: start must be less than end`);
}, se = (a, e = []) => (t, r, s) => {
  if (!t || typeof t != "object" || Array.isArray(t)) {
    s.push(`${r}: expected an object`);
    return;
  }
  const i = t;
  for (const [c, m] of Object.entries(a))
    i[c] === void 0 && e.includes(c) || m(i[c], `${r}.${c}`, s);
}, Ye = { cx: te, cy: te, rx: Ee, ry: Ee }, de = se(Ye), Ce = me(pe, 3), yt = me(pe, 2), He = (a, e, t) => {
  te(a, e, t), typeof a == "number" && (a < 0 || a > 1) && t.push(`${e}: must be between 0 and 1`);
}, Wt = (a) => se({
  version: (e, t, r) => {
    e !== 1 && r.push(`${t}: only version 1 is supported`);
  },
  image: se({ width: ye, height: ye }),
  head: se({
    ...Ye,
    shiftX: te,
    shiftY: te,
    pivotX: te,
    pivotY: te,
    maxRoll: te,
    weightBand: oe,
    turnBand: oe
  }),
  body: se({
    pivotX: te,
    pivotY: te,
    maxRoll: te,
    breathBand: oe,
    rollBand: oe,
    chest: de,
    shoulders: me(de)
  }),
  face: se({
    nose: de,
    mouth: de,
    eyeA: de,
    eyeB: de,
    earL: de,
    earR: de,
    brow: se({ ...Ye, band: oe }),
    jaw: se({ ...Ye, band: oe })
  }),
  buns: se({ bunL: de, bunR: de }, ["bunL", "bunR"]),
  eyes: me(se({
    opening: Ce,
    roi: Ce,
    x0: te,
    x1: te,
    top: me(te, 24, 24),
    bot: me(te, 24, 24)
  }, a ? ["x0", "x1", "top", "bot"] : []), 2, 2),
  mouth: se({
    cx: te,
    cy: te,
    angle: te,
    halfLen: Ee,
    bow: te,
    area: se({ ...Ye, angle: te })
  }),
  cheeks: me(pe, 2, 2),
  strands: me(se({ name: gt, nodes: yt, sigma: Ee, k: Ee, max: Ee })),
  accessories: me(se({
    name: gt,
    pivot: pe,
    tip: pe,
    split: He,
    box: me(Fe, 4, 4),
    color: se({ redness: He, minRed: te })
  })),
  hand: se({
    outline: Ce,
    jaw: yt,
    jawRange: oe,
    background: Ce,
    elbow: pe,
    wrist: pe,
    knuckle: pe,
    contact: pe,
    forearmShare: He,
    armBand: oe,
    wristBand: oe,
    handBand: oe,
    fingerXBand: oe,
    fingerYBand: oe,
    pinBand: oe
  }),
  mesh: se({
    baseCell: ye,
    fine: se({
      x0: Fe,
      x1: Fe,
      y0: Fe,
      y1: Fe,
      cell: ye
    }),
    handCell: ye,
    tasselCell: ye,
    eyeBallCell: ye,
    eyeCell: ye,
    spriteCell: ye
  }),
  view: se({ padTop: te, padSide: te, gazeCenter: pe }, ["gazeCenter"])
}, ["buns", "strands", "accessories", "hand"]);
function _t(a, e = {}) {
  const t = [];
  if (Wt(e.draft ?? !1)(a, "rig", t), t.length) return t;
  const r = a;
  r.eyes.forEach((s, i) => {
    const c = ["x0", "x1", "top", "bot"];
    if (!(e.draft && c.every((m) => s[m] === void 0))) {
      if (c.some((m) => s[m] === void 0)) {
        t.push(`rig.eyes[${i}]: supply all x0/x1/top/bot fields or omit all in a draft`);
        return;
      }
      s.x0 >= s.x1 && t.push(`rig.eyes[${i}].x1: must exceed x0`), s.top.some((m, E) => m > s.bot[E]) && t.push(`rig.eyes[${i}].top: must not exceed bottom curve`);
    }
  }), (r.mesh.fine.x0 >= r.mesh.fine.x1 || r.mesh.fine.y0 >= r.mesh.fine.y1) && t.push("rig.mesh.fine: rectangle must have positive area"), (r.view.padTop <= -1 || r.view.padTop >= 1 || r.view.padSide <= -0.5) && t.push("rig.view: margins must leave a positive viewport");
  for (const [s, i] of (r.strands ?? []).entries())
    i.nodes.some((c, m) => m > 0 && c[0] === i.nodes[m - 1][0] && c[1] === i.nodes[m - 1][1]) && t.push(`rig.strands[${s}].nodes: consecutive nodes must differ`);
  for (const [s, i] of (r.accessories ?? []).entries())
    (i.box[0] < 0 || i.box[1] < 0 || i.box[2] > r.image.width || i.box[3] > r.image.height) && t.push(`rig.accessories[${s}].box: rectangle must stay inside the image`), (i.split <= 0 || i.split >= 1) && t.push(`rig.accessories[${s}].split: must be strictly between 0 and 1`), i.pivot.every((c, m) => c === i.tip[m]) && t.push(`rig.accessories[${s}].tip: must differ from pivot`), (i.box[0] >= i.box[2] || i.box[1] >= i.box[3]) && t.push(`rig.accessories[${s}].box: rectangle must have positive area`);
  return t;
}
function it(a) {
  const e = _t(a);
  if (e.length) throw new Error(`Invalid rig:
${e.join(`
`)}`);
  return structuredClone(a);
}
const ze = [
  { id: "angleX", label: "Face angle X", min: -30, max: 30, def: 0, group: "Head and body" },
  { id: "angleY", label: "Face angle Y", min: -30, max: 30, def: 0, group: "Head and body" },
  { id: "angleZ", label: "Face roll", min: -30, max: 30, def: 0, group: "Head and body" },
  { id: "bodyAngleX", label: "Body angle X", min: -10, max: 10, def: 0, group: "Head and body" },
  { id: "bodyAngleZ", label: "Body roll", min: -10, max: 10, def: 0, group: "Head and body" },
  { id: "breath", label: "Breath", min: 0, max: 1, def: 0, group: "Head and body" },
  { id: "eyeLOpen", label: "Left eye open", min: 0, max: 1.25, def: 1, group: "Eyes and brows" },
  { id: "eyeROpen", label: "Right eye open", min: 0, max: 1.25, def: 1, group: "Eyes and brows" },
  { id: "eyeSmile", label: "Eye smile", min: 0, max: 1, def: 0, group: "Eyes and brows" },
  { id: "gazeX", label: "Gaze X", min: -1, max: 1, def: 0, group: "Eyes and brows" },
  { id: "gazeY", label: "Gaze Y", min: -1, max: 1, def: 0, group: "Eyes and brows" },
  { id: "browY", label: "Brow Y", min: -1, max: 1, def: 0, group: "Eyes and brows" },
  { id: "browAngle", label: "Brow angle", min: -1, max: 1, def: 0, group: "Eyes and brows" },
  { id: "mouthOpen", label: "Mouth open", min: 0, max: 1, def: 0, group: "Mouth and cheeks" },
  { id: "mouthForm", label: "Mouth form (i to o)", min: -1, max: 1, def: 0, group: "Mouth and cheeks" },
  { id: "blush", label: "Blush", min: 0, max: 1, def: 0, group: "Mouth and cheeks" },
  { id: "armAngle", label: "Arm angle", min: -10, max: 10, def: 0, group: "Hand" },
  { id: "handAngle", label: "Wrist angle", min: -10, max: 10, def: 0, group: "Hand" },
  { id: "fingerTap", label: "Finger tap", min: 0, max: 1, def: 0, group: "Hand" }
];
function Gt(a) {
  const e = { w: a.image.width, h: a.image.height }, t = (b, w, A) => A ? Math.exp(-(((b - A.cx) / A.rx) ** 2 + ((w - A.cy) / A.ry) ** 2)) : 0, r = 24, s = a.eyes;
  function i(b, w) {
    const A = Math.min(1, Math.max(0, w)) * (r - 1), T = Math.min(Math.floor(A), r - 2), F = A - T;
    return b[T] + (b[T + 1] - b[T]) * F;
  }
  function c(b, w, A, T) {
    w = Math.min(1, Math.max(0, w));
    const F = i(b.top, w), X = i(b.bot, w), k = 1 - A, $ = 4 * w * (1 - w), p = i(b.bot, 0.5) - i(b.top, 0.5), R = b.top[0] + (b.top[r - 1] - b.top[0]) * w - 0.3 * p * $, z = Math.max(F, X + 1 + (R - X - 1) * T);
    return [(z - F) * Math.max(k, -0.07), k > 0 ? (z - X) * k * T : 0];
  }
  const m = [[-2, 1], [-1, 2], [0, 3], [1, 2], [2, 1]], E = 5;
  function v(b, w, A, T) {
    let F = 0, X = 0;
    for (const [R, z] of m) {
      const [K, Q] = c(b, (w + R * E - b.x0) / (b.x1 - b.x0), A, T);
      F += K * z / 9, X += Q * z / 9;
    }
    const k = Math.min(1, Math.max(0, (w - b.x0) / (b.x1 - b.x0))), $ = i(b.top, k), p = i(b.bot, k);
    return { top: $, bot: p, b: 1 - A, lid: $ + F, bc: p + X };
  }
  function M(b, w, A, T, F, X) {
    const k = v(b, A, F, X);
    return w === "lash" ? k.lid - (k.top - T) * (1 - 0.3 * Math.min(1, Math.max(0, k.b))) : w === "low" ? T + (k.bc - k.bot) : w === "crease" ? T + (k.lid - k.top) * 0.22 : T;
  }
  function u(b, w, A) {
    const T = Math.min(1, Math.max(0, 1 - w));
    return b === "low" ? 1 - Math.min(1, T * A * 1.2) : b === "crease" ? 1 - 0.45 * T : 1;
  }
  const x = a.mouth, S = a.cheeks, y = a.head, h = a.body, l = (b, w, A) => {
    const T = Math.min(1, Math.max(0, (A - b) / (w - b)));
    return T * T * (3 - 2 * T);
  };
  function d(b, w) {
    return 1 - l(...y.weightBand, w);
  }
  function n(b, w) {
    return 1 - l(...y.turnBand, w);
  }
  const o = a.strands ?? [];
  function L(b, w, A) {
    let T = 1 / 0, F = 0;
    const X = A.length - 1;
    for (let k = 0; k < X; k++) {
      const [$, p] = A[k], [R, z] = A[k + 1], K = R - $, Q = z - p, re = Math.min(1, Math.max(0, ((b - $) * K + (w - p) * Q) / (K * K + Q * Q))), ie = Math.hypot(b - $ - K * re, w - p - Q * re);
      ie < T && (T = ie, F = (k + re) / X);
    }
    return [T, F];
  }
  function f(b, w, A) {
    if (A < 0.02) return [];
    const T = [];
    let F = 0;
    o.forEach((k, $) => {
      const [p, R] = L(b, w, k.nodes), z = Math.exp(-((p / k.sigma) ** 2));
      z < 0.02 || (T.push([$, z, R]), F += z);
    });
    const X = Math.max(1, F);
    return T.map(([k, $, p]) => [k, A * $ / X * l(0.04, 0.55, p), p]);
  }
  function g(b, w, A = 1) {
    return {
      head: d(b, w),
      turn: n(b, w),
      strands: f(b, w, A),
      bunL: t(b, w, a.buns?.bunL),
      bunR: t(b, w, a.buns?.bunR),
      brow: t(b, w, a.face.brow) * (1 - l(...a.face.brow.band, w)),
      // chin below the mouth line drops a little when the mouth opens
      jaw: t(b, w, a.face.jaw) * l(...a.face.jaw.band, w),
      // per-feature depth for head turns (nose sticks out most, ears sit at the back)
      nose: t(b, w, a.face.nose),
      mouth: t(b, w, a.face.mouth),
      eyeA: t(b, w, a.face.eyeA),
      eyeB: t(b, w, a.face.eyeB),
      earR: t(b, w, a.face.earR),
      earL: t(b, w, a.face.earL),
      chest: t(b, w, h.chest),
      breath: 1 - l(...h.breathBand, w),
      shoulder: h.shoulders.reduce((T, F) => T + t(b, w, F), 0)
    };
  }
  function B(b, w, A, T) {
    const F = (b - y.cx) / y.rx, X = (w - y.cy) / y.ry, k = 1 - F * F - X * X;
    if (k <= 0) return [0, 0];
    const $ = l(0, 0.84, k);
    return [A * y.shiftX * $, -T * y.shiftY * $];
  }
  function U(b, w, A, T) {
    const F = Math.cos(T), X = Math.sin(T), k = b[0] - w, $ = b[1] - A;
    b[0] = w + k * F - $ * X, b[1] = A + k * X + $ * F;
  }
  function D(b, w, A, T = w) {
    const F = B(b[0], b[1], A.angleX / 30, A.angleY / 30);
    b[0] += F[0] * T, b[1] += F[1] * T, !(w <= 0) && U(b, y.pivotX, y.pivotY, -A.angleZ / 30 * y.maxRoll * w);
  }
  function _(b, w, A, T = 0, F = 1, X = 0) {
    const k = A.breath;
    b[1] -= k * (5 * F + 4 * X), b[0] += (b[0] - h.chest.cx) * 0.012 * k * T, b[0] += A.bodyAngleX / 10 * (7 + 9 * T), U(b, h.pivotX, h.pivotY, -A.bodyAngleZ / 10 * h.maxRoll * (1 - l(...h.rollBand, w)));
  }
  function P(b, w, A, T, F, X) {
    const k = X;
    k[0] = b, k[1] = w;
    const $ = F.gain;
    for (const [z, K, Q] of A.strands) {
      const re = F.strands?.[z];
      if (!re) continue;
      const ie = Q * 3, ne = Math.min(2, Math.floor(ie)), ve = ie - ne;
      k[0] += (re[ne][0] + (re[ne + 1][0] - re[ne][0]) * ve) * K * $, k[1] += (re[ne][1] + (re[ne + 1][1] - re[ne][1]) * ve) * K * $;
    }
    if (k[0] += (F.bunL[0] * A.bunL + F.bunR[0] * A.bunR) * $, k[1] += (F.bunL[1] * A.bunL + F.bunR[1] * A.bunR) * $, k[1] -= T.browY * 7 * A.brow, A.brow > 0.01) {
      const z = T.browAngle * 0.12 * A.brow;
      k[1] += (b - a.face.brow.cx) * Math.sin(z);
    }
    k[1] += T.mouthOpen * 3.5 * A.jaw;
    const p = T.angleX / 30, R = T.angleY / 30;
    return k[0] += p * (8 * A.nose + 5 * A.mouth) + (b - a.face.eyeA.cx) * 0.12 * p * A.eyeA - (b - a.face.eyeB.cx) * 0.12 * p * A.eyeB - p * 9 * A.earR + p * 4 * A.earL - p * 10 * (A.bunL + A.bunR), k[1] -= R * (6 * A.nose + 3 * A.mouth), k[1] += (w - a.face.eyeA.cy) * -0.06 * Math.abs(R) * A.eyeA + (w - a.face.eyeB.cy) * -0.06 * Math.abs(R) * A.eyeB, D(k, A.head, T, A.turn), _(k, w, T, A.chest, A.breath, A.shoulder), k;
  }
  const O = a.hand, j = O?.elbow ?? [0, 0], I = O?.wrist ?? [0, 0], q = O?.knuckle ?? [0, 0], N = O?.contact ?? [0, 0], Z = O?.forearmShare ?? 0;
  function H(b, w) {
    return O ? {
      arm: 1 - l(...O.armBand, w),
      wrist: 1 - l(...O.wristBand, w),
      hand: 1 - l(...O.handBand, w),
      finger: l(...O.fingerXBand, b) * (1 - l(...O.fingerYBand, w)),
      pinBottom: l(...O.pinBand, w)
    } : { arm: 0, wrist: 0, hand: 0, finger: 0, pinBottom: 0 };
  }
  const J = (b, w, A, T) => {
    const F = b[0] - w[0], X = b[1] - w[1];
    return [w[0] + F * A - X * T, w[1] + F * T + X * A];
  }, C = (b) => Math.atan2(b[1], b[0]);
  function V(b) {
    const w = [...N];
    D(w, d(...N), b, n(...N)), _(w, N[1], b, 0, 1, 0);
    const A = [...j];
    _(A, j[1], b, 0, 0, 0);
    const T = (C([w[0] - A[0], w[1] - A[1]]) - C([N[0] - j[0], N[1] - j[1]])) * Z, F = Math.cos(T), X = Math.sin(T), k = (K) => {
      const Q = J(K, j, F, X);
      return [Q[0] + A[0] - j[0], Q[1] + A[1] - j[1]];
    }, $ = k(I), p = k(N), R = C([w[0] - $[0], w[1] - $[1]]) - C([p[0] - $[0], p[1] - $[1]]), z = Math.min(1.03, Math.max(0.97, Math.hypot(w[0] - $[0], w[1] - $[1]) / Math.hypot(p[0] - $[0], p[1] - $[1])));
    return { tr: k, w: $, b: R, k: z };
  }
  function Y(b, w, A, T, F, X) {
    let k = [b, w];
    k = J(k, q, Math.cos(T.fingerTap * 0.07 * A.finger), Math.sin(T.fingerTap * 0.07 * A.finger));
    const $ = -T.handAngle / 10 * 0.045 * A.wrist, p = -T.armAngle / 10 * 0.015 * A.arm;
    k = J(k, I, Math.cos($), Math.sin($)), k = J(k, j, Math.cos(p), Math.sin(p)), k = F.tr(k);
    const R = F.b * A.hand, z = 1 + (F.k - 1) * A.hand;
    return k = J(k, F.w, Math.cos(R) * z, Math.sin(R) * z), k[1] += (w - k[1]) * A.pinBottom, X[0] = k[0], X[1] = k[1], X;
  }
  const W = a.accessories ?? [];
  function ee(b, w, A, T) {
    const F = g(b.pivot[0], b.pivot[1]);
    return P(b.pivot[0], b.pivot[1], F, w, A, T);
  }
  return { IMG: e, EYES: s, MOUTH: x, CHEEKS: S, STRANDS: o, TASSELS: W, headWeight: d, turnWeight: n, baseWeights: g, deformBase: P, applyHead: D, applyBody: _, handWeights: H, handFrame: V, deformHand: Y, eyePartY: M, eyePartAlpha: u, tasselAnchor: ee };
}
function Vt(a, e, t, r = !1) {
  const s = r ? Math.max(e, t) * 2 : 1, i = new Float32Array(a.length), c = Math.SQRT2;
  for (let m = 0; m < t; m++) for (let E = 0; E < e; E++) {
    const v = m * e + E;
    a[v] <= 3 || (i[v] = Math.min(
      E ? i[v - 1] + 1 : s,
      m ? i[v - e] + 1 : s,
      E && m ? i[v - e - 1] + c : s,
      m && E + 1 < e ? i[v - e + 1] + c : s
    ));
  }
  for (let m = t - 1; m >= 0; m--) for (let E = e - 1; E >= 0; E--) {
    const v = m * e + E;
    !a[v] || a[v] <= 3 || (i[v] = Math.min(
      i[v],
      E + 1 < e ? i[v + 1] + 1 : s,
      m + 1 < t ? i[v + e] + 1 : s,
      E && m + 1 < t ? i[v + e - 1] + c : s,
      E + 1 < e && m + 1 < t ? i[v + e + 1] + c : s
    ));
  }
  return i;
}
function We(a, e, t) {
  return Math.exp(-(((a - t.cx) / t.rx) ** 2 + ((e - t.cy) / t.ry) ** 2));
}
function qt(a, e, t) {
  const r = ((a - t.head.cx) / t.head.rx) ** 2 + ((e - t.head.cy) / t.head.ry) ** 2;
  let s = t.head.rx * 0.8 * Math.sqrt(Math.max(0, 1 - r)) + t.body.chest.rx * 0.23 * We(a, e, t.body.chest);
  s += t.face.nose.rx * 0.2 * We(a, e, t.face.nose);
  for (const [i, c] of t.cheeks) s += t.head.rx * 0.012 * We(a, e, { cx: i, cy: c, rx: t.head.rx * 0.3, ry: t.head.ry * 0.16 });
  return s;
}
function Ze(a, e, t, r) {
  const s = new Float32Array(a.length), i = new Float32Array(a.length), c = (m, E, v, M, u, x) => {
    for (let S = 0; S < M; S++) {
      const y = S * x;
      let h = 0, l = 0;
      for (let d = 0; d < Math.min(r, v - 1) + 1; d++)
        h += m[y + d * u], l++;
      for (let d = 0; d < v; d++) {
        E[y + d * u] = h / l;
        const n = d + r + 1, o = d - r;
        n < v && (h += m[y + n * u], l++), o >= 0 && (h -= m[y + o * u], l--);
      }
    }
  };
  return c(a, s, e, t, 1, e), c(s, i, t, e, e, 1), i;
}
function Jt(a, e, t, r) {
  const s = Ze(a, t, r, 1), i = Ze(a, t, r, 6), c = new Float32Array(a.length);
  for (let v = 0; v < c.length; v++) c[v] = e[v] > 128 ? s[v] - i[v] : 0;
  const m = new Float32Array(a.length * 2), E = (v, M) => c[Math.max(0, Math.min(r - 1, M)) * t + Math.max(0, Math.min(t - 1, v))];
  for (let v = 0; v < r; v++) for (let M = 0; M < t; M++) {
    const u = v * t + M;
    e[u] <= 128 || (m[2 * u] = Math.max(-1, Math.min(1, -(E(M + 1, v) - E(M - 1, v)) * 4)), m[2 * u + 1] = Math.max(-1, Math.min(1, -(E(M, v + 1) - E(M, v - 1)) * 4)));
  }
  return m;
}
function Kt(a, e, t, r, s, i = !0, c) {
  const m = !!s && r[0] === 0 && r[1] === 0 && r[2] === s.image.width && r[3] === s.image.height, E = Vt(a, e, t, m), v = new Float32Array(a.length), M = r[2] / e, u = r[3] / t, x = Math.min(M, u), S = Math.min(r[2], r[3]) * 0.08;
  for (let n = 0; n < t; n++) for (let o = 0; o < e; o++) {
    const L = n * e + o;
    v[L] = (i ? Math.sqrt(E[L] * x * S) * 0.55 : 0) + (s ? qt(r[0] + (o + 0.5) * M, r[1] + (n + 0.5) * u, s) : 0);
  }
  const y = Math.max(1, Math.round(Math.min(e, t) * 0.02));
  v.set(Ze(Ze(v, e, t, y), e, t, y));
  const h = c ? Jt(c, a, e, t) : null, l = new Uint8Array(e * t * 4), d = (n, o) => v[Math.max(0, Math.min(t - 1, o)) * e + Math.max(0, Math.min(e - 1, n))];
  for (let n = 0; n < t; n++) for (let o = 0; o < e; o++) {
    const L = -(d(o + 2, n) - d(o - 2, n)) / (4 * M), f = -(d(o, n + 2) - d(o, n - 2)) / (4 * u), g = Math.hypot(L, f, 1), B = (n * e + o) * 4, U = n * e + o;
    l[B] = Math.round((L / g * 0.5 + 0.5) * 255), l[B + 1] = Math.round((f / g * 0.5 + 0.5) * 255), l[B + 2] = Math.round(((h?.[2 * U] ?? 0) * 0.5 + 0.5) * 255), l[B + 3] = Math.round(((h?.[2 * U + 1] ?? 0) * 0.5 + 0.5) * 255);
  }
  return l;
}
const bt = /* @__PURE__ */ new WeakMap();
function Qt(a, e, t, r) {
  const s = JSON.stringify([e, t.head, t.body.chest, t.face.nose, t.cheeks, r]), i = bt.get(a);
  if (i?.key === s) return { ...i, computed: !1, ms: 0 };
  const c = performance.now(), m = Math.min(1, 512 / Math.max(a.width, a.height)), E = Math.max(1, Math.round(a.width * m)), v = Math.max(1, Math.round(a.height * m)), M = document.createElement("canvas");
  M.width = E, M.height = v;
  const u = M.getContext("2d", { willReadFrequently: !0 });
  u.drawImage(a, 0, 0, E, v);
  const x = u.getImageData(0, 0, E, v).data, S = new Uint8Array(E * v), y = new Float32Array(E * v);
  for (let l = 0; l < S.length; l++)
    S[l] = x[4 * l + 3], y[l] = (0.2126 * x[4 * l] + 0.7152 * x[4 * l + 1] + 0.0722 * x[4 * l + 2]) / 255;
  const h = { key: s, data: Kt(S, E, v, e, t, r, r ? y : void 0), width: E, height: v };
  return bt.set(a, h), { ...h, computed: !0, ms: performance.now() - c };
}
const ke = Object.freeze({
  enabled: !1,
  x: 0.2,
  y: 0.2,
  z: 0.45,
  color: 16777215,
  strength: 0.8,
  intensity: 0.8,
  ambient: 0.4,
  mode: "soft",
  shadow: !1,
  reach: 1.2,
  ambientColor: 15659256,
  softness: 0.45,
  specular: 0.12,
  rim: 0.3,
  detail: 0.4
}), vt = {
  x: [0, 1],
  y: [0, 1],
  z: [0.1, 2],
  color: [0, 16777215],
  strength: [0, 1],
  intensity: [0, 2],
  ambient: [0, 1],
  reach: [0.2, 3],
  ambientColor: [0, 16777215],
  softness: [0, 1],
  specular: [0, 1],
  rim: [0, 1],
  detail: [0, 1]
}, ea = /* @__PURE__ */ new Set(["color", "ambientColor"]);
function ta(a) {
  if (!a || typeof a != "object" || Array.isArray(a)) return null;
  const e = a;
  if (Object.keys(e).length !== Object.keys(ke).length || Object.keys(e).some((r) => !(r in ke)) || ![!0, !1].includes(e.enabled) || ![!0, !1].includes(e.shadow) || !["soft", "cel"].includes(e.mode)) return null;
  const t = { ...ke, enabled: e.enabled, shadow: e.shadow, mode: e.mode };
  for (const r of Object.keys(vt)) {
    const s = e[r], [i, c] = vt[r];
    if (typeof s != "number" || !Number.isFinite(s) || ea.has(r) && !Number.isInteger(s)) return null;
    t[r] = Math.max(i, Math.min(c, s));
  }
  return t;
}
const Ne = -0.1, aa = 0.9, ra = 1, na = 1.06;
function sa(a, e) {
  return [(0.5 - a) * 0.12, (0.5 - e) * 0.12];
}
function ia(a, e, t, r) {
  const s = a * Math.PI / 180, i = e * Math.PI / 180, c = -t / 30 * r, m = Math.cos(s), E = Math.sin(s), v = Math.cos(i), M = Math.sin(i), u = Math.cos(c), x = Math.sin(c);
  return [
    u * m,
    x * m,
    -E,
    u * E * M - x * v,
    x * E * M + u * v,
    m * M,
    u * E * v + x * M,
    x * E * v - u * M,
    m * v
  ];
}
class oa {
  constructor(e, t) {
    this.gl = e, this.program = t(e, `#version 300 es
      out vec2 vUv;
      void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`, `#version 300 es
      precision highp float; in vec2 vUv; out vec4 o;
      uniform sampler2D uTex; uniform vec2 uStep; uniform vec2 uShift; uniform int uPass;
      float alphaAt(vec2 p) { if (any(lessThan(p, vec2(0))) || any(greaterThan(p, vec2(1)))) return 0.0; return texture(uTex, p).a; }
      void main() {
        if (uPass == 2) { o = texture(uTex, vUv); return; }
        vec2 p = vUv - uShift;
        float a = alphaAt(p) * 0.227027;
        a += (alphaAt(p + uStep * 1.384615) + alphaAt(p - uStep * 1.384615)) * 0.316216;
        a += (alphaAt(p + uStep * 3.230769) + alphaAt(p - uStep * 3.230769)) * 0.070270;
        o = uPass == 0 ? vec4(0, 0, 0, a) : vec4(vec3(0.035, 0.045, 0.065) * a * 0.28, a * 0.28);
      }`), this.vao = e.createVertexArray(), this.targets = [];
  }
  target(e, t) {
    const r = this.gl, s = r.createTexture(), i = r.createFramebuffer();
    if (r.bindTexture(r.TEXTURE_2D, s), r.texImage2D(r.TEXTURE_2D, 0, r.RGBA, e, t, 0, r.RGBA, r.UNSIGNED_BYTE, null), r.texParameteri(r.TEXTURE_2D, r.TEXTURE_MIN_FILTER, r.LINEAR), r.texParameteri(r.TEXTURE_2D, r.TEXTURE_MAG_FILTER, r.LINEAR), r.texParameteri(r.TEXTURE_2D, r.TEXTURE_WRAP_S, r.CLAMP_TO_EDGE), r.texParameteri(r.TEXTURE_2D, r.TEXTURE_WRAP_T, r.CLAMP_TO_EDGE), r.bindFramebuffer(r.FRAMEBUFFER, i), r.framebufferTexture2D(r.FRAMEBUFFER, r.COLOR_ATTACHMENT0, r.TEXTURE_2D, s, 0), r.checkFramebufferStatus(r.FRAMEBUFFER) !== r.FRAMEBUFFER_COMPLETE) throw new Error("Shadow framebuffer unavailable");
    return { texture: s, framebuffer: i };
  }
  begin(e, t) {
    const r = this.gl;
    (this.width !== e || this.height !== t) && (this.clearTargets(), this.width = e, this.height = t, this.targets = [this.target(e, t), this.target(Math.ceil(e / 2), Math.ceil(t / 2))]), r.bindFramebuffer(r.FRAMEBUFFER, this.targets[0].framebuffer), r.viewport(0, 0, e, t), r.clearColor(0, 0, 0, 0), r.clear(r.COLOR_BUFFER_BIT);
  }
  composite(e) {
    const t = this.gl, { prog: r, u: s } = this.program, i = this.width, c = this.height;
    t.useProgram(r), t.bindVertexArray(this.vao), t.activeTexture(t.TEXTURE0), t.uniform1i(s.uTex, 0), t.disable(t.BLEND), t.bindFramebuffer(t.FRAMEBUFFER, this.targets[1].framebuffer), t.viewport(0, 0, Math.ceil(i / 2), Math.ceil(c / 2)), t.bindTexture(t.TEXTURE_2D, this.targets[0].texture), t.uniform1i(s.uPass, 0), t.uniform2f(s.uShift, 0, 0), t.uniform2f(s.uStep, 3 / i, 0), t.drawArrays(t.TRIANGLES, 0, 3), t.bindFramebuffer(t.FRAMEBUFFER, null), t.viewport(0, 0, i, c), t.clearColor(0, 0, 0, 0), t.clear(t.COLOR_BUFFER_BIT), t.enable(t.BLEND), t.bindTexture(t.TEXTURE_2D, this.targets[1].texture);
    const m = sa(e.x, e.y);
    t.uniform1i(s.uPass, 1), t.uniform2f(s.uShift, m[0], -m[1]), t.uniform2f(s.uStep, 0, 3 / c), t.drawArrays(t.TRIANGLES, 0, 3), t.bindTexture(t.TEXTURE_2D, this.targets[0].texture), t.uniform1i(s.uPass, 2), t.drawArrays(t.TRIANGLES, 0, 3), t.bindVertexArray(null);
  }
  clearTargets() {
    for (const e of this.targets)
      this.gl.deleteTexture(e.texture), this.gl.deleteFramebuffer(e.framebuffer);
    this.targets = [];
  }
  destroy() {
    this.clearTargets(), this.gl.deleteProgram(this.program.prog), this.gl.deleteVertexArray(this.vao);
  }
}
function la(a, e) {
  const { IMG: t, EYES: r, MOUTH: s, CHEEKS: i } = a, c = `#version 300 es
  in vec2 aPos; in vec2 aUv;
  uniform vec2 uScale; uniform vec2 uOffset;
  out vec2 vUv;
  void main() { vUv = aUv; gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); }`, m = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec4 uRect;        // layer rect in source px
  uniform int uFace;
  uniform float uAlpha;
  uniform vec4 uEyeBox[2];   // x0, x1, -, -
  uniform float uEyeTop[48]; // 2 eyes x EYE_N samples
  uniform float uEyeBot[48];
  uniform vec4 uEyeState[2]; // open, smile, ballX(px), ballY(px)
  uniform vec4 uMouth;       // cx, cy, angle, halfLen
  uniform vec4 uMouthState;  // open, form, bow, -
  uniform vec4 uCheeks;      // x0, y0, x1, y1
  uniform float uCheek;

  const int EYE_N = 24;
  float crv(int e, bool top, float u) {
    float f = clamp(u, 0.0, 1.0) * float(EYE_N - 1);
    int i = min(int(floor(f)), EYE_N - 2);
    float t = f - float(i);
    int k = e * EYE_N + i;
    return top ? mix(uEyeTop[k], uEyeTop[k + 1], t) : mix(uEyeBot[k], uEyeBot[k + 1], t);
  }

  // Upper lid line and lower lid line of eye e at column u, for the current open/smile state.
  // Must match eyeLids() in rig.js, which moves the lash meshes to the same lines.
  // Must match eyeLidsRaw() / eyeLids() in rig.js.
  vec2 eyeLidsRaw(int e, float u) {
    u = clamp(u, 0.0, 1.0);
    vec4 st = uEyeState[e];
    float top = crv(e, true, u), bot = crv(e, false, u);
    float b = 1.0 - st.x, smile = st.y, hump = 4.0 * u * (1.0 - u);
    float H = crv(e, false, 0.5) - crv(e, true, 0.5);
    float arc = mix(uEyeTop[e * EYE_N], uEyeTop[e * EYE_N + EYE_N - 1], u) - 0.3 * H * hump;
    float closed = max(top, bot + 1.0 + (arc - bot - 1.0) * smile);
    return vec2((closed - top) * max(b, -0.07), b > 0.0 ? (closed - bot) * b * smile : 0.0);
  }

  vec2 eyeLids(int e, float u, float top, float bot) {
    vec4 box = uEyeBox[e];
    float du = 5.0 / (box.y - box.x);
    vec2 raw = eyeLidsRaw(e, u);
    vec2 d = (eyeLidsRaw(e, u - 2.0 * du) + 2.0 * eyeLidsRaw(e, u - du) + 3.0 * raw
            + 2.0 * eyeLidsRaw(e, u + du) + eyeLidsRaw(e, u + 2.0 * du)) / 9.0;
    // for hiding the ball take whichever closes more: the smoothed lash can sit a little
    // above the raw lid near the corners, and the gap must show lid skin, not eye white
    return vec2(top + max(d.x, raw.x), bot + min(d.y, raw.y));
  }

  vec4 texAt(vec2 p) { return texture(uTex, (p - uRect.xy) / uRect.zw); }

  // Eye white + iris layer: shown only between the lids (the lids cover it, it never squashes);
  // the iris slides inside the opening for the gaze.
  vec4 eyeBall(int e, vec2 p) {
    vec4 box = uEyeBox[e]; vec4 st = uEyeState[e];
    float u = clamp((p.x - box.x) / (box.y - box.x), 0.0, 1.0);
    float top = crv(e, true, u), bot = crv(e, false, u);
    vec2 lids = eyeLids(e, u, top, bot);
    float v = clamp((p.y - top) / max(bot - top, 1.0), 0.0, 1.0);
    float w = sqrt(4.0 * u * (1.0 - u)) * sqrt(4.0 * v * (1.0 - v));
    vec4 c = texAt(p - vec2(st.z, st.w) * w);
      // the lash covers ~2px of the ball's upper edge, so the cut can sit under it (no seam)
    return c * smoothstep(lids.x - 1.0, lids.x + 0.5, p.y) * (1.0 - smoothstep(lids.y - 0.9, lids.y + 0.6, p.y));
  }

  vec4 mouth(vec2 p, vec4 base) {
    float open = uMouthState.x;
    if (open < 0.01) return base;
    vec2 d = vec2(cos(uMouth.z), sin(uMouth.z)), n = vec2(-d.y, d.x);
    vec2 r = p - uMouth.xy;
    float s = dot(r, d) / uMouth.w, t = dot(r, n);
    float form = uMouthState.y;                       // -1 wide "i" .. +1 round "o"
    float wf = mix(0.78, 0.46, clamp(form * 0.5 + 0.5, 0.0, 1.0));
    float k = 1.0 - (s / wf) * (s / wf);
    if (k <= 0.0) return base;
    float line = uMouthState.z * (1.0 - s * s);
    float hk = pow(k, mix(0.55, 0.85, clamp(form, 0.0, 1.0)));
    float H = mix(20.0, 26.0, clamp(form, 0.0, 1.0));
    float up = line - 0.6 - open * 2.5 * hk;
    float lo = line + open * H * hk;
    float cov = smoothstep(-0.7, 0.7, t - up) * smoothstep(-0.7, 0.7, lo - t);
    if (cov <= 0.0) return base;
    float tv = clamp((t - up) / max(lo - up, 1.0), 0.0, 1.0);
    vec3 col = mix(vec3(0.24, 0.05, 0.08), vec3(0.48, 0.15, 0.19), tv);
    float tongue = smoothstep(0.5, 0.78, tv) * (1.0 - smoothstep(0.45, 0.8, abs(s) / wf));
    col = mix(col, vec3(0.86, 0.44, 0.47), tongue * 0.9);
    float teeth = (1.0 - smoothstep(0.12, 0.22, tv)) * smoothstep(0.25, 0.45, open) * (1.0 - smoothstep(0.55, 0.85, abs(s) / wf));
    col = mix(col, vec3(0.99, 0.96, 0.94), teeth);
    float rim = 1.0 - smoothstep(0.6, 1.8, lo - t);
    col = mix(col, vec3(0.36, 0.09, 0.11), rim * 0.85);
    return vec4(mix(base.rgb, col, cov), 1.0);
  }

  void main() {
    vec2 p = uRect.xy + vUv * uRect.zw;
    vec4 c;
    if (uFace == 1) {
      c = mouth(p, texAt(p));
      float blush = exp(-dot((p - uCheeks.xy) / vec2(48.0, 22.0), (p - uCheeks.xy) / vec2(48.0, 22.0)))
                  + exp(-dot((p - uCheeks.zw) / vec2(40.0, 20.0), (p - uCheeks.zw) / vec2(40.0, 20.0)));
      c.rgb = mix(c.rgb, c.rgb * vec3(1.0, 0.62, 0.64) , clamp(blush * uCheek * 0.55, 0.0, 1.0) * c.a);
    } else if (uFace >= 2) {
      c = eyeBall(uFace - 2, p);
    } else {
      c = texAt(p);
    }
    outColor = c * uAlpha;
  }`, E = c.replace("out vec2 vUv;", "in float aHeadWeight; out float vHeadWeight; out vec2 vScreen; out vec2 vUv;").replace("vUv = aUv;", "vHeadWeight = aHeadWeight; vScreen = vec2((aPos.x * uScale.x + uOffset.x + 1.0) * 0.5, (1.0 - aPos.y * uScale.y - uOffset.y) * 0.5); vUv = aUv;"), v = m.replace("uniform sampler2D uTex;", `uniform sampler2D uTex;
    uniform sampler2D uNormal; in float vHeadWeight; in vec2 vScreen;
    uniform mat3 uHeadRotation; uniform vec3 uLight; uniform vec3 uLightColor; uniform vec3 uAmbientColor;
    uniform vec4 uLighting; uniform vec4 uSurface; uniform float uAspect; uniform int uCel;`).replace("outColor = c * uAlpha;", `
      // RG hold the smooth surface normal, BA the painting's relief (see lighting/normals.ts).
      vec4 encoded = texture(uNormal, vUv);
      vec2 base = encoded.rg * 2.0 - 1.0;
      vec3 n = vec3(base, sqrt(max(0.0, 1.0 - dot(base, base))));
      n = normalize(n + vec3((encoded.ba * 2.0 - 1.0) * uSurface.w * ${aa.toFixed(3)}, 0.0));
      n = normalize(mix(n, uHeadRotation * n, vHeadWeight));
      vec2 toLight = (uLight.xy - vScreen) * vec2(uAspect, 1.0);
      vec3 light = normalize(vec3(toLight, uLight.z));
      float ndl = dot(n, light);
      float diffuse;
      if (uCel == 1) {
        float w = 0.01 + uSurface.x * 0.08;
        diffuse = 0.2 + 0.45 * smoothstep(${Ne.toFixed(3)} - w, ${Ne.toFixed(3)} + w, ndl) + 0.35 * smoothstep(0.55 - w, 0.55 + w, ndl);
      } else {
        float s = 0.05 + uSurface.x * 0.5;
        diffuse = smoothstep(${Ne.toFixed(3)} - s, ${Ne.toFixed(3)} + s, ndl) * (0.35 + 0.65 * max(0.0, ndl));
      }
      float reach = dot(toLight, toLight) / (uLighting.w * uLighting.w);
      float attenuation = 1.0 / (1.0 + reach);
      vec3 radiance = uLightColor * uLighting.y * attenuation;
      // A light close to the surface may brighten a little, but must not bleach painted colours.
      vec3 irradiance = min(uAmbientColor * uLighting.z + radiance * diffuse, vec3(${na.toFixed(3)}));
      // Painted shadows are deeper versions of the base colour, not grey: multiply by the colour
      // itself as the surface turns away from the light.
      vec3 albedo = c.rgb / max(c.a, 1e-4);
      float dark = 1.0 - clamp(dot(irradiance, vec3(0.3333)), 0.0, 1.0);
      vec3 shaded = c.rgb * mix(vec3(1.0), albedo, dark * ${ra.toFixed(3)}) * irradiance;
      float specular = pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * uSurface.y;
      if (uCel == 1) specular = smoothstep(0.3, 0.35, specular) * uSurface.y;
      vec2 side = length(n.xy) > 0.001 ? normalize(n.xy) : vec2(0.0);
      float rim = pow(1.0 - max(n.z, 0.0), 4.0) * smoothstep(-0.2, 0.7, dot(side, normalize(toLight + vec2(1e-4)))) * uSurface.z;
      shaded += radiance * (specular * max(0.0, ndl) + rim) * c.a;
      // Strength blends between the original painting and the relit result; alpha is unchanged.
      c.rgb = clamp(mix(c.rgb, shaded, uLighting.x), vec3(0.0), vec3(c.a));
      outColor = c * uAlpha;`), M = `#version 300 es
  in vec2 aPos; uniform vec2 uScale; uniform vec2 uOffset;
  void main() { gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); gl_PointSize = 7.0; }`, u = `#version 300 es
  precision mediump float; uniform vec4 uColor; out vec4 o; void main() { o = uColor; }`;
  function x(l, d, n) {
    const o = l.createProgram();
    for (const [g, B] of [[l.VERTEX_SHADER, d], [l.FRAGMENT_SHADER, n]]) {
      const U = l.createShader(g);
      if (l.shaderSource(U, B), l.compileShader(U), !l.getShaderParameter(U, l.COMPILE_STATUS)) throw new Error(l.getShaderInfoLog(U));
      l.attachShader(o, U), l.deleteShader(U);
    }
    if (l.bindAttribLocation(o, 0, "aPos"), l.bindAttribLocation(o, 1, "aUv"), l.bindAttribLocation(o, 2, "aHeadWeight"), l.linkProgram(o), !l.getProgramParameter(o, l.LINK_STATUS)) throw new Error(l.getProgramInfoLog(o));
    const L = {}, f = l.getProgramParameter(o, l.ACTIVE_UNIFORMS);
    for (let g = 0; g < f; g++) {
      const B = l.getActiveUniform(o, g).name.replace("[0]", "");
      L[B] = l.getUniformLocation(o, B);
    }
    return { prog: o, u: L };
  }
  function S(l, d, n, o) {
    const L = [l];
    let f = l;
    for (; f < l + d - 0.5; ) {
      const g = o && f >= o.from && f < o.to ? o.cell : n;
      f = Math.min(l + d, f + g), L.push(f);
    }
    return L;
  }
  function y(l, d, n, o, L = null) {
    const [f, g, B, U] = l, D = S(f, B, d, L && { from: L.x0, to: L.x1, cell: L.cell }), _ = S(g, U, d, L && { from: L.y0, to: L.y1, cell: L.cell }), P = D.length - 1, O = _.length - 1, j = (P + 1) * (O + 1), I = new Float32Array(j * 2), q = new Float32Array(j * 2);
    for (let C = 0; C <= O; C++) for (let V = 0; V <= P; V++) {
      const Y = C * (P + 1) + V;
      I[Y * 2] = D[V], I[Y * 2 + 1] = _[C], q[Y * 2] = (D[V] - f) / B, q[Y * 2 + 1] = (_[C] - g) / U;
    }
    const N = [], Z = [], H = n.length / o, J = o === 1 ? 0 : 1;
    for (let C = 0; C < O; C++) for (let V = 0; V < P; V++) {
      const Y = Math.floor(D[V] - f) * J - 2, W = Math.ceil(D[V + 1] - f) * J + 2, ee = Math.floor(_[C] - g) * J - 2, b = Math.ceil(_[C + 1] - g) * J + 2;
      let w = !1;
      for (let k = Math.max(0, ee); k < Math.min(H, b) && !w; k += 1)
        for (let $ = Math.max(0, Y); $ < Math.min(o, W); $ += 1)
          if (n[k * o + $] > 3) {
            w = !0;
            break;
          }
      if (!w) continue;
      const A = C * (P + 1) + V, T = A + 1, F = A + P + 1, X = F + 1;
      N.push(A, T, F, T, X, F), Z.push(A, T, A, F, T, F), V === P - 1 && Z.push(T, X), C === O - 1 && Z.push(F, X);
    }
    return { rect: l, cols: P, rows: O, rest: I, uv: q, pos: new Float32Array(I), tris: new Uint32Array(N), lines: new Uint32Array(Z) };
  }
  class h {
    // padTop / padSide: margin around the image, as a share of its height / width. A negative
    // padTop pushes the top of the image above the canvas (hides a cut-off top edge).
    constructor(d, { padTop: n = 0, padSide: o = 0, fit: L = "contain" } = {}) {
      this.pad = { top: n, side: o }, this.fit = L;
      const f = d.getContext("webgl2", { premultipliedAlpha: !0, antialias: !0, alpha: !0, preserveDrawingBuffer: !0 });
      if (!f) throw new Error("WebGL2 is not available");
      this.gl = f, this.canvas = d, this.main = x(f, c, m), this.line = x(f, M, u), this.layers = [], this.lighting = ke, this.lightingStats = { normalMs: 0, computedLayers: 0, cachedLayers: 0 }, f.enable(f.BLEND), f.blendFunc(f.ONE, f.ONE_MINUS_SRC_ALPHA);
    }
    texture(d) {
      const n = this.gl, o = n.createTexture();
      return n.bindTexture(n.TEXTURE_2D, o), n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !0), n.texImage2D(n.TEXTURE_2D, 0, n.RGBA, n.RGBA, n.UNSIGNED_BYTE, d), n.generateMipmap(n.TEXTURE_2D), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MIN_FILTER, n.LINEAR_MIPMAP_LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MAG_FILTER, n.LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_S, n.CLAMP_TO_EDGE), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_T, n.CLAMP_TO_EDGE), o;
    }
    addLayer(d, n, o, L = {}) {
      const f = this.gl, g = f.createVertexArray();
      f.bindVertexArray(g);
      const B = f.createBuffer();
      f.bindBuffer(f.ARRAY_BUFFER, B), f.bufferData(f.ARRAY_BUFFER, o.pos, f.DYNAMIC_DRAW);
      for (const j of [this.main, this.line]) {
        const I = f.getAttribLocation(j.prog, "aPos");
        f.enableVertexAttribArray(I), f.vertexAttribPointer(I, 2, f.FLOAT, !1, 0, 0);
      }
      const U = f.createBuffer();
      f.bindBuffer(f.ARRAY_BUFFER, U), f.bufferData(f.ARRAY_BUFFER, o.uv, f.STATIC_DRAW);
      const D = f.getAttribLocation(this.main.prog, "aUv");
      f.enableVertexAttribArray(D), f.vertexAttribPointer(D, 2, f.FLOAT, !1, 0, 0);
      const _ = f.createBuffer();
      f.bindBuffer(f.ELEMENT_ARRAY_BUFFER, _), f.bufferData(f.ELEMENT_ARRAY_BUFFER, o.tris, f.STATIC_DRAW), f.bindVertexArray(null);
      const P = f.createBuffer();
      f.bindBuffer(f.ELEMENT_ARRAY_BUFFER, P), f.bufferData(f.ELEMENT_ARRAY_BUFFER, o.lines, f.STATIC_DRAW);
      const O = { name: d, image: n, mesh: o, tex: this.texture(n), vao: g, posBuf: B, uvBuf: U, triBuf: _, lineBuf: P, visible: !0, face: !!L.face, eyeBall: L.eyeBall, color: L.color || [1, 1, 1, 1] };
      return this.layers.push(O), O;
    }
    destroy() {
      const d = this.gl;
      for (const n of this.layers) {
        d.deleteTexture(n.tex), n.normal && d.deleteTexture(n.normal), n.headBuf && d.deleteBuffer(n.headBuf), d.deleteVertexArray(n.vao);
        for (const o of [n.posBuf, n.uvBuf, n.triBuf, n.lineBuf]) d.deleteBuffer(o);
      }
      d.deleteProgram(this.main.prog), d.deleteProgram(this.line.prog), this.lit && d.deleteProgram(this.lit.prog), this.shadow?.destroy(), this.layers.length = 0;
    }
    setLighting(d) {
      if (this.lighting = ta({ ...ke, ...d }) ?? ke, !this.lighting.enabled) return;
      const n = this.gl;
      this.lit || (this.lit = x(n, E, v));
      for (const o of this.layers) {
        if (o.normal || o.overlay) continue;
        const L = Qt(o.image, o.mesh.rect, e, !/^(eye|mouth)/.test(o.name));
        this.lightingStats.normalMs += L.ms, this.lightingStats[L.computed ? "computedLayers" : "cachedLayers"]++, o.normal = n.createTexture(), n.activeTexture(n.TEXTURE0), n.bindTexture(n.TEXTURE_2D, o.normal), n.pixelStorei(n.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !1), n.texImage2D(n.TEXTURE_2D, 0, n.RGBA, L.width, L.height, 0, n.RGBA, n.UNSIGNED_BYTE, L.data), n.generateMipmap(n.TEXTURE_2D), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MIN_FILTER, n.LINEAR_MIPMAP_LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_MAG_FILTER, n.LINEAR), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_S, n.CLAMP_TO_EDGE), n.texParameteri(n.TEXTURE_2D, n.TEXTURE_WRAP_T, n.CLAMP_TO_EDGE);
        const f = new Float32Array(o.mesh.rest.length / 2);
        for (let g = 0; g < f.length; g++) f[g] = a.headWeight(o.mesh.rest[g * 2], o.mesh.rest[g * 2 + 1]);
        o.headBuf = n.createBuffer(), n.bindVertexArray(o.vao), n.bindBuffer(n.ARRAY_BUFFER, o.headBuf), n.bufferData(n.ARRAY_BUFFER, f, n.STATIC_DRAW), n.enableVertexAttribArray(2), n.vertexAttribPointer(2, 1, n.FLOAT, !1, 0, 0);
      }
      n.bindVertexArray(null), this.lighting.shadow && !this.shadow && (this.shadow = new oa(n, x));
    }
    resize() {
      const d = this.canvas, n = Math.min(window.devicePixelRatio || 1, 2), o = Math.round(d.clientWidth * n), L = Math.round(d.clientHeight * n);
      (d.width !== o || d.height !== L) && (d.width = o, d.height = L);
      const f = (this.fit === "cover" ? Math.max : Math.min)(o / (t.w * (1 + 2 * this.pad.side)), L / (t.h * (1 + this.pad.top))), g = (o - t.w * f) / 2, B = (L - t.h * f) / (this.fit === "cover" ? 2 : 1);
      this.scale = [2 * f / o, -2 * f / L], this.offset = [-1 + 2 * g / o, 1 - 2 * B / L], this.pxScale = f, this.pxOff = [g, B];
    }
    draw(d) {
      const n = this.gl;
      this.resize(), n.viewport(0, 0, this.canvas.width, this.canvas.height), n.clearColor(0, 0, 0, 0), n.clear(n.COLOR_BUFFER_BIT);
      const o = this.lighting.enabled, L = o && this.lighting.shadow;
      L && this.shadow.begin(this.canvas.width, this.canvas.height);
      const f = o ? this.lit : this.main;
      if (this.current = f, n.useProgram(f.prog), o) {
        const g = this.lighting;
        n.uniform1i(f.u.uNormal, 1), n.uniform3f(f.u.uLight, g.x, g.y, g.z), n.uniform3f(f.u.uLightColor, (g.color >> 16 & 255) / 255, (g.color >> 8 & 255) / 255, (g.color & 255) / 255), n.uniform3f(f.u.uAmbientColor, (g.ambientColor >> 16 & 255) / 255, (g.ambientColor >> 8 & 255) / 255, (g.ambientColor & 255) / 255), n.uniform4f(f.u.uLighting, g.strength, g.intensity, g.ambient, g.reach), n.uniform4f(f.u.uSurface, g.softness, g.specular, g.rim, g.detail), n.uniform1f(f.u.uAspect, this.canvas.width / this.canvas.height), n.uniform1i(f.u.uCel, g.mode === "cel" ? 1 : 0), n.uniformMatrix3fv(f.u.uHeadRotation, !1, ia(d.angleX ?? 0, d.angleY ?? 0, d.angleZ ?? 0, e.head.maxRoll));
      }
      n.uniform2fv(f.u.uScale, this.scale), n.uniform2fv(f.u.uOffset, this.offset), n.uniform1i(f.u.uTex, 0), n.uniform4fv(f.u.uEyeBox, r.flatMap((g) => [g.x0, g.x1, 0, 0])), n.uniform1fv(f.u.uEyeTop, r.flatMap((g) => g.top)), n.uniform1fv(f.u.uEyeBot, r.flatMap((g) => g.bot)), n.uniform4fv(f.u.uEyeState, d.eyes), n.uniform4f(f.u.uMouth, s.cx, s.cy, s.angle, s.halfLen), n.uniform4f(f.u.uMouthState, d.mouthOpen, d.mouthForm, s.bow, 0), n.uniform4f(f.u.uCheeks, i[0][0], i[0][1], i[1][0], i[1][1]), n.uniform1f(f.u.uCheek, d.cheek), n.activeTexture(n.TEXTURE0);
      for (const g of this.layers)
        !g.visible || g.overlay || this.drawLayer(g, g.alpha ?? 1);
      if (this.original && d.originalAlpha > 0 && this.drawLayer(this.original, d.originalAlpha), L && this.shadow.composite(this.lighting), d.showMesh) {
        const g = this.line;
        n.useProgram(g.prog), n.uniform2fv(g.u.uScale, this.scale), n.uniform2fv(g.u.uOffset, this.offset);
        for (const B of this.layers)
          !B.visible || B.overlay || (n.bindVertexArray(B.vao), n.bindBuffer(n.ELEMENT_ARRAY_BUFFER, B.lineBuf), n.uniform4fv(g.u.uColor, B.color), n.drawElements(n.LINES, B.mesh.lines.length, n.UNSIGNED_INT, 0), n.bindBuffer(n.ELEMENT_ARRAY_BUFFER, B.triBuf));
        d.joints?.length && this.drawPoints(d.joints), n.bindVertexArray(null);
      }
    }
    drawLayer(d, n) {
      const o = this.gl, L = this.current;
      o.useProgram(L.prog), o.bindVertexArray(d.vao), o.bindBuffer(o.ARRAY_BUFFER, d.posBuf), o.bufferSubData(o.ARRAY_BUFFER, 0, d.mesh.pos), this.lighting.enabled && (o.activeTexture(o.TEXTURE1), o.bindTexture(o.TEXTURE_2D, d.normal), o.activeTexture(o.TEXTURE0)), o.bindTexture(o.TEXTURE_2D, d.tex), o.uniform4fv(L.u.uRect, d.mesh.rect), o.uniform1i(L.u.uFace, d.eyeBall !== void 0 ? 2 + d.eyeBall : d.face ? 1 : 0), o.uniform1f(L.u.uAlpha, n), o.drawElements(o.TRIANGLES, d.mesh.tris.length, o.UNSIGNED_INT, 0);
    }
    drawPoints(d) {
      const n = this.gl, o = this.line;
      if (!this.pointBuf) {
        this.pointBuf = n.createBuffer(), this.pointVao = n.createVertexArray(), n.bindVertexArray(this.pointVao), n.bindBuffer(n.ARRAY_BUFFER, this.pointBuf);
        const L = n.getAttribLocation(o.prog, "aPos");
        n.enableVertexAttribArray(L), n.vertexAttribPointer(L, 2, n.FLOAT, !1, 0, 0);
      }
      n.bindVertexArray(this.pointVao), n.bindBuffer(n.ARRAY_BUFFER, this.pointBuf), n.bufferData(n.ARRAY_BUFFER, new Float32Array(d.flat()), n.DYNAMIC_DRAW), n.uniform4f(o.u.uColor, 1, 0.85, 0.2, 1), n.drawArrays(n.POINTS, 0, d.length);
    }
    // canvas CSS px -> source image px
    toImage(d, n) {
      if (!this.pxOff) return null;
      const o = this.canvas.width / this.canvas.clientWidth;
      return [(d * o - this.pxOff[0]) / this.pxScale, (n * o - this.pxOff[1]) / this.pxScale];
    }
  }
  return { Renderer: h, buildGrid: y };
}
function ha(a, e) {
  const { applyHead: t, applyBody: r, TASSELS: s, tasselAnchor: i } = a, c = (e.strands ?? []).map((n) => {
    if (n.nodes.length === 4) return n;
    const o = Array.from({ length: 4 }, (L, f) => {
      const g = f / 3 * (n.nodes.length - 1), B = Math.min(n.nodes.length - 2, Math.floor(g)), U = g - B;
      return [0, 1].map((D) => n.nodes[B][D] + (n.nodes[B + 1][D] - n.nodes[B][D]) * U);
    });
    return { ...n, nodes: o };
  }), m = [0, 300, 200, 140], E = 0.9, v = 7, M = { stiff: 1.7, damp: 1.6, couple: 0.85, reach: 0.9, bind: 4 }, u = Math.min(6, c.filter((n) => n.name.startsWith("bang")).length), x = { freq: 0.7, zeta: 0.22, hang: 0.85, inertia: 0.32, wind: 0.03, max: 0.55, smooth: 6 }, S = (n, o) => [n[0] * Math.cos(o) - n[1] * Math.sin(o), n[0] * Math.sin(o) + n[1] * Math.cos(o)], y = (n, o) => {
    const L = Math.hypot(n[0], n[1]);
    if (L < 1e-6) return n;
    const f = o * Math.tanh(L / o) / L;
    return [n[0] * f, n[1] * f];
  }, h = Object.fromEntries(Object.entries(e.buns ?? {}).map(([n, o]) => [n, { at: [o.cx, o.cy], k: 260, c: 11, hang: 3, max: 4 }])), l = (n, o) => {
    const L = Math.hypot(n[0], n[1]);
    L > o && (n[0] *= o / L, n[1] *= o / L);
  };
  class d {
    constructor() {
      this.gain = 1, this.out = { gain: 1, bunL: [0, 0], bunR: [0, 0] }, this.hair = {};
      for (const o of Object.keys(h))
        this.hair[o] = { p: null, v: [0, 0] }, this.out[o] = [0, 0];
      this.strands = c.map(() => ({ p: null, v: [[0, 0], [0, 0], [0, 0], [0, 0]] })), this.out.strands = c.map(() => [[0, 0], [0, 0], [0, 0], [0, 0]]), this.chains = s.map((o) => {
        const L = o.tip[0] - o.pivot[0], f = o.tip[1] - o.pivot[1], g = Math.hypot(L, f), B = [L / g, f / g];
        return { t: o, dir: B, L1: g * o.split, L2: g * (1 - o.split), pts: null, prev: null, phi: [0, 0], anchor: [0, 0] };
      }), this.time = 0;
    }
    hairAnchor(o, L) {
      const f = [o[0], o[1]];
      return t(f, 1, L), r(f, o[1], L), f;
    }
    step(o, L) {
      const f = Math.max(1, Math.ceil(L / 0.004166666666666667)), g = Math.min(L, 0.05) / f, B = -o.angleZ / 30 * e.head.maxRoll - o.bodyAngleZ / 10 * e.body.maxRoll, U = this.gain;
      c.forEach((_, P) => {
        const O = this.strands[P], j = this.out.strands[P], I = _.nodes.map((N) => this.hairAnchor(N, o));
        O.p || (O.p = I.map((N) => [...N]));
        const q = P * 1.7;
        for (let N = 0; N < f; N++) {
          const Z = this.time + N * g;
          for (let H = 1; H < 4; H++) {
            const J = Math.hypot(_.nodes[H][0] - _.nodes[0][0], _.nodes[H][1] - _.nodes[0][1]), C = (Math.sin(Z * 1.3) * 0.5 + Math.sin(Z * 3.1) * 0.3 + Math.sin(Z * 4.7 + q) * 0.2) * _.max * 0.1 * H / 3, V = [O.p[H - 1][0] - I[H - 1][0], O.p[H - 1][1] - I[H - 1][1]], Y = I[H][0] + V[0] * E * M.couple - Math.sin(B) * J * 0.12 + C, W = I[H][1] + V[1] * E * M.couple, ee = m[H] * _.k * M.stiff / Math.max(0.35, U), b = v * M.damp * Math.sqrt(M.stiff) / Math.max(0.5, Math.sqrt(U)), w = O.v[H], A = O.p[H];
            w[0] += (ee * (Y - A[0]) - b * w[0]) * g, w[1] += (ee * (W - A[1]) - b * w[1]) * g, A[0] += w[0] * g, A[1] += w[1] * g;
          }
          O.p[0] = [...I[0]];
        }
        for (let N = 0; N < 4; N++) {
          const Z = [O.p[N][0] - I[N][0], O.p[N][1] - I[N][1]];
          j[N] = y(Z, Math.max(0.5, _.max * M.reach * Math.max(1, U) * N / 3));
        }
      });
      for (const [_, P] of Object.entries(h)) {
        const O = this.hair[_], j = this.hairAnchor(P.at, o), I = Math.sin(this.time * 1.3 + P.at[0] * 0.01) * 0.6 + Math.sin(this.time * 2.9 + P.at[1] * 0.02) * 0.4, q = j[0] - Math.sin(B) * P.hang + I * P.max * 0.12, N = j[1];
        O.p || (O.p = [q, N]);
        const Z = P.k / Math.max(0.35, U), H = P.c / Math.max(0.5, Math.sqrt(U));
        for (let C = 0; C < f; C++)
          O.v[0] += (Z * (q - O.p[0]) - H * O.v[0]) * g, O.v[1] += (Z * (N - O.p[1]) - H * O.v[1]) * g, O.p[0] += O.v[0] * g, O.p[1] += O.v[1] * g;
        const J = [O.p[0] - j[0], O.p[1] - j[1]];
        l(J, P.max * Math.max(1, U)), this.out[_] = J;
      }
      this.out.gain = 1;
      const D = this.out.strands;
      for (let _ = 0; _ < M.bind; _++) for (let P = 1; P < 4; P++) {
        const O = D.slice(0, u).map((j) => [...j[P]]);
        for (let j = 0; j < u; j++) {
          const I = O[Math.max(0, j - 1)], q = O[Math.min(u - 1, j + 1)];
          for (const N of [0, 1]) D[j][P][N] = O[j][N] * 0.5 + (I[N] + q[N]) * 0.25;
        }
      }
      for (const _ of this.chains) {
        const P = i(_.t, o, this.out, [0, 0]);
        _.st || (_.st = { th: [0, 0], w: [0, 0], pos: [...P], vel: [0, 0], acc: [0, 0] });
        const O = _.st, j = x, I = [(P[0] - O.pos[0]) / Math.max(L, 1e-3), (P[1] - O.pos[1]) / Math.max(L, 1e-3)], q = 1 - Math.exp(-L * j.smooth), N = [(I[0] - O.vel[0]) / Math.max(L, 1e-3), (I[1] - O.vel[1]) / Math.max(L, 1e-3)];
        O.acc = [O.acc[0] + (N[0] - O.acc[0]) * q, O.acc[1] + (N[1] - O.acc[1]) * q], O.vel = [O.vel[0] + (I[0] - O.vel[0]) * q, O.vel[1] + (I[1] - O.vel[1]) * q], O.pos = [...P];
        const Z = [-_.dir[1], _.dir[0]], H = -(O.acc[0] * Z[0] + O.acc[1] * Z[1]) / (_.L1 + _.L2) * j.inertia, J = (Math.sin(this.time * 0.9 + _.t.pivot[0]) * 0.6 + Math.sin(this.time * 0.37 + _.t.pivot[1]) * 0.4) * j.wind, C = -B * j.hang + J, V = 2 * Math.PI * j.freq / Math.sqrt(Math.max(0.4, U)), Y = V * 1.35;
        for (let w = 0; w < f; w++) {
          const A = -V * V * (O.th[0] - C) - 2 * j.zeta * V * O.w[0] + H;
          O.w[0] += A * g, O.th[0] += O.w[0] * g;
          const T = -Y * Y * (O.th[1] - O.th[0]) - 2 * j.zeta * Y * O.w[1] + H * 0.4 + A * 0.5;
          O.w[1] += T * g, O.th[1] += O.w[1] * g;
        }
        O.th[0] = Math.max(-0.55, Math.min(j.max, O.th[0])), O.th[1] = Math.max(-0.55 * 1.4, Math.min(j.max * 1.4, O.th[1])), _.phi = [O.th[0], O.th[1]];
        const W = S(_.dir, O.th[0]), ee = S(_.dir, O.th[1]), b = [P[0] + W[0] * _.L1, P[1] + W[1] * _.L1];
        _.pts = [[...P], b, [b[0] + ee[0] * _.L2, b[1] + ee[1] * _.L2]], _.anchor = P;
      }
      return this.time += L, this.out;
    }
  }
  return { Physics: d };
}
function ua(a, e) {
  const { baseWeights: t, deformBase: r, MOUTH: s } = a, i = (f, g, B) => {
    const U = Math.min(1, Math.max(0, (B - f) / (g - f)));
    return U * U * (3 - 2 * U);
  }, c = e.mouth.area, m = {
    a: { sprite: "mouth_a", ref: 0.9, width: 1 },
    aHalf: { sprite: "mouth_a_half", ref: 0.55, width: 1 },
    i: { sprite: "mouth_i", ref: 0.55, width: 1 },
    e: { sprite: "mouth_a_half", ref: 0.65, width: 1.06 },
    o: { sprite: "mouth_o", ref: 0.75, width: 1 },
    u: { sprite: "mouth_o", ref: 0.75, width: 0.78 }
  }, E = 0.16, v = ["angry", "sad"];
  function M(f, g) {
    const B = (_, P, O) => _ >= P - (g ? 0.07 : 0) && _ < O + (g ? 0.07 : 0), U = [["i", -9, -0.55], ["e", -0.55, -0.2], ["a", -0.2, 0.35], ["o", 0.35, 0.75], ["u", 0.75, 9]], D = g && U.find((_) => _[0] === g || g === "aHalf" && _[0] === "a");
    return D && B(f, D[1], D[2]) ? D[0] : U.find((_) => f >= _[1] && f < _[2])[0];
  }
  const u = 0.75, x = 0.3, S = 0.06, y = ["sad", "surprise"];
  function h(f, g, B = null) {
    return B && f >= x ? B : f >= u ? null : f < x ? g >= 0.5 ? "eyes_smile" : "eyes_closed" : "eyes_half";
  }
  function l(f, g, B = null) {
    if (f < E) return null;
    const U = M(g, B);
    return U === "a" ? f >= 0.6 ? "a" : "aHalf" : U;
  }
  function d(f) {
    return s.cy + (f - s.cx) * Math.tan(s.angle);
  }
  function n() {
    return c.cx;
  }
  function o(f, g) {
    const B = Math.cos(-c.angle), U = Math.sin(-c.angle), D = f - c.cx, _ = g - c.cy, P = (D * B - _ * U) / c.rx, O = (D * U + _ * B) / c.ry;
    return 1 - i(0.55, 0.95, Math.hypot(P, O));
  }
  function L(f, g, B, U, D) {
    const _ = {}, P = (Y) => Y.startsWith("eyes_closed") || Y.startsWith("eyes_smile"), O = (Y) => v.some((W) => Y === `mouth_${W}`), j = (Y) => P(Y) ? 1 : Y.startsWith("eyes_") ? 0 : O(Y) ? 2 : 3, I = Object.entries(g.layers).sort((Y, W) => j(Y[0]) - j(W[0]));
    for (const [Y, W] of I) {
      const ee = U(W, e.mesh.spriteCell, D(B[Y]), B[Y].width), b = [], w = [];
      for (let T = 0; T < ee.rest.length / 2; T++) {
        const F = ee.rest[T * 2], X = ee.rest[T * 2 + 1];
        b.push(t(F, X, 0)), w.push(Y.startsWith("mouth") ? o(F, X) : 0);
      }
      const A = f.addLayer(Y, B[Y], ee, { color: [0.4, 1, 0.8, 0.6] });
      A.visible = !1, _[Y] = { mesh: ee, W: b, inner: w, layer: A };
    }
    const q = [0, 1].map((Y) => !!(_[`eyes_closed_${Y}`] && _[`eyes_half_${Y}`])), N = Object.values(m).some((Y) => _[Y.sprite]), Z = (Y, W) => (Y === "eyes_smile" && !_[`eyes_smile_${W}`] && (Y = "eyes_closed"), Y === "open" || _[`${Y}_${W}`] ? Y : "open"), H = [0, 0];
    let J = null;
    const C = [0, 1].map(() => ({ cur: "open", prev: "open", t: 1 }));
    function V(Y, W, ee, b, w = 1) {
      const A = Y.mesh.rest, T = Y.mesh.pos;
      for (let F = 0; F < Y.W.length; F++) {
        let X = A[F * 2], k = A[F * 2 + 1];
        const $ = Y.inner[F];
        if ($ > 0) {
          const p = d(X);
          k = p + (k - p) * (1 + (b - 1) * $), X = n() + (X - n()) * (1 + (w - 1) * $);
        }
        r(X, k, Y.W[F], W, ee, H), T[F * 2] = H[0], T[F * 2 + 1] = H[1];
      }
    }
    return {
      /**
       * Show / hide and deform the sprites for this frame.
       * Returns which eyes are covered by a sprite, so the layered eye parts can be hidden, and
       * whether a drawing shows the mouth, so the shader mouth can be left out.
       * `mood` (angry / sad / surprise) picks drawn expression eyes (sad, surprise) and closed
       * mouths (angry, sad) when the avatar has them.
       */
      update(Y, W, ee = 1 / 60, b = null) {
        for (const k of Object.values(_)) k.layer.visible = !1;
        const w = [!1, !1];
        [
          [Y.eyeROpen, Y.eyeSmile],
          [Y.eyeLOpen, Y.eyeSmileL ?? Y.eyeSmile]
        ].forEach(([k, $], p) => {
          const R = C[p], z = y.includes(b) && _[`eyes_${b}_${p}`] ? `eyes_${b}` : null, K = Z(h(k, $, z) ?? "open", p);
          K !== R.cur && (R.prev = R.cur, R.cur = K, R.t = 0), R.t = ee > 0 ? Math.min(1, R.t + ee / S) : 1;
          const Q = i(0, 1, R.t), re = (ne, ve) => {
            if (ne === "open" || ve <= 1e-3) return;
            const Se = _[`${ne}_${p}`];
            Se && (Se.layer.visible = !0, Se.layer.alpha = ve, V(Se, Y, W, 1));
          }, ie = (ne) => ne === "open" ? -1 : P(ne) ? 1 : 0;
          R.t >= 1 ? re(R.cur, 1) : ie(R.cur) > ie(R.prev) ? (re(R.prev, 1), re(R.cur, Q)) : (re(R.cur, 1), re(R.prev, 1 - Q)), w[p] = R.cur !== "open" && Q >= 0.999;
        });
        const A = l(Y.mouthOpen, Y.mouthForm, J);
        J = A;
        const T = A && m[A], F = T && _[T.sprite], X = v.includes(b) && _[`mouth_${b}`];
        if (X && (!F || Y.mouthOpen < E + 0.04) && (X.layer.visible = !0, X.layer.alpha = 1, V(X, Y, W, 1)), F) {
          F.layer.visible = !0, F.layer.alpha = i(E, E + 0.04, Y.mouthOpen);
          const k = Math.min(1.1, Math.max(0.5, Y.mouthOpen / T.ref));
          V(F, Y, W, k, T.width);
        }
        return { eyes: w, mouth: A, mouthDrawn: N && (!T || !!F) };
      },
      /** Whether each eye has the closed and half-closed drawings, so the layered eye stays open. */
      eyesDrawn: q
    };
  }
  return { createSprites: L, mouthShape: l, eyeSprite: h };
}
const wt = { angry: "angry", angryTalk: "angry", sad: "sad", sadTalk: "sad", surprise: "surprise", surprisedTalk: "surprise" };
function ca(a, e) {
  return a && a !== "neutral" ? wt[a] ?? null : (e && wt[e]) ?? null;
}
function fa(a, e, t, r = 6) {
  let s = e, i = t, c = -1, m = -1;
  for (let M = 0; M < t; M++) {
    const u = M * e;
    for (let x = 0; x < e; x++)
      a[u + x] > 3 && (x < s && (s = x), x > c && (c = x), M < i && (i = M), M > m && (m = M));
  }
  if (c < 0) return null;
  const E = Math.max(0, s - r), v = Math.max(0, i - r);
  return [E, v, Math.min(e, c + 1 + r) - E, Math.min(t, m + 1 + r) - v];
}
function ma(a, e, t, r, s, i, c = 16, m, E, v) {
  const M = /* @__PURE__ */ new Map();
  for (const u of e.overlays) {
    const x = t[u.name];
    if (m !== void 0 && x.width !== m || E !== void 0 && x.height !== E)
      throw new Error(`overlay ${u.name}: image size does not match base.png`);
    const S = s(x), y = fa(S, x.width, x.height);
    if (!y) continue;
    const [h, l, d, n] = y, o = new Uint8Array(d * n);
    for (let B = 0; B < n; B++) o.set(S.subarray((l + B) * x.width + h, (l + B) * x.width + h + d), B * d);
    const L = r(y, c, o, d), f = [];
    for (let B = 0; B < L.rest.length; B += 2) {
      const U = i(L.rest[B], L.rest[B + 1], 0);
      f.push({ ...U, brow: 0, jaw: 0 });
    }
    const g = a.addLayer(`overlay_${u.name}`, v(x, y), L);
    g.visible = !1, M.set(u.name, { mesh: L, weights: f, layer: g });
  }
  return {
    /** Shows the named overlays and hides the rest. Unknown names are ignored. */
    set(u) {
      const x = new Set(u);
      for (const [S, y] of M) y.layer.visible = x.has(S);
    },
    update(u, x, S, y) {
      for (const { mesh: h, weights: l, layer: d } of M.values())
        if (d.visible)
          for (let n = 0; n < l.length; n++)
            S(h.rest[n * 2], h.rest[n * 2 + 1], l[n], u, x, y), h.pos[n * 2] = y[0], h.pos[n * 2 + 1] = y[1];
    }
  };
}
function ot(a) {
  if (!a || typeof a != "object" || Array.isArray(a)) throw new TypeError("lipSync: expected an object");
  const e = a, t = {};
  for (const r of ["granularity", "openness", "closeSpeed"]) {
    const s = e[r];
    if (s !== void 0) {
      if (typeof s != "number" || !Number.isFinite(s) || s < 0 || s > 1)
        throw new RangeError(`lipSync.${r}: expected 0–1`);
      t[r] = s;
    }
  }
  if (e.preset !== void 0) {
    if (!["calm", "default", "lively", "subtle", "big", "custom"].includes(e.preset))
      throw new RangeError("lipSync.preset: expected calm, default, lively, subtle, big or custom");
    t.preset = e.preset;
  }
  return t;
}
function xt(a = {}, e = {
  granularity: 0.5,
  openness: 0.5,
  closeSpeed: 0.5
}) {
  const t = ot(a);
  return {
    granularity: t.granularity ?? e.granularity,
    openness: t.openness ?? e.openness,
    closeSpeed: t.closeSpeed ?? e.closeSpeed
  };
}
const we = (a, e, t, r) => a === 0.5 ? t : a < 0.5 ? e + (t - e) * a * 2 : t + (r - t) * (a - 0.5) * 2;
function At(a) {
  return {
    arm: we(a.granularity, 0.2, 0.6, 0.9),
    trigger: we(a.granularity, 0.65, 0.8, 0.95),
    relax: we(a.granularity, 1.5, 5, 12),
    range: we(a.granularity, 0.7, 0.3, 0.05),
    risePower: we(a.granularity, 0.05, 0.3, 0.8),
    openness: we(a.openness, 0.55, 1, 1.25),
    audioRelease: we(a.closeSpeed, 6, 32, 45),
    kanaRelease: we(a.closeSpeed, 6, 22, 45)
  };
}
const pa = /* @__PURE__ */ new Set([
  "angleX",
  "angleY",
  "angleZ",
  "bodyAngleX",
  "bodyAngleZ",
  "armAngle",
  "handAngle",
  "gazeX",
  "gazeY"
]), lt = {
  nod: {
    label: "Nod",
    dur: 1.7,
    tracks: {
      angleY: [[0, 0], [0.32, -13], [0.62, 2], [0.95, -9], [1.3, 1], [1.7, 0]],
      angleZ: [[0, 0], [0.4, -2], [1, -1], [1.7, 0]],
      bodyAngleX: [[0, 0], [0.5, -1.5], [1.7, 0]],
      eyeSmile: [[0, 0], [0.3, 0.45], [1.3, 0.45], [1.7, 0]],
      eyeOpen: [[0, 1], [0.3, 0.72], [1.3, 0.72], [1.7, 1]],
      mouthOpen: [[0, 0], [0.3, 0.12], [1.3, 0.12], [1.7, 0]],
      mouthForm: [[0, 0], [0.3, -0.6], [1.7, -0.3]]
    }
  },
  tilt: {
    label: "Head tilt",
    dur: 2.6,
    tracks: {
      angleZ: [[0, 0], [0.55, 17], [2, 15], [2.6, 0]],
      angleX: [[0, 0], [0.6, 8], [2, 7], [2.6, 0]],
      angleY: [[0, 0], [0.6, 4], [2.6, 0]],
      bodyAngleZ: [[0, 0], [0.8, 3], [2, 3], [2.6, 0]],
      gazeX: [[0, 0], [0.4, 0.5], [2.1, 0.4], [2.6, 0]],
      gazeY: [[0, 0], [0.4, 0.35], [2.1, 0.3], [2.6, 0]],
      browAngle: [[0, 0], [0.5, -0.7], [2.1, -0.6], [2.6, 0]],
      browY: [[0, 0], [0.5, 0.35], [2.1, 0.3], [2.6, 0]]
      // closed mouth: a barely open round mouth read as a squashed blob
    }
  },
  think: {
    label: "Thinking",
    dur: 3.6,
    tracks: {
      angleX: [[0, 0], [0.7, -11], [3, -9], [3.6, 0]],
      angleY: [[0, 0], [0.7, 9], [3, 8], [3.6, 0]],
      angleZ: [[0, 0], [0.8, 6], [3, 5], [3.6, 0]],
      gazeX: [[0, 0], [0.35, -0.8], [3.1, -0.7], [3.6, 0]],
      gazeY: [[0, 0], [0.35, 0.7], [3.1, 0.6], [3.6, 0]],
      handAngle: [[0, 0], [0.6, 3], [3, 3], [3.6, 0]],
      fingerTap: [
        [0, 0],
        [0.9, 0],
        [1.05, 1],
        [1.2, 0],
        [1.4, 1],
        [1.55, 0],
        [1.75, 1],
        [1.9, 0],
        [2.3, 0],
        [2.45, 1],
        [2.6, 0],
        [3.6, 0]
      ],
      browY: [[0, 0], [0.6, 0.25], [3, 0.2], [3.6, 0]],
      browAngle: [[0, 0], [0.6, -0.3], [3, -0.3], [3.6, 0]],
      mouthForm: [[0, 0], [0.6, 0.4], [3.6, 0]]
    }
  },
  giggle: {
    label: "Chuckle",
    dur: 2.2,
    tracks: {
      eyeOpen: [[0, 1], [0.2, 0], [1.8, 0], [2.2, 1]],
      eyeSmile: [[0, 0], [0.2, 1], [1.8, 1], [2.2, 0]],
      mouthOpen: [[0, 0], [0.2, 0.5], [0.45, 0.32], [0.7, 0.55], [0.95, 0.34], [1.2, 0.5], [1.8, 0.3], [2.1, 0]],
      mouthForm: [[0, 0], [0.2, -0.8], [2.2, -0.2]],
      blush: [[0, 0], [0.3, 0.7], [1.8, 0.7], [2.2, 0.1]],
      angleY: [[0, 0], [0.2, -5], [0.45, -1], [0.7, -6], [0.95, -2], [1.2, -5], [1.6, -2], [2.2, 0]],
      angleZ: [[0, 0], [0.3, -6], [1.8, -5], [2.2, 0]],
      bodyAngleZ: [[0, 0], [0.25, 2], [0.5, -1], [0.75, 2], [1, -1], [1.3, 1.5], [2.2, 0]],
      browY: [[0, 0], [0.3, 0.3], [1.8, 0.3], [2.2, 0]]
    }
  },
  surprise: {
    label: "Surprise",
    dur: 2,
    tracks: {
      angleY: [[0, 0], [0.12, 10], [0.5, 6], [1.5, 5], [2, 0]],
      angleX: [[0, 0], [0.12, -4], [2, 0]],
      bodyAngleX: [[0, 0], [0.15, -4], [1.5, -3], [2, 0]],
      eyeOpen: [[0, 1], [0.1, 1.25], [1.5, 1.2], [2, 1]],
      browY: [[0, 0], [0.1, 1], [1.5, 0.9], [2, 0]],
      mouthOpen: [[0, 0], [0.12, 0.6], [1.4, 0.45], [2, 0]],
      mouthForm: [[0, 0], [0.12, 0.6], [1.5, 0.55], [2, 0]],
      // o
      armAngle: [[0, 0], [0.15, -4], [1.5, -3], [2, 0]]
    }
  },
  shy: {
    label: "Shy",
    dur: 3.2,
    tracks: {
      angleX: [[0, 0], [0.6, 14], [2.6, 12], [3.2, 0]],
      angleY: [[0, 0], [0.6, -9], [2.6, -8], [3.2, 0]],
      angleZ: [[0, 0], [0.7, -8], [2.6, -7], [3.2, 0]],
      gazeX: [[0, 0], [0.3, 0.8], [1.6, 0.8], [1.9, -0.3], [2.2, 0.8], [2.8, 0.6], [3.2, 0]],
      gazeY: [[0, 0], [0.3, -0.5], [2.8, -0.4], [3.2, 0]],
      eyeOpen: [[0, 1], [0.5, 0.75], [2.7, 0.75], [3.2, 1]],
      eyeSmile: [[0, 0], [0.5, 0.5], [2.7, 0.5], [3.2, 0]],
      blush: [[0, 0], [0.8, 1], [2.7, 1], [3.2, 0]],
      browAngle: [[0, 0], [0.5, -0.6], [2.7, -0.5], [3.2, 0]],
      mouthForm: [[0, 0], [0.5, -0.4], [3.2, 0]],
      handAngle: [[0, 0], [0.8, 4], [2.6, 4], [3.2, 0]]
    }
  },
  no: {
    label: "Shake head",
    dur: 1.9,
    tracks: {
      angleX: [[0, 0], [0.2, 13], [0.45, -13], [0.7, 12], [0.95, -10], [1.2, 5], [1.5, 0]],
      angleY: [[0, 0], [0.2, -3], [1.3, -3], [1.9, 0]],
      bodyAngleX: [[0, 0], [0.3, 1.5], [0.6, -1.5], [0.9, 1], [1.3, 0]],
      eyeOpen: [[0, 1], [0.15, 0], [1.4, 0], [1.9, 1]],
      eyeSmile: [[0, 0], [0.15, 1], [1.4, 1], [1.9, 0]],
      // closed mouth while shaking the head
      browAngle: [[0, 0], [0.2, -0.5], [1.4, -0.5], [1.9, 0]]
    }
  },
  wink: {
    label: "Wink",
    dur: 2,
    tracks: {
      angleZ: [[0, 0], [0.35, -13], [1.5, -12], [2, 0]],
      angleX: [[0, 0], [0.35, 9], [1.5, 8], [2, 0]],
      bodyAngleZ: [[0, 0], [0.5, -2], [1.5, -2], [2, 0]],
      eyeOpenL: [[0, 1], [0.25, 1], [0.4, 0], [1.4, 0], [1.6, 1]],
      eyeSmileL: [[0, 0], [0.3, 1], [1.5, 1], [1.7, 0]],
      mouthOpen: [[0, 0], [2, 0]],
      // wink with a closed smile
      mouthForm: [[0, 0], [0.35, -0.8], [2, 0]],
      blush: [[0, 0], [0.4, 0.5], [1.6, 0.5], [2, 0]]
    }
  },
  greet: {
    label: "Greeting",
    dur: 2.6,
    tracks: {
      angleY: [[0, 0], [0.7, -18], [1.2, -17], [1.9, 2], [2.6, 0]],
      bodyAngleX: [[0, 0], [0.8, 2], [1.8, 0]],
      bodyAngleZ: [[0, 0], [0.8, 1.5], [2, 0]],
      armAngle: [[0, 0], [0.8, 3], [2, 0]],
      eyeOpen: [[0, 1], [0.5, 0], [1.4, 0], [1.8, 1]],
      eyeSmile: [[0, 0], [0.5, 1], [1.6, 1], [2.3, 0.4], [2.6, 0]],
      mouthOpen: [[0, 0], [1.6, 0], [1.8, 0.3], [2.3, 0.2], [2.6, 0]],
      mouthForm: [[0, 0], [1.6, -0.8], [2.6, -0.3]],
      blush: [[0, 0], [1.6, 0.3], [2.6, 0]]
    }
  }
}, ht = {
  lookAround: {
    label: "Look around",
    dur: 5.2,
    idle: !0,
    tracks: {
      gazeX: [[0, 0], [0.25, -0.85], [1.5, -0.8], [1.8, 0.1], [2.1, 0.85], [3.4, 0.8], [3.7, 0], [5.2, 0]],
      gazeY: [[0, 0], [0.25, 0.15], [1.8, 0.25], [2.1, 0.1], [3.7, 0], [5.2, 0]],
      angleX: [[0, 0], [0.7, -20], [1.6, -18], [2.5, 19], [3.5, 17], [4.4, 0], [5.2, 0]],
      angleY: [[0, 0], [0.7, 3], [1.8, 5], [2.5, 3], [4.4, 0]],
      angleZ: [[0, 0], [0.8, 4], [1.8, 0], [2.6, -4], [4.4, 0]],
      bodyAngleX: [[0, 0], [1, -4], [2.8, 4], [4.6, 0]],
      bodyAngleZ: [[0, 0], [1, 1.5], [2.8, -1.5], [4.6, 0]],
      handAngle: [[0, 0], [1, -2], [2.8, 2], [4.6, 0]],
      browY: [[0, 0], [0.5, 0.35], [3.6, 0.3], [4.4, 0]],
      // curious: a quick inhale, held while looking, let out at the end
      breath: [[0, 0.2], [0.6, 0.85], [3.6, 0.7], [4.6, 0], [5.2, 0.1]]
    }
  },
  glance: {
    label: "Side glance",
    dur: 4.6,
    idle: !0,
    tracks: {
      gazeX: [[0, 0], [0.18, 0.9], [2.6, 0.85], [2.9, 0.15], [3.2, 0], [4.6, 0]],
      gazeY: [[0, 0], [0.18, 0.4], [2.6, 0.35], [3.2, 0]],
      angleX: [[0, 0], [0.6, 13], [2.6, 11], [3.6, 0]],
      angleY: [[0, 0], [0.6, 6], [2.6, 5], [3.6, 0]],
      angleZ: [[0, 0], [0.7, -5], [2.6, -4], [3.6, 0]],
      bodyAngleX: [[0, 0], [1, 2.5], [2.8, 2], [4, 0]],
      eyeOpen: [[0, 1], [0.3, 1.06], [2.5, 1.05], [2.8, 0.85], [3.4, 1]],
      browY: [[0, 0], [0.4, 0.4], [2.5, 0.35], [3.4, 0]],
      browAngle: [[0, 0], [0.4, -0.2], [2.5, -0.2], [3.4, 0]],
      breath: [[0, 0], [0.5, 0.6], [2.6, 0.55], [3.8, 0], [4.6, 0.3]]
    }
  },
  sway: {
    label: "Sway",
    dur: 7,
    idle: !0,
    tracks: {
      bodyAngleZ: [[0, 0], [1.6, 6], [3.4, -6], [5.2, 5], [7, 0]],
      bodyAngleX: [[0, 0], [1.6, 3], [3.4, -3], [5.2, 2.5], [7, 0]],
      angleZ: [[0, 0], [1.8, -10], [3.6, 10], [5.4, -8], [7, 0]],
      angleX: [[0, 0], [1.8, 6], [3.6, -6], [5.4, 5], [7, 0]],
      angleY: [[0, 0], [0.9, 3], [1.8, 0], [2.7, 3], [3.6, 0], [4.5, 3], [5.4, 0], [7, 0]],
      armAngle: [[0, 0], [1.6, 3], [3.4, -3], [5.2, 2], [7, 0]],
      handAngle: [[0, 0], [1.8, -4], [3.6, 4], [5.4, -3], [7, 0]],
      gazeX: [[0, 0], [1.8, -0.3], [3.6, 0.3], [5.4, -0.2], [7, 0]],
      eyeOpen: [[0, 1], [0.8, 0.82], [6.2, 0.82], [7, 1]],
      eyeSmile: [[0, 0], [0.8, 0.35], [6.2, 0.35], [7, 0]],
      // slow, even breaths in time with the sway
      breath: [[0, 0], [0.9, 1], [1.8, 0], [2.7, 1], [3.6, 0], [4.5, 1], [5.4, 0], [6.3, 0.8], [7, 0]]
    }
  },
  sigh: {
    label: "Sigh",
    dur: 5.6,
    idle: !0,
    tracks: {
      breath: [[0, 0], [1.3, 1.25], [1.9, 1.25], [3.6, 0], [5.6, 0]],
      angleY: [[0, 0], [1.3, 9], [1.9, 9], [3.3, -9], [4.6, -6], [5.6, 0]],
      angleZ: [[0, 0], [1.3, -3], [3.3, 5], [5.6, 0]],
      bodyAngleX: [[0, 0], [1.3, -2.5], [3.3, 2.5], [5.6, 0]],
      bodyAngleZ: [[0, 0], [1.9, 1], [3.3, -1.5], [5.6, 0]],
      armAngle: [[0, 0], [1.3, -2.5], [3.3, 2], [5.6, 0]],
      gazeY: [[0, 0], [1.2, 0.4], [2, 0.3], [3.2, -0.4], [4.8, -0.2], [5.6, 0]],
      eyeOpen: [[0, 1], [1, 0.95], [1.9, 0.6], [3.4, 0.6], [4.6, 0.78], [5.6, 1]],
      browY: [[0, 0], [1.3, 0.35], [3.2, -0.2], [5.6, 0]],
      browAngle: [[0, 0], [1.9, -0.4], [4.6, -0.35], [5.6, 0]]
    }
  },
  doze: {
    label: "Drowsy",
    dur: 7.2,
    idle: !0,
    tracks: {
      eyeOpen: [[0, 1], [1.8, 0.78], [3.2, 0.62], [4.5, 0.55], [4.75, 1.1], [5.6, 1.05], [7.2, 1]],
      angleY: [[0, 0], [1.8, -6], [3.2, -9], [4.5, -17], [4.75, 5], [5.6, 2], [7.2, 0]],
      angleZ: [[0, 0], [2, 4], [4.5, 10], [4.75, -2], [7.2, 0]],
      angleX: [[0, 0], [4.5, -4], [4.75, 3], [5.4, -6], [6.2, 5], [7.2, 0]],
      bodyAngleZ: [[0, 0], [4.5, 3], [4.8, -2], [7.2, 0]],
      bodyAngleX: [[0, 0], [4.5, 2], [4.8, -1.5], [7.2, 0]],
      armAngle: [[0, 0], [4.5, 3], [4.8, -2], [7.2, 0]],
      handAngle: [[0, 0], [4.5, 5], [4.8, -1], [7.2, 0]],
      gazeY: [[0, 0], [4.5, -0.4], [4.75, 0.2], [7.2, 0]],
      gazeX: [[0, 0], [4.8, 0], [5.3, -0.6], [6.1, 0.6], [6.8, 0]],
      browY: [[0, 0], [4.5, -0.35], [4.75, 0.8], [5.8, 0.3], [7.2, 0]],
      // long, slow, deepening breaths; a sharp inhale on waking
      breath: [[0, 0], [1.1, 0.7], [2.6, 0], [3.8, 0.6], [4.5, 0.2], [4.8, 1.1], [6, 0.2], [7.2, 0]]
    }
  },
  stretch: {
    label: "Stretch",
    dur: 6.2,
    idle: !0,
    tracks: {
      angleZ: [[0, 0], [1.3, -22], [2.3, -21], [3.8, 20], [4.8, 19], [6.2, 0]],
      angleY: [[0, 0], [1.3, 5], [2.3, 7], [3.1, -3], [3.8, 5], [4.8, 6], [6.2, 0]],
      angleX: [[0, 0], [1.3, -5], [3.8, 5], [6.2, 0]],
      bodyAngleZ: [[0, 0], [1.3, 4], [3.8, -4], [6.2, 0]],
      bodyAngleX: [[0, 0], [1.3, -2], [3.8, 2], [6.2, 0]],
      armAngle: [[0, 0], [1.3, 2], [3.8, -2], [6.2, 0]],
      eyeOpen: [[0, 1], [0.8, 0.62], [4.9, 0.62], [5.6, 1]],
      browAngle: [[0, 0], [1, -0.3], [4.9, -0.3], [5.8, 0]],
      breath: [[0, 0], [1.3, 1.1], [2.3, 0.9], [3.1, 0.2], [3.8, 1.1], [4.8, 0.9], [6.2, 0]]
    }
  },
  lean: {
    label: "Peek",
    dur: 4.8,
    idle: !0,
    tracks: {
      bodyAngleX: [[0, 0], [0.9, 6], [3.4, 6], [4.4, 0]],
      bodyAngleZ: [[0, 0], [0.9, -3], [3.4, -3], [4.4, 0]],
      angleX: [[0, 0], [0.9, 9], [2, 7], [2.6, 10], [3.4, 8], [4.4, 0]],
      angleY: [[0, 0], [0.9, -6], [3.4, -5], [4.4, 0]],
      angleZ: [[0, 0], [0.9, 10], [2.2, 12], [3.4, 9], [4.4, 0]],
      armAngle: [[0, 0], [0.9, -3], [3.4, -3], [4.4, 0]],
      handAngle: [[0, 0], [0.9, 3], [3.4, 3], [4.4, 0]],
      gazeY: [[0, 0], [0.6, 0.45], [3.4, 0.4], [4.2, 0]],
      gazeX: [[0, 0], [1.5, 0], [1.8, -0.3], [2.3, 0.2], [2.8, 0], [4.2, 0]],
      eyeOpen: [[0, 1], [0.6, 1.1], [3.4, 1.08], [4.2, 1]],
      browY: [[0, 0], [0.6, 0.45], [3.4, 0.4], [4.2, 0]],
      browAngle: [[0, 0], [0.6, -0.3], [3.4, -0.3], [4.2, 0]],
      blush: [[0, 0], [1.2, 0.25], [3.4, 0.25], [4.4, 0]],
      breath: [[0, 0], [0.8, 0.8], [3.4, 0.6], [4.4, 0], [4.8, 0.2]]
    }
  },
  hum: {
    label: "Listen",
    dur: 5.6,
    idle: !0,
    tracks: {
      angleY: [[0, 0], [0.45, -5], [0.9, 2], [1.35, -5], [1.8, 2], [2.25, -5], [2.7, 2], [3.15, -5], [3.6, 2], [4.05, -4], [4.8, 0]],
      angleZ: [[0, 0], [0.9, 8], [1.8, -8], [2.7, 8], [3.6, -8], [4.6, 0]],
      angleX: [[0, 0], [0.9, 4], [1.8, -4], [2.7, 4], [3.6, -4], [4.6, 0]],
      bodyAngleZ: [[0, 0], [0.9, -3], [1.8, 3], [2.7, -3], [3.6, 3], [4.6, 0]],
      bodyAngleX: [[0, 0], [1.8, 2], [3.6, -2], [4.8, 0]],
      handAngle: [[0, 0], [0.9, 3], [1.8, -3], [2.7, 3], [3.6, -3], [4.6, 0]],
      fingerTap: [[0, 0], [0.45, 1], [0.9, 0], [1.35, 1], [1.8, 0], [2.25, 1], [2.7, 0], [3.15, 1], [3.6, 0], [5.6, 0]],
      gazeX: [[0, 0], [0.9, 0.3], [1.8, -0.3], [2.7, 0.3], [3.6, -0.3], [4.6, 0]],
      eyeOpen: [[0, 1], [0.4, 0.72], [4.6, 0.72], [5.3, 1]],
      eyeSmile: [[0, 0], [0.4, 0.55], [4.6, 0.55], [5.3, 0]],
      blush: [[0, 0], [0.8, 0.3], [4.6, 0.3], [5.6, 0]],
      browY: [[0, 0], [0.5, 0.25], [4.6, 0.25], [5.4, 0]],
      breath: [[0, 0], [0.9, 0.9], [1.8, 0.2], [2.7, 0.9], [3.6, 0.2], [4.6, 0.8], [5.6, 0]]
    }
  },
  tap: {
    label: "Tap",
    dur: 5,
    idle: !0,
    tracks: {
      gazeX: [[0, 0], [0.3, -0.6], [2.2, -0.5], [2.5, -0.1], [2.8, -0.6], [4.2, -0.5], [4.7, 0]],
      gazeY: [[0, 0], [0.3, 0.55], [4.2, 0.5], [4.7, 0]],
      angleX: [[0, 0], [0.8, -11], [2.4, -9], [3, -12], [4.2, -10], [5, 0]],
      angleY: [[0, 0], [0.8, 8], [4.2, 7], [5, 0]],
      angleZ: [[0, 0], [0.8, 6], [2.4, 4], [3, 7], [4.2, 5], [5, 0]],
      bodyAngleX: [[0, 0], [1, -2], [4.2, -2], [5, 0]],
      handAngle: [[0, 0], [0.8, 3], [4.2, 3], [5, 0]],
      fingerTap: [
        [0, 0],
        [0.9, 0],
        [1.05, 1],
        [1.2, 0],
        [1.4, 1],
        [1.55, 0],
        [1.75, 1],
        [1.9, 0],
        [2.6, 0],
        [2.75, 1],
        [2.9, 0],
        [3.1, 1],
        [3.25, 0],
        [5, 0]
      ],
      browY: [[0, 0], [0.6, 0.3], [4.2, 0.25], [5, 0]],
      browAngle: [[0, 0], [0.6, -0.35], [4.2, -0.3], [5, 0]],
      eyeOpen: [[0, 1], [0.6, 0.9], [4.2, 0.9], [5, 1]],
      breath: [[0, 0], [0.8, 0.7], [2.2, 0.4], [3.2, 0.8], [4.4, 0], [5, 0.2]]
    }
  },
  readNote: {
    label: "Read script",
    dur: 2.6,
    idle: !0,
    tracks: {
      // a quick look down at the notes on the desk and back to the camera
      gazeY: [[0, 0], [0.2, -0.85], [1.5, -0.8], [1.75, 0], [2.6, 0]],
      gazeX: [[0, 0], [0.2, -0.15], [1.5, -0.1], [1.75, 0]],
      angleY: [[0, 0], [0.45, -9], [1.5, -8], [2, 1], [2.6, 0]],
      angleZ: [[0, 0], [0.5, 2], [1.6, 2], [2.6, 0]],
      eyeOpen: [[0, 1], [0.3, 0.78], [1.5, 0.78], [1.75, 1]],
      breath: [[0, 0.3], [0.8, 0.5], [1.8, 0.2], [2.6, 0.4]]
    }
  },
  waiting: {
    label: "Fidget",
    dur: 6.4,
    idle: !0,
    tracks: {
      // shifts her weight, checks the viewer, looks away, shifts back
      bodyAngleZ: [[0, 0], [0.9, 5], [2.4, 4], [3.3, -5], [5.2, -4], [6.4, 0]],
      bodyAngleX: [[0, 0], [0.9, 3], [3.3, -3], [5.2, -2], [6.4, 0]],
      angleZ: [[0, 0], [1, -6], [2.4, -4], [3.4, 6], [5.2, 5], [6.4, 0]],
      angleX: [[0, 0], [1.2, -8], [2.2, 2], [3.6, 12], [5, 10], [6.2, 0]],
      angleY: [[0, 0], [1.2, -3], [2.2, 2], [3.6, -2], [6.2, 0]],
      armAngle: [[0, 0], [0.9, 3], [3.3, -3], [5.2, -2], [6.4, 0]],
      handAngle: [[0, 0], [1.2, 3], [3.4, -3], [6.4, 0]],
      fingerTap: [[0, 0], [4.2, 0], [4.35, 1], [4.5, 0], [4.7, 1], [4.85, 0], [6.4, 0]],
      gazeX: [[0, 0], [0.9, -0.7], [1.9, -0.6], [2.1, 0], [2.7, 0], [2.9, 0.8], [5, 0.7], [5.4, 0], [6.4, 0]],
      gazeY: [[0, 0], [0.9, -0.2], [2.1, 0], [2.9, 0.3], [5.4, 0]],
      eyeOpen: [[0, 1], [2, 1], [2.2, 1.06], [2.8, 1.05], [3.1, 0.85], [5.4, 0.85], [6.2, 1]],
      browAngle: [[0, 0], [0.9, -0.35], [2, -0.35], [2.3, 0], [3.1, -0.4], [5.4, -0.35], [6.4, 0]],
      browY: [[0, 0], [2.2, 0.4], [2.8, 0.35], [3.2, 0], [6.4, 0]],
      breath: [[0, 0.3], [0.9, 0.8], [2, 0.3], [2.6, 0.9], [3.4, 0.2], [4.4, 0.8], [5.6, 0], [6.4, 0.2]]
    }
  },
  spaceOut: {
    label: "Daydream",
    dur: 7.4,
    idle: !0,
    tracks: {
      // gaze drifts up and away, breaths get slow and long, one slow blink
      gazeX: [[0, 0], [1.4, -0.55], [4.8, -0.6], [5.6, 0.1], [7, 0]],
      gazeY: [[0, 0], [1.4, 0.6], [4.8, 0.55], [5.6, 0], [7, 0]],
      angleX: [[0, 0], [2, -9], [4.8, -10], [6, 2], [7.4, 0]],
      angleY: [[0, 0], [2, 7], [4.8, 8], [6, -2], [7.4, 0]],
      angleZ: [[0, 0], [2, 9], [4.8, 11], [6, 2], [7.4, 0]],
      bodyAngleZ: [[0, 0], [2.2, 3], [4.8, 3.5], [6.4, 0]],
      bodyAngleX: [[0, 0], [2.2, -2], [4.8, -2], [6.4, 0]],
      handAngle: [[0, 0], [2.2, 4], [4.8, 5], [6.4, 0]],
      armAngle: [[0, 0], [2.2, 2], [4.8, 2], [6.4, 0]],
      eyeOpen: [[0, 1], [1.4, 0.8], [3, 0.8], [3.35, 0.56], [3.8, 0.8], [4.8, 0.8], [5.6, 1.04], [6.4, 1]],
      browY: [[0, 0], [1.6, 0.15], [4.8, 0.15], [5.6, 0.35], [6.6, 0]],
      breath: [[0, 0], [1.6, 0.9], [3.4, 0], [5, 0.9], [6.2, 0.1], [7.4, 0]]
    }
  }
};
function da(a, e) {
  if (e <= a[0][0]) return a[0][1];
  const t = a.length - 1;
  if (e >= a[t][0]) return a[t][1];
  let r = 0;
  for (; e > a[r + 1][0]; ) r++;
  const [s, i] = a[r], [c, m] = a[r + 1], E = (h) => h <= 0 || h >= t ? 0 : (a[h + 1][1] - a[h - 1][1]) / (a[h + 1][0] - a[h - 1][0]), v = c - s, M = (e - s) / v, u = E(r) * v, x = E(r + 1) * v, S = M * M, y = S * M;
  return (2 * y - 3 * S + 1) * i + (y - 2 * S + M) * u + (-2 * y + 3 * S) * m + (y - S) * x;
}
const Ue = {
  a: { open: 0.9, form: 0, label: "あ" },
  i: { open: 0.5, form: -0.85, label: "い" },
  u: { open: 0.4, form: 0.9, label: "う" },
  e: { open: 0.62, form: -0.4, label: "え" },
  o: { open: 0.75, form: 0.6, label: "お" },
  n: { open: 0, form: null, label: "ん" }
  // closes with the previous shape
}, ga = {
  a: "あかさたなはまやらわがざだばぱぁ",
  i: "いきしちにひみりぎじぢびぴぃ",
  u: "うくすつぬふむゆるぐずづぶぷぅゔ",
  e: "えけせてねへめれげぜでべぺぇ",
  o: "おこそとのほもよろをごぞどぼぽぉ"
}, Bt = {};
for (const [a, e] of Object.entries(ga)) for (const t of e) Bt[t] = a;
const ya = /* @__PURE__ */ new Set([..."まみむめもばびぶべぼぱぴぷぺぽ"]), ba = /* @__PURE__ */ new Set([..."あいうえおぁぃぅぇぉ"]), Mt = { ゃ: "a", ゅ: "u", ょ: "o" }, va = /* @__PURE__ */ new Set([..."、。，．,.！？!? 　…"]), wa = (a) => a.replace(/[ァ-ヶ]/g, (e) => String.fromCharCode(e.charCodeAt(0) - 96));
function xa(a, e = 0.14) {
  const t = [];
  for (const r of wa(a)) {
    const s = t[t.length - 1];
    if (Mt[r] && s) {
      s.vowel = Mt[r];
      continue;
    }
    if (r === "ー" && s) {
      s.dur += e;
      continue;
    }
    if (r === "っ") {
      t.push({ vowel: "n", dur: e * 0.8, onset: null });
      continue;
    }
    if (r === "ん") {
      t.push({ vowel: "n", dur: e, onset: null });
      continue;
    }
    if (va.has(r)) {
      t.push({ vowel: "n", dur: e * 2.2, onset: null });
      continue;
    }
    const i = Bt[r];
    i && t.push({ vowel: i, dur: e, onset: ya.has(r) ? "lips" : ba.has(r) ? null : "consonant" });
  }
  return t;
}
function Aa(a, e, t = 0.5) {
  if (t !== 0.5) return Ma(a, e, t);
  let r = 0;
  for (const s of a) {
    if (e < r + s.dur) {
      const i = (e - r) / s.dur, c = Ue[s.vowel], m = s.onset === "lips" ? 0.05 : s.onset === "consonant" ? 0.45 : 1, E = i < 0.35 ? m + (1 - m) * (i / 0.35) : 1;
      return { open: c.open * E, form: c.form, vowel: s.vowel };
    }
    r += s.dur;
  }
  return null;
}
function Ma(a, e, t) {
  const r = t < 0.5 ? (0.5 - t) * 0.72 : 0;
  let s = 0, i = 0, c = null;
  for (const m of a) {
    let E = m.vowel;
    if (m.vowel === "n" ? r && m.dur <= 0.2 && c ? E = c : (i = 0, c = null) : ((!c || i >= r) && (c = m.vowel, i = 0), i += m.dur, r && (E = c)), e < s + m.dur) {
      const v = Ue[E], M = m.onset === "lips" ? 0.05 : m.onset === "consonant" ? 0.45 : 1, u = t < 0.5 ? 1 - (1 - M) * t * 2 : M * (2 - t * 2), x = Math.min(m.dur * 0.35, 0.05), S = (e - s) / x;
      return { open: v.open * (S < 1 ? u + (1 - u) * S : 1), form: v.form, vowel: E };
    }
    s += m.dur;
  }
  return null;
}
const Ge = { ...lt, ...ht }, Et = { amp: 1, stiff: 1.8 }, Ea = /^(angle|bodyAngle|armAngle|handAngle)/, Sa = /* @__PURE__ */ new Set([
  "eyeOpen",
  "eyeOpenL",
  "eyeSmileL",
  "eyeSmile",
  "mouthOpen",
  "mouthForm",
  "blush",
  "browY",
  "browAngle"
]), De = (a, e, t) => {
  const r = Math.min(1, Math.max(0, (t - a) / (e - a)));
  return r * r * (3 - 2 * r);
};
function St(a, e) {
  const t = Math.floor(a), r = a - t, s = (c) => {
    const m = Math.sin((c + e * 57.3) * 127.1) * 43758.5453;
    return m - Math.floor(m);
  }, i = r * r * (3 - 2 * r);
  return (s(t) * (1 - i) + s(t + 1) * i) * 2 - 1;
}
const be = (a, e) => St(a, e) * 0.7 + St(a * 2.3, e + 9) * 0.3, ce = (a, e, t) => Math.max(e, Math.min(t, a)), Yt = {
  normal: { label: "Neutral", p: {} },
  smile: { label: "Smile", p: { eyeOpen: 0, eyeSmile: 1, blush: 0.35, browY: 0.2 } },
  shy: { label: "Blush", p: { eyeOpen: 0.78, eyeSmile: 0.5, blush: 1, browAngle: -0.5, browY: -0.1, glance: [0.7, 0.35] } },
  jito: { label: "Half-lidded", p: { eyeOpen: 0.5, browY: -0.5, browAngle: 0.6 } },
  surprise: { label: "Surprise", p: { eyeOpen: 1.22, browY: 1, mouthOpen: 0.6, mouthForm: 0.6 } },
  wink: { label: "Wink", p: { eyeOpenL: 0, eyeSmileL: 1, blush: 0.3 } },
  // talking faces for AITuber OnAir emotion tags: eyes stay mostly open (closed / ^^ eyes are
  // what a single image fakes worst, and they would stay shut for a whole sentence)
  happyTalk: { label: "happy", p: { eyeOpen: 0.8, eyeSmile: 0.45, blush: 0.35, browY: 0.25, mouthForm: -0.5 } },
  sadTalk: { label: "sad", p: { eyeOpen: 0.78, browAngle: -0.8, browY: -0.2, mouthForm: 0.3, glance: [0, -0.35] } },
  angryTalk: { label: "angry", p: { eyeOpen: 0.72, browAngle: 0.85, browY: -0.55, mouthForm: 0.2 } },
  surprisedTalk: { label: "surprised", p: { eyeOpen: 1.18, browY: 0.9, mouthForm: 0.9 } },
  relaxedTalk: { label: "relaxed", p: { eyeOpen: 0.82, eyeSmile: 0.35, blush: 0.15, browY: 0.1 } }
}, Rt = {
  happy: ["happyTalk", "nod"],
  sad: ["sadTalk", "sigh"],
  angry: ["angryTalk", "no"],
  surprised: ["surprisedTalk", "surprise"],
  relaxed: ["relaxedTalk", "sway"],
  neutral: ["normal", null]
}, Ra = {
  gazeX: [260, 0.9],
  gazeY: [260, 0.9],
  angleX: [55, 0.72],
  angleY: [55, 0.72],
  angleZ: [45, 0.75],
  bodyAngleX: [14, 0.9],
  bodyAngleZ: [12, 0.9],
  armAngle: [20, 0.85],
  handAngle: [30, 0.8]
};
class La {
  /** @param {number[]} gazeCenter */
  constructor(e) {
    this.mode = "auto", this.P = Object.fromEntries(ze.map((t) => [t.id, t.def])), this.manual = { ...this.P }, this.cur = { ...this.P }, this.vel = Object.fromEntries(ze.map((t) => [t.id, 0])), this.expr = "normal", this.exprMix = {}, this.t = 0, this.blink = { t: 0, start: 1.5, double: !1 }, this.gaze = { x: 0, y: 0, next: 0 }, this.tap = { next: 4, until: -1 }, this.pointer = null, this.faceCenter = [...e], this.lipOpen = null, this.lipForm = 0, this.speaking = !1, this.voice = 0, this.mouth = 0, this.vowel = "a", this.vowelForm = 0, this.lipSync = xt(), this.lipMotion = At(this.lipSync), this.syllableArmed = !0, this.voicePeak = 0, this.voiceTrough = 0, this.kana = null, this.lipHold = null, this.emotionUntil = 0, this.talkGain = 1, this.play = null, this.autoMotion = !0, this.nextAuto = 14, this.autoIdle = !0, this.nextIdle = 3, this.lastAuto = null, this.onMotion = null;
  }
  setExpression(e) {
    this.expr = e;
  }
  hasMotion(e) {
    return e in Ge;
  }
  // ---- speech (driven from outside, e.g. by the TTS audio analyser) ----
  setVoiceLevel(e) {
    this.voice = Math.min(1, Math.max(0, Number(e) || 0));
  }
  setLipSync(e) {
    this.lipSync = xt(e, this.lipSync), this.lipMotion = At(this.lipSync);
  }
  setSpeaking(e) {
    e !== this.speaking && (this.speaking = !!e, e || (this.emotionUntil = this.t + 1.2, this.voice = 0));
  }
  /** `playMotion: false` changes only the face (a caller that picks motions itself). */
  setEmotion(e, { playMotion: t = !0 } = {}) {
    const r = Rt[e] ?? Rt.neutral;
    this.expr = r[0], this.emotionUntil = 1 / 0, r[1] && t && this.playMotion(r[1]);
  }
  /** Mouth shapes from kana text, without audio (preview / tuning). */
  /** @param {string} text @param {{ speed?: number, loop?: boolean }} [options] */
  speakKana(e, { speed: t, loop: r = !1 } = {}) {
    this.lipHold = null;
    const s = xa(e, t === void 0 ? 0.14 : 1 / ce(Number(t) || 7, 4, 12));
    this.kana = s.length ? { moras: s, t: 0, loop: r, duration: s.reduce((i, c) => i + c.dur, 0) } : null;
  }
  holdMouth(e) {
    this.kana = null, this.lipHold = Object.hasOwn(Ue, e) ? e : null;
  }
  stopLipSync() {
    this.kana = null, this.lipHold = null, this.lipOpen = null, this.mouth = 0;
  }
  getLipSyncState() {
    return { active: this.kana !== null || this.lipHold !== null, open: this.P.mouthOpen, form: this.P.mouthForm };
  }
  // Mouth from the TTS loudness. A volume signal has no vowel information, so each syllable
  // (the voice dipping and rising again) gets one vowel at random, weighted towards a, and
  // keeps it until the next syllable: the drawn mouths must not change shape mid-syllable.
  // Syllables are found relative to the recent peak (not an absolute level), and the mouth
  // is scaled by where the voice sits between the recent trough and peak, so it closes in
  // the dip before each mora even when a loud voice never gets quiet.
  speechMouth(e) {
    if (this.kana || this.lipHold) {
      let x;
      if (this.lipHold ? x = Ue[this.lipHold] : (this.kana.t += e, this.kana.loop && (this.kana.t %= this.kana.duration), x = Aa(this.kana.moras, this.kana.t, this.lipSync.granularity)), !x)
        return this.kana = null, this.mouth > 0.01 ? [this.mouth *= this.lipSync.closeSpeed === 0.5 ? 0.6 : Math.exp(-e * this.lipMotion.kanaRelease), this.vowelForm] : null;
      const S = this.lipMotion.openness === 1 ? x.open : Math.min(1, x.open * this.lipMotion.openness), y = S > this.mouth ? 1 - Math.exp(-e * 30) : 1 - Math.exp(-e * this.lipMotion.kanaRelease);
      return this.mouth += (S - this.mouth) * y, x.form !== null && (this.vowelForm = x.form), [this.mouth, this.vowelForm];
    }
    const t = this.speaking ? this.voice : 0, r = 1 - Math.exp(-e * this.lipMotion.relax);
    this.voicePeak = t > this.voicePeak ? t : this.voicePeak + (t - this.voicePeak) * r, this.voiceTrough = t < this.voiceTrough ? t : this.voiceTrough + (t - this.voiceTrough) * r;
    const s = Math.max(this.voicePeak, 0.05);
    if (t < s * this.lipMotion.arm) this.syllableArmed = !0;
    else if (this.syllableArmed && t > s * this.lipMotion.trigger && t > 0.1) {
      this.syllableArmed = !1;
      const x = Math.random();
      this.vowel = x < 0.4 ? "a" : x < 0.58 ? "o" : x < 0.74 ? "e" : x < 0.88 ? "i" : "u";
    }
    const i = this.voicePeak - this.voiceTrough, c = i < s * this.lipMotion.range ? 1 : Math.max(0, (t - this.voiceTrough) / i), m = Ue[this.vowel ?? "a"], E = Math.min(1, Math.pow(t, 0.7) * 1.15) * Math.pow(c, this.lipMotion.risePower), v = this.speaking ? Math.min(0.95, E) * (0.45 + 0.55 * m.open / 0.9) : 0, M = this.lipMotion.openness === 1 ? v : Math.min(1, v * this.lipMotion.openness), u = M > this.mouth ? 1 - Math.exp(-e * 40) : 1 - Math.exp(-e * this.lipMotion.audioRelease);
    return this.mouth += (M - this.mouth) * u, this.speaking && (this.vowelForm = m.form), this.speaking || this.mouth > 0.01 ? [this.mouth, this.vowelForm] : null;
  }
  // Breathing: inhale ~40% of the cycle, a slower exhale, a short pause at the bottom,
  // and a period that drifts between ~3.2 and 4.6 s so it never looks metronomic.
  breathValue(e) {
    this.breathPhase = (this.breathPhase ?? 0) + e / (this.breathPeriod ?? 3.8), this.breathPhase >= 1 && (this.breathPhase -= 1, this.breathPeriod = 3.2 + Math.random() * 1.4);
    const t = this.breathPhase;
    return t < 0.4 ? De(0, 0.4, t) : t < 0.88 ? 1 - De(0.4, 0.88, t) : 0;
  }
  // pick one at random, never the one that just played
  playRandom(e) {
    const t = e.filter((r) => r !== this.lastAuto);
    this.playMotion(t[Math.floor(Math.random() * t.length)]);
  }
  playMotion(e) {
    this.lastAuto = e, this.play = { id: e, t: 0 }, this.onMotion?.(e);
  }
  blinkValue(e) {
    const t = this.blink;
    if (t.t += e, t.t < t.start) return 1;
    const r = (t.t - t.start) / 0.17;
    return r >= 1 ? (t.double ? (t.double = !1, t.start = t.t + 0.07) : (t.start = t.t + 1.8 + Math.random() * 4.2, t.double = Math.random() < 0.18), 1) : r < 0.45 ? 1 - r / 0.45 : (r - 0.45) / 0.55;
  }
  update(e) {
    this.t += e;
    const t = this.t, r = {};
    for (const y of ze) r[y.id] = y.def;
    if (this.mode === "manual")
      Object.assign(r, this.manual);
    else if (this.mode === "auto") {
      if (r.angleX = be(t * 0.18, 1) * 10 + this.gaze.x * 11, r.angleY = be(t * 0.15, 2) * 6 - 1 + this.gaze.y * 7, r.angleZ = be(t * 0.12, 3) * 10, r.bodyAngleX = be(t * 0.1, 4) * 5, r.bodyAngleZ = be(t * 0.09, 5) * 4, r.armAngle = be(t * 0.14, 6) * 5, r.handAngle = be(t * 0.21, 7) * 5, t > this.gaze.next) {
        const y = Math.random();
        this.gaze.x = y < 0.45 ? 0 : (Math.random() * 2 - 1) * 0.8, this.gaze.y = y < 0.45 ? 0 : (Math.random() * 2 - 1) * 0.5, this.gaze.next = t + 0.8 + Math.random() * 2.5;
      }
      if (r.gazeX = this.gaze.x + r.angleX / 60, r.gazeY = this.gaze.y + r.angleY / 60, t > this.tap.next && (this.tap.until = t + 1.1, this.tap.next = t + 5 + Math.random() * 6), this.speaking) {
        this.nextIdle = Math.max(this.nextIdle, t + 2.5), this.nextAuto = Math.max(this.nextAuto, t + 6);
        const y = this.talkGain;
        this.talkNod = (this.talkNod ?? 0) + (this.voice * 7 * y - (this.talkNod ?? 0)) * Math.min(1, e * 6), r.angleY -= this.talkNod, r.angleX += be(t * 0.6, 11) * 5 * y, r.angleZ += be(t * 0.5, 12) * 4 * y;
      }
      !this.speaking && t > this.emotionUntil && (this.expr = "normal", this.emotionUntil = 1 / 0), this.speaking || (!this.play && this.autoMotion && t > this.nextAuto ? (this.playRandom(Object.keys(lt).filter((y) => y !== "surprise")), this.nextAuto = t + 15 + Math.random() * 10, this.nextIdle = Math.max(this.nextIdle, t + 5)) : !this.play && this.autoIdle && t > this.nextIdle && (this.playRandom(Object.keys(ht)), this.nextIdle = t + 5 + Math.random() * 5));
    } else if (this.mode === "mouse" && this.pointer) {
      const y = (this.pointer[0] - this.faceCenter[0]) / 500, h = (this.pointer[1] - this.faceCenter[1]) / 500;
      r.angleX = ce(y * 30, -30, 30), r.angleY = ce(-h * 30, -30, 30), r.angleZ = ce(-y * h * 25, -12, 12), r.bodyAngleX = ce(y * 10, -10, 10) * 0.6, r.gazeX = ce(y * 1.4, -1, 1), r.gazeY = ce(-h * 1.4, -1, 1), r.handAngle = ce(y * 4, -5, 5);
    }
    this.mode !== "manual" && (r.breath = this.breathValue(e), t < this.tap.until && (r.fingerTap = Math.max(0, Math.sin((this.tap.until - t) * Math.PI * 3.6)) ** 2));
    let s = null, i = 0;
    if (this.play) {
      const y = Ge[this.play.id];
      if (this.play.t += e, this.play.t >= y.dur)
        this.play = null, this.onMotion?.(null);
      else {
        s = {};
        for (const [h, l] of Object.entries(y.tracks))
          s[h] = da(l, this.play.t) * (y.idle && Ea.test(h) ? Et.amp : 1);
        i = De(0, 0.15, this.play.t) * (1 - De(y.dur - 0.25, y.dur, this.play.t));
        for (const [h, l] of Object.entries(s))
          pa.has(h) ? r[h] += l : h === "breath" ? r[h] += (l - r[h]) * i : Sa.has(h) || (r[h] = Math.max(r[h], Math.max(0, l)));
      }
    }
    this.mode !== "manual" && (r.angleY += r.breath * 1.6);
    const c = Yt[this.expr].p, m = ["eyeOpen", "eyeOpenL", "eyeSmileL", "eyeSmile", "mouthOpen", "mouthForm", "blush", "browY", "browAngle", "gx", "gy"], E = {
      eyeOpen: c.eyeOpen ?? 1,
      eyeOpenL: c.eyeOpenL ?? c.eyeOpen ?? 1,
      eyeSmileL: c.eyeSmileL ?? c.eyeSmile ?? 0,
      eyeSmile: c.eyeSmile ?? 0,
      mouthOpen: c.mouthOpen ?? 0,
      mouthForm: c.mouthForm ?? 0,
      blush: c.blush ?? 0,
      browY: c.browY ?? 0,
      browAngle: c.browAngle ?? 0,
      gx: c.glance?.[0] ?? 0,
      gy: c.glance?.[1] ?? 0
    }, v = 1 - Math.exp(-e * 9);
    for (const y of m)
      this.exprMix[y] === void 0 && (this.exprMix[y] = E[y]), this.exprMix[y] += (E[y] - this.exprMix[y]) * v;
    const M = this.exprMix, u = {};
    for (const y of ze) {
      const h = y.id;
      if (this.mode === "manual" && !s) {
        u[h] = r[h], this.cur[h] = r[h], this.vel[h] = 0;
        continue;
      }
      let [l, d] = Ra[h] ?? [120, 0.95];
      s && /^angle|^body/.test(h) && (Ge[this.play?.id ?? ""]?.idle ? (l *= Et.stiff, d = 0.8) : /^angle/.test(h) && (l *= 4.5, d = 0.75));
      const n = 2 * Math.sqrt(l) * d;
      this.vel[h] += (l * (r[h] - this.cur[h]) - n * this.vel[h]) * e, this.cur[h] += this.vel[h] * e, u[h] = this.cur[h];
    }
    let x = 1;
    if (this.mode !== "manual" ? (x = this.blinkValue(e), u.eyeROpen = M.eyeOpen * x, u.eyeLOpen = M.eyeOpenL * x, u.eyeSmile = M.eyeSmile, u.eyeSmileL = M.eyeSmileL, u.mouthOpen = M.mouthOpen, u.mouthForm = M.mouthForm, u.blush = M.blush, u.browY = M.browY + (u.angleY > 0 ? u.angleY / 60 : 0) - (1 - x) * 0.18, u.browAngle = M.browAngle, u.gazeX = ce(u.gazeX + M.gx, -1, 1), u.gazeY = ce(u.gazeY + M.gy, -1, 1)) : u.eyeSmileL = u.eyeSmile, s) {
      const y = (l, d) => {
        u[l] += (d - u[l]) * i;
      }, h = (l) => Math.min(1.3, Math.max(0, l));
      "eyeOpen" in s && (y("eyeROpen", h(s.eyeOpen) * x), "eyeOpenL" in s || y("eyeLOpen", h(s.eyeOpen) * x)), "eyeOpenL" in s && y("eyeLOpen", h(s.eyeOpenL) * x), "eyeSmile" in s && (y("eyeSmile", s.eyeSmile), "eyeSmileL" in s || y("eyeSmileL", s.eyeSmile)), "eyeSmileL" in s && y("eyeSmileL", s.eyeSmileL);
      for (const l of ["mouthOpen", "mouthForm", "blush", "browY", "browAngle"])
        l in s && y(l, l === "mouthOpen" || l === "blush" ? Math.max(0, s[l]) : s[l]);
    }
    const S = this.speechMouth(e);
    return S ? (this.lipOpen = S[0], this.lipForm = S[1]) : this.lipOpen !== null && !this.speaking && !this.kana && (this.lipOpen = null), this.lipOpen !== null && (u.mouthOpen = Math.max(u.mouthOpen * 0.3, this.lipOpen), u.mouthForm = ce(this.lipForm, -1, 1)), this.P = u, u;
  }
}
const ut = {
  neutral: "normal",
  smile: "smile",
  shy: "shy",
  surprise: "surprise",
  halfLidded: "jito",
  angry: "angryTalk",
  sad: "sadTalk",
  wink: "wink"
}, Oa = { sad: { pitch: -6, gy: -0.45 } }, _e = (a, e, t) => Math.max(e, Math.min(t, a)), Be = Object.freeze({ eyeOpen: 1, eyeOpenL: 1, eyeSmile: 0, eyeSmileL: 0, blush: 0, browY: 0, browAngle: 0, mouthOpen: 0, gx: 0, gy: 0, pitch: 0 });
function Ta(a) {
  const e = Yt[ut[a]]?.p ?? {}, t = Oa[a] ?? {};
  return {
    eyeOpen: e.eyeOpen ?? 1,
    eyeOpenL: e.eyeOpenL ?? e.eyeOpen ?? 1,
    eyeSmile: e.eyeSmile ?? 0,
    eyeSmileL: e.eyeSmileL ?? e.eyeSmile ?? 0,
    blush: e.blush ?? 0,
    browY: e.browY ?? 0,
    browAngle: e.browAngle ?? 0,
    mouthOpen: e.mouthOpen ?? 0,
    gx: e.glance?.[0] ?? 0,
    gy: t.gy ?? e.glance?.[1] ?? 0,
    pitch: t.pitch ?? 0
  };
}
function ka(a, e) {
  const t = { ...a };
  return t.eyeROpen = (a.eyeROpen ?? 1) * e.eyeOpen, t.eyeLOpen = (a.eyeLOpen ?? 1) * e.eyeOpenL, t.eyeSmile = Math.max(a.eyeSmile ?? 0, e.eyeSmile), t.eyeSmileL = Math.max(a.eyeSmileL ?? a.eyeSmile ?? 0, e.eyeSmileL), t.blush = Math.max(a.blush ?? 0, e.blush), t.browY = _e((a.browY ?? 0) + e.browY, -1, 1), t.browAngle = _e((a.browAngle ?? 0) + e.browAngle, -1, 1), t.mouthOpen = Math.max(a.mouthOpen ?? 0, e.mouthOpen), t.gazeX = _e((a.gazeX ?? 0) + e.gx, -1, 1), t.gazeY = _e((a.gazeY ?? 0) + e.gy, -1, 1), t.angleY = _e((a.angleY ?? 0) + e.pitch, -30, 30), t;
}
class Fa {
  /** @type {keyof typeof OVERLAY_EXPRESSIONS} */
  name = "neutral";
  mix = { ...Be };
  /** @param {string} name */
  set(e) {
    this.name = Object.hasOwn(ut, e) ? (
      /** @type {keyof typeof OVERLAY_EXPRESSIONS} */
      e
    ) : "neutral";
  }
  /** True while an expression is shown or still fading out. */
  get active() {
    return this.name !== "neutral" || Object.keys(Be).some((e) => Math.abs(this.mix[e] - Be[e]) > 1e-3);
  }
  apply(e, t) {
    if (!this.active)
      return this.mix = { ...Be }, e;
    const r = Ta(this.name), s = 1 - Math.exp(-Math.max(0, t) * 12);
    for (const i of Object.keys(Be)) this.mix[i] += (r[i] - this.mix[i]) * s;
    return ka(e, this.mix);
  }
}
const Lt = ["ball", "low", "crease", "lash"], Ve = /* @__PURE__ */ new Map(), qe = /* @__PURE__ */ new Map();
async function Je(a) {
  return qe.has(a) || qe.set(a, fetch(a).then((e) => {
    if (!e.ok) throw new Error(`failed to load ${a}`);
    return e.json();
  })), qe.get(a);
}
function Ke(a) {
  if (Ve.has(a)) return Ve.get(a);
  const e = new Promise((t, r) => {
    const s = new Image();
    s.onload = () => t(s), s.onerror = () => r(new Error(`failed to load ${a}`)), s.src = a;
  });
  return Ve.set(a, e), e;
}
function Ut(a, e) {
  const t = document.createElement("canvas");
  t.width = a.width, t.height = a.height;
  const r = t.getContext("2d");
  r.drawImage(a, 0, 0);
  const s = r.getImageData(0, 0, t.width, t.height).data, i = new Uint8Array(t.width * t.height);
  for (let c = 0; c < i.length; c++) i[c] = s[c * 4 + e];
  return i;
}
const Le = (a) => Ut(a, 3);
function _a(a, [e, t, r, s]) {
  const i = document.createElement("canvas");
  return i.width = r, i.height = s, i.getContext("2d").drawImage(a, e, t, r, s, 0, 0, r, s), i;
}
function Ba(a, e) {
  const [t, r] = a.t.pivot, s = a.dir, i = a.pts, c = (S, y, h) => {
    const l = Math.min(1, Math.max(0, (h - S) / (y - S)));
    return l * l * (3 - 2 * l);
  }, m = Math.cos(a.phi[0]), E = Math.sin(a.phi[0]), v = Math.cos(a.phi[1]), M = Math.sin(a.phi[1]), u = e.rest, x = e.pos;
  for (let S = 0; S < u.length; S += 2) {
    const y = u[S] - t, h = u[S + 1] - r, l = y * s[0] + h * s[1], d = i[0][0] + y * m - h * E, n = i[0][1] + y * E + h * m, o = y - s[0] * a.L1, L = h - s[1] * a.L1, f = i[1][0] + o * v - L * M, g = i[1][1] + o * M + L * v, B = c(a.L1 * 0.55, a.L1 * 1.35, l);
    x[S] = d + (f - d) * B, x[S + 1] = n + (g - n) * B;
  }
}
async function Ya(a, e) {
  if (!e.assets && e.assetsBase === void 0)
    throw new Error("createMeshAvatar requires assets or assetsBase.");
  const t = e.rig, r = Gt(t), {
    IMG: s,
    EYES: i,
    baseWeights: c,
    deformBase: m,
    eyePartY: E,
    eyePartAlpha: v,
    handWeights: M,
    handFrame: u,
    deformHand: x,
    TASSELS: S
  } = r, { Renderer: y, buildGrid: h } = la(r, t), { Physics: l } = ha(r, t), { createSprites: d } = ua(r, t), n = (e.assetsBase ?? "").replace(/\/?$/, "/"), o = (p, R) => {
    if (e.assets) {
      if (!e.assets[p]) throw new Error(`Missing project asset: ${p}`);
      return e.assets[p];
    }
    return `${n}${p}${R === void 0 ? "" : `?b=${R}`}`;
  }, L = await Je(o("layers.json")), f = ["base", ...t.hand ? ["hand"] : [], ...S.map((p) => p.name), ...[0, 1].flatMap((p) => Lt.map((R) => `eye${p}_${R}`)), "hairmask"], g = Object.fromEntries(await Promise.all(f.map(async (p) => [p, await Ke(o(`${p}.png`, L.build))]))), B = Ut(g.hairmask, 0), U = (p, R) => B[Math.min(s.h - 1, Math.max(0, Math.round(R))) * s.w + Math.min(s.w - 1, Math.max(0, Math.round(p)))] / 255, D = new y(a, { padTop: e.padTop ?? t.view.padTop, padSide: e.padSide ?? t.view.padSide, fit: e.fit }), _ = { base: [0, 0, s.w, s.h], ...L.layers }, P = h(_.base, t.mesh.baseCell, Le(g.base), g.base.width, t.mesh.fine), O = [];
  for (let p = 0; p < P.rest.length / 2; p++) {
    const R = P.rest[p * 2], z = P.rest[p * 2 + 1];
    O.push(c(R, z, U(R, z)));
  }
  D.addLayer("base", g.base, P, { face: !0 });
  const j = [];
  i.forEach((p, R) => {
    for (const z of Lt) {
      const K = `eye${R}_${z}`, Q = h(_[K], z === "ball" ? t.mesh.eyeBallCell : t.mesh.eyeCell, Le(g[K]), g[K].width), re = [];
      for (let ne = 0; ne < Q.rest.length / 2; ne++) re.push(c(Q.rest[ne * 2], Q.rest[ne * 2 + 1], 0));
      const ie = D.addLayer(K, g[K], Q, { eyeBall: z === "ball" ? R : void 0 });
      j.push({ e: p, eye: R, part: z, mesh: Q, W: re, layer: ie });
    }
  });
  let I = null;
  try {
    {
      const p = await Je(o("sprites/sprites.json")), R = Object.fromEntries(await Promise.all(Object.keys(p.layers).map(async (z) => [z, await Ke(o(`sprites/${z}.png`, p.build))])));
      I = d(D, p, R, h, Le);
    }
  } catch (p) {
    console.warn("eye / mouth sprites not loaded:", p);
  }
  let q = null;
  try {
    const p = await Je(o("overlays/overlays.json")), R = Object.fromEntries(await Promise.all(p.overlays.map(async (z) => [z.name, await Ke(o(`overlays/${z.file}`))])));
    q = ma(D, p, R, h, Le, c, t.mesh.spriteCell, s.w, s.h, _a);
  } catch (p) {
    e.assets?.["overlays/overlays.json"] && console.warn("overlay layers not loaded:", p);
  }
  const N = S.map((p) => {
    const R = h(_[p.name], t.mesh.tasselCell, Le(g[p.name]), g[p.name].width);
    return D.addLayer(p.name, g[p.name], R);
  }), Z = t.hand ? h(_.hand, t.mesh.handCell, Le(g.hand), g.hand.width) : { rest: [], pos: [] }, H = [];
  for (let p = 0; p < Z.rest.length / 2; p++) H.push(M(Z.rest[p * 2], Z.rest[p * 2 + 1]));
  t.hand && D.addLayer("hand", g.hand, Z);
  const J = new l(), C = new La(t.view.gazeCenter ?? [t.head.cx, t.head.cy]);
  e.lipSync !== void 0 && C.setLipSync(e.lipSync);
  const V = /* @__PURE__ */ new Set();
  C.onMotion = (p) => {
    for (const R of V) R(p);
  };
  let Y = {}, W = 1, ee = {};
  const b = new Fa(), w = [0, 0];
  function A(p) {
    const R = { ...C.update(p) };
    for (const [K, Q] of Object.entries(Y)) R[K] = W === 1 ? Q : (R[K] ?? 0) + (Q - (R[K] ?? 0)) * W;
    C.lipOpen !== null && (R.mouthOpen = C.P.mouthOpen, (!e.preserveMouthForm || Y.mouthForm === void 0) && (R.mouthForm = C.P.mouthForm));
    const z = b.apply(R, p);
    return ee = z, z;
  }
  function T(p) {
    const R = A(p), z = J.step(R, p), K = P.pos, Q = P.rest;
    for (let G = 0; G < O.length; G++)
      m(Q[G * 2], Q[G * 2 + 1], O[G], R, z, w), K[G * 2] = w[0], K[G * 2 + 1] = w[1];
    const re = (G, Re) => I?.eyesDrawn[Re] ? 1 : G;
    for (const G of j) {
      const Re = re(G.eye === 0 ? R.eyeROpen : R.eyeLOpen, G.eye), ft = G.eye === 0 ? R.eyeSmile : R.eyeSmileL ?? R.eyeSmile;
      G.layer.alpha = v(G.part, Re, ft);
      const mt = G.mesh.rest, pt = G.mesh.pos;
      for (let Ae = 0; Ae < G.W.length; Ae++) {
        const dt = mt[Ae * 2], Ht = mt[Ae * 2 + 1];
        m(dt, E(G.e, G.part, dt, Ht, Re, ft), G.W[Ae], R, z, w), pt[Ae * 2] = w[0], pt[Ae * 2 + 1] = w[1];
      }
    }
    const ie = I?.update(R, z, p, ca(b.name, C.mode === "manual" ? null : C.expr));
    if (ie) for (const G of j) ie.eyes[G.eye] && (G.layer.alpha = 0);
    q?.update(R, z, m, w);
    const ne = Z.pos, ve = Z.rest, Se = u(R);
    for (let G = 0; G < H.length; G++)
      x(ve[G * 2], ve[G * 2 + 1], H[G], R, Se, w), ne[G * 2] = w[0], ne[G * 2 + 1] = w[1];
    J.chains.forEach((G, Re) => Ba(G, N[Re].mesh));
    const $e = 7;
    D.draw({
      angleX: R.angleX,
      angleY: R.angleY,
      angleZ: R.angleZ,
      eyes: [
        re(R.eyeROpen, 0),
        R.eyeSmile,
        R.gazeX * $e,
        -R.gazeY * $e * 0.6,
        re(R.eyeLOpen, 1),
        R.eyeSmileL ?? R.eyeSmile,
        R.gazeX * $e * 0.85,
        -R.gazeY * $e * 0.6
      ],
      // with sprites the drawn mouths replace the shader-painted one
      mouthOpen: ie?.mouthDrawn ? 0 : R.mouthOpen,
      mouthForm: R.mouthForm,
      cheek: R.blush,
      showMesh: !1,
      originalAlpha: 0,
      joints: []
    });
  }
  let F = 0, X = performance.now(), k = !1;
  const $ = (p) => {
    const R = Math.min(0.05, (p - X) / 1e3);
    X = p, T(R), F = requestAnimationFrame($);
  };
  return e.manual || (F = requestAnimationFrame($)), {
    motions: [
      ...Object.entries(lt).map(([p, R]) => ({ id: p, label: R.label, idle: !1 })),
      ...Object.entries(ht).map(([p, R]) => ({ id: p, label: R.label, idle: !0 }))
    ],
    setParameters(p, R = 1) {
      Y = { ...p }, W = Math.min(1, Math.max(0, Number(R) || 0));
    },
    getParameters() {
      return { ...ee };
    },
    /** 0..1 loudness of the voice being played (e.g. normalised RMS). */
    setVoiceLevel(p) {
      C.setVoiceLevel(p);
    },
    /** Partial mouth-movement settings; omitted fields retain their current values. */
    setLipSync(p) {
      C.setLipSync(p);
    },
    /** true while TTS audio is playing: idle motions pause and the head nods along. */
    setSpeaking(p) {
      C.setSpeaking(p);
    },
    /** AITuber OnAir emotion tag: happy / sad / angry / surprised / relaxed / neutral (or null). */
    setEmotion(p, R) {
      C.setEmotion(p, R);
    },
    /** Live expression layered over tracking (see OVERLAY_EXPRESSIONS); 'neutral' clears it. */
    setExpression(p) {
      b.set(p);
    },
    /** Show the named overlay layers (built/overlays/overlays.json) and hide the others. */
    setOverlays(p) {
      q?.set(p);
    },
    getExpression() {
      return { name: b.name, active: b.active };
    },
    /** How much the head moves with the voice while speaking (1 = default, calmer below). */
    setTalkGain(p) {
      C.talkGain = Math.max(0, Number(p) || 0);
    },
    /** Play a motion or idle motion by id (see `motions`). */
    play(p) {
      C.hasMotion(p) && C.playMotion(p);
    },
    /** Move the mouth through the vowels of kana text (no audio; for previews). */
    speakKana(p, R) {
      C.speakKana(String(p ?? ""), R);
    },
    holdMouth(p) {
      C.holdMouth(p);
    },
    stopLipSync() {
      C.stopLipSync();
    },
    getLipSyncState() {
      return C.getLipSyncState();
    },
    setAutoIdle(p) {
      C.autoIdle = !!p;
    },
    setLighting(p) {
      D.setLighting(p);
    },
    getLightingStats() {
      return { ...D.lightingStats };
    },
    setAutoMotion(p) {
      C.autoMotion = !!p;
    },
    /** Hair / tassel sway multiplier (1 = default). */
    setSwayGain(p) {
      J.gain = p;
    },
    /** Called with the motion id when a motion starts and with null when it ends. */
    onMotion(p) {
      return V.add(p), () => V.delete(p);
    },
    /** Advance the simulation by `sec` and draw (for tests / hidden tabs). */
    advance(p, R = 60) {
      if (!k)
        if (p === 0) T(0);
        else for (let z = 0; z < Math.round(p * R); z++) T(1 / R);
    },
    /** Update motion and lip sync without drawing a hidden preview. */
    advanceParameters(p) {
      k || A(p);
    },
    destroy() {
      k || (k = !0, cancelAnimationFrame(F), V.clear(), D.destroy());
    }
  };
}
const Ua = Object.keys(ut);
async function Pa(a, e) {
  return Ya(a, { ...e, rig: it(e.rig) });
}
function je(a) {
  if (!a || typeof a != "object" || Array.isArray(a))
    throw new Error("avatar.json: expected an object");
  const e = a, t = [];
  e.format !== "mesh-avatar" && t.push('avatar.json.format: expected "mesh-avatar"'), e.version !== 1 && t.push(`avatar.json.version: unsupported version ${JSON.stringify(e.version) ?? "missing"} (expected 1)`), (typeof e.name != "string" || !e.name.trim()) && t.push("avatar.json.name: expected a non-empty string");
  const r = { format: "mesh-avatar", version: 1, name: e.name };
  for (const s of ["author", "license", "thumbnail", "source"])
    e[s] !== void 0 && (typeof e[s] != "string" ? t.push(`avatar.json.${s}: expected a string`) : r[s] = e[s]);
  if (e.studio !== void 0) {
    const s = e.studio;
    !s || typeof s != "object" || Array.isArray(s) || !("version" in s) || typeof s.version != "string" || !s.version.trim() ? t.push("avatar.json.studio.version: expected a non-empty string") : r.studio = { version: s.version };
  }
  if (e.lipSync !== void 0)
    try {
      r.lipSync = ot(e.lipSync);
    } catch (s) {
      t.push(`avatar.json.lipSync: ${s instanceof Error ? s.message : String(s)}`);
    }
  if (t.length) throw new Error(t.join(`
`));
  return r;
}
function ja(a) {
  return je({ format: "mesh-avatar", version: 1, name: a });
}
const Ie = (a) => !!a && typeof a == "object" && !Array.isArray(a), Me = (a, e) => Array.isArray(a) && a.length === e && a.every((t) => typeof t == "number" && Number.isFinite(t)), Qe = (a, e) => Object.hasOwn(a, e);
function Xa(a) {
  const e = [];
  function t(S, y = !0) {
    if (!Qe(a, S)) {
      y && e.push(`${S}: missing file`);
      return;
    }
    const h = a[S];
    if (!(h instanceof Uint8Array)) {
      e.push(`${S}: JSON bytes are required`);
      return;
    }
    let l;
    try {
      l = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(h));
    } catch {
      e.push(`${S}: invalid UTF-8 JSON`);
      return;
    }
    if (!Ie(l)) {
      e.push(`${S}: expected an object`);
      return;
    }
    return l;
  }
  function r(S, y, h = !0) {
    return S.version === 1 || h && S.version === void 0 ? !0 : (e.push(`${y}.version: unsupported version ${JSON.stringify(S.version) ?? "missing"} (expected 1)`), !1);
  }
  function s(S) {
    if (!Qe(a, S)) {
      e.push(`${S}: missing file`);
      return;
    }
    const y = a[S], h = y instanceof Uint8Array ? y.byteLength : y?.size;
    (!Number.isSafeInteger(h) || h <= 0) && e.push(`${S}: expected a non-empty file`);
  }
  function i(S, y, h, l) {
    if (!Ie(S)) {
      e.push(`${y}.layers: expected a layer rectangle map`);
      return;
    }
    for (const [d, n] of Object.entries(S)) {
      const o = `${y}.layers.${d}`;
      if (!/^[A-Za-z0-9_-]+$/.test(d)) {
        e.push(`${o}: expected a safe layer name (letters, digits, hyphens or underscores)`);
        continue;
      }
      !Me(n, 4) || !n.every(Number.isInteger) || n[0] < 0 || n[1] < 0 || n[2] <= 0 || n[3] <= 0 ? e.push(`${o}: expected [x, y, width, height] with non-negative integer origins and positive integer dimensions`) : l && (n[0] + n[2] > l[0] || n[1] + n[3] > l[1]) && e.push(`${o}: rectangle must stay inside the image`), s(`${h}/${d}.png`);
    }
    return S;
  }
  function c(S, y) {
    (typeof S.build != "string" || !S.build.trim()) && e.push(`${y}.build: expected a non-empty string`);
  }
  const m = t("avatar.json", !1);
  if (m)
    try {
      je(m);
    } catch (S) {
      e.push(S.message);
    }
  const E = t("rig.json");
  let v;
  if (E && r(E, "rig.json", !1)) {
    const S = _t(E);
    e.push(...S.map((y) => `rig.json: ${y}`)), S.length || (v = E);
  }
  s("built/base.png"), s("built/hairmask.png");
  const M = t("built/layers.json");
  if (M && r(M, "built/layers.json")) {
    c(M, "built/layers.json");
    let S;
    !Me(M.size, 2) || !M.size.every((h) => Number.isInteger(h) && h > 0) ? e.push("built/layers.json.size: expected [width, height] with positive integer dimensions") : (S = M.size, v && (S[0] !== v.image.width || S[1] !== v.image.height) && e.push("built/layers.json.size: must match rig.json.image"));
    const y = i(M.layers, "built/layers.json", "built", S);
    if (v && y) {
      const h = [
        ...v.eyes.flatMap((l, d) => ["ball", "low", "crease", "lash"].map((n) => `eye${d}_${n}`)),
        ...v.hand ? ["hand"] : [],
        ...(v.accessories ?? []).map((l) => l.name)
      ];
      for (const l of h) Qe(y, l) || e.push(`built/layers.json.layers.${l}: missing required layer`);
    }
    !Array.isArray(M.eyes) || M.eyes.length !== 2 ? e.push("built/layers.json.eyes: expected two eye curves") : M.eyes.forEach((h, l) => {
      const d = `built/layers.json.eyes[${l}]`;
      if (!Ie(h)) {
        e.push(`${d}: expected an object`);
        return;
      }
      Me([h.x0, h.x1], 2) && h.x0 < h.x1 || e.push(`${d}: expected finite x0 < x1`);
      for (const n of ["top", "bot"])
        Me(h[n], 24) || e.push(`${d}.${n}: expected 24 finite numbers`);
      if (Me(h.top, 24) && Me(h.bot, 24) && h.top.some((n, o) => n > h.bot[o]) && e.push(`${d}.top: must not exceed bottom curve`), v) for (const n of ["x0", "x1", "top", "bot"]) {
        const o = h[n], L = v.eyes[l][n];
        (Array.isArray(L) ? Me(o, L.length) && o.every((f, g) => f === L[g]) : o === L) || e.push(`${d}.${n}: must match rig.json.eyes[${l}].${n}`);
      }
    });
  }
  const u = t("built/sprites/sprites.json", !1);
  u && r(u, "built/sprites/sprites.json") && (c(u, "built/sprites/sprites.json"), i(u.layers, "built/sprites/sprites.json", "built/sprites", v ? [v.image.width, v.image.height] : void 0));
  const x = t("built/overlays/overlays.json", !1);
  if (x && r(x, "built/overlays/overlays.json"))
    if (!Array.isArray(x.overlays)) e.push("built/overlays/overlays.json.overlays: expected an array");
    else {
      const S = /* @__PURE__ */ new Set();
      for (const [y, h] of x.overlays.entries()) {
        const l = `built/overlays/overlays.json.overlays[${y}]`;
        if (!Ie(h) || typeof h.name != "string" || !/^[A-Za-z0-9_-]+$/.test(h.name) || typeof h.file != "string" || !/^[A-Za-z0-9_-]+\.png$/.test(h.file)) {
          e.push(`${l}: expected { name, file } with safe names`);
          continue;
        }
        S.has(h.name) && e.push(`${l}.name: duplicate overlay name`), S.add(h.name), s(`built/overlays/${h.file}`);
      }
    }
  return e;
}
var he = Uint8Array, Te = Uint16Array, $a = Int32Array, Pt = new he([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]), jt = new he([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]), Ca = new he([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]), Xt = function(a, e) {
  for (var t = new Te(31), r = 0; r < 31; ++r)
    t[r] = e += 1 << a[r - 1];
  for (var s = new $a(t[30]), r = 1; r < 30; ++r)
    for (var i = t[r]; i < t[r + 1]; ++i)
      s[i] = i - t[r] << 5 | r;
  return { b: t, r: s };
}, $t = Xt(Pt, 2), Ct = $t.b, za = $t.r;
Ct[28] = 258, za[258] = 28;
var Na = Xt(jt, 0), Da = Na.b, nt = new Te(32768);
for (var ae = 0; ae < 32768; ++ae) {
  var xe = (ae & 43690) >> 1 | (ae & 21845) << 1;
  xe = (xe & 52428) >> 2 | (xe & 13107) << 2, xe = (xe & 61680) >> 4 | (xe & 3855) << 4, nt[ae] = ((xe & 65280) >> 8 | (xe & 255) << 8) >> 1;
}
var Pe = (function(a, e, t) {
  for (var r = a.length, s = 0, i = new Te(e); s < r; ++s)
    a[s] && ++i[a[s] - 1];
  var c = new Te(e);
  for (s = 1; s < e; ++s)
    c[s] = c[s - 1] + i[s - 1] << 1;
  var m;
  if (t) {
    m = new Te(1 << e);
    var E = 15 - e;
    for (s = 0; s < r; ++s)
      if (a[s])
        for (var v = s << 4 | a[s], M = e - a[s], u = c[a[s] - 1]++ << M, x = u | (1 << M) - 1; u <= x; ++u)
          m[nt[u] >> E] = v;
  } else
    for (m = new Te(r), s = 0; s < r; ++s)
      a[s] && (m[s] = nt[c[a[s] - 1]++] >> 15 - a[s]);
  return m;
}), Xe = new he(288);
for (var ae = 0; ae < 144; ++ae)
  Xe[ae] = 8;
for (var ae = 144; ae < 256; ++ae)
  Xe[ae] = 9;
for (var ae = 256; ae < 280; ++ae)
  Xe[ae] = 7;
for (var ae = 280; ae < 288; ++ae)
  Xe[ae] = 8;
var zt = new he(32);
for (var ae = 0; ae < 32; ++ae)
  zt[ae] = 5;
var Ia = /* @__PURE__ */ Pe(Xe, 9, 1), Za = /* @__PURE__ */ Pe(zt, 5, 1), et = function(a) {
  for (var e = a[0], t = 1; t < a.length; ++t)
    a[t] > e && (e = a[t]);
  return e;
}, fe = function(a, e, t) {
  var r = e / 8 | 0;
  return (a[r] | a[r + 1] << 8) >> (e & 7) & t;
}, tt = function(a, e) {
  var t = e / 8 | 0;
  return (a[t] | a[t + 1] << 8 | a[t + 2] << 16) >> (e & 7);
}, Ha = function(a) {
  return (a + 7) / 8 | 0;
}, ct = function(a, e, t) {
  return (e == null || e < 0) && (e = 0), (t == null || t > a.length) && (t = a.length), new he(a.subarray(e, t));
}, Wa = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
], le = function(a, e, t) {
  var r = new Error(e || Wa[a]);
  if (r.code = a, Error.captureStackTrace && Error.captureStackTrace(r, le), !t)
    throw r;
  return r;
}, Ga = function(a, e, t, r) {
  var s = a.length, i = r ? r.length : 0;
  if (!s || e.f && !e.l)
    return t || new he(0);
  var c = !t, m = c || e.i != 2, E = e.i;
  c && (t = new he(s * 3));
  var v = function(k) {
    var $ = t.length;
    if (k > $) {
      var p = new he(Math.max($ * 2, k));
      p.set(t), t = p;
    }
  }, M = e.f || 0, u = e.p || 0, x = e.b || 0, S = e.l, y = e.d, h = e.m, l = e.n, d = s * 8;
  do {
    if (!S) {
      M = fe(a, u, 1);
      var n = fe(a, u + 1, 3);
      if (u += 3, n)
        if (n == 1)
          S = Ia, y = Za, h = 9, l = 5;
        else if (n == 2) {
          var o = fe(a, u, 31) + 257, L = fe(a, u + 10, 15) + 4, f = o + fe(a, u + 5, 31) + 1;
          u += 14;
          for (var g = new he(f), B = new he(19), U = 0; U < L; ++U)
            B[Ca[U]] = fe(a, u + U * 3, 7);
          u += L * 3;
          for (var D = et(B), _ = (1 << D) - 1, P = Pe(B, D, 1), U = 0; U < f; ) {
            var O = P[fe(a, u, _)];
            u += O & 15;
            var j = O >> 4;
            if (j < 16)
              g[U++] = j;
            else {
              var I = 0, q = 0;
              for (j == 16 ? (q = 3 + fe(a, u, 3), u += 2, I = g[U - 1]) : j == 17 ? (q = 3 + fe(a, u, 7), u += 3) : j == 18 && (q = 11 + fe(a, u, 127), u += 7); q--; )
                g[U++] = I;
            }
          }
          var N = g.subarray(0, o), Z = g.subarray(o);
          h = et(N), l = et(Z), S = Pe(N, h, 1), y = Pe(Z, l, 1);
        } else
          le(1);
      else {
        var j = Ha(u) + 4, H = a[j - 4] | a[j - 3] << 8, J = j + H;
        if (J > s) {
          E && le(0);
          break;
        }
        m && v(x + H), t.set(a.subarray(j, J), x), e.b = x += H, e.p = u = J * 8, e.f = M;
        continue;
      }
      if (u > d) {
        E && le(0);
        break;
      }
    }
    m && v(x + 131072);
    for (var C = (1 << h) - 1, V = (1 << l) - 1, Y = u; ; Y = u) {
      var I = S[tt(a, u) & C], W = I >> 4;
      if (u += I & 15, u > d) {
        E && le(0);
        break;
      }
      if (I || le(2), W < 256)
        t[x++] = W;
      else if (W == 256) {
        Y = u, S = null;
        break;
      } else {
        var ee = W - 254;
        if (W > 264) {
          var U = W - 257, b = Pt[U];
          ee = fe(a, u, (1 << b) - 1) + Ct[U], u += b;
        }
        var w = y[tt(a, u) & V], A = w >> 4;
        w || le(3), u += w & 15;
        var Z = Da[A];
        if (A > 3) {
          var b = jt[A];
          Z += tt(a, u) & (1 << b) - 1, u += b;
        }
        if (u > d) {
          E && le(0);
          break;
        }
        m && v(x + 131072);
        var T = x + ee;
        if (x < Z) {
          var F = i - Z, X = Math.min(Z, T);
          for (F + x < 0 && le(3); x < X; ++x)
            t[x] = r[F + x];
        }
        for (; x < T; ++x)
          t[x] = t[x - Z];
      }
    }
    e.l = S, e.p = Y, e.b = x, e.f = M, S && (M = 1, e.m = h, e.d = y, e.n = l);
  } while (!M);
  return x != t.length && c ? ct(t, 0, x) : t.subarray(0, x);
}, Va = /* @__PURE__ */ new he(0), ge = function(a, e) {
  return a[e] | a[e + 1] << 8;
}, ue = function(a, e) {
  return (a[e] | a[e + 1] << 8 | a[e + 2] << 16 | a[e + 3] << 24) >>> 0;
}, at = function(a, e) {
  return ue(a, e) + ue(a, e + 4) * 4294967296;
};
function qa(a, e) {
  return Ga(a, { i: 2 }, e && e.out, e && e.dictionary);
}
var st = typeof TextDecoder < "u" && /* @__PURE__ */ new TextDecoder(), Ja = 0;
try {
  st.decode(Va, { stream: !0 }), Ja = 1;
} catch {
}
var Ka = function(a) {
  for (var e = "", t = 0; ; ) {
    var r = a[t++], s = (r > 127) + (r > 223) + (r > 239);
    if (t + s > a.length)
      return { s: e, r: ct(a, t - 1) };
    s ? s == 3 ? (r = ((r & 15) << 18 | (a[t++] & 63) << 12 | (a[t++] & 63) << 6 | a[t++] & 63) - 65536, e += String.fromCharCode(55296 | r >> 10, 56320 | r & 1023)) : s & 1 ? e += String.fromCharCode((r & 31) << 6 | a[t++] & 63) : e += String.fromCharCode((r & 15) << 12 | (a[t++] & 63) << 6 | a[t++] & 63) : e += String.fromCharCode(r);
  }
};
function Qa(a, e) {
  if (e) {
    for (var t = "", r = 0; r < a.length; r += 16384)
      t += String.fromCharCode.apply(null, a.subarray(r, r + 16384));
    return t;
  } else {
    if (st)
      return st.decode(a);
    var s = Ka(a), i = s.s, t = s.r;
    return t.length && le(8), i;
  }
}
var er = function(a, e) {
  return e + 30 + ge(a, e + 26) + ge(a, e + 28);
}, tr = function(a, e, t) {
  var r = ge(a, e + 28), s = ge(a, e + 30), i = Qa(a.subarray(e + 46, e + 46 + r), !(ge(a, e + 8) & 2048)), c = e + 46 + r, m = ar(a, c, s, t, ue(a, e + 20), ue(a, e + 24), ue(a, e + 42)), E = m[0], v = m[1], M = m[2];
  return [ge(a, e + 10), E, v, i, c + s + ge(a, e + 32), M];
}, ar = function(a, e, t, r, s, i, c) {
  var m = s == 4294967295, E = i == 4294967295, v = c == 4294967295, M = e + t, u = m + E + v;
  if (r && u) {
    for (; e + 4 < M; e += 4 + ge(a, e + 2))
      if (ge(a, e) == 1)
        return [
          m ? at(a, e + 4 + 8 * E) : s,
          E ? at(a, e + 4) : i,
          v ? at(a, e + 4 + 8 * (E + m)) : c,
          1
        ];
    r < 2 && le(13);
  }
  return [s, i, c, 0];
};
function rr(a, e) {
  for (var t = {}, r = a.length - 22; ue(a, r) != 101010256; --r)
    (!r || a.length - r > 65558) && le(13);
  var s = ge(a, r + 8);
  if (!s)
    return {};
  var i = ue(a, r + 16), c = ue(a, r - 20) == 117853008;
  if (c) {
    var m = ue(a, r - 12);
    c = ue(a, m) == 101075792, c && (s = ue(a, m + 32), i = ue(a, m + 48));
  }
  for (var E = e && e.filter, v = 0; v < s; ++v) {
    var M = tr(a, i, c), u = M[0], x = M[1], S = M[2], y = M[3], h = M[4], l = M[5], d = er(a, l);
    i = h, (!E || E({
      name: y,
      size: x,
      originalSize: S,
      compression: u
    })) && (u ? u == 8 ? t[y] = qa(a.subarray(d, d + x), { out: new he(S) }) : le(14, "unknown compression type " + u) : t[y] = ct(a, d, d + x));
  }
  return t;
}
const Ot = 200, Tt = 64 * 1024 * 1024, kt = new TextDecoder("utf-8", { fatal: !0 });
function Nt(a) {
  if (!a || a.startsWith("/") || /^[A-Za-z]:/.test(a) || a.includes("\\") || a.includes("\0") || a.split("/").includes(".."))
    throw new Error(`ZIP entry ${JSON.stringify(a)}: path must be relative, without .. or backslashes`);
}
function nr(a) {
  const e = new DataView(a.buffer, a.byteOffset, a.byteLength), t = (x = "(archive)") => {
    throw new Error(`ZIP entry ${JSON.stringify(x)}: invalid or truncated ZIP`);
  }, r = (x) => x >= 0 && x + 2 <= a.length ? e.getUint16(x, !0) : t(), s = (x) => x >= 0 && x + 4 <= a.length ? e.getUint32(x, !0) : t();
  let i = a.length - 22;
  for (; i >= Math.max(0, a.length - 65557) && !(s(i) === 101010256 && i + 22 + r(i + 20) === a.length); i--)
    ;
  (i < 0 || i < a.length - 65557) && t(), (r(i + 4) || r(i + 6) || r(i + 8) !== r(i + 10)) && t();
  const c = r(i + 10), m = s(i + 16), E = m + s(i + 12);
  E !== i && t();
  const v = [], M = /* @__PURE__ */ new Set();
  let u = m;
  for (let x = 0; x < c; x++) {
    (u + 46 > E || s(u) !== 33639248) && t();
    const S = r(u + 28), y = u + 46 + S + r(u + 30) + r(u + 32);
    y > E && t();
    let h;
    try {
      h = kt.decode(a.subarray(u + 46, u + 46 + S));
    } catch {
      throw new Error("ZIP entry (invalid UTF-8 name): invalid filename");
    }
    if (Nt(h), x >= Ot) throw new Error(`ZIP entry ${JSON.stringify(h)}: more than ${Ot} entries`);
    if (M.has(h)) throw new Error(`ZIP entry ${JSON.stringify(h)}: duplicate entry`);
    M.add(h);
    const l = s(u + 24), d = s(u + 20), n = s(u + 42);
    if (l > Tt || d > Tt) throw new Error(`ZIP entry ${JSON.stringify(h)}: exceeds 64 MB`);
    if (r(u + 10) !== 0) throw new Error(`ZIP entry ${JSON.stringify(h)}: expected stored compression (method 0)`);
    if (r(u + 8) & 1) throw new Error(`ZIP entry ${JSON.stringify(h)}: encrypted entries are not supported`);
    (d !== l || n + 30 > m || s(n) !== 67324752) && t(h);
    const o = n + 30 + r(n + 26) + r(n + 28);
    (o + l > m || r(n + 8) !== 0 || r(n + 6) !== r(u + 8)) && t(h);
    let L;
    try {
      L = kt.decode(a.subarray(n + 30, n + 30 + r(n + 26)));
    } catch {
      t(h);
    }
    L !== h && t(h), v.push({ name: h, offset: n, start: o, size: l, central: u }), u = y;
  }
  return u !== E && t(), { files: v };
}
function sr(a) {
  const e = a instanceof Uint8Array ? a : new Uint8Array(a), t = nr(e), r = rr(e, { filter: (i) => i.name !== "__proto__" }), s = /* @__PURE__ */ Object.create(null);
  for (const i of t.files) {
    const c = i.name === "__proto__" ? e.slice(i.start, i.start + i.size) : r[i.name];
    if (!(c instanceof Uint8Array) || c.length !== i.size) throw new Error(`ZIP entry ${JSON.stringify(i.name)}: invalid size`);
    s[i.name] = c;
  }
  return s;
}
const ir = (a) => JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(a));
function Oe(a, e) {
  try {
    return ir(a);
  } catch {
    throw new Error(`${e}: invalid UTF-8 JSON`);
  }
}
function Dt(a, e, t) {
  return [
    "layers.json",
    "base.png",
    "hairmask.png",
    ...Object.keys(a?.layers ?? {}).map((r) => `${r}.png`),
    ...e ? ["sprites/sprites.json", ...Object.keys(e.layers ?? {}).map((r) => `sprites/${r}.png`)] : [],
    // malformed entries are left to validateAvatarFiles, which reports them
    ...t ? ["overlays/overlays.json", ...(Array.isArray(t.overlays) ? t.overlays : []).flatMap((r) => typeof r?.file == "string" ? [`overlays/${r.file}`] : [])] : []
  ];
}
function It(a) {
  const e = Xa(a);
  if (e.length) throw new Error(e.join(`
`));
}
function Zt(a) {
  return !!a && typeof a == "object" && "manifest" in a && "rig" in a && "assets" in a && "release" in a;
}
function rt(a) {
  const e = sr(a);
  if (!Object.hasOwn(e, "avatar.json")) throw new Error("avatar.json: missing file in .mavatar archive");
  It(e);
  const t = je(Oe(e["avatar.json"], "avatar.json")), r = it(Oe(e["rig.json"], "rig.json")), s = e["built/overlays/overlays.json"] ? Oe(e["built/overlays/overlays.json"], "built/overlays/overlays.json") : void 0, i = Dt(
    Oe(e["built/layers.json"], "built/layers.json"),
    e["built/sprites/sprites.json"] ? Oe(e["built/sprites/sprites.json"], "built/sprites/sprites.json") : void 0,
    s
  ), c = {}, m = [], E = () => {
    m.splice(0).forEach((v) => URL.revokeObjectURL(v));
  };
  try {
    for (const v of new Set(i)) {
      const M = URL.createObjectURL(new Blob([new Uint8Array(e[`built/${v}`])], { type: v.endsWith(".json") ? "application/json" : "image/png" }));
      m.push(M), c[v] = M;
    }
  } catch (v) {
    throw E(), v;
  }
  return { manifest: t, rig: r, assets: c, release: E };
}
async function or(a, e = {}) {
  if (Zt(a)) return a;
  if (a instanceof Blob) return rt(await a.arrayBuffer());
  if (a instanceof ArrayBuffer || a instanceof Uint8Array) return rt(a);
  const t = new URL(a, typeof location > "u" ? void 0 : location.href);
  if (/\.mavatar$/i.test(t.pathname)) {
    const l = await fetch(t);
    if (!l.ok) throw new Error(`.mavatar: could not load (${l.status})`);
    return rt(await l.arrayBuffer());
  }
  t.pathname.endsWith("/") || (t.pathname += "/");
  const r = (l) => {
    const d = new URL(t);
    return d.pathname += l.split("/").map(encodeURIComponent).join("/"), e.version !== void 0 && d.searchParams.set("v", String(e.version)), d.href;
  }, s = {};
  async function i(l, d = !1) {
    const n = await fetch(r(l));
    if (d && (n.status === 404 || n.ok && n.headers.get("content-type")?.includes("text/html"))) return;
    if (!n.ok) throw new Error(`${l}: could not load (${n.status})`);
    const o = new Uint8Array(await n.arrayBuffer());
    return s[l] = o, Oe(o, l);
  }
  const c = e.rigFile ?? "rig.json";
  Nt(c);
  const [m, E, v, M, u] = await Promise.all([
    i(c),
    i("built/layers.json"),
    i("avatar.json", !0),
    i("built/sprites/sprites.json", !0),
    i("built/overlays/overlays.json", !0)
  ]);
  Array.isArray(m?.eyes) && Array.isArray(E?.eyes) && (m.eyes = m.eyes.map((l, d) => {
    if (!l || typeof l != "object") return l;
    const n = { ...l };
    for (const o of ["x0", "x1", "top", "bot"]) n[o] === void 0 && (n[o] = E.eyes[d]?.[o]);
    return n;
  })), s["rig.json"] = new TextEncoder().encode(JSON.stringify(m));
  const x = Dt(E, M, u);
  for (const l of x) l.endsWith(".png") && (s[`built/${l}`] = { size: 1 });
  It(s);
  const S = it(m), y = Object.fromEntries(x.map((l) => [l, r(`built/${l}`)])), h = decodeURIComponent(t.pathname.split("/").filter(Boolean).at(-1) ?? "Avatar");
  return { manifest: v === void 0 ? ja(h) : je(v), rig: S, assets: y, release() {
  } };
}
async function lr(a, e, t = {}) {
  const r = !Zt(e), s = await or(e);
  try {
    const i = t.lipSync === void 0 ? s.manifest.lipSync : { ...s.manifest.lipSync, ...ot(t.lipSync) }, c = await Pa(a, { ...t, ...i === void 0 ? {} : { lipSync: i }, rig: s.rig, assets: s.assets }), m = c.destroy.bind(c);
    let E = !1;
    return Object.assign(c, { package: s, destroy() {
      if (!E) {
        E = !0;
        try {
          m();
        } finally {
          r && s.release();
        }
      }
    } });
  } catch (i) {
    throw r && s.release(), i;
  }
}
const hr = "https://shinshin86.github.io/mesh-avatar-studio/miko.mavatar", ur = ["happy", "sad", "angry", "surprised", "relaxed", "neutral"];
function cr(a) {
  return a === null || a === "" ? "neutral" : Ua.includes(a) ? a : void 0;
}
function fr(a) {
  return a === null || a === "" ? null : ur.includes(a) ? a : void 0;
}
function Ft(a) {
  return a === null || a === "" ? "contain" : a === "contain" || a === "cover" ? a : void 0;
}
function mr(a) {
  return a ? a.split(/\s+/).filter(Boolean) : [];
}
function pr(a, e) {
  return Math.min(0.05, Math.max(1e-3, (a - e) / 1e3));
}
class dr {
  promise;
  #a;
  #e;
  #t = !0;
  /** Call when a load starts. */
  start() {
    this.#t && (this.#t = !1, this.promise = new Promise((e, t) => {
      this.#a = e, this.#e = t;
    }), this.promise.catch(() => {
    }));
  }
  resolve(e) {
    this.#t || (this.#t = !0, this.#a(e));
  }
  reject(e) {
    this.#t || (this.#t = !0, this.#e(e));
  }
}
const gr = `
:host { display: block; position: relative; aspect-ratio: 1 / 1; }
:host([hidden]) { display: none; }
canvas { display: block; width: 100%; height: 100%; }
`, yr = typeof HTMLElement > "u" ? class {
} : HTMLElement;
class br extends yr {
  static observedAttributes = ["src", "fit", "expression", "emotion", "paused", "no-idle", "label", "overlays"];
  #a;
  #e = null;
  #t = new dr();
  #o = 0;
  #n = !1;
  #s = null;
  #u;
  #i = 0;
  #c = 0;
  #g = !0;
  #f = null;
  #m = null;
  #l = {};
  #y = /* @__PURE__ */ new Set();
  constructor() {
    super();
    const e = this.attachShadow({ mode: "open" }), t = document.createElement("style");
    t.textContent = gr, this.#a = document.createElement("canvas"), this.#a.setAttribute("role", "img"), this.#a.setAttribute("aria-label", "Avatar"), e.append(t, this.#a), this.#t.start(), this.#a.addEventListener("webglcontextlost", (r) => {
      r.preventDefault(), this.#h();
    }), this.#a.addEventListener("webglcontextrestored", () => this.#p());
  }
  /** The loaded runtime avatar, or null while loading. Every `mesh-avatar` method is available on it. */
  get avatar() {
    return this.#e;
  }
  /** Resolves with the avatar once the current source has loaded. */
  get ready() {
    return this.#t.promise;
  }
  /** Loads a file, archive or URL without changing `src`. A changed `src` replaces this source. */
  load(e) {
    return this.#s = null, this.#u = e, this.#p(), this.ready;
  }
  get src() {
    return this.getAttribute("src") ?? "";
  }
  set src(e) {
    this.setAttribute("src", e);
  }
  get fit() {
    return Ft(this.getAttribute("fit")) ?? "contain";
  }
  set fit(e) {
    this.setAttribute("fit", e);
  }
  get expression() {
    return this.getAttribute("expression") ?? "neutral";
  }
  set expression(e) {
    this.setAttribute("expression", e);
  }
  get emotion() {
    return this.getAttribute("emotion");
  }
  set emotion(e) {
    e === null ? this.removeAttribute("emotion") : this.setAttribute("emotion", e);
  }
  get paused() {
    return this.hasAttribute("paused");
  }
  set paused(e) {
    this.toggleAttribute("paused", e);
  }
  /** Overlay layers to show, such as glasses (the avatar's built/overlays). Kept across loads. */
  get overlays() {
    return mr(this.getAttribute("overlays"));
  }
  set overlays(e) {
    e.length ? this.setAttribute("overlays", e.join(" ")) : this.removeAttribute("overlays");
  }
  /** Mouth opening from the voice loudness, 0 to 1. Kept until the avatar loads. */
  setVoiceLevel(e) {
    this.#m = e, this.#e?.setVoiceLevel(e);
  }
  /** Explicit mouth-movement overrides, retained across loads. Assignment is a partial update. */
  get lipSync() {
    return { ...this.#l };
  }
  set lipSync(e) {
    this.setLipSync(e);
  }
  /** Partial overrides of the avatar's saved mouth-movement settings, retained across loads. */
  setLipSync(e) {
    const t = je({ format: "mesh-avatar", version: 1, name: "Avatar", lipSync: e }).lipSync;
    this.#e?.setLipSync(t), this.#l = { ...this.#l, ...t };
  }
  /** Moves the mouth to Japanese text without audio. Waits for the avatar to load. */
  async speak(e, t) {
    (await this.ready).speakKana(e, t);
  }
  /** Plays a motion by id (see `avatar.motions`). Waits for the avatar to load. */
  async play(e) {
    (await this.ready).play(e);
  }
  connectedCallback() {
    this.#f ??= new IntersectionObserver((e) => {
      this.#g = e.at(-1)?.isIntersecting ?? !0, this.#r();
    }), this.#f.observe(this), document.addEventListener("visibilitychange", this.#r), !this.#e && !this.#n ? this.#v() : this.#r();
  }
  disconnectedCallback() {
    this.#f?.disconnect(), document.removeEventListener("visibilitychange", this.#r), this.#h(), queueMicrotask(() => {
      this.isConnected || this.#w();
    });
  }
  attributeChangedCallback(e, t, r) {
    t !== r && (e === "src" || e === "fit" ? (e === "src" && (this.#u = void 0), e === "fit" && Ft(r) === void 0 && this.#d(e, r), this.isConnected && this.#v()) : e === "label" ? this.#a.setAttribute("aria-label", r || "Avatar") : e === "paused" ? this.#r() : this.#e && this.#b(this.#e, e));
  }
  #b(e, t) {
    if (t === "expression") {
      const r = cr(this.getAttribute("expression"));
      r ? e.setExpression(r) : this.#d(t, this.getAttribute(t));
    } else if (t === "emotion") {
      const r = fr(this.getAttribute("emotion"));
      r !== void 0 ? e.setEmotion(r) : this.#d(t, this.getAttribute(t));
    } else t === "no-idle" ? e.setAutoIdle(!this.hasAttribute("no-idle")) : t === "overlays" && e.setOverlays(this.overlays);
  }
  #v() {
    if (this.#t.start(), this.#s) return;
    const e = this.#s = {};
    queueMicrotask(() => {
      this.#s === e && (this.#s = null, this.isConnected && this.#p());
    });
  }
  async #p(e = this.#u ?? (this.getAttribute("src") || hr)) {
    const t = ++this.#o;
    this.#w(!1), this.#n = !0, this.#t.start();
    try {
      const r = await lr(this.#a, e, { manual: !0, fit: this.fit });
      if (t !== this.#o) {
        r.destroy();
        return;
      }
      this.#n = !1, this.#e = r;
      for (const s of ["expression", "emotion", "no-idle", "overlays"])
        (s !== "emotion" || this.hasAttribute(s)) && this.#b(r, s);
      this.#m !== null && r.setVoiceLevel(this.#m), r.setLipSync(this.#l), matchMedia("(prefers-reduced-motion: reduce)").matches && r.setSwayGain(0.5), r.onMotion((s) => this.dispatchEvent(new CustomEvent("motion", { detail: { id: s } }))), r.advance(0), this.#t.resolve(r), this.dispatchEvent(new CustomEvent("load", { detail: { avatar: r } })), this.#r();
    } catch (r) {
      if (t !== this.#o) return;
      this.#n = !1, this.#t.reject(r), this.dispatchEvent(new CustomEvent("error", { detail: { error: r } }));
    }
  }
  /** Destroys the avatar. Without `cancel = false` it also abandons a load in progress. */
  #w(e = !0) {
    e && (this.#o++, this.#n = !1), this.#h(), this.#e?.destroy(), this.#e = null;
  }
  #r = () => {
    const e = this.#e && this.isConnected && this.#g && !document.hidden && !this.paused;
    e && !this.#i ? (this.#c = performance.now(), this.#i = requestAnimationFrame(this.#x)) : e || this.#h();
  };
  #x = (e) => {
    const t = pr(e, this.#c);
    this.#c = e, this.#e?.advance(t, 1 / t), this.#i = requestAnimationFrame(this.#x);
  };
  #h() {
    cancelAnimationFrame(this.#i), this.#i = 0;
  }
  #d(e, t) {
    const r = `${e}=${t}`;
    this.#y.has(r) || (this.#y.add(r), console.warn(`<mesh-avatar> ignores ${e}="${t}".`));
  }
}
typeof customElements < "u" && !customElements.get("mesh-avatar") && customElements.define("mesh-avatar", br);
window.MeshAvatarRuntime = { DEFAULT_SRC: hr, EMOTIONS: ur, MeshAvatarElement: br };

})();
