// =====================================================================
// AI OTC TRADER — Tradefloor 3D (WebGL2, sem dependências)
// Cena real em 3D: geometria, iluminação, reflexo no piso, câmera orbital.
// Tudo o que é DADO (estado dos agentes, gráfico, decisões) vem do backend;
// o que é ambiente (globo girando, luzes pulsando, janelas) é decoração
// e não representa atividade de agentes.
// =====================================================================

// ---------------------------------------------------------------- math
const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  persp(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(e, t, u) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  },
  /** translação · rotY · rotX · escala */
  trs(px, py, pz, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0) {
    const cy = Math.cos(ry), sy_ = Math.sin(ry), cx = Math.cos(rx), sx_ = Math.sin(rx);
    // R = Ry * Rx
    const r00 = cy, r01 = sy_ * sx_, r02 = sy_ * cx;
    const r10 = 0, r11 = cx, r12 = -sx_;
    const r20 = -sy_, r21 = cy * sx_, r22 = cy * cx;
    return new Float32Array([r00 * sx, r10 * sx, r20 * sx, 0, r01 * sy, r11 * sy, r21 * sy, 0, r02 * sz, r12 * sz, r22 * sz, 0, px, py, pz, 1]);
  },
  mirrorY: () => new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  xform(m, v) {
    const x = v[0], y = v[1], z = v[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w, w];
  },
};

// ---------------------------------------------------------------- geometria
function box() {
  const p = [], n = [], uv = [];
  const faces = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  for (const [nn, u, v] of faces) {
    const c = (a, b) => [nn[0] * 0.5 + u[0] * a + v[0] * b, nn[1] * 0.5 + u[1] * a + v[1] * b, nn[2] * 0.5 + u[2] * a + v[2] * b];
    const q = [c(-0.5, -0.5), c(0.5, -0.5), c(0.5, 0.5), c(-0.5, -0.5), c(0.5, 0.5), c(-0.5, 0.5)];
    const quv = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    q.forEach((pt, i) => { p.push(...pt); n.push(...nn); uv.push(...quv[i]); });
  }
  return { p, n, uv };
}
function cylinder(seg = 20) {
  const p = [], n = [], uv = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const x0 = Math.cos(a0) * 0.5, z0 = Math.sin(a0) * 0.5, x1 = Math.cos(a1) * 0.5, z1 = Math.sin(a1) * 0.5;
    const side = [[x0, -0.5, z0], [x1, -0.5, z1], [x1, 0.5, z1], [x0, -0.5, z0], [x1, 0.5, z1], [x0, 0.5, z0]];
    const sn = [[x0, 0, z0], [x1, 0, z1], [x1, 0, z1], [x0, 0, z0], [x1, 0, z1], [x0, 0, z0]];
    side.forEach((v, k) => { p.push(...v); n.push(sn[k][0] * 2, 0, sn[k][2] * 2); uv.push(0, 0); });
    for (const y of [0.5, -0.5]) { p.push(0, y, 0, x0, y, z0, x1, y, z1); for (let k = 0; k < 3; k++) { n.push(0, Math.sign(y), 0); uv.push(0, 0); } }
  }
  return { p, n, uv };
}
function sphere(lat = 16, lon = 24) {
  const p = [], n = [], uv = [];
  const pt = (i, j) => { const th = (i / lat) * Math.PI, ph = (j / lon) * Math.PI * 2; return [Math.sin(th) * Math.cos(ph) * 0.5, Math.cos(th) * 0.5, Math.sin(th) * Math.sin(ph) * 0.5]; };
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    for (const v of [a, b, c, a, c, d]) { p.push(...v); n.push(v[0] * 2, v[1] * 2, v[2] * 2); uv.push(0, 0); }
  }
  return { p, n, uv };
}
function plane() { // XY, voltado para +Z
  return { p: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], n: Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), uv: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1] };
}
function globeLines(lat = 9, lon = 14, seg = 48) {
  const p = [];
  for (let i = 1; i < lat; i++) {
    const th = (i / lat) * Math.PI, y = Math.cos(th) * 0.5, r = Math.sin(th) * 0.5;
    for (let s = 0; s < seg; s++) { const a = (s / seg) * 6.2832, b = ((s + 1) / seg) * 6.2832; p.push(Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(b) * r, y, Math.sin(b) * r); }
  }
  for (let j = 0; j < lon; j++) {
    const ph = (j / lon) * 6.2832;
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI, b = ((s + 1) / seg) * Math.PI;
      p.push(Math.sin(a) * Math.cos(ph) * 0.5, Math.cos(a) * 0.5, Math.sin(a) * Math.sin(ph) * 0.5, Math.sin(b) * Math.cos(ph) * 0.5, Math.cos(b) * 0.5, Math.sin(b) * Math.sin(ph) * 0.5);
    }
  }
  return { p, n: Array(p.length).fill(0), uv: Array((p.length / 3) * 2).fill(0) };
}
function ring(seg = 64) {
  const p = [];
  for (let s = 0; s < seg; s++) { const a = (s / seg) * 6.2832, b = ((s + 1) / seg) * 6.2832; p.push(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5, Math.cos(b) * 0.5, 0, Math.sin(b) * 0.5); }
  return { p, n: Array(p.length).fill(0), uv: Array((p.length / 3) * 2).fill(0) };
}
function gridLines(size = 40, step = 2) {
  const p = [];
  for (let x = -size / 2; x <= size / 2; x += step) { p.push(x, 0.01, -size / 2, x, 0.01, size / 2); p.push(-size / 2, 0.01, x, size / 2, 0.01, x); }
  return { p, n: Array(p.length).fill(0), uv: Array((p.length / 3) * 2).fill(0) };
}

// ---------------------------------------------------------------- shaders
const VS = `#version 300 es
in vec3 aPos; in vec3 aNor; in vec2 aUv;
uniform mat4 uVP; uniform mat4 uM; uniform mat4 uMirror;
out vec3 vN; out vec3 vW; out vec2 vUv;
void main(){
  vec4 w = uM * vec4(aPos,1.0);
  vW = w.xyz;
  vN = mat3(uM) * aNor;
  vUv = aUv;
  gl_Position = uVP * uMirror * w;
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec2 vUv;
uniform vec3 uColor; uniform vec3 uEmissive; uniform float uAlpha; uniform float uUnlit;
uniform sampler2D uTex; uniform float uUseTex; uniform float uClip;
uniform vec3 uEye; uniform vec3 uL1; uniform vec3 uL1c; uniform vec3 uL2; uniform vec3 uL2c; uniform vec3 uL3; uniform vec3 uL3c;
uniform vec3 uFog; uniform float uFogD;
out vec4 o;
vec3 pl(vec3 lp, vec3 lc, vec3 n, vec3 v){
  vec3 d = lp - vW; float dist = length(d); d /= dist;
  float att = 1.0 / (1.0 + 0.02*dist + 0.006*dist*dist);
  float diff = max(dot(n,d),0.0);
  float spec = pow(max(dot(n, normalize(d+v)),0.0), 48.0);
  return lc * att * (diff*uColor + spec*0.6);
}
void main(){
  if (uClip > 0.5 && vW.y > 0.02) discard;
  vec3 base = uColor;
  vec3 em = uEmissive;
  if (uUseTex > 0.5){ vec4 t = texture(uTex, vUv); em += t.rgb; base *= 0.2; }
  vec3 col;
  if (uUnlit > 0.5){ col = em + base*0.15; }
  else {
    vec3 n = normalize(vN); vec3 v = normalize(uEye - vW);
    if (!gl_FrontFacing) n = -n;
    col = base*0.10 + pl(uL1,uL1c,n,v) + pl(uL2,uL2c,n,v) + pl(uL3,uL3c,n,v) + em;
  }
  float f = clamp((length(uEye - vW) - 12.0) / uFogD, 0.0, 0.85);
  col = mix(col, uFog, f);
  o = vec4(col, uAlpha);
}`;

// ---------------------------------------------------------------- utilidades de textura
function canvasTex(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

const STATUS_COLORS = {
  ok: [0.15, 1.0, 0.55], waiting: [0.2, 0.6, 1.0], degraded: [1.0, 0.7, 0.15], error: [1.0, 0.2, 0.25], stopped: [0.45, 0.5, 0.58], idle: [0.45, 0.5, 0.58],
};
const STATUS_LABEL = { ok: 'OK', waiting: 'AGUARDANDO', degraded: 'DEGRADADO', error: 'ERRO', stopped: 'PARADO', idle: 'OCIOSO' };

// =====================================================================
export class Tradefloor {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, { quality = 'auto', onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 indisponível neste navegador');
    this.gl = gl;
    this.quality = quality === 'auto' ? (Math.min(screen.width, screen.height) < 600 ? 'eco' : 'full') : quality;
    this.agents = [];
    this.ticks = [];
    this.headline = { title: 'AGUARDANDO DADOS', lines: [] };
    this.selected = null;
    this.cam = { az: 0.0, el: 0.42, dist: 15.5, target: [0, 2.2, 0], goalAz: 0.0, goalEl: 0.42, goalDist: 15.5 };
    this.t0 = performance.now();
    this.frames = 0; this.fps = 0; this.fpsT = performance.now();
    this.running = false;
    this.lastInteraction = 0;
    this.initGL();
    this.buildScene();
    this.bindInput();
    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  initGL() {
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {};
    for (const name of ['uVP', 'uM', 'uMirror', 'uColor', 'uEmissive', 'uAlpha', 'uUnlit', 'uTex', 'uUseTex', 'uClip', 'uEye', 'uL1', 'uL1c', 'uL2', 'uL2c', 'uL3', 'uL3c', 'uFog', 'uFogD']) this.u[name] = gl.getUniformLocation(prog, name);
    this.a = { pos: gl.getAttribLocation(prog, 'aPos'), nor: gl.getAttribLocation(prog, 'aNor'), uv: gl.getAttribLocation(prog, 'aUv') };
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  mesh(g, mode) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = (data, loc, size) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    buf(g.p, this.a.pos, 3); buf(g.n, this.a.nor, 3); buf(g.uv, this.a.uv, 2);
    gl.bindVertexArray(null);
    return { vao, count: g.p.length / 3, mode: mode ?? gl.TRIANGLES };
  }

  texture(canvas) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: t, canvas, update: () => { gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas); } };
  }

  // ------------------------------------------------------------- cena
  buildScene() {
    const gl = this.gl;
    this.m = { box: this.mesh(box()), cyl: this.mesh(cylinder()), sph: this.mesh(sphere()), plane: this.mesh(plane()), globe: this.mesh(globeLines(), gl.LINES), ring: this.mesh(ring(), gl.LINES), grid: this.mesh(gridLines(), gl.LINES) };
    this.statics = [];
    const S = (mesh, m, color, emissive = [0, 0, 0], extra = {}) => this.statics.push({ mesh, m, color, emissive, ...extra });

    // janelas panorâmicas (12 painéis em volta) com skyline procedural
    const sky = canvasTex(512, 256);
    { const c = sky.getContext('2d'); const g = c.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#02040c'); g.addColorStop(0.65, '#06173a'); g.addColorStop(1, '#0a3a5a'); c.fillStyle = g; c.fillRect(0, 0, 512, 256);
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let x = 0; x < 512;) { const w = 14 + rnd() * 30, h = 40 + rnd() * 120; c.fillStyle = '#030814'; c.fillRect(x, 256 - h, w, h);
        for (let wy = 256 - h + 6; wy < 250; wy += 9) for (let wx = x + 3; wx < x + w - 3; wx += 6) if (rnd() > 0.72) { c.fillStyle = rnd() > 0.5 ? 'rgba(80,200,255,0.55)' : 'rgba(60,255,170,0.35)'; c.fillRect(wx, wy, 2, 3); }
        x += w + 2; }
      for (let i = 0; i < 60; i++) { c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(rnd() * 512, rnd() * 90, 1, 1); } }
    this.skyTex = this.texture(sky);
    const R = 17, N = 12;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const w = 2 * R * Math.tan(Math.PI / N);
      S(this.m.plane, M4.trs(Math.sin(a) * R, 5, Math.cos(a) * R, a + Math.PI, w, 10, 1), [0.02, 0.03, 0.05], [0, 0, 0], { tex: this.skyTex, unlit: true });
      S(this.m.box, M4.trs(Math.sin(a + Math.PI / N) * R, 5, Math.cos(a + Math.PI / N) * R, a, 0.25, 10.2, 0.25), [0.08, 0.1, 0.14]);
    }
    // teto com faixas de luz
    S(this.m.plane, M4.trs(0, 10, 0, 0, 36, 36, 1, Math.PI / 2), [0.02, 0.025, 0.04]);
    for (let i = -2; i <= 2; i++) S(this.m.box, M4.trs(i * 4, 9.9, 0, 0, 0.18, 0.05, 26), [0, 0, 0], [0.25, 0.7, 1.0], { unlit: true });

    // pedestal + globo holográfico
    S(this.m.cyl, M4.trs(0, 0.35, 0, 0, 3.2, 0.7, 3.2), [0.08, 0.1, 0.14]);
    S(this.m.cyl, M4.trs(0, 0.72, 0, 0, 2.6, 0.04, 2.6), [0, 0, 0], [0.02, 0.28, 0.2], { unlit: true });
    S(this.m.ring, M4.trs(0, 0.75, 0, 0, 2.7, 2.7, 2.7), [0, 0, 0], [0.1, 1.0, 0.65], { unlit: true });

    // mesas e robôs (um por agente) em arco
    this.stations = [];
    const ids = ['market_data', 'market_analyzer', 'strategy_engine', 'signal_validator', 'risk_manager', 'execution_engine', 'portfolio_monitor', 'audit', 'supervisor'];
    const arcFrom = -Math.PI * 0.62, arcTo = Math.PI * 0.62;
    ids.forEach((id, i) => {
      const a = Math.PI + arcFrom + ((arcTo - arcFrom) * i) / (ids.length - 1); // atrás do globo
      const rDesk = 7.4, rBot = 6.2;
      const dx = Math.sin(a), dz = Math.cos(a);
      const face = a + Math.PI; // tela voltada para o centro
      const deskM = M4.trs(dx * rDesk, 1.0, dz * rDesk, a, 2.4, 0.08, 1.0);
      const st = { id, angle: a, pos: [dx * rBot, 0, dz * rBot], deskPos: [dx * rDesk, 1.0, dz * rDesk] };
      S(this.m.box, deskM, [0.12, 0.14, 0.2]);
      S(this.m.box, M4.trs(dx * (rDesk - 0.48), 1.02, dz * (rDesk - 0.48), a, 2.4, 0.03, 0.04), [0, 0, 0], [0.1, 0.6, 1.0], { unlit: true });
      for (const s of [-1, 1]) { const ox = Math.cos(a) * s * 1.05, oz = -Math.sin(a) * s * 1.05; S(this.m.box, M4.trs(dx * rDesk + ox, 0.5, dz * rDesk + oz, a, 0.08, 1.0, 0.9), [0.1, 0.12, 0.16]); }
      // monitor com textura dinâmica (dados reais do agente)
      const mc = canvasTex(256, 160);
      st.screen = this.texture(mc);
      st.screenM = M4.trs(dx * (rDesk + 0.25), 1.75, dz * (rDesk + 0.25), face, 1.7, 1.06, 1);
      st.monitorBack = M4.trs(dx * (rDesk + 0.29), 1.75, dz * (rDesk + 0.29), face, 1.8, 1.14, 0.05);
      st.stand = M4.trs(dx * (rDesk + 0.3), 1.25, dz * (rDesk + 0.3), face, 0.08, 0.5, 0.08);
      // rótulo flutuante
      const lc = canvasTex(256, 64);
      st.label = this.texture(lc);
      this.stations.push(st);
    });

    // painéis suspensos: gráfico de cotações (real) e quadro de decisão (real)
    this.chartCanvas = canvasTex(1024, 384);
    this.chartTex = this.texture(this.chartCanvas);
    this.infoCanvas = canvasTex(1024, 384);
    this.infoTex = this.texture(this.infoCanvas);
    this.panels = [
      { tex: this.chartTex, m: M4.trs(-3.6, 6.4, -9.5, 0.18, 6.6, 2.5, 1), frame: M4.trs(-3.6, 6.4, -9.56, 0.18, 6.8, 2.66, 0.06) },
      { tex: this.infoTex, m: M4.trs(3.6, 6.4, -9.5, -0.18, 6.6, 2.5, 1), frame: M4.trs(3.6, 6.4, -9.56, -0.18, 6.8, 2.66, 0.06) },
    ];
    this.drawChart();
    this.drawInfo();
    for (const st of this.stations) this.drawStation(st, null);
  }

  // ------------------------------------------------------------- texturas de dados
  drawStation(st, agent) {
    const c = st.screen.canvas.getContext('2d');
    const status = agent?.status ?? 'idle';
    const col = STATUS_COLORS[status] ?? STATUS_COLORS.idle;
    const css = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`;
    c.fillStyle = '#020812'; c.fillRect(0, 0, 256, 160);
    c.strokeStyle = css; c.lineWidth = 4; c.strokeRect(2, 2, 252, 156);
    c.fillStyle = css; c.font = 'bold 22px system-ui, sans-serif';
    c.fillText((agent?.name ?? st.id).toUpperCase().slice(0, 18), 12, 32);
    c.font = 'bold 18px system-ui, sans-serif';
    c.fillText(STATUS_LABEL[status] ?? status, 12, 58);
    c.fillStyle = '#9fd8ff'; c.font = '14px system-ui, sans-serif';
    const detail = agent?.detail ?? 'sem dados do backend';
    wrap(c, detail, 12, 82, 232, 17, 3);
    c.fillStyle = '#5a7a95'; c.font = '12px system-ui, sans-serif';
    c.fillText(agent?.lastActivityAt ? `última atividade ${agent.lastActivityAt.slice(11, 19)} UTC` : 'sem atividade registrada', 12, 150);
    st.screen.update();

    const l = st.label.canvas.getContext('2d');
    l.clearRect(0, 0, 256, 64);
    l.fillStyle = 'rgba(2,10,22,0.85)'; l.fillRect(0, 8, 256, 48);
    l.fillStyle = css; l.fillRect(0, 8, 6, 48);
    l.font = 'bold 20px system-ui, sans-serif'; l.fillStyle = '#e8f6ff';
    l.fillText((agent?.name ?? st.id).slice(0, 20), 16, 39);
    st.label.update();
    st.color = col;
    st.status = status;
  }

  drawChart() {
    const c = this.chartCanvas.getContext('2d');
    const W = 1024, H = 384;
    c.fillStyle = '#01060f'; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(40,160,255,0.6)'; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
    c.fillStyle = '#5fd0ff'; c.font = 'bold 30px system-ui, sans-serif';
    const pts = this.ticks;
    c.fillText(this.chartTitle ?? 'COTAÇÕES', 24, 46);
    if (pts.length < 2) {
      c.fillStyle = '#7d94ab'; c.font = '26px system-ui, sans-serif';
      c.fillText('Sem cotações recebidas da Deriv ainda', 24, H / 2);
    } else {
      let lo = Infinity, hi = -Infinity;
      for (const [, q] of pts) { if (q < lo) lo = q; if (q > hi) hi = q; }
      if (hi === lo) { hi += 1; lo -= 1; }
      const x0 = 24, x1 = W - 24, y0 = 70, y1 = H - 30;
      c.strokeStyle = 'rgba(60,120,180,0.25)'; c.lineWidth = 1;
      for (let g = 0; g <= 4; g++) { const y = y0 + ((y1 - y0) * g) / 4; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); }
      const X = (i) => x0 + ((x1 - x0) * i) / (pts.length - 1), Y = (q) => y1 - ((q - lo) / (hi - lo)) * (y1 - y0);
      const grad = c.createLinearGradient(0, y0, 0, y1); grad.addColorStop(0, 'rgba(30,255,160,0.35)'); grad.addColorStop(1, 'rgba(30,255,160,0)');
      c.beginPath(); c.moveTo(X(0), y1); pts.forEach(([, q], i) => c.lineTo(X(i), Y(q))); c.lineTo(X(pts.length - 1), y1); c.closePath(); c.fillStyle = grad; c.fill();
      c.beginPath(); pts.forEach(([, q], i) => (i ? c.lineTo(X(i), Y(q)) : c.moveTo(X(i), Y(q)))); c.strokeStyle = '#2bffa8'; c.lineWidth = 4; c.stroke();
      const last = pts[pts.length - 1];
      c.fillStyle = '#e8fff6'; c.font = 'bold 34px system-ui, sans-serif'; c.textAlign = 'right';
      c.fillText(String(last[1]), W - 24, 46); c.textAlign = 'left';
      c.fillStyle = '#6f8aa5'; c.font = '20px system-ui, sans-serif';
      c.fillText(`fonte: Deriv ticks • ${new Date(last[0] * 1000).toISOString().slice(11, 19)} UTC • ${pts.length} pontos`, 24, H - 8);
    }
    this.chartTex.update();
  }

  drawInfo() {
    const c = this.infoCanvas.getContext('2d');
    const W = 1024, H = 384;
    c.fillStyle = '#01060f'; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(40,255,170,0.55)'; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
    c.fillStyle = '#2bffa8'; c.font = 'bold 30px system-ui, sans-serif';
    c.fillText(this.headline.title, 24, 46);
    c.fillStyle = '#cfe9ff'; c.font = '24px system-ui, sans-serif';
    let y = 92;
    for (const line of this.headline.lines.slice(0, 9)) { y = wrap(c, line, 24, y, W - 48, 30, 2) + 6; if (y > H - 20) break; }
    this.infoTex.update();
  }

  // ------------------------------------------------------------- API pública (dados do backend)
  setAgents(list) {
    this.agents = list;
    const now = Date.now();
    for (const st of this.stations) {
      const a = list.find((x) => x.id === st.id);
      st.agent = a ?? null;
      st.activeUntil = a?.lastActivityAt ? Date.parse(a.lastActivityAt) + 2500 : 0;
      const sig = a ? `${a.status}|${a.detail}|${a.lastActivityAt}` : '';
      if (sig !== st.sig) { st.sig = sig; this.drawStation(st, a ?? null); }
    }
    void now;
  }
  setTicks(ticks, title) { this.ticks = ticks.slice(-300); this.chartTitle = title; this.drawChart(); }
  setHeadline(title, lines) { const sig = title + lines.join('|'); if (sig === this._hl) return; this._hl = sig; this.headline = { title, lines }; this.drawInfo(); }
  setQuality(q) { this.quality = q; this.resize(); }
  focus(id) {
    const st = this.stations.find((s) => s.id === id);
    this.selected = id ?? null;
    if (st) { this.cam.goalAz = st.angle + Math.PI; this.cam.goalDist = 9.5; this.cam.goalEl = 0.35; this.cam.target = [st.pos[0] * 0.9, 1.6, st.pos[2] * 0.9]; }
    else { this.cam.goalAz = 0; this.cam.goalDist = 15.5; this.cam.goalEl = 0.42; this.cam.target = [0, 2.2, 0]; }
    this.lastInteraction = performance.now();
  }

  // ------------------------------------------------------------- entrada (toque e mouse)
  bindInput() {
    const cv = this.canvas;
    const pointers = new Map();
    let pinch = null, moved = 0;
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; this.lastInteraction = performance.now(); });
    cv.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      this.lastInteraction = performance.now();
      if (pointers.size === 1) {
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        moved += Math.abs(dx) + Math.abs(dy);
        this.cam.goalAz -= dx * 0.006;
        this.cam.goalEl = Math.min(1.25, Math.max(0.08, this.cam.goalEl + dy * 0.004));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.cam.goalDist = Math.min(26, Math.max(6, this.cam.goalDist * (pinch / d)));
        pinch = d; moved += 10;
      }
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (moved < 8 && e.type === 'pointerup') this.pick(e.clientX, e.clientY);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.cam.goalDist = Math.min(26, Math.max(6, this.cam.goalDist * (1 + e.deltaY * 0.001))); this.lastInteraction = performance.now(); }, { passive: false });
  }

  pick(x, y) {
    const r = this.canvas.getBoundingClientRect();
    let best = null, bestD = 48;
    for (const st of this.stations) {
      const p = M4.xform(this.vp, [st.pos[0], 1.6, st.pos[2]]);
      if (p[3] <= 0) continue;
      const sx = r.left + ((p[0] + 1) / 2) * r.width, sy = r.top + ((1 - p[1]) / 2) * r.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) { bestD = d; best = st; }
    }
    this.onSelect(best ? best.id : null);
  }

  resize() {
    const dprCap = this.quality === 'eco' ? 1.25 : 2;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  start() { if (this.running) return; this.running = true; const loop = (t) => { if (!this.running) return; this.frame(t); this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  stop() { this.running = false; if (this.raf) cancelAnimationFrame(this.raf); }
  destroy() { this.stop(); window.removeEventListener('resize', this._onResize); const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }

  // ------------------------------------------------------------- render
  frame(now) {
    const gl = this.gl;
    this.resize();
    const t = (now - this.t0) / 1000;
    // câmera: deriva lenta quando o usuário não interage (ambiente)
    if (now - this.lastInteraction > 8000 && !this.selected) this.cam.goalAz += 0.0009;
    const k = 0.08;
    this.cam.az += (this.cam.goalAz - this.cam.az) * k;
    this.cam.el += (this.cam.goalEl - this.cam.el) * k;
    this.cam.dist += (this.cam.goalDist - this.cam.dist) * k;
    const tg = this.cam.target;
    const eye = [tg[0] + Math.sin(this.cam.az) * Math.cos(this.cam.el) * this.cam.dist, tg[1] + Math.sin(this.cam.el) * this.cam.dist, tg[2] + Math.cos(this.cam.az) * Math.cos(this.cam.el) * this.cam.dist];
    const aspect = this.canvas.width / this.canvas.height;
    const proj = M4.persp(aspect < 1 ? 1.05 : 0.8, aspect, 0.1, 120);
    const view = M4.lookAt(eye, tg, [0, 1, 0]);
    this.vp = M4.mul(proj, view);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.004, 0.012, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    const u = this.u;
    gl.uniformMatrix4fv(u.uVP, false, this.vp);
    gl.uniform3fv(u.uEye, eye);
    const pulse = 0.85 + 0.15 * Math.sin(t * 1.3);
    gl.uniform3fv(u.uL1, [0, 7, 0]); gl.uniform3fv(u.uL1c, [0.35 * pulse, 0.75 * pulse, 1.4 * pulse]);
    gl.uniform3fv(u.uL2, [-8, 4, 6]); gl.uniform3fv(u.uL2c, [0.15, 1.1, 0.6]);
    gl.uniform3fv(u.uL3, [8, 4, 6]); gl.uniform3fv(u.uL3c, [0.2, 0.6, 1.3]);
    gl.uniform3fv(u.uFog, [0.004, 0.015, 0.035]); gl.uniform1f(u.uFogD, 30);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);

    const reflect = this.quality === 'full';
    if (reflect) {
      gl.uniformMatrix4fv(u.uMirror, false, M4.mirrorY());
      gl.uniform1f(u.uClip, 0);
      this.drawWorld(t, true);
    }
    // piso escuro semitransparente sobre o reflexo
    gl.uniformMatrix4fv(u.uMirror, false, M4.ident());
    gl.uniform1f(u.uClip, 0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.draw(this.m.plane, M4.trs(0, 0, 0, 0, 40, 40, 1, -Math.PI / 2), [0.02, 0.03, 0.05], [0, 0, 0], { alpha: reflect ? 0.82 : 1 });
    gl.disable(gl.BLEND);
    this.draw(this.m.grid, M4.ident(), [0, 0, 0], [0.04, 0.2, 0.35], { unlit: true });
    this.drawWorld(t, false);

    this.frames++;
    if (now - this.fpsT > 1000) { this.fps = this.frames; this.frames = 0; this.fpsT = now; }
  }

  drawWorld(t, mirrored) {
    const gl = this.gl;
    for (const o of this.statics) this.draw(o.mesh, o.m, o.color, o.emissive, { tex: o.tex, unlit: o.unlit });
    // globo holográfico (ambiente)
    const gm = M4.trs(0, 3.4, 0, t * 0.25, 3.6, 3.6, 3.6);
    this.draw(this.m.globe, gm, [0, 0, 0], [0.15, 0.85, 1.0], { unlit: true });
    this.draw(this.m.sph, M4.trs(0, 3.4, 0, 0, 3.3, 3.3, 3.3), [0, 0, 0], [0.0, 0.08, 0.14], { unlit: true, alpha: 0.35, blend: true });
    this.draw(this.m.ring, M4.trs(0, 3.4, 0, -t * 0.4, 5.0, 5.0, 5.0, 0.35), [0, 0, 0], [0.2, 1.0, 0.6], { unlit: true });
    this.draw(this.m.ring, M4.trs(0, 3.4, 0, t * 0.3, 4.4, 4.4, 4.4, -0.5), [0, 0, 0], [0.3, 0.6, 1.0], { unlit: true });
    gl.lineWidth(1);

    // estações (robôs + monitores), cor = estado real do agente
    for (const st of this.stations) {
      const col = st.color ?? STATUS_COLORS.idle;
      const active = Date.now() < (st.activeUntil ?? 0);
      const sel = this.selected === st.id;
      const a = st.angle;
      const [px, , pz] = st.pos;
      const bob = active ? Math.sin(t * 9 + a * 3) * 0.035 : 0;
      const face = a; // robô voltado para a própria tela (de costas para o centro)
      this.draw(this.m.box, st.monitorBack, [0.05, 0.06, 0.08]);
      this.draw(this.m.box, st.stand, [0.1, 0.12, 0.15]);
      this.draw(this.m.plane, st.screenM, [0, 0, 0], [0, 0, 0], { tex: st.screen, unlit: true });
      // cadeira
      this.draw(this.m.cyl, M4.trs(px, 0.55, pz, 0, 0.7, 0.08, 0.7), [0.08, 0.09, 0.12]);
      this.draw(this.m.cyl, M4.trs(px, 0.28, pz, 0, 0.1, 0.5, 0.1), [0.1, 0.1, 0.12]);
      // corpo humanoide
      const metal = [0.55, 0.6, 0.68];
      this.draw(this.m.box, M4.trs(px, 1.05 + bob, pz, face, 0.62, 0.8, 0.38), metal);
      this.draw(this.m.box, M4.trs(px - Math.sin(a) * 0.2, 1.06 + bob, pz - Math.cos(a) * 0.2, face, 0.3, 0.3, 0.04), [0, 0, 0], col.map((v) => v * 0.9), { unlit: true }); // núcleo nas costas = estado
      this.draw(this.m.cyl, M4.trs(px, 1.52 + bob, pz, 0, 0.14, 0.14, 0.14), [0.3, 0.32, 0.36]);
      this.draw(this.m.sph, M4.trs(px, 1.78 + bob, pz, face, 0.44, 0.4, 0.44), metal);
      this.draw(this.m.box, M4.trs(px + Math.sin(a) * 0.19, 1.8 + bob, pz + Math.cos(a) * 0.19, face, 0.3, 0.07, 0.04), [0, 0, 0], col, { unlit: true }); // visor
      this.draw(this.m.cyl, M4.trs(px, 2.05 + bob, pz, 0, 0.03, 0.18, 0.03), [0.3, 0.3, 0.3]);
      this.draw(this.m.sph, M4.trs(px, 2.16 + bob, pz, 0, 0.08, 0.08, 0.08), [0, 0, 0], active || sel ? col : col.map((v) => v * 0.35), { unlit: true });
      // braços em direção ao teclado (movem só quando o agente realmente trabalhou)
      for (const s of [-1, 1]) {
        const ox = Math.cos(a) * s * 0.42, oz = -Math.sin(a) * s * 0.42;
        const swing = active ? Math.sin(t * 14 + s * 1.7) * 0.15 : 0;
        this.draw(this.m.box, M4.trs(px + ox + Math.sin(a) * 0.25, 1.15 + bob, pz + oz + Math.cos(a) * 0.25, face, 0.14, 0.14, 0.62, -0.5 + swing), metal);
      }
      // pernas
      for (const s of [-1, 1]) {
        const ox = Math.cos(a) * s * 0.17, oz = -Math.sin(a) * s * 0.17;
        this.draw(this.m.box, M4.trs(px + ox + Math.sin(a) * 0.3, 0.62, pz + oz + Math.cos(a) * 0.3, face, 0.16, 0.14, 0.62), metal);
        this.draw(this.m.box, M4.trs(px + ox + Math.sin(a) * 0.58, 0.32, pz + oz + Math.cos(a) * 0.58, face, 0.15, 0.6, 0.15), metal);
      }
      // anel de seleção no piso
      if (sel && !mirrored) this.draw(this.m.ring, M4.trs(px, 0.03, pz, t, 1.6, 1.6, 1.6), [0, 0, 0], col, { unlit: true });
      // rótulo (billboard voltado para a câmera)
      if (!mirrored) {
        const lab = M4.trs(px, 2.65, pz, this.cam.az, 1.6, 0.4, 1);
        this.draw(this.m.plane, lab, [0, 0, 0], [0, 0, 0], { tex: st.label, unlit: true, blend: true, alpha: 1 });
      }
    }
    // painéis suspensos
    for (const p of this.panels) {
      this.draw(this.m.box, p.frame, [0.06, 0.08, 0.12]);
      this.draw(this.m.plane, p.m, [0, 0, 0], [0, 0, 0], { tex: p.tex, unlit: true });
      if (!mirrored) for (const s of [-1, 1]) this.draw(this.m.cyl, M4.trs(p.m[12] + s * 2.8, 8.6, p.m[14] - 0.05, 0, 0.03, 2.8, 0.03), [0.2, 0.25, 0.3]);
    }
  }

  draw(mesh, m, color, emissive = [0, 0, 0], o = {}) {
    const gl = this.gl, u = this.u;
    gl.uniformMatrix4fv(u.uM, false, m);
    gl.uniform3fv(u.uColor, color);
    gl.uniform3fv(u.uEmissive, emissive);
    gl.uniform1f(u.uAlpha, o.alpha ?? 1);
    gl.uniform1f(u.uUnlit, o.unlit ? 1 : 0);
    if (o.tex) { gl.bindTexture(gl.TEXTURE_2D, o.tex.tex); gl.uniform1f(u.uUseTex, 1); } else gl.uniform1f(u.uUseTex, 0);
    const blend = o.blend || (o.alpha ?? 1) < 1;
    if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(mesh.mode, 0, mesh.count);
    if (blend) { gl.disable(gl.BLEND); gl.depthMask(true); }
  }
}

function wrap(c, text, x, y, maxW, lh, maxLines) {
  const words = String(text).split(/\s+/);
  let line = '', n = 0;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (c.measureText(test).width > maxW && line) {
      c.fillText(line, x, y); y += lh; n++; line = w;
      if (n >= maxLines) return y;
    } else line = test;
  }
  if (line && n < maxLines) { c.fillText(line, x, y); y += lh; }
  return y;
}

export function webgl2Available() {
  try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2')); } catch { return false; }
}
