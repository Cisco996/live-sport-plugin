'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { BASE_URL } = require('../config');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const DEFAULT_REFERER = 'http://www.fawanews.sc/';
const DEFAULT_ORIGIN = 'http://www.fawanews.sc';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const PLAYLIST_FEEDS = [
  'https://fawasp.pages.dev/playlist.txt',
  'https://axsp.pages.dev/playlist.txt'
];

class Ak47LiveProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Ak47Live';
    this._cache = null;
    this._lastFetchTime = 0;
    let ttl = 180000;
    try {
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'cacheTtlMs')) {
        ttl = opts.cacheTtlMs;
      }
    } catch (_) {}
    this._cacheTtlMs = ttl;
  }

  normalizeCategory(cat) {
    if (!cat) return 'other';
    const raw = String(cat).toLowerCase();
    if (/(?:premier\s*league|la\s*liga|serie\s*a|bundesliga|ligue\s*1|champions\s*league|europa|conference\s*league|fa\s*cup|copa|a-league|aleague|mls|eredivisie|scotland)/i.test(raw)) {
      return 'football';
    }
    return super.normalizeCategory(cat);
  }

  /**
   * Parse an M3U playlist text into structured stream entries.
   * Extracts #EXTVLCOPT headers, #EXTINF metadata, and stream URLs.
   * Enforces strict Zero-DASH filter (discards .mpd and /dash/ links).
   */
  _parseM3u(content) {
    if (!content || typeof content !== 'string') return [];

    const lines = content.split(/\r?\n/);
    const entries = [];
    let currentVlcOpts = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTVLCOPT:')) {
        const optLine = line.substring(11).trim();
        const eqIdx = optLine.indexOf('=');
        if (eqIdx !== -1) {
          const key = optLine.substring(0, eqIdx).trim().toLowerCase();
          const val = optLine.substring(eqIdx + 1).trim();
          if (key === 'http-referrer') currentVlcOpts.referer = val;
          else if (key === 'http-origin') currentVlcOpts.origin = val;
          else if (key === 'http-user-agent') currentVlcOpts.userAgent = val;
        }
        continue;
      }

      if (line.startsWith('#EXTINF:')) {
        const infLine = line;
        // Group title
        const groupMatch = infLine.match(/group-title="([^"]*)"/i);
        const groupTitle = groupMatch ? groupMatch[1].trim() : 'Other';

        // tvg-name
        const nameMatch = infLine.match(/tvg-name="([^"]*)"/i);
        const tvgName = nameMatch ? nameMatch[1].trim() : '';

        // tvg-logo
        const logoMatch = infLine.match(/tvg-logo="([^"]*)"/i);
        const tvgLogo = logoMatch ? logoMatch[1].trim() : '';

        // Display name after comma
        const commaIdx = infLine.lastIndexOf(',');
        const rawTitle = commaIdx !== -1 ? infLine.substring(commaIdx + 1).trim() : tvgName;

        // Next non-comment line is the stream URL
        let streamUrl = '';
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine && !nextLine.startsWith('#')) {
            streamUrl = nextLine;
            i++;
            break;
          }
          i++;
        }

        if (!streamUrl) continue;

        // Strict Zero-DASH filter: discard MPEG-DASH manifests and CENC DRM URLs
        if (/\.mpd(\?|$)/i.test(streamUrl) || /\/dash\//i.test(streamUrl) || /cenc/i.test(streamUrl)) {
          currentVlcOpts = {};
          continue;
        }

        // Must be valid HLS (.m3u8) or HTTP live video stream
        if (!/^https?:\/\//i.test(streamUrl)) {
          currentVlcOpts = {};
          continue;
        }

        entries.push({
          rawTitle: rawTitle || tvgName,
          groupTitle,
          tvgLogo,
          streamUrl,
          referer: currentVlcOpts.referer || DEFAULT_REFERER,
          origin: currentVlcOpts.origin || DEFAULT_ORIGIN,
          userAgent: currentVlcOpts.userAgent || DEFAULT_UA
        });

        currentVlcOpts = {};
      }
    }

    return entries;
  }

  /**
   * Deconstructs raw title into base match title, clean teams, and channel label.
   * e.g. "Boxing : Fundora vs Hadribeaj --- CH 1" ->
   *   cleanTitle: "Fundora vs Hadribeaj", channelLabel: "CH 1"
   */
  _extractMatchInfo(rawTitle, groupTitle) {
    let title = rawTitle || '';

    // Extract channel suffix (e.g. "--- CH 1", "--- CH 2", "- CH 1", "CH 1")
    let channelLabel = 'HD';
    const chMatch = title.match(/[-–—\s]+(CH\s*\d+|Server\s*\d+|HD\s*SERVER\s*\d+|PPV\s*\d*)/i);
    if (chMatch) {
      channelLabel = chMatch[1].trim();
      title = title.replace(chMatch[0], '').trim();
    }

    // Strip redundant leading sport category prefix (e.g. "Boxing : ", "MMA : ")
    title = title.replace(/^(?:Boxing|MMA|UFC|AEW|WWE|Football|Soccer|Basketball|Baseball|Hockey)\s*:\s*/i, '').trim();

    // Clean up trailing dashes or delimiters
    title = title.replace(/[-–—\s]+$/, '').trim();

    // Parse team1 and team2 using TeamNameExtractor if possible, or fallback regex
    let team1 = null;
    let team2 = null;
    const derived = extractTeamsFromTitle(title);
    if (derived && derived.length === 2) {
      team1 = derived[0];
      team2 = derived[1];
    } else {
      const vsMatch = title.match(/^(.+?)\s+(?:vs\.?|v\.?|@)\s+(.+?)$/i);
      if (vsMatch) {
        team1 = vsMatch[1].trim();
        team2 = vsMatch[2].trim();
      }
    }

    // Canonical category
    const category = this.normalizeCategory(groupTitle);

    return {
      title: title || rawTitle,
      channelLabel,
      team1,
      team2,
      category
    };
  }

  /**
   * Ingests and aggregates live matches from AK47 playlists.
   * Deduplicates multiple stream channels under single MatchEntity cards.
   */
  async getMatches() {
    const now = Date.now();
    if (this._cache && (now - this._lastFetchTime) < this._cacheTtlMs) {
      return this._cache;
    }

    const matchesMap = new Map();

    await Promise.all(
      PLAYLIST_FEEDS.map(async (feedUrl) => {
        try {
          const res = await this.proxyFetch(feedUrl, {
            headers: { 'User-Agent': 'okhttp/4.9.2' },
            timeoutMs: 6000,
            attempts: 2
          });

          if (!res || res.status !== 200) return;
          const text = await res.text();
          const entries = this._parseM3u(text);

          for (const entry of entries) {
            const { title, channelLabel, team1, team2, category } = this._extractMatchInfo(entry.rawTitle, entry.groupTitle);

            // Canonical slug for grouping multi-channel mirrors
            const matchSlug = this.normalizeStr(title) || 'match';
            const matchId = `ak47_${matchSlug.replace(/\s+/g, '_')}`;

            const sourceObj = {
              source: 'ak47live',
              id: entry.streamUrl,
              channelName: channelLabel,
              referer: entry.referer,
              origin: entry.origin,
              userAgent: entry.userAgent,
              type: 'live'
            };

            if (matchesMap.has(matchId)) {
              const existing = matchesMap.get(matchId);
              // Avoid duplicate identical stream URLs
              const hasUrl = existing.sources.some(s => s.id === entry.streamUrl);
              if (!hasUrl) {
                existing.sources.push(sourceObj);
              }
            } else {
              const isMatchup = Boolean(team1 && team2);
              const match = new MatchEntity({
                id: matchId,
                title,
                category,
                league: entry.groupTitle || '',
                date: now.toString(),
                status: 'LIVE',
                team1: team1 ? { name: team1 } : null,
                team2: team2 ? { name: team2 } : null,
                thumbnail_url: isMatchup ? '' : (entry.tvgLogo || ''),
                poster: '',
                sources: [sourceObj]
              });
              matchesMap.set(matchId, match);
            }
          }
        } catch (err) {
          console.warn(`[${this.name}] Feed fetch failed for ${feedUrl}: ${err.message}`);
        }
      })
    );

    const matches = Array.from(matchesMap.values());
    this._cache = matches;
    this._lastFetchTime = now;
    return matches;
  }

  /**
   * Resolves a stream source into a playable StreamEntity with proxy headers.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streamUrl = src.id || sourceId;
    if (!streamUrl || typeof streamUrl !== 'string' || !streamUrl.startsWith('http')) {
      return [];
    }

    // Zero-DASH Enforcement: Reject any DASH streams
    if (/\.mpd(\?|$)/i.test(streamUrl) || /\/dash\//i.test(streamUrl) || /cenc/i.test(streamUrl)) {
      console.warn(`[${this.name}] Dropped DASH stream: ${streamUrl}`);
      return [];
    }

    const referer = src.referer || DEFAULT_REFERER;
    const origin = src.origin || DEFAULT_ORIGIN;
    const userAgent = src.userAgent || DEFAULT_UA;
    const channelLabel = src.channelName || 'HD';

    const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

    const stream = new StreamEntity({
      name: 'Ak47Live',
      title: `[${channelLabel}] ${matchTitle || 'Live Event'} (HD)`,
      url: proxyUrl,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            'Referer': referer,
            'Origin': origin,
            'User-Agent': userAgent
          }
        }
      },
      resolution: 'HD'
    });

    return [stream];
  }
}

module.exports = Ak47LiveProvider;
