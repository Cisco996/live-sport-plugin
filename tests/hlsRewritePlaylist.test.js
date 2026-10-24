'use strict';

const { rewriteHlsPlaylist, isTikTokCloakedSegment } = require('../src/services/HlsRewriteService');
const byteRangeSigner = require('../src/services/ByteRangeSigner');
const segmentLengthService = require('../src/services/SegmentLengthService');

describe('rewriteHlsPlaylist — TikTok ByteRange Injection', () => {
  const manifestUrl = 'https://lb22.strmd.st/hotel/stream/event/1/playlist.m3u8';

  beforeAll(() => {
    segmentLengthService.autoProbe = false;
  });

  afterAll(() => {
    segmentLengthService.autoProbe = true;
  });

  test('isTikTokCloakedSegment identifies cloaked segment URLs', () => {
    expect(isTikTokCloakedSegment('https://cdn.example.com/chunk_1.image')).toBe(true);
    expect(isTikTokCloakedSegment('https://p16-common-sign.tiktokcdn-us.com/tos/segment_1.ts')).toBe(true);
    expect(isTikTokCloakedSegment('https://byteoversea.com/live/chunk.mp4')).toBe(true);
    expect(isTikTokCloakedSegment('https://normal-cdn.example.com/segment_1.ts')).toBe(false);
  });

  test('injects #EXT-X-BYTERANGE:<length>@42 and rewrites segment to 307 redirect URL', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXTINF:6.000,',
      'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg1.image',
      '#EXTINF:4.500,',
      'https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg2.image'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl, {
      referer: 'https://embed.st/',
      origin: 'https://embed.st',
      absoluteAddonBaseUrl: 'https://nuviosports.xyz'
    });

    const lines = rewritten.split('\n');

    // Verify first segment has #EXT-X-BYTERANGE injected
    const byteRangeIndex1 = lines.findIndex(l => l.startsWith('#EXT-X-BYTERANGE:'));
    expect(byteRangeIndex1).toBeGreaterThan(0);
    expect(lines[byteRangeIndex1]).toMatch(/^#EXT-X-BYTERANGE:\d+@42$/);

    // Verify segment URI line immediately follows
    const uriLine1 = lines[byteRangeIndex1 + 1];
    expect(uriLine1).toMatch(/^https:\/\/nuviosports\.xyz\/api\/hls\/resource\/[^/]+\/media\.ts\?psig=/);

    // Extract token and verify signature
    const match = uriLine1.match(/\/api\/hls\/resource\/([^/]+)\/media\.ts\?psig=([^&\s]+)/);
    expect(match).not.toBeNull();
    const token = match[1];
    const psig = decodeURIComponent(match[2]);

    const decoded = byteRangeSigner.verifySegmentToken(token, psig);
    expect(decoded).not.toBeNull();
    expect(decoded.url).toBe('https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-5300-tx2/seg1.image');
    expect(decoded.referer).toBe('https://embed.st/');
    expect(decoded.prefixBytes).toBe(42);
  });

  test('does not duplicate #EXT-X-BYTERANGE if manifest already contains it', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXTINF:6.000,',
      '#EXT-X-BYTERANGE:500000@42',
      'https://p16-common-sign.tiktokcdn-us.com/seg1.image'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
    const count = (rewritten.match(/#EXT-X-BYTERANGE/g) || []).length;
    expect(count).toBe(1);
  });

  test('leaves non-TikTok MPEG-TS segments direct without byte-range injection', () => {
    const rawM3u8 = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:4.000,',
      'https://standard-cdn.example.com/live/seg1.ts'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(rawM3u8, manifestUrl);
    expect(rewritten).not.toContain('#EXT-X-BYTERANGE');
    expect(rewritten).toContain('https://standard-cdn.example.com/live/seg1.ts');
  });

  test('preserves master playlist stream-inf variants', () => {
    const masterM3u8 = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
      '1080p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      '720p/index.m3u8'
    ].join('\n');

    const rewritten = rewriteHlsPlaylist(masterM3u8, manifestUrl, {
      referer: 'https://embed.st/',
      origin: 'https://embed.st'
    });

    expect(rewritten).toContain('/api/manifest?url=https%3A%2F%2Flb22.strmd.st%2Fhotel%2Fstream%2Fevent%2F1%2F1080p%2Findex.m3u8');
    expect(rewritten).toContain('/api/manifest?url=https%3A%2F%2Flb22.strmd.st%2Fhotel%2Fstream%2Fevent%2F1%2F720p%2Findex.m3u8');
  });
});
