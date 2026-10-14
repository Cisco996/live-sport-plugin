/**
 * routes/manifest.js - /api/manifest HLS playlist proxy
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();
const {
  MANIFEST_TTL_MS, playlistHasContent,
  manifestCacheGet, manifestCacheSet, manifestCacheSetNegative,
  notifyResolveCacheOfDeadStream, fetchUpstreamManifest,
  manifestInFlight
} = require('../manifestProxy');
const {
  readRck, getRemintCacheKey, remintCache, mergeRemintedUrl, isExpiryStatus, attemptRemint
} = require('../remint');
const { rewriteHlsUri } = require('../services/HlsRewriteService');
const { safeFetch: _safeFetch } = require('../impitClient');

router.get('/api/manifest', async (req, res) => {
  const targetUrl = req.query.url;
  const referer = req.query.referer || 'https://embed.st/';
  const origin = req.query.origin || 'https://embed.st';

  if (!targetUrl) return res.status(400).send('Missing url');
  if (targetUrl.includes('.mpd')) return handleDashManifestProxy(req, res);

  // Playlist-only proxy (same as WatchFooty / Streamed.pk .ts): this host fetches
  // the m3u8 with the CDN Referer, then the player pulls every media byte from the CDN.
  const cacheKey = `${targetUrl}|${referer}|${origin}`;
  // Recovery key for this stream, if the URL was emitted by our own resolver.
  const rck = readRck(req);
  const rckSuffix = rck ? '&rck=' + encodeURIComponent(rck) : '';
  const entry = manifestCacheGet(cacheKey);
  if (entry && entry.negative) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'NEGATIVE');
    return res.status(entry.status).send(entry.body);
  }
  if (entry) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'HIT');
    return res.send(entry.body);
  }

  try {
    let fetchPromise = manifestInFlight.get(cacheKey);
    if (!fetchPromise) {
      fetchPromise = (async () => {
        let effectiveUrl = targetUrl;
        let reminted = false;

        if (rck) {
          const subKey = getRemintCacheKey(rck, effectiveUrl);
          const cached = (subKey ? remintCache.get(subKey) : null) || remintCache.get(rck);
          if (cached && Date.now() < cached.expiresAt) {
            effectiveUrl = mergeRemintedUrl(effectiveUrl, cached.freshUrl, rck);
            reminted = true;
          }
        }

        let out;
        try {
          out = await fetchUpstreamManifest(effectiveUrl, referer, origin);
        } catch (firstErr) {
          const fresh = (isExpiryStatus(firstErr) && rck) ? await attemptRemint(rck, effectiveUrl || targetUrl) : null;
          if (!fresh || fresh === effectiveUrl) throw firstErr;
          
          console.log('[ManifestProxy] Upstream token expired — re-minted, retrying transparently');
          const subKey = getRemintCacheKey(rck, effectiveUrl || targetUrl);
          if (subKey) remintCache.set(subKey, { freshUrl: fresh, expiresAt: Date.now() + 15 * 60 * 1000 });
          remintCache.set(rck, { freshUrl: fresh, expiresAt: Date.now() + 15 * 60 * 1000 });
          
          // Preserve the variant the player asked for (see mergeRemintedUrl).
          effectiveUrl = mergeRemintedUrl(targetUrl, fresh, rck);
          reminted = true;
          out = await fetchUpstreamManifest(effectiveUrl, referer, origin);
        }
        if (!out.includes('#EXT')) {
          console.error('[ManifestProxy] Upstream returned non-m3u8 body for', effectiveUrl);
          throw new Error('Upstream returned non-m3u8 body');
        }

        // Reject header-only playlists (tags but no segment/variant URI). Feeding
        // one to a player just stalls it; reporting it lets the client fail over.
        if (!playlistHasContent(out)) {
          console.warn('[ManifestProxy] Upstream playlist has no media entries (empty live window) for', effectiveUrl);
          throw new Error('Upstream playlist has no media entries');
        }

        let dynamicTtl = MANIFEST_TTL_MS;
        try {
          const m3u8Parser = require('m3u8-parser');
          const parser = new m3u8Parser.Parser();
          parser.push(out);
          parser.end();
          if (parser.manifest.targetDuration) {
            dynamicTtl = (parser.manifest.targetDuration * 1000) / 2;
          }
        } catch (e) {
          // Fallback to default TTL on parse error
        }

        const isLive = !out.includes('#EXT-X-ENDLIST');
        const isMaster = out.includes('#EXT-X-STREAM-INF');

        // Master playlists can be cached longer, but live media playlists must refresh dynamically (2-3s)
        if (isMaster) {
          dynamicTtl = 60000;
        } else if (isLive) {
          dynamicTtl = Math.min(dynamicTtl, 3000);
        }
        let injectedStart = out.includes('#EXT-X-START');

        const lines = out.split('\n');
        const rewritten = lines.map(line => {
          const l = line.trim();

          let resultLine = line;

          if (!l) return resultLine;
          
          if (l.startsWith('#')) {
              // Handle EXT-X-MAP:URI="relative.mp4"
              if (l.startsWith('#EXT-X-MAP:')) {
                  const uriMatch = l.match(/URI="([^"]+)"/);
                  if (uriMatch) {
                      try {
                          const absUri = new URL(uriMatch[1], effectiveUrl).toString();
                          resultLine = l.replace(uriMatch[1], absUri);
                      } catch(e) {}
                  }
              }
              return resultLine;
          }

          return rewriteHlsUri(l, effectiveUrl, { referer, origin, rckSuffix });
        });

        const rewrittenResult = rewritten.join('\n');
        manifestCacheSet(cacheKey, rewrittenResult, dynamicTtl);
        return rewrittenResult;
      })().finally(() => {
        manifestInFlight.delete(cacheKey);
      });
      manifestInFlight.set(cacheKey, fetchPromise);
    }

    const finalBody = await fetchPromise;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Manifest-Cache', 'MISS');
    res.send(finalBody);
  } catch (err) {
    // Preserve the old 404 semantics so players can fail over to another stream.
    // Failures are negatively cached (15 s) so player polls stop hammering the dead upstream.
    // In parallel, drop the originating resolve-cache entry so the next click mints fresh.
    notifyResolveCacheOfDeadStream(req.originalUrl || req.url);
    // Auth/expiry statuses from the CDN mean the embedded upstream token is gone,
    // not that this proxy is broken. Providers were observed to answer expired
    // tokens with 403 (see streams.js verifyStreams). Reporting those as 404 lets
    // the player fail over cleanly instead of hard-erroring on a misleading 502.
    const upstreamStatus = err && err.statusCode;
    const isExpired = upstreamStatus === 401 || upstreamStatus === 403 ||
                      upstreamStatus === 404 || upstreamStatus === 410;
    // A transient upland 5xx that survived the retry above is NOT a broken proxy —
    // the upstream is just briefly unavailable. Reporting 404 lets the player fail
    // over to another stream instead of stalling on a 502.
    const isTransientUpstream = upstreamStatus >= 500 && upstreamStatus <= 599;
    if (err.message === 'Upstream returned non-m3u8 body' ||
        err.message === 'Upstream playlist has no media entries' ||
        isExpired || isTransientUpstream) {
      if (isExpired) {
        console.warn(`[ManifestProxy] Upstream refused with ${upstreamStatus} (expired token?) for ${targetUrl}`);
      } else if (isTransientUpstream) {
        console.warn(`[ManifestProxy] Upstream ${upstreamStatus} persisted after retry; reporting 404 so the player fails over`);
      }
      // Negative-cache briefly so the player's rapid polls don't hammer a dead
      // upstream, but short enough that a recovered upstream is picked up quickly.
      manifestCacheSetNegative(cacheKey, 404, 'Stream not found or expired');
      return res.status(404).send('Stream not found or expired');
    }
    console.error('[ManifestProxy] Error:', err.message);
    manifestCacheSetNegative(cacheKey, 502, 'Manifest proxy error: ' + err.message);
    return res.status(502).send('Manifest proxy error: ' + err.message);
  }
});

// ─── DASH MPD Manifest Proxy & ClearKey License Support ───────────────────────
// Injects BaseURL pointing to upstream CDN so media chunks stream directly to player
// Injects W3C/DASH-IF ClearKey ContentProtection tags pointing to our local license endpoint
// Result: 0% server bandwidth for media chunks; standard ExoPlayer clients decrypt cleanly.

function parseClearKeyToken(token) {
  if (!token) return [];
  let str = token;
  if (typeof str !== 'string') return [];
  str = str.trim();
  // Try base64url decode
  if (!str.startsWith('{') && !str.includes(':')) {
    try {
      str = Buffer.from(str, 'base64url').toString('utf8');
    } catch (_) {}
  }
  // Try JSON
  if (str.startsWith('{') || str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      const keysArr = parsed.keys || (parsed.keyId ? [parsed] : []);
      return keysArr.map(k => ({
        kty: 'oct',
        kid: k.kid || k.keyId,
        k: k.k || k.key
      }));
    } catch (_) {}
  }
  // Try hex colon pairs (e.g. kId1:kVal1,kId2:kVal2)
  const isHex = (s) => typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
  const toB64Url = (s) => isHex(s) ? Buffer.from(s, 'hex').toString('base64url') : s;
  const pairs = str.split(',').map(p => p.trim()).filter(Boolean);
  const keys = [];
  for (const p of pairs) {
    if (p.includes(':')) {
      const [kid, k] = p.split(':');
      keys.push({
        kty: 'oct',
        kid: toB64Url(kid.trim()),
        k: toB64Url(k.trim())
      });
    }
  }
  return keys;
}

async function handleDashManifestProxy(req, res) {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  const token = req.query.token || req.query.keys || '';
  const referer = req.query.referer || '';
  const origin = req.query.origin || (referer ? (() => { try { return new URL(referer).origin; } catch (_) { return ''; } })() : '');
  const cookie = req.query.cookie || '';
  const ua = req.query.ua || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

  const headers = { 'User-Agent': ua };
  if (referer) headers['Referer'] = referer;
  if (origin) headers['Origin'] = origin;
  if (cookie) headers['Cookie'] = cookie;

  try {
    const result = await _safeFetch(targetUrl, { headers, timeoutMs: 10000 });
    if (!result.ok) {
      return res.status(result.status).send(`Upstream returned HTTP ${result.status}`);
    }

    let mpd = await result.text();
    if (!mpd.includes('<MPD') && !mpd.includes('<mpd')) {
      return res.status(502).send('Upstream returned non-MPD body');
    }

    // 1. Inject BaseURL if missing so relative segment URLs resolve to upstream CDN
    if (!mpd.includes('<BaseURL>')) {
      try {
        const upstreamBase = new URL('.', targetUrl).toString();
        mpd = mpd.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${upstreamBase}</BaseURL>`);
      } catch (_) {}
    }

    // 2. Inject ClearKey ContentProtection if keys are present
    if (token) {
      const reqBase = `${req.protocol}://${req.get('host')}`;
      const licenseUrl = `${reqBase}/api/clearkey/license?token=${encodeURIComponent(token)}`;
      const ckTags = `
    <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030a7d0e82e" value="ClearKey1.0">
      <clearkey:Laurl xmlns:clearkey="http://dashif.org/guidelines/clearkey">${licenseUrl}</clearkey:Laurl>
      <dashif:laurl xmlns:dashif="urn:mpeg:dash:schema:dashif:laurl:2020">${licenseUrl}</dashif:laurl>
    </ContentProtection>
    <ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b" value="ClearKey1.0">
      <clearkey:Laurl xmlns:clearkey="http://dashif.org/guidelines/clearkey">${licenseUrl}</clearkey:Laurl>
      <dashif:laurl xmlns:dashif="urn:mpeg:dash:schema:dashif:laurl:2020">${licenseUrl}</dashif:laurl>
    </ContentProtection>`;

      if (mpd.includes('urn:uuid:e2719d58-a985-b3c9-781a-b030a7d0e82e')) {
        mpd = mpd.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030a7d0e82e"[^>]*>([\s\S]*?<\/ContentProtection>)?/gi, ckTags);
      } else {
        mpd = mpd.replace(/(<AdaptationSet[^>]*>)/gi, `$1${ckTags}`);
      }
    }

    res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(mpd);
  } catch (err) {
    console.error('[ManifestProxy] DASH error:', err.message);
    return res.status(502).send('Manifest proxy error: ' + err.message);
  }
}

router.get('/api/manifest.mpd', handleDashManifestProxy);

router.options(['/api/clearkey/license', '/api/license'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(204).end();
});

router.all(['/api/clearkey/license', '/api/license'], (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const rawToken = req.query.token || (req.body && req.body.token) || req.query.keys || '';
  const keys = parseClearKeyToken(rawToken);

  return res.json({
    keys,
    type: 'temporary'
  });
});

module.exports = router;
