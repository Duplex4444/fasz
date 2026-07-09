/* ============================================================================
   CLEAR THE WAY — game.js

   A complete portrait mobile puzzle game.
   Move the civilian vehicles into real parking spaces so the ambulance can
   drive from the bottom of the screen to the exit at the top.

   Structure:
     1. Constants + small utilities
     2. Pure game model (board, footprints, BFS pathfinder, targets, solver,
        level validation, level data)          — runs in Node for tests too
     3. Browser presentation (audio, save, particles, UI, renderer, input,
        animation, Game controller, bootstrap) — browser only
   ============================================================================ */
'use strict';

/* ============================== 1. CONSTANTS ============================== */

const DEBUG = false;          // draw grid, coordinates, footprints, route, ids
const ROWS  = 14;
const COLS  = 7;

const TILE = { GRASS: 0, ROAD: 1, PAVE: 2 };

const TUNE = {
  slideMs:      105,          // animation time per 1-cell slide
  rotateMs:     260,          // animation time per 90° rotation
  ambCellMs:    115,          // base ambulance time per cell (accelerates)
  freeHints:    3,
  hintCoinCost: 15,
  historyMax:   30,           // undo history depth (spec asks for >= 20)
  tapSlopPx:    12,           // movement below this is a tap, above is a drag
  hintShowMs:   4500,
  solverMaxDepth: 14,         // longest chain (level 5) is 11 moves
  adOfferMs:    5 * 60 * 1000, // rewarded-ad offer cadence (every 5 minutes)
  adOfferReward: 40,          // coins for watching the periodic offer
  adWatchSecs:  5,            // simulated ad duration before you can claim
};

const AMB_ID = '__amb';

/* Ambulance skins for the shop. `cost` is in coins (0 = owned by default);
   `body` is the [top, bottom] gradient. Everything is drawn procedurally, so
   a skin is just a palette — no assets. */
const SKINS = [
  { id: 'classic',  name: 'Classic',  cost: 0,   body: ['#ffffff', '#ccd5df'], stripe: '#e8443a', accent: '#ffb42e', cross: '#e8443a' },
  { id: 'midnight', name: 'Midnight', cost: 120, body: ['#46587a', '#26324a'], stripe: '#37c9d7', accent: '#7ad0ff', cross: '#37c9d7' },
  { id: 'ranger',   name: 'Ranger',   cost: 180, body: ['#69b455', '#37732c'], stripe: '#ffd75e', accent: '#fff2a8', cross: '#ffffff' },
  { id: 'candy',    name: 'Candy',    cost: 240, body: ['#ff9ec4', '#e46fae'], stripe: '#ffffff', accent: '#fff2a8', cross: '#e8443a' },
  { id: 'shadow',   name: 'Shadow',   cost: 320, body: ['#3a4150', '#1c212c'], stripe: '#ff6a3d', accent: '#ff6a3d', cross: '#ff6a3d' },
  { id: 'gold',     name: 'Golden',   cost: 600, body: ['#ffe38a', '#e0a419'], stripe: '#7a4a12', accent: '#fff6c8', cross: '#a5670c' },
];
const skinById = id => SKINS.find(s => s.id === id) || SKINS[0];

/* ============================== UTILITIES ================================= */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/* Deterministic pseudo-random generator for scenery placement. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
   2. PURE GAME MODEL
   ========================================================================= */

/**
 * Parse a level definition's ASCII map + parking spaces into a board object.
 * Map characters:  '.' grass   'r' road   'e' road on the emergency route
 *                  't' road with a turning zone   'p' pavement (drivable)
 * Parking space cells are always made drivable.
 */
function parseBoard(def) {
  const type = [], drivable = [], turn = [];
  const route = [], routeSet = new Set();

  if (!def.map || def.map.length !== ROWS) {
    throw new Error(`Level ${def.id}: map must have ${ROWS} rows`);
  }
  for (let r = 0; r < ROWS; r++) {
    const row = def.map[r];
    if (row.length !== COLS) throw new Error(`Level ${def.id}: row ${r} must have ${COLS} chars`);
    type[r] = []; drivable[r] = []; turn[r] = [];
    for (let c = 0; c < COLS; c++) {
      const ch = row[c];
      let t = TILE.GRASS, d = false, tz = false;
      if (ch === 'r' || ch === 'e' || ch === 't') { t = TILE.ROAD; d = true; }
      if (ch === 'p') { t = TILE.PAVE; d = true; }
      if (ch === 't') tz = true;
      if (ch === 'e') { route.push({ r, c }); routeSet.add(r + ',' + c); }
      type[r][c] = t; drivable[r][c] = d; turn[r][c] = tz;
    }
  }
  // Parking-space cells are always drivable pavement.
  for (const sp of def.spaces) {
    for (const [r, c] of footprint(sp.r, sp.c, sp.orient, sp.len)) {
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue; // validation reports this
      drivable[r][c] = true;
      if (type[r][c] === TILE.GRASS) type[r][c] = TILE.PAVE;
    }
  }
  return {
    type, drivable, turn, route, routeSet,
    inBounds: (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS,
    isDrivable(r, c) { return this.inBounds(r, c) && this.drivable[r][c]; },
  };
}

/** Cells occupied by a vehicle/space anchored at (r,c) with orientation + length. */
function footprint(r, c, orient, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(orient === 'v' ? [r + i, c] : [r, c + i]);
  return out;
}

const spaceCells = sp => footprint(sp.r, sp.c, sp.orient, sp.len);

/** Occupancy grid: cell -> vehicle id (or null). `exceptId` is left out. */
function buildOcc(vehicles, exceptId) {
  const occ = [];
  for (let r = 0; r < ROWS; r++) occ[r] = new Array(COLS).fill(null);
  for (const v of vehicles) {
    if (v.id === exceptId) continue;
    for (const [r, c] of footprint(v.r, v.c, v.orient, v.len)) {
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) occ[r][c] = v.id;
    }
  }
  return occ;
}

/* ------------------------------ PATHFINDER ------------------------------- */
/**
 * Breadth-first search over vehicle states (anchor row, anchor col, orientation).
 * Vehicles drive like cars: one cell forward or reverse ALONG their heading
 * (vertical cars move up/down, horizontal cars move left/right — never a
 * sideways crab-slide), or rotate 90° when the anchor sits in a turning zone
 * and the full LxL sweep square is free.
 * Returns Map "r,c,o" -> node {r,c,o,depth,prev}.
 */
const Pathfinder = {
  reach(board, occ, veh) {
    const nodes = new Map();
    const keyOf = (r, c, o) => r + ',' + c + ',' + o;
    const fits = (r, c, o) =>
      footprint(r, c, o, veh.len).every(([fr, fc]) => board.isDrivable(fr, fc) && !occ[fr][fc]);

    const start = { r: veh.r, c: veh.c, o: veh.orient, depth: 0, prev: null };
    nodes.set(keyOf(start.r, start.c, start.o), start);
    const q = [start];

    while (q.length) {
      const n = q.shift();
      // Forward / reverse along the current heading only.
      const dirs = n.o === 'v' ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
      for (const [dr, dc] of dirs) {
        const nr = n.r + dr, nc = n.c + dc;
        const k = keyOf(nr, nc, n.o);
        if (!nodes.has(k) && fits(nr, nc, n.o)) {
          const nn = { r: nr, c: nc, o: n.o, depth: n.depth + 1, prev: n };
          nodes.set(k, nn); q.push(nn);
        }
      }
      // Rotation inside a turning zone (anchor stays, orientation flips).
      if (board.inBounds(n.r, n.c) && board.turn[n.r][n.c]) {
        let ok = true;
        for (let i = 0; i < veh.len && ok; i++) {
          for (let j = 0; j < veh.len && ok; j++) {
            const rr = n.r + i, cc = n.c + j;
            if (!board.isDrivable(rr, cc) || occ[rr][cc]) ok = false;
          }
        }
        if (ok) {
          const no = n.o === 'v' ? 'h' : 'v';
          const k = keyOf(n.r, n.c, no);
          if (!nodes.has(k)) {
            const nn = { r: n.r, c: n.c, o: no, depth: n.depth + 1, prev: n };
            nodes.set(k, nn); q.push(nn);
          }
        }
      }
    }
    return nodes;
  },

  path(node) {
    const out = [];
    for (let n = node; n; n = n.prev) out.unshift({ r: n.r, c: n.c, o: n.o });
    return out;
  },
};

/* ------------------------------- TARGETS --------------------------------- */
/**
 * All legal parking targets for one vehicle: for each parking space that is
 * empty, big enough, off the emergency route and reachable, return the best
 * (shortest) goal state and its full path.
 */
function computeTargets(board, vehicles, spaces, movingId) {
  const veh = vehicles.find(v => v.id === movingId);
  if (!veh) return [];
  const occ = buildOcc(vehicles, movingId);
  const nodes = Pathfinder.reach(board, occ, veh);
  const targets = [];

  for (const sp of spaces) {
    if (veh.len > sp.maxLen || veh.len > sp.len) continue;
    if (sp.minLen && veh.len < sp.minLen) continue; // long bays reserved for long vehicles
    const cells = spaceCells(sp);
    // Occupied by any other vehicle?
    if (cells.some(([r, c]) => occ[r][c])) continue;
    // Vehicle already parked exactly inside this space?
    if (veh.orient === sp.orient &&
        footprint(veh.r, veh.c, veh.orient, veh.len)
          .every(([r, c]) => cells.some(([sr, sc]) => sr === r && sc === c))) continue;

    let best = null;
    for (let k = 0; k <= sp.len - veh.len; k++) {
      const gr = sp.orient === 'v' ? sp.r + k : sp.r;
      const gc = sp.orient === 'h' ? sp.c + k : sp.c;
      // A parked vehicle must never block the emergency route.
      if (footprint(gr, gc, sp.orient, veh.len).some(([r, c]) => board.routeSet.has(r + ',' + c))) continue;
      const n = nodes.get(gr + ',' + gc + ',' + sp.orient);
      if (n && (!best || n.depth < best.depth)) best = n;
    }
    if (best) {
      targets.push({
        spaceId: sp.id, space: sp,
        r: best.r, c: best.c, orient: best.o,
        path: Pathfinder.path(best),
      });
    }
  }
  return targets;
}

/**
 * The heart of the chain-reaction puzzle: a vehicle is MOVABLE only when it
 * has at least one reachable legal parking destination right now. Everything
 * else is blocked traffic.
 */
function movableVehicles(board, vehicles, spaces) {
  return vehicles
    .filter(v => v.id !== AMB_ID && computeTargets(board, vehicles, spaces, v.id).length > 0)
    .map(v => v.id);
}

/** Is the full emergency route free of civilian vehicles? */
function routeIsClear(board, vehicles) {
  for (const v of vehicles) {
    if (v.id === AMB_ID) continue;
    for (const [r, c] of footprint(v.r, v.c, v.orient, v.len)) {
      if (board.routeSet.has(r + ',' + c)) return false;
    }
  }
  return true;
}

/* -------------------------------- SOLVER ---------------------------------
   Breadth-first search over whole board states, where one "move" relocates a
   vehicle into a parking space. Used to validate that levels are solvable and
   to power the hint system. Returns the shortest move list, or null. */
function solveLevel(board, vehicles, spaces, maxDepth = TUNE.solverMaxDepth) {
  const keyOf = vs => vs.filter(v => v.id !== AMB_ID)
    .map(v => `${v.id}:${v.r},${v.c},${v.orient}`).join('|');
  if (routeIsClear(board, vehicles)) return [];

  const seen = new Set([keyOf(vehicles)]);
  let frontier = [{ vs: vehicles, seq: [] }];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const v of node.vs) {
        if (v.id === AMB_ID) continue;
        const ts = computeTargets(board, node.vs, spaces, v.id);
        for (const t of ts) {
          const vs2 = node.vs.map(x => x.id === v.id
            ? { ...x, r: t.r, c: t.c, orient: t.orient } : x);
          const k = keyOf(vs2);
          if (seen.has(k)) continue;
          seen.add(k);
          const seq2 = [...node.seq, {
            vehicleId: v.id, spaceId: t.spaceId, r: t.r, c: t.c, orient: t.orient,
          }];
          if (routeIsClear(board, vs2)) return seq2;
          next.push({ vs: vs2, seq: seq2 });
        }
      }
    }
    frontier = next;
    if (!frontier.length) return null;
  }
  return null;
}

/* ----------------------------- LEVEL GENERATOR ---------------------------
   Infinite, always-solvable, varied puzzles. Built BACKWARDS from the solved
   state: place every car in a parking bay (route clear), then in reverse solve
   order pull each car out onto the road to a spot from which its bay is
   provably reachable given the cars that move after it. Solvability is
   guaranteed by construction and every car has a real destination. A corridor
   heuristic lands cars on each other's exit paths, producing layered
   dependencies (not one repeated trick), and progressive relaxation keeps the
   success rate at ~100% without ever shipping an unsolvable board. */
const GEN_PALETTE = ['#e8443a', '#26c3d7', '#f5920b', '#3b6fe0', '#7ac043', '#9b59d0',
  '#e46fae', '#d9b34a', '#37c9a5', '#c96f35', '#4aa3f0', '#e3d13c', '#8a5cc0', '#ef5f7e', '#3fbfc9'];
const GEN_ROUTE_COL = 3;
const GEN_ROAD_ROW = '.rrerr.';   // cols 1-5 drivable, col 3 = emergency route

function generateLevel(seed, opts = {}) {
  const cars = opts.cars || 9;
  const tries = opts.tries || 300;
  const ambulance = { r: ROWS - 2, c: GEN_ROUTE_COL };
  const map = Array.from({ length: ROWS }, () => GEN_ROAD_ROW);

  const phase = f => ({ movable: Math.max(1, Math.round(cars * f.mv)), movers: f.mo, depth: f.dp });
  const phases = [
    { until: 0.45, s: phase({ mv: 0.4, mo: 0.75, dp: 0.7 }) },   // tight, layered
    { until: 0.75, s: phase({ mv: 0.55, mo: 0.65, dp: 0.6 }) },  // medium
    { until: 1.0,  s: phase({ mv: 1.0, mo: 0.5, dp: 0.45 }) },   // loose fallback
  ];

  for (let attempt = 0; attempt < tries; attempt++) {
    const strict = opts.strict || phases.find(p => attempt / tries < p.until).s;
    const rng = mulberry32(((seed >>> 0) * 2654435761 + attempt * 40503) >>> 0);
    const def = genTry(rng, cars, map, ambulance, strict, seed, opts);
    if (def) return def;
  }
  return null;
}

function genTry(rng, N, map, ambulance, strict, seed, opts) {
  const rint = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const ambCells = footprint(ambulance.r, ambulance.c, 'v', 2);
  const isAmb = (r, c) => ambCells.some(([ar, ac]) => ar === r && ac === c);

  // 1. Place bays (parked positions): off-route, non-overlapping, on shoulders.
  const occ = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const bays = [], carSize = [];
  for (let i = 0; i < N; i++) {
    let placed = false;
    for (let t = 0; t < 80 && !placed; t++) {
      const orient = rng() < 0.5 ? 'v' : 'h';
      const len = orient === 'h' ? pick([2, 2, 3]) : pick([2, 2, 3, 4]);
      let r, c;
      if (orient === 'h') { r = rint(0, ROWS - 1); c = rng() < 0.5 ? 0 : COLS - len; }
      else { c = pick([1, 2, 4, 5]); r = rint(0, ROWS - len); }
      const cells = footprint(r, c, orient, len);
      if (cells.some(([cr, cc]) => cr < 0 || cr >= ROWS || cc < 0 || cc >= COLS)) continue;
      if (cells.some(([cr, cc]) => cc === GEN_ROUTE_COL)) continue;      // bays never on the route
      if (cells.some(([cr, cc]) => occ[cr][cc] || isAmb(cr, cc))) continue;
      cells.forEach(([cr, cc]) => (occ[cr][cc] = true));
      bays.push({ r, c, orient, len });
      carSize.push({ len, orient });
      placed = true;
    }
    if (!placed) return null;
  }

  const spaces = bays.map((b, i) => ({ id: 'S' + i, r: b.r, c: b.c, orient: b.orient, len: b.len, maxLen: b.len }));
  const board = parseBoard({ id: 0, name: 'g', par: 0, map, vehicles: [], spaces, ambulance });

  // 2. Reverse solve order; pull each car out to a blocking start.
  const order = [...Array(N).keys()];
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const stepOf = new Array(N);
  order.forEach((ci, k) => (stepOf[ci] = k));
  const starts = bays.map(b => ({ r: b.r, c: b.c, orient: b.orient }));

  const corridor = new Set();
  const addCorridor = ci => {
    const s = starts[ci], b = bays[ci], len = carSize[ci].len;
    if (s.orient === 'h' && s.r === b.r) {
      const lo = Math.min(s.c, b.c), hi = Math.max(s.c + len - 1, b.c + len - 1);
      for (let c = lo; c <= hi; c++) corridor.add(s.r + ',' + c);
    } else if (s.orient === 'v' && s.c === b.c) {
      const lo = Math.min(s.r, b.r), hi = Math.max(s.r + len - 1, b.r + len - 1);
      for (let r = lo; r <= hi; r++) corridor.add(r + ',' + s.c);
    }
  };

  for (let k = N - 1; k >= 0; k--) {
    const ci = order[k], size = carSize[ci];
    const oc = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    for (let cj = 0; cj < N; cj++) {
      if (cj === ci) continue;
      const p = stepOf[cj] > k ? starts[cj] : bays[cj];        // later movers at starts, earlier at bays
      for (const [r, c] of footprint(p.r, p.c, p.orient, carSize[cj].len)) oc[r][c] = true;
    }
    for (const [r, c] of ambCells) oc[r][c] = true;

    const reach = Pathfinder.reach(board, oc, { r: bays[ci].r, c: bays[ci].c, orient: bays[ci].orient, len: size.len });
    const bayKey = bays[ci].r + ',' + bays[ci].c + ',' + bays[ci].orient;
    let best = null, bestScore = -1;
    for (const [key, node] of reach) {
      if (key === bayKey) continue;
      const fc = footprint(node.r, node.c, node.o, size.len);
      const onRoute = fc.some(([cr, cc]) => cc === GEN_ROUTE_COL) ? 1 : 0;
      const blocks = fc.reduce((n, [cr, cc]) => n + (corridor.has(cr + ',' + cc) ? 1 : 0), 0);
      const score = onRoute * 800 + blocks * 500 + node.depth * 10 + rng() * 5;
      if (score > bestScore) { bestScore = score; best = node; }
    }
    if (best) starts[ci] = { r: best.r, c: best.c, orient: best.o };
    addCorridor(ci);
  }

  // 3. Assemble + verify (route blocked, mostly-purposeful, layered, solvable).
  const vehicles = carSize.map((s, i) => ({
    id: 'c' + i, kind: s.len >= 4 ? 'truck' : s.len >= 3 ? 'van' : 'car',
    color: GEN_PALETTE[i % GEN_PALETTE.length], len: s.len, orient: starts[i].orient,
    r: starts[i].r, c: starts[i].c,
  }));
  const def = { id: opts.id || ('gen-' + seed), name: opts.name || 'Endless', par: 0, generated: true, map, vehicles, spaces, ambulance, tutorial: null };

  const vs = vehicles.map(v => ({ ...v }));
  vs.push({ id: AMB_ID, r: ambulance.r, c: ambulance.c, orient: 'v', len: 2 });
  if (routeIsClear(board, vs)) return null;                            // ambulance must be blocked
  const movers = vehicles.filter((v, i) =>
    starts[i].r !== bays[i].r || starts[i].c !== bays[i].c || starts[i].orient !== bays[i].orient).length;
  if (movers < Math.ceil(N * strict.movers)) return null;              // most cars must matter
  const startMovable = movableVehicles(board, vs, def.spaces);
  if (startMovable.length < 1 || startMovable.length > strict.movable) return null;  // layered, not trivial
  const sol = solveLevel(board, vs, def.spaces, N + 3);
  if (!sol) return null;
  if (sol.length < Math.ceil(N * strict.depth)) return null;           // demand real depth
  def.par = sol.length;
  return def;
}

/* ----------------------------- LEVEL VALIDATION -------------------------- */
/** Developer validation: sanity-checks geometry and proves solvability. */
function validateLevel(def) {
  const errors = [], warnings = [];
  let board = null;
  try { board = parseBoard(def); }
  catch (e) { return { ok: false, errors: [e.message], warnings, solution: null }; }

  // Unique ids
  const ids = new Set();
  for (const v of def.vehicles) {
    if (!v.id) errors.push('vehicle without id');
    else if (ids.has(v.id)) errors.push(`duplicate vehicle id "${v.id}"`);
    ids.add(v.id);
  }
  const sids = new Set();
  for (const s of def.spaces) {
    if (!s.id) errors.push('space without id');
    else if (sids.has(s.id)) errors.push(`duplicate space id "${s.id}"`);
    sids.add(s.id);
  }

  const vehicles = def.vehicles.map(v => ({ ...v }));
  vehicles.push({ id: AMB_ID, r: def.ambulance.r, c: def.ambulance.c, orient: 'v', len: 2 });

  // Vehicles: on the board, on drivable cells, not overlapping.
  const grid = {};
  for (const v of vehicles) {
    for (const [r, c] of footprint(v.r, v.c, v.orient, v.len)) {
      if (!board.inBounds(r, c)) { errors.push(`vehicle "${v.id}" is off the board at ${r},${c}`); continue; }
      if (!board.drivable[r][c]) errors.push(`vehicle "${v.id}" sits on non-drivable cell ${r},${c}`);
      const k = r + ',' + c;
      if (grid[k]) errors.push(`vehicles "${grid[k]}" and "${v.id}" overlap at ${r},${c}`);
      grid[k] = v.id;
    }
  }

  // Parking spaces: on the board, off the route, not overlapping each other.
  const sgrid = {};
  for (const s of def.spaces) {
    if (s.len < 1 || s.maxLen < 1) errors.push(`space "${s.id}" has invalid size`);
    for (const [r, c] of spaceCells(s)) {
      if (!board.inBounds(r, c)) { errors.push(`space "${s.id}" is off the board at ${r},${c}`); continue; }
      if (board.routeSet.has(r + ',' + c)) errors.push(`space "${s.id}" overlaps the emergency route at ${r},${c}`);
      const k = r + ',' + c;
      if (sgrid[k]) errors.push(`spaces "${sgrid[k]}" and "${s.id}" overlap at ${r},${c}`);
      sgrid[k] = s.id;
    }
  }

  // Emergency route must exist, be drivable, and start under the ambulance.
  if (!board.route.length) errors.push('no emergency route (no "e" cells) defined');
  for (const { r, c } of board.route) {
    if (!board.drivable[r][c]) errors.push(`route cell ${r},${c} is not drivable`);
  }
  for (const [r, c] of footprint(def.ambulance.r, def.ambulance.c, 'v', 2)) {
    if (!board.routeSet.has(r + ',' + c)) warnings.push(`ambulance cell ${r},${c} is not on the route`);
  }

  // Every vehicle blocking the route must have at least one size-compatible space.
  for (const v of def.vehicles) {
    const blocks = footprint(v.r, v.c, v.orient, v.len).some(([r, c]) => board.routeSet.has(r + ',' + c));
    if (blocks && !def.spaces.some(s => s.len >= v.len && s.maxLen >= v.len)) {
      errors.push(`blocking vehicle "${v.id}" has no size-compatible parking space`);
    }
  }

  // The definitive tests: choice-puzzle structure + an actual solver run.
  let solution = null;
  let startMovable = [];
  if (!errors.length) {
    if (routeIsClear(board, vehicles)) errors.push('emergency route is already clear at level start');
    startMovable = movableVehicles(board, vehicles, def.spaces);
    // A real logic puzzle offers a choice: 2-4 legal moves at the start.
    if (startMovable.length < 2 || startMovable.length > 4) {
      errors.push(`level must start with 2-4 movable vehicles, found ${startMovable.length}` +
        (startMovable.length ? ` (${startMovable.join(', ')})` : ''));
    }
    const depth = Math.max(TUNE.solverMaxDepth, def.par + 4);
    solution = solveLevel(board, vehicles, def.spaces, depth);
    if (!solution) errors.push('level is NOT solvable (solver found no solution)');
    else {
      if (solution.length !== def.par) {
        warnings.push(`par is ${def.par} but the optimal solution takes ${solution.length} moves`);
      }
      // At least one legal first move must be a decoy (trap or wasteful), and
      // at least one must be good — otherwise there is no decision to make.
      let good = 0, decoy = 0;
      for (const id of startMovable) {
        for (const t of computeTargets(board, vehicles, def.spaces, id)) {
          const vs2 = vehicles.map(v => v.id === id ? { ...v, r: t.r, c: t.c, orient: t.orient } : v);
          if (routeIsClear(board, vs2)) { good++; continue; }
          const sub = solveLevel(board, vs2, def.spaces, depth);
          if (!sub) decoy++;                              // trap
          else if (1 + sub.length > solution.length) decoy++; // wastes a move
          else good++;                                   // optimal
        }
      }
      if (decoy < 1) errors.push('level has no decoy move (every legal move is optimal)');
      if (good < 1) errors.push('level has no good move among the legal choices');
    }
  }
  return { ok: errors.length === 0, errors, warnings, solution, startMovable };
}

/* -------------------------------- LEVELS ---------------------------------
   Choice-driven traffic puzzles. Grid: 14 rows (0 = top) x 7 cols.
   Drivable road = cols 1-5, emergency route = col 3 (marked 'e').
   Map chars: '.' grass  'r' road  'e' route  't' turning zone  'p' pavement.
   Parking-space cells become drivable automatically. Vehicle anchor = top-left.

   These are NOT one-mover chains. Each level starts with 2-4 legally movable
   vehicles, but only some moves are strategically good — others are decoys
   that waste a bay, block a later car, or trap the player into an Undo. A small
   car fits a long bay, so parking it there too early can strand a van/truck.
   Every board is built and proven by the generator + analyzer: solvable,
   2-4 movable at start, at least one decoy move, and a real decision to make
   (see test.js). */

const ROAD_ROW = '.rrerr.';                  // cols 1-5 drivable, col 3 = route
const roadMap = () => Array.from({ length: ROWS }, () => ROAD_ROW);

const LEVELS = [
  /* L1 "Traffic Jam" — 9 cars, 3 movable, 1 wastes a bay (decoy). */
  { id: 1, name: 'Traffic Jam', par: 7,
    tutorial: { intro: 'Real gridlock! Several cars can move — but not every move helps. Pick the ones that actually free the ambulance lane.' },
    map: roadMap(),
    vehicles:[{id:'c0',kind:'car',color:'#e8443a',len:2,orient:'h',r:9,c:0},{id:'c1',kind:'van',color:'#26c3d7',len:3,orient:'v',r:5,c:5},{id:'c2',kind:'car',color:'#f5920b',len:2,orient:'h',r:5,c:3},{id:'c3',kind:'car',color:'#3b6fe0',len:2,orient:'v',r:1,c:2},{id:'c4',kind:'car',color:'#7ac043',len:2,orient:'v',r:10,c:1},{id:'c5',kind:'car',color:'#9b59d0',len:2,orient:'v',r:9,c:4},{id:'c6',kind:'car',color:'#e46fae',len:2,orient:'h',r:9,c:2},{id:'c7',kind:'van',color:'#d9b34a',len:3,orient:'h',r:2,c:3},{id:'c8',kind:'car',color:'#37c9a5',len:2,orient:'h',r:4,c:2}],
    spaces:[{id:'S0',r:9,c:0,orient:'h',len:2,maxLen:2},{id:'S1',r:10,c:5,orient:'v',len:3,maxLen:3},{id:'S2',r:5,c:5,orient:'h',len:2,maxLen:2},{id:'S3',r:3,c:2,orient:'v',len:2,maxLen:2},{id:'S4',r:12,c:1,orient:'v',len:2,maxLen:2},{id:'S5',r:3,c:4,orient:'v',len:2,maxLen:2},{id:'S6',r:9,c:5,orient:'h',len:2,maxLen:2},{id:'S7',r:2,c:0,orient:'h',len:3,maxLen:3},{id:'S8',r:4,c:5,orient:'h',len:2,maxLen:2}],
    ambulance:{r:12,c:3} },

  /* L2 "Bottleneck" — 11 cars, 3 movable, 1 trap + 1 waste. Long bays matter. */
  { id: 2, name: 'Bottleneck', par: 8,
    map: roadMap(),
    vehicles:[{id:'c0',kind:'car',color:'#e8443a',len:2,orient:'h',r:10,c:0},{id:'c1',kind:'van',color:'#26c3d7',len:3,orient:'h',r:3,c:2},{id:'c2',kind:'car',color:'#f5920b',len:2,orient:'v',r:9,c:5},{id:'c3',kind:'car',color:'#3b6fe0',len:2,orient:'v',r:7,c:5},{id:'c4',kind:'car',color:'#7ac043',len:2,orient:'h',r:10,c:2},{id:'c5',kind:'car',color:'#9b59d0',len:2,orient:'h',r:9,c:2},{id:'c6',kind:'van',color:'#e46fae',len:3,orient:'h',r:2,c:3},{id:'c7',kind:'car',color:'#d9b34a',len:2,orient:'h',r:13,c:0},{id:'c8',kind:'van',color:'#37c9a5',len:3,orient:'v',r:11,c:2},{id:'c9',kind:'car',color:'#c96f35',len:2,orient:'v',r:2,c:1},{id:'c10',kind:'van',color:'#4aa3f0',len:3,orient:'h',r:5,c:2}],
    spaces:[{id:'S0',r:10,c:0,orient:'h',len:2,maxLen:2},{id:'S1',r:3,c:0,orient:'h',len:3,maxLen:3},{id:'S2',r:6,c:5,orient:'v',len:2,maxLen:2},{id:'S3',r:3,c:5,orient:'v',len:2,maxLen:2},{id:'S4',r:10,c:5,orient:'h',len:2,maxLen:2},{id:'S5',r:9,c:5,orient:'h',len:2,maxLen:2},{id:'S6',r:2,c:0,orient:'h',len:3,maxLen:3},{id:'S7',r:13,c:0,orient:'h',len:2,maxLen:2},{id:'S8',r:6,c:2,orient:'v',len:3,maxLen:3},{id:'S9',r:5,c:1,orient:'v',len:2,maxLen:2},{id:'S10',r:5,c:4,orient:'h',len:3,maxLen:3}],
    ambulance:{r:12,c:3} },

  /* L3 "Crossroads" — 13 cars, 4 movable, 2 traps + 2 wastes. Lots of choice. */
  { id: 3, name: 'Crossroads', par: 10,
    map: roadMap(),
    vehicles:[{id:'c0',kind:'van',color:'#e8443a',len:3,orient:'v',r:11,c:1},{id:'c1',kind:'car',color:'#26c3d7',len:2,orient:'h',r:11,c:3},{id:'c2',kind:'van',color:'#f5920b',len:3,orient:'v',r:4,c:4},{id:'c3',kind:'van',color:'#3b6fe0',len:3,orient:'v',r:8,c:2},{id:'c4',kind:'car',color:'#7ac043',len:2,orient:'h',r:0,c:3},{id:'c5',kind:'car',color:'#9b59d0',len:2,orient:'v',r:11,c:2},{id:'c6',kind:'car',color:'#e46fae',len:2,orient:'h',r:8,c:3},{id:'c7',kind:'van',color:'#d9b34a',len:3,orient:'v',r:0,c:5},{id:'c8',kind:'car',color:'#37c9a5',len:2,orient:'h',r:1,c:2},{id:'c9',kind:'car',color:'#c96f35',len:2,orient:'v',r:9,c:4},{id:'c10',kind:'car',color:'#4aa3f0',len:2,orient:'v',r:0,c:1},{id:'c11',kind:'van',color:'#e3d13c',len:3,orient:'h',r:7,c:1},{id:'c12',kind:'van',color:'#8a5cc0',len:3,orient:'v',r:3,c:5}],
    spaces:[{id:'S0',r:4,c:1,orient:'v',len:3,maxLen:3},{id:'S1',r:11,c:0,orient:'h',len:2,maxLen:2},{id:'S2',r:0,c:4,orient:'v',len:3,maxLen:3},{id:'S3',r:0,c:2,orient:'v',len:3,maxLen:3},{id:'S4',r:0,c:5,orient:'h',len:2,maxLen:2},{id:'S5',r:4,c:2,orient:'v',len:2,maxLen:2},{id:'S6',r:8,c:5,orient:'h',len:2,maxLen:2},{id:'S7',r:3,c:5,orient:'v',len:3,maxLen:3},{id:'S8',r:1,c:5,orient:'h',len:2,maxLen:2},{id:'S9',r:9,c:4,orient:'v',len:2,maxLen:2},{id:'S10',r:1,c:1,orient:'v',len:2,maxLen:2},{id:'S11',r:7,c:4,orient:'h',len:3,maxLen:3},{id:'S12',r:10,c:5,orient:'v',len:3,maxLen:3}],
    ambulance:{r:12,c:3} },

  /* L4 "Rush Hour" — 15 cars, 3 movable, a real trap. Trucks need long bays. */
  { id: 4, name: 'Rush Hour', par: 9,
    map: roadMap(),
    vehicles:[{id:'c0',kind:'van',color:'#e8443a',len:3,orient:'h',r:7,c:3},{id:'c1',kind:'car',color:'#26c3d7',len:2,orient:'v',r:8,c:2},{id:'c2',kind:'car',color:'#f5920b',len:2,orient:'h',r:4,c:3},{id:'c3',kind:'truck',color:'#3b6fe0',len:4,orient:'v',r:0,c:1},{id:'c4',kind:'truck',color:'#7ac043',len:4,orient:'v',r:10,c:5},{id:'c5',kind:'van',color:'#9b59d0',len:3,orient:'v',r:4,c:2},{id:'c6',kind:'car',color:'#e46fae',len:2,orient:'h',r:0,c:2},{id:'c7',kind:'car',color:'#d9b34a',len:2,orient:'h',r:10,c:2},{id:'c8',kind:'car',color:'#37c9a5',len:2,orient:'v',r:6,c:1},{id:'c9',kind:'truck',color:'#c96f35',len:4,orient:'v',r:1,c:5},{id:'c10',kind:'truck',color:'#4aa3f0',len:4,orient:'v',r:10,c:4},{id:'c11',kind:'car',color:'#e3d13c',len:2,orient:'h',r:1,c:2},{id:'c12',kind:'car',color:'#8a5cc0',len:2,orient:'v',r:0,c:4},{id:'c13',kind:'car',color:'#ef5f7e',len:2,orient:'h',r:2,c:3},{id:'c14',kind:'van',color:'#3fbfc9',len:3,orient:'v',r:11,c:2}],
    spaces:[{id:'S0',r:7,c:0,orient:'h',len:3,maxLen:3},{id:'S1',r:9,c:2,orient:'v',len:2,maxLen:2},{id:'S2',r:4,c:5,orient:'h',len:2,maxLen:2},{id:'S3',r:2,c:1,orient:'v',len:4,maxLen:4},{id:'S4',r:10,c:5,orient:'v',len:4,maxLen:4},{id:'S5',r:1,c:2,orient:'v',len:3,maxLen:3},{id:'S6',r:0,c:0,orient:'h',len:2,maxLen:2},{id:'S7',r:10,c:0,orient:'h',len:2,maxLen:2},{id:'S8',r:11,c:1,orient:'v',len:2,maxLen:2},{id:'S9',r:6,c:5,orient:'v',len:4,maxLen:4},{id:'S10',r:6,c:4,orient:'v',len:4,maxLen:4},{id:'S11',r:1,c:0,orient:'h',len:2,maxLen:2},{id:'S12',r:0,c:4,orient:'v',len:2,maxLen:2},{id:'S13',r:2,c:5,orient:'h',len:2,maxLen:2},{id:'S14',r:11,c:2,orient:'v',len:3,maxLen:3}],
    ambulance:{r:12,c:3} },

  /* L5 "Deadlock" — 16 cars, 4 movable, 2 wasteful decoys. Plan the sequence. */
  { id: 5, name: 'Deadlock', par: 8,
    map: roadMap(),
    vehicles:[{id:'c0',kind:'van',color:'#e8443a',len:3,orient:'v',r:9,c:4},{id:'c1',kind:'car',color:'#26c3d7',len:2,orient:'h',r:10,c:5},{id:'c2',kind:'car',color:'#f5920b',len:2,orient:'h',r:11,c:0},{id:'c3',kind:'car',color:'#3b6fe0',len:2,orient:'h',r:0,c:5},{id:'c4',kind:'truck',color:'#7ac043',len:4,orient:'v',r:10,c:2},{id:'c5',kind:'car',color:'#9b59d0',len:2,orient:'v',r:6,c:1},{id:'c6',kind:'car',color:'#e46fae',len:2,orient:'h',r:1,c:5},{id:'c7',kind:'car',color:'#d9b34a',len:2,orient:'h',r:9,c:2},{id:'c8',kind:'car',color:'#37c9a5',len:2,orient:'h',r:0,c:3},{id:'c9',kind:'car',color:'#c96f35',len:2,orient:'h',r:10,c:0},{id:'c10',kind:'truck',color:'#4aa3f0',len:4,orient:'v',r:2,c:5},{id:'c11',kind:'van',color:'#e3d13c',len:3,orient:'h',r:1,c:2},{id:'c12',kind:'van',color:'#8a5cc0',len:3,orient:'h',r:12,c:4},{id:'c13',kind:'car',color:'#ef5f7e',len:2,orient:'v',r:0,c:1},{id:'c14',kind:'car',color:'#3fbfc9',len:2,orient:'h',r:5,c:3},{id:'c15',kind:'car',color:'#e8443a',len:2,orient:'h',r:2,c:2}],
    spaces:[{id:'S0',r:3,c:4,orient:'v',len:3,maxLen:3},{id:'S1',r:10,c:5,orient:'h',len:2,maxLen:2},{id:'S2',r:11,c:0,orient:'h',len:2,maxLen:2},{id:'S3',r:0,c:5,orient:'h',len:2,maxLen:2},{id:'S4',r:5,c:2,orient:'v',len:4,maxLen:4},{id:'S5',r:8,c:1,orient:'v',len:2,maxLen:2},{id:'S6',r:1,c:5,orient:'h',len:2,maxLen:2},{id:'S7',r:9,c:5,orient:'h',len:2,maxLen:2},{id:'S8',r:0,c:0,orient:'h',len:2,maxLen:2},{id:'S9',r:10,c:0,orient:'h',len:2,maxLen:2},{id:'S10',r:5,c:5,orient:'v',len:4,maxLen:4},{id:'S11',r:1,c:0,orient:'h',len:3,maxLen:3},{id:'S12',r:12,c:4,orient:'h',len:3,maxLen:3},{id:'S13',r:3,c:1,orient:'v',len:2,maxLen:2},{id:'S14',r:5,c:0,orient:'h',len:2,maxLen:2},{id:'S15',r:2,c:5,orient:'h',len:2,maxLen:2}],
    ambulance:{r:12,c:3} },
];

/* =========================================================================
   3. BROWSER PRESENTATION
   ========================================================================= */

const IS_BROWSER = typeof document !== 'undefined';

if (IS_BROWSER) {

/* ------------------------------- AUDIO ----------------------------------- */
class AudioManager {
  constructor(save) {
    this.save = save;
    this.ctx = null;
    this.sirenNodes = null;
    this.sirenTimer = null;
  }
  get enabled() { return this.save.data.sound; }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    } catch (e) { /* audio unavailable — game still playable */ }
  }
  tone(freq, dur, { type = 'sine', gain = 0.12, slide = 0, delay = 0 } = {}) {
    if (!this.ctx || !this.enabled) return;
    try {
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    } catch (e) { /* ignore */ }
  }
  click()    { this.tone(600, 0.07, { type: 'square', gain: 0.05 }); }
  select()   { this.tone(440, 0.09, { type: 'triangle', slide: 220, gain: 0.1 }); }
  park()     { this.tone(520, 0.1, { type: 'triangle', gain: 0.12 }); this.tone(780, 0.14, { type: 'triangle', gain: 0.12, delay: 0.09 }); }
  invalid()  { this.tone(160, 0.18, { type: 'sawtooth', gain: 0.08, slide: -60 }); }
  undo()     { this.tone(500, 0.1, { type: 'triangle', slide: -220, gain: 0.1 }); }
  hint()     { this.tone(900, 0.08, { type: 'sine', gain: 0.09 }); this.tone(1200, 0.1, { type: 'sine', gain: 0.09, delay: 0.09 }); }
  complete() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.16, { type: 'triangle', gain: 0.12, delay: i * 0.12 }));
  }
  sirenStart() {
    if (!this.ctx || !this.enabled || this.sirenNodes) return;
    try {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 680;
      g.gain.value = 0.055;
      osc.connect(g).connect(this.ctx.destination);
      osc.start();
      this.sirenNodes = { osc, g };
      let hi = false;
      this.sirenTimer = setInterval(() => {
        if (!this.sirenNodes) return;
        hi = !hi;
        const t = this.ctx.currentTime;
        this.sirenNodes.osc.frequency.cancelScheduledValues(t);
        this.sirenNodes.osc.frequency.setValueAtTime(this.sirenNodes.osc.frequency.value, t);
        this.sirenNodes.osc.frequency.linearRampToValueAtTime(hi ? 920 : 680, t + 0.28);
      }, 300);
    } catch (e) { /* ignore */ }
  }
  sirenStop() {
    if (this.sirenTimer) { clearInterval(this.sirenTimer); this.sirenTimer = null; }
    if (this.sirenNodes) {
      try {
        const t = this.ctx.currentTime;
        this.sirenNodes.g.gain.linearRampToValueAtTime(0.0001, t + 0.25);
        this.sirenNodes.osc.stop(t + 0.3);
      } catch (e) { /* ignore */ }
      this.sirenNodes = null;
    }
  }
}

/* ------------------------------ SAVE MANAGER ----------------------------- */
class SaveManager {
  constructor() {
    this.key = 'ctw_save_v1';
    this.data = {
      coins: 0,
      unlocked: 1,                 // number of unlocked levels
      best: {},                    // levelId -> { stars, moves }
      sound: true,
      tutorialDone: false,
      endlessBest: 0,              // highest Endless round reached
      ownedSkins: ['classic'],    // skin ids the player owns
      skin: 'classic',            // equipped ambulance skin
      adsRemoved: false,          // "remove ads" purchase (demo)
    };
    this.load();
  }
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* private mode etc. */ }
    // Normalise: the default skin is always owned and equipped skin must exist.
    if (!Array.isArray(this.data.ownedSkins)) this.data.ownedSkins = ['classic'];
    if (!this.data.ownedSkins.includes('classic')) this.data.ownedSkins.unshift('classic');
    if (!this.data.ownedSkins.includes(this.data.skin)) this.data.skin = 'classic';
  }
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  }
}

/* ------------------------------- PARTICLES ------------------------------- */
class ParticleSystem {
  constructor() {
    this.pool = [];
    for (let i = 0; i < 260; i++) this.pool.push({ active: false });
  }
  spawn(props) {
    const p = this.pool.find(p => !p.active) || this.pool[0];
    Object.assign(p, { active: true, age: 0, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 10 }, props);
  }
  confetti(x, y, n = 60) {
    const colors = ['#ff5b4d', '#ffb42e', '#2ecc71', '#4aa3f0', '#e46fae', '#fff26b'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 240;
      this.spawn({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 160,
        g: 420, life: 1.2 + Math.random() * 0.9,
        w: 5 + Math.random() * 5, h: 3 + Math.random() * 4,
        color: colors[(Math.random() * colors.length) | 0], shape: 'rect',
      });
    }
  }
  sparkle(x, y, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 90;
      this.spawn({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        g: 60, life: 0.35 + Math.random() * 0.35,
        w: 3, h: 3, color: '#ffffff', shape: 'dot',
      });
    }
  }
  update(dt) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { p.active = false; continue; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
  }
  draw(ctx) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const a = 1 - p.age / p.life;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      else { ctx.beginPath(); ctx.arc(0, 0, p.w, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
  }
}

/* ------------------------------ MOVE HISTORY ----------------------------- */
class MoveHistory {
  constructor() { this.stack = []; }
  push(rec) {
    this.stack.push(rec);
    if (this.stack.length > TUNE.historyMax) this.stack.shift();
  }
  pop() { return this.stack.pop(); }
  clear() { this.stack.length = 0; }
  get length() { return this.stack.length; }
}

/* ------------------------------ HINT SYSTEM ------------------------------ */
class HintSystem {
  /** Best next move: the solver's first move, with a heuristic fallback. */
  static getHint(game) {
    const vehicles = game.allObstacles();
    // The strategically correct move is the first step of an optimal solution.
    const solution = solveLevel(game.board, vehicles, game.spacesPlain(), game.vehicles.length + 4);
    // No solution from here means the player has trapped themselves -> suggest undo.
    if (!solution || !solution.length) return null;
    const vehicleId = solution[0].vehicleId;
    const spaceId = solution[0].spaceId;
    const ts = computeTargets(game.board, vehicles, game.spacesPlain(), vehicleId);
    const t = ts.find(t => t.spaceId === spaceId) || ts[0];
    if (!t) return null;
    return { vehicleId, spaceId: t.spaceId, path: t.path,
      reason: HintSystem.reason(game, vehicleId, t) };
  }

  /** A short strategic explanation for the recommended move. */
  static reason(game, vehicleId, target) {
    const veh = game.vehicleById(vehicleId);
    const space = game.spaceById(target.spaceId);
    const onRoute = footprint(veh.r, veh.c, veh.orient, veh.len)
      .some(([r, c]) => game.board.routeSet.has(r + ',' + c));

    // Is there a free long bay that a small car could wrongly steal? Then the
    // key lesson is to protect it for the vehicle that actually needs it.
    const longBays = game.spaces.filter(s => s.len >= 3 && game.spaceIsFree(s));
    const bigCarsNeedingBay = game.vehicles.some(v => v.len >= 3 && !v.spaceId);
    if (longBays.length && bigCarsNeedingBay && veh.len < 3) {
      const tempted = game.movableIds && [...game.movableIds].some(id => {
        const c = game.vehicleById(id);
        if (!c || c.len >= 3) return false;
        return computeTargets(game.board, game.allObstacles(), game.spaces, id)
          .some(tt => { const sp = game.spaceById(tt.spaceId); return sp && sp.len >= 3; });
      });
      if (tempted) return 'Keep the long bay free for a bigger vehicle.';
    }

    if (veh.len >= 3 && space && space.len >= 3) return 'Get the long vehicle into the long bay.';
    if (onRoute) return 'This clears the emergency lane.';
    return 'Move this to open up the jam.';
  }
}

/* -------------------------------- UI MANAGER ----------------------------- */
class UIManager {
  constructor() {
    const $ = id => document.getElementById(id);
    this.el = {
      hudLevel: $('hudLevel'), hudMoves: $('hudMoves'), hudCoins: $('hudCoins'),
      btnPause: $('btnPause'), btnUndo: $('btnUndo'), btnHint: $('btnHint'),
      btnRestart: $('btnRestart'), hintBadge: $('hintBadge'),
      toast: $('toast'), tutorialBox: $('tutorialBox'),
      overlay: $('overlay'),
      panelPause: $('panelPause'), panelComplete: $('panelComplete'),
      panelMenu: $('panelMenu'), panelConfirm: $('panelConfirm'),
      btnResume: $('btnResume'), btnPauseRestart: $('btnPauseRestart'),
      btnPauseSound: $('btnPauseSound'), btnPauseMenu: $('btnPauseMenu'),
      starRow: $('starRow'), statMoves: $('statMoves'), statBest: $('statBest'),
      statCoins: $('statCoins'), btnNext: $('btnNext'), btnReplay: $('btnReplay'),
      btnCompleteMenu: $('btnCompleteMenu'),
      levelGrid: $('levelGrid'), btnMenuSound: $('btnMenuSound'),
      btnMenuTutorial: $('btnMenuTutorial'), btnEndless: $('btnEndless'), btnShop: $('btnShop'),
      confirmText: $('confirmText'), btnConfirmYes: $('btnConfirmYes'), btnConfirmNo: $('btnConfirmNo'),
      panelShop: $('panelShop'), shopCoins: $('shopCoins'), skinGrid: $('skinGrid'),
      btnWatchAd: $('btnWatchAd'), shopPacks: $('shopPacks'), btnShopClose: $('btnShopClose'),
      panelAd: $('panelAd'), adReason: $('adReason'), adReward: $('adReward'),
      adCount: $('adCount'), adSkip: $('adSkip'), adClaim: $('adClaim'),
      panelAdOffer: $('panelAdOffer'), adOfferReward: $('adOfferReward'),
      btnAdOfferWatch: $('btnAdOfferWatch'), btnAdOfferSkip: $('btnAdOfferSkip'),
      panelStuck: $('panelStuck'), btnStuckAd: $('btnStuckAd'),
      btnStuckUndo: $('btnStuckUndo'), btnStuckRestart: $('btnStuckRestart'),
    };
    this.toastTimer = null;
    this.confirmCb = null;
  }
  updateHUD(label, moves, par, coins) {
    this.el.hudLevel.textContent = label;
    this.el.hudMoves.textContent = `MOVES ${moves} / ${par}`;
    this.el.hudCoins.textContent = coins;
  }
  updateUndo(enabled) { this.el.btnUndo.disabled = !enabled; }
  updateHintBadge(hintsLeft) {
    this.el.hintBadge.textContent = hintsLeft > 0 ? hintsLeft : '🪙' + TUNE.hintCoinCost;
    this.el.hintBadge.textContent = hintsLeft > 0 ? String(hintsLeft) : TUNE.hintCoinCost + 'c';
  }
  toast(text, ms = 1400) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.remove('hidden');
    // retrigger the pop animation
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  tutorial(text) {
    if (!text) { this.el.tutorialBox.classList.add('hidden'); return; }
    this.el.tutorialBox.textContent = text;
    this.el.tutorialBox.classList.remove('hidden');
  }
  hideAllPanels() {
    for (const p of [this.el.panelPause, this.el.panelComplete, this.el.panelMenu, this.el.panelConfirm,
                     this.el.panelShop, this.el.panelAd, this.el.panelAdOffer, this.el.panelStuck]) {
      p.classList.add('hidden');
    }
    this.el.overlay.classList.add('hidden');
  }
  showPanel(panel) {
    this.hideAllPanels();
    this.el.overlay.classList.remove('hidden');
    panel.classList.remove('hidden');
  }
  showPause(soundOn) {
    this.el.btnPauseSound.textContent = 'SOUND: ' + (soundOn ? 'ON' : 'OFF');
    this.showPanel(this.el.panelPause);
  }
  showComplete({ stars, moves, best, earned, isLast, endless }) {
    const spans = this.el.starRow.querySelectorAll('span');
    spans.forEach((s, i) => s.classList.toggle('lit', i < stars));
    this.el.statMoves.textContent = moves;
    if (endless) {
      this.el.statBest.textContent = 'round ' + (best ? best.moves : 1);
    } else {
      this.el.statBest.textContent = best ? `${best.moves} moves · ${'★'.repeat(best.stars)}` : '–';
    }
    this.el.statCoins.textContent = '+' + earned;
    this.el.btnNext.textContent = endless ? 'NEXT MAP' : isLast ? 'MAIN MENU' : 'NEXT LEVEL';
    this.showPanel(this.el.panelComplete);
  }
  showMenu(save, curatedCount, onPick, soundOn, onEndless, onShop) {
    this.el.btnMenuSound.textContent = 'SOUND: ' + (soundOn ? 'ON' : 'OFF');
    this.el.btnShop.onclick = onShop;
    const grid = this.el.levelGrid;
    grid.innerHTML = '';
    // Infinite campaign: show every unlocked level plus one locked "next",
    // capped so the grid stays light. The panel scrolls if it grows.
    const unlocked = save.data.unlocked;
    const count = Math.min(60, Math.max(curatedCount, unlocked) + 1);
    for (let i = 0; i < count; i++) {
      const n = i + 1;
      const isUnlocked = i < unlocked;
      const btn = document.createElement('button');
      btn.className = 'level-cell' + (isUnlocked ? '' : ' locked');
      const best = save.data.best[n];
      const stars = best ? best.stars : 0;
      btn.innerHTML = isUnlocked
        ? `${n}<span class="lv-stars">` +
          [0, 1, 2].map(s => `<span class="${s < stars ? 'on' : ''}">★</span>`).join('') +
          '</span>'
        : '🔒';
      if (isUnlocked) btn.addEventListener('click', () => onPick(i));
      grid.appendChild(btn);
    }
    const eb = this.el.btnEndless;
    const rec = save.data.endlessBest || 0;
    eb.innerHTML = '∞ ENDLESS<span class="endless-sub">' +
      (rec ? 'best: round ' + rec : 'infinite fresh puzzles') + '</span>';
    eb.onclick = onEndless;
    this.showPanel(this.el.panelMenu);
  }
  confirm(text, cb, cancelCb) {
    this.el.confirmText.textContent = text;
    this.confirmCb = cb;
    this.confirmCancelCb = cancelCb || null;
    this.showPanel(this.el.panelConfirm);
  }

  /* ---- shop: ambulance skins + coin packs + rewarded ad ---- */
  showShop(save, skins, cb) {
    this.el.shopCoins.textContent = save.data.coins;
    const grid = this.el.skinGrid;
    grid.innerHTML = '';
    for (const skin of skins) {
      const owned = save.data.ownedSkins.includes(skin.id);
      const equipped = save.data.skin === skin.id;
      const cell = document.createElement('div');
      cell.className = 'skin-cell' + (equipped ? ' equipped' : '');
      cell.innerHTML =
        `<div class="skin-amb" style="--b0:${skin.body[0]};--b1:${skin.body[1]};--st:${skin.stripe};--cr:${skin.cross}">
           <span class="skin-cross"></span></div>
         <div class="skin-name">${skin.name}</div>
         <button class="skin-btn ${equipped ? 'is-equipped' : owned ? 'is-owned' : 'is-buy'}">${
           equipped ? 'EQUIPPED' : owned ? 'EQUIP' : '🪙 ' + skin.cost}</button>`;
      const btn = cell.querySelector('.skin-btn');
      if (!equipped) btn.addEventListener('click', () => owned ? cb.onEquip(skin.id) : cb.onBuy(skin.id));
      grid.appendChild(cell);
    }
    this.el.btnWatchAd.onclick = cb.onWatchAd;
    this.el.shopPacks.querySelectorAll('[data-coins]').forEach(b => {
      b.onclick = () => cb.onPack(parseInt(b.dataset.coins, 10), b.dataset.label || '');
    });
    this.el.btnShopClose.onclick = cb.onClose;
    this.showPanel(this.el.panelShop);
  }

  /* ---- simulated rewarded ad player ---- */
  playAd(reward, reason, onReward) {
    clearInterval(this._adInt);
    const panel = this.el.panelAd;
    let left = TUNE.adWatchSecs;
    const skip = this.el.adSkip, claim = this.el.adClaim, count = this.el.adCount;
    this.el.adReason.textContent = reason || 'Reward';
    this.el.adReward.textContent = reward > 0 ? '+' + reward + ' coins' : 'Undo + free hint';
    claim.classList.add('hidden');
    skip.classList.add('hidden');
    count.textContent = left + 's';
    this.showPanel(panel);
    const tick = () => {
      left--;
      count.textContent = left > 0 ? left + 's' : '';
      if (left <= 0) {
        clearInterval(this._adInt);
        claim.classList.remove('hidden');
        skip.classList.remove('hidden');
      }
    };
    this._adInt = setInterval(tick, 1000);
    claim.onclick = () => { clearInterval(this._adInt); this.hideAllPanels(); onReward(); };
    skip.onclick = () => { clearInterval(this._adInt); this.hideAllPanels(); onReward(); };
  }

  /* ---- periodic rewarded-ad offer ---- */
  showAdOffer(reward, cb) {
    this.el.adOfferReward.textContent = '+' + reward + ' coins';
    this.el.btnAdOfferWatch.onclick = cb.onWatch;
    this.el.btnAdOfferSkip.onclick = cb.onSkip;
    this.showPanel(this.el.panelAdOffer);
  }

  /* ---- "you're stuck" screen: ad-help, undo, or restart ---- */
  showStuck(cb) {
    this.el.btnStuckUndo.style.display = cb.canUndo ? '' : 'none';
    this.el.btnStuckAd.onclick = cb.onAd;
    this.el.btnStuckUndo.onclick = cb.onUndo;
    this.el.btnStuckRestart.onclick = cb.onRestart;
    this.showPanel(this.el.panelStuck);
  }
}

/* -------------------------------- RENDERER -------------------------------
   Pure drawing. Reads game state, never mutates it. */
class Renderer {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { ox: 0, oy: 0, cs: 32, w: 0, h: 0 };
    this.dashOffset = 0;
    this.dpr = 1;
    this.ground = null;       // offscreen cache of all static scenery
    this.groundDirty = true;  // rebuilt lazily on the next frame
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height;
    const cs = Math.floor(Math.min(w / COLS, h / ROWS));
    this.view = {
      cs,
      ox: Math.floor((w - cs * COLS) / 2),
      oy: Math.floor((h - cs * ROWS) / 2),
      w, h,
    };
    this.groundDirty = true;
  }

  /* Pixel pose (center + angle) of a vehicle state. */
  poseOf(state, len) {
    const { ox, oy, cs } = this.view;
    const cx = ox + (state.c + (state.o === 'h' ? len / 2 : 0.5)) * cs;
    const cy = oy + (state.r + (state.o === 'v' ? len / 2 : 0.5)) * cs;
    return { x: cx, y: cy, angle: state.o === 'v' ? -Math.PI / 2 : 0 };
  }

  cellCenter(r, c) {
    const { ox, oy, cs } = this.view;
    return { x: ox + (c + 0.5) * cs, y: oy + (r + 0.5) * cs };
  }

  rrOn(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  rr(x, y, w, h, r) { this.rrOn(this.ctx, x, y, w, h, r); }

  draw(t, dt) {
    const g = this.game, ctx = this.ctx, { w, h } = this.view;
    this.dashOffset -= dt * 26;

    if ((this.groundDirty || !this.ground) && g.board) this.renderGround();

    ctx.clearRect(0, 0, w, h);

    // Camera shake while the ambulance is racing out.
    ctx.save();
    if (g.shakeUntil > t) {
      const m = 2.6;
      ctx.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2);
    }

    if (this.ground) {
      ctx.drawImage(this.ground, 0, 0, this.ground.width, this.ground.height, 0, 0, w, h);
    }
    this.drawRouteFx(t);
    this.drawSpaceHighlights(t);
    this.drawExit(t);
    this.drawDynamicDecor(t);
    this.drawHintPath(t);
    this.drawDragPreview(t);
    this.drawVehicles(t);
    this.drawGhost(t);
    g.particles.draw(ctx);
    this.drawVignette();
    if (DEBUG) this.drawDebug();

    ctx.restore();
  }

  /* ---- static scenery cache: grass, road, sidewalks, bays, buildings ---- */
  renderGround() {
    const g = this.game, b = g.board;
    const { ox, oy, cs, w, h } = this.view;
    const dpr = this.dpr;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rand = mulberry32(g.seedNum * 911 + 17);

    // Grass: warm top-lit gradient + soft checker + mottled patches.
    const lawn = c.createLinearGradient(0, 0, 0, h);
    lawn.addColorStop(0, '#8ed162');
    lawn.addColorStop(1, '#6fbc48');
    c.fillStyle = lawn;
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.055)';
    for (let r = -2; r < ROWS + 2; r++) {
      for (let cc = -2; cc < COLS + 2; cc++) {
        if ((r + cc) % 2 === 0) c.fillRect(ox + cc * cs, oy + r * cs, cs, cs);
      }
    }
    for (let i = 0; i < 26; i++) {
      c.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(30,80,20,0.05)';
      c.beginPath();
      c.ellipse(rand() * w, rand() * h, cs * (0.6 + rand()), cs * (0.35 + rand() * 0.6), rand() * 3, 0, Math.PI * 2);
      c.fill();
    }

    // Sidewalk / apron cells: concrete tiles with seams.
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (b.type[r][cc] !== TILE.PAVE) continue;
        const x = ox + cc * cs, y = oy + r * cs;
        const pv = c.createLinearGradient(x, y, x, y + cs);
        pv.addColorStop(0, '#d5dbe2');
        pv.addColorStop(1, '#c3cad3');
        c.fillStyle = pv;
        c.fillRect(x, y, cs, cs);
        c.strokeStyle = 'rgba(90,100,115,0.16)';
        c.lineWidth = 1;
        c.strokeRect(x + 0.5, y + 0.5, cs - 1, cs - 1);
      }
    }

    // Road: asphalt with subtle speckle texture.
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (b.type[r][cc] !== TILE.ROAD) continue;
        const x = ox + cc * cs, y = oy + r * cs;
        c.fillStyle = '#51565f';
        c.fillRect(x, y, cs, cs);
        for (let i = 0; i < 6; i++) {
          c.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.07)';
          c.fillRect(x + rand() * (cs - 2), y + rand() * (cs - 2), 2, 2);
        }
      }
    }

    // Curbs: light stone with a darker seam toward the road.
    const curb = Math.max(2.5, cs * 0.1);
    const seam = Math.max(1, cs * 0.028);
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (!b.drivable[r][cc]) continue;
        const x = ox + cc * cs, y = oy + r * cs;
        if (cc === 0 || !b.drivable[r][cc - 1]) {
          c.fillStyle = '#e9edf1'; c.fillRect(x, y, curb, cs);
          c.fillStyle = 'rgba(35,45,60,0.28)'; c.fillRect(x + curb, y, seam, cs);
        }
        if (cc === COLS - 1 || !b.drivable[r][cc + 1]) {
          c.fillStyle = '#e9edf1'; c.fillRect(x + cs - curb, y, curb, cs);
          c.fillStyle = 'rgba(35,45,60,0.28)'; c.fillRect(x + cs - curb - seam, y, seam, cs);
        }
        if (r === 0 || !b.drivable[r - 1][cc]) {
          c.fillStyle = '#e9edf1'; c.fillRect(x, y, cs, curb);
          c.fillStyle = 'rgba(35,45,60,0.28)'; c.fillRect(x, y + curb, cs, seam);
        }
        if (r === ROWS - 1 || !b.drivable[r + 1][cc]) {
          c.fillStyle = '#e9edf1'; c.fillRect(x, y + cs - curb, cs, curb);
          c.fillStyle = 'rgba(35,45,60,0.28)'; c.fillRect(x, y + cs - curb - seam, cs, seam);
        }
      }
    }

    // Dashed lane separators beside the emergency lane.
    c.strokeStyle = 'rgba(244,246,248,0.55)';
    c.lineWidth = Math.max(2, cs * 0.055);
    c.setLineDash([cs * 0.45, cs * 0.4]);
    for (const lx of [3, 4]) {
      let run = null;
      for (let r = 0; r <= ROWS; r++) {
        const on = r < ROWS && b.type[r][lx - 1] === TILE.ROAD && b.type[r][lx] === TILE.ROAD;
        if (on && run === null) run = r;
        if ((!on || r === ROWS) && run !== null) {
          c.beginPath();
          c.moveTo(ox + lx * cs, oy + run * cs + 3);
          c.lineTo(ox + lx * cs, oy + r * cs - 3);
          c.stroke();
          run = null;
        }
      }
    }
    c.setLineDash([]);

    // Emergency lane: warm tint + red dashed edge lines.
    for (const p of b.route) {
      c.fillStyle = 'rgba(255,110,80,0.10)';
      c.fillRect(ox + p.c * cs, oy + p.r * cs, cs, cs);
    }
    if (b.route.length) {
      const col = b.route[0].c;
      const rows = b.route.map(p => p.r);
      const r0 = Math.min(...rows), r1 = Math.max(...rows);
      c.strokeStyle = 'rgba(255,96,70,0.5)';
      c.lineWidth = Math.max(2, cs * 0.05);
      c.setLineDash([cs * 0.3, cs * 0.24]);
      for (const x of [ox + col * cs + cs * 0.07, ox + (col + 1) * cs - cs * 0.07]) {
        c.beginPath();
        c.moveTo(x, oy + r0 * cs);
        c.lineTo(x, oy + (r1 + 1) * cs);
        c.stroke();
      }
      c.setLineDash([]);
    }

    // A couple of manhole covers on the outer lanes.
    const spaceCellSet = new Set();
    for (const sp of g.spaces) for (const [r, cc] of spaceCells(sp)) spaceCellSet.add(r + ',' + cc);
    let holes = 0;
    for (let tries = 0; tries < 30 && holes < 2; tries++) {
      const r = 1 + Math.floor(rand() * (ROWS - 2));
      const cc = rand() < 0.5 ? 2 : 4;
      if (b.type[r][cc] !== TILE.ROAD) continue;
      if (b.routeSet.has(r + ',' + cc) || spaceCellSet.has(r + ',' + cc)) continue;
      const x = ox + (cc + 0.5) * cs, y = oy + (r + 0.5) * cs;
      c.fillStyle = '#3e434c';
      c.beginPath(); c.arc(x, y, cs * 0.2, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, cs * 0.2, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(x, y, cs * 0.11, 0, Math.PI * 2); c.stroke();
      holes++;
    }

    // Parking bays: tinted slab, painted white outline, big P.
    for (const sp of g.spaces) {
      const cells = spaceCells(sp);
      const minR = Math.min(...cells.map(p => p[0])), maxR = Math.max(...cells.map(p => p[0]));
      const minC = Math.min(...cells.map(p => p[1])), maxC = Math.max(...cells.map(p => p[1]));
      const x = ox + minC * cs + cs * 0.08, y = oy + minR * cs + cs * 0.08;
      const wd = (maxC - minC + 1) * cs - cs * 0.16, ht = (maxR - minR + 1) * cs - cs * 0.16;
      c.fillStyle = 'rgba(70,90,120,0.10)';
      this.rrOn(c, x, y, wd, ht, cs * 0.14); c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = Math.max(2, cs * 0.065);
      this.rrOn(c, x, y, wd, ht, cs * 0.14); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.75)';
      c.font = `900 ${Math.round(cs * 0.52)}px "Trebuchet MS", sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('P', x + wd / 2, y + ht / 2 + 1);
    }

    // Picket fences along the top and bottom grass strips.
    for (const r of [0, ROWS - 1]) {
      for (let cc = 0; cc < COLS; cc++) {
        if (b.drivable[r][cc]) continue;
        this.paintFence(c, ox + cc * cs, oy + r * cs + cs * 0.34, cs);
      }
    }

    // Static decorations: houses, hydrants, rocks, flowers.
    for (const d of g.decor) {
      const x = ox + d.x * cs, y = oy + d.y * cs, s = d.s * cs;
      if (d.kind === 'house') this.paintHouse(c, x, y, s, d.seed);
      else if (d.kind === 'hydrant') this.paintHydrant(c, x, y, s);
      else if (d.kind === 'rock') this.paintRock(c, x, y, s, d.seed);
      else if (d.kind === 'flower') this.paintFlower(c, x, y, s, d.seed);
    }

    this.ground = cv;
    this.groundDirty = false;
  }

  paintFence(c, x, y, cs) {
    c.fillStyle = 'rgba(20,30,45,0.10)';
    c.fillRect(x + cs * 0.04, y + cs * 0.2, cs * 0.92, cs * 0.06);
    c.fillStyle = '#efe4c8';
    c.fillRect(x, y + cs * 0.08, cs, cs * 0.05);
    c.fillRect(x, y + cs * 0.2, cs, cs * 0.05);
    c.fillStyle = '#f7efdb';
    for (let i = 0; i < 4; i++) {
      const px = x + cs * (0.06 + i * 0.27);
      this.rrOn(c, px, y, cs * 0.08, cs * 0.32, cs * 0.03);
      c.fill();
    }
  }

  paintHouse(c, x, y, s, seed) {
    const palettes = [['#e2694f', '#c94f38'], ['#5f8fd0', '#4674b4'],
                      ['#e8b04c', '#cc9236'], ['#7fb069', '#639152']];
    const [roofA, roofB] = palettes[Math.floor(seed * palettes.length) % palettes.length];
    c.save();
    c.translate(x, y);
    c.rotate((seed - 0.5) * 0.12);
    c.fillStyle = 'rgba(20,30,45,0.18)';
    this.rrOn(c, -s * 0.44, -s * 0.32, s, s * 0.84, s * 0.1); c.fill();
    c.fillStyle = '#f0e6d4';
    this.rrOn(c, -s * 0.5, -s * 0.42, s, s * 0.84, s * 0.08); c.fill();
    const gr = c.createLinearGradient(0, -s * 0.36, 0, s * 0.36);
    gr.addColorStop(0, roofA); gr.addColorStop(1, roofB);
    c.fillStyle = gr;
    this.rrOn(c, -s * 0.44, -s * 0.36, s * 0.88, s * 0.72, s * 0.07); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.18)';
    c.lineWidth = Math.max(1, s * 0.03);
    this.rrOn(c, -s * 0.44, -s * 0.36, s * 0.88, s * 0.72, s * 0.07); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.beginPath(); c.moveTo(-s * 0.36, 0); c.lineTo(s * 0.36, 0); c.stroke();
    c.fillStyle = '#b0492f';
    this.rrOn(c, s * 0.12, -s * 0.28, s * 0.16, s * 0.16, s * 0.03); c.fill();
    c.restore();
  }

  paintHydrant(c, x, y, s) {
    c.fillStyle = 'rgba(20,30,45,0.2)';
    c.beginPath(); c.ellipse(x + s * 0.12, y + s * 0.16, s * 0.5, s * 0.32, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#d8402f';
    c.beginPath(); c.arc(x, y, s * 0.42, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#f26a52';
    c.beginPath(); c.arc(x - s * 0.1, y - s * 0.12, s * 0.24, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ffd75e';
    c.beginPath(); c.arc(x, y, s * 0.1, 0, Math.PI * 2); c.fill();
  }

  paintRock(c, x, y, s, seed) {
    c.fillStyle = 'rgba(20,30,45,0.15)';
    c.beginPath(); c.ellipse(x + s * 0.1, y + s * 0.14, s, s * 0.7, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#a8b0ba';
    c.beginPath(); c.ellipse(x, y, s, s * 0.75, seed, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#c2c9d2';
    c.beginPath(); c.ellipse(x - s * 0.2, y - s * 0.18, s * 0.55, s * 0.4, seed, 0, Math.PI * 2); c.fill();
  }

  paintFlower(c, x, y, s, seed) {
    c.fillStyle = seed > 0.5 ? '#ff9db0' : '#ffe08a';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + seed * 6;
      c.beginPath();
      c.arc(x + Math.cos(a) * s * 0.3, y + Math.sin(a) * s * 0.3, s * 0.2, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = '#ffffff';
    c.beginPath(); c.arc(x, y, s * 0.16, 0, Math.PI * 2); c.fill();
  }

  /* ---- per-frame dynamic layers over the cached ground ---- */
  drawRouteFx(t) {
    const g = this.game, ctx = this.ctx, { ox, oy, cs } = this.view;
    const crawl = (t * 0.018) % (cs * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = Math.max(2, cs * 0.07);
    ctx.lineCap = 'round';
    for (const { r, c } of g.board.route) {
      if (r % 2 !== 0) continue;
      const cx = ox + (c + 0.5) * cs;
      const cy = oy + (r + 0.62) * cs - crawl * 0.5;
      if (cy < oy + r * cs - cs || cy > oy + (r + 1) * cs + cs) continue;
      ctx.beginPath();
      ctx.moveTo(cx - cs * 0.16, cy);
      ctx.lineTo(cx, cy - cs * 0.16);
      ctx.lineTo(cx + cs * 0.16, cy);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // Tutorial route highlight pulse.
    if (g.routeGlowUntil > t) {
      const a = 0.16 + 0.12 * Math.sin(t * 0.012);
      ctx.fillStyle = `rgba(255,90,70,${a})`;
      for (const { r, c } of g.board.route) ctx.fillRect(ox + c * cs, oy + r * cs, cs, cs);
    }
  }

  drawDynamicDecor(t) {
    const g = this.game, ctx = this.ctx, { ox, oy, cs } = this.view;
    for (const d of g.decor) {
      if (d.kind !== 'tree' && d.kind !== 'bush') continue;
      const x = ox + d.x * cs, y = oy + d.y * cs, s = d.s * cs;
      const sway = Math.sin(t * 0.0011 + d.seed * 9) * cs * 0.03;
      if (d.kind === 'tree') {
        ctx.fillStyle = 'rgba(20,30,45,0.16)';
        ctx.beginPath(); ctx.ellipse(x + s * 0.18, y + s * 0.26, s * 1.02, s * 0.68, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#377f2f';
        ctx.beginPath(); ctx.arc(x + sway, y, s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4d9c3f';
        ctx.beginPath(); ctx.arc(x + sway - s * 0.18, y - s * 0.2, s * 0.78, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#66b551';
        ctx.beginPath(); ctx.arc(x + sway - s * 0.3, y - s * 0.32, s * 0.42, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(20,30,45,0.14)';
        ctx.beginPath(); ctx.ellipse(x + s * 0.12, y + s * 0.18, s * 1.05, s * 0.7, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#4d9c3f';
        ctx.beginPath(); ctx.arc(x + sway * 0.5, y, s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#63af4e';
        ctx.beginPath(); ctx.arc(x + sway * 0.5 - s * 0.25, y - s * 0.25, s * 0.55, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  drawVignette() {
    const ctx = this.ctx, { w, h } = this.view;
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.5, w / 2, h / 2, Math.max(w, h) * 0.78);
    vg.addColorStop(0, 'rgba(10,20,35,0)');
    vg.addColorStop(1, 'rgba(10,20,35,0.24)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  /* ---- parking space highlight overlays (base bays live in the cache) ---- */
  drawSpaceHighlights(t) {
    const g = this.game, ctx = this.ctx, { ox, oy, cs } = this.view;
    for (const sp of g.spaces) {
      const isValid = g.selection && g.selection.targets.has(sp.id);
      const isHint = g.hintFx && g.hintFx.spaceId === sp.id && g.hintFx.until > t;
      const flash = g.flashFx && g.flashFx.spaceId === sp.id && g.flashFx.until > t;
      if (!isValid && !isHint && !flash) continue;

      const cells = spaceCells(sp);
      const minR = Math.min(...cells.map(p => p[0])), maxR = Math.max(...cells.map(p => p[0]));
      const minC = Math.min(...cells.map(p => p[1])), maxC = Math.max(...cells.map(p => p[1]));
      const x = ox + minC * cs + cs * 0.08, y = oy + minR * cs + cs * 0.08;
      const wd = (maxC - minC + 1) * cs - cs * 0.16, ht = (maxR - minR + 1) * cs - cs * 0.16;

      let fill, stroke, glow;
      if (flash) {
        fill = 'rgba(231,60,50,0.42)'; stroke = '#ff5347'; glow = 'rgba(255,80,60,0.9)';
      } else if (isValid) {
        fill = `rgba(46,204,113,${0.26 + 0.1 * Math.sin(t * 0.008)})`;
        stroke = '#2ecc71'; glow = 'rgba(46,220,120,0.9)';
      } else {
        fill = `rgba(255,201,60,${0.26 + 0.16 * Math.sin(t * 0.012)})`;
        stroke = '#ffc93c'; glow = 'rgba(255,201,60,0.9)';
      }

      ctx.fillStyle = fill;
      this.rr(x, y, wd, ht, cs * 0.14); ctx.fill();
      ctx.save();
      ctx.shadowColor = glow;
      ctx.shadowBlur = cs * 0.35;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(3, cs * 0.09);
      this.rr(x, y, wd, ht, cs * 0.14); ctx.stroke();
      ctx.restore();

      if (g.spaceIsFree(sp)) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = `900 ${Math.round(cs * 0.52)}px "Trebuchet MS", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('P', x + wd / 2, y + ht / 2 + 1);
      }
    }
  }

  /* ---- exit gate at the top of the emergency lane ---- */
  drawExit(t) {
    const g = this.game, ctx = this.ctx, { ox, oy, cs } = this.view;
    const topRoute = g.board.route.reduce((a, b) => (b.r < a.r ? b : a), g.board.route[0]);
    if (!topRoute) return;
    const cx = ox + (topRoute.c + 0.5) * cs;
    const y0 = oy + topRoute.r * cs;

    // Glowing green gradient strip.
    const grad = ctx.createLinearGradient(0, y0, 0, y0 + cs * 1.5);
    const glow = 0.4 + 0.18 * Math.sin(t * 0.005);
    grad.addColorStop(0, `rgba(110,255,165,${glow})`);
    grad.addColorStop(1, 'rgba(110,255,165,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(ox + (topRoute.c - 1) * cs, y0, cs * 3, cs * 1.5);

    // Big glowing green arrow.
    ctx.save();
    ctx.shadowColor = 'rgba(110,255,165,0.95)';
    ctx.shadowBlur = cs * 0.4;
    ctx.strokeStyle = `rgba(170,255,200,${0.8 + 0.2 * Math.sin(t * 0.006)})`;
    ctx.lineWidth = Math.max(3, cs * 0.13);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, y0 + cs * 0.95);
    ctx.lineTo(cx, y0 + cs * 0.22);
    ctx.moveTo(cx - cs * 0.27, y0 + cs * 0.52);
    ctx.lineTo(cx, y0 + cs * 0.22);
    ctx.lineTo(cx + cs * 0.27, y0 + cs * 0.52);
    ctx.stroke();
    // Two small rising chevrons beside the arrow.
    const rise = (t * 0.03) % (cs * 0.8);
    ctx.lineWidth = Math.max(2, cs * 0.07);
    ctx.strokeStyle = `rgba(170,255,200,${0.5 - rise / (cs * 2)})`;
    for (const sx of [-1, 1]) {
      const ax = cx + sx * cs * 0.72;
      const ay = y0 + cs * 0.8 - rise;
      ctx.beginPath();
      ctx.moveTo(ax - cs * 0.12, ay);
      ctx.lineTo(ax, ay - cs * 0.14);
      ctx.lineTo(ax + cs * 0.12, ay);
      ctx.stroke();
    }
    ctx.restore();
    ctx.lineCap = 'butt';

    ctx.fillStyle = 'rgba(230,255,240,0.92)';
    ctx.font = `900 ${Math.round(cs * 0.32)}px "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('EXIT', cx, y0 + cs * 1.02);
  }

  /* ---- dotted paths for hint & drag preview ---- */
  drawPathDots(path, len, color) {
    const ctx = this.ctx, { cs } = this.view;
    if (!path || path.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, cs * 0.1);
    ctx.lineCap = 'round';
    ctx.setLineDash([1, cs * 0.36]);
    ctx.lineDashOffset = this.dashOffset;
    ctx.beginPath();
    path.forEach((s, i) => {
      const p = this.poseOf(s, len);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineCap = 'butt';
  }

  drawHintPath(t) {
    const g = this.game;
    if (!g.hintFx || g.hintFx.until < t) return;
    const veh = g.vehicleById(g.hintFx.vehicleId);
    if (veh) this.drawPathDots(g.hintFx.path, veh.len, 'rgba(255,201,60,0.9)');
  }

  drawDragPreview(t) {
    const g = this.game;
    if (!g.drag || !g.drag.target) return;
    const veh = g.vehicleById(g.drag.vehicleId);
    if (veh) this.drawPathDots(g.drag.target.path, veh.len, 'rgba(255,255,255,0.85)');
  }

  drawGhost(t) {
    const g = this.game, ctx = this.ctx;
    if (!g.drag || !g.drag.target) return;
    const veh = g.vehicleById(g.drag.vehicleId);
    if (!veh) return;
    const tgt = g.drag.target;
    const pose = this.poseOf({ r: tgt.r, c: tgt.c, o: tgt.orient }, veh.len);
    ctx.save();
    ctx.globalAlpha = 0.45;
    this.drawVehicleBody(veh, pose, { ghost: true, t });
    ctx.restore();
  }

  /* ---- vehicles ---- */
  drawVehicles(t) {
    const g = this.game;
    for (const veh of g.vehicles) {
      const selected = g.selection && g.selection.vehicleId === veh.id;
      const hinted = g.hintFx && g.hintFx.vehicleId === veh.id && g.hintFx.until > t;
      const tut = g.tutorial.active && g.tutorial.step === 0 && veh.id === g.tutorial.vehicleId;
      const movable = g.movableIds.has(veh.id);
      this.drawVehicleBody(veh, veh.px, { selected, hinted: hinted || tut, movable, t });
    }
    this.drawAmbulance(t);
    this.drawBlockedIcon(t);
  }

  /* Small "no entry" badge over a blocked car the player just tapped. */
  drawBlockedIcon(t) {
    const g = this.game, ctx = this.ctx, { cs } = this.view;
    if (!g.blockedFx || g.blockedFx.until < t) return;
    const veh = g.vehicleById(g.blockedFx.vehicleId);
    if (!veh) return;
    const life = (g.blockedFx.until - t) / 950;
    const pop = Math.min(1, (1 - life) * 6);
    const x = veh.px.x, y = veh.px.y - cs * 0.72 - (1 - life) * cs * 0.1;
    ctx.save();
    ctx.globalAlpha = Math.min(1, life * 3);
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(0, 0, cs * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = cs * 0.11;
    ctx.strokeStyle = '#e8443a';
    ctx.beginPath(); ctx.arc(0, 0, cs * 0.24, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    const d = cs * 0.24 * Math.SQRT1_2;
    ctx.moveTo(-d, -d); ctx.lineTo(d, d);
    ctx.stroke();
    ctx.restore();
  }

  drawVehicleBody(veh, pose, { selected = false, hinted = false, movable = true, ghost = false, t = 0 } = {}) {
    const ctx = this.ctx, { cs } = this.view;
    const L = veh.len * cs - cs * 0.2;
    const W = cs * 0.8;
    let scale = 1;
    if (selected) scale = 1.05;
    if (hinted) scale = 1 + 0.035 * (0.5 + 0.5 * Math.sin(t * 0.01));
    if (veh.bounceT > 0) scale += 0.06 * Math.sin((1 - veh.bounceT) * Math.PI * 3) * veh.bounceT;

    // Refused-to-move shake for blocked traffic.
    const shakeX = veh.shakeT > 0 ? Math.sin(veh.shakeT * 34) * cs * 0.07 * veh.shakeT : 0;

    ctx.save();
    ctx.translate(pose.x + shakeX, pose.y - (selected ? cs * 0.08 : 0));
    ctx.rotate(pose.angle);
    ctx.scale(scale, scale);

    const rad = cs * 0.24;

    if (!ghost) {
      // Soft two-layer drop shadow.
      ctx.fillStyle = 'rgba(20,30,45,0.12)';
      this.rr(-L / 2 - cs * 0.04, -W / 2 + cs * (selected ? 0.2 : 0.12), L + cs * 0.08, W, rad * 1.2);
      ctx.fill();
      ctx.fillStyle = 'rgba(20,30,45,0.2)';
      this.rr(-L / 2 + cs * 0.03, -W / 2 + cs * (selected ? 0.16 : 0.09), L - cs * 0.02, W * 0.94, rad);
      ctx.fill();

      // Wheels peeking out on both sides.
      ctx.fillStyle = '#252d38';
      const ww = cs * 0.3, wh = cs * 0.12, wx = L / 2 - cs * 0.42, wy = W / 2 - cs * 0.02;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          this.rr(sx * wx - ww / 2, sy * wy - wh / 2, ww, wh, wh / 2);
          ctx.fill();
        }
      }
    }

    // Selection / hint glow; movable cars get a subtle ready-to-go glow.
    if (selected || hinted) {
      ctx.shadowColor = selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,201,60,0.95)';
      ctx.shadowBlur = cs * 0.5;
    } else if (movable && !ghost) {
      // Very subtle "this one can move" hint — not a spotlight.
      ctx.shadowColor = `rgba(180,240,210,${0.22 + 0.1 * Math.sin(t * 0.005)})`;
      ctx.shadowBlur = cs * 0.16;
    }

    // Body with a top-lit candy gradient.
    const grad = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    grad.addColorStop(0, this.lighten(veh.color, 0.42));
    grad.addColorStop(0.45, this.lighten(veh.color, 0.08));
    grad.addColorStop(1, this.lighten(veh.color, -0.25));
    ctx.fillStyle = grad;
    this.rr(-L / 2, -W / 2, L, W, rad);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, cs * 0.05);
    ctx.strokeStyle = this.lighten(veh.color, -0.42);
    this.rr(-L / 2, -W / 2, L, W, rad);
    ctx.stroke();

    // Pulsing white ring around the selected car.
    if (selected) {
      ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.3 * Math.sin(t * 0.012)})`;
      ctx.lineWidth = cs * 0.07;
      this.rr(-L / 2 - cs * 0.09, -W / 2 - cs * 0.09, L + cs * 0.18, W + cs * 0.18, rad + cs * 0.09);
      ctx.stroke();
    }

    // Tinted glass with a white reflection notch.
    const glassFill = (x, y, gw, gh, gr) => {
      const gg = ctx.createLinearGradient(x, y, x, y + gh);
      gg.addColorStop(0, '#3d5570');
      gg.addColorStop(1, '#1f2f42');
      ctx.fillStyle = gg;
      this.rr(x, y, gw, gh, gr); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      this.rr(x + gw * 0.12, y + gh * 0.1, gw * 0.32, gh * 0.3, gr * 0.6); ctx.fill();
    };

    if (veh.kind === 'van') {
      // Boxy cargo behind, cab glass at the front.
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      this.rr(-L * 0.46, -W * 0.38, L * 0.6, W * 0.76, rad * 0.5); ctx.fill();
      ctx.fillStyle = this.lighten(veh.color, 0.2);
      this.rr(-L * 0.44, -W * 0.34, L * 0.56, W * 0.68, rad * 0.45); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.1)';
      ctx.lineWidth = cs * 0.03;
      for (let i = 0; i < 3; i++) {
        const x = -L * 0.36 + i * L * 0.16;
        ctx.beginPath(); ctx.moveTo(x, -W * 0.3); ctx.lineTo(x, W * 0.3); ctx.stroke();
      }
      glassFill(L * 0.2, -W * 0.36, L * 0.16, W * 0.72, cs * 0.08);
    } else {
      // Car / long car: rounded cabin, windshield, rear and side glass.
      const cab = veh.len >= 3 ? L * 0.52 : L * 0.5;
      ctx.fillStyle = this.lighten(veh.color, 0.22);
      this.rr(-cab / 2, -W * 0.37, cab, W * 0.74, rad * 0.6); ctx.fill();
      glassFill(cab / 2 - L * 0.13, -W * 0.33, L * 0.11, W * 0.66, cs * 0.07);
      glassFill(-cab / 2 + L * 0.015, -W * 0.33, L * 0.09, W * 0.66, cs * 0.07);
      ctx.fillStyle = '#2b3d52';
      this.rr(-cab * 0.22, -W * 0.37, cab * 0.44, W * 0.1, cs * 0.03); ctx.fill();
      this.rr(-cab * 0.22, W * 0.27, cab * 0.44, W * 0.1, cs * 0.03); ctx.fill();
      if (veh.len >= 3) {
        // Roof rails on the long car.
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth = cs * 0.035;
        ctx.beginPath(); ctx.moveTo(-cab * 0.18, -W * 0.18); ctx.lineTo(cab * 0.18, -W * 0.18); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-cab * 0.18, W * 0.18); ctx.lineTo(cab * 0.18, W * 0.18); ctx.stroke();
      }
    }

    // Glossy highlight streak along the top edge.
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    this.rr(-L / 2 + cs * 0.08, -W / 2 + cs * 0.05, L - cs * 0.4, W * 0.2, rad * 0.5);
    ctx.fill();

    // Headlights (front = +x) and taillights.
    ctx.fillStyle = '#fff3c4';
    this.rr(L / 2 - cs * 0.1, -W * 0.36, cs * 0.08, W * 0.2, cs * 0.03); ctx.fill();
    this.rr(L / 2 - cs * 0.1, W * 0.16, cs * 0.08, W * 0.2, cs * 0.03); ctx.fill();
    ctx.fillStyle = '#ff6459';
    this.rr(-L / 2 + cs * 0.02, -W * 0.34, cs * 0.06, W * 0.18, cs * 0.02); ctx.fill();
    this.rr(-L / 2 + cs * 0.02, W * 0.16, cs * 0.06, W * 0.18, cs * 0.02); ctx.fill();

    // Blocked traffic sits darker so the movable car stands out.
    if (!movable && !ghost && !selected) {
      ctx.fillStyle = 'rgba(22,30,44,0.30)';
      this.rr(-L / 2, -W / 2, L, W, rad);
      ctx.fill();
    }

    // Freshly unlocked: a bright expanding ring.
    if (veh.unlockT > 0 && !ghost) {
      const u = 1 - veh.unlockT;
      ctx.strokeStyle = `rgba(255,235,140,${veh.unlockT})`;
      ctx.lineWidth = cs * 0.09;
      this.rr(-L / 2 - u * cs * 0.35, -W / 2 - u * cs * 0.35,
              L + u * cs * 0.7, W + u * cs * 0.7, rad + u * cs * 0.35);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawAmbulance(t) {
    const g = this.game, ctx = this.ctx, { cs } = this.view;
    const amb = g.ambulance;
    const pose = amb.px;
    const L = amb.len * cs - cs * 0.16;
    const W = cs * 0.86;
    const on = amb.lights;
    const phase = Math.floor(t / 130) % 2 === 0;
    const skin = g.currentSkin();

    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);

    // Soft double shadow (the hero vehicle gets the strongest one).
    ctx.fillStyle = 'rgba(20,30,45,0.14)';
    this.rr(-L / 2 - cs * 0.05, -W / 2 + cs * 0.15, L + cs * 0.1, W, cs * 0.26); ctx.fill();
    ctx.fillStyle = 'rgba(20,30,45,0.24)';
    this.rr(-L / 2 + cs * 0.03, -W / 2 + cs * 0.1, L - cs * 0.02, W * 0.94, cs * 0.22); ctx.fill();

    // Wheels.
    ctx.fillStyle = '#252d38';
    const ww = cs * 0.32, wh = cs * 0.13;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        this.rr(sx * (L / 2 - cs * 0.42) - ww / 2, sy * (W / 2 - cs * 0.015) - wh / 2, ww, wh, wh / 2);
        ctx.fill();
      }
    }

    // Body (skin-tinted gradient).
    const grad = ctx.createLinearGradient(0, -W / 2, 0, W / 2);
    grad.addColorStop(0, skin.body[0]);
    grad.addColorStop(0.6, this.lighten(skin.body[1], 0.12));
    grad.addColorStop(1, skin.body[1]);
    ctx.fillStyle = grad;
    this.rr(-L / 2, -W / 2, L, W, cs * 0.2); ctx.fill();
    ctx.lineWidth = Math.max(1.5, cs * 0.05);
    ctx.strokeStyle = this.lighten(skin.body[1], -0.28);
    this.rr(-L / 2, -W / 2, L, W, cs * 0.2); ctx.stroke();

    // Side stripes + tail accent block (skin colours).
    ctx.fillStyle = skin.stripe;
    ctx.fillRect(-L / 2 + cs * 0.08, -W / 2 + cs * 0.055, L - cs * 0.3, cs * 0.09);
    ctx.fillRect(-L / 2 + cs * 0.08, W / 2 - cs * 0.145, L - cs * 0.3, cs * 0.09);
    ctx.fillStyle = skin.accent;
    ctx.fillRect(-L / 2 + cs * 0.04, -W * 0.3, cs * 0.07, W * 0.6);

    // Roof module with the medical cross.
    ctx.fillStyle = this.lighten(skin.body[0], 0.12);
    this.rr(-L * 0.44, -W * 0.35, L * 0.6, W * 0.7, cs * 0.12); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = Math.max(1, cs * 0.03);
    this.rr(-L * 0.44, -W * 0.35, L * 0.6, W * 0.7, cs * 0.12); ctx.stroke();
    ctx.fillStyle = skin.cross;
    const cw = W * 0.34, ct2 = W * 0.115, ccx = -L * 0.14;
    this.rr(ccx - cw / 2, -ct2 / 2, cw, ct2, ct2 * 0.3); ctx.fill();
    this.rr(ccx - ct2 / 2, -cw / 2, ct2, cw, ct2 * 0.3); ctx.fill();

    // Windshield with reflection.
    const gg = ctx.createLinearGradient(L * 0.22, 0, L * 0.36, 0);
    gg.addColorStop(0, '#42597a');
    gg.addColorStop(1, '#243447');
    ctx.fillStyle = gg;
    this.rr(L * 0.22, -W * 0.33, L * 0.13, W * 0.66, cs * 0.07); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    this.rr(L * 0.23, -W * 0.3, L * 0.045, W * 0.28, cs * 0.04); ctx.fill();

    // Light bar: dark base with red + blue lamps; strobes + bloom when active.
    ctx.fillStyle = '#33404f';
    this.rr(L * 0.1, -W * 0.36, cs * 0.13, W * 0.72, cs * 0.04); ctx.fill();
    if (on) {
      ctx.save();
      ctx.shadowBlur = cs * 0.5;
      ctx.shadowColor = phase ? 'rgba(255,60,50,0.95)' : 'rgba(255,60,50,0.2)';
      ctx.fillStyle = phase ? '#ff453a' : '#7a1f1f';
      this.rr(L * 0.105, -W * 0.34, cs * 0.11, W * 0.31, cs * 0.03); ctx.fill();
      ctx.shadowColor = !phase ? 'rgba(70,140,255,0.95)' : 'rgba(70,140,255,0.2)';
      ctx.fillStyle = !phase ? '#3f8bff' : '#1d3766';
      this.rr(L * 0.105, W * 0.03, cs * 0.11, W * 0.31, cs * 0.03); ctx.fill();
      ctx.restore();
      // Rotating ground bloom.
      ctx.globalAlpha = 0.3 + 0.2 * Math.sin(t * 0.03);
      ctx.fillStyle = phase ? 'rgba(255,70,60,0.5)' : 'rgba(80,150,255,0.5)';
      ctx.beginPath(); ctx.arc(L * 0.16, 0, cs * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#a04038';
      this.rr(L * 0.105, -W * 0.34, cs * 0.11, W * 0.31, cs * 0.03); ctx.fill();
      ctx.fillStyle = '#33518f';
      this.rr(L * 0.105, W * 0.03, cs * 0.11, W * 0.31, cs * 0.03); ctx.fill();
    }

    // Headlights + light beams while racing.
    ctx.fillStyle = '#fff3c4';
    this.rr(L / 2 - cs * 0.1, -W * 0.34, cs * 0.08, W * 0.2, cs * 0.03); ctx.fill();
    this.rr(L / 2 - cs * 0.1, W * 0.14, cs * 0.08, W * 0.2, cs * 0.03); ctx.fill();
    if (on) {
      ctx.fillStyle = 'rgba(255,240,180,0.16)';
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(L / 2 - cs * 0.02, sy * W * 0.24);
        ctx.lineTo(L / 2 + cs * 0.95, sy * W * 0.52);
        ctx.lineTo(L / 2 + cs * 0.95, sy * W * 0.04);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  drawDebug() {
    const g = this.game, ctx = this.ctx, { ox, oy, cs } = this.view;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + r * cs); ctx.lineTo(ox + COLS * cs, oy + r * cs); ctx.stroke();
    }
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath(); ctx.moveTo(ox + c * cs, oy); ctx.lineTo(ox + c * cs, oy + ROWS * cs); ctx.stroke();
    }
    ctx.font = '9px monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText(r + ',' + c, ox + c * cs + 2, oy + r * cs + 2);
        if (g.board.routeSet.has(r + ',' + c)) {
          ctx.fillStyle = 'rgba(255,0,0,0.2)';
          ctx.fillRect(ox + c * cs, oy + r * cs, cs, cs);
        }
        if (g.board.turn[r][c]) {
          ctx.fillStyle = 'rgba(0,0,255,0.25)';
          ctx.fillRect(ox + c * cs, oy + r * cs, cs, cs);
        }
      }
    }
    for (const sp of g.spaces) {
      const p = this.cellCenter(sp.r, sp.c);
      ctx.fillStyle = '#0ff';
      ctx.fillText(sp.id, p.x - 8, p.y - 4);
    }
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.fillText('state: ' + g.state, ox + 4, oy - 14 < 0 ? oy + 2 : oy - 14);
  }

  lighten(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }
}

/* -------------------------------- ANIMATOR ------------------------------- */
/* Animates a vehicle along a list of grid states. Poses are computed from the
   current view every frame, so window resizes never break an animation. */
class Animator {
  constructor(game) {
    this.game = game;
    this.job = null; // only one vehicle animates at a time (by design)
  }
  get busy() { return !!this.job; }

  animate(target, states, cb, timeFor) {
    if (states.length < 2) {
      this.applyFinal(target, states[states.length - 1] || null);
      if (cb) cb();
      return;
    }
    const times = [0];
    for (let i = 1; i < states.length; i++) {
      const rot = states[i].o !== states[i - 1].o;
      const dt = timeFor ? timeFor(i, rot) : (rot ? TUNE.rotateMs : TUNE.slideMs);
      times.push(times[i - 1] + dt);
    }
    this.job = { target, states, times, total: times[times.length - 1], elapsed: 0, cb };
  }

  applyFinal(target, state) {
    if (!state) return;
    const pose = this.game.renderer.poseOf(state, target.len);
    target.px = pose;
  }

  update(dt) {
    if (!this.job) return;
    const j = this.job;
    j.elapsed += dt * 1000;
    const t = Math.min(j.elapsed, j.total);
    let i = 1;
    while (i < j.times.length && j.times[i] < t) i++;
    if (i >= j.states.length) i = j.states.length - 1;
    const t0 = j.times[i - 1], t1 = j.times[i];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    const ef = easeInOut(f);
    const a = this.game.renderer.poseOf(j.states[i - 1], j.target.len);
    const b = this.game.renderer.poseOf(j.states[i], j.target.len);
    j.target.px = {
      x: lerp(a.x, b.x, ef),
      y: lerp(a.y, b.y, ef),
      angle: lerp(a.angle, b.angle, ef),
    };
    if (j.elapsed >= j.total) {
      this.applyFinal(j.target, j.states[j.states.length - 1]);
      const cb = j.cb;
      this.job = null;
      if (cb) cb();
    }
  }
}

/* ---------------------------- INPUT CONTROLLER --------------------------- */
class InputController {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    this.down = null;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', () => { this.down = null; game.clearDrag(); });
    document.addEventListener('contextmenu', e => e.preventDefault());
    // Belt & braces against page scroll on older mobile browsers.
    document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  }

  cellAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const { ox, oy, cs } = this.game.renderer.view;
    const x = e.clientX - rect.left - ox;
    const y = e.clientY - rect.top - oy;
    return { r: Math.floor(y / cs), c: Math.floor(x / cs) };
  }

  onDown(e) {
    e.preventDefault();
    this.game.audio.unlock();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    if (!this.game.inputAllowed()) return;
    const { r, c } = this.cellAt(e);
    const veh = this.game.vehicleAtCell(r, c);
    this.down = { x: e.clientX, y: e.clientY, vehicleId: veh ? veh.id : null, dragging: false };
    if (veh) this.game.select(veh.id);
  }

  onMove(e) {
    if (!this.down || !this.down.vehicleId) return;
    if (!this.game.inputAllowed() && !this.down.dragging) return;
    const dx = e.clientX - this.down.x, dy = e.clientY - this.down.y;
    if (!this.down.dragging && Math.hypot(dx, dy) > TUNE.tapSlopPx) {
      this.down.dragging = true;
    }
    if (this.down.dragging) {
      const { r, c } = this.cellAt(e);
      this.game.updateDrag(this.down.vehicleId, this.game.spaceAtCell(r, c));
    }
  }

  onUp(e) {
    const down = this.down;
    this.down = null;
    if (!down) return;
    if (down.dragging) {
      this.game.endDrag();
      return;
    }
    if (!this.game.inputAllowed()) return;
    // Tap.
    const { r, c } = this.cellAt(e);
    const veh = this.game.vehicleAtCell(r, c);
    if (veh) return; // selection already handled on pointerdown
    const sp = this.game.spaceAtCell(r, c);
    if (this.game.state === 'selected') {
      if (sp) this.game.tryTargetSpace(sp);
      else this.game.deselect();
    }
  }
}

/* --------------------------------- GAME ---------------------------------- */
class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.save = new SaveManager();
    this.audio = new AudioManager(this.save);
    this.ui = new UIManager();
    this.particles = new ParticleSystem();
    this.renderer = new Renderer(this, this.canvas);
    this.animator = new Animator(this);
    this.input = new InputController(this, this.canvas);
    this.history = new MoveHistory();

    this.state = 'loading';
    this.levelIndex = 0;
    this.endless = false;      // Endless mode: infinite generated puzzles
    this.endlessRound = 0;
    this.genDef = null;        // the currently loaded generated level
    this.nextGenDef = null;    // pre-generated next endless level (hides the stall)
    this.seedNum = 1;          // numeric seed for scenery (generated ids are strings)
    this.board = null;
    this.vehicles = [];
    this.spaces = [];
    this.ambulance = null;
    this.moves = 0;
    this.selection = null;   // { vehicleId, targets: Map<spaceId, target> }
    this.drag = null;        // { vehicleId, target|null }
    this.hintFx = null;      // { vehicleId, spaceId, path, until }
    this.flashFx = null;     // { spaceId, until }
    this.blockedFx = null;   // { vehicleId, until } — "blocked" icon over a tapped car
    this.movableIds = new Set(); // ids of vehicles that currently have a destination
    this.hintsLeft = TUNE.freeHints;
    this.shakeUntil = 0;
    this.routeGlowUntil = 0;
    this.decor = [];
    this.tutorial = { active: false, step: -1, vehicleId: 'orange', spaceId: 'P3' };
    this.now = 0;

    this.bindUI();
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state === 'waiting' || this.state === 'selected')) this.pause();
    });

    // Developer validation of every level (console only).
    setTimeout(() => {
      for (const def of LEVELS) {
        const res = validateLevel(def);
        for (const err of res.errors) console.error(`[Level ${def.id}] ${err}`);
        for (const wrn of res.warnings) console.warn(`[Level ${def.id}] ${wrn}`);
        if (res.ok) console.log(`[Level ${def.id}] OK — solvable in ${res.solution.length} moves`);
      }
    }, 60);

    // Start on the first level the player has not beaten yet.
    const start = Math.max(0, this.save.data.unlocked - 1);
    this.loadLevel(start);
    this.startAdOffers();

    const loop = t => {
      const dt = Math.min(0.05, (t - (this._lt || t)) / 1000);
      this._lt = t;
      this.now = t;
      this.tick(t, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /* ------------------------------- helpers ------------------------------- */
  levelDef() { return this.loadedDef; }
  hudLabel() { return this.endless ? 'ENDLESS #' + this.endlessRound : 'LEVEL ' + (this.levelIndex + 1); }
  vehicleById(id) { return this.vehicles.find(v => v.id === id); }
  spaceById(id) { return this.spaces.find(s => s.id === id); }
  inputAllowed() { return this.state === 'waiting' || this.state === 'selected'; }

  /** Civilian vehicles + the ambulance, as plain obstacle records. */
  allObstacles() {
    const list = this.vehicles.map(v => ({ id: v.id, r: v.r, c: v.c, orient: v.orient, len: v.len }));
    list.push({ id: AMB_ID, r: this.ambulance.r, c: this.ambulance.c, orient: 'v', len: this.ambulance.len });
    return list;
  }
  spacesPlain() { return this.spaces; }

  /** Recompute which vehicles currently have a reachable destination. */
  refreshMovable() {
    this.movableIds = new Set(movableVehicles(this.board, this.allObstacles(), this.spaces));
  }

  /** A space is free when no vehicle currently overlaps any of its cells. */
  spaceIsFree(sp) {
    const cells = spaceCells(sp);
    for (const v of this.vehicles) {
      if (footprint(v.r, v.c, v.orient, v.len)
          .some(([r, c]) => cells.some(([sr, sc]) => sr === r && sc === c))) return false;
    }
    return true;
  }

  vehicleAtCell(r, c) {
    return this.vehicles.find(v =>
      footprint(v.r, v.c, v.orient, v.len).some(([fr, fc]) => fr === r && fc === c));
  }
  spaceAtCell(r, c) {
    return this.spaces.find(s =>
      spaceCells(s).some(([sr, sc]) => sr === r && sc === c));
  }

  setState(s) { this.state = s; }

  /* ----------------------------- level loading --------------------------- */
  loadLevel(idx) {
    this.endless = false;
    this.levelIndex = idx;
    // The campaign is infinite: the 5 curated levels, then endlessly generated
    // numbered levels with a difficulty ramp (deterministic + cached per index).
    this.loadDef(idx < LEVELS.length ? LEVELS[idx] : this.genCampaignLevel(idx));
  }

  /** Deterministic, cached generated level for campaign slots past the curated 5. */
  genCampaignLevel(idx) {
    if (!this.campaignCache) this.campaignCache = new Map();
    if (this.campaignCache.has(idx)) return this.campaignCache.get(idx);
    const n = idx + 1;
    const cars = clamp(12 + Math.floor((n - 6) / 2), 12, 16);
    const base = (n * 2654435761) >>> 0;
    let def = null;
    for (let k = 0; k < 40 && !def; k++) {
      const cand = generateLevel((base + k * 2246822519) >>> 0,
        { cars, tries: 200, strict: { movable: 4, movers: 0.55, depth: 0.5 } });
      if (!cand) continue;
      const board = parseBoard(cand);
      const vs = cand.vehicles.map(v => ({ ...v }));
      vs.push({ id: AMB_ID, r: cand.ambulance.r, c: cand.ambulance.c, orient: 'v', len: 2 });
      const sm = movableVehicles(board, vs, cand.spaces).length;
      if (sm >= 2 && sm <= 4) def = cand;          // ensure a real choice
    }
    if (!def) def = generateLevel(base, { cars }) || generateLevel((base + 7) >>> 0, { cars: 10 });
    def.id = n; def.name = 'Level ' + n; def.tutorial = null; def.generated = true;
    this.campaignCache.set(idx, def);
    return def;
  }

  /** Enter Endless mode: infinite freshly generated puzzles. */
  startEndless() {
    this.endless = true;
    this.endlessRound = 1;
    this.nextGenDef = null;
    this.genDef = this.makeEndlessLevel(this.endlessRound);
    this.loadDef(this.genDef);
  }

  /** Difficulty ramp: more cars as the streak grows (capped for solve speed). */
  makeEndlessLevel(round) {
    const cars = clamp(6 + Math.floor((round - 1) / 2), 6, 12);
    const seed = (Date.now() ^ (round * 2654435761)) >>> 0;
    return generateLevel(seed, { cars, id: 'gen-' + round + '-' + seed, name: 'Endless #' + round })
      || generateLevel((seed + 12345) >>> 0, { cars: 7, name: 'Endless #' + round }); // guaranteed fallback
  }

  loadDef(def) {
    this.loadedDef = def;
    this.seedNum = typeof def.id === 'number' ? def.id : 900 + (this.endlessRound || 0);
    this.board = parseBoard(def);
    this.vehicles = def.vehicles.map(v => ({
      ...v, spaceId: null, bounceT: 0, shakeT: 0, unlockT: 0,
      px: { x: 0, y: 0, angle: 0 },
    }));
    this.ambulance = {
      id: AMB_ID, r: def.ambulance.r, c: def.ambulance.c, orient: 'v', len: 2,
      lights: false, px: { x: 0, y: 0, angle: 0 },
    };
    // Space occupancy is always COMPUTED from vehicle positions (see
    // computeTargets); nothing is cached here. That lets levels start with
    // gate cars double-parked across bay mouths — the heart of the chain puzzle.
    this.spaces = def.spaces.map(s => ({ ...s }));
    this.moves = 0;
    this.history.clear();
    this.selection = null;
    this.drag = null;
    this.hintFx = null;
    this.flashFx = null;
    this.blockedFx = null;
    this.hintsLeft = TUNE.freeHints;
    this.shakeUntil = 0;
    this.routeGlowUntil = 0;
    this.animator.job = null;
    for (const p of this.particles.pool) p.active = false; // no confetti bleed into the next map

    this.buildDecor(def);
    this.renderer.groundDirty = true; // new board + decor -> repaint scenery cache
    this.syncAllPoses();
    this.refreshMovable();

    // Tutorial on first ever play (the level definition names the one car
    // that can move first, so the tutorial always points at the real opener).
    this.tutorial = { active: false, step: -1, vehicleId: null, spaceId: null };
    if (def.tutorial && !this.save.data.tutorialDone) {
      this.tutorial.active = true;
      this.tutorial.step = 0;
      this.tutorial.vehicleId = def.tutorial.vehicleId;
      this.tutorial.spaceId = def.tutorial.spaceId;
      this.ui.tutorial(def.tutorial.intro);
    } else {
      this.ui.tutorial(null);
    }

    this.ui.hideAllPanels();
    this.ui.updateHUD(this.hudLabel(), 0, def.par, this.save.data.coins);
    this.ui.updateUndo(false);
    this.ui.updateHintBadge(this.hintsLeft);
    this.setState('waiting');
    this.ui.toast(def.name, 1200);
  }

  buildDecor(def) {
    // Sizes are stored as fractions of a cell, so resizes never need a rebuild.
    this.decor = [];
    const rand = mulberry32(this.seedNum * 1337 + 7);
    const b = this.board;
    const nearRoad = (r, c) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => {
        const nr = r + dr, nc = c + dc;
        return nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && b.drivable[nr][nc];
      });
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (b.drivable[r][c]) continue;
        const roll = rand();
        const jx = () => 0.3 + rand() * 0.4;
        if (roll < 0.08 && r > 0 && r < ROWS - 1) {
          this.decor.push({ kind: 'house', x: c + 0.5, y: r + 0.5, s: 0.92, seed: rand() });
        } else if (roll < 0.34) {
          this.decor.push({ kind: 'tree', x: c + jx(), y: r + jx(), s: 0.3 + rand() * 0.14, seed: rand() });
        } else if (roll < 0.46) {
          this.decor.push({ kind: 'bush', x: c + jx(), y: r + jx(), s: 0.16 + rand() * 0.08, seed: rand() });
        } else if (roll < 0.52 && nearRoad(r, c) && r > 0 && r < ROWS - 1) {
          this.decor.push({ kind: 'hydrant', x: c + 0.5, y: r + 0.5, s: 0.3, seed: rand() });
        } else if (roll < 0.6) {
          this.decor.push({ kind: 'rock', x: c + jx(), y: r + jx(), s: 0.14 + rand() * 0.08, seed: rand() });
        } else if (roll < 0.74) {
          this.decor.push({ kind: 'flower', x: c + jx(), y: r + jx(), s: 0.16, seed: rand() });
        }
      }
    }
  }

  syncAllPoses() {
    for (const v of this.vehicles) {
      v.px = this.renderer.poseOf({ r: v.r, c: v.c, o: v.orient }, v.len);
    }
    this.ambulance.px = this.renderer.poseOf(
      { r: this.ambulance.r, c: this.ambulance.c, o: 'v' }, this.ambulance.len);
  }

  onResize() {
    this.renderer.resize(); // marks the scenery cache dirty itself
    if (!this.animator.busy) this.syncAllPoses();
  }

  /* ------------------------------ selection ------------------------------ */
  select(vehicleId) {
    if (!this.inputAllowed()) return;
    const veh = this.vehicleById(vehicleId);

    // Blocked traffic cannot be selected: shake it and show the blocked icon.
    const targets = computeTargets(this.board, this.allObstacles(), this.spaces, vehicleId);
    if (!targets.length) {
      veh.shakeT = 1;
      this.blockedFx = { vehicleId, until: this.now + 950 };
      this.audio.invalid();
      return;
    }
    // Tutorial is informational now — several cars are movable, the player
    // chooses. We no longer hard-lock selection to one "correct" car.
    this.selection = { vehicleId, targets: new Map(targets.map(t => [t.spaceId, t])) };
    this.setState('selected');
    this.audio.select();
  }

  deselect() {
    this.selection = null;
    if (this.state === 'selected') this.setState('waiting');
  }

  /* -------------------------------- drag --------------------------------- */
  updateDrag(vehicleId, hoverSpace) {
    if (!this.selection || this.selection.vehicleId !== vehicleId) return;
    let target = null;
    if (hoverSpace && this.selection.targets.has(hoverSpace.id)) {
      target = this.selection.targets.get(hoverSpace.id);
    }
    this.drag = { vehicleId, target, hoverSpaceId: hoverSpace ? hoverSpace.id : null };
  }

  endDrag() {
    const drag = this.drag;
    this.drag = null;
    if (!drag || !this.inputAllowed()) return;
    if (drag.target) {
      const sp = this.spaceById(drag.target.spaceId);
      this.tryTargetSpace(sp);
    } else if (drag.hoverSpaceId) {
      // Released over a space that is not a legal target.
      this.flashFx = { spaceId: drag.hoverSpaceId, until: this.now + 450 };
      this.audio.invalid();
    }
    // Released over nothing: silently cancel (no move counted).
  }

  clearDrag() { this.drag = null; }

  /* ------------------------------- moving -------------------------------- */
  tryTargetSpace(sp) {
    if (!this.selection) return;
    const target = this.selection.targets.get(sp.id);
    if (!target) {
      this.flashFx = { spaceId: sp.id, until: this.now + 450 };
      this.audio.invalid();
      return;
    }
    this.commitMove(target);
  }

  commitMove(target) {
    const veh = this.vehicleById(this.selection.vehicleId);
    const rec = {
      vehicleId: veh.id,
      from: { r: veh.r, c: veh.c, orient: veh.orient, spaceId: veh.spaceId },
      to: { r: target.r, c: target.c, orient: target.orient, spaceId: target.spaceId },
      path: target.path,
      prevMoves: this.moves,
    };
    this.selection = null;
    this.drag = null;
    this.hintFx = null;
    this.setState('vehicleMoving');
    this.audio.click();

    this.animator.animate(veh, target.path.map(s => ({ ...s })), () => {
      // Apply the move to the logical model.
      veh.r = target.r; veh.c = target.c; veh.orient = target.orient;
      veh.spaceId = target.spaceId;
      veh.bounceT = 1;

      this.moves++;
      this.history.push(rec);
      this.ui.updateHUD(this.hudLabel(), this.moves, this.levelDef().par, this.save.data.coins);
      this.ui.updateUndo(true);
      this.audio.park();
      this.particles.sparkle(veh.px.x, veh.px.y, 10);

      // Chain reaction: find vehicles this move just unlocked and celebrate them.
      const before = this.movableIds;
      this.refreshMovable();
      for (const id of this.movableIds) {
        if (before.has(id) || id === veh.id) continue;
        const nv = this.vehicleById(id);
        if (nv) {
          nv.unlockT = 1;
          this.particles.sparkle(nv.px.x, nv.px.y, 16);
        }
      }

      // Tutorial advances after the first parked vehicle.
      if (this.tutorial.active && this.tutorial.step === 0) {
        this.tutorial.step = 1;
        this.ui.tutorial('Nice! But watch out — some moves waste a bay or trap a car. Plan ahead, and Undo if you get stuck.');
        this.routeGlowUntil = this.now + 2600;
        setTimeout(() => { if (this.tutorial.active) this.ui.tutorial(null); }, 4600);
      }

      this.checkRoute();
    });
  }

  checkRoute() {
    this.setState('checkingRoute');
    if (routeIsClear(this.board, this.allObstacles())) {
      this.startAmbulance();
    } else {
      this.setState('waiting');
      this.checkStuck();
    }
  }

  /** After a move, detect a dead end (no way to clear the route from here) and
      offer the player a way out: ad-help, undo, or restart. */
  checkStuck() {
    if (this.moves === 0) return;                 // fresh board is always solvable
    // Generous depth so we never falsely tell a player they're stuck.
    const depth = Math.max(TUNE.solverMaxDepth, this.vehicles.length + 6);
    const solvable = solveLevel(this.board, this.allObstacles(), this.spaces, depth);
    if (solvable) return;
    this.audio.invalid();
    this.setState('paused');
    this.ui.showStuck({
      canUndo: this.history.length > 0,
      onAd: () => this.watchAd(0, 'Get unstuck', () => { this.ui.hideAllPanels(); this.setState('waiting'); this.undo(); this.freeHintSoon(); }),
      onUndo: () => { this.audio.click(); this.ui.hideAllPanels(); this.setState('waiting'); this.undo(); },
      onRestart: () => { this.audio.click(); this.ui.hideAllPanels(); this.doRestart(); },
    });
  }

  /** Give a free hint shortly after an undo (used by the "get unstuck" ad). */
  freeHintSoon() {
    setTimeout(() => {
      if (this.state === 'waiting') { this.hintsLeft++; this.hint(); }
    }, 650);
  }

  /* ------------------------------ ambulance ------------------------------ */
  startAmbulance() {
    this.setState('ambulanceMoving');
    this.selection = null;
    this.hintFx = null;
    if (this.tutorial.active) {
      this.ui.tutorial(null);
      this.ui.toast('The road is clear!', 1400);
    } else {
      this.ui.toast('ROAD CLEAR!', 1400);
    }

    setTimeout(() => {
      this.ambulance.lights = true;
      this.audio.sirenStart();
      this.shakeUntil = this.now + 2600;

      // Drive straight up the emergency lane and off the top of the board.
      const states = [];
      for (let r = this.ambulance.r; r >= -3; r--) {
        states.push({ r, c: this.ambulance.c, o: 'v' });
      }
      let i = 0;
      const timeFor = () => Math.max(48, TUNE.ambCellMs - 6 * (i++));

      // Confetti burst at the exit as the ambulance escapes.
      const topRoute = this.board.route.reduce((a, b) => (b.r < a.r ? b : a), this.board.route[0]);
      const exitPx = this.renderer.cellCenter(topRoute.r, topRoute.c);
      setTimeout(() => this.particles.confetti(exitPx.x, exitPx.y, 70), 900);

      this.animator.animate(this.ambulance, states, () => {
        this.audio.sirenStop();
        this.finishLevel();
      }, timeFor);
    }, 320);
  }

  finishLevel() {
    this.setState('completed');
    const def = this.levelDef();
    const par = def.par;
    const stars = this.moves <= par ? 3 : this.moves <= par + 2 ? 2 : 1;

    let earned, best;
    if (this.endless) {
      // Score by round reached; no per-map bests (ids are throwaway).
      earned = 10 + stars * 5 + this.endlessRound * 2;
      this.save.data.coins += earned;
      this.save.data.endlessBest = Math.max(this.save.data.endlessBest || 0, this.endlessRound);
      best = { stars, moves: this.save.data.endlessBest, isEndless: true };
      // Pre-generate the next map now so the "Next" tap is instant.
      this.nextGenDef = this.makeEndlessLevel(this.endlessRound + 1);
    } else {
      const prev = this.save.data.best[def.id];
      earned = prev ? 5 + Math.max(0, stars - prev.stars) * 10 : stars * 10;
      this.save.data.coins += earned;
      if (!prev || stars > prev.stars || (stars === prev.stars && this.moves < prev.moves)) {
        this.save.data.best[def.id] = { stars, moves: this.moves };
      }
      // Infinite campaign: unlock grows without an upper bound.
      this.save.data.unlocked = Math.max(this.save.data.unlocked, this.levelIndex + 2);
      best = this.save.data.best[def.id];
      // Pre-generate the next campaign level so "Next Level" is instant.
      if (this.levelIndex + 1 >= LEVELS.length) {
        setTimeout(() => this.genCampaignLevel(this.levelIndex + 1), 30);
      }
    }
    if (this.tutorial.active) { this.save.data.tutorialDone = true; this.tutorial.active = false; }
    this.save.save();

    this.audio.complete();
    this.ui.updateHUD(this.hudLabel(), this.moves, par, this.save.data.coins);

    // A few celebratory bursts behind the panel.
    const v = this.renderer.view;
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.particles.confetti(
        v.ox + Math.random() * COLS * v.cs, v.oy + v.cs * (1 + Math.random() * 3), 40), i * 260);
    }

    setTimeout(() => {
      if (this.state !== 'completed') return;   // navigated away before the panel showed
      this.ui.showComplete({
        stars, moves: this.moves, best, earned,
        isLast: false,                 // the campaign never ends
        endless: this.endless,
      });
    }, 480);
  }

  /** Advance to the next generated puzzle (Endless mode). */
  nextEndless() {
    this.endlessRound++;
    this.genDef = this.nextGenDef || this.makeEndlessLevel(this.endlessRound);
    this.nextGenDef = null;
    this.loadDef(this.genDef);
  }

  /* --------------------------------- undo -------------------------------- */
  undo() {
    if (!this.inputAllowed() || !this.history.length) return;
    const rec = this.history.pop();
    const veh = this.vehicleById(rec.vehicleId);
    this.selection = null;
    this.drag = null;
    this.hintFx = null;
    this.setState('vehicleMoving');

    const reversed = rec.path.slice().reverse().map(s => ({ ...s }));
    this.animator.animate(veh, reversed, () => {
      // Restore exact previous logical state (occupancy is recomputed).
      veh.r = rec.from.r; veh.c = rec.from.c; veh.orient = rec.from.orient;
      veh.spaceId = rec.from.spaceId;
      this.moves = rec.prevMoves;
      this.refreshMovable();
      this.ui.updateHUD(this.hudLabel(), this.moves, this.levelDef().par, this.save.data.coins);
      this.ui.updateUndo(this.history.length > 0);
      this.audio.undo();
      this.checkRoute(); // recalculate; route cannot be clear here, returns to waiting
    });
  }

  /* --------------------------------- hint -------------------------------- */
  hint() {
    if (!this.inputAllowed()) return;
    if (this.hintsLeft <= 0) {
      if (this.save.data.coins < TUNE.hintCoinCost) {
        this.ui.toast('Not enough coins!', 1100);
        this.audio.invalid();
        return;
      }
    }
    const h = HintSystem.getHint(this);
    if (!h) { this.ui.toast('No good move — try Undo!', 1500); return; }

    if (this.hintsLeft > 0) this.hintsLeft--;
    else {
      this.save.data.coins -= TUNE.hintCoinCost;
      this.save.save();
    }
    this.hintFx = { ...h, until: this.now + TUNE.hintShowMs };
    this.audio.hint();
    if (h.reason) this.ui.toast('💡 ' + h.reason, 2400);   // short strategic explanation
    this.ui.updateHintBadge(this.hintsLeft);
    this.ui.updateHUD(this.hudLabel(), this.moves, this.levelDef().par, this.save.data.coins);
  }

  /* --------------------------- restart & pause --------------------------- */
  requestRestart() {
    if (!this.inputAllowed() && this.state !== 'paused' && this.state !== 'completed') return;
    if (this.moves === 0 && this.state !== 'completed') {
      this.doRestart();
      return;
    }
    this.ui.confirm('Restart this level?', () => this.doRestart());
  }
  doRestart() {
    this.audio.click();
    if (this.endless) this.loadDef(this.genDef); else this.loadLevel(this.levelIndex);
  }

  pause() {
    if (!this.inputAllowed()) return;
    this._stateBeforePause = this.state;
    this.setState('paused');
    this.ui.showPause(this.save.data.sound);
  }
  resume() {
    this.ui.hideAllPanels();
    this.setState('waiting');
    this.selection = null;
  }

  toggleSound() {
    this.save.data.sound = !this.save.data.sound;
    this.save.save();
    if (!this.save.data.sound) this.audio.sirenStop();
    return this.save.data.sound;
  }

  showMenu() {
    this.setState('paused');
    this.ui.showMenu(this.save, LEVELS.length, i => {
      this.audio.click();
      this.loadLevel(i);
    }, this.save.data.sound, () => { this.audio.click(); this.startEndless(); },
    () => { this.audio.click(); this.openShop(); });
  }

  /* ------------------------------ economy / shop ------------------------- */
  currentSkin() { return skinById(this.save.data.skin); }

  grantCoins(n) {
    this.save.data.coins += n;
    this.save.save();
    this.ui.updateHUD(this.hudLabel(), this.moves, this.levelDef() ? this.levelDef().par : 0, this.save.data.coins);
  }

  openShop() {
    if (this.inputAllowed()) this.setState('paused');
    this.refreshShop();
  }
  refreshShop() {
    this.ui.showShop(this.save, SKINS, {
      onBuy: id => this.buySkin(id),
      onEquip: id => this.equipSkin(id),
      onWatchAd: () => this.watchAd(30, 'Free coins', () => this.refreshShop()),
      onPack: (coins, label) => this.buyCoins(coins, label),
      onClose: () => { this.audio.click(); this.showMenu(); },
    });
  }

  buySkin(id) {
    const skin = skinById(id);
    if (this.save.data.ownedSkins.includes(id)) { this.equipSkin(id); return; }
    if (this.save.data.coins < skin.cost) {
      this.ui.toast('Not enough coins — earn more!', 1300);
      this.audio.invalid();
      return;
    }
    this.save.data.coins -= skin.cost;
    this.save.data.ownedSkins.push(id);
    this.save.data.skin = id;
    this.save.save();
    this.audio.park();
    this.ui.toast(skin.name + ' unlocked!', 1300);
    this.refreshShop();
  }
  equipSkin(id) {
    if (!this.save.data.ownedSkins.includes(id)) return;
    this.save.data.skin = id;
    this.save.save();
    this.audio.select();
    this.refreshShop();
  }

  /** Simulated coin-pack "purchase" (demo — no real payment processor). */
  buyCoins(amount, label) {
    this.ui.confirm(`Get the ${label} pack (${amount} coins)?\n(demo — no real charge)`, () => {
      this.grantCoins(amount);
      this.audio.complete();
      this.ui.toast('+' + amount + ' coins!', 1200);
      this.refreshShop();
    }, () => this.refreshShop());
  }

  /** Simulated rewarded ad: play a fake ad, then grant the reward (coins, or
      pure "help" when reward is 0). */
  watchAd(reward, reason, afterCb) {
    this.ui.playAd(reward, reason, () => {
      if (reward > 0) { this.grantCoins(reward); this.ui.toast('+' + reward + ' coins!', 1300); }
      this.audio.complete();
      if (afterCb) afterCb();
    });
  }

  /* Rewarded-ad offer that appears every few minutes at a safe moment. */
  startAdOffers() {
    if (this._adTimer) return;
    this._adPending = false;
    this._adTimer = setInterval(() => {
      if (this.save.data.adsRemoved) return;
      this._adPending = true;
      this.tryShowAdOffer();
    }, TUNE.adOfferMs);
  }
  tryShowAdOffer() {
    // Only interrupt at a calm moment: waiting, no other panel/animation.
    if (!this._adPending) return;
    if (this.state !== 'waiting' || this.animator.busy) return;
    if (!this.ui.el.overlay.classList.contains('hidden')) return;
    this._adPending = false;
    this.setState('paused');
    this.ui.showAdOffer(TUNE.adOfferReward, {
      onWatch: () => this.watchAd(TUNE.adOfferReward, 'Bonus coins',
        () => { this.ui.hideAllPanels(); this.setState('waiting'); }),
      onSkip: () => { this.audio.click(); this.ui.hideAllPanels(); this.setState('waiting'); },
    });
  }

  /* ------------------------------- UI wiring ----------------------------- */
  bindUI() {
    const ui = this.ui, el = ui.el;
    const click = fn => e => { e.preventDefault(); this.audio.unlock(); this.audio.click(); fn(); };

    el.btnUndo.addEventListener('click', click(() => this.undo()));
    el.btnHint.addEventListener('click', click(() => this.hint()));
    el.btnRestart.addEventListener('click', click(() => this.requestRestart()));
    el.btnPause.addEventListener('click', click(() => this.pause()));

    el.btnResume.addEventListener('click', click(() => this.resume()));
    el.btnPauseRestart.addEventListener('click', click(() => { this.requestRestart(); }));
    el.btnPauseSound.addEventListener('click', click(() => {
      el.btnPauseSound.textContent = 'SOUND: ' + (this.toggleSound() ? 'ON' : 'OFF');
    }));
    el.btnPauseMenu.addEventListener('click', click(() => this.showMenu()));

    el.btnNext.addEventListener('click', click(() => {
      if (this.endless) this.nextEndless();
      else this.loadLevel(this.levelIndex + 1);   // campaign is infinite
    }));
    el.btnReplay.addEventListener('click', click(() => {
      if (this.endless) this.loadDef(this.genDef); else this.loadLevel(this.levelIndex);
    }));
    el.btnCompleteMenu.addEventListener('click', click(() => this.showMenu()));

    el.btnMenuSound.addEventListener('click', click(() => {
      el.btnMenuSound.textContent = 'SOUND: ' + (this.toggleSound() ? 'ON' : 'OFF');
    }));
    el.btnMenuTutorial.addEventListener('click', click(() => {
      this.save.data.tutorialDone = false;
      this.save.save();
      this.loadLevel(0);
    }));

    el.btnConfirmYes.addEventListener('click', click(() => {
      const cb = ui.confirmCb; ui.confirmCb = null;
      ui.hideAllPanels();
      if (cb) cb();
    }));
    el.btnConfirmNo.addEventListener('click', click(() => {
      const cancel = ui.confirmCancelCb;
      ui.confirmCb = null; ui.confirmCancelCb = null;
      ui.hideAllPanels();
      if (cancel) { cancel(); return; }
      if (this.state === 'paused' && !this._menuOpen) this.setState('waiting');
    }));

    // Keyboard conveniences for desktop testing.
    document.addEventListener('keydown', e => {
      if (e.key === 'u') this.undo();
      if (e.key === 'h') this.hint();
      if (e.key === 'r') this.requestRestart();
      if (e.key === 'Escape') this.pause();
    });
  }

  /* --------------------------------- tick -------------------------------- */
  tick(t, dt) {
    this.animator.update(dt);
    this.particles.update(dt);
    for (const v of this.vehicles) {
      if (v.bounceT > 0) v.bounceT = Math.max(0, v.bounceT - dt * 2.4);
      if (v.shakeT > 0) v.shakeT = Math.max(0, v.shakeT - dt * 2.8);
      if (v.unlockT > 0) v.unlockT = Math.max(0, v.unlockT - dt * 1.1);
    }
    if (this.hintFx && this.hintFx.until < t) this.hintFx = null;
    if (this.blockedFx && this.blockedFx.until < t) this.blockedFx = null;
    if (this._adPending) this.tryShowAdOffer();   // fire the offer at a calm moment
    this.renderer.draw(t, dt);
  }

  /* Exposed for automated browser tests: client-pixel center of a grid cell. */
  testCellCenter(r, c) {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.renderer.cellCenter(r, c);
    return { x: rect.left + p.x, y: rect.top + p.y };
  }
}

/* -------------------------------- BOOTSTRAP ------------------------------ */
window.addEventListener('DOMContentLoaded', () => {
  window.game = new Game();
});

} /* end IS_BROWSER */

/* ---------------------- Node exports for automated tests ------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ROWS, COLS, TILE, TUNE, AMB_ID,
    parseBoard, footprint, spaceCells, buildOcc,
    Pathfinder, computeTargets, movableVehicles, routeIsClear, solveLevel, validateLevel,
    generateLevel, LEVELS,
  };
}
