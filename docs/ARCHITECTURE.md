# Architecture

## Design in one paragraph

The creature is a **kinling**: a plump, big-eared quadruped with a luminous seed-lantern at the tip of its tail. The lantern is the anatomical feature with a behavioural job: it brightens with comfort and attention, pulses on a head tilt or a chirp, flickers on a fright and breathes slowly in sleep. The setting is a small glade ringed by trees, with a pond, a nest between the roots of an old tree, a sun-warmed stone, a berry bush, a hollow log and patches of tall grass. A slow day/night cycle (nights pass faster than days) changes the light, wakes the fireflies and makes the creature sleepy.

## Layers and ownership

```
input ─► World (sim) ◄─ save / offline
           │  events
           ▼
   rig · props · environment · audio · HUD · inspector   (read-only views of the sim)
```

The simulation (`src/sim`) imports nothing from rendering. It can be stepped headless, which is how the scenario tests run. Presentation subscribes to `world.events` and reads state each frame.

Responsibilities inside the agent, in the order `Kinling.update` runs them:

| Step | Module | Owns |
| --- | --- | --- |
| 1. Perception | `creature/senses.ts` | What has been sensed: Yuka `Vision` from the head with occluders, `MemorySystem` records, hearing (imprecise position), smell at nose range. Decisions read *believed* positions, never entity positions. |
| 2. Body mode | `creature/bodyStates.ts` | Yuka `StateMachine`: `FREE`, `SETTLED`, `INTERACT`, `ASLEEP`, `STARTLED`. Sequences action phases and contact effects, receives touch/sound/cue telegrams, cleans up on interruption. |
| 3. Motivation and intention | `creature/brain.ts` | Yuka `Think` with 17 custom `GoalEvaluator`s. Each exposes the terms of its score. |
| 4. Execution | `creature/goals.ts` | Atomic goals composed with `CompositeGoal` into activities with completion, failure, recovery and cleanup. |
| 5. Movement | `creature/Kinling.ts` | The **only** writer of position, heading and velocity. |
| 6. Needs and affect | `needs.ts`, `affect.ts` | Drift and relaxation. |
| — Expression | `render/creature/rig.ts`, `audio/` | Read-only. |

**Think vs. StateMachine.** `Think` decides *what to do* (eat, rest, fetch, investigate…). The state machine decides *what the body can do right now*. A goal asks for a posture or an action; the machine performs it through its phases and reports back. A fright changes the machine's state, which interrupts the brain; the reverse never happens.

**One owner of the transform.** Steering behaviours only propose a desired velocity. `Kinling.move` converts that into quadruped motion (it turns before it runs, with acceleration, braking and a speed-dependent turning circle), then resolves collisions with the same `isWalkable` rules the nav graph was built from, then sets height from the terrain. Animation adds purely visual offsets (leap arc, tail-chase spin, body lean) and never moves the entity.

**Toy handoff.** Toys run a small custom integrator (sphere on a heightfield; no physics engine). A toy is `free` (integrated), `carried` (position copied from the creature's mouth each tick, physics off) or `held` (by the player's pointer). `Kinling.take` and `Kinling.release` are the only transitions to and from `carried`; `release` is safe to call from any interruption and returns the toy to physics with a valid position and velocity.

**Stability.** The running activity keeps at least 85% of the desirability it had when chosen (so making progress cannot talk it out of finishing: each lap of water lowers thirst) plus a hysteresis bonus (+0.10). During its commitment period, and whenever the body is mid-action, other evaluators are scaled by 0.45 unless they declare themselves urgent for the current situation (a thrown toy may interrupt idling, never eating). Activities set a cooldown when they finish or fail. Failures are handled inside activities: an unreachable target fails `GoTo`, a toy that is not where it was believed triggers `Search`, a stuck path replans once and then fails.

**Timing.** `core/stepper.ts` runs the simulation at a fixed 1/60 s with at most 5 steps per frame; a longer stall is dropped, not replayed. Rendering interpolates position between steps. Arbitration runs every 0.5 s of simulated time (and immediately on notable events); perception runs at 10 Hz.

## Navigation

The glade is an analytic heightfield (`sim/terrain.ts`) with round obstacles, an irregular pond and a soft boundary. `sim/nav.ts` samples walkable ground into a grid graph of Yuka `NavNode`/`NavEdge` and searches it with Yuka `AStar`. Paths are string-pulled against `walkableSegment`, the same test movement uses, so a planned path can always be walked. The renderer builds its meshes from the same `heightAt`, obstacle list and landmarks.

## Yuka feature decisions

Verified against the installed source (`yuka@0.7.8`, `node_modules/yuka/build/yuka.module.js`).

| Feature | Decision | Where and why |
| --- | --- | --- |
| `GameEntity` | Used | Obstacles (with `lineOfSightTest`), berries, curios, the head (vision origin), the world's message source. |
| `MovingEntity` | Used | Toys and the wisp, so pursuit can predict them. `update` overridden with custom physics. |
| `Vehicle` | Used | The kinling. `update` overridden: Yuka steering in, custom locomotion and collision out. |
| `EntityManager` | Used | Owns every entity; drives updates, trigger processing and message dispatch. |
| `SteeringManager` | Used | Weighted sum of the behaviours below. |
| `FollowPathBehavior`, `Path`, `OnPathBehavior` | Used | Following A* paths and staying on them. Includes Yuka's arrive/seek internally. |
| `PursuitBehavior` | Used | Chasing a rolling toy or the wisp when the line to it is clear. |
| `WanderBehavior` | Used (subclassed) | The meander phase of exploring. Subclassed to draw jitter from the creature's seeded RNG; the stock version uses `Math.random`. |
| `ObstacleAvoidanceBehavior` | Used | Local avoidance of rocks, the log and trunks, backed by hard collision and by path planning. |
| `Think`, `GoalEvaluator` | Used | Intention selection. `characterBias` carries personality. |
| `Goal`, `CompositeGoal` | Used | All activities and their sub-steps. |
| `State`, `StateMachine` | Used | Body modes, action phases, telegram handling (including a global state). |
| `Vision` | Used | Field of view, range and occlusion from the head entity. |
| `MemorySystem`, `MemoryRecord` | Used | Short-term perception memory (30 s span): last sensed position, visibility, timestamps. |
| `Trigger`, `SphericalTriggerRegion` | Used | Pond shore (wet paws, ripples, splashes), nest (security recovers faster, better sleep), four tall-grass patches (rustle). |
| `MessageDispatcher`, `Telegram` | Used, immediate only | Touch, sound and cue events reach the body state machine as telegrams. |
| Delayed telegrams | **Not used** | `dispatchDelayedMessages` calls `delayedTelegrams.pop()` for whichever telegram came due, which removes the *last* one. With two pending messages of different delay, one is delivered repeatedly and another is lost. `World.post` keeps its own delay queue and hands due messages to Yuka for immediate dispatch; a test covers ordering and exactly-once delivery. |
| `Graph`, `NavNode`, `NavEdge`, `AStar`, `HeuristicPolicyEuclid` | Used | Path planning. |
| `FuzzyModule` and sets, `FuzzyRule`, `FuzzyAND` | Used | Two appraisals where gradual judgement beats thresholds: wanting rest from (energy, darkness), and caution from (novelty, nerve), which selects a bold, wary or timid approach. |
| `Task`, `TaskQueue` | Used | Autosave serialisation runs in browser idle time. |
| `Ray`, `Vector3` | Used | Line-of-sight maths and entity state. |
| `NavMesh`, `NavMeshLoader`, `Corridor`, `CostTable` | Omitted | There is no polygonal source mesh; the habitat is a heightfield with round obstacles. A grid graph built from the walkability function stays consistent with collision by construction. |
| `CellSpacePartitioning`, `BVH` | Omitted | Fewer than 40 entities; a spatial index would cost more than it saves. |
| `Separation`, `Alignment`, `Cohesion`, `Interpose`, `OffsetPursuit` | Omitted | Single agent; nothing to flock with or interpose between. |
| Standalone `Seek`, `Arrive`, `Flee`, `Evade` | Omitted | Seek and arrive are used inside path following. Retreat is a planned path to the nest; a fright's hop back is a short impulse in the movement controller. |
| `Regulator` | Omitted | It reads wall-clock time, which would make decision cadence non-deterministic in tests. Cadence is counted in simulated seconds instead. |
| `Time` | Omitted | Replaced by the fixed-step accumulator. |
| `Smoother` | Omitted | Heading comes from the custom turn-rate model. |
| `toJSON` / `fromJSON` | Omitted | Saves use a small versioned format of the individual's own data. Serialising goal and state graphs would be brittle across versions and store nothing worth keeping. |
| `Dijkstra`, `BFS`, `DFS`, `RectangularTriggerRegion`, `OBB`, `AABB`, `ConvexHull`, `SAT`, `Polyhedron`, `MeshGeometry`, `EventDispatcher`, `Logger` | Omitted | No behaviour needs them. |

No other AI, physics or animation library is used. The needs, affect, habituation, memory and association systems are small custom modules because each is a few explicit rules that are easier to control and explain directly.

## Four separate layers of "who it is"

| Layer | File | Timescale | Example |
| --- | --- | --- | --- |
| Bodily needs | `needs.ts` | minutes | nourishment, hydration, energy, stimulation, social, security |
| Affect | `affect.ts` | seconds | valence, arousal, wariness, interest |
| Personality | `identity.ts` | permanent, seeded | curiosity, sociability, confidence, playfulness, persistence, sensitivity; coat, voice, touch preferences |
| Learned | `learning.ts`, `memory.ts` | grows with experience | below |

Needs only change through things that happen: running costs energy (`0.0048 · exertion^1.5` per second on top of a base rate), sleep restores it, each lap of water adds hydration, each berry eaten adds nourishment, play adds stimulation while it lasts.

## What is learned, exactly

Every rule changes a stored number that a later decision reads. All are in `sim/learning.ts`.

| What | Rule | Read by |
| --- | --- | --- |
| **Liking for each activity** (ball, rattle, wisp) | After each play episode, `a ← a + 0.18·(e − a)`, where enjoyment `e ∈ [0,1]` is computed from that episode: catches, bats, whether the player joined in, whether the toy was lost, fatigue, mood. | Play, fetch, wisp and offer-a-toy evaluators (the liking multiplies their score), and which toy it brings you. |
| **Habituation** per stimulus kind | Each exposure that proves harmless: `h ← h + r·(1 − h)`, `r = 0.3·(1.15 − 0.6·sensitivity)`. Recovers as `h·exp(−Δt / 3 h)`. | Startle strength is multiplied by `(1 − h)`. |
| **Familiarity** per kind of object | `f ← f + amount·(1 − f)`; amount depends on how closely it investigated (0.14 watching, 0.42 a careful sniff, 0.6 a bold one). | Novelty in the investigate evaluator and in the fuzzy caution appraisal. Toys are only played with once familiar. |
| **Cue association** (`come`, `sit`) | Rescorla–Wagner. Rewarded response: `s ← s + 0.24·(1 − s)`. Unrewarded response: `s ← s − 0.06·s`. A reward is a liked stroke or a berry within the wait window after it responds. | Probability of responding correctly, and latency. |
| **Bond** | Small signed steps: gentle strokes, being fed and playing together raise it; being poked awake, unwelcome handling and ignored invitations lower it. | Willingness to come, how close it sits, whether it retrieves or keeps a toy, how it greets you, whether it shies from your hand. |
| **Places** | Up to seven remembered spots with a comfort value: `c ← c + 0.22·(v − c)` when something good or bad happens there (a nap's quality, being stroked). | Where it goes to rest and where it carries a toy it likes. |
| **Touch tolerance** | Per body region, a slow bounded drift when disliked handling is tolerated under high bond. | Whether a stroke there is enjoyed. |
| **Trait drift** | Each trait may shift by at most ±0.12 from its seeded value, in steps of about 0.005 (confidence from facing new things and from getting used to a noise; playfulness from good games; sociability from enjoyed strokes). | Everything that reads personality. The individual stays recognisable. |
| **Trodden ground** | An 8×8 map of how well it knows each part of the glade. | Curious individuals explore less-trodden ground. |

### Memory

Two systems, with different jobs:

- **Short-term (Yuka `MemorySystem`)**: what was sensed in the last 30 s and where. This is what lets it go to where it *last saw* the ball and be wrong.
- **Long-term (`sim/memory.ts`)**: at most 64 episodes (`kind`, subject, place, time, valence, salience, count, note), plus where each toy was last seen. A repeat of the same kind of experience in the same area within 15 minutes merges into the existing episode and strengthens it. Salience decays exponentially, more slowly for strongly felt and often-repeated episodes. On waking from a nap, faded episodes are dropped and the six strongest are firmed up slightly. When full, the least salient episode is evicted.

Memory payoffs you can see without the inspector: it rests where it has slept well or been stroked; it carries a well-liked toy to its favourite place; after you have been away it runs to greet you and then fetches its favourite toy; with nothing to eat it goes and asks where it was last fed; after a reload it walks straight to where it last saw a toy.

## Rendering and animation

- **Sculpt** (`render/creature/sdf.ts`, `anatomy.ts`, `build.ts`): about 40 round cones and ellipsoids, blended with a smooth minimum and extracted with naive surface nets into one connected mesh (around 34 k triangles). Skin weights come from the same volumes, so joints blend without manual painting. Ears are lofted leaves; eyes are spheres in carved sockets with rotating lid caps; the coat, markings, strand length and glow spots are painted per vertex from rest-pose position and the individual's seed.
- **Fur**: 6, 10 or 16 alpha-tested shells over the skinned mesh, with strands hashed from rest position so they hold together across shells, combed back, and length varying by body region.
- **Rig** (`render/creature/rig.ts`): pose channels are set each frame from posture, action performance, emotion and touch, then smoothed by critically damped springs, which is what keeps interruptions continuous. Feet are planted in world space and lift when a gait clock says so (lateral-sequence walk, diagonal trot, bound); landing spots are predicted from velocity and turning. The spine rides on the feet; legs are two-bone IK with a pole; neck and head share a look-at; tail and ears are verlet chains pulled toward an animated pose. Eyes move first, then the head, then (if a goal wants it) the body.
- **Quality tiers** change pixel ratio, shadow resolution, shell count, grass density, MSAA and bloom. They do not change behaviour.

## Saves

`sim/save.ts` writes a versioned JSON object: identity (seed, name, birth time), needs, affect, all learned values, episodic memory, position and posture, lifetime counters, toy positions, berries, curio, bush stock, simulated age, time of day, and the wall-clock time of saving. Loading validates and clamps every field and re-derives the identity from its seed. The previous good save is kept as a backup and restored automatically if the primary is unreadable.

`sim/offline.ts` handles absence. Gaps under 45 s count as continuous. Longer gaps relax each need toward a plausible self-care level with its own time constant (it slept, drank, foraged; it is bored and has missed you), decay memory, regrow the bush, and place the creature at its preferred resting spot, asleep with a probability that rises at night. The effect is capped at 12 hours. Negative, zero or non-finite gaps do nothing.
