import { describe, expect, it } from 'vitest';
import { RUN_SPEED } from '../src/sim/needs';
import { isWalkable } from '../src/sim/terrain';
import type { World } from '../src/sim/world';
import type { KEvaluator } from '../src/sim/creature/brain';
import { DT, goalLog, makeWorld, run } from './helpers';

const evaluator = (w: World, name: string): KEvaluator => w.kinling.brain.evaluators.find((e) => e.name === name)!;
/** Skip the "what is that?" phase so a scenario can focus on something else. */
const familiar = (w: World): void => { for (const k of ['ball', 'rattle', 'berry', 'wisp', 'hand']) w.kinling.learn.data.familiarity[k] = 1; };

describe('needs compete without thrashing', () => {
  it('a hungry, tired creature settles on one need, finishes it, then tends the other', () => {
    const w = makeWorld(11);
    familiar(w);
    const k = w.kinling;
    k.needs.values.nourishment = 0.22;
    k.needs.values.energy = 0.2;
    k.needs.values.hydration = 0.9;
    k.needs.values.social = 0.95;
    k.needs.values.stimulation = 0.95;
    const log = goalLog(w);
    let ate = false, slept = false;
    const n0 = k.needs.values.nourishment;
    run(w, 240, () => {
      if (k.needs.values.nourishment > n0 + 0.1) ate = true;
      if (k.asleep) slept = true;
      return ate && slept;
    });
    expect(ate, log.join('\n')).toBe(true);
    expect(slept, log.join('\n')).toBe(true);
    // no flip-flopping between the two on the way
    const switches = log.filter((l) => / eat | rest /.test(l)).length;
    expect(switches, log.join('\n')).toBeLessThanOrEqual(4);
  });

  it('activities have real effects: running tires, sleep restores, water quenches', () => {
    const w = makeWorld(5);
    familiar(w);
    const k = w.kinling;
    k.brain.suspended = true;
    const e0 = k.needs.values.energy;
    k.travelTo(4, 3, 'run');
    run(w, 6);
    const afterRun = k.needs.values.energy;
    expect(afterRun).toBeLessThan(e0 - 0.004);
    k.stopTravel();
    k.brain.suspended = false;
    k.needs.values.hydration = 0.15;
    k.needs.values.energy = 0.9;
    run(w, 60, () => k.needs.values.hydration > 0.5);
    expect(k.needs.values.hydration).toBeGreaterThan(0.5);
    k.needs.values.energy = 0.12;
    run(w, 90, () => k.asleep);
    expect(k.asleep).toBe(true);
    const asleepAt = k.needs.values.energy;
    run(w, 30);
    expect(k.needs.values.energy).toBeGreaterThan(asleepAt + 0.1);
  });
});

describe('perception is not world truth', () => {
  it('searches where it last saw a toy, then finds or gives up', () => {
    const w = makeWorld(7);
    familiar(w);
    const k = w.kinling;
    const ball = w.toys.ball;
    // it sees the ball in the open…
    k.place(0.2, -1.6, 0);
    ball.position.set(0.9, ball.position.y, 0.4);
    k.brain.suspended = true;
    run(w, 1);
    expect(k.senses.sees(ball)).toBe(true);
    // …then looks away while it is moved behind the log
    k.place(0.2, -1.6, Math.PI);
    run(w, 1.5);
    expect(k.senses.sees(ball)).toBe(false);
    ball.position.set(-5.3, ball.position.y, -3.1);
    const believed = k.senses.believed(ball)!;
    expect(Math.hypot(believed.x - 0.9, believed.z - 0.4)).toBeLessThan(0.3);
    expect(Math.hypot(believed.x - ball.position.x, believed.z - ball.position.z)).toBeGreaterThan(4);
    // now it wants to play, and the ball is the toy it likes
    k.learn.data.affinity.ball = 0.9; k.learn.data.affinity.rattle = 0.02;
    k.needs.values.stimulation = 0.05;
    k.needs.values.energy = 0.95;
    k.brain.suspended = false;
    const phases = new Set<string>();
    const labels = new Set<string>();
    let found = false;
    run(w, 90, () => {
      const a = k.brain.activity;
      if (a) { phases.add(a.phase); labels.add(a.label); }
      if ([...phases].some((p) => p.startsWith('looking for')) && k.senses.sees(ball)) found = true;
      return found || k.ltm.recall('lostToy', 'ball') !== null;
    });
    expect([...labels].some((l) => l.includes('ball')), [...labels].join()).toBe(true);
    expect([...phases].some((p) => p.startsWith('looking for')), [...phases].join(' | ')).toBe(true);
    expect(found || k.ltm.recall('lostToy', 'ball') !== null).toBe(true);
    expect(k.carrying === null || k.carrying === ball).toBe(true);
  });

  it('abandons a toy it can see but cannot reach, and stays in a valid state', () => {
    const w = makeWorld(7);
    familiar(w);
    const k = w.kinling;
    const ball = w.toys.ball;
    k.place(-0.5, 1.0, -1.2);
    // out in the middle of the pond, pinned there
    k.learn.data.affinity.ball = 0.9; k.learn.data.affinity.rattle = 0.02;
    k.needs.values.stimulation = 0.05;
    let ended = false;
    const log = goalLog(w);
    run(w, 80, () => {
      ball.position.set(-3.5, -0.15, 1.9);
      ball.resting = true;
      const playing = k.brain.activity?.label.includes('ball');
      if (playing) ended = false;
      else if (log.some((l) => l.includes('ball'))) ended = true;
      return ended && w.time > 30;
    });
    expect(log.some((l) => l.includes('ball')), log.join('\n')).toBe(true);
    expect(ended, log.join('\n')).toBe(true);
    expect(k.carrying).toBeNull();
    expect(['FREE', 'SETTLED', 'INTERACT']).toContain(k.mode);
    expect(isWalkable(k.position.x, k.position.z, 0.1)).toBe(true);
  });

  it('cannot see through the log or tree trunks', () => {
    const w = makeWorld(3);
    const k = w.kinling;
    k.brain.suspended = true;
    const ball = w.toys.ball;
    // creature on one side of the log, ball directly behind it
    k.place(-2.9, -2.0, Math.atan2(-4.3 - -2.9, -2.7 - -2.0));
    ball.position.set(-5.5, ball.position.y, -3.3);
    run(w, 1);
    expect(k.senses.sees(ball)).toBe(false);
    ball.position.set(-2.2, ball.position.y, -3.4);
    k.look(ball.position.x, 0.1, ball.position.z, 3, 9);
    run(w, 1);
    expect(k.senses.sees(ball)).toBe(true);
  });
});

describe('surprise, interruption and recovery', () => {
  it('a sudden chime interrupts eating, the body recovers, and it calms down', () => {
    const w = makeWorld(21);
    familiar(w);
    const k = w.kinling;
    k.needs.values.nourishment = 0.15;
    k.place(1.5, 1.5, 0);
    w.dropBerry(1.6, 2.4);
    run(w, 30, () => k.action?.kind === 'eat' || k.action?.kind === 'sniff');
    expect(k.mode).toBe('INTERACT');
    w.emitSound({ kind: 'chime', x: k.position.x + 0.6, z: k.position.z + 0.4, loud: 0.9, sourceId: 'test' });
    run(w, 0.5);
    expect(k.mode).toBe('STARTLED');
    expect(k.action).toBeNull();
    expect(k.affect.wariness).toBeGreaterThan(0.3);
    const peak = k.affect.wariness;
    run(w, 12, () => k.mode !== 'STARTLED');
    expect(k.mode).not.toBe('STARTLED');
    expect(k.brain.suspended).toBe(false);
    run(w, 60);
    expect(k.affect.wariness).toBeLessThan(peak * 0.5);
    expect(k.ltm.recall('startle', 'chime')).not.toBeNull();
    expect(isWalkable(k.position.x, k.position.z, 0.1)).toBe(true);
  });

  it('drops what it is carrying when frightened, leaving the toy free', () => {
    const w = makeWorld(21);
    const k = w.kinling;
    k.brain.suspended = true;
    k.take(w.toys.ball);
    run(w, 0.5);
    expect(w.toys.ball.state).toBe('carried');
    w.emitSound({ kind: 'chime', x: k.position.x + 0.5, z: k.position.z, loud: 1, sourceId: 'test' });
    run(w, 0.6);
    expect(k.carrying).toBeNull();
    expect(w.toys.ball.state).toBe('free');
    run(w, 3);
    expect(w.toys.ball.position.y).toBeLessThan(0.6);
  });

  it('habituates: the same harmless sound startles less each time', () => {
    const w = makeWorld(21);
    familiar(w);
    const k = w.kinling;
    let startles = 0;
    const firstHalf: number[] = [];
    w.events.on('mode', (m) => { if (m.mode === 'STARTLED') startles++; });
    for (let i = 0; i < 12; i++) {
      const before = startles;
      k.needs.values.energy = 0.9;
      if (k.asleep) k.rise();
      w.emitSound({ kind: 'chime', x: k.position.x + 0.7, z: k.position.z + 0.3, loud: 0.8, sourceId: 'test' });
      run(w, 14);
      firstHalf.push(startles - before);
    }
    const early = firstHalf.slice(0, 3).reduce((a, b) => a + b, 0);
    const late = firstHalf.slice(-3).reduce((a, b) => a + b, 0);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
    expect(k.learn.habituation('chime', k.now)).toBeGreaterThan(0.6);
  });
});

describe('sensory messages', () => {
  it('delivers each delayed sound exactly once, in order, even when several are pending', () => {
    const w = makeWorld(4);
    const k = w.kinling;
    k.brain.suspended = true;
    const heard: string[] = [];
    const original = k.senses.hear.bind(k.senses);
    k.senses.hear = (e) => { heard.push(`${e.kind}@${e.distance.toFixed(1)}`); original(e); };
    // three sounds at different distances → three different latencies, queued together
    w.emitSound({ kind: 'plop', x: k.position.x + 6, z: k.position.z, loud: 0.5 });
    w.emitSound({ kind: 'bounce', x: k.position.x + 0.5, z: k.position.z, loud: 0.5 });
    w.emitSound({ kind: 'splash', x: k.position.x + 3, z: k.position.z, loud: 0.5 });
    run(w, 1);
    expect(heard).toEqual(['bounce@0.5', 'splash@3.0', 'plop@6.0']);
  });
});

describe('individuals differ but obey the same physics', () => {
  it('different seeds give different temperaments and different first choices', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const approaches = new Set<string>();
    const firstGoals = new Set<string>();
    let minConf = 1, maxConf = 0;
    for (const seed of seeds) {
      const w = makeWorld(seed);
      const k = w.kinling;
      minConf = Math.min(minConf, k.traits.confidence);
      maxConf = Math.max(maxConf, k.traits.confidence);
      const log = goalLog(w);
      let maxSpeed = 0;
      let offGround = false;
      for (let i = 0; i < 60 * 40; i++) {
        w.step(DT);
        maxSpeed = Math.max(maxSpeed, k.speed);
        if (i % 20 === 0 && !isWalkable(k.position.x, k.position.z, 0.1)) offGround = true;
        const a = k.brain.activity;
        if (a?.label.startsWith('investigate')) approaches.add(a.phase.split(' ')[0]);
      }
      firstGoals.add(log.slice(0, 3).map((l) => l.split(' ').slice(1, 3).join(' ')).join('>'));
      expect(maxSpeed).toBeLessThanOrEqual(RUN_SPEED + 0.4); // pounces briefly exceed a run
      expect(offGround).toBe(false);
    }
    expect(maxConf - minConf).toBeGreaterThan(0.25);
    expect(approaches.size).toBeGreaterThanOrEqual(2); // e.g. "trotting", "approaching", "watching"
    expect(firstGoals.size).toBeGreaterThanOrEqual(2);
  });

  it('the same seed is the same individual', () => {
    const a = makeWorld(42), b = makeWorld(42);
    expect(a.kinling.traits).toEqual(b.kinling.traits);
    expect(a.identity.look).toEqual(b.identity.look);
    run(a, 30); run(b, 30);
    expect(a.kinling.position.x).toBeCloseTo(b.kinling.position.x, 6);
    expect(a.kinling.brain.activity?.label).toBe(b.kinling.brain.activity?.label);
  });
});

describe('autonomy', () => {
  it('lets a thrown toy pass when it is exhausted, but chases when lively', () => {
    const chases = (energy: number): boolean => {
      const w = makeWorld(9);
      familiar(w);
      const k = w.kinling;
      k.learn.data.bond = 0.6;
      k.needs.values.energy = energy;
      k.needs.values.nourishment = 0.9; k.needs.values.hydration = 0.9;
      k.place(0, 0, 0);
      w.toys.ball.position.set(0.5, w.toys.ball.position.y, 1);
      run(w, 1);
      w.tossToy('ball', 2.5, 3.5);
      let chased = false;
      run(w, 8, () => { if (k.brain.activity?.label === 'fetch ball') chased = true; return chased; });
      return chased;
    };
    expect(chases(0.9)).toBe(true);
    expect(chases(0.08)).toBe(false);
  });
});

export { evaluator };
