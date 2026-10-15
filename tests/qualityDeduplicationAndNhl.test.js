'use strict';

const LiveTVProvider = require('../src/providers/LiveTVProvider');
const skTechMatchResolver = require('../src/resolver/sktech/SkTechMatchResolver');
const { deduplicateResolutions } = require('../src/streams');

describe('Quality Deduplication & NHL Direct Streams Suite', () => {
  describe('NHL Direct Streams via Brightcove Edge Playback API', () => {
    let provider;

    beforeEach(() => {
      provider = new LiveTVProvider();
    });

    test('extracts direct HLS and MP4 streams from Brightcove player embeds with 0% server bandwidth', async () => {
      const mockBrightcoveData = {
        name: 'BOS at SJS | Recap',
        sources: [
          {
            type: 'application/x-mpegURL',
            src: 'https://manifest.prod.boltdns.net/manifest/v1/hls/v4/clear/6415718365001/test/master.m3u8?fastly_token=xyz'
          },
          {
            container: 'MP4',
            avg_bitrate: 4500000,
            src: 'https://fastly-signed-us-east-1-prod.brightcovecdn.com/media/v1/pmp4/static/clear/test/main.mp4?fastly_token=xyz'
          }
        ]
      };

      global.fetch = jest.fn().mockImplementation((url) => {
        if (url.includes('edge.api.brightcove.com')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockBrightcoveData)
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('<html></html>')
        });
      });

      const res = await provider._resolveBrightcove('6415718365001', '6406827636112');
      expect(res).toBeDefined();
      expect(res.hlsUrl).toContain('master.m3u8');
      expect(res.mp4Url).toContain('main.mp4');
    });
  });

  describe('SkTech Dynamic M3U Quality Deduplication', () => {
    test('deduplicates FanCode multi-bitrate entries keeping only highest resolution per feed', () => {
      const resolver = skTechMatchResolver;
      const m3uContent = `
#EXTM3U
#EXTINF:-1 tvg-id="141449" tvg-name="FanCode" group-title="Cricket",Namibia vs Uganda (240p)
https://in-mc-flive.fancode.com/240p.m3u8
#EXTINF:-1 tvg-id="141449" tvg-name="FanCode" group-title="Cricket",Namibia vs Uganda (360p)
https://in-mc-flive.fancode.com/360p.m3u8
#EXTINF:-1 tvg-id="141449" tvg-name="FanCode" group-title="Cricket",Namibia vs Uganda (480p)
https://in-mc-flive.fancode.com/480p.m3u8
#EXTINF:-1 tvg-id="141449" tvg-name="FanCode" group-title="Cricket",Namibia vs Uganda (720p)
https://in-mc-flive.fancode.com/720p.m3u8
#EXTINF:-1 tvg-id="141449" tvg-name="FanCode" group-title="Cricket",Namibia vs Uganda (1080p)
https://in-mc-flive.fancode.com/1080p.m3u8
`;

      const matchMap = new Map();
      const matches = [];
      resolver.parseM3UContent(m3uContent, { label: 'FanCode', url: 'https://example.com/playlist.m3u' }, matchMap, matches);

      expect(matches).toHaveLength(1);
      expect(matches[0].title).toBe('Namibia vs Uganda');
      // Sources must only contain 1 entry (1080P) instead of 5 separate entries
      expect(matches[0].sources).toHaveLength(1);
      expect(matches[0].sources[0].resolution).toBe('1080P');
      expect(matches[0].sources[0].streamUrl).toBe('https://in-mc-flive.fancode.com/1080p.m3u8');
    });
  });

  describe('streams.js Quality Deduplication', () => {
    test('filters out lower bitrate duplicates when same base stream has multiple resolutions', () => {
      // Test the pure deduplicateResolutions function directly — no IoC container required.
      const streams = [
        { name: 'ReplayZone', title: 'Replay (240p) [OK.ru]', url: 'https://example.com/240.mp4' },
        { name: 'ReplayZone', title: 'Replay (360p) [OK.ru]', url: 'https://example.com/360.mp4' },
        { name: 'ReplayZone', title: 'Replay (480p) [OK.ru]', url: 'https://example.com/480.mp4' },
        { name: 'ReplayZone', title: 'Replay (1080p) [OK.ru]', url: 'https://example.com/1080.mp4' },
        { name: 'ReplayZone', title: 'Replay (Auto HLS) [OK.ru]', url: 'https://example.com/master.m3u8' }
      ];

      deduplicateResolutions(streams);

      // Should keep 1080p and Auto HLS; 240p, 360p, 480p should be suppressed!
      expect(streams.some(s => s.title.includes('1080p'))).toBe(true);
      expect(streams.some(s => s.title.includes('Auto HLS'))).toBe(true);
      expect(streams.some(s => s.title.includes('240p'))).toBe(false);
      expect(streams.some(s => s.title.includes('360p'))).toBe(false);
      expect(streams.some(s => s.title.includes('480p'))).toBe(false);
      expect(streams).toHaveLength(2);
    });

    test('passes through streams with no resolution tag unchanged', () => {
      const streams = [
        { name: 'Sky Sports', title: 'Sky Sports F1 [HLS]', url: 'https://example.com/f1.m3u8' },
        { name: 'Daddy Live', title: 'Premier League Live', url: 'https://example.com/prem.m3u8' }
      ];

      deduplicateResolutions(streams);

      expect(streams).toHaveLength(2);
    });
  });
});
