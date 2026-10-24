'use strict';

const segmentLengthService = require('../src/services/SegmentLengthService');
const { SegmentLengthService } = segmentLengthService;

describe('SegmentLengthService', () => {
  let service;

  beforeEach(() => {
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

  test('returns estimated length based on duration and bitrate when not cached', () => {
    const url = 'https://cdn.example.com/chunk_uncached.image';
    // 6 seconds @ 4,000,000 bps = 3,000,000 bytes. Minus 42 = 2,999,958 bytes.
    // Aligned to 188: Math.floor(2999958 / 188) * 188 = 15957 * 188 = 2999916
    const length = service.getSegmentLength(url, { duration: 6.0, bitrate: 4000000 });
    expect(length).toBe(2999916);
    expect(length % 188).toBe(0);
  });

  test('returns default fallback when duration is not provided', () => {
    const url = 'https://cdn.example.com/chunk_unknown.image';
    const length = service.getSegmentLength(url);
    expect(length).toBe(1022720);
    expect(length % 188).toBe(0);
  });

  test('evicts oldest entries when cache reaches capacity', () => {
    for (let i = 0; i < 12; i++) {
      service.setCachedLength(`https://cdn.example.com/chunk_${i}.image`, 100000 + i);
    }
    expect(service.cache.size).toBeLessThanOrEqual(10);
  });
});
