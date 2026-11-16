/**
 * Surface treatment for the Kinling: a velvety skin, layered shell fur with
 * per-region strand length, wet-looking eyes with a controllable pupil, and
 * the inner-lit tail lantern. All are standard three.js physical materials
 * extended in place, so they keep scene lighting, fog and shadows.
 */
import * as THREE from 'three';
import type { Coat } from './build';

export interface FurUniforms {
  uFurLength: { value: number };
  uDensity: { value: number };
  uSway: { value: THREE.Vector3 };
  uGlow: { value: number };
  uGlowColor: { value: THREE.Color };
}

/**
 * The scene renders to a float buffer and is then bloomed, so a single
 * non-finite or negative pixel would smear across the whole frame. Every
 * creature material ends with this guard (comparisons with NaN are false).
 */
const GUARD = /* glsl */ `#include <opaque_fragment>
if (!(gl_FragColor.r >= 0.0 && gl_FragColor.g >= 0.0 && gl_FragColor.b >= 0.0)) gl_FragColor.rgb = diffuseColor.rgb * 0.25;
gl_FragColor.rgb = min(gl_FragColor.rgb, vec3(14.0));`;
const guard = (fragment: string): string => fragment.replace('#include <opaque_fragment>', GUARD);

const HASH = /* glsl */ `
float kHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`;

export function createSkinMaterial(coat: Coat): { material: THREE.MeshPhysicalMaterial; uniforms: { uGlow: { value: number } } } {
  const uniforms = { uGlow: { value: 0.6 }, uGlowColor: { value: coat.lantern.clone() } };
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: coat.belly.clone().multiplyScalar(0.55),
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;\nuniform vec3 uGlowColor;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlowColor * vGlow * uGlow;');
    shader.fragmentShader = guard(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kinling-skin';
  return { material, uniforms };
}

export function createFurShellMaterial(coat: Coat): { make: (shell: number, count: number) => THREE.Material; uniforms: FurUniforms } {
  const uniforms: FurUniforms = {
    uFurLength: { value: 0.023 },
    uDensity: { value: 380 },
    uSway: { value: new THREE.Vector3() },
    uGlow: { value: 0.6 },
    uGlowColor: { value: coat.lantern.clone() },
  };
  const make = (shell: number, count: number): THREE.Material => {
    const material = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      sheen: 0.9,
      sheenRoughness: 0.6,
      sheenColor: coat.belly.clone().multiplyScalar(0.5),
      side: THREE.FrontSide,
    });
    const uShell = { value: shell };
    const uStep = { value: 1 / count };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, { uShell, uStep });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aFur;
attribute float aGlow;
uniform float uShell;
uniform float uFurLength;
uniform vec3 uSway;
varying vec3 vRest;
varying float vFur;
varying float vGlow;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vRest = position;
vFur = aFur;
vGlow = aGlow;
{
  float h = uShell;
  // strands lean back and down the body, and lag behind motion at their tips
  vec3 comb = vec3(0.0, -0.42, -0.5);
  transformed += (normal + comb * h * 0.6 + uSway * h * h) * (uFurLength * aFur * h);
}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uShell;
uniform float uStep;
uniform float uDensity;
uniform float uGlow;
uniform vec3 uGlowColor;
varying vec3 vRest;
varying float vFur;
varying float vGlow;
${HASH}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  if (vFur < 0.03) discard;
  vec3 fp = vRest * uDensity;
  vec3 cell = floor(fp);
  vec3 f = fract(fp) - 0.5;
  float rnd = kHash(cell);
  float len = mix(0.5, 1.0, rnd);
  float hh = uShell / len;
  if (hh > 1.0) discard;
  vec3 jit = (vec3(kHash(cell + 7.1), kHash(cell + 3.7), kHash(cell + 11.3)) - 0.5) * 0.45;
  float rad = 0.6 * (1.0 - hh * 0.72);
  if (length(f - jit) > rad) discard;
  // roots sit in shadow, tips catch the light
  diffuseColor.rgb *= mix(0.6, 1.08, pow(uShell, 0.8));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.02, rnd * uShell * 0.6);
}`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlowColor * vGlow * uGlow * (0.4 + 0.6 * uShell);');
      shader.fragmentShader = guard(shader.fragmentShader);
    };
    material.customProgramCacheKey = () => 'kinling-fur';
    return material;
  };
  return { make, uniforms };
}

export function createEyeMaterial(iris: THREE.Color): {
  material: THREE.MeshPhysicalMaterial;
  uniforms: { uPupil: { value: number }; uGlint: { value: number }; uIris: { value: THREE.Color } };
} {
  const uniforms = { uPupil: { value: 0.52 }, uGlint: { value: 1 }, uIris: { value: iris.clone() } };
  const material = new THREE.MeshPhysicalMaterial({
    roughness: 0.12,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEyeLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeLocal = normalize(position);');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uPupil;
uniform float uGlint;
uniform vec3 uIris;
varying vec3 vEyeLocal;
vec3 kEye;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 d = normalize(vEyeLocal);
  float ang = acos(clamp(d.z, -1.0, 1.0));
  float r = ang / 0.92;
  // atan(0, 0) is undefined at the exact centre of the pupil; one NaN pixel would spread through the bloom
  float th = atan(d.y, abs(d.x) < 1e-5 ? 1e-5 : d.x);
  float fib = 0.5 + 0.5 * sin(th * 38.0 + sin(th * 9.0) * 2.0);
  vec3 iris = uIris * mix(0.5, 1.3, smoothstep(0.15, 0.95, r));
  iris = mix(iris, iris * 1.45 + 0.04, fib * 0.3 * smoothstep(uPupil, 1.0, r));
  iris *= 1.0 - smoothstep(0.8, 1.0, r) * 0.8;
  vec3 col = mix(iris, vec3(0.13, 0.08, 0.07), smoothstep(0.98, 1.05, r));
  col = mix(vec3(0.012, 0.008, 0.012), col, smoothstep(uPupil - 0.035, uPupil + 0.035, r));
  kEye = col;
  diffuseColor.rgb = col;
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 vn = normalize(vNormal);
  float g1 = smoothstep(0.2, 0.07, distance(vn.xy, vec2(-0.28, 0.4)));
  float g2 = smoothstep(0.1, 0.03, distance(vn.xy, vec2(0.24, -0.2)));
  totalEmissiveRadiance += vec3(1.0, 0.98, 0.94) * (g1 * 0.95 + g2 * 0.35) * uGlint;
  totalEmissiveRadiance += kEye * 0.22;
}`,
      );
    shader.fragmentShader = guard(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kinling-eye';
  return { material, uniforms };
}

export function createLanternMaterial(color: THREE.Color): { material: THREE.MeshPhysicalMaterial; uniforms: { uGlow: { value: number }; uLantern: { value: THREE.Color } } } {
  const uniforms = { uGlow: { value: 1 }, uLantern: { value: color.clone() } };
  const material = new THREE.MeshPhysicalMaterial({
    color: color.clone().multiplyScalar(0.6),
    roughness: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBud;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBud = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;\nuniform vec3 uLantern;\nvarying vec3 vBud;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float facing = abs(normalize(vNormal).z);
  // hot core seen through a cooler shell, with faint veins like a seed pod
  float veins = 0.85 + 0.15 * sin(atan(vBud.x, abs(vBud.z) < 1e-5 ? 1e-5 : vBud.z) * 9.0 + vBud.y * 40.0);
  float core = mix(0.5, 2.2, pow(facing, 1.4)) * veins;
  totalEmissiveRadiance += uLantern * core * uGlow;
}`,
      );
    shader.fragmentShader = guard(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => 'kinling-lantern';
  return { material, uniforms };
}
