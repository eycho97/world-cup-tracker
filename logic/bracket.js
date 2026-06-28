'use strict';

// buildBracket(skeleton, matches) → { slots, _mismatches }
//
// skeleton  : parsed bracket-skeleton.json
// matches   : the `matches` array from GET /v4/competitions/WC/matches (all stages)
//
// Algorithm:
//   1. Build a lookup: team_id pair (sorted) → API match object, per API stage.
//   2. Walk slots in pos order within each round (R32 → R16 → QF → SF → Final).
//   3. R32 slots: home/away fixed from skeleton. Guardrail: assert the API
//      has a LAST_32 match with exactly those two teams.
//   4. R16+ slots: occupants = winners of feeder slots (null = TBD).
//   5. Winner: once a slot has known occupants and the API match is FINISHED,
//      take score.winner.  Whitelist status==="FINISHED" only.
//
// Returns per-slot: { home_id, away_id, winner_id }  (any may be null)
// _mismatches: array of human-readable strings flagging guardrail failures.

const API_STAGE = {
  R32:   'LAST_32',
  R16:   'LAST_16',
  QF:    'QUARTER_FINALS',
  SF:    'SEMI_FINALS',
  FINAL: 'FINAL',
};

function buildBracket(skeleton, matches) {
  // ── Index API matches by sorted team-id pair, within each API stage ──────
  // key = `${minId},${maxId}` within a stage
  const matchByStageAndPair = {};   // { [apiStage]: { [pairKey]: apiMatch } }

  for (const m of matches) {
    const stage = m.stage;
    if (!API_STAGE[stageFromApi(stage)]) continue;   // skip GROUP_STAGE, THIRD_PLACE
    if (!m.homeTeam?.id || !m.awayTeam?.id) continue; // null slots not yet assigned

    const key = pairKey(m.homeTeam.id, m.awayTeam.id);
    if (!matchByStageAndPair[stage]) matchByStageAndPair[stage] = {};
    matchByStageAndPair[stage][key] = m;
  }

  function findApiMatch(round, idA, idB) {
    const apiStage = API_STAGE[round];
    return matchByStageAndPair[apiStage]?.[pairKey(idA, idB)] ?? null;
  }

  // ── Walk slots ────────────────────────────────────────────────────────────
  const slotWinner = {};   // slotId → winning team_id (filled as we walk)
  const slots      = {};
  const mismatches = [];

  // Process in round order: R32 → R16 → QF → SF → FINAL
  const roundOrder = ['R32', 'R16', 'QF', 'SF', 'FINAL'];

  for (const round of roundOrder) {
    // Collect slots in this round, sorted by pos
    const roundSlots = Object.values(skeleton.slots)
      .filter(s => s.round === round)
      .sort((a, b) => a.pos - b.pos);

    for (const sk of roundSlots) {
      const id = String(sk.match);
      let home_id, away_id;

      if (round === 'R32') {
        // Fixed from skeleton
        home_id = sk.home_id;
        away_id = sk.away_id;

        // ── Guardrail: confirm API has a LAST_32 match with these two teams ─
        const apiMatch = findApiMatch('R32', home_id, away_id);
        if (!apiMatch) {
          mismatches.push(
            `R32 slot ${id}: no LAST_32 API match found for teams ${home_id}/${away_id} — skeleton may be wrong`
          );
        }
        // (If found, the pair matches by construction since we looked up by pair)
      } else {
        // Occupants derived from feeder slot winners
        home_id = slotWinner[sk.fed_by[0]] ?? null;
        away_id = slotWinner[sk.fed_by[1]] ?? null;
      }

      // ── Find winner ───────────────────────────────────────────────────────
      let winner_id = null;
      if (home_id != null && away_id != null) {
        const apiMatch = findApiMatch(round, home_id, away_id);
        if (apiMatch && apiMatch.status === 'FINISHED') {
          const w = apiMatch.score.winner;
          if (w === 'HOME_TEAM') winner_id = apiMatch.homeTeam.id;
          else if (w === 'AWAY_TEAM') winner_id = apiMatch.awayTeam.id;
        }
      }

      if (winner_id != null) slotWinner[id] = winner_id;

      slots[id] = { home_id, away_id, winner_id };
    }
  }

  return {
    last_updated: new Date().toISOString(),
    slots,
    ...(mismatches.length > 0 && { _mismatches: mismatches }),
  };
}

function pairKey(a, b) {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

// Map our round names back from API stage strings (inverse of API_STAGE)
const API_STAGE_INV = {};
for (const [r, s] of Object.entries(API_STAGE)) API_STAGE_INV[s] = r;

function stageFromApi(apiStage) {
  return API_STAGE_INV[apiStage] ?? null;
}

module.exports = { buildBracket };
