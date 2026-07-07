# Clear the Way 🚑

A complete, self-contained portrait mobile puzzle game for the browser.
The road is jammed with traffic and an ambulance is stuck at the bottom. It is a
**chain-reaction logic puzzle**: at the start only ONE vehicle can legally move.
Driving it into its bay opens room for the next car, which opens the next — you
must read the gridlock and find the correct order to drain the emergency lane so
the ambulance can race to the exit at the top.

## Run it

No build system, no server, no dependencies:

1. Open `index.html` in any modern browser (or serve the folder statically).
2. Best experienced in a portrait/mobile viewport — on desktop, open DevTools
   device emulation or just resize the window tall and narrow.

## How to play

- Only the **currently movable** vehicles glow softly. Every other car is
  blocked traffic and sits darker — tapping a blocked car makes it shake and
  shows a red "no entry" badge.
- **Tap a movable vehicle** to select it — every parking space it can legally
  reach glows green.
- **Tap a green space** (or **drag** the vehicle toward one — a ghost preview
  and dotted route appear) to send it there. Cars drive like real cars: they
  only go forward/reverse along their heading (and rotate in turning zones) —
  no sliding sideways through empty space.
- Each successful move sparkles the cars it just unlocked. Keep the chain going
  until the emergency lane is clear; then the ambulance flips on its lights and
  siren and drives out on its own.
- **Undo** reverses your last moves (full history), **Hint** points at the
  next correct car in the chain (3 free per level, then coins), **Restart**
  resets the level (with confirmation once you've moved).

## The puzzle design

Each level is a dense jam (8–18 cars) engineered so that **exactly one vehicle
is movable at the start**. Moving it unblocks one or two others, and so on:

- **Level 1** — tutorial: one "gate" van frees a stack of blocked cars.
- **Level 2** — a small opener frees the gate; includes a decoy car that looks
  useful but is boxed in.
- **Level 3** — a long truck blocks four cars; free the small car first.
- **Level 4** — a van must pull into a side street to unlock the gate.
- **Level 5** — a four-stage chain: opener → keystone → gate → drain.

`movableVehicles()` computes the movable set from live positions; a car is
movable only if it has at least one reachable legal destination right now.

## Endless mode — infinite generated puzzles

The **∞ ENDLESS** button on the menu generates a fresh, always-solvable puzzle
every round, with difficulty ramping as your streak grows (best round is saved).

`generateLevel(seed, opts)` builds each map **backwards from the solved state**:
it parks every car in a bay (route clear), then in reverse solve order pulls
each car out onto the road to a spot from which its bay is *provably reachable*
given the cars that move after it. Because the construction only ever places a
car where the forward move is legal, the result is **solvable by construction**
and **every car has a real destination it can reach** — no filler. A corridor
heuristic lands cars on each other's exit paths, so each map has genuinely
layered dependencies (not one repeated trick), and progressive relaxation keeps
the success rate at ~100% without ever shipping an unsolvable board. Same seed →
same map, so any puzzle is reproducible.

## Features

- 5 chain-reaction campaign levels, each proven by an automated solver to start
  with exactly one movable car and to be solvable only in the correct order
- Endless mode: an infinite supply of backward-generated, always-solvable,
  varied puzzles with a difficulty ramp and saved best round
- Grid-based BFS pathfinding: cars drive along their heading (no crab-slides),
  plus 90° rotations in turning zones
- Real undo history, chain-aware hints, stars/coins, `localStorage` saves
- Tutorial on first play, pause menu, level select, sound toggle
- Movable-car glow, blocked-car shake + badge, unlock sparkles, confetti
- All graphics drawn procedurally on Canvas; all sound generated with Web Audio
- Pointer Events: touch and mouse both work; page scroll/zoom suppressed

## Files

- `index.html` — page structure: HUD, canvas stage, toolbar, overlay panels
- `style.css`  — mobile chrome styling, safe-area handling, panel animations
- `game.js`    — all game logic and rendering (pure logic section is
  Node-compatible for testing)
- `test.js`    — automated validation: run `node test.js` to verify geometry,
  pathfinding rules, and solvability of every level

## Level validation

Every level is checked at boot (console) and in `test.js` for: vehicle overlap,
out-of-bounds vehicles, parking overlap, invalid space sizes, route integrity,
duplicate/missing IDs — plus the chain-puzzle guarantees: the route is blocked
at the start, exactly one vehicle is movable at the start, blocked cars have no
legal target, the route only becomes clear on the final move, and an actual
solver run proves the level is beatable at par. Run `node test.js` (66 checks).
