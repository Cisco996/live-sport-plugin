const undici = require('undici');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class SoccerFullProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'SoccerFull';
    this.sourceName = 'soccerfull';
    this.baseUrl = 'https://soccerfull.net';
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    };

    // In-memory bounded caches to prevent repeated network hops
    this._matchPageCache = new Map();
    this._streamCache = new Map();
    this._maxCacheEntries = 500;

    // Circuit breaker wrappers if circuit breaker is available
    if (this.circuitBreaker && typeof this.circuitBreaker.wrapSync === 'function') {
      this.fetchPage = this.circuitBreaker.wrapSync(`${this.name}_fetchPage`, async (url) => {
        const res = await undici.request(url, {
          headers: this.defaultHeaders,
          headersTimeout: 10000,
          bodyTimeout: 10000
        });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        return await res.body.text();
      });
    } else {
      this.fetchPage = {
        fire: async (url) => {
          const res = await undici.request(url, {
            headers: this.defaultHeaders,
            headersTimeout: 10000,
            bodyTimeout: 10000
          });
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          return await res.body.text();
        }
      };
    }
  }

  /**
   * Bounded Map cache helper with LRU-style eviction
   */
  _setCache(cache, key, value, ttlMs = 30 * 60 * 1000) {
    if (cache.size >= this._maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  _getCache(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Parses soccerfull HTML pages for replay match listings.
   */
  _parseMatchCards(html, pageIndex = 0) {
    const matches = [];
    const itemRegex = /<li class="item-movie">([\s\S]*?)<\/li>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(html)) !== null) {
      const block = itemMatch[1];

      // Extract relative match URL and title
      const linkMatch = block.match(/<a\s+href="([^"]+)"[^>]*title="([^"]*)"/i) ||
                         block.match(/<a\s+href="([^"]+)"/i);
      if (!linkMatch) continue;

      const rawUrl = linkMatch[1];
      if (!rawUrl.endsWith('.html')) continue;

      const matchUrl = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
      const slug = matchUrl.replace(/^\//, '').replace(/\.html$/, '');

      // Title
      let title = linkMatch[2] ? linkMatch[2].trim() : '';
      if (!title) {
        const titleTag = block.match(/<div class="title-movie"><h3>([^<]+)<\/h3><\/div>/i);
        if (titleTag) title = titleTag[1].trim();
      }
      if (!title) {
        title = slug.replace(/-\d+$/, '').replace(/-/g, ' ');
      }

      // Thumbnail
      let thumbnail = '';
      const imgMatch = block.match(/(?:src|data-original)="([^"]*\/imgs\/[^"]+)"/i);
      if (imgMatch) {
        thumbnail = imgMatch[1].startsWith('http') ? imgMatch[1] : `${this.baseUrl}${imgMatch[1]}`;
      }

      // League / Competition tag
      let league = '';
      const leagueMatch = block.match(/<span class="code[^"]*">([^<]+)<\/span>/i);
      if (leagueMatch) {
        league = leagueMatch[1].trim();
      }

      // Kickoff / Past event date parsing
      // Try to parse DD-MM-YYYY from URL/slug e.g. "crystal-palace-vs-nottingham-forest-08-02-2026.html"
      let dateMs = 0;
      const dateInSlug = slug.match(/(\d{2})-(\d{2})-(\d{4})/);
      if (dateInSlug) {
        const day = parseInt(dateInSlug[1], 10);
        const month = parseInt(dateInSlug[2], 10) - 1;
        const year = parseInt(dateInSlug[3], 10);
        const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
        if (!isNaN(d.getTime())) {
          dateMs = d.getTime();
        }
      }

      // If no explicit date in slug, anchor in the past based on page index
      // so it is immediately qualified as a finished replay (past kickoff)
      if (!dateMs) {
        const now = Date.now();
        // Page 0: ~6 hours ago; Page 1: ~1.5 days ago; Page 2: ~3 days ago
        const pastOffsetHours = 6 + (pageIndex * 36);
        dateMs = now - (pastOffsetHours * 3600 * 1000);
      }

      // Extract numeric ID if present
      const idMatch = slug.match(/-(\d+)$/);
      const matchId = idMatch ? `sf_${idMatch[1]}` : `sf_${slug}`;

      matches.push(new MatchEntity({
        id: matchId,
        title,
        category: 'football', // SoccerFull is 100% football replays
        league,
        status: 'finished', // Authoritative replay flag
        date: String(dateMs),
        thumbnail_url: thumbnail,
        poster: thumbnail,
        background: thumbnail,
        sources: [{
          source: this.sourceName,
          id: matchUrl,
          name: 'SoccerFull',
          url: `${this.baseUrl}${matchUrl}`
        }]
      }));
    }

    return matches;
  }

  /**
   * Fetch replays from SoccerFull (scrapes first 3 pages: /, /new/2, /new/3).
   */
  async getMatches() {
    const urls = [
      `${this.baseUrl}/`,
      `${this.baseUrl}/new/2`,
      `${this.baseUrl}/new/3`
    ];

    try {
      const pagePromises = urls.map(async (url, idx) => {
        try {
          const html = await this.fetchPage.fire(url);
          return this._parseMatchCards(html, idx);
        } catch (err) {
          console.warn(`[SoccerFull] Failed to fetch page ${url}:`, err.message);
          return [];
        }
      });

      const settled = await Promise.allSettled(pagePromises);
      const seenIds = new Set();
      const allMatches = [];

      for (const res of settled) {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
          for (const match of res.value) {
            if (!seenIds.has(match.id)) {
              seenIds.add(match.id);
              allMatches.push(match);
            }
          }
        }
      }

      console.log(`[SoccerFull] Extracted ${allMatches.length} replay matches`);
      return allMatches;
    } catch (error) {
      console.error('[SoccerFull] Error fetching matches:', error.message);
      return [];
    }
  }

  /**
   * Resolves replay streams for a match.
   * Scrapes match page buttons, ignores live broadcasts, resolves Vixeo & Vidara direct HLS.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src) {
    const targetPath = (src && src.url) || sourceId || '';
    if (!targetPath) return [];

    const fullUrl = targetPath.startsWith('http') ? targetPath : `${this.baseUrl}${targetPath.startsWith('/') ? '' : '/'}${targetPath}`;

    try {
      // Check cached stream list for this match URL
      const cachedStreams = this._getCache(this._matchPageCache, fullUrl);
      if (cachedStreams) {
        return cachedStreams;
      }

      const matchHtml = await this.fetchPage.fire(fullUrl);
      const servers = this._extractServerOptions(matchHtml);

      if (servers.length === 0) {
        return [];
      }

      // Resolve each server option concurrently
      const resolvePromises = servers.map(server => this._resolveServerStream(server, fullUrl));
      const results = await Promise.allSettled(resolvePromises);

      const streams = [];
      const seenUrls = new Set();

      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          for (const s of r.value) {
            if (s && s.url && !seenUrls.has(s.url)) {
              seenUrls.add(s.url);
              streams.push(s);
            }
          }
        }
      }

      if (streams.length > 0) {
        this._setCache(this._matchPageCache, fullUrl, streams, 30 * 60 * 1000);
      }

      return streams;
    } catch (err) {
      console.error(`[SoccerFull] Error resolving streams for ${fullUrl}:`, err.message);
      return [];
    }
  }

  /**
   * Extracts server options from match page HTML, strictly ignoring live matches.
   */
  _extractServerOptions(html) {
    const servers = [];
    const seenSids = new Set();

    // 1. Parse video-server buttons: <a href="...?sid=16484" class="video-server ...">1st Half</a>
    const btnRegex = /<a[^>]+href="[^"]*?[?&]sid=(\d+)"[^>]*class="[^"]*video-server[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = btnRegex.exec(html)) !== null) {
      const sid = m[1];
      const label = m[2].replace(/<[^>]+>/g, '').trim();

      // STRICT USER REQUIREMENT: NO live matches!
      // Filter out any button that mentions "live"
      if (/\blive\b/i.test(label)) {
        continue;
      }

      if (!seenSids.has(sid)) {
        seenSids.add(sid);
        servers.push({ sid, label: label || 'Replay' });
      }
    }

    // 2. Also check if the default iframe has an SID not yet captured
    const defaultIframe = html.match(/<iframe[^>]+src=["']\/play\/(\d+)["']/i);
    if (defaultIframe && !seenSids.has(defaultIframe[1])) {
      servers.unshift({ sid: defaultIframe[1], label: 'Highlights' });
    }

    return servers;
  }

  /**
   * Resolves a single server SID into StreamEntity objects.
   */
  async _resolveServerStream(server, refererUrl) {
    const { sid, label } = server;
    const playUrl = `${this.baseUrl}/play/${sid}`;

    const cached = this._getCache(this._streamCache, playUrl);
    if (cached) return cached;

    try {
      const res = await undici.request(playUrl, {
        headers: {
          ...this.defaultHeaders,
          Referer: refererUrl
        },
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return [];
      const html = await res.body.text();

      // Extract iframe src
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (!iframeMatch) return [];

      const iframeSrc = iframeMatch[1];

      // Disallow any live embed hosts (like embed.st)
      if (/embed\.st/i.test(iframeSrc) || /\blive\b/i.test(iframeSrc)) {
        return [];
      }

      const streams = [];

      // A. Vixeo host (vixeo.io)
      if (iframeSrc.includes('vixeo.io')) {
        const streamUrl = await this.extractVixeo(iframeSrc);
        if (streamUrl) {
          const cleanLabel = this._formatPartLabel(label);
          streams.push(new StreamEntity({
            name: 'SoccerFull',
            title: `[VOD] ${cleanLabel} (1080p)`,
            resolution: '1080p',
            url: streamUrl,
            behaviorHints: {
              notWebReady: false
            }
          }));
        }
      }
      // B. Vidara host (vidaraa.cc / gbsagbo.com)
      else if (iframeSrc.includes('vidaraa.cc') || iframeSrc.includes('gbsagbo.com')) {
        const streamUrl = await this.extractVidara(iframeSrc);
        if (streamUrl) {
          const cleanLabel = this._formatPartLabel(label);
          streams.push(new StreamEntity({
            name: 'SoccerFull',
            title: `[VOD] ${cleanLabel} (1080p)`,
            resolution: '1080p',
            url: streamUrl,
            behaviorHints: {
              notWebReady: false
            }
          }));
        }
      }

      if (streams.length > 0) {
        this._setCache(this._streamCache, playUrl, streams, 30 * 60 * 1000);
      }

      return streams;
    } catch (err) {
      return [];
    }
  }

  /**
   * Normalizes part labels: "1st Half in En" -> "1st Half (EN)", "Highlight" -> "Highlights"
   */
  _formatPartLabel(label) {
    if (!label) return 'Full Match';
    let clean = label.trim();
    clean = clean.replace(/\bin\s+en\b/gi, '(EN)');
    clean = clean.replace(/\bhighlight\b/gi, 'Highlights');
    clean = clean.replace(/\b2st\b/gi, '2nd');
    return clean;
  }

  /**
   * Extracts direct CDN HLS URL from Vixeo (vixeo.io/e/<id>)
   * Zero server proxying, native open CORS.
   */
  async extractVixeo(vixeoUrl) {
    try {
      const res = await undici.request(vixeoUrl, {
        headers: {
          ...this.defaultHeaders,
          Referer: `${this.baseUrl}/`
        },
        headersTimeout: 6000,
        bodyTimeout: 6000
      });
      if (res.statusCode !== 200) return null;

      const html = await res.body.text();
      const match = html.match(/data-config=["']([^"']+)["']/i);
      if (!match) return null;

      const jsonStr = Buffer.from(match[1], 'base64').toString('utf8');
      const config = JSON.parse(jsonStr);
      if (!config.source) return null;

      // Hex string deobfuscation
      const p = config.source.replaceAll('|', '');
      let ascii = '';
      for (let i = 0; i < p.length; i += 2) {
        ascii += String.fromCharCode(parseInt(p.slice(i, i + 2), 16));
      }
      const streamUrl = [...ascii].reverse().join('');
      return streamUrl.startsWith('http') ? streamUrl : null;
    } catch (err) {
      console.warn(`[SoccerFull] Vixeo extraction failed for ${vixeoUrl}:`, err.message);
      return null;
    }
  }

  /**
   * Extracts direct CDN HLS URL from Vidara (vidaraa.cc/v/<filecode> or gbsagbo.com/e/<filecode>)
   * Zero server proxying, native open CORS.
   */
  async extractVidara(vidaraUrl) {
    try {
      const u = new URL(vidaraUrl);
      const pathParts = u.pathname.split('/').filter(Boolean);
      const filecode = pathParts[pathParts.length - 1];
      if (!filecode) return null;

      const apiUrl = 'https://gbsagbo.com/api/stream';
      const res = await undici.request(apiUrl, {
        method: 'POST',
        headers: {
          ...this.defaultHeaders,
          Referer: `https://gbsagbo.com/e/${filecode}`,
          Origin: 'https://gbsagbo.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filecode, device: 'desktop', codecs: ['h264', 'aac'] }),
        headersTimeout: 6000,
        bodyTimeout: 6000
      });

      if (res.statusCode !== 200) return null;
      const json = await res.body.json();
      if (json && json.streaming_url) {
        return json.streaming_url;
      }
      return null;
    } catch (err) {
      console.warn(`[SoccerFull] Vidara extraction failed for ${vidaraUrl}:`, err.message);
      return null;
    }
  }
}

module.exports = SoccerFullProvider;
