/** Hash-based value noise, deterministic and dependency-free (shared by terrain, layout and sculpting). */

function h2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function h3(ix: number, iy: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1440662683) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

export function noise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = fade(x - ix), fy = fade(y - iy);
  const a = h2(ix, iy, seed), b = h2(ix + 1, iy, seed);
  const c = h2(ix, iy + 1, seed), d = h2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function noise3(x: number, y: number, z: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x00 = l(h3(ix, iy, iz, seed), h3(ix + 1, iy, iz, seed), fx);
  const x10 = l(h3(ix, iy + 1, iz, seed), h3(ix + 1, iy + 1, iz, seed), fx);
  const x01 = l(h3(ix, iy, iz + 1, seed), h3(ix + 1, iy, iz + 1, seed), fx);
  const x11 = l(h3(ix, iy + 1, iz + 1, seed), h3(ix + 1, iy + 1, iz + 1, seed), fx);
  return l(l(x00, x10, fy), l(x01, x11, fy), fz);
}

/** Fractal noise in [0,1]. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let amp = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y, seed + i * 17) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}
export function fbm3(x: number, y: number, z: number, octaves = 3, seed = 0): number {
  let amp = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x, y, z, seed + i * 17) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}
