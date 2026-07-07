/* ============================================================================
   CLEAR THE WAY — automated logic tests (run with: node test.js)

   Validates every level's geometry and proves the chain-reaction puzzle design:
   each level is a dense jam that starts with exactly ONE movable vehicle, the
   ambulance route is blocked at the start, the correct chain is solvable, and
   blocked cars can never be moved or offered as valid targets.
   ============================================================================ */
'use strict';

const G = require('./game.js');
const {
  LEVELS, AMB_ID, ROWS, COLS, parseBoard, footprint, spaceCells,
  computeTargets, movableVehicles, routeIsClear, solveLevel, validateLevel,
} = G;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}

/** Civilian vehicles + the ambulance as plain obstacle records. */
function obstaclesOf(def, overrides = {}) {
  const vs = def.vehicles.map(v => overrides[v.id] ? { ...v, ...overrides[v.id] } : { ...v });
  vs.push({ id: AMB_ID, r: def.ambulance.r, c: def.ambulance.c, orient: 'v', len: 2 });
  return vs;
}

/** Play the solver's solution and return the sequence of board states. */
function playSolution(def) {
  const board = parseBoard(def);
  let vs = obstaclesOf(def);
  const sol = solveLevel(board, vs, def.spaces, 24);
  if (!sol) return null;
  const states = [vs];
  for (const m of sol) {
    vs = vs.map(v => v.id === m.vehicleId ? { ...v, r: m.r, c: m.c, orient: m.orient } : v);
    states.push(vs);
  }
  return { board, sol, states };
}

/* ==================== 1. validate + chain structure per level ============== */
console.log('\n== Level validation (geometry + chain structure + solver) ==');
const CAR_RANGE = { 1: [8, 10], 2: [10, 12], 3: [12, 14], 4: [15, 15], 5: [15, 18] };
for (const def of LEVELS) {
  console.log(`Level ${def.id} — ${def.name}`);
  const res = validateLevel(def);
  res.errors.forEach(e => console.error('    error: ' + e));
  res.warnings.forEach(w => console.warn('    warning: ' + w));
  ok(res.ok, `level ${def.id} passes validation`);

  const board = parseBoard(def);
  const vs = obstaclesOf(def);

  // Required: dense jam, exactly one movable vehicle at the start.
  const [lo, hi] = CAR_RANGE[def.id];
  ok(def.vehicles.length >= lo && def.vehicles.length <= hi,
    `level ${def.id} has ${def.vehicles.length} cars (want ${lo}-${hi})`);
  const startMovable = movableVehicles(board, vs, def.spaces);
  ok(startMovable.length === 1,
    `level ${def.id} starts with exactly 1 movable vehicle (${JSON.stringify(startMovable)})`);

  // Required: the ambulance route is blocked at the start.
  ok(!routeIsClear(board, vs), `level ${def.id} route is blocked at the start`);

  // Required: solvable, and the route only becomes clear at the very end.
  const played = playSolution(def);
  ok(played, `level ${def.id} is solvable (solver)`);
  if (played) {
    ok(played.sol.length === def.par,
      `level ${def.id} par (${def.par}) matches optimal solution (${played.sol.length})`);
    // Ambulance stays blocked until the final move of the chain.
    let clearedEarly = false;
    for (let i = 0; i < played.states.length - 1; i++) {
      if (routeIsClear(board, played.states[i])) clearedEarly = true;
    }
    ok(!clearedEarly, `level ${def.id} route stays blocked until the chain is complete`);
    ok(routeIsClear(board, played.states[played.states.length - 1]),
      `level ${def.id} route is clear after the chain (ambulance can exit)`);
    console.log('    chain: ' + played.sol.map(m => `${m.vehicleId}→${m.spaceId}`).join(', '));
  }
}

/* ==================== 2. blocked cars cannot move or be targeted =========== */
console.log('\n== Blocked cars are never movable or valid ==');
for (const def of LEVELS) {
  const board = parseBoard(def);
  const vs = obstaclesOf(def);
  const movable = new Set(movableVehicles(board, vs, def.spaces));
  let blockedHaveNoTargets = true, blockedCount = 0;
  for (const v of def.vehicles) {
    if (movable.has(v.id)) continue;
    blockedCount++;
    // A blocked car must have zero legal targets (cannot be selected as valid).
    if (computeTargets(board, vs, def.spaces, v.id).length !== 0) blockedHaveNoTargets = false;
  }
  ok(blockedHaveNoTargets, `level ${def.id}: all ${blockedCount} blocked cars have no legal target`);
}

/* ==================== 3. movable set grows as the chain is played ========== */
console.log('\n== Chain reaction: moves unlock new vehicles ==');
{
  const def = LEVELS[0];
  const played = playSolution(def);
  const m0 = movableVehicles(played.board, played.states[0], def.spaces);
  const m1 = movableVehicles(played.board, played.states[1], def.spaces);
  ok(m0.length === 1, 'level 1 has 1 movable before the first move');
  ok(m1.length > m0.length, 'level 1: the opener unlocks additional vehicles');
}

/* ==================== 4. movement realism (axis-only, no crab-slide) ======= */
console.log('\n== Movement rules ==');
{
  const def = LEVELS[0];
  const board = parseBoard(def);
  const vs = obstaclesOf(def);

  // Every offered path is a legal sequence of single forward/reverse steps or a
  // rotation — never a sideways slide of a car across its own body.
  let realistic = true, onBoard = true, noOverlap = true, offRoute = true;
  for (const v of def.vehicles) {
    for (const t of computeTargets(board, vs, def.spaces, v.id)) {
      for (let i = 1; i < t.path.length; i++) {
        const a = t.path[i - 1], b = t.path[i];
        const dr = Math.abs(b.r - a.r), dc = Math.abs(b.c - a.c);
        const rotated = a.o !== b.o;
        const slid = !rotated && (dr + dc === 1);
        if (!rotated && !slid) realistic = false;
        // A moving car must translate along its own heading, never sideways.
        if (slid) {
          if (a.o === 'v' && dc !== 0) realistic = false;   // vertical car moved sideways
          if (a.o === 'h' && dr !== 0) realistic = false;   // horizontal car moved sideways
        }
      }
      // Destination stays on the board, off scenery, off other cars, off route.
      for (const [r, c] of footprint(t.r, t.c, t.orient, v.len)) {
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) onBoard = false;
        else if (!board.drivable[r][c]) onBoard = false;
        if (board.routeSet.has(r + ',' + c)) offRoute = false;
        for (const o of vs) {
          if (o.id === v.id) continue;
          if (footprint(o.r, o.c, o.orient, o.len).some(([or, oc]) => or === r && oc === c)) noOverlap = false;
        }
      }
    }
  }
  ok(realistic, 'cars only drive along their heading or rotate — never crab-slide sideways');
  ok(onBoard, 'every destination stays on the board and on drivable cells');
  ok(noOverlap, 'no destination overlaps another vehicle');
  ok(offRoute, 'no parking target blocks the emergency route');
}

/* ==================== 5. no vehicle disappears / parks off a real bay ====== */
console.log('\n== Vehicles never disappear or park outside a real bay ==');
for (const def of LEVELS) {
  const played = playSolution(def);
  if (!played) { ok(false, `level ${def.id} solvable`); continue; }
  const finalState = played.states[played.states.length - 1];
  // Same set of vehicles at the end as at the start (nothing removed/added).
  const startIds = def.vehicles.map(v => v.id).sort().join(',');
  const endIds = finalState.filter(v => v.id !== AMB_ID).map(v => v.id).sort().join(',');
  ok(startIds === endIds, `level ${def.id}: no vehicle disappears during the solution`);

  // Every vehicle that moved ends fully inside a declared parking space.
  let allParked = true;
  for (const m of played.sol) {
    const v = finalState.find(x => x.id === m.vehicleId);
    const sp = def.spaces.find(s => s.id === m.spaceId);
    const cells = spaceCells(sp);
    const inside = footprint(v.r, v.c, v.orient, v.len)
      .every(([r, c]) => cells.some(([sr, sc]) => sr === r && sc === c));
    if (!inside) allParked = false;
  }
  ok(allParked, `level ${def.id}: every moved vehicle parks fully inside a real bay`);
}

/* ==================== 6. hint points at the next chain move ================ */
console.log('\n== Hint targets the correct movable car ==');
for (const def of LEVELS) {
  const board = parseBoard(def);
  const vs = obstaclesOf(def);
  const startMovable = movableVehicles(board, vs, def.spaces);
  const sol = solveLevel(board, vs, def.spaces, 24);
  // When only one car is movable, the correct hint is unambiguous: that car.
  ok(startMovable.length === 1 && sol && sol[0].vehicleId === startMovable[0],
    `level ${def.id}: the single movable car is the correct first move (${startMovable[0]})`);
}

/* --------------------------------- summary -------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
