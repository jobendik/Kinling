# Verification

What was run, what it showed, and what nobody has checked. Environment: Linux container, 2 vCPUs, **no GPU and no audio output**; Node 22.23, Chrome for Testing 153 with SwiftShader (software WebGL), three 0.187, yuka 0.7.8.

## Automated checks (all passing on the final commit)

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | 30 tests in 4 files, about 26 s (the soak test is 25 s of that) |
| `npm run build` | succeeds; 939 kB JS (255 kB gzip), 10 kB CSS, fonts bundled |
| `npm run test:browser` | 21 of 21 checks against the production build |

### Simulation scenarios (`tests/`)

| Scenario from the brief | Test | What is asserted |
| --- | --- | --- |
| Hunger and fatigue compete without oscillation | `behavior` › needs compete | Starts hungry and exhausted; it eats and it sleeps, with at most four eat/rest decisions on the way |
| Activities have real effects | `behavior` › real effects | Running lowers energy; drinking raises hydration; sleep restores energy |
| Occluded / moved toy | `behavior` › searches where it last saw a toy | Belief stays at the old position while the ball is moved behind the log; it goes to the believed place, enters a search phase, then finds it or records losing it |
| Unreachable toy | `behavior` › abandons a toy | Ball pinned mid-pond: the activity ends, nothing is carried, the body is in a valid mode on walkable ground |
| Sight occlusion | `behavior` › cannot see through the log | Not visible behind the log; visible beside it |
| Unexpected stimulus, interruption, recovery | `behavior` › a sudden chime | Mid-eating → `STARTLED`, action cancelled, wariness spikes, returns to normal, wariness decays, episode remembered |
| Interruption cleanup | `behavior` › drops what it is carrying | Carried toy becomes free and falls |
| Habituation | `behavior` › habituates | Fewer startles in the last three of twelve identical chimes than in the first three; stored value above 0.6 |
| Message delivery | `behavior` › delivers each delayed sound once | Three queued sounds arrive once each, in latency order |
| Seeds differ, same physics | `behavior` › individuals differ | Twelve seeds: confidence spans more than 0.25, at least two distinct approach styles and first-choice sequences; never off walkable ground or over speed |
| Determinism | `behavior` › same seed | Identical traits, look, position and activity after 30 s |
| Declining an invitation | `behavior` › autonomy | Same throw: chased at energy 0.9, ignored at 0.08 |
| Positive play changes a preference and later choices | `learning` › repeated good games | Real fetch games raise ball liking by more than 0.05; in an identical situation the trained individual scores ball play higher than its untrained twin and higher than rattle play, and actually chooses the ball; survives save/reload |
| Practice and feedback | `learning` › rewarding sits | 45 cue trials with strokes only after a sit: association rises by more than 0.3 and the last 15 trials have more sits than the first 15 |
| Place significance | `learning` › being stroked somewhere | A petting spot is remembered, overtakes the nest in comfort, and becomes the chosen resting place |
| Memory bounds | `learning` › episodic memory | 30 repeats consolidate to one episode; 200 distinct ones stay within 64; decay plus consolidation drops faded ones |
| Reload preserves the individual | `learning` › reloading | Name, seed, traits, look, all learned values, memory, needs and age round-trip through JSON |
| Damaged saves | `learning` › rejects or repairs | Garbage is rejected; wrong types, out-of-range values and a toy saved inside the pond are repaired |
| Bounded offline progression | `learning` › offline | Negative, NaN, infinite, 0 s, 10 s, 2 min, 1 h, 1 day and 10 years: effect capped at 12 h, all values in range, valid position, still runs |
| Return continuity | `learning` › a long absence | After 5 h: rested, less social, not starving, and it greets |
| Frame rates and resumed tab | `core` › fixed-step timing | Same simulated time at 30/60/144 fps and with irregular frames; a 37 s stall runs at most 5 steps |
| Navigation | `core` › glade and navigation | Paths around the pond stay on walkable ground; an unreachable goal resolves to the nearest standable point |
| Long sessions | `soak` | Six temperaments × 20 simulated minutes with a randomly meddling player: no invalid position, need, toy state or carry state; at least six kinds of activity; fewer than 12 goal changes a minute; memory within bounds; never starved or collapsed |

### Browser checks (`scripts/browser-check.mjs`, production build)

Loads and starts (about 9 s here, mostly the one-off creature sculpt); the scene renders; a goal is chosen; the berry tool drops a berry; audio unlocks on the first gesture; the ball tool tosses the ball; the Call button and the `S` key each reach the creature exactly once; dragging across the creature produces strokes; dragging the ground orbits; the wheel zooms; mute and reduced motion persist; the inspector shows live scores; reload restores the same individual with its learning and lived time; a save aged by three hours produces one bounded "you were away" transition; the canvas follows a resize; at 390×780 with touch the dock fits and its targets are at least 44×67 px; tap-tool-then-tap-ground works; no console errors or uncaught exceptions.

## Visual review

Done from deterministic captures (`scripts/capture.mjs` steps simulated time exactly and screenshots each frame), not by watching it live:

- Rest-pose turnarounds and silhouettes in the creature lab (`/lab.html`).
- Frame sheets of the walk and trot from the side ([docs/media/trot-frames.jpg](media/trot-frames.jpg)).
- A sheet of poses: sit, lie, sleep curl, eat, play-bow, head tilt, flinch, pounce, stretch, groom ([docs/media/poses.jpg](media/poses.jpg)).
- Day, dusk and night framings at high detail ([glade-dusk](media/glade-dusk.jpg), [face](media/face.jpg), [night-nest](media/night-nest.jpg), [glade-wide](media/glade-wide.jpg)).
- An eleven-second fetch sequence at 12 fps ([fetch.mp4](media/fetch.mp4), [fetch.gif](media/fetch.gif)).
- Desktop and phone-sized UI ([desktop-ui](media/desktop-ui.jpg), [phone](media/phone.jpg)).

Problems found this way and fixed: eyelids covering the eyes; a tail that tucked instead of lifting; faceted rocks; a pond with the wrong outline; den-tree roots like stilts; fireflies far too large; and blank frames at medium/high detail, caused by non-finite pixels from the fur shells being spread by the bloom pass. The last is fixed with an output guard on the creature materials (and a separate `atan(0,0)` at the pupil centre was removed); which shading term produces the bad values was **not** isolated.

## Performance

**Not measured on a GPU.** Under software rendering this build runs at roughly 1 frame per second at low detail (1100×700), which says nothing about real hardware. What was measured:

- Simulation: 420 simulated seconds in 1.5 s of one CPU core, about 0.06 ms per 60 Hz step.
- One-off creature sculpt at load: about 2.1 s on this machine (blocks the main thread behind the loading veil).
- Draw load at low detail: about 680 k triangles and 170 draw calls per frame. High detail adds 10 more fur shells and 2.5× the grass, so expect roughly 1.4 M.

The 60 fps target on a modern laptop is therefore **unverified**. Automatic detail steps down after three consecutive seconds above 24 ms per frame and up after twelve below 11 ms; that logic has not been exercised on real hardware either.

## Not tested

- **Sound.** The audio engine was run in headless Chrome (every method executed, levels metered, voice cap and mute verified) but no one has listened to it.
- **Animation in motion.** Judged from frame sheets and a 12 fps clip only. Foot planting is by construction (paws are fixed in world space during stance), but timing, weight and transitions need a human eye at full frame rate.
- **Real devices and other browsers.** Only Chrome 153 with emulated touch. No Safari, Firefox, iOS or Android run.
- **Memory over hours** in the browser. The simulation soak covers logic, not GPU or audio resources.
- **Save export/import through the UI** (the parsing behind it is tested).
- **CI** has not run on GitHub.

## Known limitations

- The mouth is simple (a dropping chin with a painted cavity and tongue).
- Folded legs in the lying and sleeping poses intersect the belly under the fur.
- The den tree's buttress roots and the berry bush are cruder than the creature.
- The camera does not avoid rocks between it and the creature.
- Fur strands can shimmer at a distance at low detail (no MSAA there).
- Retrieving is not guaranteed: depending on trust and temperament it may bring a toy back, bring it halfway, or carry it home. That is intended, but the reasons are only visible in the inspector.
- Time away is an estimate applied on return. Nothing runs while the page is closed.
