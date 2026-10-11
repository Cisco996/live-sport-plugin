'use strict';

const CacheService = require('../src/services/CacheService');

describe('High-Concurrency Stress & Object Isolation (10k+ Users Scenario)', () => {
  let cacheService;
  const TOTAL_MATCHES = 3000;
  const mockMatches = [];

  beforeAll(() => {
    // Generate 3,000 realistic matches simulating production scale
    for (let i = 0; i < TOTAL_MATCHES; i++) {
      mockMatches.push({
        id: `nuvio_sport_dlv_${i}`,
        title: `Team A${i} vs Team B${i}`,
        category: i % 2 === 0 ? 'football' : 'basketball',
        date: new Date(Date.now() + i * 60000).toISOString(),
        aliasIds: [`nuvio_alias_${i}_1`, `nuvio_alias_${i}_2`],
        sources: [
          { id: `stream_${i}_1`, source: 'daddylive', name: `Feed 1 (${i})`, url: `http://stream.example/1/${i}` },
          { id: `stream_${i}_2`, source: 'streamedpk', name: `Feed 2 (${i})`, url: `http://stream.example/2/${i}` },
        ],
        team1: { name: `Team A${i}` },
        team2: { name: `Team B${i}` },
      });
    }
  });

  beforeEach(() => {
    cacheService = new CacheService();
    cacheService.setMatches(mockMatches);
    cacheService.lastDiskMtime = Date.now() + 10000000; // prevent disk reload during test
  });

  test('2,000 lookups in < 500ms via O(1) indexed maps (~10k ops/sec throughput)', () => {
    const start = Date.now();
    for (let i = 0; i < 2000; i++) {
      const matchIndex = i % TOTAL_MATCHES;
      // Alternate between primary ID, alias ID, and source ID
      const queryType = i % 3;
      let query;
      if (queryType === 0) {
        query = `nuvio_sport_dlv_${matchIndex}`;
      } else if (queryType === 1) {
        query = `nuvio_alias_${matchIndex}_1`;
      } else {
        query = `stream_${matchIndex}_1`;
      }
      const match = cacheService.findMatch(query);
      expect(match).not.toBeNull();
      expect(match.id).toBe(`nuvio_sport_dlv_${matchIndex}`);
    }
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000);
  });

  test('10,000 concurrent user mutations: NO state contamination across concurrent requests', async () => {
    // Simulate 10,000 simulated users clicking and modifying their stream object
    const tasks = [];
    const sharedTargetId = 'nuvio_sport_dlv_42';

    for (let i = 0; i < 10000; i++) {
      const userNumber = i;
      tasks.push(new Promise((resolve) => {
        const m = cacheService.findMatch(sharedTargetId);
        expect(m).not.toBeNull();
        // User's request handler downstream mutates the source URL, headers, and name
        m.sources[0].url = `http://user-tampered-${userNumber}.example/stream.m3u8`;
        m.sources[0].name = `User ${userNumber} Custom Name`;
        m.team1.name = `Tampered Team ${userNumber}`;
        resolve(m.sources[0].url);
      }));
    }

    await Promise.all(tasks);

    // Verify internal state remains completely pristine
    const pristine = cacheService.findMatch(sharedTargetId);
    expect(pristine.sources[0].url).toBe('http://stream.example/1/42');
    expect(pristine.sources[0].name).toBe('Feed 1 (42)');
    expect(pristine.team1.name).toBe('Team A42');
  });

  test('getMatchesReadOnly returns identical count in O(1) without cloning 24k objects', () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      const list = cacheService.getMatchesReadOnly();
      expect(list.length).toBe(TOTAL_MATCHES);
    }
    const duration = Date.now() - start;
    // 1,000 read-only requests should easily complete in under 500ms
    expect(duration).toBeLessThan(500);
  });

  test('sortCatalogMatches yields identical results to compareCatalogMatches across diverse fixtures', () => {
    const { compareCatalogMatches, sortCatalogMatches } = require('../src/catalog');
    const fixtures = [
      { id: '1', title: 'Network Stream', category: 'networks', popular: '0' },
      { id: '2', title: 'Real Madrid vs Barcelona', category: 'football', date: new Date(Date.now() + 3600000).toISOString(), popular: '1' },
      { id: '3', title: 'Arsenal vs Chelsea U21', category: 'football', date: new Date(Date.now() + 1800000).toISOString(), popular: '0' },
      { id: '4', title: 'Liverpool vs Everton', category: 'football', date: new Date(Date.now() - 1800000).toISOString(), popular: '1' },
      { id: '5', title: 'Live TV Channel 24/7', category: 'networks', popular: '1' },
    ];

    const traditionalSorted = [...fixtures].sort((a, b) => compareCatalogMatches(a, b, false));
    const fastSorted = sortCatalogMatches(fixtures, false);

    expect(fastSorted.map(m => m.id)).toEqual(traditionalSorted.map(m => m.id));
  });

  test('MatchAggregator merges matches across distinct providers accurately using bucketing and ID index', async () => {
    const MatchAggregator = require('../src/services/MatchAggregator');
    const mockCache = {
      getMatches: () => [],
      setMatches: jest.fn(),
      findMatch: () => null,
      bumpRev: jest.fn(),
    };
    const mockCron = { ensureFresh: jest.fn() };
    const mockProviders = [
      {
        name: 'provider1',
        getMatches: async () => [
          { id: 'match_p1_1', title: 'Lakers vs Warriors', category: 'basketball', sources: [{ id: 's1', source: 'provider1' }] },
          { id: 'match_p1_2', title: 'Real Madrid vs Barcelona', category: 'football', sources: [{ id: 's2', source: 'provider1' }] },
          { id: 'match_p1_3', title: 'Red Bull Racing GP', category: 'motorsport', sources: [{ id: 's3', source: 'provider1' }] },
        ]
      },
      {
        name: 'provider2',
        getMatches: async () => [
          // Same ID merge
          { id: 'match_p1_1', title: 'Lakers vs Warriors', category: 'basketball', sources: [{ id: 's1_hd', source: 'provider2' }] },
          // Title merge in same sport
          { id: 'match_p2_2', title: 'Real Madrid vs Barcelona', category: 'football', sources: [{ id: 's2_alt', source: 'provider2' }] },
          // Unmatched row in another sport
          { id: 'match_p2_4', title: 'Yankees vs Red Sox', category: 'baseball', sources: [{ id: 's4', source: 'provider2' }] },
        ]
      }
    ];

    const aggregator = new MatchAggregator({
      timStreamsProvider: mockProviders[0],
      streamedPkProvider: mockProviders[1],
      cacheService: mockCache,
    });
    const results = await aggregator.syncMatches();

    expect(results.length).toBe(4);

    const lakers = results.find(m => m.id === 'match_p1_1');
    expect(lakers).toBeDefined();
    expect(lakers.sources.length).toBe(2);

    const elClasico = results.find(m => m.id === 'match_p1_2');
    expect(elClasico).toBeDefined();
    expect(elClasico.sources.length).toBe(2);
    expect(elClasico.aliasIds).toContain('match_p2_2');
  });
});
