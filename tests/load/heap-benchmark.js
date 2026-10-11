/**
 * tests/load/heap-benchmark.js
 *
 * Measures heap allocation churn for:
 *  - getMatches() deep clone (3,000 matches × 100 reads)
 *  - getMatchesReadOnly() zero-clone (3,000 matches × 100 reads)
 *  - sortCatalogMatches() Schwartzian vs pairwise on 3,000 items
 *  - StreamResolveCache LRU thrash (500 entries, cap 200)
 *
 * Run with: node --expose-gc tests/load/heap-benchmark.js
 */

'use strict';

const hp = require('./heap-profiler');
const CacheService = require('../../src/services/CacheService');
const { sortCatalogMatches, compareCatalogMatches } = require('../../src/catalog');
const StreamResolveCache = require('../../src/services/StreamResolveCache');

async function runHeapBenchmark() {
  const TOTAL_MATCHES = parseInt(process.env.BENCH_SCALE || '3000', 10);

  // Build realistic matches
  const sports = ['football', 'basketball', 'baseball', 'hockey'];
  const matches = Array.from({ length: TOTAL_MATCHES }, (_, i) => ({
    id: `nuvio_sport_${sports[i % sports.length]}_${i}`,
    title: `Team A${i} vs Team B${i}`,
    category: sports[i % sports.length],
    date: new Date(Date.now() + i * 60000).toISOString(),
    popular: String(i % 5 === 0 ? 1 : 0),
    aliasIds: [`alias_${i}_1`, `alias_${i}_2`],
    sources: [
      { id: `stream_${i}_1`, source: 'daddylive', name: `HD Feed 1 (${i})`, url: `http://stream.example/1/${i}` },
      { id: `stream_${i}_2`, source: 'streamedpk', name: `HD Feed 2 (${i})`, url: `http://stream.example/2/${i}` },
    ],
    team1: { name: `Team A${i}`, crest: null },
    team2: { name: `Team B${i}`, crest: null },
  }));

  const cache = new CacheService();
  cache.setMatches(matches);
  cache.lastDiskMtime = Date.now() + 10000000;

  hp.reset();
  hp.snapshot('Baseline (Initial Loaded State)');

  // ── Test 1: getMatches() deep clone churn ──
  hp.snapshot('Before getMatches() deep-clone x100');
  for (let i = 0; i < 100; i++) {
    const list = cache.getMatches();
    if (list.length !== TOTAL_MATCHES) throw new Error('Mismatch');
  }
  hp.snapshot('After getMatches() deep-clone x100');

  // ── Test 2: getMatchesReadOnly() zero-clone ──
  hp.snapshot('Before getMatchesReadOnly() reference x100');
  for (let i = 0; i < 100; i++) {
    const list = typeof cache.getMatchesReadOnly === 'function' ? cache.getMatchesReadOnly() : cache.getMatches();
    if (list.length !== TOTAL_MATCHES) throw new Error('Mismatch');
  }
  hp.snapshot('After getMatchesReadOnly() reference x100');

  // ── Test 3: sortCatalogMatches() Schwartzian ──
  const shuffled = [...matches].sort(() => Math.random() - 0.5);
  hp.snapshot('Before sortCatalogMatches() Schwartzian x10');
  for (let i = 0; i < 10; i++) {
    const sorted = sortCatalogMatches([...shuffled]);
    if (sorted.length !== TOTAL_MATCHES) throw new Error('Mismatch');
  }
  hp.snapshot('After sortCatalogMatches() Schwartzian x10');

  // ── Test 4: Pairwise sort simulation ──
  hp.snapshot('Before pairwise sort simulation x10');
  for (let i = 0; i < 10; i++) {
    const sorted = [...shuffled].sort((a, b) => compareCatalogMatches(a, b, false));
    if (sorted.length !== TOTAL_MATCHES) throw new Error('Mismatch');
  }
  hp.snapshot('After pairwise sort simulation x10');

  // ── Test 5: StreamResolveCache LRU churn (500 entries, cap 200) ──
  const streamCache = new StreamResolveCache({ maxEntries: 200, defaultTtlMs: 5000, negativeTtlMs: 1000 });
  hp.snapshot('Before StreamResolveCache insertions (500 entries, cap 200)');
  for (let i = 0; i < 500; i++) {
    await streamCache.getOrCreate(`source_${i}:match_${i}`, async () => [
      { title: `Stream ${i}`, url: `http://test/${i}.m3u8` }
    ]);
  }
  hp.snapshot('After StreamResolveCache insertions (500 entries, cap 200)');

  hp.printReport();

  if (process.send) {
    process.send(hp.toJSON());
  }
  return hp.toJSON();
}

if (require.main === module) {
  runHeapBenchmark().catch((err) => {
    console.error('Heap benchmark failed:', err);
    process.exit(1);
  });
}

module.exports = { runHeapBenchmark };
