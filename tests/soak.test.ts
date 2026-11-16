import { describe, expect, it } from 'vitest';
import { NEED_KEYS } from '../src/sim/needs';
import { isWalkable } from '../src/sim/terrain';
import { CURIO_KINDS } from '../src/sim/types';
import { Rng } from '../src/core/rng';
import { DT, makeWorld } from './helpers';

describe('long sessions stay healthy', () => {
  it('twenty simulated minutes of a meddling player, across temperaments, break nothing', () => {
    for (const seed of [1, 4, 9, 12, 18, 21]) {
      const w = makeWorld(seed);
      const k = w.kinling;
      const hand = new Rng(seed * 31);
      const goals = new Set<string>();
      let switches = 0;
      w.events.on('goal', (g) => { goals.add(g.name.split(' ')[0]); switches++; });
      const steps = 60 * 60 * 20;
      for (let i = 0; i < steps; i++) {
        w.step(DT);
        // every few seconds the player does something, sensible or not
        if (i % 240 === 0) {
          const x = hand.range(-5, 5), z = hand.range(-4, 5);
          switch (hand.int(0, 9)) {
            case 0: w.dropBerry(x, z); break;
            case 1: w.tossToy('ball', x, z); break;
            case 2: w.tossToy('rattle', x, z); break;
            case 3: w.cue('come'); break;
            case 4: w.cue('sit'); break;
            case 5: for (let s = 0; s < 6; s++) w.touch(hand.pick(['head', 'back', 'tail', 'paws', 'chin'] as const), hand.chance(0.2) ? 'tap' : 'stroke', k.position.x, k.position.y + 0.3, k.position.z); break;
            case 6: w.placeCurio(hand.pick(CURIO_KINDS), x, z); break;
            case 7: w.setWisp(true, x, z); break;
            case 8: w.setWisp(false); w.removeCurio(); break;
            default: w.holdToy('ball', x, 0.5, z); w.releaseToy('ball', hand.range(-3, 3), 2, hand.range(-3, 3));
          }
        }
        if (w.wisp.on && i % 20 === 0) w.setWisp(true, w.wisp.target.x + hand.range(-0.4, 0.4), w.wisp.target.z + hand.range(-0.4, 0.4));
        if (i % 30 === 0) {
          expect(Number.isFinite(k.position.x + k.position.z + k.heading + k.speed)).toBe(true);
          expect(isWalkable(k.position.x, k.position.z, 0.08), `seed ${seed} at ${w.time.toFixed(0)}s (${k.position.x.toFixed(2)}, ${k.position.z.toFixed(2)})`).toBe(true);
          for (const n of NEED_KEYS) { expect(k.needs.values[n]).toBeGreaterThanOrEqual(0); expect(k.needs.values[n]).toBeLessThanOrEqual(1); }
          for (const t of Object.values(w.toys)) expect(Number.isFinite(t.position.x + t.position.y + t.position.z)).toBe(true);
          if (k.carrying) expect(k.carrying.state).toBe('carried');
          for (const t of Object.values(w.toys)) if (t.state === 'carried') expect(k.carrying).toBe(t);
        }
      }
      // it lived a varied life, without thrashing between intentions
      expect(goals.size, [...goals].join(', ')).toBeGreaterThanOrEqual(6);
      expect(switches / 20, `seed ${seed}: ${switches} goal changes`).toBeLessThan(12); // per simulated minute
      expect(k.ltm.data.episodes.length).toBeGreaterThan(3);
      expect(k.ltm.data.episodes.length).toBeLessThanOrEqual(64);
      // it never starved or collapsed while food, water and rest were available
      expect(k.needs.values.hydration).toBeGreaterThan(0.1);
      expect(k.needs.values.energy).toBeGreaterThan(0.05);
    }
  }, 120000);
});
