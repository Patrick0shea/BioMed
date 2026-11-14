// Gloved right hand (WebXR "generic-hand" model, MIT) posed procedurally to grip a
// cylindrical handle and press buttons along its top with the thumb.
//
// The model's joints are flat children of the armature (WebXR convention: -Z points along
// the bone toward the tip, +Y is dorsal, flexion = negative rotation about local +X), so
// we run our own forward kinematics and write every joint's transform each frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const FSEG = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
const TSEG = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
const FINGER_R = [0.86, 0.9, 0.84, 0.76];   // finger half-thickness, cm
const THUMB_R = 0.95;
const DEG = Math.PI / 180;
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

class Chain {
  constructor(names, byName) {
    this.joints = names.map((n) => {
      const j = byName[n];
      if (!j) throw new Error(`hand joint missing: ${n}`);
      return j;
    });
    this.p = this.joints.map((j) => j.position.clone().multiplyScalar(100)); // work in cm
    this.q = this.joints.map((j) => j.quaternion.clone());
    this.rel = []; this.off = [];
    for (let i = 1; i < this.p.length; i++) {
      const inv = this.q[i - 1].clone().invert();
      this.rel[i] = inv.clone().multiply(this.q[i]);
      this.off[i] = this.p[i].clone().sub(this.p[i - 1]).applyQuaternion(inv);
    }
    this.P = this.p.map((v) => v.clone());
    this.Q = this.q.map((v) => v.clone());
  }
  fk(locals) {
    const { P, Q } = this;
    P[0].copy(this.p[0]); Q[0].copy(this.q[0]);
    if (locals[0]) Q[0].multiply(locals[0]);
    for (let i = 1; i < P.length; i++) {
      P[i].copy(this.off[i]).applyQuaternion(Q[i - 1]).add(P[i - 1]);
      Q[i].copy(Q[i - 1]).multiply(this.rel[i]);
      if (locals[i]) Q[i].multiply(locals[i]);
    }
    return this;
  }
  write() {
    this.joints.forEach((j, i) => { j.position.copy(this.P[i]).multiplyScalar(0.01); j.quaternion.copy(this.Q[i]); });
  }
}

const qx = (a) => new THREE.Quaternion().setFromAxisAngle(AX, a);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();

/**
 * @param {object} o
 * @param {string} o.url        GLB url
 * @param {number} o.handleR    handle radius (cm)
 * @param {number} o.topAngle   where the thumb lies around the handle (deg, 0 = straight away from the palm)
 */
export async function loadGripHand({ url, handleR = 1.6, topAngle = 90, gloveColor = '#7ea6dc' }) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const byName = {};
  let skinned = null;
  model.traverse((o) => { byName[o.name] = o; if (o.isSkinnedMesh) skinned = o; });
  const glove = new THREE.MeshPhysicalMaterial({
    color: gloveColor, roughness: 0.55, side: THREE.DoubleSide, sheen: 0.6, sheenColor: new THREE.Color('#d6e6ff'), sheenRoughness: 0.5,
  });
  skinned.material = glove;
  skinned.frustumCulled = false;

  const fingers = FINGERS.map((f) => new Chain(FSEG.map((s) => `${f}-${s}`), byName));
  const thumb = new Chain(TSEG, byName);
  const wrist = byName.wrist.position.clone().multiplyScalar(100);

  // ---------- grip frame (armature space, cm) ----------
  const K = fingers.map((c) => c.p[1]);
  const Kmid = K.reduce((a, b) => a.clone().add(b)).multiplyScalar(0.25);
  const U = K[0].clone().sub(K[3]).normalize();                 // along the handle, toward the index side (distal)
  const F = fingers.reduce((a, c) => a.add(c.p[2].clone().sub(c.p[1])), new THREE.Vector3()).normalize();
  const Pm = new THREE.Vector3().crossVectors(U, F).normalize();  // palmar
  const F2 = new THREE.Vector3().crossVectors(Pm, U).normalize(); // finger direction ⟂ U
  const R = handleR;
  const C = Kmid.clone().addScaledVector(Pm, R + 1.45).addScaledVector(F2, -0.35);
  // "top" of the handle (button row): rotate from the wrist side (-F2) toward the palm-opposite side (+Pm)
  const ta = topAngle * DEG;
  const T = F2.clone().multiplyScalar(-Math.cos(ta)).addScaledVector(Pm, Math.sin(ta)).normalize();
  const Xg = new THREE.Vector3().crossVectors(T, U).normalize();
  const basis = new THREE.Matrix4().makeBasis(Xg, T, U);          // grip-frame → armature rotation
  const qBasis = new THREE.Quaternion().setFromRotationMatrix(basis);
  const toArm = (pAnchor) => pAnchor.clone().applyQuaternion(qBasis).add(C);
  const distAxis = (p) => { _v1.copy(p).sub(C); const a = _v1.dot(U); return _v2.copy(_v1).addScaledVector(U, -a).length(); };

  // ---------- fit each finger around the handle ----------
  const fitted = fingers.map((ch, fi) => {
    const rf = FINGER_R[fi];
    let best = null;
    const L = [null, null, null, null, null];
    for (let a1 = 0; a1 <= 100; a1 += 3) for (let a2 = 0; a2 <= 110; a2 += 3) for (let a3 = 0; a3 <= 80; a3 += 4) {
      L[1] = qx(-a1 * DEG); L[2] = qx(-a2 * DEG); L[3] = qx(-a3 * DEG);
      ch.fk(L);
      let e = 0;
      for (let i = 2; i <= 4; i++) {
        const want = R + (i === 4 ? rf * 0.7 : rf);
        const d = distAxis(ch.P[i]);
        e += (d - want) ** 2;
        if (d < R + rf * 0.75) e += 30 * (R + rf * 0.75 - d) ** 2;
        const m = _v1.copy(ch.P[i]).add(ch.P[i - 1]).multiplyScalar(0.5);
        const dm = distAxis(m);
        e += 0.6 * (dm - (R + rf)) ** 2;
        if (dm < R + rf * 0.8) e += 30 * (R + rf * 0.8 - dm) ** 2;
      }
      e += 0.00002 * (a1 + a2 + a3);
      if (!best || e < best.e) best = { e, a: [a1, a2, a3] };
    }
    return best.a;
  });
  const OPEN = [[6, 8, 4], [6, 8, 4], [6, 8, 4], [8, 10, 4]];
  const SPREAD = [-4, 0, 3, 7];

  // ---------- thumb ----------
  const LIM = [[-45, 75], [-60, 60], [-45, 45], [-15, 85], [-25, 95]];
  const thumbLocals = (x) => {
    _qa.setFromAxisAngle(AY, x[1] * DEG);
    _qb.setFromAxisAngle(AX, -x[0] * DEG);
    _qc.setFromAxisAngle(AZ, x[2] * DEG);
    return [_qa.clone().multiply(_qb).multiply(_qc), qx(-x[3] * DEG), qx(-x[4] * DEG), null];
  };
  const pad = new THREE.Vector3(), padN = new THREE.Vector3();
  const thumbFK = (x) => {
    thumb.fk(thumbLocals(x));
    const P = thumb.P, Q = thumb.Q;
    padN.set(0, -1, 0).applyQuaternion(Q[2]);
    pad.copy(P[2]).lerp(P[3], 0.55).addScaledVector(padN, 0.62);
    return thumb;
  };
  const Tarm = T;
  function thumbCost(x, target, x0) {
    thumbFK(x);
    const P = thumb.P;
    let e = 12 * pad.distanceToSquared(target);
    e += 3 * (1 + padN.dot(Tarm)) ** 2;
    for (let i = 0; i < 5; i++) e += 0.004 * ((x[i] - x0[i]) / 10) ** 2;
    const pts = [P[1], P[2], P[3], _v1.copy(P[1]).add(P[2]).multiplyScalar(0.5)];
    for (const p of pts) {
      const d = distAxis(p);
      const a = _v2.copy(p).sub(C).dot(U);
      if (a > -9 && a < 9 && d < R + THUMB_R) e += 40 * (R + THUMB_R - d) ** 2;
    }
    return e;
  }
  function solveThumb(targetAnchor, start) {
    const target = toArm(targetAnchor);
    const x = start.slice();
    const x0 = [10, 0, 0, 20, 20];
    let e = thumbCost(x, target, x0);
    for (let step = 16; step > 0.05; step *= 0.5) {
      let improved = true, guard = 0;
      while (improved && guard++ < 60) {
        improved = false;
        for (let i = 0; i < 5; i++) for (const dir of [1, -1]) {
          const old = x[i];
          x[i] = THREE.MathUtils.clamp(old + dir * step, LIM[i][0], LIM[i][1]);
          const e2 = thumbCost(x, target, x0);
          if (e2 < e - 1e-9) { e = e2; improved = true; } else x[i] = old;
        }
      }
    }
    thumbFK(x);
    return { x, err: pad.distanceTo(target) };
  }

  // ---------- scene graph ----------
  // anchor (provided by the probe) ⟶ approach ⟶ model (armature space, scaled to cm)
  const approach = new THREE.Group();
  const root = new THREE.Group();
  root.add(approach);
  approach.add(model);
  model.scale.setScalar(100);
  const qInv = qBasis.clone().invert();
  model.quaternion.copy(qInv);
  model.position.copy(C).applyQuaternion(qInv).multiplyScalar(-1);
  // armature-space cm ⇄ model children are in metres, so cuff/sleeve go in a cm-scaled holder
  const extras = new THREE.Group();
  extras.scale.setScalar(0.01);
  model.add(extras);
  {
    const armDir = wrist.clone().sub(Kmid).normalize();
    const side = U.clone().addScaledVector(armDir, -U.dot(armDir)).normalize();
    const n = new THREE.Vector3().crossVectors(side, armDir).normalize();
    const m = new THREE.Matrix4().makeBasis(side, armDir, n);
    const cuffGeo = new THREE.CylinderGeometry(1, 1.16, 9, 40, 1, true);
    cuffGeo.scale(2.75, 1, 1.85);
    const cuff = new THREE.Mesh(cuffGeo, glove);
    cuff.quaternion.setFromRotationMatrix(m);
    cuff.position.copy(wrist).addScaledVector(armDir, 3.4);
    extras.add(cuff);
  }

  const toAnchorDir = (vArm) => vArm.clone().applyQuaternion(qInv);
  const dorsalAnchor = toAnchorDir(Pm.clone().negate());
  const wristAnchor = toAnchorDir(F2.clone().negate());

  // precomputed thumb poses (targets in the anchor frame, cm)
  const poses = {};
  const REST_GUESS = [15, 0, 0, 20, 15];
  function buildPoses(buttonTargets, restTarget) {
    poses.rest = solveThumb(restTarget, REST_GUESS).x;
    buttonTargets.forEach((b, i) => {
      poses[`hover${i}`] = solveThumb(b.hover, poses.rest).x;
      poses[`press${i}`] = solveThumb(b.press, poses[`hover${i}`]).x;
    });
    poses.open = poses.rest.map((v, i) => v + [-18, 22, 0, -18, -20][i]);
    return poses;
  }

  const mixArr = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  /**
   * @param {object} s
   * @param {number} s.approach  0 = away from the handle, 1 = in place
   * @param {number} s.grip      0 = open hand, 1 = fingers wrapped
   * @param {number[]} s.thumb   thumb parameters (from poses / mixes)
   */
  function setPose({ approach: ap = 1, grip = 1, thumb: tx = poses.rest }) {
    const k = 1 - ap;
    approach.position.copy(dorsalAnchor).multiplyScalar(9 * k).addScaledVector(wristAnchor, 6 * k);
    approach.position.y += 4 * k;
    fingers.forEach((ch, fi) => {
      const a = OPEN[fi].map((o, j) => o + (fitted[fi][j] - o) * grip);
      ch.fk([null, qx(-a[0] * DEG).multiply(new THREE.Quaternion().setFromAxisAngle(AY, SPREAD[fi] * (1 - grip) * DEG)),
        qx(-a[1] * DEG), qx(-a[2] * DEG), null]).write();
    });
    const t = tx ? mixArr(poses.open, tx, grip) : poses.open;
    thumbFK(t); thumb.write();
  }

  return {
    root, model, glove, poses, buildPoses, setPose, mixArr, solveThumb, fitted,
    debug: { C, U, T, Pm, F2 },
  };
}
