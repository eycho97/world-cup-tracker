// furthest_stage ∈ GROUP | R32 | R16 | QF | SF | FINAL | CHAMPION
// Cumulative knockout points: each value is total KO wins to reach that stage.
const KNOCKOUT_POINTS = {
  GROUP: 0, R32: 0, R16: 2, QF: 5, SF: 9, FINAL: 14, CHAMPION: 20,
};

// Group points are exclusive: a group winner gets 2, not 2+1.
function scoreTeam({ won_group, furthest_stage }) {
  const advanced = furthest_stage !== 'GROUP';
  const groupPts = won_group ? 2 : advanced ? 1 : 0;
  return groupPts + KNOCKOUT_POINTS[furthest_stage];
}

if (typeof module !== 'undefined') module.exports = { KNOCKOUT_POINTS, scoreTeam };
