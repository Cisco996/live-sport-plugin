'use strict';

/**
 * HlsRewriteService.js
 *
 * Single source of truth for HLS segment/variant URI rewriting.
 *
 * Both /api/manifest (playlist proxy) and the speed probe in streams.js must
 * build the exact URL a player would use for a given playlist entry. Before
 * this module existed the CF worker pool and the rewrite rules were duplicated
 * inline in routes/manifest.js and streams.js, which drifted apart once.
 *
 * Rewrite rules:
 *  - .m3u8  → /api/manifest?url=...&referer=...&origin=...(+rckSuffix)
 *  - .image → Cloudflare Worker from the budgeted pool (strips the 42-byte fake
 *             WebP/RIFF header Streamed.pk / TikTok CDN prepends). Free workers
 *             are spent first; the paid worker only takes the overflow.
 *             Fallback /api/hlschunk, or the raw upstream URL when
 *             HLSCUNK_FALLBACK=off.
 *  - disguised pure MPEG-TS (.png/.webp/.js, no .ts) → append '#.ts' hint
 *  - anything else → absolute URL as-is
 */

const { createWorkerPool } = require('./WorkerBudget');

// Process-wide pool. Budget state is per process by design — see the
// WORKER_INSTANCE_COUNT note in WorkerBudget.js.
const workerPool = createWorkerPool();

/**
 * Resolve a playlist URI against the manifest URL, inheriting the manifest's
 * query params (upstream CDNs key tokens in the query string).
 */
function resolveSegmentUrl(segmentUri, manifestUrl) {
  try {
    const chunkUrl = new URL(segmentUri, manifestUrl);
    const manifestObj = new URL(manifestUrl);

    manifestObj.searchParams.forEach((val, key) => {
      if (!chunkUrl.searchParams.has(key)) {
        chunkUrl.searchParams.set(key, val);
      }
    });

    return chunkUrl.toString();
  } catch (_) {
    return segmentUri;
  }
}

/**
 * Rewrite one playlist entry into the URL the player should fetch.
 */
function rewriteHlsUri(segmentUri, manifestUrl, opts = {}) {
  const { referer = '', origin = '', rckSuffix = '', absoluteAddonBaseUrl = '' } = opts;
  const absoluteUrl = resolveSegmentUrl(segmentUri, manifestUrl);

  if (absoluteUrl.includes('.m3u8')) {
    let manifestPath = `/api/manifest?url=${encodeURIComponent(absoluteUrl)}`;
    if (referer) manifestPath += `&referer=${encodeURIComponent(referer)}`;
    if (origin) manifestPath += `&origin=${encodeURIComponent(origin)}`;
    manifestPath += rckSuffix || '';
    return absoluteAddonBaseUrl ? new URL(manifestPath, absoluteAddonBaseUrl).toString() : manifestPath;
  }

  if (absoluteUrl.includes('.image')) {
    // Deduped by absolute URL: a live playlist re-emits its whole sliding
    // window on every fetch, and those repeats must not spend budget twice.
    const pick = workerPool.pick(absoluteUrl);

    if (pick) {
      let workerChunkUrl = `${pick.url}/seg.ts?url=${encodeURIComponent(absoluteUrl)}`;
      if (referer) workerChunkUrl += `&referer=${encodeURIComponent(referer)}`;
      if (origin) workerChunkUrl += `&origin=${encodeURIComponent(origin)}`;
      return workerChunkUrl;
    }

    // Every free worker is at its daily cap and the paid worker is at its
    // monthly budget. Emitting the upstream URL keeps the VPS out of the byte
    // path; the player drops this segment instead of streaming it through us.
    if (!workerPool.config.hlschunkFallback) {
      return absoluteUrl;
    }

    let chunkPath = `/api/hlschunk?url=${encodeURIComponent(absoluteUrl)}`;
    if (referer) chunkPath += `&referer=${encodeURIComponent(referer)}`;
    if (origin) chunkPath += `&origin=${encodeURIComponent(origin)}`;
    return absoluteAddonBaseUrl ? new URL(chunkPath, absoluteAddonBaseUrl).toString() : chunkPath;
  }

  // Plain MPEG-TS segments stream directly from the upstream CDN (0 VPS bandwidth bleeding).

  const isPureDisguisedTs = absoluteUrl.includes('.png') || absoluteUrl.includes('.webp') || absoluteUrl.includes('.js');
  if (isPureDisguisedTs && !absoluteUrl.includes('.ts')) {
    return absoluteUrl + '#.ts';
  }

  return absoluteUrl;
}

module.exports = {
  resolveSegmentUrl,
  rewriteHlsUri,
  workerPool,
};
