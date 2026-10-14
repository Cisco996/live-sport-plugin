'use strict';

const http = require('http');
const express = require('express');
const SkTechCrypto = require('../src/resolver/sktech/SkTechCrypto');
const SkTechEmbedExtractor = require('../src/resolver/sktech/SkTechEmbedExtractor');
const manifestRouter = require('../src/routes/manifest');

describe('SK Tech DASH Manifest & ClearKey DRM Proxy System', () => {
  let server;
  let serverPort;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(manifestRouter);

    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      baseUrl = `http://127.0.0.1:${serverPort}`;
      done();
    });
  });

  afterAll((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  describe('SkTechCrypto.formatClearKey()', () => {
    test('normalizes comma-separated multi-keys (audio + video) into base64url', () => {
      const rawMultiKey = '2a19442cb6a65a0d9547b7a887029334:78f4db938c5873b14dffa721a6b979c5,7d7a754c2d5756328cf9bb03b93bf946:5e2eb51889cf8e326f04abf24757205e';
      const parsed = SkTechCrypto.formatClearKey(rawMultiKey);
      expect(parsed).toBeDefined();
      expect(parsed.keyId).toBe('KhlELLamWg2VR7eohwKTNA');
      expect(parsed.key).toBe('ePTbk4xYc7FN_6chprl5xQ');
      expect(parsed.keys).toHaveLength(2);
      expect(parsed.keys[1]).toEqual({
        keyId: 'fXp1TC1XVjKM-bsDuTv5Rg',
        key: 'Xi61GInPjjJvBKvyR1cgXg'
      });
    });

    test('normalizes W3C JSON clear key format', () => {
      const jsonStr = JSON.stringify({
        keys: [{
          kty: 'oct',
          kid: 'a71918fcc2f12066f70b7c39b0e0dcf3',
          k: 'a5e35121d4f6f16694bea15334f14814'
        }]
      });
      const parsed = SkTechCrypto.formatClearKey(jsonStr);
      expect(parsed).toBeDefined();
      expect(parsed.keyId).toBe('pxkY_MLxIGb3C3w5sODc8w');
      expect(parsed.key).toBe('peNRIdT28WaUvqFTNPFIFA');
    });

    test('normalizes single hex colon pair without adding extra keys array', () => {
      const rawHex = 'b9f1cb8a1361457bbd8097f8c2590000:1960274b7ba344cb899eba2e80916774';
      const parsed = SkTechCrypto.formatClearKey(rawHex);
      expect(parsed).toEqual({
        keyId: 'ufHLihNhRXu9gJf4wlkAAA',
        key: 'GWAnS3ujRMuJnrougJFndA'
      });
    });
  });

  describe('SkTechEmbedExtractor.parseDelimited() with Cookie', () => {
    test('correctly parses Cookie header alongside User-Agent, Referer, and Origin', () => {
      const raw = 'https://livetv.hotstar.com/live/cenc/index.mpd|Cookie=hdntl=exp=1792044485~acl=%2f*~data=hdntl&User-Agent=Virat&Referer=https://www.hotstar.com/&Origin=https://www.hotstar.com';
      const parsed = SkTechEmbedExtractor.parseDelimited(raw);
      expect(parsed.url).toBe('https://livetv.hotstar.com/live/cenc/index.mpd');
      expect(parsed.headers['Cookie']).toBe('hdntl=exp=1792044485~acl=%2f*~data=hdntl');
      expect(parsed.headers['User-Agent']).toBe('Virat');
      expect(parsed.headers['Referer']).toBe('https://www.hotstar.com/');
      expect(parsed.headers['Origin']).toBe('https://www.hotstar.com');
    });
  });

  describe('ClearKey License Endpoint (/api/clearkey/license)', () => {
    test('returns W3C ClearKey JSON response from base64url token', async () => {
      const keyObj = {
        keyId: 'ufHLihNhRXu9gJf4wlkAAA',
        key: 'GWAnS3ujRMuJnrougJFndA'
      };
      const token = Buffer.from(JSON.stringify(keyObj)).toString('base64url');

      const res = await fetch(`${baseUrl}/api/clearkey/license?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json();
      expect(body.type).toBe('temporary');
      expect(body.keys).toEqual([
        {
          kty: 'oct',
          kid: 'ufHLihNhRXu9gJf4wlkAAA',
          k: 'GWAnS3ujRMuJnrougJFndA'
        }
      ]);
    });

    test('supports OPTIONS preflight with 204 status', async () => {
      const res = await fetch(`${baseUrl}/api/clearkey/license`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    test('returns multiple key pairs for multi-key token', async () => {
      const multiKeyObj = {
        keys: [
          { kid: 'keyId1', k: 'keyVal1' },
          { kid: 'keyId2', k: 'keyVal2' }
        ]
      };
      const token = Buffer.from(JSON.stringify(multiKeyObj)).toString('base64url');

      const res = await fetch(`${baseUrl}/api/clearkey/license?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kids: ['keyId1', 'keyId2'], type: 'temporary' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toHaveLength(2);
      expect(body.keys[0]).toEqual({ kty: 'oct', kid: 'keyId1', k: 'keyVal1' });
      expect(body.keys[1]).toEqual({ kty: 'oct', kid: 'keyId2', k: 'keyVal2' });
    });
  });

  describe('SkTechCrypto.buildDashManifestUrl()', () => {
    test('packages upstream URL, token, and headers into a relative manifest URL', () => {
      const upstream = 'https://otte.cache.aiv-cdn.net/live/clients/dash/cenc.mpd';
      const ck = { keyId: 'abc', key: 'def' };
      const headers = { 'Cookie': 'cookieVal', 'User-Agent': 'TestUA' };

      const manifestUrl = SkTechCrypto.buildDashManifestUrl(upstream, ck, headers);
      expect(manifestUrl).toContain('/api/manifest.mpd?url=https%3A%2F%2Fotte.cache.aiv-cdn.net');
      expect(manifestUrl).toContain('token=');
      expect(manifestUrl).toContain('cookie=cookieVal');
      expect(manifestUrl).toContain('ua=TestUA');
    });
  });
});
