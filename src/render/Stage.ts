/**
 * Renderer, scene, post-processing and quality tiers. Expensive effects are
 * chosen for what they add to the actual view: soft shadows ground the
 * creature, a restrained bloom lets its lantern and the fireflies glow.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Sky } from './sky';

export type QualityLevel = 'low' | 'medium' | 'high';
export interface QualitySpec { dpr: number; shadow: number; shells: number; grass: number; bloom: boolean; msaa: number }
export const QUALITY: Record<QualityLevel, QualitySpec> = {
  low: { dpr: 1, shadow: 1024, shells: 6, grass: 0.4, bloom: false, msaa: 0 },
  medium: { dpr: 1.5, shadow: 2048, shells: 10, grass: 0.75, bloom: true, msaa: 2 },
  high: { dpr: 2, shadow: 2048, shells: 16, grass: 1, bloom: true, msaa: 4 },
};

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.08, 120);
  readonly sky: Sky;
  quality: QualityLevel;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private w = 1;
  private h = 1;

  constructor(readonly canvas: HTMLCanvasElement, quality: QualityLevel) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.sky = new Sky(this.scene, QUALITY[quality].shadow);
    this.applyQuality();
  }

  get spec(): QualitySpec {
    return QUALITY[this.quality];
  }
  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  setQuality(level: QualityLevel): void {
    if (level === this.quality) return;
    this.quality = level;
    this.sky.setShadowSize(this.spec.shadow);
    this.applyQuality();
  }

  private applyQuality(): void {
    const spec = this.spec;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, spec.dpr));
    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    if (spec.bloom) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: spec.msaa });
      const composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.28, 0.7, 0.92);
      composer.addPass(this.bloom);
      composer.addPass(new OutputPass());
      this.composer = composer;
    }
    this.resize(this.w, this.h);
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.renderer.setSize(this.w, this.h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(this.w, this.h);
    this.camera.aspect = this.w / this.h;
    // keep the creature a sensible size on tall, narrow screens
    this.camera.fov = this.camera.aspect < 0.8 ? 46 : this.camera.aspect < 1.2 ? 40 : 34;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.toneMappingExposure = this.sky.exposure;
    if (this.bloom) this.bloom.strength = 0.22 + 0.4 * this.sky.night;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.composer?.dispose();
    this.renderer.dispose();
  }
}
