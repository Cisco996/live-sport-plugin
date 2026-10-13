'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { matchResolver, channelResolver } = require('../resolver/sktech');

/**
 * SkTechProvider
 *
 * Implements the dual-pillar SK Tech TV provider for Nuvio Live Sports Plugin:
 * - Pillar 1: Live Sports Matches (events.txt -> pro/*.txt)
 * - Pillar 2: 24/7 Continuous TV Networks (categories.txt -> channels/*.txt & .m3u)
 *
 * Operational Constraints:
 * - 0% Server Bandwidth Consumption: Never proxies media chunks through addon server.
 *   Emits direct CDN URLs with client-side behaviorHints.proxyHeaders.
 * - 0 Cloudflare Workers: Zero workers deployed or proxied through.
 */
class SkTechProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'SkTech';
    this.matchResolver = matchResolver;
    this.channelResolver = channelResolver;
  }

  /**
   * Ingests both Pillar 1 (Live Fixtures) and Pillar 2 (24/7 TV Networks)
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    const matches = [];

    // ──────────────────────────────────────────────────────────────────────────
    // Pillar 1: Live Sports Fixtures & Matches
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const liveMatches = await this.matchResolver.fetchLiveMatches();
      for (const m of liveMatches) {
        const isLive = m.kickoff && m.kickoff <= Date.now() && m.kickoff >= (Date.now() - 4 * 3600 * 1000);
        const status = isLive ? 'live' : ((m.kickoff && m.kickoff > Date.now()) ? 'upcoming' : 'live');

        matches.push(new MatchEntity({
          id: `sktech_${m.id}`,
          title: m.title,
          baseTitle: m.title,
          category: this.normalizeCategory(m.category),
          date: String(m.kickoff || 0),
          status,
          league: m.rawCategory || 'Live Sports',
          team1: m.teamA && m.teamA.name ? { name: m.teamA.name, logo: m.teamA.logo } : null,
          team2: m.teamB && m.teamB.name ? { name: m.teamB.name, logo: m.teamB.logo } : null,
          poster: m.poster || undefined,
          thumbnail_url: m.poster || undefined,
          sources: [{
            source: 'sktech',
            id: m.linkPath,
            channelName: m.title,
            type: 'fixture'
          }]
        }));
      }
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch live matches:`, err.message);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Pillar 2: 24/7 Continuous TV Networks
    // ──────────────────────────────────────────────────────────────────────────
    try {
      const channels = await this.channelResolver.fetchChannels();
      for (const ch of channels) {
        matches.push(new MatchEntity({
          id: `sktech_ch_${ch.id}`,
          title: ch.title,
          baseTitle: ch.title,
          category: 'networks',
          date: '0',
          popular: '1',
          league: 'Live TV',
          poster: ch.logo || ch.poster || undefined,
          thumbnail_url: ch.logo || ch.poster || undefined,
          logo: ch.logo || undefined,
          sources: [{
            source: 'sktech',
            id: ch.links || ch.api || ch.id,
            channelName: ch.title,
            type: ch.type,
            url: ch.api || '',
            links: ch.links || ''
          }]
        }));
      }
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch 24/7 channels:`, err.message);
    }

    return matches;
  }

  /**
   * Resolves direct playable streams for fixtures and 24/7 channels
   * Strict Constraints: 0 Server Bandwidth, 0 Cloudflare Workers
   *
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} src
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const rawCandidates = [];
    const targetLink = src.links || src.id || sourceId;

    try {
      // Branch A: Fixture link path or direct pro/ link
      if (src.type === 'fixture' || (targetLink && targetLink.startsWith('pro/'))) {
        const fixtureStreams = await this.matchResolver.resolveMatchStreams(targetLink, matchTitle);
        rawCandidates.push(...fixtureStreams);
      }
      // Branch B: 24/7 TV Channel item
      else {
        const channelStreams = await this.channelResolver.resolveChannelStream({
          ...src,
          id: sourceId,
          title: matchTitle
        });
        rawCandidates.push(...channelStreams);
      }
    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for ${sourceId}:`, err.message);
    }

    // Map candidates to StreamEntity instances (Zero Server Bandwidth compliance)
    const streamEntities = [];
    for (const s of rawCandidates) {
      if (!s.url) continue;

      // Filter out any internal proxy routes if accidentally emitted
      if (s.url.includes('localhost') || s.url.includes('/api/manifest')) {
        continue;
      }

      streamEntities.push(new StreamEntity({
        name: 'SK Tech',
        title: s.title || matchTitle || 'Live Stream',
        url: s.url,
        resolution: s.resolution || 'HD',
        score: s.score || 85,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: s.behaviorHints?.proxyHeaders || {
            request: s.headers || {}
          }
        },
        clearkey: s.clearkey || undefined
      }));
    }

    return streamEntities;
  }
}

module.exports = SkTechProvider;
