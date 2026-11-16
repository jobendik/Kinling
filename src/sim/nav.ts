/**
 * Navigation for the glade. The habitat is a heightfield with round
 * obstacles, an irregular pond and a soft boundary, so the walkable area is
 * sampled into a grid graph (Yuka Graph + NavNode/NavEdge) and searched with
 * Yuka's A*. Paths are then string-pulled against the very same walkability
 * test that collision uses, which keeps planning and movement consistent.
 */
import { AStar, Graph, HeuristicPolicyEuclid, NavEdge, NavNode, Vector3 } from 'yuka';
import { isWalkable, nearestWalkable, walkableSegment } from './terrain';
import type { Vec2 } from './types';

const CELL = 0.3;
const HALF = 8.4;
const N = Math.round((HALF * 2) / CELL);
export const BODY_RADIUS = 0.17;

export class Nav {
  readonly graph = new Graph();
  private nodeAt = new Int32Array(N * N).fill(-1);
  private positions: Vec2[] = [];
  readonly nodeCount: number;

  constructor() {
    let index = 0;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = -HALF + (i + 0.5) * CELL, z = -HALF + (j + 0.5) * CELL;
        if (!isWalkable(x, z, BODY_RADIUS)) continue;
        this.nodeAt[i + j * N] = index;
        this.positions.push({ x, z });
        this.graph.addNode(new NavNode(index, new Vector3(x, 0, z)));
        index++;
      }
    this.nodeCount = index;
    const link = (a: number, b: number): void => {
      const pa = this.positions[a], pb = this.positions[b];
      if (!walkableSegment(pa.x, pa.z, pb.x, pb.z, BODY_RADIUS)) return;
      this.graph.addEdge(new NavEdge(a, b, Math.hypot(pa.x - pb.x, pa.z - pb.z)));
    };
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const a = this.nodeAt[i + j * N];
        if (a < 0) continue;
        const right = i + 1 < N ? this.nodeAt[i + 1 + j * N] : -1;
        const down = j + 1 < N ? this.nodeAt[i + (j + 1) * N] : -1;
        const dr = i + 1 < N && j + 1 < N ? this.nodeAt[i + 1 + (j + 1) * N] : -1;
        const dl = i > 0 && j + 1 < N ? this.nodeAt[i - 1 + (j + 1) * N] : -1;
        if (right >= 0) link(a, right);
        if (down >= 0) link(a, down);
        if (dr >= 0) link(a, dr);
        if (dl >= 0) link(a, dl);
      }
  }

  private nearestNode(x: number, z: number): number {
    const ci = Math.floor((x + HALF) / CELL), cj = Math.floor((z + HALF) / CELL);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= 6 && best < 0; ring++)
      for (let j = cj - ring; j <= cj + ring; j++)
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          const n = this.nodeAt[i + j * N];
          if (n < 0) continue;
          const p = this.positions[n];
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < bd) { bd = d; best = n; }
        }
    return best;
  }

  /**
   * A walkable polyline from `from` to (as near as possible to) `to`.
   * Returns null when the destination cannot be reached at all.
   */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const goal = isWalkable(to.x, to.z, BODY_RADIUS) ? to : nearestWalkable(to.x, to.z, BODY_RADIUS);
    if (walkableSegment(from.x, from.z, goal.x, goal.z, BODY_RADIUS)) return [{ x: from.x, z: from.z }, { x: goal.x, z: goal.z }];
    const a = this.nearestNode(from.x, from.z), b = this.nearestNode(goal.x, goal.z);
    if (a < 0 || b < 0) return null;
    const search = new AStar(this.graph, a, b);
    search.heuristic = HeuristicPolicyEuclid;
    search.search();
    if (!search.found) return null;
    const raw: Vec2[] = [{ x: from.x, z: from.z }];
    for (const n of search.getPath()) raw.push(this.positions[n]);
    raw.push({ x: goal.x, z: goal.z });
    // string pulling: skip ahead to the farthest visible point
    const out: Vec2[] = [raw[0]];
    let i = 0;
    while (i < raw.length - 1) {
      let j = raw.length - 1;
      while (j > i + 1 && !walkableSegment(raw[i].x, raw[i].z, raw[j].x, raw[j].z, BODY_RADIUS)) j--;
      out.push({ x: raw[j].x, z: raw[j].z });
      i = j;
    }
    return out;
  }

  pathLength(path: Vec2[]): number {
    let d = 0;
    for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    return d;
  }
}
