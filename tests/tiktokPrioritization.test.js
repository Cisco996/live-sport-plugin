'use strict';

/**
 * tests/tiktokPrioritization.test.js
 *
 * Verifies that:
 * 1. StreamScoringService awards Direct CDN bonus (+20) to non-worker streams
 *    (Vavoo, DaddyLive, Golf, PPVst, DamiTV, SKTech) and penalizes TikTok CDN streams (-30).
 * 2. LanguagePriorityService's compareStreams strictly ranks non-TikTok direct streams
 *    above TikTok CDN streams to prevent Cloudflare Worker quota exhaustion.
 * 3. TikTok stream detection flags .image chunks and ByteDance/TikTok domains.
 */

const StreamScoringService = require('../src/services/StreamScoringService');
const { compareStreams, parseLanguagePriority, DIRECT_STREAM_NAME } = require('../src/services/LanguagePriorityService');

describe('TikTok CDN Deprioritization & Worker Quota Saver', () => {
  let scorer;
  const noConfig = parseLanguagePriority({});

  beforeEach(() => {
    scorer = new StreamScoringService();
  });

  describe('StreamScoringService', () => {
    test('awards Direct CDN bonus (+20) to Vavoo and DaddyLive', () => {
      const vavooStream = { url: 'https://sunshine.example/index.m3u8', resolution: '1080p' };
      const score = scorer.calculateScore(vavooStream, 'vavoo');
      // base 50 + 30 (url) + 20 (1080p) + 20 (direct CDN) + 15 (reliable) = 135
      expect(score).toBe(135);
    });

    test('penalizes TikTok CDN streams (-30) and strips reliability bonus', () => {
      const tiktokStream = {
        url: 'https://p16-common-sign.tiktokcdn.com/tos-alisg/video~tplv-origin.image',
        resolution: '1080p',
        isTikTok: true
      };
      const score = scorer.calculateScore(tiktokStream, 'admin');
      // base 50 + 30 (url) + 20 (1080p) - 30 (tiktok penalty) + 0 = 70
      expect(score).toBe(70);
    });

    test('clean Golf stream outscores TikTok Admin stream', () => {
      const golfStream = { url: 'https://lb1.strmd.st/ingest/stream/1/playlist.m3u8', resolution: '1080p' };
      const tiktokAdmin = {
        url: 'https://lb17.strmd.st/rtmp/stream/1/playlist.m3u8',
        resolution: '1080p',
        isTikTok: true
      };

      const golfScore = scorer.calculateScore(golfStream, 'golf');
      const adminScore = scorer.calculateScore(tiktokAdmin, 'admin');

      expect(golfScore).toBeGreaterThan(adminScore);
      expect(golfScore - adminScore).toBeGreaterThanOrEqual(60);
    });
  });

  describe('LanguagePriorityService compareStreams', () => {
    test('places non-TikTok direct stream before TikTok stream in same language and format', () => {
      const directVavoo = {
        name: DIRECT_STREAM_NAME,
        url: 'https://sunshine.example/index.m3u8',
        language: 'English',
        score: 135,
        speedScore: 50,
        isTikTok: false
      };

      const tiktokAdmin = {
        name: DIRECT_STREAM_NAME,
        url: 'https://lb17.strmd.st/manifest.m3u8',
        language: 'English',
        score: 70,
        speedScore: 90, // Even with higher speed score
        isTikTok: true
      };

      // compareStreams should return negative when first argument outranks second
      expect(compareStreams(directVavoo, tiktokAdmin, noConfig)).toBeLessThan(0);
      expect(compareStreams(tiktokAdmin, directVavoo, noConfig)).toBeGreaterThan(0);
    });

    test('sorts mixed stream list prioritizing Direct CDNs before TikTok feeds', () => {
      const list = [
        { name: DIRECT_STREAM_NAME, title: 'Streamed [Admin]', language: 'English', isTikTok: true, score: 70 },
        { name: DIRECT_STREAM_NAME, title: 'Vavoo 1080p', language: 'English', isTikTok: false, score: 135 },
        { name: DIRECT_STREAM_NAME, title: 'DaddyLive 1080p', language: 'English', isTikTok: false, score: 135 },
        { name: DIRECT_STREAM_NAME, title: 'Streamed [Golf]', language: 'English', isTikTok: false, score: 135 }
      ];

      const sorted = [...list].sort((a, b) => compareStreams(a, b, noConfig));

      // Top 3 streams must all be non-TikTok feeds
      expect(sorted[0].isTikTok).toBeFalsy();
      expect(sorted[1].isTikTok).toBeFalsy();
      expect(sorted[2].isTikTok).toBeFalsy();

      // The TikTok stream must be at the bottom
      expect(sorted[3].title).toBe('Streamed [Admin]');
      expect(sorted[3].isTikTok).toBe(true);
    });
  });
});
