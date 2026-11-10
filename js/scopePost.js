// Post-processing for the laparoscope monitor: barrel distortion, circular optic,
// chromatic fringing, sensor grain, tissue "red-out" on contact, lens fogging,
// blood in the field, and procedural tissue when the tip is inside the abdominal wall.
import * as THREE from 'three';

const frag = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uRes;
uniform float uTime;
uniform float uLayerMix;
uniform float uLayerType;   // 0 skin surface, 1 skin, 2 fat, 3 fascia, 4 muscle, 5 preperitoneal fat, 6 peritoneum
uniform float uLayerDepth;
uniform float uContact;
uniform vec3 uContactCol;
uniform float uFog;
uniform float uBlood;
uniform float uBright;
varying vec2 vUv;

float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; } return v; }
vec2 voro(vec2 p){ vec2 n=floor(p), f=fract(p); float md=8.0, md2=8.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g=vec2(float(i),float(j)); vec2 o=vec2(hash(n+g), hash(n+g+17.1));
    vec2 r=g+o-f; float d=dot(r,r); if(d<md){ md2=md; md=d; } else if(d<md2){ md2=d; } }
  return vec2(sqrt(md), sqrt(md2)); }

vec3 tissue(vec2 p, float t){
  float d = uLayerDepth;
  vec2 q = p * (3.0 + d * 0.6) + vec2(0.0, d * 0.8);
  float n = fbm(q*1.7 + uTime*0.02);
  if (t < 0.5) {           // skin surface, lit from the scope
    vec3 c = mix(vec3(0.7,0.48,0.38), vec3(0.55,0.34,0.27), n);
    c *= 0.8 + 0.35*fbm(q*14.0);
    float crease = smoothstep(0.03, 0.0, abs(fbm(q*0.7) - 0.5));
    c *= 1.0 - 0.35*crease;
    return c;
  } else if (t < 1.5) {    // dermis
    return mix(vec3(0.55,0.22,0.18), vec3(0.72,0.38,0.3), n);
  } else if (t < 2.5) {    // subcutaneous fat lobules
    vec2 v = voro(q*3.2);
    float edge = smoothstep(0.0, 0.09, v.y - v.x);
    vec3 c = mix(vec3(0.78,0.52,0.12), vec3(0.92,0.7,0.26), n);
    c = mix(vec3(0.5,0.16,0.08), c, edge);
    c += 0.18*pow(max(0.0, 1.0 - v.x*1.4), 5.0);
    float ves = smoothstep(0.035, 0.0, abs(fbm(q*0.9) - 0.5));
    c = mix(c, vec3(0.45,0.05,0.04), ves*0.7);
    return c * 0.8;
  } else if (t < 3.5) {    // fascia: glistening white fibres
    float s = fbm(vec2(q.x*0.6, q.y*9.0));
    return mix(vec3(0.62,0.58,0.54), vec3(0.85,0.83,0.78), s) * (0.8 + 0.3*n);
  } else if (t < 4.5) {    // muscle striations
    float s = 0.5 + 0.5*sin(q.y*26.0 + fbm(q*3.0)*6.0);
    return mix(vec3(0.45,0.08,0.06), vec3(0.72,0.2,0.16), s) * (0.75 + 0.4*n);
  } else if (t < 5.5) {    // pre-peritoneal fat
    vec2 v = voro(q*2.6);
    float edge = smoothstep(0.0, 0.1, v.y - v.x);
    return mix(vec3(0.6,0.3,0.15), mix(vec3(0.85,0.66,0.3), vec3(0.92,0.78,0.45), n), edge) * 0.85;
  }
  return mix(vec3(0.75,0.55,0.5), vec3(0.85,0.68,0.62), n); // peritoneum (translucent)
}

void main(){
  float aspect = uRes.x / uRes.y;
  vec2 c = vUv - 0.5; c.x *= aspect;
  float r = length(c);
  vec2 cd = c * (1.0 + 0.16 * r * r);
  vec2 suv = vec2(cd.x / aspect, cd.y) + 0.5;

  vec2 dirv = normalize(c + 1e-5);
  float ca = 0.004 * r * r;
  vec3 col;
  float blurR = uContact * 0.012 + uFog * 0.01;
  if (blurR > 0.0005) {
    col = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7854;
      col += texture2D(tScene, suv + vec2(cos(a), sin(a)) * blurR).rgb;
    }
    col /= 8.0;
  } else {
    col.r = texture2D(tScene, suv + dirv * ca).r;
    col.g = texture2D(tScene, suv).g;
    col.b = texture2D(tScene, suv - dirv * ca).b;
  }
  col *= uBright;

  // Tissue layers while the tip travels through the abdominal wall
  if (uLayerMix > 0.0) {
    vec3 tc = tissue(cd, uLayerType);
    float lit = 1.25 - 0.9 * r;
    if (uLayerType > 5.5) {
      col = mix(col, tc * lit, 0.6 * uLayerMix);
    } else {
      col = mix(col, tc * lit * (uLayerType < 0.5 ? 1.0 : 0.85), uLayerMix);
    }
  }

  // Red-out: lens pressed into tissue
  if (uContact > 0.0) {
    float n = fbm(cd*4.0 + uTime*0.15);
    vec3 cc = uContactCol * (1.2 + 0.5*n) * (1.2 - 0.6*r);
    cc += vec3(0.25,0.1,0.08) * pow(max(0.0, 1.0 - r*2.2), 2.0);
    col = mix(col, cc, clamp(uContact, 0.0, 1.0));
  }

  // Blood in the field absorbs light and tints everything red
  if (uBlood > 0.0) {
    float n = fbm(cd*3.0 + vec2(0.0, uTime*0.05));
    float pool = smoothstep(0.35, 0.75, n + uBlood*0.6 - 0.25 + cd.y*0.4);
    vec3 bl = vec3(0.35, 0.02, 0.02) * (0.6 + 0.6*n);
    col = mix(col, col * vec3(1.0, 0.45, 0.4), uBlood * 0.6);
    col = mix(col, bl, pool * uBlood);
  }

  // Lens fogging (cold scope in warm, humid cavity)
  if (uFog > 0.0) {
    float n = fbm(cd*6.0);
    col = mix(col, vec3(0.78, 0.74, 0.72) + 0.1*n, uFog * (0.55 + 0.35*n));
  }

  // Vignette + circular optic
  col *= 1.0 - 0.55 * smoothstep(0.18, 0.56, r);
  float mask = smoothstep(0.565, 0.548, r);
  col *= mask;
  // sensor noise
  col += (hash(vUv*uRes + fract(uTime)*91.7) - 0.5) * 0.025 * mask;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const vert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export function createScopePost() {
  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const material = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      tScene: { value: target.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uLayerMix: { value: 0 },
      uLayerType: { value: 0 },
      uLayerDepth: { value: 0 },
      uContact: { value: 0 },
      uContactCol: { value: new THREE.Color() },
      uFog: { value: 0 },
      uBlood: { value: 0 },
      uBright: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    target, material, scene, camera, uniforms: material.uniforms,
    setSize(w, h) {
      if (target.width !== w || target.height !== h) target.setSize(w, h);
      material.uniforms.uRes.value.set(w, h);
    },
  };
}
