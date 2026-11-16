# Implementation checklist

Status against the brief. "Done" means implemented and exercised by a test or a browser check; "Built" means implemented and seen working in captured frames but not covered by an automated check; "Unverified" means it exists but nobody has confirmed it does its job.

## Creature
- [x] Original design, sculpted as one connected implicit surface with automatic skinning — **Built**
- [x] Distinctive feature with a behavioural role: the tail lantern (comfort, attention, fright, sleep) — **Built**
- [x] Shell fur with per-region length, painted coat and markings from the seed, four coats — **Built**
- [x] Eyes with gaze, saccades, lids, blinks (including slow blinks), pupils — **Built**; readability at gameplay distance judged from stills only
- [ ] Mouth: a chin that drops, a painted cavity and tongue. Simple compared with the rest of the face.

## Animation
- [x] Planted-foot gait with IK: walk, trot, bound; speed-dependent stride and duty; turn lean; start/stop lean — **Built**
- [x] Breathing tied to exertion and sleep, blinking, ear flicks, look-at with eyes leading — **Built**
- [x] Verlet tail and ears — **Built**
- [x] Performances: eat, drink, sniff, pounce, pick up, drop, bat, gnaw, play-bow, stretch, shake, groom, yawn, head tilt, knead, chirp, greet, wiggle, paw, look away, perk, nuzzle, tail-chase; startle flinch/watch/recover; sleep curl — **Built**
- [x] Touch responses by body region, liked and disliked — **Built**
- [ ] Motion quality in real time — **Unverified** (see VERIFICATION.md)

## Sanctuary
- [x] Glade with pond, nest, sun stone, bush, log, rocks, tall grass, trees — **Built**
- [x] Grass parts around bodies; water ripples from paws, toys and drinking; rustle and splash triggers — **Built**
- [x] Day/night cycle with fireflies and glowing mushrooms — **Built**
- [x] Orbit camera with soft follow, zoom, bounds; pointer, touch and keyboard — **Done** (browser check)

## Agent (Yuka)
- [x] Vehicle as sole movement owner, steering, collision — **Done**
- [x] Vision with occlusion, MemorySystem, hearing, smell; belief ≠ truth — **Done**
- [x] Think + 17 evaluators with exposed terms, hysteresis, commitment, cooldowns — **Done**
- [x] Composite goals with failure, recovery (search, replan) and cleanup — **Done**
- [x] StateMachine for body modes and action phases; telegrams — **Done**
- [x] A* on a nav graph consistent with collision — **Done**
- [x] Triggers, fuzzy appraisals, task queue — **Done** (fuzzy and triggers exercised indirectly)
- [x] Feature decision table — docs/ARCHITECTURE.md

## Needs, personality, memory, learning
- [x] Six needs with real costs and effects — **Done**
- [x] Affect layer separate from needs and personality — **Done**
- [x] Seeded personality, bounded drift — **Done**
- [x] Episodic memory with consolidation, decay, bounded capacity — **Done**
- [x] Toy preference learning that changes later choices — **Done**
- [x] Habituation — **Done**
- [x] Place significance — **Done**
- [x] Cue learning through practice and feedback — **Done**
- [x] Bond affecting approach and engagement — **Built** (bond changes are tested; its effect on approach distance is not asserted)
- [x] Memory payoffs visible without the inspector — **Built**

## Interaction
- [x] Feed, drink, pet, call, toss, carry/retrieve, two toys plus the wisp, sleep, novelty, practice cue — **Done** in simulation tests; berry, toss, call, cue, stroke, orbit, zoom driven through the real UI in the browser check
- [x] Accept / postpone / modify / decline — **Done** (decline when exhausted is tested; partial retrieve and sitting at a distance are implemented, not asserted)
- [x] Creature initiates: offers a toy, asks for company, begs for food — **Built**

## Interface
- [x] First minute: notices toys, approaches in character, name prompt, light hints — **Built**
- [x] Dark, restrained HUD; English; journal in plain language; developer inspector — **Done** (browser check)
- [x] Mute, volume, reduced motion, detail level — **Done**
- [x] Procedural sound vocabulary, unlocked on first gesture — **Done** that it runs; **Unverified** by ear

## Engineering
- [x] TypeScript, Vite, modules by concern, sim independent of rendering — **Done**
- [x] Fixed step, bounded catch-up, interpolation — **Done**
- [x] Versioned save with validation, backup recovery, export/import — **Done** (export/import UI not driven by the browser check)
- [x] Bounded offline progression, safe for odd clocks — **Done**
- [x] Quality tiers and adaptive detail — **Built**; **Unverified** on real hardware
- [x] CI: typecheck, tests, build — written, not yet run on GitHub
