// Procedural, tileable tissue textures drawn on canvas.
// Each texture produces a colour map and a matching bump map.
import * as THREE from 'three';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexA(hex, a) {
  const c = new THREE.Color(hex);
  return `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${a})`;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Draw `fn` at (x,y) plus wrapped copies so the canvas tiles seamlessly.
 */
function tiled(ctx, size, x, y, r, fn) {
  for (let ox = -size; ox <= size; ox += size) {
    if (x + ox + r < 0 || x + ox - r > size) continue;
    for (let oy = -size; oy <= size; oy += size) {
      if (y + oy + r < 0 || y + oy - r > size) continue;
      ctx.save();
      ctx.translate(ox, oy);
      fn(ctx);
      ctx.restore();
    }
  }
}

function genVessel(rnd, x, y, ang, width, len, depth, curl, out) {
  let px = x, py = y;
  const step = 5;
  const steps = Math.max(3, (len / step) | 0);
  for (let s = 0; s < steps; s++) {
    ang += (rnd() - 0.5) * curl;
    const nx = px + Math.cos(ang) * step;
    const ny = py + Math.sin(ang) * step;
    out.push({ x1: px, y1: py, x2: nx, y2: ny, w: width });
    px = nx; py = ny;
    width *= 0.988;
    if (depth > 0 && rnd() < 0.11) {
      const side = rnd() < 0.5 ? -1 : 1;
      genVessel(rnd, px, py, ang + side * (0.5 + rnd() * 0.7), width * 0.62, len * 0.5, depth - 1, curl, out);
    }
  }
}

export function makeTissue(opts) {
  const {
    size = 512, seed = 1, base = '#c88',
    mottle = [], mottleCount = 60, mottleAlpha = 0.18, mottleSize = [20, 90],
    vessels = null, blobs = null, stripes = [], speckle = null,
    repeat = [1, 1], blur = 1.5,
  } = opts;
  const rnd = mulberry32(seed);
  const col = document.createElement('canvas');
  col.width = col.height = size;
  const bmp = document.createElement('canvas');
  bmp.width = bmp.height = size;
  const c = col.getContext('2d');
  const b = bmp.getContext('2d');
  c.fillStyle = base; c.fillRect(0, 0, size, size);
  b.fillStyle = '#808080'; b.fillRect(0, 0, size, size);

  // Large-scale mottling
  for (let i = 0; i < mottleCount && mottle.length; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = lerp(mottleSize[0], mottleSize[1], rnd());
    const color = mottle[i % mottle.length];
    const a = mottleAlpha * (0.4 + rnd() * 0.6);
    const g = rnd() < 0.5 ? 255 : 0;
    tiled(c, size, x, y, r, (ctx) => {
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, hexA(color, a));
      gr.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    });
    tiled(b, size, x, y, r, (ctx) => {
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${g},${g},${g},0.12)`);
      gr.addColorStop(1, `rgba(${g},${g},${g},0)`);
      ctx.fillStyle = gr; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    });
  }

  // Fine speckle (e.g. hepatic lobules)
  if (speckle) {
    const { count = 3000, colors = ['#000'], alpha = 0.15, r: rr = [0.8, 2.2] } = speckle;
    for (let i = 0; i < count; i++) {
      const x = rnd() * size, y = rnd() * size, r = lerp(rr[0], rr[1], rnd());
      const color = colors[(rnd() * colors.length) | 0];
      c.fillStyle = hexA(color, alpha * (0.5 + rnd() * 0.5));
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      const g = rnd() < 0.5 ? 200 : 60;
      b.fillStyle = `rgba(${g},${g},${g},0.25)`;
      b.beginPath(); b.arc(x, y, r, 0, Math.PI * 2); b.fill();
    }
  }

  // Fat lobules / blobs
  if (blobs) {
    const { count = 120, colors = ['#e8c860'], r: rr = [4, 14], alpha = 0.85, outline = 'rgba(120,80,20,0.1)' } = blobs;
    for (let i = 0; i < count; i++) {
      const x = rnd() * size, y = rnd() * size, r = lerp(rr[0], rr[1], rnd());
      const color = colors[(rnd() * colors.length) | 0];
      tiled(c, size, x, y, r + 2, (ctx) => {
        const gr = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
        gr.addColorStop(0, hexA('#fff0c0', alpha * 0.35));
        gr.addColorStop(0.45, hexA(color, alpha * 0.9));
        gr.addColorStop(0.85, hexA(color, alpha * 0.6));
        gr.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 0.6; ctx.stroke(); }
      });
      tiled(b, size, x, y, r, (ctx) => {
        const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(230,230,230,0.9)');
        gr.addColorStop(1, 'rgba(100,100,100,0.6)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      });
    }
  }

  // Stripes (e.g. taenia coli)
  for (const s of stripes) {
    const y = s.y * size, h = s.w * size;
    const gr = c.createLinearGradient(0, y - h, 0, y + h);
    gr.addColorStop(0, hexA(s.color, 0));
    gr.addColorStop(0.5, hexA(s.color, s.alpha ?? 0.7));
    gr.addColorStop(1, hexA(s.color, 0));
    c.fillStyle = gr; c.fillRect(0, y - h, size, 2 * h);
    const gb = b.createLinearGradient(0, y - h, 0, y + h);
    gb.addColorStop(0, 'rgba(200,200,200,0)');
    gb.addColorStop(0.5, 'rgba(200,200,200,0.7)');
    gb.addColorStop(1, 'rgba(200,200,200,0)');
    b.fillStyle = gb; b.fillRect(0, y - h, size, 2 * h);
  }

  // Branching blood vessels
  if (vessels) {
    const { count = 6, color = '#7a1010', width = [2, 5], len = [120, 300], depth = 3, alpha = 0.65,
      dir = null, curl = 0.45 } = vessels;
    const segs = [];
    for (let i = 0; i < count; i++) {
      const ang = dir == null ? rnd() * Math.PI * 2 : dir + (rnd() - 0.5) * 0.3;
      genVessel(rnd, rnd() * size, rnd() * size, ang, lerp(width[0], width[1], rnd()),
        lerp(len[0], len[1], rnd()), depth, curl, segs);
    }
    for (const sg of segs) {
      const mx = (sg.x1 + sg.x2) / 2, my = (sg.y1 + sg.y2) / 2;
      const wx = ((mx % size) + size) % size - mx;
      const wy = ((my % size) + size) % size - my;
      const x1 = sg.x1 + wx, y1 = sg.y1 + wy, x2 = sg.x2 + wx, y2 = sg.y2 + wy;
      const draw = (ctx, style, w) => {
        ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      };
      tiled(c, size, mx + wx, my + wy, 8 + sg.w, (ctx) => {
        draw(ctx, hexA(color, alpha * 0.35), sg.w * 1.9);
        draw(ctx, hexA(color, alpha), sg.w);
      });
      tiled(b, size, mx + wx, my + wy, 8 + sg.w, (ctx) => draw(ctx, 'rgba(210,210,210,0.8)', sg.w * 1.2));
    }
  }

  if (blur > 0) {
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = size;
    const t = tmp.getContext('2d');
    t.filter = `blur(${blur}px)`;
    t.drawImage(bmp, 0, 0);
    b.clearRect(0, 0, size, size);
    b.drawImage(tmp, 0, 0);
  }

  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  const bumpMap = new THREE.CanvasTexture(bmp);
  for (const t of [map, bumpMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = 8;
  }
  return { map, bumpMap, canvas: col };
}

// Library of tissue presets.
export const TISSUE = {
  liver: { base: '#8a3024', mottle: ['#5a1810', '#a8483a', '#6e2218'], mottleCount: 90, mottleAlpha: 0.35,
    speckle: { count: 5000, colors: ['#2e0806', '#9a4a3a'], alpha: 0.18, r: [0.6, 1.8] }, repeat: [2, 2], seed: 11 },
  gallbladder: { base: '#5d7d47', mottle: ['#3f5f3a', '#8aa060', '#6d6a3a'], mottleCount: 50, mottleAlpha: 0.35,
    vessels: { count: 5, color: '#8a2420', width: [1.5, 3], len: [160, 300], depth: 3, alpha: 0.7 }, seed: 12 },
  stomach: { base: '#d08476', mottle: ['#b05c52', '#e8a89a', '#c27060'], mottleCount: 70, mottleAlpha: 0.3,
    vessels: { count: 7, color: '#7a1414', width: [2, 4.5], len: [150, 320], depth: 3, alpha: 0.7 }, seed: 13 },
  spleen: { base: '#6e2c40', mottle: ['#4a1a2c', '#8a4a60'], mottleCount: 60, mottleAlpha: 0.35,
    speckle: { count: 2500, colors: ['#2a0a16', '#8a4a60'], alpha: 0.15 }, seed: 14 },
  smallBowel: { base: '#e29a8a', mottle: ['#c87264', '#f0b8a8', '#d48878'], mottleCount: 70, mottleAlpha: 0.3,
    vessels: { count: 26, color: '#8a1818', width: [1.2, 2.6], len: [80, 200], depth: 1, alpha: 0.6, dir: Math.PI / 2, curl: 0.25 },
    seed: 15 },
  colon: { base: '#cf9580', mottle: ['#b8735f', '#e2b29e', '#c4846e'], mottleCount: 60, mottleAlpha: 0.3,
    stripes: [{ y: 0.18, w: 0.025, color: '#f7e6d8', alpha: 0.8 }, { y: 0.52, w: 0.025, color: '#f7e6d8', alpha: 0.8 }],
    blobs: { count: 18, colors: ['#e9c25a', '#f0cf6a'], r: [5, 11], alpha: 0.9 },
    vessels: { count: 14, color: '#8a2020', width: [1, 2.2], len: [60, 150], depth: 1, alpha: 0.5, dir: Math.PI / 2, curl: 0.3 },
    seed: 16 },
  omentum: { base: '#cf9f38', mottle: ['#c99a30', '#f2d478', '#d8a848'], mottleCount: 60, mottleAlpha: 0.35,
    blobs: { count: 520, colors: ['#e0b247', '#ebc45c', '#d29e38'], r: [4, 11], alpha: 0.85, outline: 'rgba(140,80,20,0.12)' },
    vessels: { count: 9, color: '#9a1e18', width: [1.5, 3.5], len: [160, 320], depth: 3, alpha: 0.65 },
    repeat: [2, 2], seed: 17 },
  peritoneum: { base: '#e3afa2', mottle: ['#cf8f82', '#f2cbbf', '#e0a090', '#e9c27a'], mottleCount: 90, mottleAlpha: 0.3,
    vessels: { count: 10, color: '#a32a24', width: [1, 2.6], len: [150, 320], depth: 3, alpha: 0.55 },
    repeat: [6, 4], seed: 18 },
  bladder: { base: '#d6b19c', mottle: ['#c09080', '#ead0c0'], mottleCount: 50, mottleAlpha: 0.3,
    vessels: { count: 6, color: '#8a2a24', width: [1, 2.5], len: [120, 260], depth: 2, alpha: 0.5 }, seed: 19 },
  aorta: { base: '#b8655a', mottle: ['#a04a40', '#d89080', '#e8c070'], mottleCount: 50, mottleAlpha: 0.3, seed: 20 },
  ivc: { base: '#6f6890', mottle: ['#4f4a78', '#9890b0', '#e0b070'], mottleCount: 50, mottleAlpha: 0.3, seed: 21 },
  falciform: { base: '#e6c27a', mottle: ['#d8a860', '#f0d8a0', '#e0a090'], mottleCount: 40, mottleAlpha: 0.3,
    blobs: { count: 80, colors: ['#ecc868'], r: [4, 9], alpha: 0.6 }, seed: 22 },
};
