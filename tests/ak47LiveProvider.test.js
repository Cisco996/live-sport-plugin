'use strict';

process.env.NODE_ENV = 'test';

const Ak47LiveProvider = require('../src/providers/Ak47LiveProvider');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const container = require('../src/container');

describe('Ak47LiveProvider Unit & Integration Tests', () => {
  let provider;

  beforeEach(() => {
    provider = new Ak47LiveProvider({ cacheTtlMs: 5000 });
  });

  describe('Strict Zero-DASH Enforcement & M3U Parser', () => {
    test('parses valid HLS streams and captures #EXTVLCOPT headers', () => {
      const sampleM3u = `
#EXTM3U
#EXTVLCOPT:http-referrer=http://www.fawanews.sc/
#EXTVLCOPT:http-origin=http://www.fawanews.sc
#EXTVLCOPT:http-user-agent=CustomUA/1.0
#EXTINF:-1 tvg-id="" tvg-name="Boxing : Fundora vs Hadribeaj --- CH 1" tvg-logo="https://example.com/logo.png" group-title="Boxing",Boxing : Fundora vs Hadribeaj --- CH 1
http://193.47.62.100:8080/live/stream1/playlist.m3u8
      `;

      const entries = provider._parseM3u(sampleM3u);
      expect(entries.length).toBe(1);
      expect(entries[0]).toEqual({
        rawTitle: 'Boxing : Fundora vs Hadribeaj --- CH 1',
        groupTitle: 'Boxing',
        tvgLogo: 'https://example.com/logo.png',
        streamUrl: 'http://193.47.62.100:8080/live/stream1/playlist.m3u8',
        referer: 'http://www.fawanews.sc/',
        origin: 'http://www.fawanews.sc',
        userAgent: 'CustomUA/1.0'
      });
    });

    test('strictly drops MPEG-DASH (.mpd) and DRM-encrypted (cenc) manifests', () => {
      const mixedM3u = `
#EXTM3U
#EXTINF:-1 tvg-name="TNT SPORTS 1" group-title="Broadcast",TNT SPORTS 1
https://otte.cache.aiv-cdn.net/cenc/live/channel.mpd
#EXTINF:-1 tvg-name="Sky Sports Main Event" group-title="Broadcast",Sky Sports Main Event
https://edge-node.net/dash/live/manifest.mpd?token=xyz
#EXTINF:-1 tvg-name="Valid HLS Stream" group-title="Football",Valid HLS Stream
http://193.47.62.200:8080/live/valid/index.m3u8
#EXTINF:-1 tvg-name="Another DASH Stream" group-title="Sports",Another DASH Stream
http://example.com/cenc/stream.m3u8
      `;

      const entries = provider._parseM3u(mixedM3u);
      expect(entries.length).toBe(1);
      expect(entries[0].rawTitle).toBe('Valid HLS Stream');
      expect(entries[0].streamUrl).toBe('http://193.47.62.200:8080/live/valid/index.m3u8');
    });

    test('ignores non-HTTP schemes and empty/malformed lines', () => {
      const badM3u = `
#EXTM3U
#EXTINF:-1,Invalid Scheme
rtmp://live.stream/live
#EXTINF:-1,File Path
file:///etc/passwd
#EXTINF:-1,No URL
      `;
      const entries = provider._parseM3u(badM3u);
      expect(entries.length).toBe(0);
    });
  });

  describe('Match Info Extraction & Category Normalization', () => {
    test('extracts clean title, channel label, teams, and normalized category', () => {
      const info = provider._extractMatchInfo(
        'Boxing : Fundora vs Hadribeaj --- CH 1',
        'Boxing'
      );

      expect(info.title).toBe('Fundora vs Hadribeaj');
      expect(info.channelLabel).toBe('CH 1');
      expect(info.team1).toBe('Fundora');
      expect(info.team2).toBe('Hadribeaj');
      expect(info.category).toBe('mma');
    });

    test('handles Server numbers and alternate separators', () => {
      const info = provider._extractMatchInfo(
        'Arsenal vs Chelsea - Server 2',
        'Australia A-League'
      );

      expect(info.title).toBe('Arsenal vs Chelsea');
      expect(info.channelLabel).toBe('Server 2');
      expect(info.team1).toBe('Arsenal');
      expect(info.team2).toBe('Chelsea');
      expect(info.category).toBe('football');
    });

    test('maps Basketball leagues to basketball category', () => {
      const info = provider._extractMatchInfo(
        'Sydney Kings vs Melbourne United --- CH 2',
        'Basketball NBL'
      );

      expect(info.title).toBe('Sydney Kings vs Melbourne United');
      expect(info.channelLabel).toBe('CH 2');
      expect(info.team1).toBe('Sydney Kings');
      expect(info.team2).toBe('Melbourne United');
      expect(info.category).toBe('basketball');
    });
  });

  describe('Multi-Channel Mirror Grouping & Ingest', () => {
    test('aggregates multi-channel mirrors under a single MatchEntity card', async () => {
      const mockFeed = `
#EXTM3U
#EXTINF:-1 tvg-name="Boxing : Fundora vs Hadribeaj --- CH 1" group-title="Boxing",Boxing : Fundora vs Hadribeaj --- CH 1
http://193.47.62.1:8080/live/ch1.m3u8
#EXTINF:-1 tvg-name="Boxing : Fundora vs Hadribeaj --- CH 2" group-title="Boxing",Boxing : Fundora vs Hadribeaj --- CH 2
http://193.47.62.2:8080/live/ch2.m3u8
      `;

      jest.spyOn(provider, 'proxyFetch').mockImplementation(async () => ({
        status: 200,
        text: async () => mockFeed
      }));

      const matches = await provider.getMatches();
      expect(matches.length).toBe(1);

      const match = matches[0];
      expect(match).toBeInstanceOf(MatchEntity);
      expect(match.title).toBe('Fundora vs Hadribeaj');
      expect(match.category).toBe('mma');
      expect(match.sources.length).toBe(2);
      expect(match.sources[0].channelName).toBe('CH 1');
      expect(match.sources[0].id).toBe('http://193.47.62.1:8080/live/ch1.m3u8');
      expect(match.sources[1].channelName).toBe('CH 2');
      expect(match.sources[1].id).toBe('http://193.47.62.2:8080/live/ch2.m3u8');
    });

    test('serves subsequent requests from cache within TTL', async () => {
      const mockFeed = `
#EXTM3U
#EXTINF:-1 group-title="Football",Team A vs Team B --- CH 1
http://193.47.62.1:8080/live/game.m3u8
      `;

      const spy = jest.spyOn(provider, 'proxyFetch').mockResolvedValue({
        status: 200,
        text: async () => mockFeed
      });

      const first = await provider.getMatches();
      const second = await provider.getMatches();

      expect(first).toBe(second); // same object reference
      expect(spy).toHaveBeenCalledTimes(2); // 2 playlist feeds fetched on initial call
    });

    test('handles upstream feed fetch failure gracefully', async () => {
      jest.spyOn(provider, 'proxyFetch').mockRejectedValue(new Error('Network timeout'));

      const matches = await provider.getMatches();
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBe(0);
    });
  });

  describe('resolveStream & Proxy Headers Decoration', () => {
    test('resolves stream with /api/manifest proxy and request headers', async () => {
      const src = {
        id: 'http://193.47.62.50:8080/live/stream.m3u8',
        channelName: 'CH 1',
        referer: 'http://www.fawanews.sc/',
        origin: 'http://www.fawanews.sc',
        userAgent: 'CustomUA/2.0'
      };

      const resolved = await provider.resolveStream(src.id, 'mma', 'Fundora vs Hadribeaj', src);
      expect(resolved.length).toBe(1);

      const stream = resolved[0];
      expect(stream).toBeInstanceOf(StreamEntity);
      expect(stream.name).toBe('Ak47Live');
      expect(stream.title).toContain('[CH 1]');
      expect(stream.title).toContain('Fundora vs Hadribeaj');
      expect(stream.url).toContain('/api/manifest?url=http%3A%2F%2F193.47.62.50%3A8080%2Flive%2Fstream.m3u8');
      expect(stream.behaviorHints.notWebReady).toBe(true);
      expect(stream.behaviorHints.proxyHeaders.request['Referer']).toBe('http://www.fawanews.sc/');
      expect(stream.behaviorHints.proxyHeaders.request['Origin']).toBe('http://www.fawanews.sc');
      expect(stream.behaviorHints.proxyHeaders.request['User-Agent']).toBe('CustomUA/2.0');
    });

    test('strictly drops DASH URLs passed to resolveStream', async () => {
      const dashSrc = {
        id: 'https://otte.cache.aiv-cdn.net/cenc/live/channel.mpd',
        channelName: 'TNT SPORTS 1'
      };

      const resolved = await provider.resolveStream(dashSrc.id, 'football', 'Match', dashSrc);
      expect(resolved).toEqual([]);
    });

    test('returns empty array for invalid stream URLs', async () => {
      const resolved = await provider.resolveStream('', 'football', 'Match');
      expect(resolved).toEqual([]);
    });
  });

  describe('Container & System Integration', () => {
    test('ak47LiveProvider is registered as singleton in container', () => {
      const resolved = container.resolve('ak47LiveProvider');
      expect(resolved).toBeInstanceOf(Ak47LiveProvider);
    });

    test('MatchAggregator includes ak47LiveProvider in providers list', () => {
      const aggregator = container.resolve('matchAggregator');
      const hasAk47 = aggregator.providers.some(p => p && p.name === 'Ak47Live');
      expect(hasAk47).toBe(true);
    });

    test('selectSources ranks ak47live with Priority 1 and keeps it in fallback list', () => {
      const { selectSources } = require('../src/streams');
      const sources = [
        { source: 'streamedpk', id: 'sp1' },
        { source: 'daddylive', id: 'dl1' },
        { source: 'ak47live', id: 'http://193.47.62.1:8080/live/ch1.m3u8' },
        { source: 'streamsports99', id: 'ss1' }
      ];

      const sorted = selectSources(sources);
      expect(sorted[0].source).toBe('ak47live');
      expect(sorted.some(s => s.source === 'ak47live')).toBe(true);

      const withConfig = selectSources(sources, { sources: 'ak47live,daddylive' });
      expect(withConfig.length).toBe(2);
      expect(withConfig[0].source).toBe('ak47live');
    });
  });
});
