'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Dual-Ping Auth Token Manager ───────────────────────────────────────────
// Centralized token ring shared across all requests.
// Implements primary (vypn.net) -> fallback (lokke.app) failover.
// Proactive background refresh when < 3 minutes remain before expiration.

class VavooTokenManager {
  constructor() {
    this.sig = null;
    this.validUntil = 0;
    this.refreshPromise = null;
    this.activeSource = null;
  }

  isValid() {
    return Boolean(this.sig && Date.now() < this.validUntil);
  }

  needsRefresh() {
    return !this.sig || Date.now() > (this.validUntil - 3 * 60 * 1000);
  }

  _parseValidUntil(addonSig) {
    let validUntil = Date.now() + 20 * 60 * 1000; // 20-minute default
    try {
      const decoded = JSON.parse(Buffer.from(String(addonSig), 'base64').toString('utf8'));
      const dataObj = typeof decoded.data === 'string' ? JSON.parse(decoded.data) : decoded.data;
      if (typeof dataObj?.validUntil === 'number') {
        validUntil = dataObj.validUntil;
      }
    } catch (_) {
      // Keep default
    }
    return validUntil;
  }

  async _pingVypn(fetchFn) {
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const nowMs = Date.now();
    const pingBody = {
      token: '',
      reason: 'app-focus',
      locale: 'de',
      theme: 'dark',
      metadata: {
        device: { type: 'phone', uniqueId },
        os: { name: 'android', version: '14', abis: ['arm64-v8a'], host: 'android' },
        app: { platform: 'android' },
        version: { package: 'net.vypn.app', binary: '1.4.1', js: '1.4.1' }
      },
      appFocusTime: 0,
      playerActive: false,
      playDuration: 0,
      devMode: false,
      hasAddon: true,
      castConnected: false,
      package: 'net.vypn.app',
      version: '1.4.1',
      process: 'app',
      firstAppStart: nowMs - 86400000,
      lastAppStart: nowMs,
      ipLocation: null,
      adblockEnabled: true,
      migrationApplied: false,
      migrationTargetInstalled: false,
      proxy: { supported: ['ss'], engine: 'Mu', ssVersion: '2022', enabled: false, autoServer: true, id: '' },
      iap: { supported: false, error: '' }
    };

    const res = await fetchFn('https://www.vypn.net/api/app/ping', {
      method: 'POST',
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'accept': 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'Accept-Language': 'de'
      },
      body: JSON.stringify(pingBody),
      timeoutMs: 8000
    });

    if (!res.ok) throw new Error(`vypn.net ping returned HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.addonSig) throw new Error('vypn.net ping response missing addonSig');
    return { sig: j.addonSig, validUntil: this._parseValidUntil(j.addonSig), source: 'vypn.net' };
  }

  async _pingLokke(fetchFn) {
    const now = Date.now();
    const pingBody = {
      token: "ldCvE092e7gER0rVIajfsXIvRhwlrAzP6_1oEJ4q6HH89QHt24v6NNL_jQJO219hiLOXF2hqEfsUuEWitEIGN4EaHHEHb7Cd7gojc5SQYRFzU3XWo_kMeryAUbcwWnQrnf0-",
      reason: "app-blur",
      locale: "de",
      theme: "dark",
      metadata: {
        device: { type: "Handset", brand: "google", model: "Nexus", name: "21081111RG", uniqueId: "a1b2c3d4e5f60718" },
        os: { name: "android", version: "7.1.2", abis: ["arm64-v8a"], host: "android" },
        app: { platform: "android", version: "1.1.0", buildId: "97215000", engine: "hbc85", signatures: ["6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e"], installer: "com.android.vending" },
        version: { package: "app.lokke.main", binary: "1.1.0", js: "1.1.0" },
        platform: { isAndroid: true, isIOS: false, isTV: false, isWeb: false, isMobile: true, isWebTV: false, isElectron: false }
      },
      appFocusTime: 0,
      playerActive: false,
      playDuration: 0,
      devMode: true,
      hasAddon: true,
      castConnected: false,
      package: "app.lokke.main",
      version: "1.1.0",
      process: "app",
      firstAppStart: now - 86400000,
      lastAppStart: now,
      ipLocation: null,
      adblockEnabled: false,
      proxy: { supported: ["ss", "openvpn"], engine: "openvpn", ssVersion: 1, enabled: false, autoServer: true, id: "fi-hel" },
      iap: { supported: true }
    };

    const res = await fetchFn('https://www.lokke.app/api/app/ping', {
      method: 'POST',
      headers: {
        'user-agent': 'okhttp/4.11.0',
        'accept': 'application/json',
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(pingBody),
      timeoutMs: 8000
    });

    if (!res.ok) throw new Error(`lokke.app ping returned HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.addonSig) throw new Error('lokke.app ping response missing addonSig');
    return { sig: j.addonSig, validUntil: this._parseValidUntil(j.addonSig), source: 'lokke.app' };
  }

  async _fetchDualSig(fetchFn = fetch) {
    // 1. Try Primary: vypn.net
    try {
      return await this._pingVypn(fetchFn);
    } catch (vypnErr) {
      console.warn(`[VavooProvider] Primary ping (vypn.net) failed: ${vypnErr.message}. Failing over to lokke.app...`);
    }

    // 2. Try Fallback: lokke.app
    try {
      return await this._pingLokke(fetchFn);
    } catch (lokkeErr) {
      console.error(`[VavooProvider] Secondary ping (lokke.app) failed: ${lokkeErr.message}.`);
      throw new Error(`Dual-ping authentication exhausted: vypn.net & lokke.app both unreachable.`);
    }
  }

  async getOrRefreshSig(fetchFn = fetch) {
    // Fast path: cached token is valid and not yet in refresh window
    if (this.isValid() && !this.needsRefresh()) {
      return this.sig;
    }

    // Proactive background refresh: still valid, but within 3 mins of expiry
    if (this.isValid() && this.needsRefresh() && !this.refreshPromise) {
      this.refreshPromise = this._fetchDualSig(fetchFn)
        .then(result => {
          this.sig = result.sig;
          this.validUntil = result.validUntil;
          this.activeSource = result.source;
        })
        .catch(err => console.warn('[VavooProvider] Background token refresh failed:', err.message))
        .finally(() => {
          this.refreshPromise = null;
        });
      // Return currently valid signature without blocking the user
      return this.sig;
    }

    // If a refresh is already underway, await it
    if (this.refreshPromise) {
      await this.refreshPromise;
      if (this.isValid()) return this.sig;
    }

    // Hard refresh: token missing or expired
    this.refreshPromise = this._fetchDualSig(fetchFn)
      .then(result => {
        this.sig = result.sig;
        this.validUntil = result.validUntil;
        this.activeSource = result.source;
        return result.sig;
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return await this.refreshPromise;
  }
}

// Global singleton token manager instance
const globalTokenManager = new VavooTokenManager();

// ─── Channel Catalog (lazy-loaded singleton) ────────────────────────────────
let _vavooCatalog = null;
function getVavooCatalog() {
  if (!_vavooCatalog) {
    const candidates = [
      path.resolve(__dirname, '../data/vavoo_channels.json'),
      path.resolve(__dirname, './data/vavoo_channels.json'),
      path.resolve(__dirname, './src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'dist/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'data/vavoo_channels.json'),
    ];
    const catalogPath = candidates.find(p => fs.existsSync(p));
    if (catalogPath) {
      try {
        _vavooCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      } catch (err) {
        console.error('[VavooProvider] Failed to parse vavoo_channels.json:', err.message);
        _vavooCatalog = [];
      }
    } else {
      _vavooCatalog = [];
    }
  }
  return _vavooCatalog;
}

// ─── VavooProvider Class ────────────────────────────────────────────────────
class VavooProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'VavooProvider';
    this.sourceName = 'vavoo';
    let customTm = null;
    try {
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'tokenManager')) {
        customTm = opts.tokenManager;
      }
    } catch (_) {}
    this.tokenManager = customTm || globalTokenManager;
  }

  isEnabled() {
    return process.env.VAVOO_ENABLED === 'true';
  }

  /**
   * Returns all 1,800+ verified 24/7 channels as MatchEntity objects.
   * Isolated from live fixtures via category: 'networks' and id: 'vavoo_ch_*'.
   */
  async getMatches() {
    if (!this.isEnabled()) {
      return [];
    }

    const catalog = getVavooCatalog();
    if (!Array.isArray(catalog) || catalog.length === 0) {
      return [];
    }

    return catalog.map(ch => {
      const isPopular = ch.is4k || (ch.group === 'United Kingdom' && /sky sport|tnt sport/i.test(ch.name));
      const hasGroup = ch.group && typeof ch.group === 'string' && !/^(?:live tv|general|channels|networks|other)$/i.test(ch.group.trim());
      const groupLower = hasGroup ? ch.group.toLowerCase().trim() : '';
      const nameLower = ch.name.toLowerCase();
      const groupInName = hasGroup && (
        nameLower.includes(groupLower) ||
        (groupLower === 'united kingdom' && /\b(?:uk)\b/i.test(nameLower)) ||
        (groupLower === 'united states' && /\b(?:usa?)\b/i.test(nameLower)) ||
        (groupLower === 'germany' && /\b(?:de|ger)\b/i.test(nameLower)) ||
        (groupLower === 'france' && /\b(?:fr)\b/i.test(nameLower)) ||
        (groupLower === 'spain' && /\b(?:es)\b/i.test(nameLower)) ||
        (groupLower === 'italy' && /\b(?:it)\b/i.test(nameLower)) ||
        (groupLower === 'turkey' && /\b(?:tr)\b/i.test(nameLower))
      );
      const displayTitle = (hasGroup && !groupInName) ? `${ch.name} (${ch.group})` : ch.name;
      return new MatchEntity({
        id: `vavoo_ch_${ch.id}`,
        title: displayTitle,
        baseTitle: displayTitle,
        category: 'networks',
        date: '0', // Evergreen — 24/7 continuous channel
        popular: isPopular ? '1' : '0',
        league: ch.group || 'Live TV',
        logo: undefined,
        thumbnail_url: undefined,
        sources: [{
          source: 'vavoo',
          id: ch.vavooUrl,
          channelName: ch.name,
          language: ch.language || undefined,
          group: ch.group,
          is4k: ch.is4k,
          type: 'channel'
        }]
      });
    });
  }

  /**
   * Resolves a direct playable stream URL for a 24/7 channel.
   * Strictly adheres to Zero Server Bandwidth: returns Sunshine CDN link + proxyHeaders.
   *
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} src
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    if (!this.isEnabled()) {
      return [];
    }

    const vavooUrl = src.id || sourceId;
    if (!vavooUrl || !vavooUrl.includes('vavoo.to')) {
      return [];
    }

    try {
      const sig = await this.tokenManager.getOrRefreshSig(this.proxyFetch.bind(this));

      const resolveRes = await this.proxyFetch('https://vavoo.to/mediahubmx-resolve.json', {
        method: 'POST',
        headers: {
          'user-agent': 'MediaHubMX/2',
          'accept': 'application/json',
          'content-type': 'application/json; charset=utf-8',
          'mediahubmx-signature': sig
        },
        body: JSON.stringify({
          language: 'de',
          region: 'AT',
          url: vavooUrl,
          clientVersion: '3.1.0'
        }),
        timeoutMs: 8000
      });

      if (!resolveRes.ok) {
        console.warn(`[${this.name}] Resolve failed for "${matchTitle}": HTTP ${resolveRes.status}`);
        return [];
      }

      const j = await resolveRes.json();
      let streamUrl = null;
      if (Array.isArray(j) && j[0]?.url) {
        streamUrl = String(j[0].url);
      } else if (j?.url) {
        streamUrl = String(j.url);
      }

      if (!streamUrl) {
        console.warn(`[${this.name}] No stream URL returned in resolve payload for "${matchTitle}"`);
        return [];
      }

      const is4K = src.is4k || /4k|uhd/i.test(matchTitle);
      const resolution = is4K ? '4K UHD' : '1080p';
      const channelLabel = src.channelName || (matchTitle && !matchTitle.startsWith('vavoo_') ? matchTitle : 'Live TV');

      return [new StreamEntity({
        name: 'Vavoo',
        title: `Vavoo (${channelLabel}) [${resolution}]`,
        url: streamUrl,
        resolution: is4K ? '4K' : '1080p',
        score: is4K ? 95 : 85,
        language: src.language || undefined,
        channelName: channelLabel,
        group: src.group,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': 'MediaHubMX/2',
              'Referer': 'https://vavoo.to/'
            }
          }
        }
      })];
    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for "${matchTitle}":`, err.message);
      return [];
    }
  }
}

module.exports = VavooProvider;
module.exports.VavooTokenManager = VavooTokenManager;
module.exports.globalTokenManager = globalTokenManager;
