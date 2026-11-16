/**
 * An unhurried orbit camera. It keeps the creature comfortably framed without
 * chasing every step: a soft focus point trails the creature, the player
 * orbits and zooms around it, and the camera stays inside the glade and
 * above the ground.
 */
import * as THREE from 'three';
import { clamp, damp, dampAngle, lerp } from '../core/math';
import { heightAt } from '../sim/terrain';

export class CameraRig {
  readonly focus = new THREE.Vector3(0, 0.3, 0);
  azimuth = 0.12;
  polar = 1.25;
  distance = 4.3;
  private az = 0.12;
  private pol = 1.25;
  private dist = 4.3;
  reducedMotion = false;
  /** Seconds since the player last moved the camera. */
  idle = 10;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  snap(target: THREE.Vector3): void {
    this.focus.set(target.x, target.y + 0.28, target.z);
    this.az = this.azimuth; this.pol = this.polar; this.dist = this.distance;
    this.place();
  }

  orbit(dx: number, dy: number): void {
    this.azimuth -= dx * 0.0055;
    this.polar = clamp(this.polar - dy * 0.004, 0.42, 1.5);
    this.idle = 0;
  }

  zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, 1.35, 9.5);
    this.idle = 0;
  }

  update(dt: number, target: THREE.Vector3, headY: number): void {
    this.idle += dt;
    const close = 1 - clamp((this.distance - 1.6) / 2.2, 0, 1);
    // up close we watch the face; further out, the whole animal and where it is going
    const desiredY = target.y + lerp(0.26, headY - target.y, close * 0.9);
    const d = Math.hypot(target.x - this.focus.x, target.z - this.focus.z);
    const rate = this.reducedMotion ? 30 : lerp(0.9, 3.2, clamp((d - 0.5) / 2, 0, 1)) + close * 4;
    this.focus.x = damp(this.focus.x, target.x, rate, dt);
    this.focus.z = damp(this.focus.z, target.z, rate, dt);
    this.focus.y = damp(this.focus.y, desiredY, rate + 2, dt);
    const k = this.reducedMotion ? 40 : 9;
    this.az = dampAngle(this.az, this.azimuth, k, dt);
    this.pol = damp(this.pol, this.polar, k, dt);
    this.dist = damp(this.dist, this.distance, k * 0.8, dt);
    this.place();
  }

  private place(): void {
    const sp = Math.sin(this.pol), cp = Math.cos(this.pol);
    let dist = this.dist;
    const c = this.camera.position;
    for (let i = 0; i < 6; i++) {
      c.set(this.focus.x + Math.sin(this.az) * sp * dist, this.focus.y + cp * dist, this.focus.z + Math.cos(this.az) * sp * dist);
      // stay inside the ring of trees
      if (Math.hypot(c.x, c.z) <= 11.2) break;
      dist *= 0.9;
    }
    const ground = heightAt(c.x, c.z) + 0.22;
    if (c.y < ground) c.y = ground;
    this.camera.lookAt(this.focus);
  }

  /** A spot on the ground just in front of the viewer: where "the player" is, to the creature. */
  playerSpot(out: { x: number; z: number }): void {
    const c = this.camera.position;
    const dx = this.focus.x - c.x, dz = this.focus.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    const step = Math.min(1.5, d * 0.4);
    out.x = c.x + (dx / d) * step;
    out.z = c.z + (dz / d) * step;
  }
}
