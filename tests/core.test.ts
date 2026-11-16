import { describe, expect, it } from 'vitest';
import { FixedStepper } from '../src/core/stepper';
import { Rng } from '../src/core/rng';
import { Nav } from '../src/sim/nav';
import { heightAt, isWalkable, nearestShore, POND, WATER_Y, walkableSegment } from '../src/sim/terrain';

describe('fixed-step timing', () => {
  const simulate = (frameDts: number[]): number => {
    const s = new FixedStepper();
    let t = 0;
    for (const dt of frameDts) s.advance(dt, (h) => { t += h; });
    return t;
  };
  it('advances the same simulated time at 30, 60 and 144 fps', () => {
    const at = (fps: number): number => simulate(Array.from({ length: fps * 10 }, () => 1 / fps));
    for (const fps of [30, 60, 144]) expect(at(fps)).toBeGreaterThan(9.95), expect(at(fps)).toBeLessThanOrEqual(10.001);
  });
  it('tolerates irregular frame times', () => {
    const rng = new Rng(3);
    const frames = Array.from({ length: 2000 }, () => rng.range(0.004, 0.03));
    const total = frames.reduce((a, b) => a + b, 0);
    expect(Math.abs(simulate(frames) - total)).toBeLessThan(1 / 60 + 1e-9);
  });
  it('does not replay a long stall (resumed tab)', () => {
    const s = new FixedStepper();
    let steps = 0;
    const ran = s.advance(37.5, () => { steps++; });
    expect(ran).toBeLessThanOrEqual(5);
    expect(steps).toBeLessThanOrEqual(5);
    expect(s.advance(Number.NaN, () => { steps++; })).toBe(0);
    expect(s.advance(-4, () => { steps++; })).toBe(0);
  });
});

describe('glade and navigation', () => {
  const nav = new Nav();
  it('builds a connected walkable graph', () => {
    expect(nav.nodeCount).toBeGreaterThan(800);
  });
  it('routes around the pond on walkable ground only', () => {
    const from = { x: POND.x - POND.r - 1.2, z: POND.z + 0.3 }, to = { x: POND.x + POND.r + 1.2, z: POND.z - 0.2 };
    expect(isWalkable(from.x, from.z)).toBe(true);
    expect(walkableSegment(from.x, from.z, to.x, to.z)).toBe(false);
    const path = nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(2);
    for (let i = 1; i < path.length; i++) expect(walkableSegment(path[i - 1].x, path[i - 1].z, path[i].x, path[i].z)).toBe(true);
    expect(nav.pathLength(path)).toBeGreaterThan(Math.hypot(to.x - from.x, to.z - from.z));
  });
  it('gets as close as it can to somewhere it cannot stand', () => {
    const path = nav.findPath({ x: 0, z: 0 }, { x: POND.x, z: POND.z })!;
    const end = path[path.length - 1];
    expect(isWalkable(end.x, end.z)).toBe(true);
    expect(WATER_Y - heightAt(end.x, end.z)).toBeLessThan(0.08);
  });
  it('finds a drinkable shore', () => {
    const s = nearestShore(0, 0);
    expect(isWalkable(s.x, s.z, 0.14)).toBe(true);
    expect(Math.hypot(s.x - POND.x, s.z - POND.z)).toBeLessThan(POND.r + 1.2);
  });
});
