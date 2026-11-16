/**
 * Short-lived emotional state, separate from needs and from personality.
 * Three continuous dimensions relax toward baselines set by how the body
 * feels; events push them around. Behaviour reads them smoothly.
 */
import { clamp, clamp01, damp } from '../core/math';
import type { Traits } from './identity';

export class Affect {
  /** -1 unhappy … +1 delighted */
  valence = 0.15;
  /** 0 drowsy … 1 excited */
  arousal = 0.4;
  /** 0 at ease … 1 frightened */
  wariness = 0;
  /** Brief spike of interest after noticing something. */
  interest = 0;

  update(dt: number, comfort: number, energy: number, night: number, traits: Traits): void {
    const vBase = clamp((comfort - 0.55) * 1.6, -0.7, 0.6);
    const aBase = clamp01(0.18 + 0.38 * energy - 0.14 * night + this.wariness * 0.4);
    this.valence = damp(this.valence, vBase, 1 / 40, dt);
    this.arousal = damp(this.arousal, aBase, 1 / 18, dt);
    // sensitive individuals hold on to a fright for longer; confident ones shake it off
    const tau = 9 + 16 * traits.sensitivity - 6 * traits.confidence;
    this.wariness = damp(this.wariness, 0, 1 / Math.max(4, tau), dt);
    this.interest = damp(this.interest, 0, 1 / 6, dt);
  }

  feel(dValence: number, dArousal = 0, dWariness = 0): void {
    this.valence = clamp(this.valence + dValence, -1, 1);
    this.arousal = clamp01(this.arousal + dArousal);
    this.wariness = clamp01(this.wariness + dWariness);
  }

  /** A one-line, plain-language reading for the optional summary. */
  label(needs: { energy: number }): string {
    if (this.wariness > 0.55) return 'wary';
    if (needs.energy < 0.22) return 'sleepy';
    if (this.valence > 0.45 && this.arousal > 0.6) return 'delighted';
    if (this.valence > 0.3 && this.arousal < 0.35) return 'content';
    if (this.arousal > 0.62) return 'excited';
    if (this.valence < -0.3) return 'out of sorts';
    if (this.interest > 0.4) return 'curious';
    if (this.arousal < 0.25) return 'drowsy';
    return 'calm';
  }
}
