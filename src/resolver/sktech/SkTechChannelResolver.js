'use strict';

const SkTechCrypto = require('./SkTechCrypto');
const SkTechEmbedExtractor = require('./SkTechEmbedExtractor');
const SkTechMatchResolver = require('./SkTechMatchResolver');

const BASE_API_URL = 'https://dk01-64n.pages.dev/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class SkTechChannelResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_API_URL;
    this._customCache = new Map();
    this._customCacheTime = new Map();
    this._m3uCache = new Map();
    this._m3uCacheTime = new Map();
  }

  /**
   * Ingest and decrypt all 24/7 TV channels & categories from `categories.txt`
   * Maps everything cleanly under category 'networks' and kickoff '0'
   * Unpacks multi-tier nested bouquets:
   * - Custom multi-channel groups (SPORTS WORLD, Hindi, Tamil, Telugu, Pakistan, Movies, News)
   * - Encrypted dynamic M3U playlists (BIG BOSS -> Cricket + Reality)
   * - Multi-channel M3U bouquets (SUN NXT with ClearKey, CRIC HD, USA/UK TV)
   *
   * @returns {Promise<Array<Object>>} Normalized 24/7 channel items
   */
  async fetchChannels() {
    let rawCategories = [];
    try {
      const url = `${this.baseUrl}categories.txt`;
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA },
        signal: AbortSignal.timeout(6000)
      });

      if (!res.ok) return [];

      const rawCiphertext = (await res.text()).trim();
      const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
      rawCategories = JSON.parse(decryptedJson);
    } catch (_) {
      return [];
    }

    const channels = [];

    for (let i = 0; i < rawCategories.length; i++) {
      const entry = rawCategories[i];
      const item = typeof entry.cat === 'string' ? JSON.parse(entry.cat) : entry.cat;
      if (!item || item.visible === false) continue;

      const name = (item.name || `Channel ${i + 1}`).trim();
      const logo = item.logo || '';
      const type = item.type || 'm3u';
      const api = item.api || '';

      // ────────────────────────────────────────────────────────────────────────
      // Tier 1: Custom channel group definitions (channels/<id>.txt)
      // ────────────────────────────────────────────────────────────────────────
      if (type === 'custom' && api) {
        try {
          const subChannels = await this.fetchCustomChannelGroup(api);
          if (subChannels && subChannels.length > 0) {
            const isSportsGroup = /sport|raw|smackdown|wwe/i.test(name) || api.includes('U1BPUlRTIFdPUkxE');
            const groupTag = isSportsGroup ? 'Sports Channels' : name;

            for (let j = 0; j < subChannels.length; j++) {
              const sub = subChannels[j];
              channels.push({
                id: `sktech_ch_cust_${i}_${j}`,
                title: sub.title || `${name} - ${j + 1}`,
                category: 'networks',
                kickoff: 0,
                type: 'pro',
                logo: sub.logo || logo,
                poster: sub.logo || logo,
                links: sub.links,
                group: groupTag
              });
            }
          }
        } catch (_) {}
      }
      // ────────────────────────────────────────────────────────────────────────
      // Tier 2: M3U Playlists (Direct feeds, multi-channel bouquets, encrypted workers)
      // ────────────────────────────────────────────────────────────────────────
      else if (type === 'm3u' && api) {
        try {
          let defaultGroup = name;
          if (/sun\s*nxt/i.test(name) || api.includes('sunxt.m3u')) defaultGroup = 'Sun NXT';
          else if (/cric\s*hd/i.test(name) || api.includes('CricketLive')) defaultGroup = 'Cricket';
          else if (/sports\s*event|fc\s*live/i.test(name)) defaultGroup = 'Sports Channels';
          else if (/boss/i.test(name)) defaultGroup = 'Big Boss';
          else if (/usa\s*live|usa\s*tv|prime\s*usa/i.test(name)) defaultGroup = 'USA TV';

          const subChannels = await this.fetchM3uBouquet(api, defaultGroup);
          if (subChannels && subChannels.length > 0) {
            // Limit massive playlists (e.g. 5,600+ USA channels) to top 250 to protect memory and responsiveness
            const maxChannels = Math.min(subChannels.length, 250);

            for (let j = 0; j < maxChannels; j++) {
              const sub = subChannels[j];
              channels.push({
                id: `sktech_ch_m3u_${i}_${j}`,
                title: sub.title,
                category: 'networks',
                kickoff: 0,
                type: 'direct_m3u',
                logo: sub.logo || logo,
                poster: sub.logo || logo,
                url: sub.url,
                headers: sub.headers,
                drmScheme: sub.drmScheme,
                drmLicense: sub.drmLicense,
                group: sub.group || defaultGroup
              });
            }
          }
        } catch (_) {}
      }
    }

    return channels;
  }

  /**
   * Resolves and parses a multi-channel M3U playlist with 5-minute in-memory caching
   * Automatically decrypts encrypted worker responses (like BIG BOSS / [rts])
   *
   * @param {string} rawApi - M3U URL with possible pipe delimiter or worker token
   * @param {string} defaultGroup - Fallback group title
   * @returns {Promise<Array<Object>>} Constituent channel objects
   */
  async fetchM3uBouquet(rawApi, defaultGroup = 'Live TV') {
    if (!rawApi) return [];

    const now = Date.now();
    const lastTime = this._m3uCacheTime.get(rawApi) || 0;
    if (this._m3uCache.has(rawApi) && now - lastTime < CACHE_TTL_MS) {
      return this._m3uCache.get(rawApi);
    }

    const parsed = SkTechEmbedExtractor.parseDelimited(rawApi);
    if (!parsed.url) return [];

    try {
      const res = await fetch(parsed.url, {
        headers: {
          'User-Agent': parsed.headers['User-Agent'] || DEFAULT_UA,
          'Accept': '*/*',
          ...parsed.headers
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) return [];

      const rawText = (await res.text()).trim();
      // If response is encrypted (like BIG BOSS), decrypt via reversed Dalvik algorithm
      const m3uContent = SkTechCrypto.decryptM3u(rawText);

      const items = this.parseM3uBouquet(m3uContent, defaultGroup, parsed.headers);
      this._m3uCache.set(rawApi, items);
      this._m3uCacheTime.set(rawApi, now);
      return items;
    } catch (_) {
      return [];
    }
  }

  /**
   * Parses an M3U playlist into discrete channel objects
   * Fully supports EXTINF tags, group-title, tvg-logo, #KODIPROP clearkey, and EXTVLCOPT headers
   *
   * @param {string} m3uText
   * @param {string} defaultGroup
   * @param {Object} defaultHeaders
   * @returns {Array<Object>}
   */
  parseM3uBouquet(m3uText, defaultGroup = 'Live TV', defaultHeaders = {}) {
    if (!m3uText || typeof m3uText !== 'string') return [];

    const channels = [];
    const lines = m3uText.split(/\r?\n/);

    let currentTitle = '';
    let currentLogo = '';
    let currentGroup = defaultGroup;
    let currentLang = '';
    let currentDrmScheme = null;
    let currentDrmLicense = null;
    let currentHeaders = { ...defaultHeaders };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        // Extract channel title after last comma
        const commaIdx = line.indexOf(',');
        if (commaIdx !== -1) {
          currentTitle = line.slice(commaIdx + 1).trim();
        }

        // Extract group-title="..."
        const groupMatch = line.match(/group-title="([^"]+)"/i);
        if (groupMatch && groupMatch[1].trim()) {
          currentGroup = groupMatch[1].trim();
        }

        // Extract tvg-logo="..."
        const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
        if (logoMatch && logoMatch[1].trim()) {
          currentLogo = logoMatch[1].trim();
        }

        // Extract tvg-language="..."
        const langMatch = line.match(/tvg-language="([^"]+)"/i);
        if (langMatch && langMatch[1].trim()) {
          currentLang = langMatch[1].trim();
        }
      } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
        const val = line.split('=')[1].trim().toLowerCase();
        if (val.includes('clearkey')) currentDrmScheme = 'clearkey';
        else if (val.includes('widevine')) currentDrmScheme = 'widevine';
      } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
        currentDrmLicense = line.split('=')[1].trim();
      } else if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
        currentHeaders['User-Agent'] = line.split('=')[1].trim();
      } else if (line.startsWith('#EXTVLCOPT:http-referer=') || line.startsWith('#EXTVLCOPT:http-referrer=')) {
        currentHeaders['Referer'] = line.split('=')[1].trim();
      } else if (line.startsWith('#EXTVLCOPT:http-origin=')) {
        currentHeaders['Origin'] = line.split('=')[1].trim();
      } else if (line.startsWith('#EXTHTTP:')) {
        try {
          const rawJson = line.slice(9).trim();
          const parsed = JSON.parse(rawJson);
          Object.assign(currentHeaders, parsed);
        } catch (_) {}
      } else if (line.startsWith('http://') || line.startsWith('https://')) {
        const parsed = SkTechEmbedExtractor.parseDelimited(line);
        const streamUrl = parsed.url;
        const mergedHeaders = { ...currentHeaders, ...parsed.headers };

        if (streamUrl) {
          const t = currentTitle || '';
          const g = currentGroup || '';
          const isRadio = g.startsWith('Radio_') || /\b(radio|fm|podcast)\b/i.test(t) || /\bradio\b/i.test(g);
          const isOfflineOrGeo = /\[geo-blocked\]|\[not 24\/7\]|\(offline\)|\[offline\]|\(unavailable\)|\[dead\]|\[off air\]|\[not working\]|\[testing\]/i.test(t);
          const isPlaceholder = /download sk tech|placeholder/i.test(t);
          const isDeadHost = /aalmaruf1702/i.test(streamUrl);

          if (!isRadio && !isOfflineOrGeo && !isPlaceholder && !isDeadHost) {
            channels.push({
              title: currentTitle || `Channel ${channels.length + 1}`,
              logo: currentLogo,
              group: currentGroup,
              language: currentLang,
              url: streamUrl,
              headers: mergedHeaders,
              drmScheme: currentDrmScheme || parsed.drmScheme,
              drmLicense: currentDrmLicense || parsed.drmLicense
            });
          }
        }

        // Reset per-channel state
        currentTitle = '';
        currentLogo = '';
        currentGroup = defaultGroup;
        currentLang = '';
        currentDrmScheme = null;
        currentDrmLicense = null;
        currentHeaders = { ...defaultHeaders };
      }
    }

    return channels;
  }

  /**
   * Resolves a custom channel group into its constituent stream items
   *
   * @param {string} customApiPath - e.g. `channels/RVBJQyBPTjE3Njg1MDQ2NzY4MTI.txt`
   * @returns {Promise<Array<Object>>} Channel items with individual stream links
   */
  async fetchCustomChannelGroup(customApiPath) {
    if (!customApiPath) return [];

    const now = Date.now();
    const lastTime = this._customCacheTime.get(customApiPath) || 0;
    if (this._customCache.has(customApiPath) && now - lastTime < CACHE_TTL_MS) {
      return this._customCache.get(customApiPath);
    }

    const url = customApiPath.startsWith('http') ? customApiPath : `${this.baseUrl}${customApiPath}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA },
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) return [];

      const rawCiphertext = (await res.text()).trim();
      const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
      const rawItems = JSON.parse(decryptedJson);

      const subChannels = [];
      for (let i = 0; i < rawItems.length; i++) {
        const entry = rawItems[i];
        const ch = typeof entry.channel === 'string' ? JSON.parse(entry.channel) : entry.channel;
        if (!ch) continue;

        subChannels.push({
          id: `sktech_subch_${i}`,
          title: ch.name || `Channel ${i + 1}`,
          logo: ch.logo || '',
          links: ch.links || '',
          linkNames: ch.link_names || ['FHD']
        });
      }

      this._customCache.set(customApiPath, subChannels);
      this._customCacheTime.set(customApiPath, now);
      return subChannels;
    } catch (_) {
      return [];
    }
  }

  /**
   * Resolves a 24/7 channel item into playable Stremio StreamEntities
   * Strict Constraints: 0 Server Bandwidth, 0 Cloudflare Workers
   *
   * @param {Object} channel - Normalized channel object from fetchChannels()
   * @returns {Promise<Array<Object>>} Playable stream entities
   */
  async resolveChannelStream(channel) {
    if (!channel) return [];

    // Case 0: Pre-unpacked channel from M3U bouquet (e.g. Big Boss, Sun NXT, CricHD)
    if (channel.url && channel.type === 'direct_m3u') {
      const parsed = SkTechEmbedExtractor.parseDelimited(channel.url);
      const streamHeaders = Object.keys(channel.headers || {}).length > 0 ? channel.headers : parsed.headers;

      let clearkeyObj = undefined;
      if (channel.drmScheme === 'clearkey' && channel.drmLicense) {
        if (channel.drmLicense.includes(':')) {
          const [keyId, key] = channel.drmLicense.split(':');
          clearkeyObj = { keyId, key };
        } else {
          try {
            clearkeyObj = JSON.parse(channel.drmLicense);
          } catch (_) {}
        }
      }

      return [{
        name: '⚡ Direct Stream',
        title: `SK Tech | ${channel.title}${channel.group ? ' (' + channel.group + ')' : ''}`,
        url: parsed.url || channel.url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: streamHeaders
          }
        },
        clearkey: clearkeyObj,
        score: 95
      }];
    }

    // Case 1: Custom channel item with link definition (`pro/<id>.txt`)
    const linkPath = channel.links || (channel.type === 'pro' ? channel.api : '');
    if (linkPath && linkPath.startsWith('pro/')) {
      return await SkTechMatchResolver.resolveMatchStreams(linkPath, channel.title);
    }

    // Case 2: Custom channel pointing to a group definition (`channels/<id>.txt`)
    if (channel.type === 'custom' && channel.api) {
      const groupItems = await this.fetchCustomChannelGroup(channel.api);
      if (groupItems.length > 0 && groupItems[0].links) {
        return await SkTechMatchResolver.resolveMatchStreams(groupItems[0].links, channel.title);
      }
    }

    // Case 3: Direct M3U feed (e.g. FanCode, Sony Live, JioTV+)
    const targetUrl = channel.api || channel.url || '';
    if (targetUrl) {
      const parsed = SkTechEmbedExtractor.parseDelimited(targetUrl);
      if (!parsed.url) return [];

      // If URL points to an .m3u playlist, parse constituent streams
      if (parsed.url.toLowerCase().includes('.m3u')) {
        try {
          const res = await fetch(parsed.url, {
            headers: parsed.headers,
            signal: AbortSignal.timeout(6000)
          });
          if (res.ok) {
            const m3uText = await res.text();
            const channels = this.parseM3uBouquet(m3uText, channel.title, parsed.headers);
            const streams = [];

            for (const ch of channels) {
              streams.push({
                name: '⚡ Direct Stream',
                title: `SK Tech | ${ch.title}`,
                url: ch.url,
                behaviorHints: {
                  notWebReady: true,
                  proxyHeaders: {
                    request: ch.headers
                  }
                },
                score: 90
              });
            }

            if (streams.length > 0) {
              return streams;
            }
          }
        } catch (_) {}
      }

      return [{
        name: '⚡ Direct Stream',
        title: `SK Tech | ${channel.title} (24/7 Live)`,
        url: parsed.url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: parsed.headers
          }
        },
        score: 95
      }];
    }

    return [];
  }
}

module.exports = new SkTechChannelResolver();
