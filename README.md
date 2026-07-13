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

## Infinite levels

There are two ways the game never runs out of levels:

- **The campaign is endless.** After the 5 curated levels, "Next Level" keeps
  going into generated, numbered levels (Level 6, 7, 8, …) with a difficulty
  ramp. Each numbered level is **deterministic and cached** (same number → same
  board, so replay/restart are stable), starts with 2–4 movable cars like the
  curated ones, and saves its own best score. The level-select grid grows as you
  unlock more, and the next level is pre-generated during the win panel so
  "Next" is instant.
- **Endless mode** — the **∞ ENDLESS** button on the menu is a separate
  streak-based run: a fresh, always-solvable puzzle every round with its own
  saved best round.

### Getting unstuck

Because levels contain traps, you can box the ambulance in. When there's no
longer any way to clear the route, a **"No way through!"** screen appears
offering to **watch an ad to undo your last move and get a hint**, undo for
free, or restart. (Stuck detection runs the solver from the live position, so
it only triggers when you're genuinely trapped.)

### Endless mode — infinite generated puzzles

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

## Garage, skins, street themes & coins (demo economy)

The **🛒 Garage & Shop** on the menu lets you spend coins on **14 hero-vehicle
skins** — the classics (Classic, Midnight, Ranger, Candy, Shadow, Golden) plus
a whole emergency fleet with real roof decals: **Fire Truck** and **Fire
Chief** (roof ladder), **Police**, **Interceptor** and **Sheriff** (five-point
star), **Taxi** (checker band), **Ice Cream** (cone + scoops) and **Neon
Racer** (lightning bolt). Each is a procedurally drawn palette + decal, no
assets.

Below the skins are **street themes**: the world's scenery palette. On
**AUTO** (free, default) the neighbourhood changes as you play — Sunny Day →
Sunset → Night → Autumn → Snow, rotating every 3 campaign levels and every 2
endless rounds. Or buy a theme (Sunset, Night, Autumn, Snow) and **pin it** so
every street is painted that way. Themes are purely cosmetic — the boards are
identical in any palette.

You earn coins by clearing levels, by **watching a (simulated) rewarded ad**
for free coins, or via **coin packs**. A rewarded-ad offer also pops up
periodically (every 5 minutes, at a calm moment) for bonus coins. Owned skins
and themes, the equipped ones, and coins persist in `localStorage`.

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
- Polished toy-3D presentation: vehicles are extruded (a darker base under a
  glossy top face) with chunky tires + hubs, and every car has a real body
  style — sedan, hatchback, compact, van, pickup, or box truck — with a full
  greenhouse (windshield, side windows, rear glass around a floating roof),
  bumpers, mirrors, creases, and per-car extras like sunroofs and racing
  stripes; the board is a framed "stage" on a premium dark backdrop; the
  ambulance is a hero object with a strobing red/blue light bar and coloured
  light-spill on the road; parking dust, sparkles, confetti, and a soft
  vignette round out the feel. Static scenery (mowed grass with blades, grainy
  asphalt with tyre wear + oil stains, lit curbs, painted worn bays, gabled
  houses, trees, hydrants, fences, mailboxes, benches, storm drains, flowers)
  is pre-rendered to an offscreen cache, and each car's painted body is cached
  as a sprite, so per-frame work is a handful of drawImage calls (≈60 fps on
  the densest level).
- All graphics drawn procedurally on Canvas; all sound generated with Web Audio
- Pointer Events: touch and mouse both work; page scroll/zoom suppressed

## Publishing — the game ships as an installable PWA

The repo contains everything a store submission needs:

- **`manifest.webmanifest`** — name, portrait lock, standalone display,
  theme/background colours, categories, store-style screenshots, and icons
  (192/512 + a maskable 512 for Android adaptive launchers).
- **`icons/`** — procedurally generated app icons, including
  `apple-touch-icon.png` for iOS home screens.
- **`sw.js`** — a service worker that precaches the whole app shell, so the
  game **installs and runs fully offline**. It registers itself only when
  served over http(s); opening `index.html` from disk still works. Bump the
  `CACHE` name (and `GAME_VERSION` in `game.js`) on each release.
- **`screenshots/`** — portrait gameplay captures referenced by the manifest
  and reusable for store listings.
- **`PRIVACY.md`** — privacy policy (stores require a hosted policy URL; this
  game collects nothing, everything is in `localStorage`).
- **Mobile lifecycle built in** — auto-pause + audio suspend when the app is
  backgrounded, a rotate-to-portrait guard on small landscape screens,
  vibration feedback (follows the sound toggle), iOS safe-area handling, no
  pinch-zoom/scroll/long-press artifacts, and a version stamp in the menu.

### Store checklist

1. **Host it** on any static HTTPS host — it's instantly playable and
   installable (Add to Home Screen) on Android and iOS.
2. **Google Play**: wrap the hosted URL as a Trusted Web Activity with
   [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
   (`bubblewrap init --manifest https://your.host/manifest.webmanifest`), or
   use Capacitor if you prefer a WebView shell.
3. **App Store**: wrap with [Capacitor](https://capacitorjs.com)
   (`npx cap add ios`, point the webDir at this folder).
4. **Before charging real money**: replace the demo economy — wire
   `Game.watchAd` to a rewarded-ad SDK and `Game.buyCoins` to the platform's
   in-app purchase API. Until then the demo labels must stay.
5. Fill in the listing with `icons/icon-512.png`, the `screenshots/` images,
   `PRIVACY.md` hosted at a public URL, and a content rating (no violence,
   no data collection — typically rated for all ages).

## Files

- `index.html` — page structure: HUD, canvas stage, toolbar, overlay panels
- `style.css`  — mobile chrome styling, safe-area handling, panel animations
- `game.js`    — all game logic and rendering (pure logic section is
  Node-compatible for testing)
- `test.js`    — automated validation: run `node test.js` to verify geometry,
  pathfinding rules, and solvability of every level
- `manifest.webmanifest`, `sw.js`, `icons/`, `screenshots/`, `PRIVACY.md` —
  publishing shell (see above)

## Level validation

Every level is checked at boot (console) and in `test.js` for: vehicle overlap,
out-of-bounds vehicles, parking overlap, invalid space sizes, route integrity,
duplicate/missing IDs — plus the chain-puzzle guarantees: the route is blocked
at the start, exactly one vehicle is movable at the start, blocked cars have no
legal target, the route only becomes clear on the final move, and an actual
solver run proves the level is beatable at par. Run `node test.js` (66 checks).
