'use strict';

const ChannelIdentityService = require('../src/services/ChannelIdentityService');
const { compareStreams } = require('../src/services/LanguagePriorityService');
const MatchAggregator = require('../src/services/MatchAggregator');
const CacheService = require('../src/services/CacheService');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const { formatChannelStreamTitle } = require('../src/streams');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Universal 24/7 Channel Identity & Aggregation Architecture', () => {

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 1: Universal Channel Identity Parsing
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 1: ChannelIdentityService Parsing & Normalization', () => {
    test('strips country and regional suffixes while extracting country metadata', () => {
      const res = ChannelIdentityService.parseChannel('Astro Cricket (Malaysia)', { group: 'Malaysia' });
      expect(res.canonicalTitle).toBe('Astro Cricket');
      expect(res.country).toBe('Malaysia');
      expect(res.countryCode).toBe('MY');
      expect(res.countryFlag).toBe('🇲🇾');
      expect(res.identityKey).toBe('astrocricket');
    });

    test('strips language markers and sets language metadata', () => {
      const res = ChannelIdentityService.parseChannel('Cartoon Network Arabic (EN)', { language: 'Arabic' });
      expect(res.canonicalTitle).toBe('Cartoon Network');
      expect(res.language).toBe('Arabic');
      expect(res.identityKey).toBe('cartoonnetwork');
    });

    test('strips resolution, framerate, and codec markers', () => {
      const res = ChannelIdentityService.parseChannel('Sky Sports Main Event UHD 4K 50FPS HEVC H.265');
      expect(res.canonicalTitle).toBe('Sky Sports Main Event');
      expect(res.resolution).toBe('4K');
      expect(res.identityKey).toBe('skysportsmainevent');
    });

    test('identifies backup feeds and strips backup markers', () => {
      const res = ChannelIdentityService.parseChannel('TNT Sports 1 Backup HD');
      expect(res.canonicalTitle).toBe('TNT Sports 1');
      expect(res.isBackup).toBe(true);
      expect(res.resolution).toBe('HD');
      expect(res.identityKey).toBe('tntsports1');
    });

    test('identifies timeshift delay feeds (+1, +2) and strips timeshift tag', () => {
      const res = ChannelIdentityService.parseChannel('Channel 4 +1 HD');
      expect(res.canonicalTitle).toBe('Channel 4');
      expect(res.isTimeshift).toBe(true);
      expect(res.channelNumber).toBe('4');
      expect(res.identityKey).toBe('channel4');
    });

    test('strictly preserves channel numbers for distinct channels', () => {
      const ch1 = ChannelIdentityService.parseChannel('Astro Cricket 1 HD');
      const ch2 = ChannelIdentityService.parseChannel('Astro Cricket 2 HD');

      expect(ch1.canonicalTitle).toBe('Astro Cricket 1');
      expect(ch2.canonicalTitle).toBe('Astro Cricket 2');
      expect(ch1.channelNumber).toBe('1');
      expect(ch2.channelNumber).toBe('2');
      expect(ch1.identityKey).not.toBe(ch2.identityKey);
      expect(ch1.identityKey).toBe('astrocricket1');
      expect(ch2.identityKey).toBe('astrocricket2');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 2: Cross-Provider Aggregation into Single Meta Card
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 2: Universal Aggregation Across Providers', () => {
    let aggregator;

    beforeEach(() => {
      aggregator = new MatchAggregator();
    });

    test('aggregates matching 24/7 channels across Vavoo, DaddyLive, SKTech, and CDNLive into ONE card', () => {
      const vavoo = new MatchEntity({
        id: 'vavoo_ch_astro_cricket',
        title: 'Astro Cricket (Malaysia)',
        category: 'networks',
        date: '0',
        league: 'Malaysia',
        sources: [{ source: 'vavoo', id: 'https://vavoo.to/astro', group: 'Malaysia', type: 'channel' }]
      });

      const daddylive = new MatchEntity({
        id: 'dlv_ch_123_astro-cricket',
        title: 'Astro Cricket HD',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'daddylive', id: '123', type: 'channel' }]
      });

      const sktech = new MatchEntity({
        id: 'sktech_ch_astro_cricket',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        league: 'Sports',
        sources: [{ source: 'sktech', id: 'sk_astro', type: 'channel' }]
      });

      const cdnlive = new MatchEntity({
        id: 'cdn_ch_my_astro_cricket',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'cdnlive', id: 'cdn_astro', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(vavoo, daddylive)).toBe(true);
      expect(aggregator.isSameEvent(daddylive, sktech)).toBe(true);
      expect(aggregator.isSameEvent(sktech, cdnlive)).toBe(true);

      const merged = aggregator.mergeMatches(vavoo, daddylive);
      expect(merged.title).toBe('Astro Cricket');
      expect(merged.sources.length).toBe(2);

      const mergedAll = aggregator.mergeMatches(merged, sktech);
      const mergedFinal = aggregator.mergeMatches(mergedAll, cdnlive);
      expect(mergedFinal.title).toBe('Astro Cricket');
      expect(mergedFinal.sources.length).toBe(4);
    });

    test('aggregates CARTOONITO across multiple regional feeds into one card', () => {
      const chUK = new MatchEntity({
        id: 'vavoo_ch_cartoonito_uk',
        title: 'Cartoonito UK HD',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', group: 'United Kingdom', type: 'channel' }]
      });

      const chIT = new MatchEntity({
        id: 'vavoo_ch_cartoonito_it',
        title: 'CARTOONITO (Italy)',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', group: 'Italy', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(chUK, chIT)).toBe(true);
      const merged = aggregator.mergeMatches(chUK, chIT);
      expect(merged.title).toBe('Cartoonito');
      expect(merged.sources.length).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 3: Stream Ordering within Card (English > Language > Live > Quality > Backup)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 3: Stream Ordering & Prioritization', () => {
    test('ranks English streams before other languages', () => {
      const enStream = new StreamEntity({
        name: 'Stream 1',
        title: 'Vavoo | Cartoon Network — UK — English — 1080p',
        language: 'English',
        quality: '1080p'
      });
      const esStream = new StreamEntity({
        name: 'Stream 2',
        title: 'Vavoo | Cartoon Network — Spain — Spanish — 1080p',
        language: 'Spanish',
        quality: '1080p'
      });

      expect(compareStreams(enStream, esStream)).toBeLessThan(0);
      expect(compareStreams(esStream, enStream)).toBeGreaterThan(0);
    });

    test('ranks higher resolution over lower resolution within same language', () => {
      const stream4k = new StreamEntity({
        name: 'Stream 4K',
        title: 'Vavoo | Astro Cricket — 4K',
        language: 'English',
        quality: '4K',
        resolution: '4K'
      });
      const stream1080 = new StreamEntity({
        name: 'Stream 1080p',
        title: 'Vavoo | Astro Cricket — 1080p',
        language: 'English',
        quality: '1080p',
        resolution: '1080p'
      });
      const stream720 = new StreamEntity({
        name: 'Stream 720p',
        title: 'Vavoo | Astro Cricket — 720p',
        language: 'English',
        quality: '720p',
        resolution: '720p'
      });

      expect(compareStreams(stream4k, stream1080)).toBeLessThan(0);
      expect(compareStreams(stream1080, stream720)).toBeLessThan(0);
    });

    test('ranks standard streams before backup streams', () => {
      const standardStream = new StreamEntity({
        name: 'Standard Stream',
        title: 'DaddyLive | Sky Sports Main Event — English — 1080p',
        language: 'English',
        quality: '1080p',
        isBackup: false
      });
      const backupStream = new StreamEntity({
        name: 'Backup Stream',
        title: 'DaddyLive | Sky Sports Main Event — English — 1080p [Backup]',
        language: 'English',
        quality: '1080p',
        isBackup: true
      });

      expect(compareStreams(standardStream, backupStream)).toBeLessThan(0);
    });

    test('ranks current live streams before timeshift delay streams', () => {
      const currentStream = new StreamEntity({
        name: 'Current Stream',
        title: 'Vavoo | Channel 4 — English — 1080p',
        language: 'English',
        quality: '1080p',
        isTimeshift: false
      });
      const timeshiftStream = new StreamEntity({
        name: 'Timeshift Stream',
        title: 'Vavoo | Channel 4 — English — 1080p [+1 Delay]',
        language: 'English',
        quality: '1080p',
        isTimeshift: true
      });

      expect(compareStreams(currentStream, timeshiftStream)).toBeLessThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 4: Explicit Stream Label Formatting
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 4: Explicit Stream Label Formatting', () => {
    test('formats explicit label for 24/7 channel stream: Provider | Channel — Country — Language — Quality', () => {
      const stream = new StreamEntity({
        name: 'vavoo',
        sourceName: 'vavoo',
        title: 'Astro Cricket',
        channelName: 'Astro Cricket (Malaysia)',
        canonicalChannel: 'Astro Cricket',
        country: 'Malaysia',
        countryFlag: '🇲🇾',
        language: 'English',
        resolution: '1080p'
      });

      const label = formatChannelStreamTitle(stream);
      expect(label).toContain('Vavoo | Astro Cricket');
      expect(label).toContain('Malaysia');
      expect(label).toContain('🇲🇾');
      expect(label).toContain('English');
      expect(label).toContain('1080p');
    });

    test('appends [Backup] and [+1 Delay] tags to stream label', () => {
      const stream = new StreamEntity({
        name: 'daddylive',
        sourceName: 'daddylive',
        title: 'Channel 4',
        channelName: 'Channel 4 +1 Backup',
        canonicalChannel: 'Channel 4',
        country: 'United Kingdom',
        countryFlag: '🇬🇧',
        language: 'English',
        resolution: '1080p',
        isBackup: true,
        isTimeshift: true
      });

      const label = formatChannelStreamTitle(stream);
      expect(label).toContain('DaddyLive | Channel 4');
      expect(label).toContain('[Backup]');
      expect(label).toContain('[+1 Delay]');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 5: Strict Merge Protection (False-Merge Guards)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 5: Strict Merge Protection & False-Merge Guards', () => {
    let aggregator;

    beforeEach(() => {
      aggregator = new MatchAggregator();
    });

    test('NEVER merges channels with different numbers (e.g. Astro Cricket 1 vs Astro Cricket 2)', () => {
      const astro1 = new MatchEntity({
        id: 'vavoo_astro1',
        title: 'Astro Cricket 1 HD',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', type: 'channel' }]
      });

      const astro2 = new MatchEntity({
        id: 'vavoo_astro2',
        title: 'Astro Cricket 2 HD',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(astro1, astro2)).toBe(false);
    });

    test('NEVER merges channels with different network identities (e.g. Cartoon Network vs Cartoonito)', () => {
      const cn = new MatchEntity({
        id: 'dlv_cn',
        title: 'Cartoon Network',
        category: 'networks',
        date: '0',
        sources: [{ source: 'daddylive', type: 'channel' }]
      });

      const cartoonito = new MatchEntity({
        id: 'dlv_cartoonito',
        title: 'Cartoonito',
        category: 'networks',
        date: '0',
        sources: [{ source: 'daddylive', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(cn, cartoonito)).toBe(false);
    });

    test('NEVER merges a 24/7 channel with a live fixture of the same name', () => {
      const liveFixture = new MatchEntity({
        id: 'cdn_fixture_123',
        title: 'Astro Cricket',
        category: 'cricket',
        date: String(Date.now() + 3600000),
        status: 'upcoming',
        sources: [{ source: 'cdnlive' }]
      });

      const channel = new MatchEntity({
        id: 'vavoo_channel_astro',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(liveFixture, channel)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 6: Cache Versioning & Migration
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 6: Cache Schema Versioning & Migration', () => {
    let tmpDir, cacheService;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-cache-version-'));
      cacheService = new CacheService();
      cacheService.cacheFilePath = path.join(tmpDir, 'matches_cache.json');
      cacheService.clear();
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    });

    test('writes schemaVersion = 2 to disk when saving matches', () => {
      const match = new MatchEntity({
        id: 'net_astro_cricket',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        sources: []
      });

      cacheService.setMatches([match]);
      expect(fs.existsSync(cacheService.cacheFilePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(cacheService.cacheFilePath, 'utf-8'));
      expect(content.schemaVersion).toBe(CacheService.CACHE_SCHEMA_VERSION);
      expect(content.schemaVersion).toBe(2);
      expect(content.matches.length).toBe(1);
    });

    test('discards and purges legacy disk cache with schemaVersion < 2', () => {
      // Simulate legacy disk cache saved before universal channel layer
      const legacyPayload = {
        schemaVersion: 1,
        timestamp: Date.now(),
        matches: [{ id: 'legacy_split_card', title: 'Cartoon Network (France)', category: 'networks' }]
      };
      fs.writeFileSync(cacheService.cacheFilePath, JSON.stringify(legacyPayload), 'utf-8');

      // Create a fresh CacheService instance targeting that file
      const newCache = new CacheService(cacheService.cacheFilePath);

      // Legacy entries must be purged, not loaded
      expect(newCache.getMatchesReadOnly()).toEqual([]);
      expect(fs.existsSync(cacheService.cacheFilePath)).toBe(false);
    });
  });

});
