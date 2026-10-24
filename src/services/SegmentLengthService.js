'use strict';

const { safeFetch } = require('../impitClient');

const MAX_CACHE_SIZE = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for immutable chunk lengths
const DEFAULT_FALLBACK_LENGTH = 1022720; // 5440 * 188 bytes (MPEG-TS packet aligned)
const DEFAULT_BITRATE = 6000000; // 6 Mbps default for 1080p

class SegmentLengthService {
  constructor(opts = {}) {
    this.maxSize = opts.maxSize || MAX_CACHE_SIZE;
    this.autoProbe = opts.autoProbe !== false;
    this.cache = new Map(); // url -> { length, expiresAt }
    this.inFlightProbes = new Map(); // url -> Promise<number>
  }

  /**
   * Align byte count to MPEG-TS packet boundary (188 bytes).
   *
   * @param {number} rawBytes
   * @returns {number}
   */
  alignToTsPacket(rawBytes) {
    if (rawBytes <= 188) return 188;
    return Math.floor(rawBytes / 188) * 188;
  }

  /**
   * Get cached segment length or compute a fast fallback while probing in the background.
   *
   * @param {string} segmentUrl Upstream segment URL
   * @param {Object} [opts={}]
   * @param {number} [opts.duration] Segment duration in seconds (from #EXTINF)
   * @param {number} [opts.bitrate] Stream bitrate in bps (from #EXT-X-STREAM-INF)
   * @param {string} [opts.referer]
   * @param {string} [opts.origin]
   * @returns {number} Segment byte length (excluding the 42 fake prefix bytes)
   */
  getSegmentLength(segmentUrl, opts = {}) {
    const cached = this.cache.get(segmentUrl);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.length;
    }

    // Trigger non-blocking background probe
    if (this.autoProbe) {
      this.probeContentLength(segmentUrl, opts).catch(() => {});
    }

    // Fast fallback estimation
    if (opts.duration && opts.duration > 0) {
      const bitrate = opts.bitrate || DEFAULT_BITRATE;
      const estimatedTotal = Math.round((opts.duration * bitrate) / 8);
      const videoBytes = Math.max(188, estimatedTotal - 42);
      return this.alignToTsPacket(videoBytes);
    }

    return DEFAULT_FALLBACK_LENGTH;
  }

  /**
   * Probe upstream Content-Length via lightweight HEAD request.
   *
   * @param {string} segmentUrl
   * @param {Object} [opts={}]
   * @returns {Promise<number>}
   */
  async probeContentLength(segmentUrl, opts = {}) {
    const cached = this.cache.get(segmentUrl);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.length;
    }

    if (this.inFlightProbes.has(segmentUrl)) {
      return this.inFlightProbes.get(segmentUrl);
    }

    const probePromise = (async () => {
      try {
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': opts.referer || 'https://embed.st/',
          'Origin': opts.origin || 'https://embed.st'
        };

        const res = await safeFetch(segmentUrl, {
          method: 'HEAD',
          headers,
          timeoutMs: 4000
        });

        if (res && res.headers) {
          const cl = res.headers.get('content-length');
          if (cl) {
            const totalBytes = parseInt(cl, 10);
            if (!isNaN(totalBytes) && totalBytes > 42) {
              const videoBytes = totalBytes - 42;
              this.setCachedLength(segmentUrl, videoBytes);
              return videoBytes;
            }
          }
        }
      } catch (_) {}

      // If HEAD fails, fallback
      const fallback = (opts.duration && opts.duration > 0)
        ? this.alignToTsPacket(Math.max(188, Math.round((opts.duration * (opts.bitrate || DEFAULT_BITRATE)) / 8) - 42))
        : DEFAULT_FALLBACK_LENGTH;

      this.setCachedLength(segmentUrl, fallback, 60 * 1000); // 1 min fallback TTL
      return fallback;
    })().finally(() => {
      this.inFlightProbes.delete(segmentUrl);
    });

    this.inFlightProbes.set(segmentUrl, probePromise);
    return probePromise;
  }

  setCachedLength(segmentUrl, length, ttlMs = CACHE_TTL_MS) {
    if (this.cache.size >= this.maxSize) {
      // LRU Eviction: remove oldest 20%
      const keysToDelete = [...this.cache.keys()].slice(0, Math.floor(this.maxSize * 0.2));
      for (const k of keysToDelete) {
        this.cache.delete(k);
      }
    }

    this.cache.set(segmentUrl, {
      length,
      expiresAt: Date.now() + ttlMs
    });
  }

  clear() {
    this.cache.clear();
    this.inFlightProbes.clear();
  }
}

// Export singleton instance and class
const defaultService = new SegmentLengthService();
defaultService.SegmentLengthService = SegmentLengthService;

module.exports = defaultService;
