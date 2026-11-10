import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildAnatomy, CAV, cavityInsideDist, innerWallY } from './anatomy.js';
import { createScopePost } from './scopePost.js';

const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Layers: 0 = anatomy (both views), 1 = external-only props, 2 = scope-only lights
const L_EXT = 1, L_SCOPE = 2;

// ------------------------------------------------------------------ ports
const PORTS = [
  { id: 'umbilical', name: 'Umbilical', tag: 'midline', desc: 'Standard camera port through the linea alba — thinnest point of the wall.', x: 0, z: 2, fat: 0.35, fascia: 0.45, muscle: 0 },
  { id: 'palmer', name: "Palmer's point", tag: 'LUQ', desc: 'Left upper quadrant, below the costal margin — classic alternative entry after midline surgery.', x: 8, z: -13, fat: 0.8, fascia: 0.3, muscle: 1.0 },
  { id: 'ruq', name: 'Right subcostal', tag: 'RUQ', desc: 'Right upper quadrant working port — liver and gallbladder sit directly beneath.', x: -10, z: -8, fat: 1, fascia: 0.3, muscle: 1.3 },
  { id: 'llq', name: 'Left iliac fossa', tag: 'LLQ', desc: 'Lateral lower port — sigmoid colon and small bowel lie beneath.', x: 10, z: 9, fat: 1, fascia: 0.3, muscle: 1.1 },
  { id: 'supra', name: 'Suprapubic', tag: 'midline', desc: 'Low midline port — the bladder sits just below and behind it.', x: 0, z: 14.5, fat: 1.1, fascia: 0.5, muscle: 0.4 },
];

const subcutFat = (bmi) => Math.max(0.3, 0.4 + (bmi - 20) * 0.18);

function wallLayers(port, bmi) {
  const ls = [
    { key: 'skin', name: 'Skin', t: 0.2, type: 1 },
    { key: 'fat', name: 'Subcutaneous fat', t: subcutFat(bmi) * port.fat, type: 2 },
    { key: 'fascia', name: port.muscle > 0 ? 'Anterior rectus sheath / aponeurosis' : 'Linea alba', t: port.fascia, type: 3 },
  ];
  if (port.muscle > 0) ls.push({ key: 'muscle', name: 'Abdominal wall muscle', t: port.muscle, type: 4 });
  ls.push({ key: 'prep', name: 'Pre-peritoneal fat', t: 0.25 * port.fat, type: 5 });
  ls.push({ key: 'peri', name: 'Parietal peritoneum', t: 0.08, type: 6 });
  return ls;
}

function portGeometry(port, bmi) {
  const layers = wallLayers(port, bmi);
  const T = layers.reduce((a, l) => a + l.t, 0);
  const yi = innerWallY(port.x, port.z);
  const inner = V(port.x, yi, port.z);
  const nOut = V(port.x / CAV.rx ** 2, yi / CAV.ryUp ** 2, port.z / CAV.rz ** 2).normalize();
  const skin = inner.clone().addScaledVector(nOut, T);
  return { layers, T, inner, nOut, nIn: nOut.clone().negate(), skin };
}

function scopeDirection(pg, angCC, angLat) {
  const n = pg.nIn;
  const tcc = V(0, 0, -1).projectOnPlane(n).normalize();
  const tlat = V(1, 0, 0).projectOnPlane(n);
  tlat.addScaledVector(tcc, -tlat.dot(tcc)).normalize();
  return n.clone().addScaledVector(tcc, Math.tan(angCC * DEG)).addScaledVector(tlat, Math.tan(angLat * DEG)).normalize();
}

/** Distance along the ray from the skin until it crosses the parietal peritoneum. */
function entryDistance(o, d) {
  for (const ry of [CAV.ryUp, CAV.ryLow]) {
    const ox = o.x / CAV.rx, oy = o.y / ry, oz = o.z / CAV.rz;
    const dx = d.x / CAV.rx, dy = d.y / ry, dz = d.z / CAV.rz;
    const a = dx * dx + dy * dy + dz * dz, b = 2 * (ox * dx + oy * dy + oz * dz), c = ox * ox + oy * oy + oz * oz - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) continue;
    const y = o.y + d.y * t;
    if ((ry === CAV.ryUp && y >= 0) || (ry === CAV.ryLow && y < 0)) return t;
  }
  return Infinity;
}

function regionOf(p) {
  const col = p.x < -5 ? 0 : p.x > 5 ? 2 : 1;
  const row = p.z < -6 ? 0 : p.z > 7 ? 2 : 1;
  return [
    ['Right hypochondrium', 'Epigastrium', 'Left hypochondrium'],
    ['Right flank', 'Umbilical region', 'Left flank'],
    ['Right iliac fossa', 'Hypogastrium', 'Left iliac fossa'],
  ][row][col];
}

// ------------------------------------------------------------------ state
const state = {
  portId: 'umbilical', depth: 0, angCC: 0, angLat: 0, optic: 30, roll: 0,
  iap: 12, bmi: 26, antifog: true, showOmentum: true, highlight: true, skinOpacity: 0.35,
};
const sim = {
  t0: performance.now(), elapsed: 0,
  fog: 0, blood: 0, contactAmt: 0, exposure: 1, viewDist: 5, prevPose: null,
  wasInCavity: false, maxLayerIdx: -1,
  organLevel: {}, seenFrac: {}, critical: null,
  stats: { entries: 0, contacts: 0, injuries: 0, maxDepth: 0, cavTime: 0, path: 0, seen: new Set() },
  lastTip: null, fov: [], centre: null, ahead: null, clearanceAtEntry: null,
  events: [],
};

// ------------------------------------------------------------------ renderer & scene
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const anat = buildAnatomy();
scene.add(anat.group);

// External view lights
const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a1f1a, 1.3);
const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(30, 60, 20);
const fill = new THREE.DirectionalLight(0xbfd4ff, 0.9); fill.position.set(-40, 15, -30);
for (const l of [hemi, sun, fill]) { l.layers.set(L_EXT); scene.add(l); }

// Laparoscope light (scope view only)
const scopeSpot = new THREE.SpotLight(0xfff3e6, 55, 0, 52 * DEG, 0.75, 2);
const scopeFill = new THREE.PointLight(0xffeedd, 2.5, 0, 2);
const scopeAmb = new THREE.AmbientLight(0xffe0d0, 0.025);
scopeSpot.layers.set(L_SCOPE); scopeFill.layers.set(L_SCOPE); scopeAmb.layers.set(L_SCOPE);
scene.add(scopeSpot, scopeSpot.target, scopeFill, scopeAmb);

const scopeCam = new THREE.PerspectiveCamera(72, 16 / 9, 0.04, 90);
scopeCam.layers.enable(0); scopeCam.layers.enable(L_SCOPE); scopeCam.layers.disable(L_EXT);

const extCam = new THREE.PerspectiveCamera(38, 16 / 9, 1, 600);
extCam.layers.enable(L_EXT);
const EXT_HOME = { pos: V(46, 40, 44), target: V(0, -1, -2) };
extCam.position.copy(EXT_HOME.pos);
const controls = new OrbitControls(extCam, $('extView'));
controls.target.copy(EXT_HOME.target);
controls.enableDamping = true;
controls.maxDistance = 260; controls.minDistance = 12;
controls.update();

const post = createScopePost();

// ------------------------------------------------------------------ external props (layer 1)
const skinMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color('#e9b49a') }, uOpacity: { value: state.skinOpacity } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV;
    void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
      float a = clamp(uOpacity * (0.18 + 1.25*f), 0.0, 1.0);
      gl_FragColor = vec4(uColor * (0.55 + 0.6*f), a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false, side: THREE.FrontSide,
});

const ext = new THREE.Group();
scene.add(ext);
function extMesh(geo, material) { const m = new THREE.Mesh(geo, material); m.layers.set(L_EXT); ext.add(m); return m; }

// Body outline (static parts)
function ellipsoid(c, r, segs = 48) { const g = new THREE.SphereGeometry(1, segs, Math.round(segs * 0.66)); g.scale(...r); g.translate(...c); return g; }
function capsule(a, b, r) {
  const A = V(...a), B = V(...b), len = A.distanceTo(B);
  const g = new THREE.CapsuleGeometry(r, len, 8, 20);
  const m = new THREE.Matrix4().lookAt(A, B, V(0, 1, 0)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  g.applyMatrix4(m); g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}
extMesh(ellipsoid([0, -3.5, -30], [18.5, 10, 12.5]), skinMat);
extMesh(ellipsoid([0, -5, 21], [17, 8.5, 9]), skinMat);
extMesh(ellipsoid([0, -2.5, -54], [8.5, 9.5, 10.5]), skinMat);
extMesh(capsule([0, -3, -46], [0, -3, -40], 5), skinMat);
extMesh(capsule([-7.5, -6, 27], [-8.5, -7, 78], 6.2), skinMat);
extMesh(capsule([7.5, -6, 27], [8.5, -7, 78], 6.2), skinMat);
extMesh(capsule([-22, -5, -36], [-23, -6, 6], 3.8), skinMat);
extMesh(capsule([22, -5, -36], [23, -6, 6], 3.8), skinMat);
const table = extMesh(new THREE.BoxGeometry(62, 2, 170), new THREE.MeshStandardMaterial({ color: 0x1b222b, roughness: 0.8, metalness: 0.3 }));
table.position.set(0, -15, 10);
const drape = extMesh(new THREE.BoxGeometry(56, 0.6, 164), new THREE.MeshStandardMaterial({ color: 0x1f5f5a, roughness: 0.95 }));
drape.position.set(0, -13.7, 10);

// Abdominal skin (rebuilt with IAP / BMI)
const abdSkin = extMesh(new THREE.BufferGeometry(), skinMat);
function rebuildSkin() {
  const Tr = 0.2 + subcutFat(state.bmi) + 0.3 + 1.2 + 0.3;
  const g = new THREE.SphereGeometry(1, 96, 64);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i, x * (CAV.rx + Tr), y * ((y >= 0 ? CAV.ryUp : CAV.ryLow) + Tr), z * (CAV.rz + Tr));
  }
  g.computeVertexNormals();
  abdSkin.geometry.dispose();
  abdSkin.geometry = g;
}

// Port markers
const portMarkers = {};
for (const p of PORTS) {
  const ring = extMesh(new THREE.TorusGeometry(0.9, 0.14, 10, 40), new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.75 }));
  portMarkers[p.id] = ring;
}

// Scope + trocar
const steel = new THREE.MeshStandardMaterial({ color: 0xc8d2dc, metalness: 0.9, roughness: 0.28 });
const darkSteel = new THREE.MeshStandardMaterial({ color: 0x39424c, metalness: 0.7, roughness: 0.4 });
const trocarMat = new THREE.MeshStandardMaterial({ color: 0x9fb4c4, metalness: 0.2, roughness: 0.35, transparent: true, opacity: 0.55 });
const scopeShaft = extMesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1, false), steel);
const scopeHead = extMesh(new THREE.CylinderGeometry(1.6, 1.6, 5.5, 24), darkSteel);
const lightPost = extMesh(new THREE.CylinderGeometry(0.35, 0.35, 3, 12), steel);
const trocar = extMesh(new THREE.CylinderGeometry(0.68, 0.68, 1, 20, 1, true), trocarMat);
const trocarHousing = extMesh(new THREE.CylinderGeometry(1.8, 1.4, 4, 20), new THREE.MeshStandardMaterial({ color: 0x2b3640, roughness: 0.5 }));
const tipGlow = extMesh(new THREE.SphereGeometry(0.55, 16, 12), new THREE.MeshBasicMaterial({ color: 0x2dd4bf }));
const coneLen = 7;
const viewCone = extMesh(new THREE.ConeGeometry(Math.tan(36 * DEG) * coneLen, coneLen, 32, 1, true),
  new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
const trajGeo = new THREE.BufferGeometry().setFromPoints([V(), V(0, 1, 0)]);
const trajLine = new THREE.Line(trajGeo, new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.9 }));
trajLine.layers.set(L_EXT); ext.add(trajLine);
const hitMarker = extMesh(new THREE.SphereGeometry(0.45, 12, 10), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));

const UP = V(0, 1, 0);
function placeCylinder(mesh, a, b) {
  const dir = b.clone().sub(a); const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.scale.set(1, Math.max(len, 0.001), 1);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
}

// ------------------------------------------------------------------ UI wiring
const portList = $('portList');
PORTS.forEach((p, i) => {
  const b = document.createElement('button');
  b.innerHTML = `${p.name}<small>${i + 1} · ${p.tag}</small>`;
  b.dataset.id = p.id;
  b.onclick = () => selectPort(p.id);
  portList.appendChild(b);
});

function bindRange(id, key, fmt, onChange) {
  const el = $(id), out = $(id + 'Out');
  el.addEventListener('input', () => { state[key] = parseFloat(el.value); if (out) out.textContent = fmt(state[key]); onChange && onChange(); });
  return (v) => { el.value = v; if (out) out.textContent = fmt(v); };
}
const setDepthUI = bindRange('depth', 'depth', (v) => `${v.toFixed(1)} cm`);
const setCCUI = bindRange('angCC', 'angCC', (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}°`);
const setLatUI = bindRange('angLat', 'angLat', (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}°`);
const setRollUI = bindRange('roll', 'roll', (v) => `${v.toFixed(0)}°`);
bindRange('iap', 'iap', (v) => `${v} mmHg`, () => applyPressure());
bindRange('bmi', 'bmi', (v) => `${v}`, () => { rebuildSkin(); });
bindRange('skin', 'skinOpacity', (v) => `${v}%`, () => { skinMat.uniforms.uOpacity.value = state.skinOpacity / 100; });
state.skinOpacity = 35; skinMat.uniforms.uOpacity.value = 0.35;

$('antifog').onchange = (e) => { state.antifog = e.target.checked; };
$('highlight').onchange = (e) => { state.highlight = e.target.checked; };
$('showOmentum').onchange = (e) => {
  state.showOmentum = e.target.checked;
  anat.byId.omentum.visible = state.showOmentum;
  anat.byId.omentum.group.visible = state.showOmentum;
};
document.querySelectorAll('#optic button').forEach((b) => {
  b.onclick = () => {
    state.optic = +b.dataset.v;
    document.querySelectorAll('#optic button').forEach((x) => x.classList.toggle('on', x === b));
    $('roll').disabled = state.optic === 0;
    $('hudOptic').textContent = `${state.optic}°`;
  };
});
$('btnSuction').onclick = suction;
$('btnResetScope').onclick = () => withdraw();
$('btnResetSession').onclick = resetSession;
$('btnExport').onclick = exportResults;
$('btnHelp').onclick = () => $('help').showModal();
$('btnLayout').onclick = () => $('views').classList.toggle('monitor-only');
let followTip = false;
$('btnFocusTip').onclick = (e) => { followTip = !followTip; e.target.classList.toggle('on', followTip); };
$('btnResetCam').onclick = () => { followTip = false; $('btnFocusTip').classList.remove('on'); extCam.position.copy(EXT_HOME.pos); controls.target.copy(EXT_HOME.target); };

function selectPort(id) {
  state.portId = id;
  [...portList.children].forEach((b) => b.classList.toggle('on', b.dataset.id === id));
  const p = PORTS.find((x) => x.id === id);
  $('portDesc').textContent = p.desc;
  withdraw(true);
  logEvent('info', `Port selected: ${p.name}`);
}

function withdraw(silent = false) {
  sim.prevPose = null; sim.lastTip = null;
  state.depth = 0; state.angCC = 0; state.angLat = 0;
  setDepthUI(0); setCCUI(0); setLatUI(0);
  if (!silent && sim.wasInCavity) logEvent('info', 'Scope withdrawn');
}

function applyPressure() {
  anat.setIAP(state.iap);
  rebuildSkin();
  if (state.iap > 15) logEventOnce('iap-high', 'warn', `High IAP (${state.iap} mmHg) — risk of reduced venous return / CO₂ absorption`);
  else if (state.iap < 8 && state.iap > 0) logEventOnce('iap-low', 'warn', `Low IAP (${state.iap} mmHg) — little working space, viscera close to wall`);
  else if (state.iap === 0) logEventOnce('iap-zero', 'warn', 'No pneumoperitoneum — abdominal wall resting on viscera');
}

function suction() {
  if (sim.blood > 0.02) logEvent('info', 'Suction / irrigation — field cleared');
  sim.blood = 0; sim.fog = 0;
}

// Keyboard
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (['w', 's', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.add(k); e.preventDefault(); }
  if (k >= '1' && k <= '5') selectPort(PORTS[+k - 1].id);
  if (k === 'm') $('views').classList.toggle('monitor-only');
  if (k === 'r') withdraw();
  if (k === 'x') suction();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

// Drag-to-steer + wheel on monitor
const scopeView = $('scopeView');
let drag = null;
scopeView.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; scopeView.setPointerCapture(e.pointerId); scopeView.focus(); });
scopeView.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY };
  state.angLat = clamp(state.angLat + dx * 0.12, -60, 60);
  state.angCC = clamp(state.angCC - dy * 0.12, -60, 60);
  setLatUI(state.angLat); setCCUI(state.angCC);
});
scopeView.addEventListener('pointerup', () => { drag = null; });
scopeView.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.depth = clamp(state.depth - e.deltaY * 0.01, 0, 32);
  setDepthUI(state.depth);
}, { passive: false });

// ------------------------------------------------------------------ events
const LEVEL_RANK = { info: 0, ok: 1, warn: 2, close: 3, bad: 4 };
const onceKeys = new Set();
function logEventOnce(key, level, msg) { if (onceKeys.has(key)) return; onceKeys.add(key); logEvent(level, msg); setTimeout(() => onceKeys.delete(key), 8000); }
function fmtTime(s) { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; }
function logEvent(level, msg) {
  const ev = { t: sim.elapsed, level, msg };
  sim.events.push(ev);
  const li = document.createElement('li');
  li.className = level;
  li.innerHTML = `<time>${fmtTime(ev.t)}</time><span></span>`;
  li.querySelector('span').textContent = msg;
  const log = $('eventLog');
  log.prepend(li);
  while (log.children.length > 200) log.lastChild.remove();
}

function resetSession() {
  withdraw(true);
  Object.assign(sim, {
    t0: performance.now(), elapsed: 0, fog: 0, blood: 0, contactAmt: 0, wasInCavity: false, maxLayerIdx: -1,
    organLevel: {}, seenFrac: {}, critical: null, lastTip: null, prevPose: null, exposure: 1, fov: [], events: [], clearanceAtEntry: null,
    stats: { entries: 0, contacts: 0, injuries: 0, maxDepth: 0, cavTime: 0, path: 0, seen: new Set() },
  });
  $('eventLog').innerHTML = '';
  $('seenChips').innerHTML = '';
  logEvent('info', 'Session reset');
}

function exportResults() {
  const port = PORTS.find((p) => p.id === state.portId);
  const data = {
    generatedAt: new Date().toISOString(),
    simulator: 'LapSim laparoscopic entry simulator (educational model)',
    settings: { port: port.name, optic: `${state.optic}°`, insufflationPressure_mmHg: state.iap, bmi: state.bmi, antifog: state.antifog },
    scope: { depth_cm: +state.depth.toFixed(2), tiltCranialCaudal_deg: state.angCC, tiltRightLeft_deg: state.angLat, lightPostRotation_deg: state.roll },
    current: lastReadout,
    sessionResults: {
      durationSeconds: Math.round(sim.elapsed), cavityEntries: sim.stats.entries, tissueContacts: sim.stats.contacts,
      injuries: sim.stats.injuries, maxDepth_cm: +sim.stats.maxDepth.toFixed(2), timeInCavity_s: Math.round(sim.stats.cavTime),
      tipPath_cm: Math.round(sim.stats.path), structuresIdentified: [...sim.stats.seen],
    },
    fieldOfView: sim.fov.map((f) => ({ structure: f.name, percent: Math.round(f.share * 100) })),
    events: sim.events.map((e) => ({ time: fmtTime(e.t), level: e.level, message: e.msg })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lapsim-results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ simulation
const NAMES = Object.fromEntries(anat.organs.map((o) => [o.id, o.name]));
NAMES.wall = 'Abdominal wall (peritoneum)';
const COLORS = Object.fromEntries(anat.organs.map((o) => [o.id, o.color]));
COLORS.wall = '#e3afa2';

let lastReadout = {};
let cur = null;

function computeKinematics() {
  const port = PORTS.find((p) => p.id === state.portId);
  const pg = portGeometry(port, state.bmi);
  const d = scopeDirection(pg, state.angCC, state.angLat);
  const sPeri = entryDistance(pg.skin, d);
  const tip = pg.skin.clone().addScaledVector(d, state.depth);

  // view direction (30° optic deflects toward the light-post direction)
  let upRef = V(0, 0.707, -0.707).projectOnPlane(d);
  if (upRef.lengthSq() < 1e-3) upRef = V(0, 0, -1).projectOnPlane(d);
  upRef.normalize();
  const rightRef = d.clone().cross(upRef).normalize();
  let view = d.clone();
  if (state.optic > 0) {
    const r = state.roll * DEG;
    const u = upRef.clone().multiplyScalar(Math.cos(r)).addScaledVector(rightRef, Math.sin(r));
    view = d.clone().multiplyScalar(Math.cos(state.optic * DEG)).addScaledVector(u, Math.sin(state.optic * DEG)).normalize();
  }
  let camUp = V(0, 0.707, -0.707).projectOnPlane(view);
  if (camUp.lengthSq() < 1e-3) camUp = V(0, 0, -1).projectOnPlane(view);
  camUp.normalize();

  // which tissue is the tip in?
  let layer = null, layerIdx = -1;
  const inWall = state.depth < sPeri;
  if (state.depth <= 0.001) {
    layer = { name: 'At skin (not inserted)', type: 0, key: 'surface' };
  } else if (inWall) {
    const scale = isFinite(sPeri) ? sPeri / pg.T : 1 / Math.max(0.15, d.dot(pg.nIn));
    let acc = 0;
    for (let i = 0; i < pg.layers.length; i++) {
      acc += pg.layers[i].t * scale;
      if (state.depth < acc || i === pg.layers.length - 1) { layer = pg.layers[i]; layerIdx = i; break; }
    }
  }
  return { port, pg, d, sPeri, tip, view, camUp, layer, layerIdx, inWall, angleToNormal: Math.acos(clamp(d.dot(pg.nIn), -1, 1)) / DEG };
}

function levelForDistance(d) {
  if (d <= -0.4) return 4;      // injury
  if (d <= 0.12) return 3;      // contact
  if (d <= 1.0) return 2;       // close
  if (d <= 3.0) return 1;       // caution
  return 0;
}

const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
function analyseFieldOfView(k) {
  const counts = {}; let total = 0; const ts = [];
  const aspect = scopeCam.aspect;
  const nx = 15, ny = 11;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = ((i + 0.5) / nx - 0.5) * aspect, cy = (j + 0.5) / ny - 0.5;
    const r = Math.hypot(cx, cy);
    if (r > 0.54) continue;
    const f = 1 + 0.16 * r * r;
    _ndc.set((cx * f / aspect) * 2, cy * f * 2);
    _ray.setFromCamera(_ndc, scopeCam);
    const hit = anat.march(scopeCam.position, _ray.ray.direction, 40);
    if (!hit.id) continue;
    counts[hit.id] = (counts[hit.id] || 0) + 1; total++;
    ts.push(hit.t);
  }
  ts.sort((a, b) => a - b);
  if (ts.length) sim.viewDist = ts[Math.floor(ts.length * 0.4)];
  _ray.setFromCamera(_ndc.set(0, 0), scopeCam);
  const c = anat.march(scopeCam.position, _ray.ray.direction, 40);
  sim.centre = c.id ? c : null;
  sim.fov = Object.entries(counts).map(([id, n]) => ({ id, name: NAMES[id], share: n / Math.max(total, 1) }))
    .sort((a, b) => b.share - a.share);
  for (const f of sim.fov) {
    if (f.id === 'wall' || f.share < 0.08 || sim.stats.seen.has(f.name)) continue;
    sim.stats.seen.add(f.name);
    logEvent('ok', `Visualised: ${f.name}`);
    const chip = document.createElement('span'); chip.textContent = f.name; $('seenChips').appendChild(chip);
  }
}

let fovTimer = 0, uiTimer = 0;
const tmpV = V();

function step(dt) {
  sim.elapsed = (performance.now() - sim.t0) / 1000;

  // keyboard motion
  if (keys.size) {
    if (keys.has('w')) state.depth = clamp(state.depth + 5 * dt, 0, 32);
    if (keys.has('s')) state.depth = clamp(state.depth - 5 * dt, 0, 32);
    if (keys.has('arrowup')) state.angCC = clamp(state.angCC + 30 * dt, -60, 60);
    if (keys.has('arrowdown')) state.angCC = clamp(state.angCC - 30 * dt, -60, 60);
    if (keys.has('arrowleft')) state.angLat = clamp(state.angLat - 30 * dt, -60, 60);
    if (keys.has('arrowright')) state.angLat = clamp(state.angLat + 30 * dt, -60, 60);
    if (keys.has('q') && state.optic) state.roll = ((state.roll - 90 * dt + 540) % 360) - 180;
    if (keys.has('e') && state.optic) state.roll = ((state.roll + 90 * dt + 540) % 360) - 180;
    setDepthUI(state.depth); setCCUI(state.angCC); setLatUI(state.angLat); setRollUI(state.roll);
  }

  const k = computeKinematics();
  cur = k;
  const { tip, d, sPeri, inWall, pg } = k;

  // stats
  if (sim.lastTip) sim.stats.path += sim.lastTip.distanceTo(tip);
  sim.lastTip = tip.clone();
  sim.stats.maxDepth = Math.max(sim.stats.maxDepth, state.depth);

  // tissue layers on the way in
  if (inWall && k.layerIdx >= 0 && k.layerIdx > sim.maxLayerIdx) {
    sim.maxLayerIdx = k.layerIdx;
    if (k.layerIdx > 0) logEvent('info', `Through ${pg.layers[k.layerIdx - 1].name.toLowerCase()} → ${k.layer.name} (${state.depth.toFixed(1)} cm)`);
  }
  if (state.depth < 0.01) sim.maxLayerIdx = -1;

  const inCavity = !inWall && state.depth > 0;
  const wallDist = cavityInsideDist(tip);

  // clearance under the port along the shaft axis
  const entryPt = isFinite(sPeri) ? pg.skin.clone().addScaledVector(d, sPeri + 0.06) : null;
  const ahead = inCavity ? anat.march(tip, d, 45) : entryPt ? anat.march(entryPt, d, 45) : null;
  sim.ahead = ahead;

  // entering / leaving the cavity
  if (inCavity && !sim.wasInCavity) {
    sim.stats.entries++;
    const clr = entryPt ? anat.march(entryPt, d, 45) : null;
    sim.clearanceAtEntry = clr;
    const what = clr && clr.id ? `${NAMES[clr.id]} ${clr.t.toFixed(1)} cm below` : 'no structure on axis';
    logEvent(clr && clr.id && clr.id !== 'wall' && clr.t < 2 ? 'warn' : 'ok', `Peritoneum breached at ${sPeri.toFixed(1)} cm — in cavity (${what})`);
    if (!state.antifog) { sim.fog = 1; logEvent('warn', 'Lens fogged — cold scope in warm, humid cavity'); }
  }
  if (!inCavity && sim.wasInCavity && state.depth > 0) logEvent('info', 'Tip back in abdominal wall');
  sim.wasInCavity = inCavity;
  if (inCavity) sim.stats.cavTime += dt;

  // proximity to every structure
  const dists = [];
  for (const o of anat.organs) {
    if (!o.visible) continue;
    dists.push({ id: o.id, name: o.name, d: anat.organDistance(o, tip), organ: o });
  }
  dists.push({ id: 'wall', name: NAMES.wall, d: Math.max(wallDist, 0), wall: true });
  dists.sort((a, b) => a.d - b.d);
  k.dists = dists;

  // contact / injury state machine (only meaningful inside the cavity)
  let worst = null;
  if (inCavity) {
    for (const x of dists) {
      if (x.wall) continue;
      const lvl = levelForDistance(x.d);
      // peak level within the current "episode"; an episode ends once the tip is >1 cm away again
      const peak = sim.organLevel[x.id] || 0;
      if (lvl > peak) {
        if (lvl >= 3 && peak < 3) sim.stats.contacts++;
        if (lvl === 2) logEvent('warn', `Within 1 cm of ${x.name}`);
        if (lvl === 3) logEvent('close', `Contact: ${x.name} at ${state.depth.toFixed(1)} cm`);
        if (lvl === 4) {
          sim.stats.injuries++;
          logEvent('bad', `INJURY: ${x.organ.injury}`);
          if (x.organ.kind === 'vessel') sim.critical = x.organ.injury;
        }
        sim.organLevel[x.id] = lvl;
      } else if (lvl <= 1) {
        sim.organLevel[x.id] = lvl;
      }
      if (!worst || lvl > worst.lvl) worst = { ...x, lvl };
    }
    // posterior / lateral peritoneum
    if (wallDist < 0.12) {
      const lvl = wallDist < -0.4 ? 4 : 3;
      const peak = sim.organLevel.wall || 0;
      if (lvl > peak) {
        if (peak < 3) sim.stats.contacts++;
        if (lvl === 3) logEvent('close', 'Tip touching the peritoneal wall');
        else { sim.stats.injuries++; logEvent('bad', 'Tip has passed through the peritoneum (retroperitoneum / far wall)'); }
        sim.organLevel.wall = lvl;
      }
      if (!worst || lvl > worst.lvl) worst = { id: 'wall', name: NAMES.wall, d: wallDist, lvl };
    } else if (wallDist > 1) sim.organLevel.wall = 0;
  } else {
    for (const key in sim.organLevel) sim.organLevel[key] = 0;
  }
  // fast moves: re-trace the pivoting path swept since the last frame so the scope can't skip through an organ
  const prevPose = sim.prevPose && sim.prevPose.portId === state.portId ? sim.prevPose
    : (inCavity && isFinite(sPeri) ? { depth: sPeri + 0.05, angCC: state.angCC, angLat: state.angLat } : null);
  if (prevPose && inCavity) {
    const prevTip = pg.skin.clone().addScaledVector(scopeDirection(pg, prevPose.angCC, prevPose.angLat), prevPose.depth);
    const span = prevTip.distanceTo(tip);
    if (span > 0.3) {
      const n = Math.ceil(span / 0.2);
      for (let i = 1; i < n; i++) {
        const f = i / n;
        const dd = scopeDirection(pg, THREE.MathUtils.lerp(prevPose.angCC, state.angCC, f), THREE.MathUtils.lerp(prevPose.angLat, state.angLat, f));
        const depthI = THREE.MathUtils.lerp(prevPose.depth, state.depth, f);
        if (depthI < sPeri) continue;
        const pnt = pg.skin.clone().addScaledVector(dd, depthI);
        if (cavityInsideDist(pnt) < 0) continue;
        for (const o of anat.organs) {
          if (!o.visible || (sim.organLevel[o.id] || 0) >= 4) continue;
          if (anat.organDistance(o, pnt) < -0.4) {
            if ((sim.organLevel[o.id] || 0) < 3) sim.stats.contacts++;
            sim.stats.injuries++;
            sim.organLevel[o.id] = 4;
            logEvent('bad', `INJURY: scope passed through ${o.name.toLowerCase()} — ${o.injury}`);
            if (o.kind === 'vessel') sim.critical = o.injury;
            if (o.bleeds) sim.blood = Math.min(1, sim.blood + (o.kind === 'vessel' ? 0.5 : 0.2));
          }
        }
      }
    }
  }
  sim.prevPose = inCavity ? { portId: state.portId, depth: state.depth, angCC: state.angCC, angLat: state.angLat } : null;
  k.worst = worst;

  // red-out amount and colour
  let contactAmt = 0;
  const contactCol = new THREE.Color();
  if (inCavity) {
    const nearest = dists.find((x) => !x.wall);
    const dWall = wallDist;
    const dOrg = nearest ? nearest.d : Infinity;
    if (dOrg < dWall) { contactAmt = smooth(0.35, -0.5, dOrg); contactCol.set(COLORS[nearest.id]); }
    else { contactAmt = smooth(0.35, -0.5, dWall); contactCol.set(COLORS.wall); }
  }
  sim.contactAmt += (contactAmt - sim.contactAmt) * Math.min(1, dt * 12);

  // bleeding
  if (worst && worst.lvl === 4 && worst.organ && worst.organ.bleeds) {
    sim.blood = Math.min(1, sim.blood + dt * (worst.organ.kind === 'vessel' ? 0.3 : 0.07));
  } else if (sim.critical) {
    sim.blood = Math.min(1, sim.blood + dt * 0.04);
  } else {
    sim.blood = Math.max(0, sim.blood - dt * 0.004);
  }
  sim.fog = Math.max(0, sim.fog - dt * 0.18);

  // ---------- update scene objects ----------
  scopeCam.position.copy(tip);
  scopeCam.up.copy(k.camUp);
  scopeCam.lookAt(tmpV.copy(tip).add(k.view));
  scopeCam.updateMatrixWorld();

  // field of view analysis (throttled)
  fovTimer -= dt;
  if (fovTimer <= 0) {
    fovTimer = 0.2;
    if (inCavity && contactAmt < 0.9) analyseFieldOfView(k);
    else { sim.fov = []; sim.centre = null; }
  }
  scopeSpot.position.copy(tip).addScaledVector(k.view, -0.2);
  scopeSpot.target.position.copy(tip).add(k.view);
  scopeSpot.target.updateMatrixWorld();
  scopeFill.position.copy(tip).addScaledVector(k.view, 0.3);

  const back = tip.clone().addScaledVector(d, -36);
  placeCylinder(scopeShaft, back, tip);
  placeCylinder(scopeHead, back.clone().addScaledVector(d, -5.5), back);
  const postDir = k.view.clone().sub(d.clone().multiplyScalar(k.view.dot(d)));
  if (postDir.lengthSq() < 1e-4) postDir.copy(k.camUp);
  postDir.normalize();
  const postBase = back.clone().addScaledVector(d, 2.5);
  placeCylinder(lightPost, postBase, postBase.clone().addScaledVector(postDir, 3));
  const troEnd = isFinite(sPeri) ? sPeri + 0.8 : pg.T + 1;
  placeCylinder(trocar, pg.skin.clone().addScaledVector(d, -6), pg.skin.clone().addScaledVector(d, Math.min(troEnd, Math.max(state.depth, 0.5) + 0.0) ));
  placeCylinder(trocarHousing, pg.skin.clone().addScaledVector(d, -9.5), pg.skin.clone().addScaledVector(d, -5.5));
  trocar.visible = trocarHousing.visible = state.depth > 0.001;
  tipGlow.position.copy(tip);
  tipGlow.material.color.set(worst && worst.lvl >= 3 ? 0xf43f5e : worst && worst.lvl === 2 ? 0xfb923c : 0x2dd4bf);
  viewCone.position.copy(tip).addScaledVector(k.view, coneLen / 2);
  viewCone.quaternion.setFromUnitVectors(UP, k.view.clone().negate());
  viewCone.visible = state.depth > 0.001;

  const trajEnd = ahead && ahead.id ? (inCavity ? tip.clone() : entryPt.clone()).addScaledVector(d, ahead.t) : pg.skin.clone().addScaledVector(d, 30);
  trajGeo.setFromPoints([pg.skin, trajEnd]);
  trajLine.computeLineDistances();
  const clr = ahead && ahead.id && ahead.id !== 'wall' ? ahead.t : 99;
  trajLine.material.color.set(clr < 1 ? 0xf43f5e : clr < 3 ? 0xfb923c : 0xfacc15);
  hitMarker.position.copy(trajEnd);
  hitMarker.material.color.copy(trajLine.material.color);
  hitMarker.visible = !!(ahead && ahead.id);

  for (const p of PORTS) {
    const g = p.id === state.portId ? pg : portGeometry(p, state.bmi);
    const m = portMarkers[p.id];
    m.position.copy(g.skin).addScaledVector(g.nOut, 0.15);
    m.quaternion.setFromUnitVectors(V(0, 0, 1), g.nOut);
    m.material.color.set(p.id === state.portId ? 0x2dd4bf : 0xe2e8f0);
    m.scale.setScalar(p.id === state.portId ? 1.25 : 1);
  }

  // post-process uniforms
  const u = post.uniforms;
  u.uTime.value = sim.elapsed;
  u.uLayerMix.value = inWall || state.depth <= 0.001 ? 1 : 0;
  u.uLayerType.value = k.layer ? k.layer.type : 6;
  u.uLayerDepth.value = state.depth;
  u.uContact.value = sim.contactAmt;
  u.uContactCol.value.copy(contactCol);
  u.uFog.value = sim.fog;
  u.uBlood.value = sim.blood;
  // automatic gain control, like a real camera head: brighten when tissue is far from the light
  const targetExp = inCavity ? clamp(Math.pow(sim.viewDist / 4.5, 1.6), 0.9, 5) : 1;
  if (sim.contactAmt < 0.6) sim.exposure += (targetExp - sim.exposure) * Math.min(1, dt * 2.5);
  u.uBright.value = sim.exposure;

  if (followTip) controls.target.lerp(tip, Math.min(1, dt * 4));

  uiTimer -= dt;
  if (uiTimer <= 0) { uiTimer = 0.1; updateUI(k, inCavity, wallDist); }
}

// ------------------------------------------------------------------ UI updates
function levelName(l) { return ['ok', 'warn', 'close', 'bad', 'bad'][l] || 'ok'; }

function updateUI(k, inCavity, wallDist) {
  const { pg, layer, worst } = k;
  let level = 'info', label = '', sub = '';
  if (sim.critical) {
    level = 'bad'; label = 'CRITICAL — major vascular injury';
    sub = 'Simulated outcome: haemorrhage. Convert to open surgery / call vascular. Reset session to retry.';
  } else if (state.depth <= 0.001) {
    level = 'info'; label = 'Scope outside patient'; sub = `At ${k.port.name} port — advance to insert`;
  } else if (k.inWall) {
    level = 'info'; label = `Traversing abdominal wall`; sub = layer ? layer.name : '';
    if (!isFinite(k.sPeri)) { level = 'warn'; label = 'Trajectory does not enter the cavity'; sub = 'Scope is tunnelling in the wall — reduce the tilt'; }
  } else if (worst && worst.lvl >= 4) {
    level = 'bad'; label = worst.id === 'wall' ? 'Through the peritoneum' : `Injury — ${worst.name}`;
    sub = worst.organ ? worst.organ.injury : 'Tip outside the peritoneal cavity';
  } else if (worst && worst.lvl === 3) {
    level = 'close'; label = `Contact — ${worst.name}`; sub = 'Lens against tissue (red-out). Withdraw slightly.';
  } else if (worst && worst.lvl === 2) {
    level = 'close'; label = `Close to ${worst.name}`; sub = `${(worst.d * 10).toFixed(0)} mm from the tip`;
  } else if (worst && worst.lvl === 1) {
    level = 'warn'; label = 'In cavity — caution'; sub = `${worst.name} ${worst.d.toFixed(1)} cm from the tip`;
  } else {
    level = 'ok'; label = 'In peritoneal cavity — clear'; sub = 'No structure within 3 cm of the tip';
  }
  const card = $('statusCard');
  card.dataset.level = level; $('statusLabel').textContent = label; $('statusSub').textContent = sub;
  $('statusPill').dataset.level = level; $('statusPillText').textContent = label;

  // HUD
  $('hudClock').textContent = fmtTime(sim.elapsed);
  $('hudIap').textContent = state.iap;
  $('hudDepth').textContent = state.depth.toFixed(1);
  const hl = $('hudLayer');
  if (k.inWall && state.depth > 0.001 && layer) { hl.style.display = 'block'; hl.textContent = `IN WALL · ${layer.name.toUpperCase()}`; }
  else if (state.depth <= 0.001) { hl.style.display = 'block'; hl.textContent = 'AT SKIN · ADVANCE TO INSERT'; }
  else hl.style.display = 'none';
  const al = $('hudAlert');
  al.className = 'alert';
  if (sim.critical) { al.classList.add('bad'); al.textContent = sim.critical; }
  else if (inCavity && worst && worst.lvl >= 4) { al.classList.add('bad'); al.textContent = worst.organ ? worst.organ.injury.toUpperCase() : 'THROUGH PERITONEUM'; }
  else if (inCavity && worst && worst.lvl === 3) { al.classList.add('close'); al.textContent = `CONTACT · ${worst.name.toUpperCase()}`; }
  else if (inCavity && worst && worst.lvl === 2) { al.classList.add('warn'); al.textContent = `${worst.name.toUpperCase()} · ${(worst.d * 10).toFixed(0)} mm`; }
  else if (sim.fog > 0.3) { al.classList.add('warn'); al.textContent = 'LENS FOGGED'; }

  // readout
  $('rLayer').textContent = state.depth <= 0.001 ? 'Outside' : k.inWall ? (layer ? layer.name : '—') : wallDist < 0 ? 'Beyond peritoneum' : 'Peritoneal cavity';
  $('rRegion').textContent = inCavity ? regionOf(k.tip) : '—';
  $('rWall').textContent = `${pg.T.toFixed(1)} cm` + (isFinite(k.sPeri) ? ` (${k.sPeri.toFixed(1)} on path)` : '');
  $('rIntra').textContent = inCavity ? `${(state.depth - k.sPeri).toFixed(1)} cm` : '—';
  $('rAngle').textContent = `${k.angleToNormal.toFixed(0)}°`;
  const a = sim.ahead;
  $('rAhead').textContent = a && a.id ? `${NAMES[a.id]} · ${a.t.toFixed(1)} cm` : '—';
  $('rCentre').textContent = sim.centre ? `${NAMES[sim.centre.id]} · ${sim.centre.t.toFixed(1)} cm` : '—';

  // nearest list
  const nl = $('nearList');
  nl.innerHTML = '';
  for (const x of k.dists.filter((q) => !q.wall).slice(0, 5)) {
    const lvl = levelForDistance(x.d);
    const col = ['#34d399', '#fbbf24', '#fb923c', '#f43f5e', '#f43f5e'][lvl];
    const li = document.createElement('li');
    const shown = state.depth <= 0.001 || k.inWall ? x.d : x.d;
    li.innerHTML = `<span>${x.name}</span><span class="d" style="color:${col}">${shown <= 0 ? 'contact' : shown < 1 ? (shown * 10).toFixed(0) + ' mm' : shown.toFixed(1) + ' cm'}</span>
      <div class="bar"><i style="width:${Math.max(4, 100 - clamp(x.d, 0, 15) / 15 * 100)}%;background:${col}"></i></div>`;
    nl.appendChild(li);
  }

  // FOV list
  const fl = $('fovList');
  fl.innerHTML = '';
  if (!sim.fov.length) {
    fl.innerHTML = `<li class="muted">${inCavity ? (sim.contactAmt > 0.8 ? 'View obscured — lens against tissue' : 'Analysing…') : 'Enter the cavity to analyse the view'}</li>`;
  } else {
    for (const f of sim.fov.slice(0, 6)) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${f.name.replace(' (peritoneum)', '')}</span><div class="bar"><i style="width:${(f.share * 100).toFixed(0)}%;background:${COLORS[f.id]}"></i></div><span class="pct">${(f.share * 100).toFixed(0)}%</span>`;
      fl.appendChild(li);
    }
  }

  // stats
  const s = sim.stats;
  $('sEntries').textContent = s.entries; $('sContacts').textContent = s.contacts; $('sInjuries').textContent = s.injuries;
  $('sMaxDepth').textContent = s.maxDepth.toFixed(1); $('sCavTime').textContent = `${Math.round(s.cavTime)}s`; $('sPath').textContent = Math.round(s.path);
  $('sInjuries').style.color = s.injuries ? 'var(--bad)' : '';

  lastReadout = {
    status: label, detail: sub, tissue: $('rLayer').textContent, region: $('rRegion').textContent,
    wallThickness_cm: +pg.T.toFixed(2), intraAbdominalLength_cm: inCavity ? +(state.depth - k.sPeri).toFixed(2) : null,
    aheadOnAxis: a && a.id ? { structure: NAMES[a.id], distance_cm: +a.t.toFixed(2) } : null,
    nearest: k.dists.filter((q) => !q.wall).slice(0, 5).map((x) => ({ structure: x.name, distance_cm: +x.d.toFixed(2) })),
  };
}

// ------------------------------------------------------------------ render loop
function viewRect(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: window.innerHeight - r.bottom, w: r.width, h: r.height, visible: r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight };
}

function setHighlight(on) {
  const t = sim.elapsed;
  for (const o of anat.organs) {
    let amt = 0;
    if (on && state.highlight && cur && cur.worst && cur.worst.id === o.id && cur.worst.lvl >= 1) {
      amt = cur.worst.lvl >= 3 ? 0.55 + 0.35 * Math.sin(t * 10) : cur.worst.lvl === 2 ? 0.35 : 0.18;
    }
    for (const m of o.materials) {
      m.emissive.set(cur && cur.worst && cur.worst.lvl >= 2 ? 0xff2244 : 0xffaa00);
      m.emissiveIntensity = amt;
    }
  }
}

function render() {
  const w = window.innerWidth, h = window.innerHeight;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
  const dpr = renderer.getPixelRatio();
  renderer.setScissorTest(true);
  renderer.setClearColor(0x07090c, 1);
  renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
  renderer.clear();

  // laparoscope view
  const sr = viewRect(scopeView);
  if (sr.visible) {
    scopeCam.aspect = sr.w / sr.h; scopeCam.updateProjectionMatrix();
    post.setSize(Math.max(2, Math.floor(sr.w * dpr)), Math.max(2, Math.floor(sr.h * dpr)));
    setHighlight(false);
    renderer.setRenderTarget(post.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, scopeCam);
    renderer.setRenderTarget(null);
    renderer.setViewport(sr.x, sr.y, sr.w, sr.h); renderer.setScissor(sr.x, sr.y, sr.w, sr.h);
    renderer.render(post.scene, post.camera);
  }

  // external view
  const er = viewRect($('extView'));
  if (er.visible) {
    extCam.aspect = er.w / er.h; extCam.updateProjectionMatrix();
    setHighlight(true);
    renderer.setViewport(er.x, er.y, er.w, er.h); renderer.setScissor(er.x, er.y, er.w, er.h);
    renderer.setClearColor(0x0b0f14, 1);
    renderer.render(scene, extCam);
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  step(dt);
  controls.update();
  render();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot
rebuildSkin();
selectPort('umbilical');
sim.events = []; $('eventLog').innerHTML = '';
logEvent('info', 'Session started — umbilical port selected, IAP 12 mmHg');
$('roll').disabled = false;
requestAnimationFrame((t) => { last = t; frame(t); $('loading').classList.add('done'); });

// expose for debugging / automated testing
window.lapsim = { state, sim, anat, setDepthUI, setCCUI, setLatUI, setRollUI, selectPort, get cur() { return cur; } };
