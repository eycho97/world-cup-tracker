#!/usr/bin/env node
// Cron update script: fetch live WC 2026 data → derive → write results.json → commit if changed.
// Usage:  FOOTBALL_DATA_API_KEY=<key> node scripts/update.js
'use strict';
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const { execSync } = require('child_process');
const { derive, STAGE_RANK } = require('../logic/derive.js');

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
if (!API_KEY) { console.error('Missing FOOTBALL_DATA_API_KEY env var'); process.exit(1); }

const ROOT    = path.join(__dirname, '..');
const OUT     = path.join(ROOT, 'results.json');
const OVR     = path.join(ROOT, 'overrides.json');
const BASE    = 'api.football-data.org';

// ── HTTP + throttle ───────────────────────────────────────────────────────────
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: BASE, path: urlPath, method: 'GET', headers: { 'X-Auth-Token': API_KEY } },
      (res) => {
        const remaining = parseInt(res.headers['x-requests-available-minute'] ?? '10', 10);
        const resetSecs  = parseInt(res.headers['x-requestcounter-reset'] ?? '60', 10);
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          resolve({ data: JSON.parse(body), remaining, resetSecs });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function throttledGet(urlPath, label) {
  const { data, remaining, resetSecs } = await get(urlPath);
  console.log(`  fetched ${label} — ${remaining} req/min remaining`);
  if (remaining <= 1) {
    console.log(`  rate limit near zero; sleeping ${resetSecs + 1}s`);
    await sleep((resetSecs + 1) * 1000);
  }
  return data;
}

// ── Phase (from match completion counts, never from max-team-stage) ───────────
const ROUND_ORDER = ['GROUP_STAGE', 'LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS', 'FINAL'];

const PHASE_IN_PROGRESS = {
  GROUP_STAGE:    'Group stage in progress',
  LAST_32:        'Round of 32 in progress',
  LAST_16:        'Round of 16 in progress',
  QUARTER_FINALS: 'Quarter-finals in progress',
  SEMI_FINALS:    'Semi-finals in progress',
  FINAL:          'Final in progress',
};

const PHASE_COMPLETE_NEXT = {
  GROUP_STAGE:    'Group stage final · Round of 32 in progress',
  LAST_32:        'Round of 32 complete · Round of 16 in progress',
  LAST_16:        'Round of 16 complete · Quarter-finals in progress',
  QUARTER_FINALS: 'Quarter-finals complete · Semi-finals in progress',
  SEMI_FINALS:    'Semi-finals complete · Final in progress',
};

function computePhase(matches) {
  const counts = {};
  for (const m of matches) {
    if (!ROUND_ORDER.includes(m.stage)) continue;   // skip THIRD_PLACE etc.
    if (!counts[m.stage]) counts[m.stage] = { total: 0, finished: 0 };
    counts[m.stage].total++;
    if (m.status === 'FINISHED') counts[m.stage].finished++;
  }

  for (let i = 0; i < ROUND_ORDER.length; i++) {
    const stage = ROUND_ORDER[i];
    const c     = counts[stage];

    if (!c || c.finished === 0) {
      // This stage hasn't started.  Describe the state from the previous stage.
      if (i === 0) return 'Group stage in progress';
      const prev = ROUND_ORDER[i - 1];
      const pc   = counts[prev];
      if (pc && pc.finished < pc.total) return PHASE_IN_PROGRESS[prev];
      return PHASE_COMPLETE_NEXT[prev] ?? 'Group stage in progress';
    }

    if (c.finished < c.total) return PHASE_IN_PROGRESS[stage];
    if (stage === 'FINAL') return 'Tournament complete';
    // stage fully finished → continue to next stage
  }
  return 'Tournament complete';
}

// ── Overrides ─────────────────────────────────────────────────────────────────
function getOverrides() {
  try { return JSON.parse(fs.readFileSync(OVR, 'utf8')); }
  catch { return { teams: {} }; }
}

function applyOverrides(derived, overrides) {
  const result = { ...derived, teams: { ...derived.teams } };
  for (const [id, ov] of Object.entries(overrides.teams || {})) {
    result.teams[id] = { ...(result.teams[id] ?? {}), ...ov };
  }
  return result;
}

// ── Smoke gate ────────────────────────────────────────────────────────────────
// Rejects implausible derived state; throws so the caller can exit non-zero.
function smokeGate(result, matches) {
  const teams = Object.values(result.teams);

  const gwCount = teams.filter(t => t.won_group).length;
  if (gwCount > 12)
    throw new Error(`SMOKE: ${gwCount} group winners (max 12)`);

  const advCount = teams.filter(t => t.furthest_stage !== 'GROUP').length;
  if (advCount > 32)
    throw new Error(`SMOKE: ${advCount} advanced teams (max 32)`);

  const champCount = teams.filter(t => t.furthest_stage === 'CHAMPION').length;
  if (champCount > 1)
    throw new Error(`SMOKE: ${champCount} champions (max 1)`);

  // No team should be deeper than the deepest stage reachable from FINISHED matches.
  // Baseline R32 covers the window between group stage completion and first KO kick-off.
  const PROMOTE_API = { LAST_32: 'R16', LAST_16: 'QF', QUARTER_FINALS: 'SF', SEMI_FINALS: 'FINAL', FINAL: 'CHAMPION' };
  const deepestReachable = matches
    .filter(m => m.status === 'FINISHED' && PROMOTE_API[m.stage])
    .reduce((max, m) => {
      const p = PROMOTE_API[m.stage];
      return STAGE_RANK[p] > STAGE_RANK[max] ? p : max;
    }, 'R32');

  const deepestActual = teams.reduce((max, t) => {
    return STAGE_RANK[t.furthest_stage] > STAGE_RANK[max] ? t.furthest_stage : max;
  }, 'GROUP');

  if (STAGE_RANK[deepestActual] > STAGE_RANK[deepestReachable])
    throw new Error(`SMOKE: team at ${deepestActual} but deepest reachable stage is ${deepestReachable}`);
}

// ── Content-equality (ignores last_updated) ───────────────────────────────────
function contentEquals(a, b) {
  if (!a) return false;
  return JSON.stringify({ ...a, last_updated: '' }) ===
         JSON.stringify({ ...b, last_updated: '' });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Fetching WC 2026 standings…');
  const sData = await throttledGet('/v4/competitions/WC/standings', 'standings');

  console.log('Fetching WC 2026 matches…');
  const mData = await throttledGet('/v4/competitions/WC/matches', 'matches');

  const standings = sData.standings;
  const matches   = mData.matches;

  console.log(`\nGroup tables : ${standings.length}`);
  console.log(`Total matches: ${matches.length}`);

  // ── Group-stage readiness check ────────────────────────────────────────────
  const groupMatches  = matches.filter(m => m.stage === 'GROUP_STAGE');
  const finishedGroup = groupMatches.filter(m => m.status === 'FINISHED');
  console.log(`Group stage  : ${finishedGroup.length}/${groupMatches.length} FINISHED`);

  if (finishedGroup.length !== 72) {
    console.log('Group stage not yet complete — no update written.');
    process.exit(0);   // Not ready; not an error.
  }

  const allPlayedGames3 = standings.every(s => s.table.every(r => r.playedGames === 3));
  if (!allPlayedGames3) {
    console.error('STOP: standings not final (playedGames !== 3 for some team)');
    process.exit(1);
  }
  console.log('Validation   : 72 FINISHED group matches ✓  all teams playedGames=3 ✓');

  // ── Derive ─────────────────────────────────────────────────────────────────
  const derived = derive(standings, matches);

  // ── Phase ──────────────────────────────────────────────────────────────────
  const phase = computePhase(matches);
  console.log(`Phase        : ${phase}`);

  // ── Assemble full result (phase at top level, overrides applied last) ───────
  const assembled = { ...derived, phase };

  const overrides = getOverrides();
  const final     = applyOverrides(assembled, overrides);

  // Re-stamp last_updated after overrides (so it reflects when update.js ran).
  final.last_updated = new Date().toISOString();

  // ── Smoke gate ─────────────────────────────────────────────────────────────
  console.log('\nRunning smoke gate…');
  smokeGate(final, matches);
  console.log('  Smoke gate passed ✓');

  // ── Skip if nothing meaningful changed ────────────────────────────────────
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}

  if (contentEquals(existing, final)) {
    console.log('\nNo meaningful changes — skipping write and commit.');
    process.exit(0);
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  fs.writeFileSync(OUT, JSON.stringify(final, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(`last_updated : ${final.last_updated}`);

  // Summary stats
  const gwCount  = Object.values(final.teams).filter(t => t.won_group).length;
  const advCount = Object.values(final.teams).filter(t => t.furthest_stage !== 'GROUP').length;
  const elimKO   = Object.values(final.teams).filter(t => t.eliminated && t.furthest_stage !== 'GROUP').length;
  console.log(`Group winners: ${gwCount}  Advanced: ${advCount}  Eliminated in KO: ${elimKO}`);
  if (final._mismatches?.length) console.log(`Mismatches   : ${final._mismatches.join(', ')}`);

  // ── Commit + push ──────────────────────────────────────────────────────────
  try {
    execSync('git add results.json', { cwd: ROOT, stdio: 'inherit' });
    execSync(
      `git commit -m "chore: update results ${final.last_updated}"`,
      { cwd: ROOT, stdio: 'inherit' }
    );
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    console.log('Committed and pushed.');
  } catch (e) {
    console.error('Git commit/push failed:', e.message);
    process.exit(1);
  }
})().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
