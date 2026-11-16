import { makeIdentity } from '../src/sim/identity';
import { World } from '../src/sim/world';

export const DT = 1 / 60;

export function makeWorld(seed = 7): World {
  return new World(makeIdentity(seed, 'Test'));
}

/** Advance the simulation by `seconds`, optionally stopping early. */
export function run(world: World, seconds: number, until?: () => boolean, dt = DT): number {
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) {
    world.step(dt);
    if (until?.()) return (i + 1) * dt;
  }
  return seconds;
}

export function goalLog(world: World): string[] {
  const log: string[] = [];
  world.events.on('goal', (g) => log.push(`${world.time.toFixed(1)}s ${g.name} [${g.reason}]`));
  return log;
}
