/** Small scalar helpers shared by simulation and rendering. No dependencies. */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => clamp01((v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number): number => lerp(c, d, invLerp(a, b, v));
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const frac = (v: number): number => v - Math.floor(v);

/** Frame-rate independent exponential approach. `rate` is roughly 1 / time-constant. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

/** Wrap an angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const angleDelta = (from: number, to: number): number => wrapAngle(to - from);
export const dampAngle = (current: number, target: number, rate: number, dt: number): number =>
  current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));
/** Move `current` toward `target` by at most `maxStep`. */
export const approach = (current: number, target: number, maxStep: number): number => {
  const d = target - current;
  return Math.abs(d) <= maxStep ? target : current + Math.sign(d) * maxStep;
};

export const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  t = clamp01(t);
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
/** 0 → 1 → 0 bump over t in [0,1]. */
export const bump = (t: number): number => Math.sin(clamp01(t) * Math.PI);
/** Window that rises over [a,b] and falls over [c,d]. */
export const window4 = (t: number, a: number, b: number, c: number, d: number): number =>
  smoothstep(a, b, t) * (1 - smoothstep(c, d, t));

export const dist2 = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

/**
 * Critically damped spring for a scalar. Stable for any dt (implicit form),
 * so pose channels stay continuous through interruptions and frame drops.
 */
export class Spring {
  value: number;
  velocity = 0;
  constructor(value = 0, public halflife = 0.12) {
    this.value = value;
  }
  update(target: number, dt: number, halflife = this.halflife): number {
    const y = (4 * Math.LN2) / Math.max(halflife, 1e-4) / 2;
    const j0 = this.value - target;
    const j1 = this.velocity + j0 * y;
    const e = Math.exp(-y * dt);
    this.value = e * (j0 + j1 * dt) + target;
    this.velocity = e * (this.velocity - j1 * y * dt);
    return this.value;
  }
  snap(v: number): void {
    this.value = v;
    this.velocity = 0;
  }
}

/** Underdamped spring (for follow-through and overshoot). */
export class BouncySpring {
  value: number;
  velocity = 0;
  constructor(value = 0, public stiffness = 120, public damping = 12) {
    this.value = value;
  }
  update(target: number, dt: number): number {
    // semi-implicit Euler with sub-stepping keeps it stable at low frame rates
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity += (-(this.value - target) * this.stiffness - this.velocity * this.damping) * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}
