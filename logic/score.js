// furthest_stage ∈ GROUP | R32 | R16 | QF | SF | FINAL | CHAMPION
// Cumulative knockout points: each value is total KO wins to reach that stage.
const KNOCKOUT_POINTS = {
  GROUP: 0, R32: 0, R16: 2, QF: 5, SF: 9, FINAL: 14, CHAMPION: 20,
};

const STAGE_RANK = { GROUP: 0, R32: 1, R16: 2, QF: 3, SF: 4, FINAL: 5, CHAMPION: 6 };

// Group points are exclusive: a group winner gets 2, not 2+1.
function scoreTeam({ won_group, furthest_stage }) {
  const advanced = furthest_stage !== 'GROUP';
  const groupPts = won_group ? 2 : advanced ? 1 : 0;
  return groupPts + KNOCKOUT_POINTS[furthest_stage];
}

// Returns the ordered point rows that sum to scoreTeam().
// This is the canonical trail — both the displayed total and the expanded breakdown
// must come from here so they can't drift on a future rule change.
function buildTrail({ won_group, furthest_stage }) {
  const rank = STAGE_RANK[furthest_stage] ?? 0;
  const rows = [];
  if (rank === 0) {
    rows.push({ label: 'Eliminated in group stage', pts: 0 });
    return rows;
  }
  rows.push(won_group
    ? { label: 'Won group', pts: 2 }
    : { label: 'Advanced (runner-up / best 3rd)', pts: 1 });
  if (rank >= 2) rows.push({ label: 'Won R32 → Round of 16', pts: 2 });
  if (rank >= 3) rows.push({ label: 'Won R16 → Quarter-final', pts: 3 });
  if (rank >= 4) rows.push({ label: 'Won QF → Semi-final', pts: 4 });
  if (rank >= 5) rows.push({ label: 'Won SF → Final', pts: 5 });
  if (rank >= 6) rows.push({ label: 'Won Final', pts: 6 });
  return rows;
}

if (typeof module !== 'undefined') module.exports = { KNOCKOUT_POINTS, STAGE_RANK, scoreTeam, buildTrail };
