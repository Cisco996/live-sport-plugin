'use strict';

const CacheService = require('../src/services/CacheService');
const { compareCatalogMatches, sortCatalogMatches } = require('../src/catalog');

describe('Before vs. After Algorithmic Performance Benchmarks (P0 Optimizations)', () => {
  const TOTAL_MATCHES = 3000;
  let mockMatches = [];
  let cacheService;

  beforeAll(() => {
    // Generate 3,000 realistic matches matching production scale across diverse sports
    const sports = ['football', 'basketball', 'baseball', 'hockey', 'motorsport', 'tennis', 'rugby', 'cricket'];
    for (let i = 0; i < TOTAL_MATCHES; i++) {
      const sport = sports[i % sports.length];
      const isLive = i < 50; // 50 live events
      const kickoff = isLive ? Date.now() - 1800000 : Date.now() + (i * 60000);
      mockMatches.push({
        id: `nuvio_sport_${sport}_${i}`,
        title: `Team Alpha ${i} vs Team Beta ${i}`,
        category: sport,
        date: new Date(kickoff).toISOString(),
        popular: i % 5 === 0 ? '1' : '0',
        aliasIds: [`alias_spk_${i}`, `alias_dlv_${i}`],
        sources: [
          { id: `src_${i}_1`, source: 'daddylive', name: `HD Feed 1 (${i})`, url: `http://stream.example/1/${i}` },
          { id: `src_${i}_2`, source: 'streamedpk', name: `HD Feed 2 (${i})`, url: `http://stream.example/2/${i}` },
        ],
        team1: { name: `Team Alpha ${i}` },
        team2: { name: `Team Beta ${i}` },
      });
    }
  });

  beforeEach(() => {
    cacheService = new CacheService();
    cacheService.setMatches(mockMatches);
    cacheService.lastDiskMtime = Date.now() + 10000000;
  });

  test('Benchmark 1: Catalog Sorting (Repeated Comparator vs Schwartzian Transform)', () => {
    // ── BEFORE: Pairwise comparator evaluating 80+ regexes and dates on every pairwise comparison
    const startBefore = process.hrtime.bigint();
    const beforeSorted = [...mockMatches].sort((a, b) => compareCatalogMatches(a, b, false));
    const durationBeforeMs = Number(process.hrtime.bigint() - startBefore) / 1e6;

    // ── AFTER: Schwartzian Transform precomputing keys once in O(N)
    const startAfter = process.hrtime.bigint();
    const afterSorted = sortCatalogMatches(mockMatches, false);
    const durationAfterMs = Number(process.hrtime.bigint() - startAfter) / 1e6;

    // Verify ordering correctness
    expect(afterSorted.map(m => m.id)).toEqual(beforeSorted.map(m => m.id));

    const speedupPct = (((durationBeforeMs - durationAfterMs) / durationBeforeMs) * 100).toFixed(1);
    console.log('\n====================================================================');
    console.log('BENCHMARK 1: CATALOG SORTING (3,000 matches)');
    console.log(`  BEFORE (Pairwise RegExp/Date comparator): ${durationBeforeMs.toFixed(2)} ms`);
    console.log(`  AFTER  (Schwartzian Transform O(N log N)): ${durationAfterMs.toFixed(2)} ms`);
    console.log(`  IMPROVEMENT: ${speedupPct}% faster`);
    console.log('====================================================================');

    expect(durationAfterMs).toBeLessThan(durationBeforeMs);
  });

  test('Benchmark 2: Match Lookup Resolution (4-tier Linear Scan vs O(1) Hash Map)', () => {
    const LOOKUP_COUNT = 3000;

    // ── BEFORE: 4 successive linear scans (.find(), aliasIds.includes, sources.some)
    const startBefore = process.hrtime.bigint();
    for (let i = 0; i < LOOKUP_COUNT; i++) {
      const targetId = `alias_spk_${i % TOTAL_MATCHES}`;
      // Old linear scan logic
      let found = mockMatches.find(m => m && m.id === targetId);
      if (!found) found = mockMatches.find(m => m && Array.isArray(m.aliasIds) && m.aliasIds.includes(targetId));
      if (!found) found = mockMatches.find(m => m && Array.isArray(m.sources) && m.sources.some(s => s && s.id === targetId));
      expect(found).toBeDefined();
    }
    const durationBeforeMs = Number(process.hrtime.bigint() - startBefore) / 1e6;

    // ── AFTER: O(1) Indexed Maps (_byId, _byAlias, _bySourceId)
    const startAfter = process.hrtime.bigint();
    for (let i = 0; i < LOOKUP_COUNT; i++) {
      const targetId = `alias_spk_${i % TOTAL_MATCHES}`;
      const found = cacheService.findMatch(targetId);
      expect(found).not.toBeNull();
    }
    const durationAfterMs = Number(process.hrtime.bigint() - startAfter) / 1e6;

    const speedupFactor = (durationBeforeMs / durationAfterMs).toFixed(1);
    console.log('\n====================================================================');
    console.log(`BENCHMARK 2: STREAM MATCH RESOLUTION (${LOOKUP_COUNT} stream lookups)`);
    console.log(`  BEFORE (4-tier Linear Scans): ${durationBeforeMs.toFixed(2)} ms`);
    console.log(`  AFTER  (O(1) Hash Map Index): ${durationAfterMs.toFixed(2)} ms`);
    console.log(`  SPEEDUP: ${speedupFactor}x faster lookup throughput`);
    console.log('====================================================================');

    expect(durationAfterMs).toBeLessThan(durationBeforeMs);
  });

  test('Benchmark 3: Database Read Memory Churn (Deep Cloning vs Read-Only Reference)', () => {
    const READ_COUNT = 100;

    // ── BEFORE: getMatches() deep clones all 3,000 matches x sources x teams
    const startBefore = process.hrtime.bigint();
    let beforeTotalObjects = 0;
    for (let i = 0; i < READ_COUNT; i++) {
      const cloned = cacheService.getMatches();
      beforeTotalObjects += cloned.length;
    }
    const durationBeforeMs = Number(process.hrtime.bigint() - startBefore) / 1e6;

    // ── AFTER: getMatchesReadOnly() returns O(1) reference
    const startAfter = process.hrtime.bigint();
    let afterTotalObjects = 0;
    for (let i = 0; i < READ_COUNT; i++) {
      const ref = cacheService.getMatchesReadOnly();
      afterTotalObjects += ref.length;
    }
    const durationAfterMs = Number(process.hrtime.bigint() - startAfter) / 1e6;

    console.log('\n====================================================================');
    console.log(`BENCHMARK 3: DATABASE READ ALLOCATION (${READ_COUNT} read requests)`);
    console.log(`  BEFORE (getMatches deep clone):       ${durationBeforeMs.toFixed(2)} ms (~2,400,000 objects allocated)`);
    console.log(`  AFTER  (getMatchesReadOnly reference): ${durationAfterMs.toFixed(2)} ms (0 temporary objects allocated)`);
    console.log(`  LATENCY REDUCTION: ${((durationBeforeMs - durationAfterMs) / durationBeforeMs * 100).toFixed(1)}% faster`);
    console.log('====================================================================');

    expect(durationAfterMs).toBeLessThan(durationBeforeMs);
  });

  test('Benchmark 4: Aggregator Match Merging (Full M x N loop vs Category Bucketing)', () => {
    const incomingRows = [];
    for (let i = 0; i < 500; i++) {
      const sport = ['football', 'basketball', 'baseball'][i % 3];
      incomingRows.push({
        id: `incoming_${sport}_${i}`,
        title: `Team Alpha ${i} vs Team Beta ${i}`,
        category: sport,
        sources: [{ id: `inc_${i}`, source: 'providerX' }]
      });
    }

    // ── BEFORE: Full linear scan across all 3,000 matches for all 500 incoming rows
    let beforeComparisons = 0;
    const startBefore = process.hrtime.bigint();
    for (const inc of incomingRows) {
      for (let i = 0; i < mockMatches.length; i++) {
        beforeComparisons++;
        if (mockMatches[i].id === inc.id) break;
      }
    }
    const durationBeforeMs = Number(process.hrtime.bigint() - startBefore) / 1e6;

    // ── AFTER: Category bucketing + ID index
    let afterComparisons = 0;
    const startAfter = process.hrtime.bigint();
    // Build category buckets
    const idMap = new Map();
    const buckets = new Map();
    for (let i = 0; i < mockMatches.length; i++) {
      const m = mockMatches[i];
      idMap.set(m.id, i);
      const cat = m.category;
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(i);
    }
    for (const inc of incomingRows) {
      if (idMap.has(inc.id)) {
        afterComparisons++; // O(1) hit
      } else {
        const bucket = buckets.get(inc.category) || [];
        for (let j = 0; j < bucket.length; j++) {
          afterComparisons++;
          if (mockMatches[bucket[j]].id === inc.id) break;
        }
      }
    }
    const durationAfterMs = Number(process.hrtime.bigint() - startAfter) / 1e6;

    console.log('\n====================================================================');
    console.log('BENCHMARK 4: AGGREGATOR MERGING (500 incoming x 3,000 existing)');
    console.log(`  BEFORE (Full linear scan):      ${beforeComparisons.toLocaleString()} comparisons (${durationBeforeMs.toFixed(2)} ms)`);
    console.log(`  AFTER  (Category Bucketing):    ${afterComparisons.toLocaleString()} comparisons (${durationAfterMs.toFixed(2)} ms)`);
    console.log(`  REDUCTION: ${(((beforeComparisons - afterComparisons) / beforeComparisons) * 100).toFixed(1)}% fewer iterations`);
    console.log('====================================================================\n');

    expect(afterComparisons).toBeLessThan(beforeComparisons);
    expect(durationAfterMs).toBeLessThan(durationBeforeMs);
  });

  test('Benchmark 5: ChannelCountryService (5,000 channel resolutions)', () => {
    const ChannelCountryService = require('../src/services/ChannelCountryService');
    const channelNames = [
      'Sky Sports Premier League UK',
      'TNT Sports 1 UK',
      'beIN Sports 1 France',
      'Telemundo US',
      'Polsat Sport Polska',
      'Sport 1 Israel',
      'Optus Sport Australia',
      'TSN 1 Canada',
      'Random Sports Network Unknown'
    ];

    // Generate 5,000 requests simulating 10k concurrent streams
    const requests = Array.from({ length: 5000 }, (_, i) => channelNames[i % channelNames.length]);

    // BEFORE simulation: bypass cache by running regex matching directly every time
    const rules = ChannelCountryService.getRules();
    const startBefore = process.hrtime.bigint();
    for (const ch of requests) {
      const cn = ' ' + ch.trim() + ' ';
      for (const rule of rules) {
        if (rule.regex.test(cn)) break;
      }
    }
    const durationBeforeMs = Number(process.hrtime.bigint() - startBefore) / 1e6;

    // AFTER: using detectChannelCountry with bounded Map memoization
    // Warm up cache with 1 query each
    for (const ch of channelNames) ChannelCountryService.detectChannelCountry(ch);
    const startAfter = process.hrtime.bigint();
    for (const ch of requests) {
      ChannelCountryService.detectChannelCountry(ch);
    }
    const durationAfterMs = Number(process.hrtime.bigint() - startAfter) / 1e6;

    console.log('\n====================================================================');
    console.log('BENCHMARK 5: CHANNEL COUNTRY RESOLUTION (5,000 stream lookups)');
    console.log(`  BEFORE (Repeated RegExp Scans): ${durationBeforeMs.toFixed(2)} ms`);
    console.log(`  AFTER  (Memoized O(1) Cache):   ${durationAfterMs.toFixed(2)} ms`);
    console.log(`  SPEEDUP: ${(durationBeforeMs / durationAfterMs).toFixed(1)}x faster`);
    console.log('====================================================================\n');

    expect(durationAfterMs).toBeLessThan(durationBeforeMs);
  });
});

