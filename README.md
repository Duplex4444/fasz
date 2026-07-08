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

## The puzzle design — real choices, not a linear chain

Each level is a dense jam (9–16 cars) where **2–4 vehicles are legally movable
at any moment**, but only some moves are strategically good. The others are
**decoys**: a legal move that wastes a bay, blocks a later car, or dead-ends the
whole puzzle so you have to Undo. Because a small car fits a long bay, parking
it there too early can strand a van or truck — so you must think before you tap.

- **Level 1 "Traffic Jam"** — 9 cars, 3 movable; one move wastes a bay.
- **Level 2 "Bottleneck"** — 11 cars, 3 movable; a real trap + a wasteful decoy.
- **Level 3 "Crossroads"** — 13 cars, 4 movable; 2 traps and 2 wastes — lots of choice.
- **Level 4 "Rush Hour"** — 15 cars, 3 movable; trucks need the long bays, one move dead-ends.
- **Level 5 "Deadlock"** — 16 cars, 4 movable; plan the sequence or get boxed in.

Every level is built and proven by the generator + a choice-analyzer that
verifies: 2–4 movable at the start, at least one decoy move, at least one good
move (a genuine decision), no four identical cars lined up, and full
solvability. `movableVehicles()` computes the movable set from live positions;
a car is movable only if it has a reachable legal destination right now, and
movable cars carry only a *subtle* glow — the challenge is choosing well, not
spotting the one glowing car.

The **Hint** recommends the strategically correct move (the first step of an
optimal solution, never a decoy) and shows a short reason such as *“Keep the
long bay free for a bigger vehicle.”*

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

## Garage, skins & coins (demo economy)

The **🛒 Garage & Shop** on the menu lets you spend coins on **ambulance skins**
(Classic, Midnight, Ranger, Candy, Shadow, Golden) — each is a procedurally
drawn palette, no assets. You earn coins by clearing levels, by **watching a
(simulated) rewarded ad** for free coins, or via **coin packs**. A rewarded-ad
offer also pops up periodically (every 5 minutes, at a calm moment) for bonus
coins. Owned skins, the equipped skin, and coins persist in `localStorage`.

> **Note:** this is an offline prototype — there is **no ad network and no
> payment processor**. The ad player and coin packs are clearly labelled
> *demo* and simply grant coins; nothing is ever charged. Wiring in a real
> rewarded-ad SDK or store would replace `Game.watchAd` / `Game.buyCoins`.

## Features

- 5 choice-driven campaign levels, each proven to start with 2–4 movable cars,
  to contain decoy/trap moves and a real decision, and to be solvable
- Endless mode: an infinite supply of backward-generated, always-solvable,
  varied puzzles with a difficulty ramp and saved best round
- Garage with buyable ambulance skins, a simulated rewarded-ad flow, coin
  packs, and a periodic ad offer (all clearly demo — no real charges)
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
