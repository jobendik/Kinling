/**
 * The sanctuary's ground truth: one analytic description of the glade that the
 * simulation (walkability, collision, navigation) and the renderer (meshes)
 * both read. Keeping it in a single pure module is what keeps navigable
 * surfaces, obstacles, interaction places and rendered geometry consistent.
 *
 * Axes: +Y up, +Z toward the default camera. Units are roughly metres; a
 * Kinling stands about 0.3 at the shoulder.
 */
import { clamp, smoothstep } from '../core/math';
import { fbm2, noise2 } from '../core/noise';
import { Rng } from '../core/rng';

export interface Obstacle {
  id: string;
  kind: 'rock' | 'log' | 'tree' | 'bush' | 'den';
  x: number;
  z: number;
  /** Collision / occlusion radius on the ground plane. */
  r: number;
  /** Visual height, also used for line-of-sight tests. */
  h: number;
  seed: number;
}

export interface Place {
  x: number;
  z: number;
  r: number;
}

const WORLD_SEED = 7719;

export const GLADE_RADIUS = 7.4;
export const WATER_Y = -0.2;
/** Deepest water a Kinling will stand in (wet paws only). */
export const WADE_DEPTH = 0.07;

export const POND: Place = { x: -3.5, z: 1.9, r: 2.0 };
export const NEST: Place = { x: 0.9, z: -4.7, r: 0.62 };
export const SUN_STONE: Place = { x: 3.7, z: -0.6, r: 0.85 };
export const BUSH: Place = { x: 4.9, z: 2.9, r: 0.55 };
export const DEN_TREE: Place = { x: 1.3, z: -6.5, r: 1.05 };
export const SPAWN: Place = { x: 0.2, z: -3.2, r: 0.3 };
/** A good default spot "near the player" before the camera has reported one. */
export const DEFAULT_PLAYER_SPOT: Place = { x: 0.4, z: 3.6, r: 0.5 };

function buildObstacles(): Obstacle[] {
  const rng = new Rng(WORLD_SEED);
  const list: Obstacle[] = [];
  let n = 0;
  const add = (kind: Obstacle['kind'], x: number, z: number, r: number, h: number): void => {
    list.push({ id: `${kind}-${n++}`, kind, x, z, r, h, seed: rng.int(1, 1e6) });
  };
  // Hand-placed anchors that give the glade its composition.
  add('den', DEN_TREE.x, DEN_TREE.z, DEN_TREE.r, 7);
  add('log', -4.3, -2.7, 0.62, 0.55);
  add('rock', 2.1, 2.4, 0.42, 0.42);
  add('rock', -1.5, -3.1, 0.5, 0.5);
  add('rock', 3.3, -4.2, 0.55, 0.62);
  add('rock', -6.0, -0.3, 0.52, 0.55);
  add('rock', 5.9, 0.9, 0.46, 0.44);
  add('rock', -1.0, 5.1, 0.36, 0.3);
  add('rock', -5.1, 4.1, 0.44, 0.4);
  add('bush', BUSH.x, BUSH.z, BUSH.r, 0.7);
  // A ring of trees just outside the walkable glade: shelter and backdrop.
  const count = 15;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.12, 0.12);
    // leave the view from the default camera (+Z) more open
    const front = Math.max(0, Math.cos(a - Math.PI / 2));
    const rad = 9.3 + rng.range(0, 1.6) + front * 2.2;
    const x = Math.sin(a) * rad;
    const z = Math.cos(a) * rad;
    if (Math.hypot(x - DEN_TREE.x, z - DEN_TREE.z) < 2.6) continue;
    add('tree', x, z, rng.range(0.32, 0.5), rng.range(5, 8));
  }
  return list;
}

export const OBSTACLES: readonly Obstacle[] = buildObstacles();

/** Radius of the walkable glade in a given direction; a soft, irregular edge. */
export function gladeEdge(x: number, z: number): number {
  const a = Math.atan2(x, z);
  return GLADE_RADIUS + (noise2(Math.cos(a) * 1.7 + 5, Math.sin(a) * 1.7 + 5, WORLD_SEED) - 0.5) * 1.3;
}

/** Terrain height. Pure and deterministic. */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // soft undulation, flattened in the middle so the play area reads clearly
  const und = (fbm2(x * 0.21 + 11.3, z * 0.21 - 4.1, 4, WORLD_SEED) - 0.5) * 0.5;
  const detail = (fbm2(x * 0.9, z * 0.9, 2, WORLD_SEED + 3) - 0.5) * 0.05;
  let h = und * smoothstep(0.5, 5.5, r) * 0.9 + und * 0.1 + detail;

  // sheltering bank that rises into the trees
  const edge = gladeEdge(x, z);
  const over = r - edge;
  if (over > -1.2) {
    const t = over + 1.2;
    h += t * t * 0.085 * (1 + 0.5 * noise2(x * 0.4, z * 0.4, WORLD_SEED + 9));
  }

  // pond bowl with an irregular shoreline
  const pdx = x - POND.x, pdz = z - POND.z;
  const pa = Math.atan2(pdx, pdz);
  const pr = POND.r * (0.9 + 0.2 * noise2(Math.cos(pa) * 1.3 + 2, Math.sin(pa) * 1.3 + 2, WORLD_SEED + 21));
  const pd = Math.hypot(pdx, pdz);
  const flat = 1 - smoothstep(pr * 0.8, pr + 1.5, pd);
  h = h * (1 - flat * 0.85) + flat * -0.03; // level the banks around the water
  const bowl = 1 - smoothstep(pr * 0.25, pr + 0.35, pd);
  h -= bowl * 0.62;

  // the sun stone: a low flat-topped rise
  const sd = Math.hypot(x - SUN_STONE.x, z - SUN_STONE.z);
  const top = 1 - smoothstep(SUN_STONE.r * 0.72, SUN_STONE.r * 1.05, sd);
  h = h * (1 - top * 0.8) + top * 0.17;

  // the nest: a shallow moss-lined hollow between the den tree's roots
  const nd = Math.hypot(x - NEST.x, z - NEST.z);
  h -= (1 - smoothstep(0.1, NEST.r * 1.1, nd)) * 0.07;
  // roots mound up behind the nest toward the trunk
  const dd = Math.hypot(x - DEN_TREE.x, z - DEN_TREE.z);
  h += (1 - smoothstep(DEN_TREE.r * 0.6, DEN_TREE.r + 1.3, dd)) * 0.55 * smoothstep(NEST.r * 0.9, NEST.r + 0.9, nd);

  return h;
}

const EPS = 0.08;
export function normalAt(x: number, z: number, out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 }): { x: number; y: number; z: number } {
  const hx = heightAt(x + EPS, z) - heightAt(x - EPS, z);
  const hz = heightAt(x, z + EPS) - heightAt(x, z - EPS);
  const nx = -hx, ny = 2 * EPS, nz = -hz;
  const l = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
}

export function waterDepthAt(x: number, z: number): number {
  return Math.max(0, WATER_Y - heightAt(x, z));
}

/** Can a body of the given radius stand here? */
export function isWalkable(x: number, z: number, radius = 0.16): boolean {
  if (Math.hypot(x, z) > gladeEdge(x, z) - radius) return false;
  if (WATER_Y - heightAt(x, z) > WADE_DEPTH) return false;
  for (const o of OBSTACLES) {
    const d = Math.hypot(x - o.x, z - o.z);
    if (d < o.r + radius) return false;
  }
  return true;
}

/**
 * Push a point out of obstacles, deep water and the glade edge.
 * Returns true when a correction was applied.
 */
export function resolveCollision(p: { x: number; z: number }, radius: number): boolean {
  let hit = false;
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (const o of OBSTACLES) {
      const dx = p.x - o.x, dz = p.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + radius;
      if (d < min) {
        const k = d > 1e-5 ? min / d : 0;
        if (k === 0) { p.x = o.x + min; } else { p.x = o.x + dx * k; p.z = o.z + dz * k; }
        moved = true;
      }
    }
    // deep water: walk the point back up the bank
    if (WATER_Y - heightAt(p.x, p.z) > WADE_DEPTH) {
      const dx = p.x - POND.x, dz = p.z - POND.z;
      const d = Math.hypot(dx, dz) || 1;
      for (let i = 0; i < 12 && WATER_Y - heightAt(p.x, p.z) > WADE_DEPTH; i++) {
        p.x += (dx / d) * 0.04;
        p.z += (dz / d) * 0.04;
      }
      moved = true;
    }
    const r = Math.hypot(p.x, p.z);
    const edge = gladeEdge(p.x, p.z) - radius;
    if (r > edge) {
      p.x *= edge / r;
      p.z *= edge / r;
      moved = true;
    }
    if (!moved) break;
    hit = true;
  }
  return hit;
}

/** Nearest walkable point to (x,z), searching outward in rings. */
export function nearestWalkable(x: number, z: number, radius = 0.16): { x: number; z: number } {
  if (isWalkable(x, z, radius)) return { x, z };
  for (let ring = 1; ring <= 40; ring++) {
    const d = ring * 0.12;
    const steps = 8 + ring * 2;
    let best: { x: number; z: number } | null = null;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
      if (isWalkable(px, pz, radius)) { best = { x: px, z: pz }; break; }
    }
    if (best) return best;
  }
  return { x: clamp(x, -2, 2), z: clamp(z, -2, 2) };
}

/** A point on the pond shore nearest to (x,z) where a Kinling can stand and drink. */
export function nearestShore(x: number, z: number): { x: number; z: number; faceX: number; faceZ: number } {
  let dx = x - POND.x, dz = z - POND.z;
  let d = Math.hypot(dx, dz);
  if (d < 1e-3) { dx = 0; dz = 1; d = 1; }
  dx /= d; dz /= d;
  // prefer shore directions that face into the glade, not the far bank
  let best = { x: 0, z: 0, score: -Infinity };
  for (let i = -6; i <= 6; i++) {
    const a = Math.atan2(dx, dz) + i * 0.22;
    const sx = Math.sin(a), sz = Math.cos(a);
    let t = POND.r * 0.3;
    while (t < POND.r + 2 && !(WATER_Y - heightAt(POND.x + sx * t, POND.z + sz * t) <= WADE_DEPTH * 0.6)) t += 0.03;
    const px = POND.x + sx * (t + 0.05), pz = POND.z + sz * (t + 0.05);
    if (!isWalkable(px, pz, 0.14)) continue;
    const score = -Math.hypot(px - x, pz - z);
    if (score > best.score) best = { x: px, z: pz, score };
  }
  if (best.score === -Infinity) {
    const p = nearestWalkable(POND.x + dx * (POND.r + 0.3), POND.z + dz * (POND.r + 0.3));
    return { x: p.x, z: p.z, faceX: POND.x, faceZ: POND.z };
  }
  return { x: best.x, z: best.z, faceX: POND.x, faceZ: POND.z };
}

/** Segment (ax,az)->(bx,bz) stays walkable? Sampled check used for path smoothing. */
export function walkableSegment(ax: number, az: number, bx: number, bz: number, radius = 0.16): boolean {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(d / 0.1));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!isWalkable(ax + (bx - ax) * t, az + (bz - az) * t, radius)) return false;
  }
  return true;
}
