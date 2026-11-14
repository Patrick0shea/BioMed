// Transanal balloon probe: atraumatic tip, balloon, marked shaft with a red insertion-limit
// line, handle with three thumb buttons and a status LED, and an inflation line.
// Local frame (cm): +Z = distal (toward the tip), +Y = top of the handle (buttons),
// origin = the red line. Every dimension lives in PROBE so it is easy to change.
import * as THREE from 'three';

export const PROBE = {
  shaftR: 0.6,
  shaftStart: -5.6,          // shaft disappears into the handle nose here
  redLineZ: 0,               // red line = insertion limit (sits at the anal verge when fully inserted)
  balloonCenter: 9.0,        // distance red line → balloon centre (= anastomosis height)
  balloonHalf: 2.1,          // half-length of the balloon
  balloonMaxR: 2.35,         // inflated radius
  tipStart: 11.1,
  tipZ: 12.4,                // distal end of the probe
  handleNose: -5.0,
  handleBack: -19.6,
  handleR: 1.6,
  gripZ: -15.0,              // where the hand's grip is centred along the handle
  buttons: [
    { z: -8.9, color: '#22c55e', label: '1', name: 'Power on' },
    { z: -10.0, color: '#3b82f6', label: '2', name: 'Inflate balloon' },
    { z: -11.1, color: '#f59e0b', label: '3', name: 'Deflate balloon' },
  ],
  ledZ: -7.75,
};

const ease = (t) => t * t * (3 - 2 * t);

function shaftTexture(len, zMax) {
  const W = 256, PX = 48, H = Math.ceil(len * PX);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f4f6'; g.fillRect(0, 0, W, H);
  const yOf = (z) => (zMax - z) * PX;
  // depth marks: numbers = distance from the balloon centre (what sits at the anal verge)
  for (let z = Math.ceil(PROBE.shaftStart + 0.5); z <= PROBE.balloonCenter - PROBE.balloonHalf - 0.4; z += 0.5) {
    const whole = Math.abs(z - Math.round(z)) < 1e-6;
    const y = yOf(z);
    g.fillStyle = '#1c2228';
    if (whole) g.fillRect(0, y - 1.5, W, 3);
    else g.fillRect(W * 0.38, y - 1, W * 0.24, 2);
    const n = PROBE.balloonCenter - z;
    if (whole && Math.abs(z - PROBE.redLineZ) > 0.1 && n >= 3 && n <= 15) {
      g.save();
      g.translate(W / 2, y - 12);
      g.rotate(-Math.PI / 2); // reads proximal → distal, upright from the button side
      g.font = 'bold 22px Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(n), 0, 0);
      g.restore();
    }
  }
  // red line band
  g.fillStyle = '#e11d2e';
  g.fillRect(0, yOf(PROBE.redLineZ) - 7, W, 14);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function digitTexture(txt, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 128, 128);
  const gr = g.createRadialGradient(54, 50, 6, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffffff';
  g.font = 'bold 76px Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(txt, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Lathe around the probe's Z axis from (r, z) pairs. */
function lathe(pts, segs = 64) {
  const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), segs);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Cylinder with its axis along local Z. */
function zCyl(r0, r1, z0, z1, segs = 40, open = false, thetaStart = 0, thetaLength = Math.PI * 2) {
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, segs, 1, open, thetaStart, thetaLength);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

export function createProbe() {
  const P = PROBE;
  const group = new THREE.Group();
  group.name = 'probe';

  const mats = {
    white: new THREE.MeshPhysicalMaterial({ color: '#f3f5f7', roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    grip: new THREE.MeshStandardMaterial({ color: '#2c3a45', roughness: 0.85 }),
    panel: new THREE.MeshStandardMaterial({ color: '#1d252d', roughness: 0.5 }),
    metal: new THREE.MeshStandardMaterial({ color: '#c8d2dc', metalness: 0.9, roughness: 0.28 }),
    tube: new THREE.MeshPhysicalMaterial({ color: '#d8eef6', roughness: 0.25, transparent: true, opacity: 0.75, clearcoat: 1 }),
    shaft: new THREE.MeshStandardMaterial({ roughness: 0.38 }),
    red: new THREE.MeshStandardMaterial({ color: '#e11d2e', emissive: '#ff1a2e', emissiveIntensity: 0.25, roughness: 0.4 }),
    balloon: new THREE.MeshPhysicalMaterial({
      color: '#8fd3ff', roughness: 0.12, clearcoat: 1, transparent: true, opacity: 0.62,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    led: new THREE.MeshStandardMaterial({ color: '#111', emissive: '#000', roughness: 0.3 }),
  };

  const parts = {};
  const part = (id, name) => { const g = new THREE.Group(); g.name = id; g.userData.label = name; group.add(g); parts[id] = g; return g; };

  // ---- shaft (with depth marks and the red line)
  const shaft = part('shaft', 'Marked shaft');
  const zMax = P.balloonCenter + P.balloonHalf + 0.05;
  const len = zMax - P.shaftStart;
  mats.shaft.map = shaftTexture(len, zMax);
  shaft.add(new THREE.Mesh(zCyl(P.shaftR, P.shaftR, P.shaftStart, zMax, 48, true), mats.shaft));
  const redLine = new THREE.Mesh(zCyl(P.shaftR + 0.035, P.shaftR + 0.035, P.redLineZ - 0.16, P.redLineZ + 0.16, 48), mats.red);
  shaft.add(redLine);

  // ---- balloon (geometry updated on inflation)
  const balloon = part('balloon', 'Balloon');
  const bz0 = P.balloonCenter - P.balloonHalf, bz1 = P.balloonCenter + P.balloonHalf;
  const NP = 56, NS = 64;
  const prof = [];
  for (let j = 0; j < NP; j++) prof.push([P.shaftR + 0.06, bz0 + (bz1 - bz0) * (j / (NP - 1))]);
  const bGeo = lathe(prof, NS);
  const bMesh = new THREE.Mesh(bGeo, mats.balloon);
  bMesh.renderOrder = 3;
  balloon.add(bMesh);
  // folded cuffs at each end
  balloon.add(new THREE.Mesh(zCyl(P.shaftR + 0.08, P.shaftR + 0.08, bz0 - 0.05, bz0 + 0.3, 40), mats.metal));
  balloon.add(new THREE.Mesh(zCyl(P.shaftR + 0.08, P.shaftR + 0.08, bz1 - 0.3, bz1 + 0.05, 40), mats.metal));

  /** Balloon radius at local z for inflation f ∈ [0,1]. */
  function balloonR(z, f) {
    const u = (z - P.balloonCenter) / P.balloonHalf;
    if (Math.abs(u) >= 1) return 0;
    const rs = P.shaftR + 0.06;
    const uu = Math.min(1, Math.abs(u) / 0.86);
    const shape = Math.pow(Math.max(0, 1 - uu * uu * uu), 0.55);
    const Rf = rs + (P.balloonMaxR - rs) * f;
    return rs + (Rf - rs) * shape;
  }
  let inflation = -1;
  function setInflation(f) {
    f = THREE.MathUtils.clamp(f, 0, 1);
    if (Math.abs(f - inflation) < 1e-4) return;
    inflation = f;
    const pos = bGeo.attributes.position;
    for (let i = 0; i <= NS; i++) {
      const phi = (i / NS) * Math.PI * 2;
      const s = Math.sin(phi), c = Math.cos(phi);
      for (let j = 0; j < NP; j++) {
        const z = prof[j][1];
        let r = Math.max(P.shaftR + 0.06, balloonR(z, f));
        r *= 1 + 0.05 * (1 - f) * Math.sin(phi * 7 + z * 0.8); // folds when deflated
        const idx = i * NP + j;
        // after rotateX(+90°): x = r sin, y = -r cos, z = z
        pos.setXYZ(idx, r * s, -r * c, z);
      }
    }
    pos.needsUpdate = true;
    bGeo.computeVertexNormals();
    bGeo.computeBoundingSphere();
    mats.balloon.opacity = 0.62 - 0.22 * f;
  }
  setInflation(0);

  // ---- atraumatic tip
  const tip = part('tip', 'Atraumatic tip');
  tip.add(new THREE.Mesh(lathe([[0.001, P.tipStart], [0.62, P.tipStart], [0.64, P.tipStart + 0.3], [0.62, P.tipStart + 0.6],
    [0.55, P.tipStart + 0.85], [0.42, P.tipStart + 1.05], [0.25, P.tipStart + 1.22], [0.001, P.tipZ]], 48), mats.white));
  const thread = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.04, 8, 40), mats.metal);
  thread.position.z = P.tipStart + 0.06;
  tip.add(thread);

  // ---- handle
  const handle = part('handle', 'Handle');
  const R = P.handleR;
  handle.add(new THREE.Mesh(lathe([
    [0.001, P.handleBack], [0.55, P.handleBack + 0.05], [0.95, P.handleBack + 0.2], [1.35, P.handleBack + 0.5],
    [1.6, P.handleBack + 1.0], [1.7, P.handleBack + 1.8], [1.7, P.handleBack + 3.1], [1.62, P.handleBack + 4.4],
    [R, -14.2], [R, -7.4], [1.58, -6.9], [1.45, -6.35], [1.15, -5.85], [0.85, -5.45], [0.7, -5.15], [0.64, P.handleNose],
  ], 72), mats.white));
  // soft-touch grip on the underside
  handle.add(new THREE.Mesh(zCyl(R + 0.04, R + 0.04, -18.4, -12.2, 48, true, -Math.PI * 0.6, Math.PI * 1.2), mats.grip));
  // button panel on the top
  handle.add(new THREE.Mesh(zCyl(R + 0.05, R + 0.05, -11.75, -7.2, 48, false, Math.PI * 0.8, Math.PI * 0.4), mats.panel));
  const buttons = P.buttons.map((b) => {
    const mat = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.35, emissive: b.color, emissiveIntensity: 0.05 });
    const capMat = new THREE.MeshStandardMaterial({ map: digitTexture(b.label, b.color), roughness: 0.35, emissive: '#ffffff', emissiveMap: null, emissiveIntensity: 0 });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.41, 0.32, 40), mat);
    body.position.y = 0.16;
    const capGeo = new THREE.CircleGeometry(0.38, 40);
    capGeo.rotateX(-Math.PI / 2); capGeo.rotateY(-Math.PI / 2); // digit reads upright from the side
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = 0.325;
    g.add(body, cap);
    const baseY = R + 0.02;
    g.position.set(0, baseY, b.z);
    handle.add(g);
    return { ...b, group: g, mat, capMat, baseY, topY: baseY + 0.325 };
  });
  // status LED window
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.32), mats.led);
  led.position.set(0, R + 0.08, P.ledZ);
  handle.add(led);

  // ---- inflation line + connector
  const line = part('line', 'Inflation line');
  line.add(new THREE.Mesh(zCyl(0.42, 0.42, P.handleBack - 1.0, P.handleBack + 0.05, 32), mats.metal));
  line.add(new THREE.Mesh(zCyl(0.32, 0.42, P.handleBack - 2.0, P.handleBack - 1.0, 32), mats.grip));
  const curve = new THREE.CatmullRomCurve3([
    [0, 0, P.handleBack - 1.8], [0, -0.3, P.handleBack - 3.6], [0, -2.6, P.handleBack - 6.0],
    [0.8, -8, P.handleBack - 8.3], [1.6, -18, P.handleBack - 9.4], [2.0, -40, P.handleBack - 10],
  ].map((p) => new THREE.Vector3(...p)));
  line.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 120, 0.24, 12, false), mats.tube));

  // grip anchor for the hand: on the handle axis, axes = probe axes
  const gripAnchor = new THREE.Object3D();
  gripAnchor.position.set(0, 0, P.gripZ);
  handle.add(gripAnchor);

  // ---- state helpers
  function setButton(i, press, glow) {
    const b = buttons[i];
    b.group.position.y = b.baseY - 0.16 * THREE.MathUtils.clamp(press, 0, 1);
    b.mat.emissiveIntensity = 0.05 + 0.9 * glow;
    b.capMat.emissiveIntensity = 0.0;
    b.capMat.emissive.set(b.color);
    b.capMat.emissiveIntensity = 0.55 * glow;
  }
  function setLED(color, intensity) {
    mats.led.emissive.set(color);
    mats.led.emissiveIntensity = intensity;
    mats.led.color.set(intensity > 0.05 ? color : '#111');
  }
  function setRedLineGlow(k) { mats.red.emissiveIntensity = 0.25 + 1.4 * k; }

  // exploded-view offsets for assembly (local cm) and spin (turns)
  const EXPLODE = {
    shaft: { off: new THREE.Vector3(0, 0, 0), spin: 0 },
    handle: { off: new THREE.Vector3(0, 2.5, -11), spin: 0 },
    balloon: { off: new THREE.Vector3(0, 4.5, 10), spin: 0 },
    tip: { off: new THREE.Vector3(0, 0, 7), spin: 2 },
    line: { off: new THREE.Vector3(0, -3, -9), spin: 0 },
  };
  /** a = per-part assembly progress 0..1 (0 = exploded & hidden, 1 = seated). */
  function setAssembly(a) {
    for (const id of Object.keys(parts)) {
      const k = THREE.MathUtils.clamp(a[id] ?? 1, 0, 1);
      const e = ease(k);
      const ex = EXPLODE[id];
      parts[id].position.copy(ex.off).multiplyScalar(1 - e);
      parts[id].rotation.set(0, 0, ex.spin * Math.PI * 2 * (1 - e));
      parts[id].visible = k > 0.001;
      const sc = id === 'shaft' ? 0.6 + 0.4 * e : 1;
      parts[id].scale.setScalar(sc);
    }
  }

  return {
    group, parts, buttons, gripAnchor, redLine, mats,
    setInflation, setButton, setLED, setRedLineGlow, setAssembly, balloonR,
    get inflation() { return inflation; },
    localPoint: (x, y, z) => group.localToWorld(new THREE.Vector3(x, y, z)),
  };
}
