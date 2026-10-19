import * as THREE from '../vendor/three.module.min.js';
import { toXYZ, toLatLon, greatCircle, ringToSegments } from './geo.js';

const HOLO = new THREE.Color('#6ff3e6');
const MIN_DIST = 1.16, MAX_DIST = 6, HOME_DIST = 3.7;

const globeVert = /* glsl */`
  varying vec2 vUv; varying vec3 vWorld;
  void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w; }`;
const globeFrag = /* glsl */`
  uniform sampler2D uLand; uniform sampler2D uPop; uniform float uTime;
  uniform float uPopOn; uniform float uGridOn;
  varying vec2 vUv; varying vec3 vWorld;
  void main(){
    float land = texture2D(uLand, vUv).r;
    vec3 col = mix(vec3(0.010,0.030,0.055), vec3(0.030,0.085,0.105), land);
    float lon = (vUv.x - 0.5) * 360.0, lat = (vUv.y - 0.5) * 180.0;
    float gx = abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0;
    float gy = abs(fract(lat / 15.0 + 0.5) - 0.5) * 15.0;
    float wx = max(fwidth(lon), 1e-4), wy = max(fwidth(lat), 1e-4);
    float grid = max(1.0 - smoothstep(0.0, wx * 1.2, gx), 1.0 - smoothstep(0.0, wy * 1.2, gy));
    grid *= step(fwidth(lon), 8.0);
    col += vec3(0.22, 0.80, 0.78) * grid * 0.10 * uGridOn;
    float pop = texture2D(uPop, vUv).r;
    col += vec3(1.0, 0.60, 0.28) * pow(pop, 2.0) * 0.8 * uPopOn;
    vec3 n = normalize(vWorld); vec3 v = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 2.6);
    col += vec3(0.30, 0.95, 0.90) * fres * 0.55;
    float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 1.35 + uTime * 1.6);
    col *= 0.95 + 0.05 * scan;
    gl_FragColor = vec4(col, 1.0);
  }`;

const atmoVert = /* glsl */`
  varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const atmoFrag = /* glsl */`
  uniform vec3 uColor; varying vec3 vN;
  void main(){ float i = pow(max(0.0, 0.66 - dot(vN, vec3(0.0,0.0,1.0))), 3.2);
    gl_FragColor = vec4(uColor * i * 1.7, 1.0); }`;

const dotVert = /* glsl */`
  attribute vec3 aColor; attribute float aSize; attribute float aPrec; attribute float aRecent;
  attribute float aSel; attribute float aSeed;
  uniform float uPx; uniform float uZoom;
  varying vec3 vColor; varying float vPrec; varying float vFacing; varying float vRecent; varying float vSel; varying float vSeed;
  void main(){
    vec3 n = normalize(position);
    vFacing = dot(n, normalize(cameraPosition - position));
    vColor = aColor; vPrec = aPrec; vRecent = aRecent; vSel = aSel; vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    float s = aSize * uZoom * (1.0 + aSel * 0.5) * (aRecent > 0.5 ? 2.0 : 1.0);
    gl_PointSize = vFacing > 0.0 ? s * uPx : 0.0;
  }`;
const dotFrag = /* glsl */`
  uniform float uTime; uniform float uMotion;
  varying vec3 vColor; varying float vPrec; varying float vFacing; varying float vRecent; varying float vSel; varying float vSeed;
  void main(){
    vec2 pc = gl_PointCoord * 2.0 - 1.0; float d = length(pc);
    if (d > 1.0) discard;
    float r = d * (vRecent > 0.5 ? 2.0 : 1.0);
    float disc = smoothstep(0.70, 0.52, r);
    float ring = smoothstep(0.72, 0.60, r) * smoothstep(0.36, 0.48, r);
    float core = vPrec > 2.5 ? disc : ring;
    float halo = exp(-r * r * 4.0) * 0.32;
    float pulse = 0.0;
    if (vRecent > 0.5) {
      float t = fract(uTime * 0.42 * uMotion + vSeed);
      float pr = mix(0.55, 1.95, t);
      pulse = smoothstep(0.14, 0.0, abs(r - pr)) * (1.0 - t) * 0.85;
    }
    float sel = vSel > 0.5 ? smoothstep(0.09, 0.0, abs(r - 0.92)) : 0.0;
    float fade = smoothstep(0.0, 0.28, vFacing);
    vec3 col = vColor * (core * 0.95 + halo * 0.7 + pulse) + vec3(1.0) * (core * 0.10 + sel * 0.9);
    gl_FragColor = vec4(col * fade * 0.92, 1.0);
  }`;

const lineVert = /* glsl */`
  attribute vec3 aColor; attribute float aAlpha; attribute float aT; attribute float aSeed;
  varying vec3 vColor; varying float vAlpha; varying float vT; varying float vSeed;
  void main(){ vColor = aColor; vAlpha = aAlpha; vT = aT; vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const lineFrag = /* glsl */`
  uniform float uTime; uniform float uFlow; uniform float uOpacity;
  varying vec3 vColor; varying float vAlpha; varying float vT; varying float vSeed;
  void main(){
    float a = vAlpha;
    if (uFlow > 0.0) { float f = fract(vT * 2.0 - uTime * 0.12 * uFlow + vSeed); a += smoothstep(0.88, 1.0, f) * 0.45; }
    gl_FragColor = vec4(vColor * a * uOpacity, 1.0);
  }`;

function additive(extra) {
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...extra });
}

export class Globe {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reduced = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor('#02060c', 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    this.view = { lat: 18, lon: 10, dist: HOME_DIST };
    this.target = { ...this.view };
    this.vel = { lat: 0, lon: 0 };
    this.autoRotate = !reducedMotion;
    this.lastInteract = 0;
    this.inset = { right: 0, bottom: 0 };
    this.places = [];
    this.handlers = { hover: () => {}, click: () => {}, frame: () => {} };
    this.uniforms = { uTime: { value: 0 } };
    this.layerOn = { pop: 1, grid: 1 };
    this.layerTarget = { pop: 1, grid: 1 };
    this.clock = new THREE.Clock();
    this.pointer = { x: -1, y: -1, moved: false, inside: false };
    this.buildBase();
    this.bindControls();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------------ base scene
  buildBase() {
    const loader = new THREE.TextureLoader();
    const tex = (url) => { const t = loader.load(url); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4; return t; };
    this.globeMat = new THREE.ShaderMaterial({
      vertexShader: globeVert, fragmentShader: globeFrag,
      uniforms: { uLand: { value: tex('assets/land.png') }, uPop: { value: tex('assets/population-density.png') },
        uTime: this.uniforms.uTime, uPopOn: { value: 1 }, uGridOn: { value: 1 } },
    });
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), this.globeMat);
    this.scene.add(this.globe);
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), additive({
      vertexShader: atmoVert, fragmentShader: atmoFrag, side: THREE.BackSide,
      uniforms: { uColor: { value: new THREE.Color('#2fb8c9') } },
    }));
    atmo.scale.setScalar(1.17);
    this.scene.add(atmo);
  }

  setCountries(countries) {
    const coast = [];
    for (const c of countries) for (const r of c.r) ringToSegments(r, 1.0015, coast);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(coast, 3));
    this.borders = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.borders);
  }

  highlightCountry(country) {
    if (this.hl) { this.scene.remove(this.hl); this.hl.geometry.dispose(); this.hl = null; }
    if (!country) return;
    const pts = [];
    for (const r of country.r) ringToSegments(r, 1.0025, pts, 0.6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.hl = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: '#d9fffb', transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.hl);
  }

  // ------------------------------------------------------------------ news dots
  // list: [{lat, lon, color:[r,g,b], size, prec, recent, key}]
  setPlaces(list) {
    this.places = list;
    const n = list.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const size = new Float32Array(n), prec = new Float32Array(n), rec = new Float32Array(n);
    const sel = new Float32Array(n), seed = new Float32Array(n);
    const tmp = [0, 0, 0];
    list.forEach((p, i) => {
      toXYZ(p.lat, p.lon, 1.004, tmp); pos.set(tmp, i * 3);
      col.set(p.color, i * 3); size[i] = p.size; prec[i] = p.prec; rec[i] = p.recent ? 1 : 0;
      sel[i] = p.key === this.selectedKey ? 1 : 0; seed[i] = (i * 0.618) % 1;
      p._v = [tmp[0], tmp[1], tmp[2]];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPrec', new THREE.BufferAttribute(prec, 1));
    g.setAttribute('aRecent', new THREE.BufferAttribute(rec, 1));
    g.setAttribute('aSel', new THREE.BufferAttribute(sel, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    if (!this.dots) {
      this.dotMat = additive({ vertexShader: dotVert, fragmentShader: dotFrag, depthTest: false,
        uniforms: { uTime: this.uniforms.uTime, uPx: { value: 1 }, uZoom: { value: 1 }, uMotion: { value: this.reduced ? 0 : 1 } } });
      this.dots = new THREE.Points(g, this.dotMat);
      this.dots.renderOrder = 5;
      this.scene.add(this.dots);
    } else {
      this.dots.geometry.dispose();
      this.dots.geometry = g;
    }
    this.dots.visible = this.newsOn !== false;
  }

  setSelected(key) {
    this.selectedKey = key;
    if (!this.dots) return;
    const a = this.dots.geometry.getAttribute('aSel');
    this.places.forEach((p, i) => { a.array[i] = p.key === key ? 1 : 0; });
    a.needsUpdate = true;
  }

  // beams: [{lat, lon, color, h}]
  setBeams(list) {
    if (this.beams) { this.scene.remove(this.beams); this.beams.geometry.dispose(); }
    const pos = [], col = [], alpha = [], t = [], seed = [];
    const a = [0, 0, 0], b = [0, 0, 0];
    for (const p of list) {
      toXYZ(p.lat, p.lon, 1.004, a); toXYZ(p.lat, p.lon, 1.004 + p.h, b);
      pos.push(...a, ...b); col.push(...p.color, ...p.color); alpha.push(0.9, 0.0); t.push(0, 1); seed.push(0, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    this.beams = new THREE.LineSegments(g, additive({ vertexShader: lineVert, fragmentShader: lineFrag,
      uniforms: { uTime: this.uniforms.uTime, uFlow: { value: 0 }, uOpacity: { value: 1 } } }));
    this.beams.visible = this.beamsOn !== false && this.newsOn !== false;
    this.scene.add(this.beams);
  }

  // ------------------------------------------------------------------ networks
  setAir(data) {
    const pos = [], col = [], alpha = [], tt = [], seed = [];
    const c = new THREE.Color('#8ab8ff');
    const maxN = Math.max(...data.routes.map((r) => r[2]));
    const p0 = [0, 0, 0], p1 = [0, 0, 0];
    data.routes.forEach(([ia, ib, n], k) => {
      const A = data.airports[ia], B = data.airports[ib];
      const { pts, angle } = greatCircle(A[2], A[3], B[2], B[3], 28);
      const h = Math.min(0.2, 0.015 + angle * 0.085);
      const base = 0.035 + 0.09 * Math.sqrt(n / maxN);
      const sd = (k * 0.37) % 1;
      for (let i = 0; i < pts.length - 1; i++) {
        const t0 = i / (pts.length - 1), t1 = (i + 1) / (pts.length - 1);
        toXYZ(pts[i].lat, pts[i].lon, 1.003 + h * Math.sin(Math.PI * t0), p0);
        toXYZ(pts[i + 1].lat, pts[i + 1].lon, 1.003 + h * Math.sin(Math.PI * t1), p1);
        pos.push(...p0, ...p1); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        alpha.push(base, base); tt.push(t0, t1); seed.push(sd, sd);
      }
    });
    this.air = this.lineLayer(pos, col, alpha, tt, seed, 1);
  }

  setSea(lines) {
    const pos = [], col = [], alpha = [], tt = [], seed = [];
    const c = new THREE.Color('#3f8cff');
    const w = [0.42, 0.26, 0.15];
    lines.forEach(([type, flat], k) => {
      const seg = [];
      for (let i = 0; i < flat.length - 2; i += 2) ringToSegments([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]], 1.0018, seg, 2);
      const n = seg.length / 6;
      for (let i = 0; i < n; i++) {
        pos.push(...seg.slice(i * 6, i * 6 + 6)); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        alpha.push(w[type], w[type]); tt.push(i / 12, (i + 1) / 12); seed.push(k * 0.13 % 1, k * 0.13 % 1);
      }
    });
    this.sea = this.lineLayer(pos, col, alpha, tt, seed, 0.5);
  }

  lineLayer(pos, col, alpha, tt, seed, flow) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    const m = new THREE.LineSegments(g, additive({ vertexShader: lineVert, fragmentShader: lineFrag,
      uniforms: { uTime: this.uniforms.uTime, uFlow: { value: this.reduced ? 0 : flow }, uOpacity: { value: 1 } } }));
    this.scene.add(m);
    return m;
  }

  setLayer(name, on) {
    if (name === 'pop' || name === 'grid') this.layerTarget[name] = on ? 1 : 0;
    else if (name === 'news') { this.newsOn = on; if (this.dots) this.dots.visible = on; if (this.beams) this.beams.visible = on && this.beamsOn !== false; }
    else if (name === 'beams') { this.beamsOn = on; if (this.beams) this.beams.visible = on && this.newsOn !== false; }
    else if (name === 'air' && this.air) this.air.visible = on;
    else if (name === 'sea' && this.sea) this.sea.visible = on;
    else if (name === 'borders' && this.borders) this.borders.visible = on;
    else if (name === 'rotate') this.autoRotate = on && !this.reduced;
  }

  // ------------------------------------------------------------------ camera
  setInset(right, bottom) { this.inset = { right, bottom }; this.resize(); }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the globe's width in view on portrait screens by widening the vertical field of view
    this.camera.fov = Math.max(34, Math.min(75, 2 * Math.atan(Math.tan(16.5 * Math.PI / 180) * h / w) * 180 / Math.PI));
    // shift the globe's centre into the area not covered by panels
    this.camera.setViewOffset(w, h, this.inset.right / 2, this.inset.bottom / 2, w, h);
    this.camera.updateProjectionMatrix();
    this.size = { w, h };
    this.dotScale = Math.max(0.62, Math.min(1, Math.min(w, h) / 820));
    if (this.dotMat) this.dotMat.uniforms.uPx.value = this.renderer.getPixelRatio();
  }

  flyTo(lat, lon, dist = Math.min(this.view.dist, 2.2), ms = 1500) {
    if (this.reduced) ms = 0;
    let dLon = ((lon - this.view.lon + 540) % 360) - 180;
    this.fly = { from: { ...this.view }, to: { lat, lon: this.view.lon + dLon, dist }, t0: performance.now(), ms };
    this.vel.lat = this.vel.lon = 0;
    this.lastInteract = performance.now();
  }

  home() { this.flyTo(this.view.lat > 60 || this.view.lat < -60 ? 15 : this.view.lat, this.view.lon, HOME_DIST); }
  zoomBy(f) { this.target.dist = THREE.MathUtils.clamp(this.target.dist * f, MIN_DIST, MAX_DIST); this.lastInteract = performance.now(); }
  setView(lat, lon, dist) { Object.assign(this.view, { lat, lon, dist }); Object.assign(this.target, this.view); }

  bindControls() {
    const c = this.canvas;
    const pts = new Map();
    let drag = null, pinch = null;
    const degPerPx = () => 0.16 * (this.view.dist - 0.88) * (900 / Math.max(500, this.size.h));
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.fly = null; this.lastInteract = performance.now(); this.pointerDown = true;
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: 0 };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.target.dist };
        drag = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, moved: true, inside: true };
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.target.dist = THREE.MathUtils.clamp(pinch.dist * (pinch.d / d), MIN_DIST, MAX_DIST);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      const k = degPerPx();
      this.target.lon -= dx * k; this.target.lat = THREE.MathUtils.clamp(this.target.lat + dy * k, -82, 82);
      this.vel.lon = -dx * k; this.vel.lat = dy * k;
      this.lastInteract = performance.now();
      if (drag.moved > 4) c.classList.add('dragging');
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (!pts.size) this.pointerDown = false;
      c.classList.remove('dragging');
      if (pts.size < 2) pinch = null;
      if (drag && drag.moved < 6 && performance.now() - drag.t < 600 && e.type === 'pointerup') {
        const r = c.getBoundingClientRect();
        this.handlers.click(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
      if (drag && drag.moved < 6) { this.vel.lat = this.vel.lon = 0; }
      drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.pointer.inside = false; this.handlers.hover(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fly = null;
      this.zoomBy(Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0012)));
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (hit.lat != null) this.flyTo(hit.lat, hit.lon, Math.max(MIN_DIST + 0.1, this.view.dist * 0.6), 900);
    });
  }

  // ------------------------------------------------------------------ picking
  ray(x, y) {
    const ndc = new THREE.Vector2((x / this.size.w) * 2 - 1, -(y / this.size.h) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return rc.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), hit) ? hit : null;
  }

  project(lat, lon, r = 1.004) {
    const p = toXYZ(lat, lon, r);
    return this.projectV(p);
  }

  projectV(p) {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    const cam = this.camera.position;
    const facing = (v.x * (cam.x - v.x) + v.y * (cam.y - v.y) + v.z * (cam.z - v.z)) > 0;
    v.project(this.camera);
    return { x: (v.x + 1) / 2 * this.size.w, y: (1 - v.y) / 2 * this.size.h, visible: facing };
  }

  pick(x, y) {
    const hit = this.ray(x, y);
    let best = null, bestD = Infinity;
    if (this.dots?.visible) {
      const zoom = this.dotMat.uniforms.uZoom.value;
      for (const p of this.places) {
        const s = this.projectV(p._v);
        if (!s.visible) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        const reach = p.size * zoom * 0.5 + 6;
        if (d < reach && d < bestD) { best = p; bestD = d; }
      }
    }
    const ll = hit ? toLatLon(hit.x, hit.y, hit.z) : {};
    return { place: best, lat: ll.lat, lon: ll.lon, x, y };
  }

  // ------------------------------------------------------------------ loop
  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const now = performance.now();
    this.uniforms.uTime.value += dt;
    if (this.fly) {
      const t = this.fly.ms ? Math.min(1, (now - this.fly.t0) / this.fly.ms) : 1;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const { from, to } = this.fly;
      // pull back a little mid-flight for long hops
      const hop = Math.min(1, Math.hypot(to.lat - from.lat, to.lon - from.lon) / 120);
      this.view.lat = from.lat + (to.lat - from.lat) * e;
      this.view.lon = from.lon + (to.lon - from.lon) * e;
      this.view.dist = from.dist + (to.dist - from.dist) * e + Math.sin(Math.PI * e) * hop * 0.8;
      Object.assign(this.target, this.view);
      if (t >= 1) this.fly = null;
    } else {
      const idle = now - this.lastInteract > 3500;
      if (!this.pointerDown) {
        this.target.lon += this.vel.lon; this.target.lat = THREE.MathUtils.clamp(this.target.lat + this.vel.lat, -82, 82);
        this.vel.lon *= 0.9; this.vel.lat *= 0.9;
      }
      if (this.autoRotate && idle) this.target.lon += dt * 3.2;
      const k = 1 - Math.pow(0.0008, dt);
      this.view.lat += (this.target.lat - this.view.lat) * k;
      this.view.lon += (this.target.lon - this.view.lon) * k;
      this.view.dist += (this.target.dist - this.view.dist) * k;
    }
    const p = toXYZ(this.view.lat, this.view.lon, this.view.dist);
    this.camera.position.set(p[0], p[1], p[2]);
    this.camera.lookAt(0, 0, 0);
    for (const n of ['pop', 'grid']) {
      this.layerOn[n] += (this.layerTarget[n] - this.layerOn[n]) * Math.min(1, dt * 6);
    }
    this.globeMat.uniforms.uPopOn.value = this.layerOn.pop;
    this.globeMat.uniforms.uGridOn.value = this.layerOn.grid;
    if (this.dotMat) this.dotMat.uniforms.uZoom.value = THREE.MathUtils.clamp(Math.pow(3.7 / this.view.dist, 0.5), 0.7, 2.1) * this.dotScale;
    if (this.borders) this.borders.material.opacity = THREE.MathUtils.clamp(0.30 + (3.2 - this.view.dist) * 0.12, 0.3, 0.6);
    if (this.pointer.moved && this.pointer.inside) {
      this.pointer.moved = false;
      if (!this.canvas.classList.contains('dragging')) this.handlers.hover(this.pick(this.pointer.x, this.pointer.y));
    }
    this.renderer.render(this.scene, this.camera);
    this.handlers.frame();
  }

  on(name, fn) { this.handlers[name] = fn; }
}
