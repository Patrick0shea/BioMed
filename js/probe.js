// ProbeSim — animated transanal balloon-probe procedure:
// assembly → grip & power → position → insert to red line → inflate at anastomosis →
// hold → deflate → withdraw. Fully deterministic: the whole scene is a function of time t,
// so the timeline can be scrubbed, stepped and replayed.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildAnatomy, COLON, CAV, fbm3 } from './anatomy.js';
import { makeTissue } from './textures.js';
import { createProbe, PROBE } from './probeModel.js';
import { loadGripHand } from './hand.js';

const $ = (id) => document.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const easeIO = (t) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); };
const easeInOutSine = (t) => -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;
const L_BODY = 1; // layer for skin / body / table: main view only

// ------------------------------------------------------------------ geometry of the procedure (cm)
const A = V(0, -11.5, 26.8);                         // anal verge (on the perineal skin)
const D = V(0, 0.177, -0.984).normalize();           // rectal axis, pointing cranially
const UP = V(0, 1, 0).addScaledVector(D, -D.y).normalize();
const SIDE = new THREE.Vector3().crossVectors(UP, D).normalize();
const ANAST = PROBE.balloonCenter - PROBE.redLineZ;  // anastomosis height = red line → balloon centre (9 cm)
const axisPt = (s) => A.clone().addScaledVector(D, s);
const probeOriginFor = (tipDepth) => axisPt(tipDepth - (PROBE.tipZ - PROBE.redLineZ));
const ORIGIN_READY = probeOriginFor(-1.5);
const ORIGIN_ASM = ORIGIN_READY.clone().add(V(30, 12, 3));   // beside the patient, clear of the raised leg

// ------------------------------------------------------------------ renderer, scene, cameras
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a1f1a, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(30, 60, 40);
const fill = new THREE.DirectionalLight(0xbfd4ff, 1.0); fill.position.set(-40, 15, -30);
const rim = new THREE.DirectionalLight(0xfff0e0, 0.8); rim.position.set(20, -10, 70);
scene.add(hemi, sun, fill, rim);

const mainCam = new THREE.PerspectiveCamera(36, 16 / 9, 0.5, 800);
mainCam.layers.enable(L_BODY);
const closeCam = new THREE.PerspectiveCamera(30, 2, 0.5, 400);
const controls = new OrbitControls(mainCam, $('mainView'));
controls.enableDamping = true;
controls.minDistance = 6; controls.maxDistance = 320;

// ------------------------------------------------------------------ section cut (sagittal cutaway)
const cut = {
  uCutOn: { value: 1 },
  uCutMin: { value: V(0.0, -60, 13.4) },
  uCutMax: { value: V(60, -6.3, 60) },
};
function addCut(material) {
  material.side = THREE.DoubleSide;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cut);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 cw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cw = instanceMatrix * cw;
        #endif
          vCutPos = (modelMatrix * cw).xyz; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutPos;\nuniform float uCutOn; uniform vec3 uCutMin; uniform vec3 uCutMax;')
      .replace('void main() {', 'void main() {\n  if (uCutOn > 0.5 && all(greaterThan(vCutPos, uCutMin)) && all(lessThan(vCutPos, uCutMax))) discard;');
  };
  material.customProgramCacheKey = () => 'sagittal-cut';
  material.needsUpdate = true;
  return material;
}

// ------------------------------------------------------------------ anatomy
// colon re-routed so the sigmoid descends into the pelvis and ends at the anastomosis
const colonPath = [...COLON.slice(0, 14), [2.4, -5.2, 13.0], [0.7, -7.3, 12.3],
  axisPt(14.8).toArray(), axisPt(12.0).toArray(), axisPt(ANAST).toArray()];
const anat = buildAnatomy({ colonPath, colonTaperEnd: false, iap: 5 });
anat.cavityMesh.visible = false;
anat.posteriorSheet.visible = false;
scene.add(anat.group);
const colonOrgan = anat.byId.colon;
addCut(colonOrgan.materials[0]);

// rectal stump: straight along the axis from the anal verge to the anastomosis
function rectRadius(s) {
  if (s < 0) return 0.95 + -s * 0.9;
  let r = lerp(0.95, 1.2, smooth(0, 2.6, s));
  r = lerp(r, 2.1, smooth(2.4, 4.6, s));
  return lerp(r, 1.97, smooth(7.6, ANAST, s));
}
const rectumTex = makeTissue({
  base: '#c47a6a', mottle: ['#a65a4e', '#e09a8a', '#b4675a'], mottleCount: 70, mottleAlpha: 0.3,
  vessels: { count: 9, color: '#7a1a14', width: [1.2, 3], len: [120, 260], depth: 3, alpha: 0.6 }, seed: 31,
});
const rectumMat = addCut(new THREE.MeshPhysicalMaterial({
  map: rectumTex.map, bumpMap: rectumTex.bumpMap, bumpScale: 1.5, roughness: 0.38, clearcoat: 0.9, clearcoatRoughness: 0.2,
}));
const rectum = (() => {
  const NS = 110, NR = 56, s0 = -0.5, s1 = ANAST;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const s = lerp(s0, s1, i / NS);
    const c = axisPt(s);
    for (let j = 0; j <= NR; j++) {
      const ph = (j / NR) * Math.PI * 2;
      const dir = UP.clone().multiplyScalar(Math.cos(ph)).addScaledVector(SIDE, Math.sin(ph));
      const n = fbm3(c.x * 0.6 + dir.x * 2, c.y * 0.6 + dir.y * 2, c.z * 0.6) - 0.5;
      const p = c.clone().addScaledVector(dir, rectRadius(s) * (1 + 0.06 * n));
      pos.push(p.x, p.y, p.z);
      uv.push(j / NR, s / 5);
    }
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
    const a = i * (NR + 1) + j, b = a + NR + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, rectumMat);
  scene.add(m);
  return m;
})();

// anastomosis: staple-line ridge + two staggered rows of staples
const qAxis = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), D);
const ringMat = addCut(new THREE.MeshPhysicalMaterial({ color: '#a2463c', roughness: 0.45, clearcoat: 0.6 }));
const ring = new THREE.Mesh(new THREE.TorusGeometry(1.99, 0.17, 16, 96), ringMat);
ring.position.copy(axisPt(ANAST)); ring.quaternion.copy(qAxis);
scene.add(ring);
const stapleMat = addCut(new THREE.MeshStandardMaterial({ color: '#d7dee6', metalness: 0.9, roughness: 0.25 }));
const staples = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.07, 0.34), stapleMat, 44);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V(1, 1, 1);
  for (let k = 0; k < 44; k++) {
    const row = k % 2, ph = ((Math.floor(k / 2) + row * 0.5) / 22) * Math.PI * 2;
    const dir = UP.clone().multiplyScalar(Math.cos(ph)).addScaledVector(SIDE, Math.sin(ph));
    const p = axisPt(ANAST + (row ? 0.18 : -0.18)).addScaledVector(dir, 2.1);
    q.copy(qAxis);
    m.compose(p, q, sc);
    staples.setMatrixAt(k, m);
  }
}
scene.add(staples);
// anal verge
const verge = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.34, 16, 48),
  new THREE.MeshPhysicalMaterial({ color: '#94574b', roughness: 0.5, clearcoat: 0.5 }));
verge.position.copy(axisPt(-0.25)); verge.quaternion.copy(qAxis);
scene.add(verge);

// wall deformation where the balloon presses outward
function bulgeSet(geo, filter) {
  const pos = geo.attributes.position;
  const list = [];
  const p = V();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const s = p.clone().sub(A).dot(D);
    const c = axisPt(s);
    const r = p.distanceTo(c);
    if (!filter(s, r)) continue;
    const dir = p.clone().sub(c).normalize();
    list.push({ i, s, r, dir, c });
  }
  return { geo, list, base: pos.array.slice() };
}
const bulges = [
  bulgeSet(rectum.geometry, (s) => s > 4.5),
  bulgeSet(colonOrgan.meshes[0].geometry, (s, r) => s > 6 && s < 14.5 && r < 3.6),
];
const smax = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(a, b, h) + k * h * (1 - h); };
let lastBulgeKey = '';
function applyBulge(originS, f) {
  const key = `${originS.toFixed(3)}|${f.toFixed(4)}`;
  if (key === lastBulgeKey) return;
  lastBulgeKey = key;
  for (const b of bulges) {
    const pos = b.geo.attributes.position;
    let changed = false;
    for (const v of b.list) {
      const br = f > 0.001 ? probe.balloonR(v.s - originS, f) : 0;
      let r = v.r;
      if (br > 0) r = smax(v.r, br + 0.3, 0.35);
      const x = v.c.x + v.dir.x * r, y = v.c.y + v.dir.y * r, z = v.c.z + v.dir.z * r;
      if (pos.getX(v.i) !== x || pos.getY(v.i) !== y || pos.getZ(v.i) !== z) { pos.setXYZ(v.i, x, y, z); changed = true; }
    }
    if (changed) { pos.needsUpdate = true; b.geo.computeVertexNormals(); }
  }
}

// ------------------------------------------------------------------ body (lithotomy) — external view only
const skinMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color('#e9b49a') }, uOpacity: { value: 0.3 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV;
    void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
      float a = clamp(uOpacity * (0.18 + 1.25*f), 0.0, 1.0);
      gl_FragColor = vec4(uColor * (0.55 + 0.6*f), a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false,
});
const body = new THREE.Group();
scene.add(body);
function bodyMesh(geo, material) { const m = new THREE.Mesh(geo, material); m.layers.set(L_BODY); body.add(m); return m; }
function ellipsoid(c, r, segs = 48) { const g = new THREE.SphereGeometry(1, segs, Math.round(segs * 0.66)); g.scale(...r); g.translate(...c); return g; }
function capsule(a, b, r) {
  const P = V(...a), Q = V(...b), len = P.distanceTo(Q);
  const g = new THREE.CapsuleGeometry(r, len, 8, 24);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), Q.clone().sub(P).normalize()));
  g.translate((P.x + Q.x) / 2, (P.y + Q.y) / 2, (P.z + Q.z) / 2);
  return g;
}
bodyMesh(ellipsoid([0, -3.5, -30], [18.5, 10, 12.5]), skinMat);
bodyMesh(ellipsoid([0, -5, 21], [17, 8.5, 9]), skinMat);
bodyMesh(ellipsoid([0, -2.5, -54], [8.5, 9.5, 10.5]), skinMat);
bodyMesh(capsule([0, -3, -46], [0, -3, -40], 5), skinMat);
bodyMesh(capsule([-22, -5, -36], [-23, -6, 6], 3.8), skinMat);
bodyMesh(capsule([22, -5, -36], [23, -6, 6], 3.8), skinMat);
for (const sx of [-1, 1]) {   // legs up in stirrups (lithotomy)
  bodyMesh(capsule([sx * 7.5, -6, 25.5], [sx * 15.5, 12, 36], 6.0), skinMat);
  bodyMesh(capsule([sx * 15.5, 12, 36], [sx * 18.5, 7.5, 55], 4.6), skinMat);
  bodyMesh(ellipsoid([sx * 19, 11, 58.5], [3.2, 6, 3.4], 24), skinMat);
}
const table = bodyMesh(new THREE.BoxGeometry(62, 2, 108), new THREE.MeshStandardMaterial({ color: 0x1b222b, roughness: 0.8, metalness: 0.3 }));
table.position.set(0, -15, -24);
const drape = bodyMesh(new THREE.BoxGeometry(56, 0.6, 104), new THREE.MeshStandardMaterial({ color: 0x1f5f5a, roughness: 0.95 }));
drape.position.set(0, -13.7, -24);
{ // abdomen skin from the cavity dimensions
  const Tr = 3.5;
  const g = new THREE.SphereGeometry(1, 96, 64);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i, x * (CAV.rx + Tr), y * ((y >= 0 ? CAV.ryUp : CAV.ryLow) + Tr), z * (CAV.rz + Tr));
  }
  g.computeVertexNormals();
  bodyMesh(g, skinMat);
}

// ------------------------------------------------------------------ probe
const probe = createProbe();
// roll the probe so the button row faces the patient's left (toward the main camera) and slightly up
const ROLL = 32 * Math.PI / 180;
const BTN_DIR = V(1, 0, 0).multiplyScalar(Math.cos(ROLL)).addScaledVector(UP, Math.sin(ROLL)).normalize();
const qProbe = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(BTN_DIR, D).normalize(), BTN_DIR, D));
probe.group.quaternion.copy(qProbe);
scene.add(probe.group);
const probeLocal = (x, y, z) => probe.group.localToWorld(V(x, y, z));

// balloon volume / pressure model
const VOL = [];
for (let k = 0; k <= 50; k++) {
  const f = k / 50; let v = 0; const n = 80;
  const z0 = PROBE.balloonCenter - PROBE.balloonHalf, dz = (2 * PROBE.balloonHalf) / n;
  for (let i = 0; i < n; i++) {
    const r = probe.balloonR(z0 + (i + 0.5) * dz, f);
    v += Math.PI * Math.max(0, r * r - PROBE.shaftR * PROBE.shaftR) * dz;
  }
  VOL.push(v);
}
const volumeAt = (f) => { const x = clamp(f, 0, 1) * 50, i = Math.min(49, Math.floor(x)); return lerp(VOL[i], VOL[i + 1], x - i); };
const CONTACT_F = (1.97 - (PROBE.shaftR + 0.06)) / (PROBE.balloonMaxR - (PROBE.shaftR + 0.06));
const pressureAt = (f) => 9 * f + 33 * Math.pow(smooth(CONTACT_F - 0.05, 1, f), 1.3);

// ------------------------------------------------------------------ hand
let hand = null;
async function initHand() {
  hand = await loadGripHand({ url: './assets/hand-right.glb', handleR: PROBE.handleR });
  probe.gripAnchor.add(hand.root);
  const topY = probe.buttons[0].topY;
  const targets = PROBE.buttons.map((b) => ({
    hover: V(0, topY + 0.6, b.z - PROBE.gripZ + 0.05),
    press: V(0, topY - 0.14, b.z - PROBE.gripZ + 0.05),
  }));
  hand.buildPoses(targets, V(-1.05, PROBE.handleR + 0.1, PROBE.buttons[2].z - PROBE.gripZ + 0.4));
}

// ------------------------------------------------------------------ timeline
const BTN = PROBE.buttons;
const PHASES = [
  { id: 'assemble', name: 'Assemble the probe', dur: 9, level: 'info',
    text: 'Handle, balloon, atraumatic tip and inflation line are fitted onto the marked shaft.' },
  { id: 'grip', name: 'Grip & power on', dur: 5, level: 'info',
    text: `The operator grips the handle and presses button 1 (${BTN[0].name.toLowerCase()}) — status light turns green.` },
  { id: 'position', name: 'Position at anal verge', dur: 3.5, level: 'info',
    text: 'The lubricated tip is brought to the anal verge, in line with the rectum.' },
  { id: 'insert', name: 'Insert to the red line', dur: 8, level: 'info',
    text: `The probe is advanced until the red line sits at the anal verge — the balloon is now level with the anastomosis (${ANAST} cm).` },
  { id: 'inflate', name: 'Inflate the balloon', dur: 6, level: 'ok',
    text: `Button 2 (${BTN[1].name.toLowerCase()}) — the balloon expands against the anastomosis.` },
  { id: 'hold', name: 'Hold at anastomosis', dur: 4, level: 'ok',
    text: 'The balloon is held inflated across the anastomosis.' },
  { id: 'deflate', name: 'Deflate the balloon', dur: 5, level: 'info',
    text: `Button 3 (${BTN[2].name.toLowerCase()}) — the balloon deflates back onto the shaft.` },
  { id: 'remove', name: 'Withdraw the probe', dur: 7, level: 'ok',
    text: 'With the balloon fully deflated, the probe is withdrawn.' },
];
let acc = 0;
for (const p of PHASES) { p.start = acc; acc += p.dur; }
const TOTAL = acc;
const PH = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));

const ASM = { shaft: [0, 0.12], handle: [0.12, 0.36], balloon: [0.36, 0.6], tip: [0.58, 0.8], line: [0.8, 0.97] };
const mixArr = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

/** Thumb press of button k over local progress v ∈ [0,1]. Returns true once the button has fired. */
function thumbSeq(S, v, k) {
  let press = 0, from = 'rest', to = 'rest', m = 0;
  if (v <= 0) { /* rest */ }
  else if (v < 0.3) { to = `hover${k}`; m = easeIO(v / 0.3); }
  else if (v < 0.42) { from = `hover${k}`; to = `press${k}`; m = easeIO((v - 0.3) / 0.12); press = m; }
  else if (v < 0.55) { from = to = `press${k}`; press = 1; }
  else if (v < 0.67) { from = `press${k}`; to = `hover${k}`; m = easeIO((v - 0.55) / 0.12); press = 1 - m; }
  else if (v < 1) { from = `hover${k}`; to = 'rest'; m = easeIO((v - 0.67) / 0.33); }
  S.thumbFrom = from; S.thumbTo = to; S.thumbMix = m;
  S.press[k] = press;
  return v >= 0.36;
}

const APPLY = {
  assemble(u, S) {
    for (const [id, [a, b]] of Object.entries(ASM)) S.asm[id] = clamp((u - a) / (b - a), 0, 1);
    S.cam = 'assemble';
  },
  grip(u, S) {
    S.handVisible = true;
    S.approach = easeIO(u / 0.35);
    S.grip = easeIO((u - 0.22) / 0.3);
    if (thumbSeq(S, (u - 0.5) / 0.5, 0)) { S.power = true; S.used[0] = true; }
    S.cam = 'grip';
  },
  position(u, S) {
    const e = easeIO(u);
    S.origin.lerpVectors(ORIGIN_ASM, ORIGIN_READY, e).addScaledVector(UP, -Math.sin(Math.PI * e) * 2.0);
    S.cam = 'position';
  },
  insert(u, S) {
    const tip = lerp(-1.5, PROBE.tipZ - PROBE.redLineZ, easeInOutSine(u));
    S.origin.copy(probeOriginFor(tip));
    S.redGlow = smooth(0.82, 1, u);
    S.cam = 'insert';
  },
  inflate(u, S) {
    if (thumbSeq(S, u / 0.35, 1)) S.used[1] = true;
    S.inflation = easeOut((u - 0.2) / 0.75);
    S.inflating = u > 0.126 && u < 0.95;
    S.redGlow = 0.35;
    S.cam = u < 0.32 ? 'buttons' : 'pelvis';
  },
  hold(u, S) { S.inflation = 1; S.inflating = false; S.holding = true; S.cam = 'pelvis'; },
  deflate(u, S) {
    if (thumbSeq(S, u / 0.35, 2)) S.used[2] = true;
    S.holding = u < 0.126;
    S.inflation = 1 - easeIO((u - 0.2) / 0.7);
    S.deflating = u > 0.126 && u < 0.9;
    S.cam = u < 0.32 ? 'buttons' : 'pelvis';
  },
  remove(u, S) {
    const tip = lerp(PROBE.tipZ - PROBE.redLineZ, -9, easeIO(u));
    S.origin.copy(probeOriginFor(tip));
    S.redGlow = 0;
    S.cam = 'remove';
  },
};

function evaluate(t) {
  const S = {
    t, phase: 0, u: 0, asm: { shaft: 0, handle: 0, balloon: 0, tip: 0, line: 0 },
    origin: ORIGIN_ASM.clone(), handVisible: false, approach: 0, grip: 0,
    thumbFrom: 'rest', thumbTo: 'rest', thumbMix: 0, press: [0, 0, 0], used: [false, false, false],
    power: false, inflation: 0, inflating: false, holding: false, deflating: false, redGlow: 0, cam: 'assemble',
  };
  for (let i = 0; i < PHASES.length; i++) {
    const ph = PHASES[i];
    if (t < ph.start && i > 0) break;
    S.phase = i;
    S.u = clamp((t - ph.start) / ph.dur, 0, 1);
    APPLY[ph.id](S.u, S);
  }
  return S;
}

const EVENTS = [
  ['assemble', 0.03, 'info', 'Marked shaft laid out — red line 9 cm from balloon centre'],
  ['assemble', 0.36, 'info', 'Handle fitted to the shaft'],
  ['assemble', 0.6, 'info', 'Balloon slid over the distal shaft'],
  ['assemble', 0.8, 'info', 'Atraumatic tip screwed on'],
  ['assemble', 0.97, 'ok', 'Inflation line connected — probe assembled'],
  ['grip', 0.5, 'info', 'Handle gripped'],
  ['grip', 0.68, 'ok', `Button 1 pressed — ${BTN[0].name.toLowerCase()} (green)`],
  ['position', 1.0, 'info', 'Tip at the anal verge, aligned with the rectum'],
  ['insert', 0.45, 'info', 'Balloon through the anal canal'],
  ['insert', 1.0, 'ok', `Red line at anal verge — balloon level with anastomosis (${ANAST} cm)`],
  ['inflate', 0.126, 'info', `Button 2 pressed — ${BTN[1].name.toLowerCase()}`],
  ['inflate', 0.2 + 0.75 * (1 - Math.sqrt(1 - CONTACT_F)), 'ok', 'Balloon in contact with the anastomosis'],
  ['inflate', 0.95, 'ok', `Balloon inflated — Ø ${(PROBE.balloonMaxR * 2).toFixed(1)} cm, ${Math.round(pressureAt(1))} mmHg`],
  ['hold', 1.0, 'info', 'Hold complete'],
  ['deflate', 0.126, 'info', `Button 3 pressed — ${BTN[2].name.toLowerCase()}`],
  ['deflate', 0.9, 'ok', 'Balloon fully deflated'],
  ['remove', 0.62, 'info', 'Balloon out through the anal canal'],
  ['remove', 1.0, 'ok', 'Probe removed — procedure complete'],
].map(([ph, u, level, msg]) => ({ t: PHASES[PH[ph]].start + u * PHASES[PH[ph]].dur, level, msg }));

// ------------------------------------------------------------------ apply state to the scene
let S = evaluate(0);
function applyState(st) {
  probe.setAssembly(st.asm);
  probe.group.position.copy(st.origin);
  probe.group.updateMatrixWorld(true);
  probe.setInflation(st.inflation);
  const tt = st.t;
  BTN.forEach((b, i) => {
    let glow = st.press[i];
    if (i === 0 && st.power) glow = Math.max(glow, 0.35);
    if (i === 1 && st.inflating) glow = Math.max(glow, 0.5 + 0.3 * Math.sin(tt * 8));
    if (i === 2 && st.deflating) glow = Math.max(glow, 0.5 + 0.3 * Math.sin(tt * 8));
    probe.setButton(i, st.press[i], glow);
  });
  const pulse = 0.6 + 0.4 * Math.sin(tt * 7);
  if (st.inflating) probe.setLED('#3b82f6', 2.2 * pulse);
  else if (st.holding) probe.setLED('#22d3ee', 2.0);
  else if (st.deflating) probe.setLED('#f59e0b', 2.2 * pulse);
  else if (st.power) probe.setLED('#22c55e', 2.0);
  else probe.setLED('#000000', 0);
  probe.setRedLineGlow(st.redGlow * (0.75 + 0.25 * Math.sin(tt * 6)));
  const originS = st.origin.clone().sub(A).dot(D);
  const onAxis = st.origin.clone().sub(axisPt(originS)).length() < 0.01;
  applyBulge(onAxis ? originS : -99, onAxis ? st.inflation : 0);
  if (hand && hand.poses.rest) {
    hand.root.visible = st.handVisible && ui.showHand;
    if (hand.root.visible) {
      const th = mixArr(hand.poses[st.thumbFrom] || hand.poses.rest, hand.poses[st.thumbTo] || hand.poses.rest, st.thumbMix);
      hand.setPose({ approach: st.approach, grip: st.grip, thumb: th });
    }
  }
}

// ------------------------------------------------------------------ camera choreography
function camKey(st) {
  const handle = probeLocal(0, 0, -11);
  switch (st.cam) {
    case 'assemble': { const t = probeLocal(0, 0, -3.5); return { target: t, pos: t.clone().add(V(40, 13, -4)) }; }
    case 'grip': return { target: probeLocal(0, 0, -12), pos: probeLocal(6, 19, -4) };
    case 'position': { const t = probeLocal(0, 0, -2); return { target: t, pos: t.clone().add(V(44, 14, 8)) }; }
    case 'buttons': return { target: probeLocal(0, 1.2, -11), pos: probeLocal(4, 15, -5) };
    case 'pelvis': { const t = A.clone().addScaledVector(D, -5); return { target: t, pos: t.clone().add(V(40, 9, 5)) }; }
    case 'remove': { const t = A.clone().lerp(handle, 0.45); return { target: t, pos: t.clone().add(V(42, 10, 6)) }; }
    case 'insert': default: { const t = A.clone().addScaledVector(D, -4); return { target: t, pos: t.clone().add(V(40, 8, 6)) }; }
  }
}
const camTarget = V(), camPos = V();
let camInit = false;
function updateCamera(dt) {
  if (!ui.autoCam) return;
  const k = camKey(S);
  if (!camInit) { camTarget.copy(k.target); camPos.copy(k.pos); camInit = true; }
  const a = 1 - Math.exp(-dt * 2.4);
  camTarget.lerp(k.target, a); camPos.lerp(k.pos, a);
  mainCam.position.copy(camPos);
  controls.target.copy(camTarget);
}
function setupCloseCam() {
  const t = axisPt(5.5).addScaledVector(UP, 0.4);
  closeCam.position.copy(t).add(V(24, 3, 0));
  closeCam.lookAt(t);
}
setupCloseCam();

// ------------------------------------------------------------------ labels
const tipDepth = () => probeLocal(0, 0, PROBE.tipZ).sub(A).dot(D);
const LABELS = [
  { view: 'main', text: 'Marked shaft', at: () => probeLocal(-0.9, -0.3, -3.2), show: (s) => s.phase === 0 && s.asm.shaft > 0.4 },
  { view: 'main', text: 'Red line — insertion limit', cls: 'red', at: () => probeLocal(0, 0.75, PROBE.redLineZ),
    show: (s) => (s.phase === 0 && s.asm.shaft > 0.4) || s.phase === 2 || s.phase === 3 },
  { view: 'main', text: 'Handle', at: () => probeLocal(0, -1.9, -17.5), show: (s) => s.phase === 0 && s.asm.handle > 0.5, left: true },
  { view: 'main', text: 'Buttons 1 · 2 · 3', at: () => probeLocal(0, 2.3, -9.8), show: (s) => (s.phase === 0 && s.asm.handle > 0.8) },
  { view: 'main', text: 'Balloon', at: () => probeLocal(0, 0.9, PROBE.balloonCenter), show: (s) => s.phase === 0 && s.asm.balloon > 0.5 },
  { view: 'main', text: 'Atraumatic tip', at: () => probeLocal(0, 0.6, PROBE.tipZ), show: (s) => s.phase === 0 && s.asm.tip > 0.5 },
  { view: 'main', text: 'Inflation line', at: () => probeLocal(0, -4, PROBE.handleBack - 6.5), show: (s) => s.phase === 0 && s.asm.line > 0.5, left: true },
  { view: 'main', text: 'Status light', at: () => probeLocal(0, 1.8, PROBE.ledZ), show: (s) => s.phase === 1 && s.power, left: true },
  { view: 'main', text: 'Anal verge', at: () => A.clone(), show: (s) => s.phase === 2 || s.phase === 3, left: true },
  { view: 'main', text: 'Button 2 — inflate', cls: 'warm', at: () => probeLocal(0, 2.2, BTN[1].z), show: (s) => s.phase === 4 && s.u < 0.35 },
  { view: 'main', text: 'Button 3 — deflate', cls: 'warm', at: () => probeLocal(0, 2.2, BTN[2].z), show: (s) => s.phase === 6 && s.u < 0.35 },
  { view: 'close', text: `Anastomosis (${ANAST} cm)`, cls: 'warm', at: () => axisPt(ANAST).addScaledVector(UP, 2.5), show: () => true },
  { view: 'close', text: 'Rectal stump', at: () => axisPt(5).addScaledVector(UP, -2.6), show: () => true },
  { view: 'close', text: 'Colon', at: () => axisPt(12.3).addScaledVector(UP, -2.4), show: () => true },
  { view: 'close', text: 'Anal verge', at: () => A.clone().addScaledVector(UP, -1.6), show: () => true, left: true },
  { view: 'close', text: 'Red line', cls: 'red', at: () => probeLocal(0, 0.8, PROBE.redLineZ), show: (s) => s.phase >= 2 && s.phase <= 7 && tipDepth() > -2 },
  { view: 'close', text: 'Balloon', at: () => probeLocal(0, probe.balloonR(PROBE.balloonCenter, S.inflation) + 0.5, PROBE.balloonCenter),
    show: (s) => s.phase >= 3 && s.phase <= 6 && tipDepth() > 4 },
];
for (const l of LABELS) {
  const el = document.createElement('div');
  el.className = `lbl ${l.cls || ''} ${l.left ? 'left' : ''}`;
  el.innerHTML = '<i></i><span></span>';
  el.querySelector('span').textContent = l.text;
  el.style.opacity = 0;
  $(l.view === 'main' ? 'labelsMain' : 'labelsClose').appendChild(el);
  l.el = el;
}
const _p = V();
function updateLabels() {
  const views = { main: { cam: mainCam, el: $('mainView') }, close: { cam: closeCam, el: $('closeView') } };
  for (const l of LABELS) {
    const v = views[l.view];
    const r = v.el.getBoundingClientRect();
    let vis = ui.labels && l.show(S) && r.width > 2;
    if (vis) {
      _p.copy(l.at()).project(v.cam);
      vis = _p.z < 1 && Math.abs(_p.x) < 1.05 && Math.abs(_p.y) < 1.05;
      const x = (_p.x + 1) / 2 * r.width, y = (1 - _p.y) / 2 * r.height;
      l.el.style.transform = l.left ? `translate(${x}px, ${y}px) translate(-100%, -50%) translateX(3.5px)` : `translate(${x}px, ${y}px) translate(-3.5px, -50%)`;
    }
    l.el.style.opacity = vis ? 1 : 0;
  }
}

// ------------------------------------------------------------------ UI
const ui = { playing: true, speed: 1, loop: false, autoCam: true, cutaway: true, labels: true, showHand: true };
let t = 0;

const stepsEl = $('steps');
PHASES.forEach((p, i) => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="n">${i + 1}</span><span class="t"></span><span class="d">${p.dur}s</span><span class="bar"><i></i></span>`;
  li.querySelector('.t').textContent = p.name;
  li.onclick = () => seek(p.start + 0.001);
  stepsEl.appendChild(li);
});
const hbEl = $('hButtons');
BTN.forEach((b) => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="k" style="background:${b.color};color:${b.color}"><b style="color:#fff">${b.label}</b></span><span></span><span class="s">—</span>`;
  li.children[1].textContent = b.name;
  hbEl.appendChild(li);
});
const params = [
  ['Shaft diameter', `${(PROBE.shaftR * 20).toFixed(0)} mm`],
  ['Balloon length', `${(PROBE.balloonHalf * 20).toFixed(0)} mm`],
  ['Balloon max diameter', `${(PROBE.balloonMaxR * 20).toFixed(0)} mm`],
  ['Red line → balloon centre', `${(ANAST * 10).toFixed(0)} mm`],
  ['Red line → tip', `${((PROBE.tipZ - PROBE.redLineZ) * 10).toFixed(0)} mm`],
  ['Anastomosis height', `${ANAST.toFixed(1)} cm from anal verge`],
  ['Max balloon volume', `${Math.round(volumeAt(1))} ml`],
];
$('params').innerHTML = params.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

const scrub = $('scrub');
scrub.max = TOTAL;
scrub.addEventListener('input', () => seek(parseFloat(scrub.value), true));
function seek(nt, fromScrub = false) {
  t = clamp(nt, 0, TOTAL);
  if (!fromScrub) scrub.value = t;
}
function setPlaying(p) {
  ui.playing = p;
  if (p && t >= TOTAL - 1e-3) t = 0;
  $('btnPlay').textContent = p ? '❚❚' : '▶';
  $('btnPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
}
$('btnPlay').onclick = () => setPlaying(!ui.playing);
$('btnRestart').onclick = () => { seek(0); setPlaying(true); };
const curPhase = () => { let i = 0; PHASES.forEach((p, k) => { if (t >= p.start - 1e-6) i = k; }); return i; };
$('btnNext').onclick = () => { const i = curPhase(); seek(i + 1 < PHASES.length ? PHASES[i + 1].start + 0.001 : TOTAL); };
$('btnPrev').onclick = () => { const i = curPhase(); const p = PHASES[i]; seek(t - p.start > 1 || i === 0 ? p.start + 0.001 : PHASES[i - 1].start + 0.001); };
document.querySelectorAll('#speed button').forEach((b) => {
  b.onclick = () => { ui.speed = +b.dataset.v; document.querySelectorAll('#speed button').forEach((x) => x.classList.toggle('on', x === b)); };
});
$('loop').onchange = (e) => { ui.loop = e.target.checked; };
$('autoCam').onchange = (e) => { ui.autoCam = e.target.checked; camInit = false; };
$('cutaway').onchange = (e) => { ui.cutaway = e.target.checked; };
$('labels').onchange = (e) => { ui.labels = e.target.checked; };
$('showHand').onchange = (e) => { ui.showHand = e.target.checked; };
$('skin').addEventListener('input', (e) => { skinMat.uniforms.uOpacity.value = e.target.value / 100; $('skinOut').textContent = `${e.target.value}%`; });
$('btnHelp').onclick = () => $('help').showModal();
controls.addEventListener('start', () => { if (ui.autoCam) { ui.autoCam = false; $('autoCam').checked = false; } });
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!ui.playing); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); $('btnNext').click(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); $('btnPrev').click(); }
  else if (e.key.toLowerCase() === 'r') $('btnRestart').click();
  else if (e.key.toLowerCase() === 'c') { $('cutaway').click(); }
});

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let lastEventCount = -1, lastPhase = -1;
function updateUI() {
  const ph = PHASES[S.phase];
  $('timeOut').textContent = `${fmt(t)} / ${fmt(TOTAL)}`;
  if (document.activeElement !== scrub) scrub.value = t;
  [...stepsEl.children].forEach((li, i) => {
    li.classList.toggle('on', i === S.phase);
    li.classList.toggle('done', i < S.phase || (i === S.phase && S.u >= 1));
    li.querySelector('.bar i').style.width = i === S.phase ? `${S.u * 100}%` : '0%';
  });
  const done = t >= TOTAL - 1e-3;
  if (S.phase !== lastPhase || done) {
    lastPhase = S.phase;
    $('capStep').textContent = done ? 'Complete' : `Step ${S.phase + 1} of ${PHASES.length} · ${ph.name}`;
    $('capText').textContent = done ? 'Probe withdrawn. Press R or ⏮ to replay.' : ph.text;
    $('statusLabel').textContent = done ? 'Procedure complete' : ph.name;
    $('statusSub').textContent = done ? 'All steps finished' : ph.text;
    $('statusCard').dataset.level = done ? 'ok' : ph.level;
    $('statusPill').dataset.level = done ? 'ok' : ph.level;
    $('statusPillText').textContent = done ? 'Complete' : `${S.phase + 1}/${PHASES.length} · ${ph.name}`;
  }
  // readouts
  const onPatient = S.phase >= 2;
  const td = tipDepth();
  const redS = probeLocal(0, 0, PROBE.redLineZ).sub(A).dot(D);
  const bS = td - (PROBE.tipZ - PROBE.balloonCenter);
  $('rTip').textContent = onPatient ? (td > 0 ? `${td.toFixed(1)} cm` : 'outside') : '—';
  $('rRed').textContent = !onPatient ? '—' : Math.abs(redS) < 0.06 ? 'at anal verge ✓' : redS < 0 ? `${(-redS).toFixed(1)} cm to go` : `${redS.toFixed(1)} cm past`;
  $('rRed').style.color = onPatient && Math.abs(redS) < 0.06 ? 'var(--ok)' : '';
  $('rBalloonPos').textContent = onPatient && bS > 0 ? `${bS.toFixed(1)} cm${Math.abs(bS - ANAST) < 0.1 ? ' ✓' : ''}` : '—';
  $('rBalloonPos').style.color = onPatient && Math.abs(bS - ANAST) < 0.1 ? 'var(--ok)' : '';
  const f = S.inflation;
  $('rDia').textContent = `${(probe.balloonR(PROBE.balloonCenter, f) * 20).toFixed(0)} mm`;
  $('rVol').textContent = `${Math.round(volumeAt(f))} ml`;
  const pr = pressureAt(f);
  $('rPress').textContent = `${Math.round(pr)} mmHg`;
  $('pressBar').style.width = `${clamp(pr / 45, 0, 1) * 100}%`;
  [...hbEl.children].forEach((li, i) => {
    li.classList.toggle('pressed', S.press[i] > 0.5);
    li.classList.toggle('used', S.used[i]);
    const active = (i === 0 && S.power) || (i === 1 && S.inflating) || (i === 2 && S.deflating);
    li.querySelector('.s').textContent = S.press[i] > 0.5 ? 'pressed' : active ? 'active' : S.used[i] ? 'done' : '—';
  });
  const led = S.inflating ? ['#3b82f6', 'Inflating'] : S.holding ? ['#22d3ee', 'Holding'] : S.deflating ? ['#f59e0b', 'Deflating'] : S.power ? ['#22c55e', 'Ready'] : ['#333b44', 'Off'];
  $('ledDot').style.background = led[0]; $('ledDot').style.boxShadow = S.power ? `0 0 10px ${led[0]}` : 'none';
  $('ledText').textContent = `Status light: ${led[1]}`;
  // log
  const evs = EVENTS.filter((e) => e.t <= t + 1e-6);
  if (evs.length !== lastEventCount) {
    lastEventCount = evs.length;
    $('eventLog').innerHTML = evs.slice().reverse().map((e) => `<li class="${e.level}"><time>${fmt(e.t)}</time><span>${e.msg}</span></li>`).join('');
  }
}

// ------------------------------------------------------------------ render loop
function viewRect(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: window.innerHeight - r.bottom, w: r.width, h: r.height, ok: r.width > 2 && r.height > 2 };
}
function render() {
  const w = window.innerWidth, h = window.innerHeight;
  const sz = renderer.getSize(V2);
  if (sz.x !== w || sz.y !== h) renderer.setSize(w, h, false);
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
  renderer.setClearColor(0x07090c, 1); renderer.clear();
  const mr = viewRect($('mainView'));
  if (mr.ok) {
    mainCam.aspect = mr.w / mr.h; mainCam.updateProjectionMatrix();
    cut.uCutOn.value = ui.cutaway ? 1 : 0;
    renderer.setViewport(mr.x, mr.y, mr.w, mr.h); renderer.setScissor(mr.x, mr.y, mr.w, mr.h);
    renderer.setClearColor(0x0b0f14, 1); renderer.clear();
    renderer.render(scene, mainCam);
  }
  const cr = viewRect($('closeView'));
  if (cr.ok) {
    closeCam.aspect = cr.w / cr.h; closeCam.updateProjectionMatrix();
    cut.uCutOn.value = 1;
    renderer.setViewport(cr.x, cr.y, cr.w, cr.h); renderer.setScissor(cr.x, cr.y, cr.w, cr.h);
    renderer.setClearColor(0x0d1117, 1); renderer.clear();
    renderer.render(scene, closeCam);
  }
}
const V2 = new THREE.Vector2();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (ui.playing) {
    t += dt * ui.speed;
    if (t >= TOTAL) { if (ui.loop) t = 0; else { t = TOTAL; setPlaying(false); } }
  }
  S = evaluate(t);
  applyState(S);
  updateCamera(dt);
  controls.update();
  render();
  updateLabels();
  updateUI();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot
setPlaying(true);
(async () => {
  try { await initHand(); } catch (err) { console.warn('Hand model unavailable:', err); }
  $('loading').classList.add('done');
  last = performance.now();
  requestAnimationFrame(frame);
})();

// for automated tests / debugging
window.probesim = {
  PHASES, TOTAL, PROBE, get t() { return t; }, seek, setPlaying, ui, evaluate, get S() { return S; },
  get hand() { return hand; }, mainCam, controls, closeCam, A, D, axisPt, probe,
  step() { S = evaluate(t); applyState(S); updateCamera(1); controls.update(); render(); updateLabels(); updateUI(); },
};
