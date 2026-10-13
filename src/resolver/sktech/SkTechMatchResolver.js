'use strict';

const SkTechCrypto = require('./SkTechCrypto');
const SkTechEmbedExtractor = require('./SkTechEmbedExtractor');

const BASE_API_URL = 'https://dk01-64n.pages.dev/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class SkTechMatchResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_API_URL;
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
  async fetchLiveMatches() {
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
          title: `SK Tech | ${serverName} (CDN R2)`,
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
          title: `SK Tech | ${serverName} (DASH ClearKey)`,
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
          title: `SK Tech | ${serverName} (HLS Direct)`,
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
          title: `SK Tech | ${serverName}`,
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
