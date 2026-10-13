'use strict';

const SkTechCrypto = require('./SkTechCrypto');
const SkTechEmbedExtractor = require('./SkTechEmbedExtractor');

const BASE_API_URL = 'https://dk01-64n.pages.dev/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DYNAMIC_EVENT_FEEDS = [
  { label: 'FanCode', url: 'https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.m3u' },
  { label: 'Sony LIV', url: 'https://nonyliv.saqlainhaider8198.workers.dev/nony2.m3u' }
];

class SkTechMatchResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_API_URL;
    this._dynamicCache = null;
    this._dynamicCacheTime = 0;
    this._eventStreamCache = new Map();
  }

  /**
   * Helper to normalize category names into canonical Nuvio sport categories
   */
  normalizeCategory(cat) {
    if (!cat) return 'other';
    const c = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (c.includes('soccer') || c.includes('football') || c.includes('laliga') || c.includes('seriea') || c.includes('bundesliga') || c.includes('premierleague')) return 'football';
    if (c.includes('cricket') || c.includes('ipl') || c.includes('t20')) return 'cricket';
    if (c.includes('basketball') || c.includes('nba')) return 'basketball';
    if (c.includes('boxing') || c.includes('wwe') || c.includes('aew') || c.includes('ufc') || c.includes('fight') || c.includes('mma') || c.includes('tna')) return 'mma';
    if (c.includes('motogp') || c.includes('formula1') || c.includes('f1') || c.includes('racing') || c.includes('rally') || c.includes('cycling')) return 'motorsport';
    if (c.includes('tennis') || c.includes('atp') || c.includes('wta')) return 'tennis';
    if (c.includes('baseball') || c.includes('mlb')) return 'baseball';
    if (c.includes('hockey') || c.includes('nhl')) return 'hockey';
    return 'other';
  }

  /**
   * Cleans raw M3U titles by stripping language tags, emojis, and brackets
   */
  cleanEventTitle(rawTitle, tvgName = '') {
    let title = (tvgName && /\bvs\b/i.test(tvgName)) ? tvgName : (rawTitle || tvgName || '');
    title = title.replace(/^(?:ENG|HIN|BEN|TAM|TEL|MAL|KAN|MAR|GUJ|PUN|URD|SPA|POR|ARA)\s*\|\s*/i, '');
    title = title.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u, '');
    title = title.replace(/^\[[^\]]+\]\s*/, '');
    title = title.replace(/\s*-\s*(?:MD\s*\d+\s*-\s*)?\d{1,2}\s+[A-Za-z]+\s+\d{4}.*$/i, '');
    title = title.replace(/\s*\[LIVE\].*$/i, '');
    title = title.replace(/\s*\|\s*(?:Español|English|Hindi).*$/i, '');
    title = title.replace(/\s+\d+\s*\([^)]+\)$/, '');
    title = title.replace(/\s+Vs\s+/i, ' vs ').trim();
    return title;
  }

  /**
   * Retrieves cached direct event stream metadata by source ID
   */
  getEventStream(sourceId) {
    return this._eventStreamCache.get(sourceId) || null;
  }

  /**
   * Parses SK Tech date ("DD/MM/YYYY") and time ("HH:MM:SS") into an epoch millisecond timestamp
   */
  parseKickoff(dateStr, timeStr) {
    try {
      if (!dateStr) return 0;
      const [d, m, y] = dateStr.split('/').map(Number);
      const timeParts = (timeStr || '00:00:00').split(':').map(Number);
      const hour = timeParts[0] || 0;
      const min = timeParts[1] || 0;
      const sec = timeParts[2] || 0;
      return Date.UTC(y, m - 1, d, hour, min, sec);
    } catch (_) {
      return 0;
    }
  }

  /**
   * Ingest and decrypt all live sports events from `events.txt`
   * @returns {Promise<Array<Object>>} Normalized live fixtures
   */
  async fetchEventsTxtMatches() {
    const url = `${this.baseUrl}events.txt`;
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA }
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch events.txt: HTTP ${res.status}`);
    }

    const rawCiphertext = (await res.text()).trim();
    const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
    const rawEvents = JSON.parse(decryptedJson);

    const matches = [];

    for (let i = 0; i < rawEvents.length; i++) {
      const entry = rawEvents[i];
      const item = typeof entry.event === 'string' ? JSON.parse(entry.event) : entry.event;
      if (!item) continue;

      const teamA = (item.teamAName || '').trim();
      const teamB = (item.teamBName || '').trim();
      const eventName = (item.eventName || '').trim();

      const title = (teamA && teamB)
        ? `${teamA} vs ${teamB}`
        : (eventName || teamA || 'Live Sports Event');

      const category = this.normalizeCategory(item.category);
      const kickoff = this.parseKickoff(item.date, item.time);
      const linkPath = item.links || '';

      matches.push({
        id: `sktech_match_${i}_${Buffer.from(linkPath).toString('base64url').slice(0, 16)}`,
        title,
        category,
        kickoff,
        rawCategory: item.category,
        linkPath,
        linkNames: item.link_names || [],
        teamA: { name: teamA, logo: item.teamAFlag || '' },
        teamB: { name: teamB, logo: item.teamBFlag || '' },
        poster: item.eventLogo || item.teamAFlag || ''
      });
    }

    return matches;
  }

  /**
   * Fetches and unpacks discrete live sports events from dynamic M3U event feeds
   * (e.g. FanCode, Sony LIV) into distinct MatchEntities with playable direct HLS streams.
   *
   * @returns {Promise<Array<Object>>}
   */
  async fetchDynamicM3uMatches() {
    const now = Date.now();
    if (this._dynamicCache && (now - this._dynamicCacheTime < 180000)) {
      return this._dynamicCache;
    }

    const matches = [];
    const matchMap = new Map();

    const feedPromises = DYNAMIC_EVENT_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': DEFAULT_UA },
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) return;

        const text = await res.text();
        const lines = text.split(/\r?\n/);

        let curMeta = null;
        let curOpts = {};

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          if (line.startsWith('#EXTINF:')) {
            curMeta = {};
            curOpts = {};
            const idM = line.match(/tvg-id="([^"]+)"/i);
            const nameM = line.match(/tvg-name="([^"]+)"/i);
            const logoM = line.match(/tvg-logo="([^"]+)"/i);
            const langM = line.match(/tvg-language="([^"]+)"/i);
            const groupM = line.match(/group-title="([^"]+)"/i);
            const commaIdx = line.indexOf(',');

            curMeta.tvgId = idM ? idM[1] : '';
            curMeta.tvgName = nameM ? nameM[1] : '';
            curMeta.logo = logoM ? logoM[1] : '';
            curMeta.lang = langM ? langM[1] : '';
            curMeta.group = groupM ? groupM[1] : '';
            curMeta.rawTitle = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : '';
          } else if (line.startsWith('#EXTVLCOPT:')) {
            const opt = line.slice(11).trim();
            const [k, v] = opt.split('=');
            if (k && v) {
              if (/referrer/i.test(k)) curOpts['Referer'] = v;
              if (/user-agent/i.test(k)) curOpts['User-Agent'] = v;
            }
          } else if (line.startsWith('http') && curMeta) {
            const parsed = SkTechEmbedExtractor.parseDelimited(line);
            if (parsed.url) {
              const clean = this.cleanEventTitle(curMeta.rawTitle, curMeta.tvgName);
              const cat = this.normalizeCategory(curMeta.group);
              const mapKey = `${cat}:${clean.toLowerCase()}`;
              const feedKey = feed.label.toLowerCase().replace(/[^a-z0-9]/g, '');
              const srcId = `m3u_${feedKey}_${curMeta.tvgId || Math.random().toString(36).slice(2, 8)}_${(curMeta.lang || 'def').toLowerCase()}`;

              const srcObj = {
                source: 'sktech',
                id: srcId,
                channelName: curMeta.lang ? `${feed.label} (${curMeta.lang})` : feed.label,
                type: 'fancode_direct',
                streamUrl: parsed.url,
                streamHeaders: { ...curOpts, ...parsed.headers },
                streamTitle: curMeta.lang && curMeta.lang.toLowerCase() !== 'english'
                  ? `SK Tech (${feed.label} ${curMeta.lang})`
                  : `SK Tech (${feed.label})`
              };

              this._eventStreamCache.set(srcId, srcObj);

              if (matchMap.has(mapKey)) {
                matchMap.get(mapKey).sources.push(srcObj);
              } else {
                const teamParts = clean.split(/\s+(?:vs?\.?|@|[-–—])\s+/i);
                const teamA = teamParts.length === 2 ? { name: teamParts[0].trim(), logo: '' } : null;
                const teamB = teamParts.length === 2 ? { name: teamParts[1].trim(), logo: '' } : null;

                const matchObj = {
                  id: `sktech_ev_${feedKey}_${curMeta.tvgId || Math.random().toString(36).slice(2, 8)}`,
                  title: clean,
                  category: cat,
                  kickoff: Date.now(),
                  rawCategory: curMeta.group || `${feed.label} Live`,
                  teamA,
                  teamB,
                  poster: curMeta.logo,
                  sources: [srcObj]
                };

                matchMap.set(mapKey, matchObj);
                matches.push(matchObj);
              }
            }
            curMeta = null;
            curOpts = {};
          }
        }
      } catch (_) {}
    });

    await Promise.allSettled(feedPromises);

    this._dynamicCache = matches;
    this._dynamicCacheTime = now;
    return matches;
  }

  /**
   * Unified ingestion of both Pillar 1A (events.txt) and Pillar 1B (FanCode & Sony LIV M3Us)
   * @returns {Promise<Array<Object>>}
   */
  async fetchLiveMatches() {
    const [eventsTxtMatches, dynamicM3uMatches] = await Promise.all([
      this.fetchEventsTxtMatches().catch(() => []),
      this.fetchDynamicM3uMatches().catch(() => [])
    ]);

    return [...eventsTxtMatches, ...dynamicM3uMatches];
  }

  /**
   * Resolves direct playable streams for a given event link definition (`pro/<id>.txt`)
   * Strict Constraints: 0 Server Bandwidth, 0 Cloudflare Workers
   * Prioritizes direct HLS streams first, followed by Cloudflare R2, embeds, and ClearKey DASH.
   *
   * @param {string} linkPath - Path to the event link file (e.g. `pro/xyz.txt`)
   * @param {string} matchTitle - Title of the fixture
   * @returns {Promise<Array<Object>>} Playable stream entities
   */
  async resolveMatchStreams(linkPath, matchTitle = '') {
    if (!linkPath) return [];

    let rawOptions = [];
    try {
      const url = linkPath.startsWith('http') ? linkPath : `${this.baseUrl}${linkPath}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA }
      });

      if (!res.ok) {
        return [];
      }

      const rawCiphertext = (await res.text()).trim();
      const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
      rawOptions = JSON.parse(decryptedJson);
    } catch (_) {
      return [];
    }

    const hlsStreams = [];
    const r2Streams = [];
    const embedStreams = [];
    const dashStreams = [];

    for (const opt of rawOptions) {
      const serverName = opt.name || 'HD Server';
      const rawLink = opt.link || '';
      const api = opt.api || '';
      const tokenApi = opt.tokenApi || '';

      // Case 1: Dynamic tokenApi Embed
      if (tokenApi) {
        try {
          const resolved = await SkTechEmbedExtractor.resolveTokenApi(tokenApi);
          if (resolved && resolved.url) {
            embedStreams.push({
              name: '⚡ Direct Stream',
              title: `SK Tech | ${serverName} (Web Source)`,
              url: resolved.url,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: {
                  request: resolved.headers
                }
              },
              score: 80
            });
          }
        } catch (_) {}
        continue;
      }

      if (!rawLink) continue;

      const parsed = SkTechEmbedExtractor.parseDelimited(rawLink);
      if (!parsed.url) continue;

      // Case 2: Cloudflare R2 Direct Video
      if (parsed.url.includes('.r2.dev')) {
        r2Streams.push({
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName ? `${serverName} • R2` : 'R2 Fast'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 95
        });
      }
      // Case 3: Akamai / AWS DASH with ClearKey
      else if (parsed.url.includes('.mpd') || api.includes(':')) {
        const streamObj = {
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName ? `${serverName} • DASH` : 'DASH ClearKey'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 75
        };
        if (api && api.includes(':')) {
          streamObj.clearkey = api;
        }
        dashStreams.push(streamObj);
      }
      // Case 4: Standard Direct HLS (.m3u8)
      else if (parsed.url.includes('.m3u8') || parsed.url.includes('amagi.tv') || parsed.url.includes('redbull.tv')) {
        hlsStreams.push({
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName || 'HLS Server'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 90
        });
      }
      // Case 5: Generic direct link
      else {
        hlsStreams.push({
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName || 'Live Server'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 85
        });
      }
    }

    // Prioritize direct HLS & R2 first, then embeds, then DASH ClearKey
    return [...hlsStreams, ...r2Streams, ...embedStreams, ...dashStreams];
  }
}

module.exports = new SkTechMatchResolver();
