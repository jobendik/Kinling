/**
 * Bodily needs. Each lives in [0,1] where 1 is fully satisfied. They drift
 * with time and activity; only things that actually happen in the world
 * (a bite eaten, water lapped, sleep slept) restore them.
 */
import { clamp01 } from '../core/math';
import type { Traits } from './identity';

export const NEED_KEYS = ['nourishment', 'hydration', 'energy', 'stimulation', 'social', 'security'] as const;
export type NeedKey = (typeof NEED_KEYS)[number];
export type NeedValues = Record<NeedKey, number>;

export interface NeedContext {
  /** 0..1 fraction of top speed. */
  exertion: number;
  asleep: boolean;
  resting: boolean;
  playing: boolean;
  inNest: boolean;
  night: number;
  traits: Traits;
}

export const RUN_SPEED = 2.2;

export class Needs {
  values: NeedValues = { nourishment: 0.72, hydration: 0.7, energy: 0.88, stimulation: 0.45, social: 0.62, security: 0.7 };

  update(dt: number, c: NeedContext): void {
    const v = this.values;
    const sleepK = c.asleep ? 0.4 : 1;
    v.nourishment -= dt * (1 / 900) * sleepK * (1 + 0.7 * c.exertion);
    v.hydration -= dt * (1 / 780) * sleepK * (1 + 0.9 * c.exertion);
    if (c.asleep) v.energy += dt * (1 / 150) * (1 + 0.35 * c.night) * (c.inNest ? 1.15 : 1);
    else if (c.resting) v.energy += dt * (1 / 700);
    else v.energy -= dt * (1 / 1500 + 0.0048 * Math.pow(c.exertion, 1.5));
    if (!c.playing) v.stimulation -= dt * (1 / 420) * (c.asleep ? 0.25 : 1) * (0.7 + 0.6 * c.traits.playfulness);
    v.social -= dt * (1 / 900) * (c.asleep ? 0.3 : 1) * (0.55 + 0.9 * c.traits.sociability);
    const base = 0.5 + 0.42 * c.traits.confidence + (c.inNest ? 0.15 : 0);
    v.security += (Math.min(1, base) - v.security) * (1 - Math.exp(-dt / (c.inNest ? 14 : 38)));
    for (const k of NEED_KEYS) v[k] = clamp01(v[k]);
  }

  add(key: NeedKey, amount: number): void {
    this.values[key] = clamp01(this.values[key] + amount);
  }

  /** Smooth urgency in [0,1]: gentle until a need is half-empty, steep after. */
  urgency(key: NeedKey): number {
    const lack = 1 - this.values[key];
    return clamp01(Math.pow(lack, 1.7) * 1.25);
  }

  /** Mean satisfaction, used as the mood baseline. */
  comfort(): number {
    const v = this.values;
    return (v.nourishment + v.hydration + v.energy + v.stimulation * 0.6 + v.social * 0.6 + v.security) / 4.2;
  }
}
