'use strict';

const SkTechCrypto = require('./SkTechCrypto');
const SkTechEmbedExtractor = require('./SkTechEmbedExtractor');
const SkTechMatchResolver = require('./SkTechMatchResolver');

const BASE_API_URL = 'https://dk01-64n.pages.dev/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class SkTechChannelResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_API_URL;
    this._customCache = new Map();
    this._customCacheTime = 0;
  }

  /**
   * Ingest and decrypt all 24/7 TV channels & categories from `categories.txt`
   * Maps everything cleanly under category 'networks' and kickoff '0'
   *
   * @returns {Promise<Array<Object>>} Normalized 24/7 channel items
   */
  async fetchChannels() {
    let rawCategories = [];
    try {
      const url = `${this.baseUrl}categories.txt`;
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA }
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

      // Sub-type A: Custom channel group (e.g. channels/<id>.txt)
      if (type === 'custom' && api) {
        // Expand high-value sports channels (SPORTS WORLD, WWE RAW, SmackDown, etc.)
        const isPriorityGroup = api.includes('U1BPUlRTIFdPUkxE') ||
          /sport|raw|smackdown/i.test(name);

        if (isPriorityGroup) {
          try {
            const subChannels = await this.fetchCustomChannelGroup(api);
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
                group: name
              });
            }
            continue;
          } catch (_) {}
        }

        // Generic custom group item fallback
        channels.push({
          id: `sktech_ch_custom_${i}`,
          title: name,
          category: 'networks',
          kickoff: 0,
          type: 'custom',
          logo,
          poster: logo,
          api
        });
      }
      // Sub-type B: Direct M3U stream entry
      else if (type === 'm3u' && api) {
        channels.push({
          id: `sktech_ch_m3u_${i}`,
          title: name,
          category: 'networks', // 24/7 live network
          kickoff: 0,           // signals continuous stream in Nuvio catalog
          type: 'm3u',
          logo,
          poster: logo,
          api
        });
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
    if (this._customCache.has(customApiPath) && now - this._customCacheTime < 300000) {
      return this._customCache.get(customApiPath);
    }

    const url = customApiPath.startsWith('http') ? customApiPath : `${this.baseUrl}${customApiPath}`;

    try {
      const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA } });
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
      this._customCacheTime = now;
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
            const lines = m3uText.split(/\r?\n/);
            const streams = [];
            let currentTitle = '';

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line.startsWith('#EXTINF:')) {
                const commaIdx = line.indexOf(',');
                currentTitle = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : '';
              } else if (line.startsWith('http')) {
                const streamParsed = SkTechEmbedExtractor.parseDelimited(line);
                if (streamParsed.url) {
                  streams.push({
                    name: '⚡ Direct Stream',
                    title: `SK Tech | ${currentTitle || channel.title}`,
                    url: streamParsed.url,
                    behaviorHints: {
                      notWebReady: true,
                      proxyHeaders: {
                        request: Object.keys(streamParsed.headers).length > 0 ? streamParsed.headers : parsed.headers
                      }
                    },
                    score: 90
                  });
                }
                currentTitle = '';
              }
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
