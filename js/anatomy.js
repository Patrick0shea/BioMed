// Simplified abdominal anatomy: the insufflated peritoneal cavity plus organs.
// Every organ is described by signed-distance primitives, and its mesh is generated
// from the same primitives, so proximity / contact maths matches what is drawn.
// Units: centimetres. Axes: +y anterior (up, patient supine), -z cranial (head), +x patient's left.
import * as THREE from 'three';
import { makeTissue, TISSUE } from './textures.js';

export const CAV = { rx: 16, rz: 22, ryLow: 9, ryUp: 11 };
export const hyFromIAP = (iap) => 3.2 + 0.65 * Math.max(0, iap);

const clamp = THREE.MathUtils.clamp;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// ---------- noise ----------
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const L = (a, b, t) => a + (b - a) * t;
  const x00 = L(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u);
  const x10 = L(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u);
  const x01 = L(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u);
  const x11 = L(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u);
  return L(L(x00, x10, v), L(x01, x11, v), w);
}
export function fbm3(x, y, z) {
  return vnoise(x, y, z) * 0.57 + vnoise(x * 2.03, y * 2.03, z * 2.03) * 0.29 + vnoise(x * 4.1, y * 4.1, z * 4.1) * 0.14;
}

// ---------- SDF helpers ----------
function sdEllipsoid(px, py, pz, rx, ry, rz) {
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

/** Signed distance to the cavity wall; positive inside the cavity. */
export function cavityInsideDist(p) {
  const ry = p.y >= 0 ? CAV.ryUp : CAV.ryLow;
  return -sdEllipsoid(p.x, p.y, p.z, CAV.rx, ry, CAV.rz);
}
export function innerWallY(x, z) {
  const k = 1 - (x / CAV.rx) ** 2 - (z / CAV.rz) ** 2;
  return k > 0 ? CAV.ryUp * Math.sqrt(k) : 0;
}

/** Make geometry seam-free: average normals of vertices that share a position. */
function smoothSeams(g) {
  const pos = g.attributes.position, nor = g.attributes.normal;
  const map = new Map();
  const key = (i) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    let e = map.get(k);
    if (!e) { e = { x: 0, y: 0, z: 0, idx: [] }; map.set(k, e); }
    e.x += nor.getX(i); e.y += nor.getY(i); e.z += nor.getZ(i); e.idx.push(i);
  }
  for (const e of map.values()) {
    if (e.idx.length < 2) continue;
    const l = Math.hypot(e.x, e.y, e.z) || 1;
    for (const i of e.idx) nor.setXYZ(i, e.x / l, e.y / l, e.z / l);
  }
  nor.needsUpdate = true;
}

const _t = new THREE.Vector3();

// ---------- primitives ----------
class EllipsoidPrim {
  constructor(c, r, rot = [0, 0, 0], { taper = 0, bump = 0.12, freq = 0.55, seed = 0 } = {}) {
    this.c = new THREE.Vector3(...c);
    this.r = new THREE.Vector3(...r);
    this.q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
    this.qi = this.q.clone().invert();
    this.taper = taper; this.bump = bump; this.freq = freq; this.seed = seed;
    this.R = Math.max(...r) * (1 + Math.abs(taper)) + bump + 0.2;
  }
  lowerBound(p) { return p.distanceTo(this.c) - this.R; }
  distance(p) {
    _t.copy(p).sub(this.c).applyQuaternion(this.qi);
    let rx = this.r.x, ry = this.r.y;
    if (this.taper) { const f = 1 + this.taper * clamp(_t.z / this.r.z, -1, 1); rx *= f; ry *= f; }
    return sdEllipsoid(_t.x, _t.y, _t.z, rx, ry, this.r.z);
  }
  geometry(segW = 72, segH = 48) {
    const g = new THREE.SphereGeometry(1, segW, segH);
    const pos = g.attributes.position;
    const v = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const f = 1 + this.taper * v.z;
      p.set(v.x * this.r.x * f, v.y * this.r.y * f, v.z * this.r.z);
      const n = fbm3(p.x * this.freq + this.seed, p.y * this.freq, p.z * this.freq) - 0.5;
      p.addScaledVector(v, n * this.bump * 2);
      p.applyQuaternion(this.q).add(this.c);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    g.computeVertexNormals();
    smoothSeams(g);
    return g;
  }
}

class TubePrim {
  constructor(points, radius, { haustra = 0, hPeriod = 3.4, taperStart = true, taperEnd = true, taperLen = 1.2,
    wobble = 0.06, seed = 0 } = {}) {
    this.curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    this.radius = radius; this.haustra = haustra; this.hPeriod = hPeriod;
    this.taperStart = taperStart; this.taperEnd = taperEnd; this.taperLen = taperLen;
    this.wobble = wobble; this.seed = seed;
    this.len = this.curve.getLength();
    const N = Math.max(16, Math.ceil(this.len / 0.6));
    const pts = this.curve.getSpacedPoints(N);
    this.n = pts.length;
    this.xs = new Float32Array(this.n); this.ys = new Float32Array(this.n); this.zs = new Float32Array(this.n);
    this.rs = new Float32Array(this.n);
    pts.forEach((p, i) => {
      this.xs[i] = p.x; this.ys[i] = p.y; this.zs[i] = p.z;
      this.rs[i] = radius * this.radiusFactor(i / (this.n - 1), true);
    });
    // Chunked bounding spheres for fast distance queries
    this.chunks = [];
    const C = 10;
    for (let s = 0; s < this.n - 1; s += C) {
      const e = Math.min(this.n - 1, s + C);
      let cx = 0, cy = 0, cz = 0, k = 0;
      for (let i = s; i <= e; i++) { cx += this.xs[i]; cy += this.ys[i]; cz += this.zs[i]; k++; }
      cx /= k; cy /= k; cz /= k;
      let R = 0;
      for (let i = s; i <= e; i++) R = Math.max(R, Math.hypot(this.xs[i] - cx, this.ys[i] - cy, this.zs[i] - cz) + this.rs[i]);
      this.chunks.push({ s, e, cx, cy, cz, R: R + 0.3 });
    }
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.n; i++) { cx += this.xs[i]; cy += this.ys[i]; cz += this.zs[i]; }
    this.c = new THREE.Vector3(cx / this.n, cy / this.n, cz / this.n);
    this.R = 0;
    for (let i = 0; i < this.n; i++) this.R = Math.max(this.R, Math.hypot(this.xs[i] - this.c.x, this.ys[i] - this.c.y, this.zs[i] - this.c.z));
    this.R += radius * 1.3 + 0.3;
  }
  radiusFactor(u, mean = false) {
    const s = u * this.len;
    let f = 1;
    if (this.taperStart) f *= smooth(0, this.taperLen, s) * 0.92 + 0.08 * (s > 0 ? 1 : 0);
    if (this.taperEnd) f *= smooth(0, this.taperLen, this.len - s) * 0.92 + 0.08 * (this.len - s > 0 ? 1 : 0);
    if (this.haustra) {
      if (mean) f *= 1 - this.haustra * 0.15;
      else f *= (1 - this.haustra * Math.pow(Math.cos((Math.PI * s) / this.hPeriod), 16)) * (1 + this.haustra * 0.25 * Math.pow(Math.sin((Math.PI * s) / this.hPeriod), 2));
    }
    return f;
  }
  lowerBound(p) { return p.distanceTo(this.c) - this.R; }
  distance(p) {
    let best = Infinity;
    const { xs, ys, zs, rs } = this;
    for (const ch of this.chunks) {
      const lb = Math.hypot(p.x - ch.cx, p.y - ch.cy, p.z - ch.cz) - ch.R;
      if (lb >= best) continue;
      for (let i = ch.s; i < ch.e; i++) {
        const ax = xs[i], ay = ys[i], az = zs[i];
        const bx = xs[i + 1] - ax, by = ys[i + 1] - ay, bz = zs[i + 1] - az;
        const px = p.x - ax, py = p.y - ay, pz = p.z - az;
        const bb = bx * bx + by * by + bz * bz;
        const t = bb > 0 ? clamp((px * bx + py * by + pz * bz) / bb, 0, 1) : 0;
        const d = Math.hypot(px - bx * t, py - by * t, pz - bz * t) - (rs[i] + (rs[i + 1] - rs[i]) * t);
        if (d < best) best = d;
      }
    }
    return best;
  }
  geometry(radial = 20) {
    const segs = Math.max(40, Math.ceil(this.len * 4));
    const g = new THREE.TubeGeometry(this.curve, segs, this.radius, radial, false);
    const pos = g.attributes.position;
    const P = new THREE.Vector3(), V = new THREE.Vector3();
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      this.curve.getPointAt(u, P);
      const f = this.radiusFactor(u);
      for (let j = 0; j <= radial; j++) {
        const idx = i * (radial + 1) + j;
        V.fromBufferAttribute(pos, idx).sub(P);
        const w = V.clone().add(P);
        const n = fbm3(w.x * 0.9 + this.seed, w.y * 0.9, w.z * 0.9) - 0.5;
        V.multiplyScalar(f * (1 + n * this.wobble * 2));
        pos.setXYZ(idx, P.x + V.x, P.y + V.y, P.z + V.z);
      }
    }
    g.computeVertexNormals();
    smoothSeams(g);
    return g;
  }
}

class SheetPrim {
  // A draped fatty apron (greater omentum): height field over an irregular outline.
  constructor({ cx, z0, halfWidth, zEnd, height, thick = 0.35, hwMax }) {
    Object.assign(this, { cx, z0, halfWidth, zEnd, height, thick, hwMax });
    this.c = new THREE.Vector3(cx, height(cx, z0 + 6), z0 + 6);
    this.R = Math.hypot(hwMax, 8) + 2.5;
  }
  lowerBound(p) { return p.distanceTo(this.c) - this.R; }
  distance(p) {
    const cx0 = clamp(p.x, this.cx - this.hwMax, this.cx + this.hwMax);
    const cz = clamp(p.z, this.z0, this.zEnd(cx0));
    const hw = this.halfWidth(cz);
    const cx = clamp(p.x, this.cx - hw, this.cx + hw);
    const dy = Math.abs(p.y - this.height(cx, cz)) - this.thick;
    const dxz = Math.hypot(p.x - cx, p.z - cz);
    if (dxz < 1e-6) return dy;
    return Math.hypot(dxz, Math.max(dy, 0));
  }
  geometry() {
    const nx = 90, nz = 80;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const u = (i / nx) * 2 - 1, v = j / nz;
        const z = this.z0 + v * (this.zEnd(this.cx + u * this.hwMax) - this.z0);
        const x = this.cx + u * this.halfWidth(z);
        pos.push(x, this.height(x, z) + this.thick * 0.6, z);
        uv.push(x / 8, z / 8);
      }
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + nx + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

class FalciformPrim {
  // Thin midline peritoneal fold running from the anterior wall down to the liver.
  constructor() { this.x = 0.7; this.z0 = -16; this.z1 = 0.8; this.thick = 0.22; this.update(); }
  yTop(z) { return innerWallY(this.x, z) + 0.4; }
  yBot(z) {
    const t = smooth(this.z0, this.z1, z);
    return THREE.MathUtils.lerp(2.6, this.yTop(z) - 0.9, Math.pow(t, 0.7));
  }
  update() {
    this.c = new THREE.Vector3(this.x, 5, (this.z0 + this.z1) / 2);
    this.R = 13;
  }
  lowerBound(p) { return p.distanceTo(this.c) - this.R; }
  distance(p) {
    const dx = Math.abs(p.x - this.x) - this.thick;
    const cz = clamp(p.z, this.z0, this.z1);
    const dz = Math.abs(p.z - cz);
    const yb = this.yBot(cz), yt = this.yTop(cz);
    const dy = p.y < yb ? yb - p.y : p.y > yt ? p.y - yt : 0;
    const outside = Math.hypot(Math.max(dx, 0), dz, dy);
    if (outside > 0) return outside;
    return dx; // inside the slab region
  }
  geometry() {
    const nz = 60, ny = 14;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= nz; i++) {
      const z = THREE.MathUtils.lerp(this.z0, this.z1, i / nz);
      const yb = this.yBot(z), yt = this.yTop(z);
      for (let j = 0; j <= ny; j++) {
        const y = THREE.MathUtils.lerp(yb, yt, j / ny);
        const wob = (fbm3(z * 0.6, y * 0.6, 3.3) - 0.5) * 0.35;
        pos.push(this.x + wob, y, z);
        uv.push(i / nz * 3, j / ny);
      }
    }
    for (let i = 0; i < nz; i++) for (let j = 0; j < ny; j++) {
      const a = i * (ny + 1) + j, b = a + ny + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  edgeCurvePoints() {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const z = THREE.MathUtils.lerp(this.z0 + 0.5, this.z1, i / 12);
      pts.push([this.x, this.yBot(z), z]);
    }
    return pts;
  }
}

// ---------- organ layout ----------
function bowelPath() {
  const pts = [];
  const layers = [
    { y: 0.3, zs: [3.0, 5.6, 8.2, 10.8] },
    { y: -2.3, zs: [10.4, 7.8, 5.2, 2.6, 0.2] },
    { y: -4.9, zs: [0.6, 3.2, 5.8, 8.4, 10.6] },
  ];
  let dir = 1;
  layers.forEach((L, li) => {
    for (const row of L.zs) {
      for (let k = 0; k <= 8; k++) {
        const x = dir > 0 ? -6.2 + k * 1.55 : 6.2 - k * 1.55;
        pts.push([x, L.y + 0.45 * Math.sin(x * 0.8 + row), row + 0.55 * Math.sin(x * 1.1 + li * 1.7)]);
      }
      dir *= -1;
    }
  });
  return pts;
}

const COLON = [
  [-9.8, -4.2, 12.5], [-10.4, -3, 8], [-10.6, -1.6, 3], [-9.8, -0.4, -1.5], [-7.6, 1.0, -3.2],
  [-3, 2.0, -2.2], [2, 2.4, -1.8], [6.8, 1.6, -4.2], [10.2, 0.2, -6.2], [11.4, -1.8, -2],
  [11.6, -3.2, 4], [10.8, -3.6, 9.5], [8, -3.4, 12.8], [4.5, -3.6, 14.4], [1.5, -5.2, 14.8], [0.5, -7, 16.5],
];

const OM = { cx: 0.2, hw: 8.4, z0: 0.4, z1: 13 };
const omHalfWidth = (z) => {
  const v = clamp((z - OM.z0) / (OM.z1 - OM.z0), 0, 1);
  return OM.hw * (1 - 0.24 * v * v) * (1 + 0.05 * Math.sin(z * 1.3));
};
const omZEnd = (x) => { const u = (x - OM.cx) / OM.hw; return OM.z1 - 2.2 * u * u + 0.45 * Math.sin(x * 1.15); };
function omentumHeight(x, z) {
  const e = Math.min(omHalfWidth(z) - Math.abs(x - OM.cx), omZEnd(x) - z);
  const droop = 1.5 * (1 - smooth(0, 3.2, e));
  const lift = 0.9 * (1 - smooth(0.4, 2.5, z)); // rises toward the transverse colon
  return 2.6 + (fbm3(x * 0.33, 1.7, z * 0.33) - 0.5) * 0.9 - droop + lift;
}

export function buildAnatomy() {
  const texCache = {};
  const T = (k) => (texCache[k] ??= makeTissue(TISSUE[k]));
  const mat = (key, { rough = 0.42, cc = 0.9, ccr = 0.2, bump = 2.0, side = THREE.FrontSide, repeat = null, transparent = false, opacity = 1 } = {}) => {
    const t = T(key);
    let map = t.map, bumpMap = t.bumpMap;
    if (repeat) {
      map = map.clone(); bumpMap = bumpMap.clone();
      map.repeat.set(...repeat); bumpMap.repeat.set(...repeat);
      map.needsUpdate = bumpMap.needsUpdate = true;
    }
    return new THREE.MeshPhysicalMaterial({
      map, bumpMap, bumpScale: bump, roughness: rough, metalness: 0,
      clearcoat: cc, clearcoatRoughness: ccr, side, transparent, opacity,
    });
  };

  const E = (...a) => new EllipsoidPrim(...a);
  const organs = [];
  const group = new THREE.Group();

  function addOrgan(def) {
    const o = { visible: true, highlight: 0, ...def, group: new THREE.Group(), meshes: [] };
    o.group.name = o.id;
    o.prims.forEach((pr, i) => {
      const m = Array.isArray(o.material) ? o.material[i] : o.material;
      const geo = pr.geometry();
      const mesh = new THREE.Mesh(geo, m);
      mesh.userData.organId = o.id;
      o.group.add(mesh); o.meshes.push(mesh);
    });
    let cx = 0, cy = 0, cz = 0;
    o.prims.forEach((p) => { cx += p.c.x; cy += p.c.y; cz += p.c.z; });
    o.center = new THREE.Vector3(cx, cy, cz).divideScalar(o.prims.length);
    o.materials = [...new Set(o.meshes.map((m) => m.material))];
    group.add(o.group);
    organs.push(o);
    return o;
  }

  addOrgan({
    id: 'liver', name: 'Liver', kind: 'solid', injury: 'Liver capsule laceration — bleeding', bleeds: true, color: '#8a3024',
    prims: [
      E([-5, -0.5, -12.5], [8, 4.2, 6.5], [0, 0.2, -0.15], { bump: 0.18, seed: 1 }),
      E([3.5, 1.0, -14.5], [6, 2.3, 4.5], [0, -0.35, 0.18], { bump: 0.15, seed: 2 }),
    ],
    material: mat('liver', { rough: 0.3, cc: 1, ccr: 0.12, bump: 1.4, repeat: [2, 1] }),
  });
  addOrgan({
    id: 'gallbladder', name: 'Gallbladder', kind: 'hollow', injury: 'Gallbladder perforation — bile leak', color: '#5d7d47',
    prims: [E([-5, -0.3, -6.2], [1.5, 1.4, 3.0], [0.2, 0.35, 0], { taper: 0.25, bump: 0.06, seed: 3 })],
    material: mat('gallbladder', { rough: 0.3, cc: 1, ccr: 0.1, bump: 1.2 }),
  });
  addOrgan({
    id: 'stomach', name: 'Stomach', kind: 'hollow', injury: 'Gastric perforation', color: '#d08476',
    prims: [
      E([6.5, -0.5, -9.5], [5.5, 3.6, 5.2], [0, -0.5, 0.2], { bump: 0.2, seed: 4 }),
      E([2.5, -0.2, -6.5], [3.2, 2.4, 2.8], [0, 0.3, 0], { bump: 0.15, seed: 5 }),
    ],
    material: mat('stomach', { rough: 0.38, cc: 0.9, bump: 2, repeat: [2, 1] }),
  });
  addOrgan({
    id: 'spleen', name: 'Spleen', kind: 'solid', injury: 'Splenic injury — haemorrhage', bleeds: true, color: '#5a2234',
    prims: [E([10.5, -3.5, -12], [2.2, 3.4, 4.5], [0, 0.5, 0.3], { bump: 0.1, seed: 6 })],
    material: mat('spleen', { rough: 0.3, cc: 1, bump: 1.2 }),
  });
  const colon = new TubePrim(COLON, 2.0, { haustra: 0.11, wobble: 0.05, seed: 7 });
  addOrgan({
    id: 'colon', name: 'Colon', kind: 'hollow', injury: 'Colonic perforation — faecal contamination', color: '#e4b8a2',
    prims: [colon],
    material: mat('colon', { rough: 0.4, cc: 0.9, bump: 2, repeat: [colon.len / (2 * Math.PI * 2.0), 1] }),
  });
  const appx = new TubePrim([[-9.2, -4.7, 13.4], [-7.6, -5.3, 15.1], [-6.2, -4.8, 16.6], [-5.3, -4.1, 17.3]], 0.42,
    { taperStart: false, taperLen: 0.5, seed: 8 });
  addOrgan({
    id: 'appendix', name: 'Appendix', kind: 'hollow', injury: 'Appendix perforation', color: '#e3a99a',
    prims: [appx], material: mat('smallBowel', { repeat: [2, 1] }),
  });
  const sb = new TubePrim(bowelPath(), 1.3, { wobble: 0.07, seed: 9, taperLen: 1.5 });
  addOrgan({
    id: 'smallBowel', name: 'Small bowel', kind: 'hollow', injury: 'Small bowel enterotomy', color: '#e29a8a',
    prims: [sb], material: mat('smallBowel', { rough: 0.35, cc: 1, ccr: 0.15, bump: 2, repeat: [sb.len / (2 * Math.PI * 1.3), 1] }),
  });
  const om = new SheetPrim({ cx: OM.cx, z0: OM.z0, halfWidth: omHalfWidth, zEnd: omZEnd, height: omentumHeight, thick: 0.35, hwMax: OM.hw * 1.06 });
  addOrgan({
    id: 'omentum', name: 'Greater omentum', kind: 'fat', injury: 'Omental tear — bleeding', bleeds: true, color: '#e2b94e',
    prims: [om], material: mat('omentum', { rough: 0.45, cc: 0.8, bump: 1.2, side: THREE.DoubleSide, repeat: [1, 1] }),
  });
  addOrgan({
    id: 'bladder', name: 'Bladder', kind: 'hollow', injury: 'Bladder injury', color: '#d6b19c',
    prims: [E([0, -4, 18.5], [3.8, 2.8, 3], [0, 0, 0], { bump: 0.1, seed: 10 })],
    material: mat('bladder', { rough: 0.35, cc: 0.9, bump: 1.5 }),
  });
  const aorta = new TubePrim([[1.2, -7.2, -19], [1.2, -7.2, -8], [1.2, -7.25, 1], [1.2, -7.3, 5]], 1.1, { taperEnd: false, wobble: 0.02 });
  const lci = new TubePrim([[1.2, -7.3, 5], [3.2, -7.5, 9], [5.6, -7.0, 14]], 0.7, { taperStart: false, wobble: 0.02 });
  const rci = new TubePrim([[1.2, -7.3, 5], [-0.8, -7.5, 9], [-3.6, -7.0, 14]], 0.7, { taperStart: false, wobble: 0.02 });
  const aMat = mat('aorta', { rough: 0.35, cc: 0.9, bump: 1 });
  addOrgan({
    id: 'aorta', name: 'Aorta / iliac arteries', kind: 'vessel', injury: 'MAJOR VASCULAR INJURY — arterial haemorrhage', bleeds: true, color: '#b8655a',
    prims: [aorta, lci, rci, E([1.2, -7.3, 5], [1.15, 1.1, 1.15], [0, 0, 0], { bump: 0 })], material: aMat,
  });
  addOrgan({
    id: 'ivc', name: 'Inferior vena cava', kind: 'vessel', injury: 'MAJOR VASCULAR INJURY — venous haemorrhage', bleeds: true, color: '#6f6890',
    prims: [new TubePrim([[-1.8, -7.0, -19], [-1.8, -7.0, -6], [-1.6, -7.1, 4], [-1.8, -7.2, 7]], 1.3, { wobble: 0.03 })],
    material: mat('ivc', { rough: 0.35, cc: 0.9, bump: 1 }),
  });

  // Falciform ligament (geometry depends on insufflation, rebuilt on change)
  const falc = new FalciformPrim();
  const falcMat = mat('falciform', { rough: 0.45, cc: 0.8, bump: 1.5, side: THREE.DoubleSide });
  const falcOrgan = addOrgan({
    id: 'falciform', name: 'Falciform ligament', kind: 'ligament', injury: 'Falciform ligament tear', color: '#e6c27a',
    prims: [falc], material: falcMat,
  });
  let roundLig = null;
  function rebuildFalciform() {
    falc.update();
    const old = falcOrgan.meshes[0].geometry; falcOrgan.meshes[0].geometry = falc.geometry(); old.dispose();
    if (roundLig) { falcOrgan.group.remove(roundLig); roundLig.geometry.dispose(); }
    const tp = new TubePrim(falc.edgeCurvePoints(), 0.4, { taperStart: false, taperEnd: true, taperLen: 0.6 });
    roundLig = new THREE.Mesh(tp.geometry(12), falcMat);
    roundLig.userData.organId = 'falciform';
    falcOrgan.group.add(roundLig);
    falcOrgan.meshes = [falcOrgan.meshes[0], roundLig];
  }

  // Posterior parietal peritoneum draped over the retroperitoneal great vessels (visual only)
  {
    const g = new THREE.PlaneGeometry(11, 34, 60, 120);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i) + 1;
      const vessel = Math.max(Math.exp(-(((x - 1.2) / 1.5) ** 2)) * 0.5, Math.exp(-(((x + 1.8) / 1.7) ** 2)) * 0.6);
      const y = -6.0 - 2.6 * (x / 5.5) ** 2 + vessel + (fbm3(x * 0.4, 9.1, z * 0.4) - 0.5) * 0.3;
      pos.setXYZ(i, x, y, z);
    }
    g.computeVertexNormals();
    const m = mat('peritoneum', { rough: 0.3, cc: 1, ccr: 0.12, bump: 1.2, side: THREE.DoubleSide, transparent: true, opacity: 0.8, repeat: [1.5, 4] });
    m.depthWrite = false;
    const sheet = new THREE.Mesh(g, m);
    sheet.renderOrder = 2;
    group.add(sheet);
  }

  // Peritoneal cavity lining (rendered from the inside)
  const cavGeo = new THREE.SphereGeometry(1, 128, 80);
  const base = cavGeo.attributes.position.array.slice();
  const cavityMesh = new THREE.Mesh(cavGeo, mat('peritoneum', { rough: 0.32, cc: 1, ccr: 0.12, bump: 1.6, side: THREE.BackSide }));
  cavityMesh.userData.organId = 'wall';
  function rebuildCavity() {
    const pos = cavGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      const ry = y >= 0 ? CAV.ryUp : CAV.ryLow;
      const px = x * CAV.rx, py = y * ry, pz = z * CAV.rz;
      const n = (fbm3(px * 0.35, py * 0.35, pz * 0.35) - 0.5) * 0.25;
      pos.setXYZ(i, px * (1 + n * 0.03), py + n * y, pz * (1 + n * 0.03));
    }
    pos.needsUpdate = true;
    cavGeo.computeVertexNormals();
    smoothSeams(cavGeo);
    cavGeo.computeBoundingSphere();
  }

  function setIAP(iap) {
    CAV.ryUp = hyFromIAP(iap);
    rebuildCavity();
    rebuildFalciform();
  }

  const _p = new THREE.Vector3();
  const api = {
    group, organs, cavityMesh,
    byId: Object.fromEntries(organs.map((o) => [o.id, o])),
    setIAP,
    /** Distance from p to an organ's surface (negative = inside). */
    organDistance(o, p, cap = Infinity) {
      let d = cap;
      for (const pr of o.prims) {
        if (pr.lowerBound(p) >= d) continue;
        const v = pr.distance(p);
        if (v < d) d = v;
      }
      return d;
    },
    /** Nearest visible organ to p. */
    nearest(p) {
      let best = Infinity, id = null;
      for (const o of organs) {
        if (!o.visible) continue;
        const d = api.organDistance(o, p, best);
        if (d < best) { best = d; id = o.id; }
      }
      return { d: best, id };
    },
    /** Sphere-trace a ray through the cavity. Returns hit distance and structure id. */
    march(o, dir, maxT = 45) {
      let t = 0;
      for (let i = 0; i < 110; i++) {
        _p.copy(o).addScaledVector(dir, t);
        const wall = cavityInsideDist(_p);
        const { d, id } = api.nearest(_p);
        if (d < 0.05) return { t, id };
        if (wall < 0.05) return { t, id: 'wall' };
        t += Math.max(Math.min(d, wall) * 0.85, 0.03);
        if (t > maxT) break;
      }
      return { t: maxT, id: null };
    },
  };
  group.add(cavityMesh);
  setIAP(12);
  return api;
}
