# World Cup 2026 Draft Tracker

Static leaderboard for a 5-person, winner-take-all WC 2026 draft. Auto-updates from a results API; no backend. This file is the locked spec — treat it as the source of truth. Phase-by-phase build instructions arrive separately as prompts; this captures only durable decisions.

**Pot:** 5 × $25 = $125, winner-take-all. Ties are surfaced by the app, never auto-resolved (settled socially).

## Working agreement
On any ambiguity that affects scoring, advancement, or who gets paid, STOP and ask — do not guess. This is a money board; a silent wrong result is worse than a paused build.

---

## Scoring (LOCKED)

Group points are **exclusive** (a group winner gets 2 and does NOT also get the advance point). Knockout points are **cumulative**.

| Event | Points |
|---|---|
| Win group (finish 1st) | 2 |
| Advance without winning group (runner-up OR top-8 third place) | 1 |
| Win R32 (reach R16) | 2 |
| Win R16 (reach QF) | 3 |
| Win QF (reach SF) | 4 |
| Win SF (reach Final) | 5 |
| Win Final (champion) | 6 |

No 3rd-place-game scoring. No provisional/projected standings (locked outcomes only).

```js
// furthest_stage ∈ GROUP | R32 | R16 | QF | SF | FINAL | CHAMPION
//   GROUP=out in groups · R32=advanced, lost first KO · R16..SF=won prior round, lost here
//   FINAL=lost the final (runner-up) · CHAMPION=won the final
const KNOCKOUT_POINTS = { GROUP:0, R32:0, R16:2, QF:5, SF:9, FINAL:14, CHAMPION:20 };
function scoreTeam({ won_group, furthest_stage }) {
  const advanced = furthest_stage !== "GROUP";
  const groupPts = won_group ? 2 : advanced ? 1 : 0;   // exclusive
  return groupPts + KNOCKOUT_POINTS[furthest_stage];   // group winner = 2, not 3
}
// Scoring lives in the FRONTEND, not the fetch. Cron writes raw {won_group, furthest_stage}.
```

---

## API — football-data.org (Phase 0 confirmed against live data)

- Competition: code `WC`, id `2000`. Free tier `TIER_ONE`. **Current 2026 season only** (historical WC seasons 403 on free tier).
- Base URL `https://api.football-data.org/v4`. Auth header `X-Auth-Token: <token>`.
- Rate limit 10 req/min. **Self-throttle** on response headers `X-Requests-Available-Minute` (remaining) and `X-RequestCounter-Reset` (seconds to reset).
- Endpoints: `GET /v4/competitions/WC/standings`, `GET /v4/competitions/WC/matches` (filter `?stage=LAST_32`).
- Stage enum → internal: `GROUP_STAGE`→GROUP, `LAST_32`→R32, `LAST_16`→R16, `QUARTER_FINALS`→QF, `SEMI_FINALS`→SF, `FINAL`→FINAL/CHAMPION, `THIRD_PLACE`→excluded.
- `score.winner` (`"HOME_TEAM"|"AWAY_TEAM"`) is authoritative for ALL outcomes incl. penalty shootouts. Ignore `fullTime` on shootouts (it mirrors the penalty score).
- **Whitelist** `status === "FINISHED"`. Treat everything else as unplayed — including a known malformed fixture where `status` is a datetime string, not the `TIMED` enum.

**Token is server-side only** — env var `FOOTBALL_DATA_API_KEY` (GitHub Actions secret for the cron, gitignored `.env` for local). Never in any client-side file or committed file.

---

## Derivation (cron → results.json)

1. **Validate before computing anything:** `stage=GROUP_STAGE` must return 72 matches, all FINISHED, and every team in `/standings` at `playedGames === 3`. If not, STOP and report — partial data corrupts every `won_group`.
2. **`won_group`:** position 1 in each of the 12 group tables.
3. **Advancement (from FINAL standings, NOT bracket participation — bracket lags):**
   - Position 1 or 2 → advanced.
   - Position 3 → advanced only if in the top 8 of all 12 third-place teams, ranked by **points desc, then goalDifference desc, then goalsFor desc**.
   - A tie spanning the 8th/9th third-place boundary → STOP and flag for manual override (fair-play/lots out of scope).
4. **`furthest_stage` — promote-on-FINISHED-win in the main bracket** (so THIRD_PLACE can never leak in): win in LAST_32→R16, LAST_16→QF, QUARTER_FINALS→SF, SEMI_FINALS→FINAL, FINAL→CHAMPION. A semifinal loser stays at SF whether or not they win the 3rd-place game.
5. **Cross-check:** once LAST_32 slots populate, the standings-derived advancer set must equal the bracket participant set. On mismatch, FLAG the affected team (override candidate) — never silently overwrite.
6. **Apply overrides last:** `final = applyOverrides(derived, overrides)`; `overrides.json` wins field-by-field.
7. **Smoke-test gate before commit:** reject implausible state (>12 group winners, >32 advanced, more than one CHAMPION once the final is played, any `furthest_stage` deeper than the deepest round actually played). Skip the update rather than push garbage. Commit only if changed.

---

## Data model — three JSON files

- **`teams.json`** (static, authored once): the 45 picks. Keyed on numeric **`team_id`** from `/v4/competitions/WC/teams`. Names are DISPLAY-ONLY. Entry: `{ owner, team_id, name }`.
- **`results.json`** (cron-written): `{ last_updated, teams: { <team_id>: { won_group, furthest_stage } } }`. Absent ⇒ GROUP / not won.
- **`overrides.json`** (manual seam, ships empty): same shape as `results.json.teams`; any present field wins. Adding a Notion-backed layer later = repoint `getOverrides()` at the Notion MCP DB; no frontend/schema change.

**Key on `team_id`, never on name.** Names can drift; ids don't. A silent name mismatch zeroes a team forever.

---

## Roster (45 picks; key on id at build)

```
ED CHO:     Netherlands, Argentina, Morocco, Uruguay, South Korea, Algeria, Ghana, Australia, Haiti
DYL PICKLE: Brazil, England, Norway, Mexico, Canada, Scotland, Bosnia-Herzegovina, Paraguay, New Zealand
IMAN IS #1: Spain, Germany, Turkey, Switzerland, Austria, Iran, Panama, Congo DR, Jordan
PAT (JR):   France, Belgium, Colombia, Japan, Egypt, Ivory Coast, South Africa, Tunisia, Uzbekistan
WILL (DAD): Portugal, Croatia, United States, Ecuador, Senegal, Sweden, Czechia, Qatar, Saudi Arabia
```

Name corrections vs the original draft sheet (the rest match the API `name` field exactly):
`Bosnia & Herzegovina`→`Bosnia-Herzegovina` · `Côte d'Ivoire`→`Ivory Coast` · `USA`→`United States` · `South Korea` (API `name` "South Korea", `shortName` "Korea Republic").

Undrafted (never score, never appear): Curaçao, Cape Verde Islands, Iraq.

Seeded board after group stage (use to sanity-check the pipeline): Dyl 10, Pat 10, Cho 8, Iman 8, Will 7.

---

## UI (LOCKED)

- **Stacked owner cards**, ranked by total desc (not a 5-column grid — must read well on mobile). Surface ties as ties; never break them.
- Each card: rank, owner name, total; below it all 9 teams as tiles. Eliminated teams still render (greyed).
- **Tile face = team name + current total + current round label**, e.g. `Brazil · QF · 6`. The full per-round trail (group → advanced → R16 → QF…) is revealed **on tap/expand**, never on the face.
- Required chrome: visible `last_updated`, a phase marker (e.g. "Group stage final · Round of 32 in progress"), and the cross-check flag surfaced on any disputed advancer (the best-3rd cutoff is the likeliest dispute).
- Static read of the three JSON files; scoring computed client-side; NO API calls and NO token reference in any client-side file.

---

## Architecture

`football-data.org` → GitHub Action (cron `*/15 * * * *`) runs the deterministic derive script → writes `results.json` (after `applyOverrides`) → static page on GitHub Pages reads `teams.json` + `results.json` + `overrides.json` and renders client-side. Manual override = edit `overrides.json`, push (git history = audit log). Board state changes ~6 times all tournament (groups close + 5 KO rounds), so "real-time" means within minutes of full-time.

## Out of scope
Notion override layer (deferred; seam built). 3rd-place-game scoring (`won_third_place` flag reserved, unused). Provisional/projected standings. Tiebreak logic (settled socially). Notifications.
