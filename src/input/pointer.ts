/**
 * Pointer and touch. One rule keeps gestures apart: a click acts, a drag on
 * open ground turns the camera. Dragging on the creature strokes it, dragging
 * a toy picks it up and a flick throws it. Two fingers always move the camera.
 */
import * as THREE from 'three';
import type { TouchRegion } from '../sim/identity';
import { heightAt, WATER_Y } from '../sim/terrain';
import type { ToyKind } from '../sim/types';
import type { World } from '../sim/world';
import type { KinlingBody } from '../render/creature/build';
import type { CameraRig } from '../render/camera';

export type Tool = 'hand' | 'berry' | 'ball' | 'rattle' | 'wisp' | 'curio' | 'watch';

export interface PointerHooks {
  /** A click on the ground with a tool selected. */
  act(tool: Tool, x: number, z: number): void;
  /** Any deliberate gesture (used to unlock audio and dismiss hints). */
  gesture(): void;
  petting(active: boolean): void;
  hover(what: 'creature' | 'toy' | 'ground' | 'none'): void;
}

const CLICK_PX = 7;
const CLICK_MS = 320;

export class Pointer {
  tool: Tool = 'hand';
  /** World position of the pointer on the ground, when it has one. */
  readonly ground = new THREE.Vector3();
  hasGround = false;
  private ray = new THREE.Ray();
  private ndc = new THREE.Vector2();
  private mode: 'none' | 'pending' | 'orbit' | 'pet' | 'grab' | 'wisp' = 'none';
  private pointers = new Map<number, { x: number; y: number }>();
  private start = { x: 0, y: 0, t: 0 };
  private last = { x: 0, y: 0 };
  private moved = 0;
  private lastStroke = 0;
  private strokeTravel = 0;
  private grabbed: ToyKind | null = null;
  private trail: Array<{ x: number; z: number; t: number }> = [];
  private pinch = 0;
  private downOn: 'creature' | 'toy' | 'ground' = 'ground';
  private readonly tmp = new THREE.Vector3();
  private readonly sphere = new THREE.Sphere();
  private readonly dispose: Array<() => void> = [];

  constructor(
    private el: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    private rig: CameraRig,
    private world: World,
    private body: () => KinlingBody,
    private toyMesh: (kind: ToyKind) => THREE.Object3D,
    private hooks: PointerHooks,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn as EventListener, opts);
      this.dispose.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => this.down(e));
    on('pointermove', (e) => this.move(e));
    on('pointerup', (e) => this.up(e));
    on('pointercancel', (e) => this.up(e));
    on('pointerleave', () => { if (this.tool === 'wisp' && this.mode === 'none') this.world.setWisp(false); this.hasGround = false; });
    on('wheel', (e) => { e.preventDefault(); this.rig.zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
  }

  setTool(tool: Tool): void {
    if (this.tool === 'wisp' && tool !== 'wisp') this.world.setWisp(false);
    this.tool = tool;
  }

  destroy(): void {
    for (const d of this.dispose) d();
  }

  // ── picking ────────────────────────────────────────────────────
  private setRay(cx: number, cy: number): void {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    this.ray.direction.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.camera).sub(this.ray.origin).normalize();
  }

  private pickCreature(): { region: TouchRegion; point: THREE.Vector3; dist: number } | null {
    let best: { region: TouchRegion; point: THREE.Vector3; dist: number } | null = null;
    for (const p of this.body().proxies) {
      this.sphere.center.copy(p.offset);
      p.bone.localToWorld(this.sphere.center);
      this.sphere.radius = p.radius;
      const hit = this.ray.intersectSphere(this.sphere, this.tmp);
      if (!hit) continue;
      const d = hit.distanceTo(this.ray.origin);
      if (!best || d < best.dist) best = { region: p.region, point: hit.clone(), dist: d };
    }
    return best;
  }

  private pickToy(): ToyKind | null {
    let best: ToyKind | null = null, bd = Infinity;
    for (const kind of ['ball', 'rattle'] as const) {
      if (this.world.toys[kind].state === 'carried') continue;
      this.sphere.center.copy(this.toyMesh(kind).position);
      this.sphere.radius = 0.16;
      const hit = this.ray.intersectSphere(this.sphere, this.tmp);
      if (hit) { const d = hit.distanceTo(this.ray.origin); if (d < bd) { bd = d; best = kind; } }
    }
    return best;
  }

  private surfaceAt(x: number, z: number): number {
    const y = heightAt(x, z);
    return this.tool === 'watch' ? Math.max(y, WATER_Y + .035) : y;
  }

  /** March the ray against the analytic terrain. */
  private pickGround(out: THREE.Vector3): boolean {
    const o = this.ray.origin, d = this.ray.direction;
    if (d.y > -0.02) return false;
    let t = 0, prev = 0;
    for (let i = 0; i < 160; i++) {
      t += 0.2;
      const y = o.y + d.y * t;
      if (y < this.surfaceAt(o.x + d.x * t, o.z + d.z * t)) {
        let a = prev, b = t;
        for (let j = 0; j < 12; j++) {
          const m = (a + b) / 2;
          if (o.y + d.y * m < this.surfaceAt(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m;
        }
        out.copy(d).multiplyScalar(b).add(o);
        return Math.hypot(out.x, out.z) < 14;
      }
      prev = t;
    }
    return false;
  }

  // ── gestures ───────────────────────────────────────────────────
  private down(e: PointerEvent): void {
    this.hooks.gesture();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (this.pointers.size === 2) {
      // second finger: this is a camera gesture, whatever the first was doing
      this.endGesture(false);
      this.mode = 'orbit';
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    if (this.pointers.size > 2) return;
    this.start = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.last = { x: e.clientX, y: e.clientY };
    this.moved = 0;
    this.strokeTravel = 0;
    if (e.button === 2 || e.button === 1) { this.mode = 'orbit'; return; }
    this.setRay(e.clientX, e.clientY);
    const creature = this.tool === 'watch' ? null : this.pickCreature();
    const toy = this.tool === 'hand' ? this.pickToy() : null;
    if (creature && (!toy || creature.dist < this.toyMesh(toy).position.distanceTo(this.ray.origin))) {
      this.mode = 'pet';
      this.downOn = 'creature';
      this.lastStroke = 0;
    } else if (toy) {
      this.mode = 'pending';
      this.downOn = 'toy';
      this.grabbed = toy;
    } else {
      this.downOn = 'ground';
      this.mode = this.tool === 'wisp' && e.pointerType !== 'mouse' ? 'wisp' : 'pending';
      if (this.mode === 'wisp' && this.pickGround(this.ground)) this.world.setWisp(true, this.ground.x, this.ground.z);
    }
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    this.setRay(e.clientX, e.clientY);
    this.hasGround = this.pickGround(this.ground);
    if (!p) {
      // hovering with a mouse
      if (this.tool === 'wisp' && this.hasGround) this.world.setWisp(true, this.ground.x, this.ground.z);
      this.hooks.hover(this.pickCreature() ? 'creature' : this.tool === 'hand' && this.pickToy() ? 'toy' : this.hasGround ? 'ground' : 'none');
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0 && d > 0) this.rig.zoom(this.pinch / d);
      this.pinch = d;
      this.rig.orbit(dx * 0.5, dy * 0.5);
      return;
    }
    this.moved += Math.hypot(dx, dy);
    this.last = { x: e.clientX, y: e.clientY };
    const now = performance.now();
    switch (this.mode) {
      case 'pending':
        if (this.moved > CLICK_PX) {
          if (this.downOn === 'toy' && this.grabbed) { this.mode = 'grab'; this.trail = []; }
          else this.mode = 'orbit';
        }
        break;
      case 'orbit':
        this.rig.orbit(dx, dy);
        break;
      case 'pet': {
        this.strokeTravel += Math.hypot(dx, dy);
        if (this.strokeTravel > 5 && now - this.lastStroke > 115) {
          const hit = this.pickCreature();
          if (hit) {
            this.world.touch(hit.region, 'stroke', hit.point.x, hit.point.y, hit.point.z);
            this.hooks.petting(true);
            this.lastStroke = now;
            this.strokeTravel = 0;
          }
        }
        break;
      }
      case 'grab': {
        if (!this.grabbed) break;
        // carry the toy a little above the ground under the pointer
        if (this.hasGround) {
          const y = heightAt(this.ground.x, this.ground.z) + 0.3;
          if (this.world.holdToy(this.grabbed, this.ground.x, y, this.ground.z)) {
            this.trail.push({ x: this.ground.x, z: this.ground.z, t: now });
            while (this.trail.length > 2 && now - this.trail[0].t > 130) this.trail.shift();
          }
        }
        break;
      }
      case 'wisp':
        if (this.hasGround) this.world.setWisp(true, this.ground.x, this.ground.z);
        break;
    }
  }

  private up(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    if (this.pointers.size > 0) { this.pinch = 0; return; }
    const quick = performance.now() - this.start.t < CLICK_MS && this.moved <= CLICK_PX;
    this.setRay(e.clientX, e.clientY);
    this.endGesture(quick);
  }

  private endGesture(click: boolean): void {
    const mode = this.mode;
    this.mode = 'none';
    if (mode === 'pet') {
      this.hooks.petting(false);
      if (click) {
        const hit = this.pickCreature();
        if (hit) this.world.touch(hit.region, 'tap', hit.point.x, hit.point.y, hit.point.z);
      }
    } else if (mode === 'grab' && this.grabbed) {
      const a = this.trail[0], b = this.trail[this.trail.length - 1];
      let vx = 0, vz = 0;
      if (a && b && b.t > a.t) { const dt = (b.t - a.t) / 1000; vx = (b.x - a.x) / dt; vz = (b.z - a.z) / dt; }
      const s = Math.hypot(vx, vz);
      this.world.releaseToy(this.grabbed, vx * 0.85, 0.6 + Math.min(s, 6) * 0.32, vz * 0.85);
    } else if (mode === 'pending' && click) {
      if (this.downOn === 'toy' && this.grabbed) {
        // a tap on a toy gives it a little nudge away from the viewer
        const toy = this.world.toys[this.grabbed];
        const dx = toy.position.x - this.ray.origin.x, dz = toy.position.z - this.ray.origin.z;
        const l = Math.hypot(dx, dz) || 1;
        toy.impulse((dx / l) * 1.6, 1.1, (dz / l) * 1.6, true);
      } else if (this.pickGround(this.ground)) this.hooks.act(this.tool, this.ground.x, this.ground.z);
    } else if (mode === 'wisp' && this.tool === 'wisp') {
      this.world.setWisp(false);
    }
    this.grabbed = null;
  }
}
