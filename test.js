/* ============================================================================
   CLEAR THE WAY — automated logic tests (run with: node test.js)
   Validates every level's geometry, proves each level solvable with the real
   solver, and checks the specific Level 1 / Level 5 design requirements.
   ============================================================================ */
'use strict';

const G = require('./game.js');
const {
  LEVELS, AMB_ID, parseBoard, footprint, computeTargets, routeIsClear,
  solveLevel, validateLevel,
} = G;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}

function obstaclesOf(def, overrides = {}) {
  const vs = def.vehicles.map(v => overrides[v.id]
    ? { ...v, ...overrides[v.id] } : { ...v });
  vs.push({ id: AMB_ID, r: def.ambulance.r, c: def.ambulance.c, orient: 'v', len: 2 });
  return vs;
}

/* ------------------------- 1. validate every level ------------------------ */
console.log('\n== Level validation (geometry + solver) ==');
for (const def of LEVELS) {
  console.log(`Level ${def.id} — ${def.name}`);
  const res = validateLevel(def);
  for (const e of res.errors) console.error('    error: ' + e);
  for (const w of res.warnings) console.warn('    warning: ' + w);
  ok(res.ok, `level ${def.id} passes validation`);
  ok(res.solution && res.solution.length > 0, `level ${def.id} is solvable (solver)`);
  if (res.solution) {
    ok(res.solution.length === def.par,
      `level ${def.id} par (${def.par}) matches optimal solution (${res.solution.length})`);
    console.log('    solution: ' + res.solution.map(m => `${m.vehicleId}→${m.spaceId}`).join(', '));
  }
}

/* --------------------- 2. Level 1 specific requirements ------------------- */
console.log('\n== Level 1 requirements ==');
{
  const def = LEVELS[0];
  const board = parseBoard(def);
  const vs = obstaclesOf(def);

  // The red car directly blocks the ambulance.
  const red = def.vehicles.find(v => v.id === 'red');
  const amb = def.ambulance;
  ok(red.c === amb.c && red.r + red.len === amb.r,
    'red car sits directly in front of the ambulance');

  // Red car must reach the lower-left space P1 immediately, without any other
  // vehicle moving first.
  const redTargets = computeTargets(board, vs, def.spaces, 'red');
  ok(redTargets.some(t => t.spaceId === 'P1'),
    'red car can reach lower-left space P1 from the start');

  // Suggested tutorial order must work move by move: orange→P3, cyan→P2, red→P1.
  let cur = vs;
  const order = [['orange', 'P3'], ['cyan', 'P2'], ['red', 'P1']];
  let orderOk = true;
  for (const [vid, sid] of order) {
    const ts = computeTargets(board, cur, def.spaces, vid);
    const t = ts.find(t => t.spaceId === sid);
    if (!t) { orderOk = false; console.error(`    ${vid} cannot reach ${sid}`); break; }
    cur = cur.map(v => v.id === vid ? { ...v, r: t.r, c: t.c, orient: t.orient } : v);
  }
  ok(orderOk, 'tutorial order orange→P3, cyan→P2, red→P1 is playable');
  ok(routeIsClear(board, cur), 'route is clear after the tutorial solution');

  // Blue car has its upper-right option reachable at the start.
  const blueTargets = computeTargets(board, vs, def.spaces, 'blue');
  ok(blueTargets.some(t => t.spaceId === 'P4'), 'blue car can reach upper-right space P4');

  // Route must NOT be clear at the start.
  ok(!routeIsClear(board, vs), 'route starts blocked');
}

/* ------------------------ 3. movement rule checks ------------------------- */
console.log('\n== Movement rules ==');
{
  const def = LEVELS[0];
  const board = parseBoard(def);
  const vs = obstaclesOf(def);

  // Cyan (len 3) must never be offered a 2-cell space.
  const cyanTargets = computeTargets(board, vs, def.spaces, 'cyan');
  ok(!cyanTargets.some(t => ['P1', 'P4'].includes(t.spaceId)),
    'length-3 cyan cannot target length-2 spaces');

  // Occupied space is rejected: park red in P1, then blue cannot use P1.
  const redT = computeTargets(board, vs, def.spaces, 'red').find(t => t.spaceId === 'P1');
  const after = vs.map(v => v.id === 'red' ? { ...v, r: redT.r, c: redT.c, orient: redT.orient } : v);
  const blueT = computeTargets(board, after, def.spaces, 'blue');
  ok(!blueT.some(t => t.spaceId === 'P1'), 'occupied space P1 is not offered to another car');

  // Paths never pass through another vehicle or leave the board.
  let clean = true;
  for (const v of def.vehicles) {
    for (const t of computeTargets(board, vs, def.spaces, v.id)) {
      for (const s of t.path) {
        for (const [r, c] of footprint(s.r, s.c, s.o, v.len)) {
          if (r < 0 || r >= G.ROWS || c < 0 || c >= G.COLS) clean = false;
          if (!board.drivable[r][c]) clean = false;
          for (const o of vs) {
            if (o.id === v.id) continue;
            if (footprint(o.r, o.c, o.orient, o.len).some(([or, oc]) => or === r && oc === c)) clean = false;
          }
        }
      }
    }
  }
  ok(clean, 'every offered path stays on drivable cells and never overlaps a vehicle');

  // No target may end on the emergency route.
  let offRoute = true;
  for (const v of def.vehicles) {
    for (const t of computeTargets(board, vs, def.spaces, v.id)) {
      if (footprint(t.r, t.c, t.orient, v.len).some(([r, c]) => board.routeSet.has(r + ',' + c))) {
        offRoute = false;
      }
    }
  }
  ok(offRoute, 'no parking target blocks the emergency route');
}

/* --------------------------- 4. Level 4 rotation --------------------------- */
console.log('\n== Level 4 turning zone ==');
{
  const def = LEVELS[3];
  const board = parseBoard(def);
  const vs = obstaclesOf(def);
  const mint = def.vehicles.find(v => v.id === 'mint');
  ok(mint.orient === 'h', 'mint starts horizontal');
  const ts = computeTargets(board, vs, def.spaces, 'mint');
  const t = ts.find(t => t.spaceId === 'H1');
  ok(!!t, 'mint can reach vertical bay H1');
  ok(t && t.orient === 'v', 'mint arrives vertical (rotated in the turning zone)');
  ok(t && t.path.some((s, i) => i > 0 && s.o !== t.path[i - 1].o), 'path includes a rotation step');
}

/* ---------------------------- 5. Level 5 decoy ----------------------------- */
console.log('\n== Level 5 decoy ==');
{
  const def = LEVELS[4];
  const board = parseBoard(def);
  const vs = obstaclesOf(def);
  const vanT = computeTargets(board, vs, def.spaces, 'olive');
  ok(!vanT.some(t => t.spaceId === 'D5'), 'long van cannot use the short decoy space D5');
  ok(vanT.some(t => t.spaceId === 'V5'), 'long van can use the real long bay V5');
  const carT = computeTargets(board, vs, def.spaces, 'punch');
  ok(carT.some(t => t.spaceId === 'A5'), 'small car has a reachable space');
}

/* --------------------------------- summary -------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
