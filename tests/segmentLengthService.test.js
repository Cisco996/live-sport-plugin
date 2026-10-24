'use strict';

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const segmentLengthService = require('../src/services/SegmentLengthService');
const { safeFetch } = require('../src/impitClient');
const { SegmentLengthService } = segmentLengthService;

function fakeHeaders(map = {}) {
  return { get: (k) => (map[String(k).toLowerCase()] !== undefined ? map[String(k).toLowerCase()] : null) };
}

describe('SegmentLengthService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SegmentLengthService({ maxSize: 10, autoProbe: false });
  });

  afterEach(() => {
    service.clear();
  });

  test('alignToTsPacket aligns bytes down to multiple of 188', () => {
    expect(service.alignToTsPacket(1000)).toBe(940); // 188 * 5 = 940
    expect(service.alignToTsPacket(188)).toBe(188);
    expect(service.alignToTsPacket(100)).toBe(188); // floor guard
  });

  test('returns cached length if available and not expired', () => {
    const url = 'https://cdn.example.com/chunk_1.image';
    service.setCachedLength(url, 500000);

    const length = service.getSegmentLength(url);
    expect(length).toBe(500000);
  });

  test('returns OVER-DECLARED estimate based on duration and bitrate when not cached', () => {
    const url = 'https://cdn.example.com/chunk_uncached.image';
    // 6 seconds @ 4,000,000 bps x 1.5 safety = 4,500,000 bytes total.
    // Minus 42 = 4,499,958. Aligned down to 188: 23935 * 188 = 4,499,780.
    // Over-declaring is safe (CDN returns the bytes that exist); under-declaring
    // truncates the segment mid-GOP and stalls the decoder.
    const length = service.getSegmentLength(url, { duration: 6.0, bitrate: 4000000 });
    expect(length).toBe(4499780);
    expect(length % 188).toBe(0);
  });

  test('returns over-declared default fallback when duration is not provided', () => {
    const url = 'https://cdn.example.com/chunk_unknown.image';
    // 1,022,720 x 1.5 = 1,534,080 total, minus 42 = 1,534,038, aligned: 8159 * 188.
    const length = service.getSegmentLength(url);
    expect(length).toBe(1533892);
    expect(length % 188).toBe(0);
  });

  test('probed true length replaces the estimate once cached', async () => {
    const url = 'https://cdn.example.com/chunk_probed.image';
    safeFetch.mockResolvedValueOnce({
      status: 206,
      headers: fakeHeaders({ 'content-range': 'bytes 0-0/3535338' })
    });

    const svc = new SegmentLengthService({ maxSize: 10 }); // autoProbe on
    const estimate = svc.getSegmentLength(url, { duration: 3.84 });
    expect(estimate % 188).toBe(0);

    const probed = await svc.inFlightProbes.get(url);
    expect(probed).toBe(3535338 - 42); // true payload excluding the 42-byte cloak

    expect(svc.getSegmentLength(url, { duration: 3.84 })).toBe(3535338 - 42);
    expect(svc.cache.get(url).length).toBe(3535338 - 42);
  });

  test('falls back to HEAD when the ranged GET carries no Content-Range', async () => {
    const url = 'https://cdn.example.com/chunk_head.image';
    safeFetch
      .mockResolvedValueOnce({ status: 403, headers: fakeHeaders({}) })
      .mockResolvedValueOnce({ status: 200, headers: fakeHeaders({ 'content-length': '2000042' }) });

    const svc = new SegmentLengthService({ maxSize: 10 });
    const probed = await svc.probeContentLength(url, { duration: 3.84 });

    expect(probed).toBe(2000042 - 42);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[0][1].method).toBe('GET');
    expect(safeFetch.mock.calls[0][1].headers.Range).toBe('bytes=0-0');
    expect(safeFetch.mock.calls[1][1].method).toBe('HEAD');
  });

  test('a failed probe caches NOTHING and suppresses re-probing briefly', async () => {
    const url = 'https://cdn.example.com/chunk_dead.image';
    safeFetch.mockRejectedValue(new Error('cdn blocked'));

    const svc = new SegmentLengthService({ maxSize: 10 });
    const estimate = svc.getSegmentLength(url, { duration: 3.84 });
    await svc.inFlightProbes.get(url);

    expect(estimate % 188).toBe(0);
    expect(svc.cache.size).toBe(0); // estimate must NOT be cached as truth
    expect(svc.probeFailures.has(url)).toBe(true);

    // Next call within the retry window reuses the estimate without probing.
    safeFetch.mockClear();
    svc.getSegmentLength(url, { duration: 3.84 });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('evicts oldest entries when cache reaches capacity', () => {
    for (let i = 0; i < 12; i++) {
      service.setCachedLength(`https://cdn.example.com/chunk_${i}.image`, 100000 + i);
    }
    expect(service.cache.size).toBeLessThanOrEqual(10);
  });
});
