/**
 * Implicit-surface sculpting. The Kinling's body is described as a blend of
 * smooth primitives and extracted once into a single connected mesh, so limbs,
 * neck and haunches flow into each other instead of meeting at seams.
 *
 * Extraction uses naive surface nets (no lookup tables): one vertex per
 * boundary cell at the mean of its edge crossings, one quad per sign-changing
 * grid edge. Vertices are then projected onto the true isosurface.
 */

export type Vec3 = [number, number, number];

export type Prim =
  | { type: 'sphere'; c: Vec3; r: number }
  | { type: 'ellipsoid'; c: Vec3; r: Vec3 }
  | { type: 'cone'; a: Vec3; b: Vec3; r1: number; r2: number };

export interface BodyPart {
  prim: Prim;
  /** Bone this primitive follows. */
  bone: string;
  /** Blend radius with the rest of the body. */
  k: number;
  /** Carve instead of add. */
  subtract?: boolean;
  /** Skin falloff scale (bigger = influence reaches further past the primitive). */
  reach?: number;
  /** Excluded from skin weighting (pure shape detail). */
  noSkin?: boolean;
}

export function primDistance(p: Prim, x: number, y: number, z: number): number {
  switch (p.type) {
    case 'sphere':
      return Math.hypot(x - p.c[0], y - p.c[1], z - p.c[2]) - p.r;
    case 'ellipsoid': {
      const px = (x - p.c[0]) / p.r[0], py = (y - p.c[1]) / p.r[1], pz = (z - p.c[2]) / p.r[2];
      const k0 = Math.hypot(px, py, pz);
      if (k0 < 1e-6) return -Math.min(p.r[0], p.r[1], p.r[2]);
      const k1 = Math.hypot(px / p.r[0], py / p.r[1], pz / p.r[2]);
      return (k0 * (k0 - 1)) / k1;
    }
    case 'cone': {
      // exact round cone (after Inigo Quilez)
      const bax = p.b[0] - p.a[0], bay = p.b[1] - p.a[1], baz = p.b[2] - p.a[2];
      const l2 = bax * bax + bay * bay + baz * baz;
      const rr = p.r1 - p.r2;
      const a2 = l2 - rr * rr;
      const il2 = 1 / l2;
      const pax = x - p.a[0], pay = y - p.a[1], paz = z - p.a[2];
      const yy = pax * bax + pay * bay + paz * baz;
      const zz = yy - l2;
      const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
      const x2 = qx * qx + qy * qy + qz * qz;
      const y2 = yy * yy * l2;
      const z2 = zz * zz * l2;
      const kk = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > kk) return Math.sqrt(x2 + z2) * il2 - p.r2;
      if (Math.sign(yy) * a2 * y2 < kk) return Math.sqrt(x2 + y2) * il2 - p.r1;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - p.r1;
    }
  }
}

const smin = (a: number, b: number, k: number): number => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

export function bodyDistance(parts: readonly BodyPart[], x: number, y: number, z: number): number {
  let d = 1e9;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.subtract) continue;
    d = smin(d, primDistance(part.prim, x, y, z), part.k);
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.subtract) continue;
    d = -smin(-d, primDistance(part.prim, x, y, z), part.k);
  }
  return d;
}

export interface SurfaceMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export function extractSurface(
  f: (x: number, y: number, z: number) => number,
  min: Vec3,
  max: Vec3,
  cell: number,
): SurfaceMesh {
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1;
  const ny = Math.ceil((max[1] - min[1]) / cell) + 1;
  const nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const values = new Float32Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number): number => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) values[idx(i, j, k)] = f(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);

  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i: number, j: number, k: number): number => i + (nx - 1) * (j + (ny - 1) * k);
  const pos: number[] = [];
  const corner = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = values[idx(i + corner[c][0], j + corner[c][1], k + corner[c][2])];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = edges[e][0], b = edges[e][1];
          const va = cv[a], vb = cv[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
          sy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          sz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
          n++;
        }
        cellVert[cidx(i, j, k)] = pos.length / 3;
        pos.push(min[0] + (i + sx / n) * cell, min[1] + (j + sy / n) * cell, min[2] + (k + sz / n) * cell);
      }

  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c);
    else tris.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = values[idx(i, j, k)];
        const s0 = v0 < 0;
        if (s0 !== values[idx(i + 1, j, k)] < 0)
          quad(cellVert[cidx(i, j - 1, k - 1)], cellVert[cidx(i, j, k - 1)], cellVert[cidx(i, j, k)], cellVert[cidx(i, j - 1, k)], !s0);
        if (s0 !== values[idx(i, j + 1, k)] < 0)
          quad(cellVert[cidx(i - 1, j, k - 1)], cellVert[cidx(i - 1, j, k)], cellVert[cidx(i, j, k)], cellVert[cidx(i, j, k - 1)], !s0);
        if (s0 !== values[idx(i, j, k + 1)] < 0)
          quad(cellVert[cidx(i - 1, j - 1, k)], cellVert[cidx(i, j - 1, k)], cellVert[cidx(i, j, k)], cellVert[cidx(i - 1, j, k)], !s0);
      }

  // Project onto the isosurface and take analytic-gradient normals.
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  const e = cell * 0.35;
  for (let v = 0; v < positions.length; v += 3) {
    let x = positions[v], y = positions[v + 1], z = positions[v + 2];
    let gx = 0, gy = 1, gz = 0;
    for (let it = 0; it < 3; it++) {
      gx = f(x + e, y, z) - f(x - e, y, z);
      gy = f(x, y + e, z) - f(x, y - e, z);
      gz = f(x, y, z + e) - f(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      if (it < 2) {
        const d = f(x, y, z);
        const step = Math.max(-cell, Math.min(cell, d));
        x -= gx * step; y -= gy * step; z -= gz * step;
      }
    }
    positions[v] = x; positions[v + 1] = y; positions[v + 2] = z;
    normals[v] = gx; normals[v + 1] = gy; normals[v + 2] = gz;
  }
  return { positions, normals, indices: new Uint32Array(tris) };
}
