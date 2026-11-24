// The 3D view: core/scene.js's geometry drawn with plain WebGL (no library).
//
// WHY WEBGL. Ribbons pass through the combs and the bars, so no back-to-front
// ordering of whole shapes can decide what is in front (SelfShadowed's 2D
// painter's algorithm works only because its walls never intersect). A depth
// buffer does it per pixel.
//
// SHADING matches core/optics.js, so the design viewpoint agrees with the 2D
// Preview: albedo × (ambient + (1 − ambient)·max(0, n·L)) plus a Blinn-Phong
// sheen, divided by the same exposure (the brightest face), sRGB-encoded.
// Every surface is lit on the side the eye sees (ribbons are white on both
// faces).
//
// SHADOWS: a shadow map. The solid things (ribbons, solid combs and tabs,
// rods, the box) are drawn from the light, orthographically over the scene,
// into a depth texture -- packed into RGBA, as WebGL 1 need not have depth
// textures. A point is lit where it is no deeper than the map, sampled 3 x 3
// for soft edges, and only the direct light and the sheen are shadowed (the
// ambient stays). The ribbons are thinner than a texel, so the point is
// first pushed off its face toward the light by about a texel (a normal
// offset) or every ribbon would shadow itself. The map is redrawn only when
// the scene, the light or what casts changes, not as the camera moves. Clear
// combs cast none (they would, faintly).
//
// ORDER: solid things with the depth buffer (ribbons, box, rods, solid combs
// and tabs), then the slot outlines, then clear combs and tabs blended without
// writing depth, farthest first, each drawn back faces then front faces.

const VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMVP;
varying vec3 vPos;
varying vec3 vNrm;
void main() { vPos = aPos; vNrm = aNrm; gl_Position = uMVP * vec4(aPos, 1.0); }`;

const FS = `
precision highp float;
varying vec3 vPos;
varying vec3 vNrm;
uniform vec3 uEye, uL, uAlbedo;
uniform float uAmb, uSheen, uGloss, uExposure, uAlpha;
uniform mat4 uLightMVP;
uniform sampler2D uShadowMap;
uniform float uShadowOn, uTexel, uNormalBias, uBias;
float enc(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float unpack(vec4 c) { return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }
float lightAt(vec3 p, vec3 n) {
  vec4 q = uLightMVP * vec4(p + n * uNormalBias, 1.0);
  vec3 c = q.xyz / q.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float s = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      float d = unpack(texture2D(uShadowMap, c.xy + vec2(float(i), float(j)) * uTexel));
      s += c.z - uBias > d ? 0.0 : 1.0;
    }
  }
  return s / 9.0;
}
void main() {
  vec3 n = normalize(vNrm);
  vec3 V = normalize(uEye - vPos);
  if (dot(n, V) < 0.0) n = -n;
  float nl = max(dot(n, uL), 0.0);
  float sh = (uShadowOn > 0.5 && nl > 0.0) ? lightAt(vPos, n) : 1.0;
  vec3 c = uAlbedo * (uAmb + (1.0 - uAmb) * nl * sh);
  if (uSheen > 0.0) c += sh * uSheen * pow(max(dot(n, normalize(uL + V)), 0.0), uGloss);
  c /= uExposure;
  gl_FragColor = vec4(enc(c.r), enc(c.g), enc(c.b), uAlpha);
}`;

const DEPTH_VS = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const DEPTH_FS = `
precision highp float;
vec4 pack(float d) {
  vec4 e = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * d);
  return e - e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
void main() { gl_FragColor = pack(gl_FragCoord.z); }`;

const LINE_VS = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

const RAD = Math.PI / 180;

function compile(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const u = gl.getActiveUniform(p, i); loc[u.name] = gl.getUniformLocation(p, u.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const a = gl.getActiveAttrib(p, i); loc[a.name] = gl.getAttribLocation(p, a.name); }
  return { p, loc };
}

// ------------------------------------------------------------ matrices (column-major)
function ortho(l, r, b, t, n, f) {
  return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
}

/** A point through a column-major matrix (w = 1), without the divide. */
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

/**
 * The orbit camera's frame. `right` stays horizontal and `up` follows from it,
 * so the picture turns smoothly through looking straight down or up (a fixed
 * world up would flip it there), and panning moves with the picture.
 */
export function camBasis(cam) {
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
  const fwd = [-cp * sy, -sp, -cp * cy];
  const right = [cy, 0, -sy];
  return { fwd, right, up: cross(right, fwd) };
}

/** The orbit camera's eye: yaw 0, pitch 0 looks straight at the wall from the front. */
export function eyeOf(cam) {
  const cp = Math.cos(cam.pitch);
  return [cam.target[0] + cam.dist * cp * Math.sin(cam.yaw), cam.target[1] + cam.dist * Math.sin(cam.pitch), cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)];
}

/**
 * Camera presets for a scene.
 * @param {'design'|'front'|'quarter'|'top'|'side'} name
 * @param {{xv, H, distM}} view  the design viewpoint
 */
export function preset(name, scene, view, aspect) {
  const b = scene.bounds;
  const c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
  const w = b.x1 - b.x0, h = b.y1 - b.y0, d = b.z1 - b.z0;
  if (name === 'design') {
    const dist = view.distM * 1000;
    const half = 0.54 * Math.max(h, w / aspect);
    return { target: [view.xv, view.H / 2, 0], yaw: 0, pitch: 0, dist, fov: 2 * Math.atan(half / dist) };
  }
  const fov = 35 * RAD;
  const fit = (ext) => (0.55 * ext) / Math.tan(fov / 2);
  if (name === 'top') return { target: c, yaw: 0, pitch: 89 * RAD, dist: fit(Math.max(w, d * aspect) / aspect) + b.y1 - c[1], fov };
  // not square-on: with the box on, its side panel would hide everything
  if (name === 'side') return { target: c, yaw: 65 * RAD, pitch: 8 * RAD, dist: fit(h) * 1.4, fov };
  if (name === 'quarter') return { target: c, yaw: -35 * RAD, pitch: 18 * RAD, dist: fit(Math.max(h, w / aspect)) * 1.15, fov };
  return { target: c, yaw: 0, pitch: 0, dist: fit(Math.max(h, w / aspect)), fov };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {null | {setScene, render, camera, controls}}  null without WebGL
 */
export function createView3D(canvas) {
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const lit = compile(gl, VS, FS), line = compile(gl, LINE_VS, LINE_FS), depth = compile(gl, DEPTH_VS, DEPTH_FS);
  let buffers = null, scene = null;
  // the shadow map: an RGBA texture holding packed depth, and its framebuffer
  const SIZE = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const shadowTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, shadowTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const shadowRB = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, shadowRB);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, SIZE, SIZE);
  const shadowFB = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadowTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, shadowRB);
  const shadowOK = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let shadowKey = '', shadow = null;   // shadow: {mvp, texelWorld, depthRange}
  const view = { cam: null, opts: null };

  const upload = (m) => {
    if (!m || !m.pos.length) return null;
    const pos = gl.createBuffer(), nrm = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, nrm); gl.bufferData(gl.ARRAY_BUFFER, m.nrm, gl.STATIC_DRAW);
    return { pos, nrm, count: m.pos.length / 3, center: m.center };
  };
  const free = (b) => { if (b) { gl.deleteBuffer(b.pos); gl.deleteBuffer(b.nrm); } };

  function setScene(sc) {
    if (buffers) {
      for (const k of ['ribbons', 'box', 'tabs', 'rods']) free(buffers[k]);
      buffers.combs.forEach(free);
      if (buffers.lines) gl.deleteBuffer(buffers.lines.buf);
    }
    scene = sc;
    let lines = null;
    if (sc.lines.length) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, sc.lines, gl.STATIC_DRAW);
      lines = { buf, count: sc.lines.length / 3 };
    }
    buffers = {
      ribbons: upload(sc.ribbons), box: upload(sc.box), tabs: upload(sc.tabs), rods: upload(sc.rods),
      combs: sc.combs.map(upload), lines,
    };
    shadowKey = '';
  }

  /** Draw the casters' depth from the light: orthographic, fitted to the scene's bounds seen from the light. */
  function drawShadowMap(o) {
    const b = scene.bounds, Ld = o.light;
    const c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2];
    const R = Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
    const up = Math.abs(Ld[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0];
    const view = lookAt([c[0] + Ld[0] * R, c[1] + Ld[1] * R, c[2] + Ld[2] * R], c, up);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
      const q = apply(view, [x, y, z]);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]);
    }
    const pad = 2;
    const mvp = mul(ortho(x0 - pad, x1 + pad, y0 - pad, y1 + pad, -z1 - pad, -z0 + pad), view);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
    gl.viewport(0, 0, SIZE, SIZE);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.useProgram(depth.p);
    gl.uniformMatrix4fv(depth.loc.uMVP, false, mvp);
    const casters = [buffers.ribbons, buffers.rods];
    if (o.box.on) casters.push(buffers.box);
    if (o.comb.look !== 'clear') casters.push(...buffers.combs, buffers.tabs);
    for (const bf of casters) {
      if (!bf) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, bf.pos);
      gl.enableVertexAttribArray(depth.loc.aPos); gl.vertexAttribPointer(depth.loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, bf.count);
    }
    gl.disableVertexAttribArray(depth.loc.aPos);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const texelWorld = Math.max(x1 - x0, y1 - y0) / SIZE;
    shadow = { mvp, texelWorld, depthRange: z1 - z0 + 2 * pad };
  }

  /**
   * @param {object} cam  {target, yaw, pitch, dist, fov}
   * @param {object} o  {light: [x,y,z], ambient, exposure, ribbon: {albedo, sheen, gloss},
   *   box: {on, albedo}, comb: {look, albedo}, rodAlbedo, background}
   */
  function render(cam, o) {
    view.cam = cam; view.opts = o;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.max(1, Math.round(cw * dpr)); canvas.height = Math.max(1, Math.round(ch * dpr));
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    const bg = o.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!scene) return;
    const eye = eyeOf(cam);
    const b = scene.bounds;
    const reach = Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
    const near = Math.max(1, cam.dist - reach) * 0.5, far = cam.dist + reach * 2;
    const up = camBasis(cam).up;
    const mvp = mul(perspective(cam.fov, canvas.width / canvas.height, near, far), lookAt(eye, cam.target, up));

    const shadowsOn = !!o.shadows && shadowOK;
    if (shadowsOn) {
      const key = [o.light.join(','), o.box.on, o.comb.look].join('|');
      if (key !== shadowKey) { drawShadowMap(o); shadowKey = key; }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.useProgram(lit.p);
    const L = lit.loc;
    gl.uniformMatrix4fv(L.uMVP, false, mvp);
    gl.uniform3fv(L.uEye, eye);
    gl.uniform3fv(L.uL, o.light);
    gl.uniform1f(L.uAmb, o.ambient);
    gl.uniform1f(L.uExposure, o.exposure);
    gl.uniform1f(L.uShadowOn, shadowsOn ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.uniform1i(L.uShadowMap, 0);
    if (shadowsOn) {
      gl.uniformMatrix4fv(L.uLightMVP, false, shadow.mvp);
      gl.uniform1f(L.uTexel, 1 / SIZE);
      gl.uniform1f(L.uNormalBias, 1.5 * shadow.texelWorld);
      gl.uniform1f(L.uBias, (0.5 * shadow.texelWorld) / shadow.depthRange);
    }
    const draw = (bf, albedo, sheen, gloss, alpha) => {
      if (!bf) return;
      gl.uniform3fv(L.uAlbedo, albedo);
      gl.uniform1f(L.uSheen, sheen);
      gl.uniform1f(L.uGloss, gloss);
      gl.uniform1f(L.uAlpha, alpha);
      gl.bindBuffer(gl.ARRAY_BUFFER, bf.pos);
      gl.enableVertexAttribArray(L.aPos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bf.nrm);
      gl.enableVertexAttribArray(L.aNrm); gl.vertexAttribPointer(L.aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, bf.count);
      // never leave an array enabled: another program's pass (or a deleted
      // buffer after setScene) would trip over it, and some browsers then refuse every draw
      gl.disableVertexAttribArray(L.aPos);
      gl.disableVertexAttribArray(L.aNrm);
    };
    const clear = o.comb.look === 'clear';
    const CLEAR = { albedo: [0.82, 0.88, 0.92], sheen: 0.5, gloss: 60, alpha: 0.22 };
    draw(buffers.ribbons, o.ribbon.albedo, o.ribbon.sheen, o.ribbon.gloss, 1);
    if (o.box.on) draw(buffers.box, o.box.albedo, 0, 1, 1);
    draw(buffers.rods, o.rodAlbedo, 0.3, 20, 1);
    if (!clear) {
      for (const c of buffers.combs) draw(c, o.comb.albedo, 0.05, 8, 1);
      draw(buffers.tabs, o.comb.albedo, 0.05, 8, 1);
    }

    if (buffers.lines) {
      gl.useProgram(line.p);
      gl.uniformMatrix4fv(line.loc.uMVP, false, mvp);
      gl.uniform4fv(line.loc.uColor, clear ? [1, 1, 1, 0.9] : [0.75, 0.75, 0.8, 1]);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.lines.buf);
      gl.enableVertexAttribArray(line.loc.aPos); gl.vertexAttribPointer(line.loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, buffers.lines.count);
      gl.disableVertexAttribArray(line.loc.aPos);
      gl.useProgram(lit.p);
    }

    if (clear) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.enable(gl.CULL_FACE);
      const far1st = [...buffers.combs].sort((a, c) => dist2(c.center, eye) - dist2(a.center, eye));
      for (const bf of [...far1st, buffers.tabs]) {
        if (!bf) continue;
        gl.cullFace(gl.FRONT); draw(bf, CLEAR.albedo, CLEAR.sheen, CLEAR.gloss, CLEAR.alpha);
        gl.cullFace(gl.BACK); draw(bf, CLEAR.albedo, CLEAR.sheen, CLEAR.gloss, CLEAR.alpha);
      }
      gl.disable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  /**
   * Mouse and touch: drag to orbit, right-drag or shift-drag (or two fingers)
   * to pan, wheel or pinch to zoom. `onChange(cam)` after every move.
   */
  function controls(getCam, onChange) {
    const pts = new Map();
    let last = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      last = { pan: e.button === 2 || e.shiftKey, spread: spreadOf(pts), mid: midOf(pts) };
    });
    const end = (e) => { pts.delete(e.pointerId); last = pts.size ? { pan: false, spread: spreadOf(pts), mid: midOf(pts) } : null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !last) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const cam = getCam();
      if (pts.size >= 2) {
        const sp = spreadOf(pts), mid = midOf(pts);
        if (last.spread > 0 && sp > 0) cam.dist *= last.spread / sp;
        pan(cam, mid[0] - last.mid[0], mid[1] - last.mid[1]);
        last.spread = sp; last.mid = mid;
      } else {
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        if (last.pan) pan(cam, dx, dy);
        else {
          cam.yaw -= dx * 0.006;
          cam.pitch = Math.max(-89 * RAD, Math.min(89 * RAD, cam.pitch + dy * 0.006));
        }
      }
      onChange(cam);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cam = getCam();
      cam.dist *= Math.exp(e.deltaY * 0.0012);
      onChange(cam);
    }, { passive: false });
    const pan = (cam, dx, dy) => {
      const { right: r, up: u } = camBasis(cam);
      const k = (2 * cam.dist * Math.tan(cam.fov / 2)) / canvas.clientHeight;
      for (let i = 0; i < 3; i++) cam.target[i] += (-dx * r[i] + dy * u[i]) * k;
    };
  }

  return { setScene, render, controls, gl };
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const spreadOf = (pts) => { const v = [...pts.values()]; return v.length < 2 ? 0 : Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]); };
const midOf = (pts) => { const v = [...pts.values()]; return [v.reduce((a, p) => a + p[0], 0) / v.length, v.reduce((a, p) => a + p[1], 0) / v.length]; };
