'use strict';

process.env.NODE_ENV = 'test';

const TimStreamsProvider = require('../src/providers/TimStreamsProvider');
const { isMatchLive } = require('../src/catalog');

function getNYString(offsetMs) {
  const target = new Date(Date.now() + offsetMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(target);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

describe('TimStreamsProvider Robust Date and Live Status Handling', () => {
  let provider;

  beforeEach(() => {
    provider = new TimStreamsProvider({
      circuitBreaker: {
        wrap: (name, fn) => ({ fire: fn }),
        wrapSync: (name, fn) => ({ fire: fn })
      }
    });
  });

  test('future event is classified as upcoming with popular=0 and is not live', async () => {
    const futureDate = getNYString(24 * 3600 * 1000); // Tomorrow in NY
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'liverpool-vs-villarreal-test',
            name: 'Liverpool vs Villarreal',
            genre: 'football',
            time: futureDate,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.id).toBe('ts_liverpool-vs-villarreal-test');
    expect(match.status).toBe('upcoming');
    expect(match.popular).toBe('0'); // Upcoming matches must never be popular=1
    expect(Number(match.date)).toBeGreaterThan(Date.now());
    expect(isMatchLive(match)).toBe(false); // Catalog must NOT treat it as live
  });

  test('live event within 4 hours is classified as live and respects featured for popularity', async () => {
    const liveDate = getNYString(-30 * 60 * 1000); // 30m ago in NY
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'live-derby',
            name: 'Live Derby Match',
            genre: 'football',
            time: liveDate,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.status).toBe('live');
    expect(match.popular).toBe('1');
    expect(isMatchLive(match)).toBe(true);
  });

  test('expired event older than 4 hours is dropped completely', async () => {
    const pastDate = getNYString(-6 * 3600 * 1000); // 6 hours ago in NY
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'old-match',
            name: 'Old Match Ended Hours Ago',
            genre: 'football',
            time: pastDate,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(0); // TimStreams must drop stale events
  });

  test('missing or unparseable time sets empty date and upcoming status without defaulting to Date.now()', async () => {
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'undated-fixture',
            name: 'Undated Fixture',
            genre: 'football',
            time: null,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.date).toBe(''); // Must not be Date.now()
    expect(match.status).toBe('upcoming');
    expect(match.popular).toBe('0');
    expect(isMatchLive(match)).toBe(false); // Catalog must not treat undated upcoming fixture as live
  });
});
