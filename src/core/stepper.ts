/**
 * Fixed-timestep accumulator with bounded catch-up. Simulation always
 * advances in equal steps regardless of display rate; a long stall (a hidden
 * tab, a debugger pause) is clamped and the backlog dropped rather than
 * replayed, so behaviour never jumps.
 */
export class FixedStepper {
  private acc = 0;
  constructor(readonly step = 1 / 60, readonly maxSteps = 5, readonly maxFrame = 0.1) {}

  /** Feed one frame's elapsed seconds. Returns how many steps ran. */
  advance(frameSeconds: number, tick: (dt: number) => void): number {
    const dt = Number.isFinite(frameSeconds) ? Math.min(Math.max(frameSeconds, 0), this.maxFrame) : 0;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= this.step && steps < this.maxSteps) {
      tick(this.step);
      this.acc -= this.step;
      steps++;
    }
    if (steps === this.maxSteps && this.acc >= this.step) this.acc = 0;
    return steps;
  }

  /** Fraction of a step left over, for interpolating rendering. */
  get alpha(): number {
    return this.acc / this.step;
  }

  reset(): void {
    this.acc = 0;
  }
}
