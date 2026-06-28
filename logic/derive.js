// Mapping: API stage → the stage a team REACHES by winning that match.
// THIRD_PLACE is intentionally absent: a consolation win is inert.
const PROMOTE = {
  LAST_32:        'R16',
  LAST_16:        'QF',
  QUARTER_FINALS: 'SF',
  SEMI_FINALS:    'FINAL',
  FINAL:          'CHAMPION',
};

const STAGE_RANK = { GROUP: 0, R32: 1, R16: 2, QF: 3, SF: 4, FINAL: 5, CHAMPION: 6 };

// derive(standings, matches) → { last_updated, teams, _warnings? }
//
// standings : the `standings` array from GET /v4/competitions/WC/standings
// matches   : the `matches`   array from GET /v4/competitions/WC/matches
//
// Advancement sourced from FINAL GROUP STANDINGS — not from R32 bracket slots.
// Bracket slots lag; standings are authoritative the moment all games are played.
//
//   won_group    — position 1 in each group table
//   advanced     — position 1 or 2 always; position 3 if ranked in the top 8 of all
//                  third-place teams by: points desc, GD desc, GF desc
//   furthest_stage — starts at R32 for all advanced teams, then raised by PROMOTE-ON-WIN
//                    for each FINISHED KO match the team won
//
// Throws if there is an unresolvable tie at the 8th/9th third-place boundary.
// Returns { _warnings } if standings-derived advancers disagree with a fully-populated
// R32 bracket (inR32.size === 32); caller should treat this as an override candidate.
function derive(standings, matches) {
  // ── Step 1: advancement from group standings ──────────────────────────────
  const wonGroup  = new Set();
  const advanced  = new Set();   // will hold all 32 advancing team ids
  const thirdPlace = [];         // { id, points, goalDifference, goalsFor }

  for (const s of standings) {
    for (const row of s.table) {
      const id = row.team.id;
      if (row.position === 1) {
        wonGroup.add(id);
        advanced.add(id);
      } else if (row.position === 2) {
        advanced.add(id);
      } else if (row.position === 3) {
        thirdPlace.push({
          id,
          points:         row.points,
          goalDifference: row.goalDifference,
          goalsFor:       row.goalsFor,
        });
      }
      // position 4: not advanced
    }
  }

  // ── Step 2: rank 3rd-place teams; add top 8 ──────────────────────────────
  thirdPlace.sort((a, b) => {
    if (b.points !== a.points)         return b.points - a.points;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    return b.goalsFor - a.goalsFor;
  });

  // Flag an unresolvable tie at the critical 8th/9th boundary.
  if (thirdPlace.length >= 9) {
    const t8 = thirdPlace[7];
    const t9 = thirdPlace[8];
    if (t8.points === t9.points &&
        t8.goalDifference === t9.goalDifference &&
        t8.goalsFor === t9.goalsFor) {
      throw new Error(
        `STOP: tie at 8th/9th 3rd-place boundary ` +
        `(pts=${t8.points}, GD=${t8.goalDifference > 0 ? '+' : ''}${t8.goalDifference}, GF=${t8.goalsFor}) — ` +
        `team ${t8.id} and team ${t9.id} are indistinguishable; add a manual override`
      );
    }
  }

  for (const t of thirdPlace.slice(0, 8)) {
    advanced.add(t.id);
  }

  // ── Step 3: scan matches for KO promotions + bracket cross-check ──────────
  const inR32     = new Set();   // non-null team ids in LAST_32 fixtures
  const winStage  = {};          // teamId → best stage reached via a FINISHED win

  for (const m of matches) {
    if (m.stage === 'LAST_32') {
      if (m.homeTeam && m.homeTeam.id != null) inR32.add(m.homeTeam.id);
      if (m.awayTeam && m.awayTeam.id != null) inR32.add(m.awayTeam.id);
    }

    if (m.status !== 'FINISHED') continue;
    const promoted = PROMOTE[m.stage];
    if (!promoted) continue;   // GROUP_STAGE, THIRD_PLACE, …: skip

    const w = m.score.winner === 'HOME_TEAM' ? m.homeTeam : m.awayTeam;
    if (!w || w.id == null) continue;

    const id = w.id;
    if (!winStage[id] || STAGE_RANK[promoted] > STAGE_RANK[winStage[id]]) {
      winStage[id] = promoted;
    }
  }

  // ── Step 4: cross-check once bracket is fully populated (32 non-null slots)
  const warnings = [];
  if (inR32.size === 32) {
    for (const id of inR32) {
      if (!advanced.has(id))
        warnings.push(`BRACKET_MISMATCH: team ${id} in R32 bracket but not in standings-derived advancers — review for override`);
    }
    for (const id of advanced) {
      if (!inR32.has(id))
        warnings.push(`BRACKET_MISMATCH: team ${id} in standings-derived advancers but missing from R32 bracket — review for override`);
    }
  }

  // ── Step 5: compile results ───────────────────────────────────────────────
  const teams = {};
  for (const s of standings) {
    for (const row of s.table) {
      const id = row.team.id;

      let furthest_stage;
      if      (winStage[id])   furthest_stage = winStage[id];
      else if (advanced.has(id)) furthest_stage = 'R32';
      else                       furthest_stage = 'GROUP';

      teams[String(id)] = {
        won_group: wonGroup.has(id),
        furthest_stage,
      };
    }
  }

  return {
    last_updated: new Date().toISOString(),
    teams,
    ...(warnings.length > 0 && { _warnings: warnings }),
  };
}

if (typeof module !== 'undefined') module.exports = { derive, PROMOTE, STAGE_RANK };
