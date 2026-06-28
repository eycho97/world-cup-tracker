#!/usr/bin/env node
// One-shot seed: fetch live WC 2026 data → derive → write results.json
// Usage:  FOOTBALL_DATA_API_KEY=<key> node scripts/seed.js
'use strict';
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { derive } = require('../logic/derive.js');

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
if (!API_KEY) { console.error('Missing FOOTBALL_DATA_API_KEY env var'); process.exit(1); }

const BASE = 'api.football-data.org';

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BASE, path: urlPath, method: 'GET',
      headers: { 'X-Auth-Token': API_KEY },
    };
    const req = https.request(opts, (res) => {
      const remaining = parseInt(res.headers['x-requests-available-minute'] ?? '10', 10);
      const resetSecs  = parseInt(res.headers['x-requestcounter-reset'] ?? '60', 10);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        resolve({ data: JSON.parse(body), remaining, resetSecs });
      });
    });
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

(async () => {
  console.log('Fetching WC 2026 standings…');
  const sData = await throttledGet('/v4/competitions/WC/standings', 'standings');

  console.log('Fetching WC 2026 matches…');
  const mData = await throttledGet('/v4/competitions/WC/matches', 'matches');

  const standings = sData.standings;
  const matches   = mData.matches;

  console.log(`\nGroup tables : ${standings.length}`);
  console.log(`Total matches: ${matches.length}`);

  const groupMatches    = matches.filter(m => m.stage === 'GROUP_STAGE');
  const finishedGroup   = groupMatches.filter(m => m.status === 'FINISHED');
  console.log(`Group stage  : ${finishedGroup.length}/${groupMatches.length} FINISHED`);
  if (finishedGroup.length !== 72) {
    console.error(`STOP: expected 72 finished group matches, got ${finishedGroup.length}`);
    process.exit(1);
  }

  const allPlayedGames3 = standings.every(s => s.table.every(row => row.playedGames === 3));
  if (!allPlayedGames3) {
    console.error('STOP: not all teams show playedGames === 3 in standings');
    process.exit(1);
  }
  console.log('Validation   : 72 FINISHED group matches ✓  all teams playedGames=3 ✓');

  const result = derive(standings, matches);

  // Print group winner summary
  const groupWinners = Object.entries(result.teams)
    .filter(([, v]) => v.won_group)
    .map(([id]) => id);
  console.log(`\nGroup winners (${groupWinners.length}): ${groupWinners.join(', ')}`);

  const advanced = Object.entries(result.teams)
    .filter(([, v]) => v.furthest_stage !== 'GROUP');
  console.log(`Advanced to R32 (${advanced.length}): ${advanced.map(([id]) => id).join(', ')}`);

  const outPath = path.join(__dirname, '..', 'results.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`last_updated: ${result.last_updated}`);
})().catch(e => { console.error(e); process.exit(1); });
