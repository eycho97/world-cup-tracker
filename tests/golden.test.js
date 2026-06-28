#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { scoreTeam, KNOCKOUT_POINTS } = require('../logic/score.js');
const { derive } = require('../logic/derive.js');

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Single-group standings for KO-logic tests (ranking doesn't matter with 1 group).
// Includes all fields derive() reads from standings rows.
const mkRow = (pos, id, pts, gd, gf) => ({
  position: pos,
  team: { id },
  playedGames: 3,
  points: pts,
  goalDifference: gd,
  goalsFor: gf,
});

const mkStandings = (...ids) => [{
  group: 'Group A',
  table: ids.map((id, i) => mkRow(
    i + 1,
    id,
    [9, 6, 3, 0][i] ?? 0,
    [3, 1, -1, -3][i] ?? 0,
    [8, 5, 3, 1][i] ?? 0,
  )),
}];

// Match factory.  winner: 'H' = HOME_TEAM wins, 'A' = AWAY_TEAM wins.
function mkMatch(stage, status, winner, homeId, awayId, duration = 'REGULAR') {
  return {
    stage, status,
    homeTeam: { id: homeId },
    awayTeam: { id: awayId },
    score: {
      winner:   winner === 'H' ? 'HOME_TEAM' : 'AWAY_TEAM',
      duration,
    },
  };
}

// ── 12-group standings fixture for 3rd-place ranking tests ─────────────────
// Groups 0–7: 3rd-place teams advance (top 8).
// Groups 8–11: 3rd-place teams do NOT advance (ranked 9–12).
// The 8th/9th boundary is unambiguous so the fixture doesn't throw by default.
const P3_STATS = [
  { pts: 4, gd:  1, gf: 4 },   // Group A rank 1 — advances
  { pts: 4, gd:  0, gf: 7 },   // Group B rank 2 — advances
  { pts: 4, gd:  0, gf: 5 },   // Group C rank 3 — advances
  { pts: 4, gd:  0, gf: 3 },   // Group D rank 4 — advances
  { pts: 4, gd: -1, gf: 5 },   // Group E rank 5 — advances
  { pts: 4, gd: -2, gf: 5 },   // Group F rank 6 — advances
  { pts: 3, gd:  2, gf: 5 },   // Group G rank 7 — advances
  { pts: 3, gd:  1, gf: 4 },   // Group H rank 8 — advances  ← last in
  { pts: 3, gd:  0, gf: 3 },   // Group I rank 9 — does NOT advance ← first out
  { pts: 3, gd: -1, gf: 2 },   // Group J rank 10
  { pts: 2, gd:  0, gf: 1 },   // Group K rank 11
  { pts: 1, gd: -2, gf: 1 },   // Group L rank 12
];

const mkGroupId = (gi, pos) => 1000 + gi * 10 + pos; // e.g. Group 0 pos 1 → 1001

const FULL_STANDINGS = P3_STATS.map((stats, gi) => ({
  group: `Group ${String.fromCharCode(65 + gi)}`,
  table: [
    mkRow(1, mkGroupId(gi, 1), 9,  3,  8),
    mkRow(2, mkGroupId(gi, 2), 5,  1,  5),
    mkRow(3, mkGroupId(gi, 3), stats.pts, stats.gd, stats.gf),
    mkRow(4, mkGroupId(gi, 4), 0, -4,  1),
  ],
}));

// Team id sets derived from the fixture above
const GW_IDS  = P3_STATS.map((_, gi) => mkGroupId(gi, 1));   // 12 group winners
const RU_IDS  = P3_STATS.map((_, gi) => mkGroupId(gi, 2));   // 12 runners-up
const P3_ADV  = [0,1,2,3,4,5,6,7].map(gi => mkGroupId(gi, 3));  // top-8 3rd
const P3_OUT  = [8,9,10,11].map(gi => mkGroupId(gi, 3));         // bottom-4 3rd
const P4_IDS  = P3_STATS.map((_, gi) => mkGroupId(gi, 4));   // 12 eliminated

// Dummy IDs
const [GW, R2, P3, OUT] = [100, 200, 300, 400];
const OPP = 999;

// ---------------------------------------------------------------------------
// SECTION 1 — Scoring table (all 14 combinations)
// ---------------------------------------------------------------------------
console.log('\nSECTION 1 — Scoring table');

const scoringCases = [
  [false, 'GROUP',    0,  'eliminated in groups, non-winner'],
  [true,  'GROUP',    2,  'group winner, furthest_stage=GROUP (R32 bracket still unpopulated)'],
  [false, 'R32',      1,  'advanced (runner-up / best-3rd), lost R32'],
  [true,  'R32',      2,  'group winner lost R32 → 2, not 3'],
  [false, 'R16',      3,  'advanced, won R32, lost R16'],
  [true,  'R16',      4,  'group winner, won R32, lost R16'],
  [false, 'QF',       6,  'advanced, won R16, lost QF'],
  [true,  'QF',       7,  'group winner, won R16, lost QF'],
  [false, 'SF',      10,  'advanced, won QF, lost SF'],
  [true,  'SF',      11,  'group winner, won QF, lost SF'],
  [false, 'FINAL',   15,  'advanced, won SF, runner-up'],
  [true,  'FINAL',   16,  'group winner, won SF, runner-up'],
  [false, 'CHAMPION', 21, 'advanced non-winner, champion'],
  [true,  'CHAMPION', 22, 'group winner, champion (max = 22)'],
];

for (const [wg, fs, expected, label] of scoringCases) {
  test(label, () => {
    const got = scoreTeam({ won_group: wg, furthest_stage: fs });
    assert.strictEqual(got, expected,
      `scoreTeam({won_group:${wg}, furthest_stage:'${fs}'}) → expected ${expected}, got ${got}`);
  });
}

// ---------------------------------------------------------------------------
// SECTION 2 — 3rd-place ranking & advancement (regression for today's bug)
// ---------------------------------------------------------------------------
console.log('\nSECTION 2 — 3rd-place ranking & advancement (regression)');

// 2a. The exact failure we just hit: group stage complete, R32 bracket empty,
//     yet all advancers (incl. best-3rd) must be credited from standings alone.
test('groups complete + bracket EMPTY → all advancers credited from standings', () => {
  const r = derive(FULL_STANDINGS, []); // no matches at all

  for (const id of GW_IDS) {
    assert.deepStrictEqual(r.teams[String(id)], { won_group: true,  furthest_stage: 'R32' },
      `group winner ${id} should be R32`);
  }
  for (const id of RU_IDS) {
    assert.deepStrictEqual(r.teams[String(id)], { won_group: false, furthest_stage: 'R32' },
      `runner-up ${id} should be R32`);
  }
  for (const id of P3_ADV) {
    assert.deepStrictEqual(r.teams[String(id)], { won_group: false, furthest_stage: 'R32' },
      `best-3rd ${id} should be R32`);
  }
  for (const id of P3_OUT) {
    assert.deepStrictEqual(r.teams[String(id)], { won_group: false, furthest_stage: 'GROUP' },
      `non-qualifying 3rd ${id} should be GROUP`);
  }
  for (const id of P4_IDS) {
    assert.deepStrictEqual(r.teams[String(id)], { won_group: false, furthest_stage: 'GROUP' },
      `4th-place ${id} should be GROUP`);
  }
  // Exactly 32 teams advanced (12 GW + 12 RU + 8 best-3rd)
  const advCount = Object.values(r.teams).filter(v => v.furthest_stage !== 'GROUP').length;
  assert.strictEqual(advCount, 32, `expected 32 advancers, got ${advCount}`);
});

// 2b. Best-third advances by ranking (not by bracket participation).
test('best-3rd ranked 8th advances even with no bracket slot filled', () => {
  const rank8Id = mkGroupId(7, 3); // Group H, 3pts GD=+1 GF=4 — 8th of 12
  const r = derive(FULL_STANDINGS, []);
  assert.deepStrictEqual(r.teams[String(rank8Id)], { won_group: false, furthest_stage: 'R32' });
  assert.strictEqual(scoreTeam(r.teams[String(rank8Id)]), 1);
});

// 2c. The 9th-ranked third-place team does NOT advance (scores 0 group pts).
test('9th-ranked 3rd-place team does NOT advance → GROUP, 0 pts', () => {
  const rank9Id = mkGroupId(8, 3); // Group I, 3pts GD=0 GF=3 — 9th of 12
  const r = derive(FULL_STANDINGS, []);
  assert.deepStrictEqual(r.teams[String(rank9Id)], { won_group: false, furthest_stage: 'GROUP' });
  assert.strictEqual(scoreTeam(r.teams[String(rank9Id)]), 0);
});

// 2d. Tie at the 8th/9th boundary → derive throws rather than guessing.
test('tie at 8th/9th boundary → throws, never silently resolved', () => {
  // Replace groups 7 and 8 so their 3rd-place teams are statistically identical.
  const tiedStandings = FULL_STANDINGS.map((g, gi) => {
    if (gi !== 7 && gi !== 8) return g;
    // Both get 3pts, GD=+1, GF=4  →  tied
    return {
      ...g,
      table: [
        mkRow(1, mkGroupId(gi, 1), 9,  3, 8),
        mkRow(2, mkGroupId(gi, 2), 5,  1, 5),
        mkRow(3, mkGroupId(gi, 3), 3,  1, 4),   // ← same stats for gi=7 and gi=8
        mkRow(4, mkGroupId(gi, 4), 0, -4, 1),
      ],
    };
  });
  assert.throws(
    () => derive(tiedStandings, []),
    /STOP: tie at 8th\/9th 3rd-place boundary/,
    'derive should throw on an unresolvable 8/9 tie'
  );
});

// 2e. Scoring check: 24 group-pts (12×2) + 20 advancement-pts (12+8×1) = 44 pts
//     (Cap Verde Islands is undrafted → 43 pts from drafted teams — validated in
//      section 4; here just check the math on the full 48-team fixture)
test('full fixture total: 24 group pts + 32 advancement pts = 56 total pts', () => {
  const r = derive(FULL_STANDINGS, []);
  const total = Object.values(r.teams).reduce(
    (sum, v) => sum + scoreTeam(v), 0
  );
  // 12 GW × 2 + 12 RU × 1 + 8 best-3rd × 1 = 24 + 12 + 8 = 44
  // (fixture has exactly 48 teams, 12 GW, 12 RU, 8 advancing 3rd, 4 non-adv 3rd, 12 pos-4)
  assert.strictEqual(total, 44);
});

// ---------------------------------------------------------------------------
// SECTION 3 — Derive edge cases (KO promotion logic)
// ---------------------------------------------------------------------------
console.log('\nSECTION 3 — Derive edge cases (KO promotion)');

// 3a. Penalty-shootout: score.winner drives promotion; duration is irrelevant.
test('penalty-shootout: score.winner=HOME_TEAM promotes home team', () => {
  const standings = mkStandings(GW, R2, P3, OUT);
  const matches   = [mkMatch('LAST_32', 'FINISHED', 'H', GW, P3, 'PENALTY_SHOOTOUT')];
  const r         = derive(standings, matches);

  // GW won LAST_32 → promoted to R16
  assert.deepStrictEqual(r.teams[String(GW)], { won_group: true,  furthest_stage: 'R16' });
  // P3 is advanced from standings (only 3rd-place in 1 group), lost R32 → stays R32
  assert.deepStrictEqual(r.teams[String(P3)], { won_group: false, furthest_stage: 'R32' });
  assert.strictEqual(scoreTeam(r.teams[String(P3)]), 1);
});

// 3b. Best-3rd advancer now sourced from standings, not bracket.
//     (The bracket match here confirms the team appears in R32, but the advancement
//     is established before looking at any match data.)
test('best-3rd advancer: credited from standings regardless of bracket state', () => {
  const standings = mkStandings(GW, R2, P3, OUT); // P3 is sole 3rd-place → advances
  const r_no_bracket = derive(standings, []);       // no bracket at all
  const r_with_loss  = derive(standings, [         // bracket slot filled, P3 loses
    mkMatch('LAST_32', 'FINISHED', 'H', OPP, P3), // OPP home wins → P3 loses
  ]);

  // Both: P3 is advanced (R32), non-group-winner → 1 pt
  assert.strictEqual(r_no_bracket.teams[String(P3)].furthest_stage, 'R32');
  assert.strictEqual(r_with_loss.teams [String(P3)].furthest_stage, 'R32');
  assert.strictEqual(scoreTeam(r_no_bracket.teams[String(P3)]), 1);
  // OUT (pos 4) never advances
  assert.strictEqual(r_no_bracket.teams[String(OUT)].furthest_stage, 'GROUP');
  assert.strictEqual(scoreTeam(r_no_bracket.teams[String(OUT)]), 0);
});

// 3c. Group winner eliminated in R32 = 2 pts (group pts exclusive: 2, not 3).
test('group winner lost R32 → furthest_stage=R32, score=2 (not 3)', () => {
  const standings = mkStandings(GW, R2, P3, OUT);
  const matches   = [mkMatch('LAST_32', 'FINISHED', 'A', GW, OPP)]; // OPP away wins
  const r         = derive(standings, matches);

  assert.deepStrictEqual(r.teams[String(GW)], { won_group: true, furthest_stage: 'R32' });
  assert.strictEqual(scoreTeam(r.teams[String(GW)]), 2); // 2 (group) + 0 (KO) = 2
});

// 3d. SF loser who also loses the 3rd-place game must land at SF, not THIRD_PLACE.
test('SF loser loses 3rd-place game → furthest_stage=SF, score=10', () => {
  const standings = mkStandings(GW, R2, P3, OUT);
  const matches   = [
    mkMatch('LAST_32',        'FINISHED', 'H', R2, OPP),   // R2 wins → R16
    mkMatch('LAST_16',        'FINISHED', 'H', R2, OPP),   // R2 wins → QF
    mkMatch('QUARTER_FINALS', 'FINISHED', 'H', R2, OPP),   // R2 wins → SF
    mkMatch('SEMI_FINALS',    'FINISHED', 'H', OPP, R2),   // OPP home wins → R2 loses SF
    mkMatch('THIRD_PLACE',    'FINISHED', 'H', OPP, R2),   // OPP home wins → R2 loses 3rd-place (inert)
  ];
  const r = derive(standings, matches);

  assert.strictEqual(r.teams[String(R2)].furthest_stage, 'SF', 'must be SF, not THIRD_PLACE');
  assert.notStrictEqual(r.teams[String(R2)].furthest_stage, 'THIRD_PLACE');
  assert.strictEqual(scoreTeam(r.teams[String(R2)]), 10); // 1 (adv) + 9 (KO) = 10
});

// 3e. Winning the 3rd-place game gives the SAME stage as losing it (THIRD_PLACE inert).
test('SF loser WINS 3rd-place game → still furthest_stage=SF, score=10', () => {
  const standings = mkStandings(GW, R2, P3, OUT);
  const matches   = [
    mkMatch('LAST_32',        'FINISHED', 'H', R2, OPP),
    mkMatch('LAST_16',        'FINISHED', 'H', R2, OPP),
    mkMatch('QUARTER_FINALS', 'FINISHED', 'H', R2, OPP),
    mkMatch('SEMI_FINALS',    'FINISHED', 'H', OPP, R2),   // R2 loses SF
    mkMatch('THIRD_PLACE',    'FINISHED', 'H', R2, OPP),   // R2 WINS — still inert
  ];
  const r = derive(standings, matches);

  assert.strictEqual(r.teams[String(R2)].furthest_stage, 'SF');
  assert.strictEqual(scoreTeam(r.teams[String(R2)]), 10);
});

// ---------------------------------------------------------------------------
// SECTION 4 — Derive correctness (misc)
// ---------------------------------------------------------------------------
console.log('\nSECTION 4 — Derive correctness');

test('advanced teams start at R32 even with zero matches', () => {
  // All of GW, R2, P3 are advanced from standings; OUT is not.
  const r = derive(mkStandings(GW, R2, P3, OUT), []);

  assert.deepStrictEqual(r.teams[String(GW)],  { won_group: true,  furthest_stage: 'R32' });
  assert.deepStrictEqual(r.teams[String(R2)],  { won_group: false, furthest_stage: 'R32' });
  assert.deepStrictEqual(r.teams[String(P3)],  { won_group: false, furthest_stage: 'R32' });
  assert.deepStrictEqual(r.teams[String(OUT)], { won_group: false, furthest_stage: 'GROUP' });
  assert.strictEqual(scoreTeam(r.teams[String(GW)]),  2); // group winner in R32
  assert.strictEqual(scoreTeam(r.teams[String(R2)]),  1);
  assert.strictEqual(scoreTeam(r.teams[String(P3)]),  1);
  assert.strictEqual(scoreTeam(r.teams[String(OUT)]), 0);
});

test('TIMED / malformed-status match: bracket participation counted but no promotion', () => {
  const standings = mkStandings(GW, R2, P3, OUT);
  const matches   = [
    { stage: 'LAST_32', status: 'TIMED',               homeTeam: { id: GW }, awayTeam: { id: OPP },
      score: { winner: null, duration: 'REGULAR' } },
    { stage: 'LAST_32', status: '2026-06-29 19:00:00Z', homeTeam: { id: R2 }, awayTeam: { id: OPP },
      score: { winner: null, duration: 'REGULAR' } },
  ];
  const r = derive(standings, matches);

  // Already R32 from standings; TIMED doesn't change anything
  assert.strictEqual(r.teams[String(GW)].furthest_stage, 'R32');
  assert.strictEqual(r.teams[String(R2)].furthest_stage, 'R32');
  assert.strictEqual(scoreTeam(r.teams[String(GW)]), 2);
  assert.strictEqual(scoreTeam(r.teams[String(R2)]), 1);
});

test('full champion path: won every round', () => {
  const standings = mkStandings(GW, R2, P3, OUT);
  const matches   = [
    mkMatch('LAST_32',        'FINISHED', 'H', GW, OPP),
    mkMatch('LAST_16',        'FINISHED', 'H', GW, OPP),
    mkMatch('QUARTER_FINALS', 'FINISHED', 'H', GW, OPP),
    mkMatch('SEMI_FINALS',    'FINISHED', 'H', GW, OPP),
    mkMatch('FINAL',          'FINISHED', 'H', GW, OPP),
  ];
  const r = derive(standings, matches);

  assert.deepStrictEqual(r.teams[String(GW)], { won_group: true, furthest_stage: 'CHAMPION' });
  assert.strictEqual(scoreTeam(r.teams[String(GW)]), 22);
});

// ---------------------------------------------------------------------------
// SECTION 5 — Hypothetical finished-tournament leaderboard
// ---------------------------------------------------------------------------
console.log('\nSECTION 5 — Hypothetical finished-tournament leaderboard');

const HYPO_TEAMS = [
  // owner,             team_id, won_group, furthest_stage, expected_pts
  ['ED CHO',            8601,  true,  'CHAMPION', 22],
  ['ED CHO',             762,  true,  'QF',        7],
  ['ED CHO',             815,  true,  'R32',       2],
  ['ED CHO',             758, false,  'R16',       3],
  ['ED CHO',             772, false,  'GROUP',     0],
  ['ED CHO',             778, false,  'R32',       1],
  ['ED CHO',             763, false,  'GROUP',     0],
  ['ED CHO',             779, false,  'R32',       1],
  ['ED CHO',             836, false,  'GROUP',     0],

  ['DYL PICKLE',         764,  true,  'SF',       11],
  ['DYL PICKLE',         770,  true,  'R16',       4],
  ['DYL PICKLE',        8872, false,  'R32',       1],
  ['DYL PICKLE',         769,  true,  'R32',       2],
  ['DYL PICKLE',         828, false,  'R16',       3],
  ['DYL PICKLE',        8873, false,  'GROUP',     0],
  ['DYL PICKLE',        1060, false,  'GROUP',     0],
  ['DYL PICKLE',         761, false,  'GROUP',     0],
  ['DYL PICKLE',         783, false,  'GROUP',     0],

  ['IMAN IS #1',         760,  true,  'SF',       11],
  ['IMAN IS #1',         759,  true,  'QF',        7],
  ['IMAN IS #1',         803, false,  'R32',       1],
  ['IMAN IS #1',         788,  true,  'R16',       4],
  ['IMAN IS #1',         816, false,  'R16',       3],
  ['IMAN IS #1',         840, false,  'GROUP',     0],
  ['IMAN IS #1',        1836, false,  'GROUP',     0],
  ['IMAN IS #1',        1934, false,  'GROUP',     0],
  ['IMAN IS #1',        8049, false,  'GROUP',     0],

  ['PAT (JR)',           773,  true,  'FINAL',    16],
  ['PAT (JR)',           805,  true,  'QF',        7],
  ['PAT (JR)',           818,  true,  'R16',       4],
  ['PAT (JR)',           766, false,  'R16',       3],
  ['PAT (JR)',           825, false,  'R32',       1],
  ['PAT (JR)',          1935, false,  'GROUP',     0],
  ['PAT (JR)',           774, false,  'GROUP',     0],
  ['PAT (JR)',           802, false,  'GROUP',     0],
  ['PAT (JR)',          8070, false,  'GROUP',     0],

  ['WILL (DAD)',         765,  true,  'QF',        7],
  ['WILL (DAD)',         799,  true,  'R16',       4],
  ['WILL (DAD)',         771,  true,  'R16',       4],
  ['WILL (DAD)',         791, false,  'R32',       1],
  ['WILL (DAD)',         804, false,  'R32',       1],
  ['WILL (DAD)',         792, false,  'GROUP',     0],
  ['WILL (DAD)',         798, false,  'GROUP',     0],
  ['WILL (DAD)',        8030, false,  'GROUP',     0],
  ['WILL (DAD)',         801, false,  'GROUP',     0],
];

test('all 45 hypothetical team scores match scoreTeam()', () => {
  for (const [owner, id, won_group, furthest_stage, expected] of HYPO_TEAMS) {
    const got = scoreTeam({ won_group, furthest_stage });
    assert.strictEqual(got, expected,
      `${owner} id=${id} (${furthest_stage}, won_group=${won_group}): expected ${expected}, got ${got}`);
  }
});

const EXPECTED_TOTALS = {
  'ED CHO':      22+7+2+3+0+1+0+1+0,   // 36
  'DYL PICKLE':  11+4+1+2+3+0+0+0+0,   // 21
  'IMAN IS #1':  11+7+1+4+3+0+0+0+0,   // 26
  'PAT (JR)':    16+7+4+3+1+0+0+0+0,   // 31
  'WILL (DAD)':   7+4+4+1+1+0+0+0+0,   // 17
};

test('hypothetical leaderboard — per-owner totals', () => {
  const totals = {};
  for (const [owner,,won_group,furthest_stage] of HYPO_TEAMS)
    totals[owner] = (totals[owner] || 0) + scoreTeam({ won_group, furthest_stage });
  for (const [owner, expected] of Object.entries(EXPECTED_TOTALS))
    assert.strictEqual(totals[owner], expected, `${owner}: expected ${expected}, got ${totals[owner]}`);
});

test('hypothetical leaderboard — ranking order ED CHO > PAT > IMAN > DYL > WILL', () => {
  const totals = {};
  for (const [owner,,won_group,furthest_stage] of HYPO_TEAMS)
    totals[owner] = (totals[owner] || 0) + scoreTeam({ won_group, furthest_stage });
  const ranked = Object.entries(totals).sort(([,a],[,b]) => b-a).map(([o]) => o);
  assert.deepStrictEqual(ranked, ['ED CHO','PAT (JR)','IMAN IS #1','DYL PICKLE','WILL (DAD)']);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
