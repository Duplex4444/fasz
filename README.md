# Clear the Way 🚑

A complete, self-contained portrait mobile puzzle game for the browser.
Move the civilian vehicles into real parking spaces so the ambulance can race
from the bottom of the screen to the exit at the top.

## Run it

No build system, no server, no dependencies:

1. Open `index.html` in any modern browser (or serve the folder statically).
2. Best experienced in a portrait/mobile viewport — on desktop, open DevTools
   device emulation or just resize the window tall and narrow.

## How to play

- **Tap a vehicle** to select it — every parking space it can legally reach
  glows green.
- **Tap a green space** (or **drag** the vehicle toward one — a ghost preview
  and dotted route appear) to send it there along a collision-free path.
- Clear the red emergency lane. The moment it's free, the ambulance flips on
  its lights and siren and drives out on its own.
- **Undo** reverses your last moves (full history), **Hint** shows the
  solver's recommended next move (3 free per level, then coins),
  **Restart** resets the level (with confirmation once you've moved).

## Features

- 5 hand-designed levels, each proven solvable by an automated solver
- Grid-based BFS pathfinding (slides + 90° rotations in turning zones)
- Real undo history, solver-powered hints, stars/coins, `localStorage` saves
- Tutorial on first play, pause menu, level select, sound toggle
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
missing destinations for blockers, duplicate/missing IDs — and an actual
solver run proving the level is beatable at par.
