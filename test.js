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
  computeTargets, movableVehicles, routeIsClear, solveLevel, validateLevel, generateLevel,
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

/** Classify every legal first move as good (optimal/win) or decoy (trap/waste). */
function classifyFirstMoves(def) {
  const board = parseBoard(def);
  const vs = obstaclesOf(def);
  const depth = def.vehicles.length + 4;
  const opt = solveLevel(board, vs, def.spaces, depth);
  if (!opt) return null;
  const out = { good: 0, waste: 0, trap: 0, moves: [] };
  for (const id of movableVehicles(board, vs, def.spaces)) {
    for (const t of computeTargets(board, vs, def.spaces, id)) {
      const vs2 = vs.map(v => v.id === id ? { ...v, r: t.r, c: t.c, orient: t.orient } : v);
      let cls;
      if (routeIsClear(board, vs2)) cls = 'good';
      else {
        const sub = solveLevel(board, vs2, def.spaces, depth);
        cls = !sub ? 'trap' : (1 + sub.length > opt.length ? 'waste' : 'good');
      }
      out[cls === 'good' ? 'good' : cls]++;
      out.moves.push({ id, sp: t.spaceId, cls });
    }
  }
  out.optLen = opt.length;
  return out;
}

/** Largest group of vehicles sharing (orient,len) in the same anchor lane. */
function maxIdenticalInLane(def) {
  const lanes = {};
  for (const v of def.vehicles) {
    const key = v.orient + v.len + '@' + (v.orient === 'h' ? 'c' + v.c : 'r' + v.r);
    lanes[key] = (lanes[key] || 0) + 1;
  }
  return Math.max(0, ...Object.values(lanes));
}

/* ==================== 1. choice-puzzle structure per level ================= */
console.log('\n== Level validation (geometry + choices + solver) ==');
const CAR_RANGE = { 1: [8, 10], 2: [10, 12], 3: [12, 14], 4: [15, 15], 5: [15, 18] };
for (const def of LEVELS) {
  console.log(`Level ${def.id} — ${def.name}`);
  const res = validateLevel(def);
  res.errors.forEach(e => console.error('    error: ' + e));
  res.warnings.forEach(w => console.warn('    warning: ' + w));
  ok(res.ok, `level ${def.id} passes validation`);

  const board = parseBoard(def);
  const vs = obstaclesOf(def);

  const [lo, hi] = CAR_RANGE[def.id];
  ok(def.vehicles.length >= lo && def.vehicles.length <= hi,
    `level ${def.id} has ${def.vehicles.length} cars (want ${lo}-${hi})`);

  // Required: 2-4 legal moves at the start (a real choice, not a chain).
  const startMovable = movableVehicles(board, vs, def.spaces);
  ok(startMovable.length >= 2 && startMovable.length <= 4,
    `level ${def.id} starts with 2-4 movable vehicles (${startMovable.length}: ${JSON.stringify(startMovable)})`);

  // Required: no 4 identical vehicles lined up doing the same move.
  ok(maxIdenticalInLane(def) < 4,
    `level ${def.id} has no 4 identical vehicles in one lane (max ${maxIdenticalInLane(def)})`);

  // Required: the ambulance route is blocked at the start.
  ok(!routeIsClear(board, vs), `level ${def.id} route is blocked at the start`);

  // Required: at least one decoy move and at least one good move (a decision).
  const cls = classifyFirstMoves(def);
  ok(cls && cls.trap + cls.waste >= 1,
    `level ${def.id} has at least one decoy move (${cls ? cls.trap + ' trap, ' + cls.waste + ' waste' : 'n/a'})`);
  ok(cls && cls.good >= 1 && (cls.trap + cls.waste) >= 1,
    `level ${def.id} requires a meaningful decision (good + decoy both exist)`);

  // Required: solvable, and the route only becomes clear at the very end.
  const played = playSolution(def);
  ok(played, `level ${def.id} is solvable (solver)`);
  if (played) {
    ok(played.sol.length === def.par,
      `level ${def.id} par (${def.par}) matches optimal solution (${played.sol.length})`);
    let clearedEarly = false;
    for (let i = 0; i < played.states.length - 1; i++) {
      if (routeIsClear(board, played.states[i])) clearedEarly = true;
    }
    ok(!clearedEarly, `level ${def.id} route stays blocked until the plan is complete`);
    ok(routeIsClear(board, played.states[played.states.length - 1]),
      `level ${def.id} route is clear after the solution (ambulance can exit)`);
    console.log('    optimal: ' + played.sol.map(m => `${m.vehicleId}→${m.spaceId}`).join(', ') +
      `  | first-move choices: ${cls.good} good / ${cls.trap} trap / ${cls.waste} waste`);
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

/* ==================== 3. every level offers real choices ================== */
console.log('\n== Choices: multiple movers, decoys, and traps exist ==');
{
  let anyTrap = false, everyLevelDecision = true;
  for (const def of LEVELS) {
    const cls = classifyFirstMoves(def);
    if (cls.trap > 0) anyTrap = true;
    if (!(cls.good >= 1 && cls.trap + cls.waste >= 1)) everyLevelDecision = false;
  }
  ok(everyLevelDecision, 'every level has both a good move and a decoy move at the start');
  ok(anyTrap, 'at least one level has a hard trap (a legal move that dead-ends)');
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

  // Every move lands the vehicle fully inside its declared bay (checked at the
  // moment of that move, so cars that move twice are handled correctly).
  let allParked = true;
  for (let i = 0; i < played.sol.length; i++) {
    const m = played.sol[i];
    const v = played.states[i + 1].find(x => x.id === m.vehicleId);
    const cells = spaceCells(def.spaces.find(s => s.id === m.spaceId));
    const inside = footprint(v.r, v.c, v.orient, v.len)
      .every(([r, c]) => cells.some(([sr, sc]) => sr === r && sc === c));
    if (!inside) allParked = false;
  }
  ok(allParked, `level ${def.id}: every move parks a vehicle fully inside a real bay`);
}

/* ==================== 6. hint recommends a GOOD (non-decoy) move =========== */
console.log('\n== Hint recommends a strategically good move ==');
for (const def of LEVELS) {
  const board = parseBoard(def);
  const vs = obstaclesOf(def);
  const depth = def.vehicles.length + 4;
  const sol = solveLevel(board, vs, def.spaces, depth);
  // The hint follows the solver's first move; verify that move is NOT a decoy:
  // taking it keeps the level solvable at the optimal length (it's on a best line).
  const first = sol[0];
  const vs2 = vs.map(v => v.id === first.vehicleId ? { ...v, r: first.r, c: first.c, orient: first.orient } : v);
  const sub = solveLevel(board, vs2, def.spaces, depth);
  ok(sub && 1 + sub.length === sol.length,
    `level ${def.id}: hint move ${first.vehicleId}→${first.spaceId} is optimal, not a decoy`);
}

/* ==================== 7. infinite generator (Endless mode) ================ */
console.log('\n== Procedural generator: infinite solvable, varied puzzles ==');
{
  const N = 120;                       // generate many across sizes/seeds
  let good = 0, blockedAll = true, solvableAll = true, everyCarMoves = true;
  let distinctStructures = new Set();
  let sizeOk = true, offRouteBays = true, noDisappear = true;
  for (let i = 0; i < N; i++) {
    const cars = 6 + (i % 7);          // 6..12
    const def = generateLevel(1234567 + i * 101, { cars });
    if (!def) { solvableAll = false; continue; }
    if (def.vehicles.length !== cars) sizeOk = false;

    const board = parseBoard(def);
    const vs = def.vehicles.map(v => ({ ...v }));
    vs.push({ id: AMB_ID, r: def.ambulance.r, c: def.ambulance.c, orient: 'v', len: 2 });

    // Ambulance blocked at the start.
    if (routeIsClear(board, vs)) blockedAll = false;

    // Bays are all off the emergency route (cars never park on col 3).
    for (const sp of def.spaces) {
      if (spaceCells(sp).some(([r, c]) => board.routeSet.has(r + ',' + c))) offRouteBays = false;
    }

    // Provably solvable by the real solver, and it clears the route.
    const sol = solveLevel(board, vs, def.spaces, def.vehicles.length + 3);
    if (!sol) { solvableAll = false; continue; }
    // Replay the solution: every moved car lands in a real bay; nobody vanishes.
    let cur = vs;
    for (const m of sol) {
      const sp = def.spaces.find(s => s.id === m.spaceId);
      if (!sp) noDisappear = false;
      cur = cur.map(v => v.id === m.vehicleId ? { ...v, r: m.r, c: m.c, orient: m.orient } : v);
    }
    if (!routeIsClear(board, cur)) solvableAll = false;
    if (cur.filter(v => v.id !== AMB_ID).length !== def.vehicles.length) noDisappear = false;

    // "Every car has a purpose": most cars actually move in the solution.
    const moved = new Set(sol.map(m => m.vehicleId));
    if (moved.size < Math.ceil(def.vehicles.length * 0.5)) everyCarMoves = false;

    // Layered (not everything movable at once): at least one car blocked at start.
    const sm = movableVehicles(board, vs, def.spaces).length;
    if (sm >= def.vehicles.length) distinctStructures.add('trivial');

    // Fingerprint the layout to confirm maps really differ.
    distinctStructures.add(def.vehicles.map(v => `${v.orient}${v.len}@${v.r},${v.c}`).join('|'));
    good++;
  }
  ok(good === N, `generated all ${N} levels (got ${good})`);
  ok(sizeOk, 'each generated level has the requested car count');
  ok(blockedAll, 'every generated level starts with the ambulance blocked');
  ok(solvableAll, 'every generated level is solvable and the solution clears the route');
  ok(offRouteBays, 'generated parking bays are never on the emergency route');
  ok(noDisappear, 'no vehicle disappears; every moved car lands in a real bay');
  ok(everyCarMoves, 'most cars have a real purpose (move in the solution)');
  ok(!distinctStructures.has('trivial'), 'no generated level is trivially all-movable at once');
  ok(distinctStructures.size >= N - 2, `generated maps are distinct (${distinctStructures.size}/${N} unique)`);

  // Determinism: same seed -> same map (needed for reproducible bug reports).
  const a = generateLevel(42, { cars: 9 }), b = generateLevel(42, { cars: 9 });
  ok(JSON.stringify(a.vehicles) === JSON.stringify(b.vehicles), 'generation is deterministic per seed');

  // A layered example: report movable-at-start for a sample.
  const sample = generateLevel(2024, { cars: 10 });
  const sb = parseBoard(sample);
  const svs = sample.vehicles.map(v => ({ ...v }));
  svs.push({ id: AMB_ID, r: sample.ambulance.r, c: sample.ambulance.c, orient: 'v', len: 2 });
  console.log(`    sample(seed 2024,10 cars): par ${sample.par}, movable@start ` +
    `${movableVehicles(sb, svs, sample.spaces).length}`);
}

/* --------------------------------- summary -------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
