/**
 * Sky dome and the lighting it implies. One slow day/night cycle drives the
 * sun or moon direction, light colours, fog and exposure, so the glade's mood
 * changes without ever losing the creature's readability.
 */
import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../core/math';
import { nightFactor, sunHeight } from '../sim/world';

interface Key { t: number; zenith: number; horizon: number; sun: number; ambientSky: number; ambientGround: number; fog: number }

// keyed by sun height (-1 midnight … 0 horizon … 1 noon)
const KEYS: Key[] = [
  { t: -1.0, zenith: 0x070d1c, horizon: 0x14233a, sun: 0x8fb0ff, ambientSky: 0x2a3d66, ambientGround: 0x10161c, fog: 0x101c2c },
  { t: -0.25, zenith: 0x0c1730, horizon: 0x263a56, sun: 0x9db8ff, ambientSky: 0x34497a, ambientGround: 0x141c22, fog: 0x18283a },
  { t: 0.0, zenith: 0x2c3f72, horizon: 0xf0976a, sun: 0xff9a5c, ambientSky: 0x7a6f9c, ambientGround: 0x3a2c28, fog: 0x8f6f72 },
  { t: 0.22, zenith: 0x4f83c4, horizon: 0xf4d6a8, sun: 0xffd9a0, ambientSky: 0x9fb8dc, ambientGround: 0x4a4230, fog: 0xb9c2ae },
  { t: 1.0, zenith: 0x5a9bdc, horizon: 0xd9ecde, sun: 0xfff3dc, ambientSky: 0xb8d0ee, ambientGround: 0x56503a, fog: 0xc2d6c8 },
];

const ca = new THREE.Color(), cb = new THREE.Color();
function keyed(h: number, field: keyof Omit<Key, 't'>, out: THREE.Color): THREE.Color {
  let i = 0;
  while (i < KEYS.length - 2 && h > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const u = clamp01((h - a.t) / (b.t - a.t));
  return out.copy(ca.setHex(a[field])).lerp(cb.setHex(b[field]), u);
}

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  readonly fill = new THREE.DirectionalLight(0x9fb4ff, 0.3);
  readonly fog = new THREE.FogExp2(0x9fb0a0, 0.028);
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  night = 0;
  exposure = 1;
  private uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };

  constructor(scene: THREE.Scene, shadowSize: number) {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * p;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
        uniform float uNight, uTime;
        varying vec3 vDir;
        float hash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -0.2, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.75, h), 0.7));
          float s = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.22 + pow(s, 3.0) * 0.08) * (1.0 - uNight * 0.5);
          // stars: sparse, softly twinkling, only on a clear dark sky
          vec3 g = floor(d * 180.0);
          float st = hash(g);
          float star = smoothstep(0.9965, 1.0, st) * (0.6 + 0.4 * sin(uTime * (1.0 + st * 3.0) + st * 40.0));
          col += vec3(0.85, 0.9, 1.0) * star * uNight * smoothstep(0.05, 0.35, d.y);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);

    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(shadowSize, shadowSize);
    const c = s.shadow.camera;
    c.left = -11; c.right = 11; c.top = 11; c.bottom = -11; c.near = 1; c.far = 60;
    s.shadow.bias = -0.0004;
    s.shadow.normalBias = 0.02;
    s.shadow.radius = 3;
    scene.add(s, s.target, this.hemi, this.fill);
    scene.fog = this.fog;
  }

  setShadowSize(size: number): void {
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  update(dayTime: number, time: number, focus: THREE.Vector3): void {
    const h = sunHeight(dayTime);
    const night = nightFactor(dayTime);
    this.night = night;
    const u = this.uniforms;
    keyed(h, 'zenith', u.uZenith.value);
    keyed(h, 'horizon', u.uHorizon.value);
    keyed(h, 'sun', u.uSunColor.value);
    u.uNight.value = night;
    u.uTime.value = time;

    // the sun arcs east → west, leaning toward the viewer so faces stay lit;
    // after dusk the same light becomes the moon, from the other side
    const ang = (dayTime - 0.25) * Math.PI * 2;
    const day = h > -0.06;
    const el = day ? Math.max(h, 0.1) : Math.max(-h, 0.3);
    const az = day ? Math.cos(ang) : -Math.cos(ang) * 0.7;
    this.sunDir.set(az * 0.9, el * 1.1, 0.5).normalize();
    u.uSunDir.value.set(Math.cos(ang) * 0.9, h, 0.45).normalize();
    if (!day) u.uSunDir.value.set(-Math.cos(ang) * 0.9, -h, 0.45).normalize();

    // intensity dips through twilight, hiding the hand-over between sun and moon
    const sunI = smoothstep(-0.04, 0.3, h) * 2.9;
    const moonI = smoothstep(0.02, -0.3, h) * 0.75;
    this.sun.intensity = sunI + moonI;
    this.sun.color.copy(u.uSunColor.value);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 26);
    this.sun.target.position.copy(focus);
    keyed(h, 'ambientSky', this.hemi.color);
    keyed(h, 'ambientGround', this.hemi.groundColor);
    this.hemi.intensity = lerp(0.95, 1.25, clamp01(h)) + 0.25 * night;
    this.fill.position.set(-this.sunDir.x, 0.6, -0.8).normalize().multiplyScalar(10);
    this.fill.color.copy(this.hemi.color);
    this.fill.intensity = 0.28 + 0.2 * night;
    keyed(h, 'fog', this.fog.color);
    this.fog.density = lerp(0.024, 0.034, night);
    this.exposure = lerp(1.0, 1.22, night);
  }
}
