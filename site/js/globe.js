import * as THREE from '../vendor/three.module.min.js';
import { toXYZ, toLatLon, greatCircle, ringToSegments } from './geo.js';

const HOLO = new THREE.Color('#6ff3e6');
const MIN_DIST = 1.16, MAX_DIST = 6, HOME_DIST = 3.7;
const D2R = Math.PI / 180;

// ------------------------------------------------------------------ shaders
const globeVert = /* glsl */`
  varying vec2 vUv; varying vec3 vWorld;
  void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w; }`;
const globeFrag = /* glsl */`
  uniform sampler2D uLand; uniform sampler2D uWx; uniform float uTime;
  uniform float uGridOn; uniform float uNightOn; uniform float uCloudOn; uniform float uTempOn;
  uniform vec3 uSun;
  varying vec2 vUv; varying vec3 vWorld;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a*noise(p); p *= 2.03; a *= 0.5; } return v; }
  vec3 tempRamp(float t){ // t: 0 = -45C, 1 = +45C
    vec3 c = mix(vec3(0.35,0.25,0.95), vec3(0.20,0.70,1.00), smoothstep(0.15,0.42,t));
    c = mix(c, vec3(0.30,0.95,0.60), smoothstep(0.42,0.58,t));
    c = mix(c, vec3(1.00,0.85,0.25), smoothstep(0.58,0.72,t));
    return mix(c, vec3(1.00,0.25,0.20), smoothstep(0.72,0.90,t)); }
  void main(){
    float land = texture2D(uLand, vUv).r;
    vec3 col = mix(vec3(0.010,0.030,0.055), vec3(0.030,0.085,0.105), land);
    float lon = (vUv.x - 0.5) * 360.0, lat = (vUv.y - 0.5) * 180.0;
    vec3 n = normalize(vWorld);
    vec4 wx = texture2D(uWx, vUv);
    if (uTempOn > 0.001) col = mix(col, tempRamp(wx.r) * (0.55 + 0.25 * land), 0.62 * uTempOn);
    float gx = abs(fract(lon / 15.0 + 0.5) - 0.5) * 15.0;
    float gy = abs(fract(lat / 15.0 + 0.5) - 0.5) * 15.0;
    float wlon = max(fwidth(lon), 1e-4), wlat = max(fwidth(lat), 1e-4);
    float grid = max(1.0 - smoothstep(0.0, wlon * 1.2, gx), 1.0 - smoothstep(0.0, wlat * 1.2, gy));
    grid *= step(fwidth(lon), 8.0);
    col += vec3(0.22, 0.80, 0.78) * grid * 0.10 * uGridOn;
    if (uCloudOn > 0.001) {
      vec2 p = vec2(lon * 0.09 + uTime * 0.012, lat * 0.12);
      float detail = fbm(p) * 0.55 + fbm(p * 3.1 - uTime * 0.02) * 0.25;
      float cl = smoothstep(0.32, 0.85, wx.g * 0.75 + detail * 0.5) * (0.3 + 0.7 * wx.g);
      col = mix(col, vec3(0.82, 0.93, 0.98), cl * 0.72 * uCloudOn);
    }
    float day = dot(n, uSun);
    float night = smoothstep(0.08, -0.18, day);
    col *= mix(1.0, 0.45, night * uNightOn);
    col += vec3(0.5, 0.9, 1.0) * smoothstep(0.12, 0.0, abs(day)) * 0.035 * uNightOn; // terminator glow
    vec3 v = normalize(cameraPosition - vWorld);
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
      pulse = smoothstep(0.14, 0.0, abs(r - mix(0.55, 1.95, t))) * (1.0 - t) * 0.85;
    }
    float sel = vSel > 0.5 ? smoothstep(0.09, 0.0, abs(r - 0.92)) : 0.0;
    float fade = smoothstep(0.0, 0.28, vFacing);
    vec3 col = vColor * (core * 0.95 + halo * 0.7 + pulse) + vec3(1.0) * (core * 0.10 + sel * 0.9);
    gl_FragColor = vec4(col * fade * 0.92, 1.0);
  }`;

const popVert = /* glsl */`
  attribute float aV;
  uniform float uSpacing; uniform float uPx; uniform vec3 uSun; uniform float uNightOn;
  varying float vV; varying float vFacing; varying float vNight; varying float vComp; varying float vSoft;
  void main(){
    vec3 n = normalize(position);
    vFacing = dot(n, normalize(cameraPosition - position));
    vNight = smoothstep(0.05, -0.2, dot(n, uSun)) * uNightOn;
    vV = aV;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // When zoomed out, dots are closer together than a few pixels. Instead of tiny
    // hard dots (which shimmer), draw soft overlapping dots and dim them to match,
    // so the layer reads as a smooth glow. Zoomed in, they become crisp dots again.
    float base = max(1.4, uSpacing * (0.22 + 0.42 * aV));
    float soft = 1.0 - smoothstep(3.0, 8.0, uSpacing);
    float s = max(base, uSpacing * 1.6 * soft);
    vComp = clamp((base * base) / (s * s) * 1.9, 0.16, 1.0);
    vSoft = soft;
    gl_PointSize = vFacing > 0.0 ? s * uPx : 0.0;
  }`;
const popFrag = /* glsl */`
  uniform float uOn;
  varying float vV; varying float vFacing; varying float vNight; varying float vComp; varying float vSoft;
  void main(){
    float d = length(gl_PointCoord * 2.0 - 1.0);
    if (d > 1.0) discard;
    float a = mix(smoothstep(1.0, 0.35, d), exp(-d * d * 2.2) * (1.0 - d * d), vSoft) * vComp;
    vec3 col = mix(vec3(1.0, 0.55, 0.22), vec3(1.0, 0.92, 0.70), vV * vV);
    float k = (0.18 + 0.82 * vV) * smoothstep(0.0, 0.25, vFacing) * uOn * mix(0.75, 1.35, vNight);
    gl_FragColor = vec4(col * a * k * 0.85, 1.0);
  }`;

const stationVert = /* glsl */`
  uniform float uPx; varying float vFacing;
  void main(){ vec3 n = normalize(position); vFacing = dot(n, normalize(cameraPosition - position));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = vFacing > 0.0 ? 11.0 * uPx : 0.0; }`;
const stationFrag = /* glsl */`
  varying float vFacing;
  void main(){ vec2 p = abs(gl_PointCoord * 2.0 - 1.0); float d = p.x + p.y;
    if (d > 1.0) discard;
    float edge = smoothstep(1.0, 0.8, d) * (0.45 + 0.55 * smoothstep(0.55, 0.75, d));
    gl_FragColor = vec4(vec3(0.85, 0.97, 1.0) * edge * smoothstep(0.0, 0.25, vFacing), 1.0); }`;

const lineVert = /* glsl */`
  attribute vec3 aColor; attribute float aAlpha; attribute float aT; attribute float aSeed;
  varying vec3 vColor; varying float vAlpha; varying float vT; varying float vSeed;
  void main(){ vColor = aColor; vAlpha = aAlpha; vT = aT; vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const lineFrag = /* glsl */`
  uniform float uTime; uniform float uFlow; uniform float uOpacity; uniform float uDash;
  varying vec3 vColor; varying float vAlpha; varying float vT; varying float vSeed;
  void main(){
    float a = vAlpha;
    if (uFlow > 0.0) { float f = fract(vT * uDash - uTime * 0.12 * uFlow + vSeed); a += smoothstep(0.88, 1.0, f) * 0.45 * (vAlpha > 0.0 ? 1.0 : 0.0); }
    gl_FragColor = vec4(vColor * a * uOpacity, 1.0);
  }`;

const windVert = /* glsl */`
  attribute float aA; varying float vA; varying float vFacing;
  void main(){ vA = aA; vec3 n = normalize(position); vFacing = dot(n, normalize(cameraPosition - position));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const windFrag = /* glsl */`
  uniform float uOn; varying float vA; varying float vFacing;
  void main(){ gl_FragColor = vec4(vec3(0.75, 0.95, 1.0) * vA * uOn * smoothstep(0.0, 0.2, vFacing), 1.0); }`;

function additive(extra) {
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...extra });
}

function lineGeometry(pos, col, alpha, tt, seed) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(tt, 1));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  return g;
}

// Sub-solar point for a given time (accurate to a fraction of a degree).
export function sunPosition(date = new Date()) {
  const d = (date.getTime() / 86400000) + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * D2R;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * d) * D2R;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  let lon = (ra / D2R - gmst * 15) % 360;
  if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
  return { lat: dec / D2R, lon };
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
    this.spin = !reducedMotion;       // user's preference
    this.hold = false;                // something is selected: don't spin
    this.lastInteract = 0;
    this.inset = { right: 0, bottom: 0 };
    this.places = [];
    this.stations = [];
    this.handlers = { hover: () => {}, click: () => {}, frame: () => {} };
    this.uniforms = { uTime: { value: 0 }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uNightOn: { value: 1 } };
    this.fade = { grid: [1, 1], night: [1, 1], cloud: [0, 0], temp: [0, 0], pop: [1, 1], wind: [0, 0] };
    this.on_ = { news: true, beams: true, links: true };
    this.clock = new THREE.Clock();
    this.pointer = { x: -1, y: -1, moved: false, inside: false };
    this.buildBase();
    this.bindControls();
    this.resize();
    this.updateSun();
    setInterval(() => this.updateSun(), 60e3);
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get autoRotate() { return this.spin && !this.hold; }

  updateSun() {
    const s = sunPosition();
    const p = toXYZ(s.lat, s.lon, 1);
    this.uniforms.uSun.value.set(p[0], p[1], p[2]).normalize();
    this.sun = s;
  }

  // ------------------------------------------------------------------ base scene
  buildBase() {
    const loader = new THREE.TextureLoader();
    const land = loader.load('assets/land.png');
    land.colorSpace = THREE.NoColorSpace; land.anisotropy = 4;
    this.wxTex = new THREE.DataTexture(new Uint8Array([128, 0, 0, 255]), 1, 1);
    this.wxTex.needsUpdate = true;
    this.globeMat = new THREE.ShaderMaterial({
      vertexShader: globeVert, fragmentShader: globeFrag,
      uniforms: { uLand: { value: land }, uWx: { value: this.wxTex }, uTime: this.uniforms.uTime,
        uSun: this.uniforms.uSun, uNightOn: this.uniforms.uNightOn,
        uGridOn: { value: 1 }, uCloudOn: { value: 0 }, uTempOn: { value: 0 } },
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
    const segs = [];
    for (const c of countries) for (const r of c.r) ringToSegments(r, 1.0015, segs);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    this.borders = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.borders);
  }

  highlightCountry(country) {
    if (this.hl) { this.scene.remove(this.hl); this.hl.geometry.dispose(); this.hl = null; }
    if (!country || !country.r) return;
    const pts = [];
    for (const r of country.r) ringToSegments(r, 1.0025, pts, 0.6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.hl = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: '#d9fffb', transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scene.add(this.hl);
  }

  // ------------------------------------------------------------------ population dot matrix
  setPopulation(positions, values, stepDeg) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aV', new THREE.BufferAttribute(values, 1));
    this.popStep = stepDeg * D2R;
    this.popMat = additive({ vertexShader: popVert, fragmentShader: popFrag,
      uniforms: { uSpacing: { value: 2 }, uPx: { value: this.renderer.getPixelRatio() }, uOn: { value: this.fade.pop[0] },
        uSun: this.uniforms.uSun, uNightOn: this.uniforms.uNightOn } });
    this.pop = new THREE.Points(g, this.popMat);
    this.pop.renderOrder = 2;
    this.scene.add(this.pop);
  }

  // ------------------------------------------------------------------ news dots
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
        uniforms: { uTime: this.uniforms.uTime, uPx: { value: this.renderer.getPixelRatio() }, uZoom: { value: 1 },
          uMotion: { value: this.reduced ? 0 : 1 } } });
      this.dots = new THREE.Points(g, this.dotMat);
      this.dots.renderOrder = 5;
      this.scene.add(this.dots);
    } else {
      this.dots.geometry.dispose();
      this.dots.geometry = g;
    }
    this.dots.visible = this.on_.news;
  }

  setSelected(key) {
    this.selectedKey = key;
    if (!this.dots) return;
    const a = this.dots.geometry.getAttribute('aSel');
    this.places.forEach((p, i) => { a.array[i] = p.key === key ? 1 : 0; });
    a.needsUpdate = true;
  }

  setBeams(list) {
    if (this.beams) { this.scene.remove(this.beams); this.beams.geometry.dispose(); }
    const pos = [], col = [], alpha = [], t = [], seed = [];
    const a = [0, 0, 0], b = [0, 0, 0];
    for (const p of list) {
      toXYZ(p.lat, p.lon, 1.004, a); toXYZ(p.lat, p.lon, 1.004 + p.h, b);
      pos.push(...a, ...b); col.push(...p.color, ...p.color); alpha.push(0.9, 0.0); t.push(0, 1); seed.push(0, 0);
    }
    this.beams = new THREE.LineSegments(lineGeometry(pos, col, alpha, t, seed), additive({
      vertexShader: lineVert, fragmentShader: lineFrag,
      uniforms: { uTime: this.uniforms.uTime, uFlow: { value: 0 }, uOpacity: { value: 1 }, uDash: { value: 2 } } }));
    this.beams.visible = this.on_.beams && this.on_.news;
    this.scene.add(this.beams);
  }

  // ------------------------------------------------------------------ arcs
  arcPoints(lat1, lon1, lat2, lon2, lift, steps = 32) {
    const { pts, angle } = greatCircle(lat1, lon1, lat2, lon2, steps);
    const h = lift(angle);
    return pts.map((p, i) => toXYZ(p.lat, p.lon, 1.003 + h * Math.sin(Math.PI * i / steps)));
  }

  // links: [{a:{lat,lon}, b:{lat,lon}, color:[r,g,b], w: 0..1}]
  setLinks(list) {
    if (this.links) { this.scene.remove(this.links); this.links.geometry.dispose(); }
    const pos = [], col = [], alpha = [], tt = [], seed = [];
    list.forEach((l, k) => {
      const pts = this.arcPoints(l.a.lat, l.a.lon, l.b.lat, l.b.lon, (ang) => Math.min(0.32, 0.04 + ang * 0.16), 40);
      const base = 0.10 + 0.45 * l.w, sd = (k * 0.29) % 1;
      for (let i = 0; i < pts.length - 1; i++) {
        pos.push(...pts[i], ...pts[i + 1]); col.push(...l.color, ...l.color);
        alpha.push(base, base); tt.push(i / 40, (i + 1) / 40); seed.push(sd, sd);
      }
    });
    this.links = new THREE.LineSegments(lineGeometry(pos, col, alpha, tt, seed), additive({
      vertexShader: lineVert, fragmentShader: lineFrag,
      uniforms: { uTime: this.uniforms.uTime, uFlow: { value: this.reduced ? 0 : 1.6 }, uOpacity: { value: 1 }, uDash: { value: 1 } } }));
    this.links.renderOrder = 4;
    this.links.visible = this.on_.links;
    this.scene.add(this.links);
  }

  setAir(data) {
    const pos = [], col = [], alpha = [], tt = [], seed = [];
    const c = new THREE.Color('#f2f6ff');
    const maxN = Math.max(...data.routes.map((r) => r[2]));
    data.routes.forEach(([ia, ib, n], k) => {
      const A = data.airports[ia], B = data.airports[ib];
      const pts = this.arcPoints(A[2], A[3], B[2], B[3], (ang) => Math.min(0.2, 0.015 + ang * 0.085), 28);
      const base = 0.03 + 0.08 * Math.sqrt(n / maxN), sd = (k * 0.37) % 1;
      for (let i = 0; i < pts.length - 1; i++) {
        pos.push(...pts[i], ...pts[i + 1]); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        alpha.push(base, base); tt.push(i / 28, (i + 1) / 28); seed.push(sd, sd);
      }
    });
    this.air = this.lineLayer(pos, col, alpha, tt, seed, 1, 2);
  }

  setSea(lines) {
    const pos = [], col = [], alpha = [], tt = [], seed = [];
    const c = new THREE.Color('#2f7dff');
    const w = [0.55, 0.34, 0.2];
    lines.forEach(([type, flat], k) => {
      const seg = [];
      for (let i = 0; i < flat.length - 2; i += 2) ringToSegments([flat[i], flat[i + 1], flat[i + 2], flat[i + 3]], 1.0018, seg, 2);
      const n = seg.length / 6;
      for (let i = 0; i < n; i++) {
        pos.push(...seg.slice(i * 6, i * 6 + 6)); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        alpha.push(w[type], w[type]); tt.push(i / 12, (i + 1) / 12); seed.push((k * 0.13) % 1, (k * 0.13) % 1);
      }
    });
    this.sea = this.lineLayer(pos, col, alpha, tt, seed, 0.5, 2);
  }

  lineLayer(pos, col, alpha, tt, seed, flow, dash) {
    const m = new THREE.LineSegments(lineGeometry(pos, col, alpha, tt, seed), additive({
      vertexShader: lineVert, fragmentShader: lineFrag,
      uniforms: { uTime: this.uniforms.uTime, uFlow: { value: this.reduced ? 0 : flow }, uOpacity: { value: 1 }, uDash: { value: dash } } }));
    this.scene.add(m);
    return m;
  }

  // ------------------------------------------------------------------ research stations
  setStations(list) {
    this.stations = list;
    const pos = new Float32Array(list.length * 3), tmp = [0, 0, 0];
    list.forEach((s, i) => { toXYZ(s.lat, s.lon, 1.004, tmp); pos.set(tmp, i * 3); s._v = [...tmp]; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stationPts = new THREE.Points(g, additive({ vertexShader: stationVert, fragmentShader: stationFrag, depthTest: false,
      uniforms: { uPx: { value: this.renderer.getPixelRatio() } } }));
    this.stationPts.renderOrder = 6;
    this.scene.add(this.stationPts);
  }

  // ------------------------------------------------------------------ weather
  setWeather(w) {
    const W = w.lons.length, H = w.lats.length;
    const data = new Uint8Array(W * H * 4);
    this.wind = { W, H, step: w.step, lat0: w.lats[0], lon0: w.lons[0], u: new Float32Array(W * H), v: new Float32Array(W * H) };
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        const t = w.temp[i] ?? 10, cl = w.cloud[i] ?? 0, sp = w.speed[i] ?? 0, dir = (w.dir[i] ?? 0) * D2R;
        data[i * 4] = Math.max(0, Math.min(255, ((t + 45) / 90) * 255));
        data[i * 4 + 1] = Math.max(0, Math.min(255, cl * 2.55));
        data[i * 4 + 2] = Math.max(0, Math.min(255, (w.precip[i] ?? 0) * 50));
        data[i * 4 + 3] = 255;
        // meteorological direction is where the wind comes from
        this.wind.u[i] = -sp * Math.sin(dir);
        this.wind.v[i] = -sp * Math.cos(dir);
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.globeMat.uniforms.uWx.value = tex;
    this.buildWind();
  }

  sampleWind(lat, lon) {
    const w = this.wind;
    const fx = (((lon - w.lon0) / w.step) % w.W + w.W) % w.W;
    const fy = Math.max(0, Math.min(w.H - 1.001, (lat - w.lat0) / w.step));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = (x0 + 1) % w.W, y1 = y0 + 1;
    const tx = fx - x0, ty = fy - y0;
    const at = (arr, x, y) => arr[y * w.W + x];
    const bl = (arr) => (at(arr, x0, y0) * (1 - tx) + at(arr, x1, y0) * tx) * (1 - ty)
      + (at(arr, x0, y1) * (1 - tx) + at(arr, x1, y1) * tx) * ty;
    return [bl(w.u), bl(w.v)];
  }

  buildWind() {
    const N = matchMedia('(max-width: 820px)').matches ? 2600 : 5200, TRAIL = 6;
    this.particles = { N, TRAIL, lat: new Float32Array(N), lon: new Float32Array(N), age: new Float32Array(N),
      life: new Float32Array(N), hist: new Float32Array(N * TRAIL * 2), speed: new Float32Array(N) };
    for (let i = 0; i < N; i++) this.respawn(i, true);
    const segs = N * (TRAIL - 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(segs * 2), 1).setUsage(THREE.DynamicDrawUsage));
    if (this.windLines) { this.scene.remove(this.windLines); this.windLines.geometry.dispose(); }
    this.windLines = new THREE.LineSegments(g, additive({ vertexShader: windVert, fragmentShader: windFrag,
      uniforms: { uOn: { value: this.fade.wind[0] } } }));
    this.windLines.frustumCulled = false;
    this.windLines.renderOrder = 3;
    this.scene.add(this.windLines);
  }

  respawn(i, initial) {
    const p = this.particles;
    p.lat[i] = Math.asin(Math.random() * 2 - 1) / D2R;
    p.lon[i] = Math.random() * 360 - 180;
    p.life[i] = 2.5 + Math.random() * 4;
    p.age[i] = initial ? Math.random() * p.life[i] : 0;
    for (let k = 0; k < p.TRAIL; k++) { p.hist[(i * p.TRAIL + k) * 2] = p.lat[i]; p.hist[(i * p.TRAIL + k) * 2 + 1] = p.lon[i]; }
  }

  stepWind(dt) {
    const p = this.particles, T = p.TRAIL;
    if (!p || this.fade.wind[0] < 0.01) return;
    const pos = this.windLines.geometry.attributes.position.array;
    const aA = this.windLines.geometry.attributes.aA.array;
    const k = this.reduced ? 0 : 0.55, tmp1 = [0, 0, 0], tmp2 = [0, 0, 0];
    p.acc = (p.acc || 0) + dt;
    const shift = p.acc > 0.09;
    if (shift) p.acc = 0;
    for (let i = 0; i < p.N; i++) {
      p.age[i] += dt;
      if (p.age[i] > p.life[i]) this.respawn(i, false);
      const [u, v] = this.sampleWind(p.lat[i], p.lon[i]);
      const sp = Math.hypot(u, v);
      p.speed[i] = sp;
      p.lat[i] = Math.max(-85, Math.min(85, p.lat[i] + v * dt * k));
      p.lon[i] += (u * dt * k) / Math.max(0.2, Math.cos(p.lat[i] * D2R));
      if (p.lon[i] > 180) p.lon[i] -= 360; else if (p.lon[i] < -180) p.lon[i] += 360;
      const base = i * T * 2;
      if (shift) p.hist.copyWithin(base + 2, base, base + (T - 1) * 2);
      p.hist[base] = p.lat[i]; p.hist[base + 1] = p.lon[i];
      const life = Math.min(1, p.age[i] / 0.6, (p.life[i] - p.age[i]) / 0.8);
      const bright = Math.min(1, 0.3 + sp / 12) * life;
      for (let s = 0; s < T - 1; s++) {
        const la1 = p.hist[base + s * 2], lo1 = p.hist[base + s * 2 + 1];
        const la2 = p.hist[base + s * 2 + 2], lo2 = p.hist[base + s * 2 + 3];
        const o = (i * (T - 1) + s) * 6;
        toXYZ(la1, lo1, 1.009, tmp1);
        if (Math.abs(lo1 - lo2) > 90) { toXYZ(la1, lo1, 1.009, tmp2); } else toXYZ(la2, lo2, 1.009, tmp2);
        pos[o] = tmp1[0]; pos[o + 1] = tmp1[1]; pos[o + 2] = tmp1[2];
        pos[o + 3] = tmp2[0]; pos[o + 4] = tmp2[1]; pos[o + 5] = tmp2[2];
        const a = bright * (1 - s / (T - 1));
        aA[(i * (T - 1) + s) * 2] = a; aA[(i * (T - 1) + s) * 2 + 1] = a * 0.7;
      }
    }
    this.windLines.geometry.attributes.position.needsUpdate = true;
    this.windLines.geometry.attributes.aA.needsUpdate = true;
  }

  // ------------------------------------------------------------------ layers
  setLayer(name, on) {
    const v = on ? 1 : 0;
    if (name in this.fade) this.fade[name][1] = v;
    if (name === 'news') { this.on_.news = on; if (this.dots) this.dots.visible = on; if (this.beams) this.beams.visible = on && this.on_.beams; }
    if (name === 'beams') { this.on_.beams = on; if (this.beams) this.beams.visible = on && this.on_.news; }
    if (name === 'links') { this.on_.links = on; if (this.links) this.links.visible = on; }
    if (name === 'air' && this.air) this.air.visible = on;
    if (name === 'sea' && this.sea) this.sea.visible = on;
    if (name === 'stations' && this.stationPts) this.stationPts.visible = on;
    if (name === 'borders' && this.borders) this.borders.visible = on;
  }

  setSpin(on) { this.spin = on && !this.reduced; this.lastInteract = 0; }
  setHold(on) { this.hold = on; if (!on) this.lastInteract = performance.now() - 2000; }

  // ------------------------------------------------------------------ camera
  setInset(right, bottom) { this.inset = { right, bottom }; this.resize(); }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = Math.max(34, Math.min(75, 2 * Math.atan(Math.tan(16.5 * D2R) * h / w) / D2R));
    this.camera.setViewOffset(w, h, this.inset.right / 2, this.inset.bottom / 2, w, h);
    this.camera.updateProjectionMatrix();
    this.size = { w, h };
    this.dotScale = Math.max(0.62, Math.min(1, Math.min(w, h) / 820));
  }

  flyTo(lat, lon, dist = Math.min(this.view.dist, 2.2), ms = 1500) {
    if (this.reduced) ms = 0;
    const dLon = ((lon - this.view.lon + 540) % 360) - 180;
    this.fly = { from: { ...this.view }, to: { lat, lon: this.view.lon + dLon, dist }, t0: performance.now(), ms };
    this.vel.lat = this.vel.lon = 0;
    this.lastInteract = performance.now();
  }

  home() { this.flyTo(Math.abs(this.view.lat) > 60 ? 15 : this.view.lat, this.view.lon, HOME_DIST); }
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
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
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
        this.target.dist = THREE.MathUtils.clamp(pinch.dist * (pinch.d / Math.hypot(a.x - b.x, a.y - b.y)), MIN_DIST, MAX_DIST);
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
      if (drag && drag.moved < 6) this.vel.lat = this.vel.lon = 0;
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
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.size.w) * 2 - 1, -(y / this.size.h) * 2 + 1), this.camera);
    const hit = new THREE.Vector3();
    return rc.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), hit) ? hit : null;
  }

  project(lat, lon, r = 1.004) { return this.projectV(toXYZ(lat, lon, r)); }

  projectV(p) {
    const v = new THREE.Vector3(p[0], p[1], p[2]);
    const cam = this.camera.position;
    const facing = (v.x * (cam.x - v.x) + v.y * (cam.y - v.y) + v.z * (cam.z - v.z)) > 0;
    v.project(this.camera);
    return { x: (v.x + 1) / 2 * this.size.w, y: (1 - v.y) / 2 * this.size.h, visible: facing };
  }

  pick(x, y) {
    const hit = this.ray(x, y);
    let best = null, bestD = Infinity, station = null;
    if (this.dots?.visible) {
      const zoom = this.dotMat.uniforms.uZoom.value;
      for (const p of this.places) {
        const s = this.projectV(p._v);
        if (!s.visible) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < p.size * zoom * 0.5 + 6 && d < bestD) { best = p; bestD = d; }
      }
    }
    if (!best && this.stationPts?.visible) {
      for (const s of this.stations) {
        const q = this.projectV(s._v);
        if (q.visible && Math.hypot(q.x - x, q.y - y) < 9) { station = s; break; }
      }
    }
    const ll = hit ? toLatLon(hit.x, hit.y, hit.z) : {};
    return { place: best, station, lat: ll.lat, lon: ll.lon, x, y };
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
      const hop = Math.min(1, Math.hypot(to.lat - from.lat, to.lon - from.lon) / 120);
      this.view.lat = from.lat + (to.lat - from.lat) * e;
      this.view.lon = from.lon + (to.lon - from.lon) * e;
      this.view.dist = from.dist + (to.dist - from.dist) * e + Math.sin(Math.PI * e) * hop * 0.8;
      Object.assign(this.target, this.view);
      if (t >= 1) this.fly = null;
    } else {
      if (!this.pointerDown) {
        this.target.lon += this.vel.lon; this.target.lat = THREE.MathUtils.clamp(this.target.lat + this.vel.lat, -82, 82);
        this.vel.lon *= 0.9; this.vel.lat *= 0.9;
      }
      if (this.autoRotate && now - this.lastInteract > 2500) this.target.lon += dt * 3.2;
      const k = 1 - Math.pow(0.0008, dt);
      this.view.lat += (this.target.lat - this.view.lat) * k;
      this.view.lon += (this.target.lon - this.view.lon) * k;
      this.view.dist += (this.target.dist - this.view.dist) * k;
    }
    const p = toXYZ(this.view.lat, this.view.lon, this.view.dist);
    this.camera.position.set(p[0], p[1], p[2]);
    this.camera.lookAt(0, 0, 0);
    for (const n in this.fade) this.fade[n][0] += (this.fade[n][1] - this.fade[n][0]) * Math.min(1, dt * 6);
    const u = this.globeMat.uniforms;
    u.uGridOn.value = this.fade.grid[0]; u.uCloudOn.value = this.fade.cloud[0]; u.uTempOn.value = this.fade.temp[0];
    this.uniforms.uNightOn.value = this.fade.night[0];
    if (this.popMat) {
      this.popMat.uniforms.uOn.value = this.fade.pop[0];
      this.pop.visible = this.fade.pop[0] > 0.01;
      const fovRad = this.camera.fov * D2R;
      this.popMat.uniforms.uSpacing.value = (this.popStep / Math.max(0.05, this.view.dist - 1)) * (this.size.h / fovRad);
    }
    if (this.windLines) {
      this.windLines.material.uniforms.uOn.value = this.fade.wind[0];
      this.windLines.visible = this.fade.wind[0] > 0.01;
      this.stepWind(dt);
    }
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
