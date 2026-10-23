'use strict';

// Unit tests for the Cloudflare worker budget allocator
// (src/services/WorkerBudget.js) and its integration in
// src/services/HlsRewriteService.js.
//
// Deterministic and offline: the clock and the RNG are injectable, so no test
// performs a network call or depends on wall-clock time.

const {
  createWorkerPool,
  resolveConfig,
  DEFAULT_FREE_POOL,
  DEFAULT_PAID_WORKER,
  FREE_DAILY_LIMIT,
} = require('../src/services/WorkerBudget');

const MANIFEST = 'https://cdn.example/live/index.m3u8';

// Quiet pool: no timers, no console noise.
const quietEnv = { WORKER_POOL_LOG: 'off' };

function fixedClock(startIso) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    set: (iso) => {
      current = new Date(iso).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/**
 * Require HlsRewriteService with a patched process.env. The worker pool is
 * built at module load, so the env must be in place before the require.
 */
function withServiceEnv(env, fn) {
  // The module-level pool is built at require time and logs by default; the
  // suite asserts behaviour, not log output, so keep the reporter quiet.
  const merged = { WORKER_POOL_LOG: 'off', ...env };
  const saved = {};
  for (const key of Object.keys(merged)) {
    saved[key] = process.env[key];
    process.env[key] = merged[key];
  }
  try {
    jest.resetModules();
    const service = require('../src/services/HlsRewriteService');
    return fn(service);
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.resetModules();
  }
}

describe('WorkerBudget — configuration', () => {
  test('the paid worker is never in the free pool', () => {
    const config = resolveConfig({});
    expect(config.freePool).not.toContain(DEFAULT_PAID_WORKER);
    expect(config.freePool).toHaveLength(DEFAULT_FREE_POOL.length);
  });

  test('filters the paid worker out of a custom CF_WORKER_POOL', () => {
    const config = resolveConfig({
      CF_WORKER_POOL: `https://a.example,${DEFAULT_PAID_WORKER},https://b.example`,
    });
    expect(config.freePool).toEqual(['https://a.example', 'https://b.example']);
  });

  test('drops duplicate entries and trailing slashes', () => {
    const config = resolveConfig({
      CF_WORKER_POOL: 'https://a.example/,https://a.example,https://b.example/',
    });
    expect(config.freePool).toEqual(['https://a.example', 'https://b.example']);
  });

  test('divides the per-worker cap by the cluster instance count', () => {
    const single = resolveConfig({ WORKER_INSTANCE_COUNT: '1' });
    const cluster = resolveConfig({ WORKER_INSTANCE_COUNT: '2' });

    expect(single.freeCapPerProcess).toBe(Math.floor(FREE_DAILY_LIMIT * 0.9));
    expect(cluster.freeCapPerProcess).toBe(Math.floor(single.freeCapPerProcess / 2));
    expect(cluster.paidCapPerProcess).toBe(Math.floor(single.paidCapPerProcess / 2));
  });

  test('HLSCUNK_FALLBACK defaults on and accepts off', () => {
    expect(resolveConfig({}).hlschunkFallback).toBe(true);
    expect(resolveConfig({ HLSCUNK_FALLBACK: 'off' }).hlschunkFallback).toBe(false);
    expect(resolveConfig({ HLSCUNK_FALLBACK: 'on' }).hlschunkFallback).toBe(true);
  });
});

describe('WorkerBudget — allocation', () => {
  test('spends free workers before the paid worker', () => {
    const pool = createWorkerPool({
      env: quietEnv,
      overrides: { freeCapPerProcess: 1000, paidCapPerProcess: 1000 },
    });

    for (let i = 0; i < 50; i += 1) {
      const pick = pool.pick(`https://cdn.example/seg-${i}.image`);
      expect(pick.tier).toBe('free');
      expect(pick.url).not.toBe(DEFAULT_PAID_WORKER);
    }
    expect(pool.snapshot().paid.used).toBe(0);
  });

  test('spreads load across the whole free tier', () => {
    const pool = createWorkerPool({
      env: quietEnv,
      overrides: { freeCapPerProcess: 1000, paidCapPerProcess: 1000 },
    });

    for (let i = 0; i < 200; i += 1) {
      pool.pick(`https://cdn.example/x-${i}.image`);
    }

    const used = pool.snapshot().free.filter((w) => w.used > 0);
    expect(used).toHaveLength(DEFAULT_FREE_POOL.length);
  });

  test('overflows to the paid worker only once every free worker is at cap', () => {
    const cap = 2;
    const pool = createWorkerPool({
      env: quietEnv,
      overrides: { freeCapPerProcess: cap, paidCapPerProcess: 100 },
    });

    const tiers = [];
    const totalFreeCapacity = cap * DEFAULT_FREE_POOL.length;
    for (let i = 0; i < totalFreeCapacity + 2; i += 1) {
      tiers.push(pool.pick(`https://cdn.example/o-${i}.image`).tier);
    }

    expect(tiers.slice(0, totalFreeCapacity).every((t) => t === 'free')).toBe(true);
    expect(tiers.slice(totalFreeCapacity)).toEqual(['paid', 'paid']);
  });

  test('returns null when both tiers are exhausted', () => {
    const pool = createWorkerPool({
      env: quietEnv,
      overrides: { freeCapPerProcess: 0, paidCapPerProcess: 1 },
    });

    expect(pool.pick('https://cdn.example/first.image').tier).toBe('paid');
    expect(pool.pick('https://cdn.example/second.image')).toBeNull();
  });

  test('logs exhaustion at most once per log interval', () => {
    const clock = fixedClock('2026-10-23T12:00:00Z');
    const lines = [];
    const pool = createWorkerPool({
      now: clock.now,
      log: (line) => lines.push(line),
      env: {},
      overrides: { freeCapPerProcess: 0, paidCapPerProcess: 0 },
    });

    expect(pool.pick('https://cdn.example/a.image')).toBeNull();
    clock.advance(1000);
    expect(pool.pick('https://cdn.example/b.image')).toBeNull();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('both exhausted');

    clock.advance(300000);
    expect(pool.pick('https://cdn.example/c.image')).toBeNull();
    expect(lines).toHaveLength(2);

    pool.stop();
  });
});

describe('WorkerBudget — dedupe of sliding-window re-emissions', () => {
  test('the same segment URL is charged once and stays on the same worker', () => {
    const pool = createWorkerPool({
      env: quietEnv,
      overrides: { freeCapPerProcess: 1, paidCapPerProcess: 10 },
    });

    const first = pool.pick('https://cdn.example/repeat.image');
    const second = pool.pick('https://cdn.example/repeat.image');

    expect(second.url).toBe(first.url);
    expect(second.reused).toBe(true);

    // Cap is 1 per worker, so exactly one worker may have been charged.
    const charged = pool.snapshot().free.filter((w) => w.used === 1);
    expect(charged).toHaveLength(1);
  });

  test('re-emission stops being free after the dedupe TTL', () => {
    const clock = fixedClock('2026-10-23T12:00:00Z');
    const pool = createWorkerPool({
      now: clock.now,
      env: { ...quietEnv, CF_DEDUPE_TTL_MS: '1000' },
      overrides: { freeCapPerProcess: 100, paidCapPerProcess: 100 },
    });

    pool.pick('https://cdn.example/window.image');
    clock.advance(2000);
    const second = pool.pick('https://cdn.example/window.image');

    expect(second.reused).toBe(false);
    expect(pool.snapshot().free.reduce((sum, w) => sum + w.used, 0)).toBe(2);
  });
});

describe('WorkerBudget — budget resets', () => {
  test('free counters reset at the UTC day boundary', () => {
    const clock = fixedClock('2026-10-23T23:59:00Z');
    const pool = createWorkerPool({
      now: clock.now,
      env: quietEnv,
      overrides: { freeCapPerProcess: 1, paidCapPerProcess: 100 },
    });

    for (let i = 0; i < DEFAULT_FREE_POOL.length; i += 1) {
      expect(pool.pick(`https://cdn.example/late-${i}.image`).tier).toBe('free');
    }
    expect(pool.pick('https://cdn.example/overflow.image').tier).toBe('paid');

    clock.set('2026-10-24T00:00:30Z');
    expect(pool.pick('https://cdn.example/next-day.image').tier).toBe('free');
  });

  test('paid budget resets at the UTC month boundary', () => {
    const clock = fixedClock('2026-10-31T23:00:00Z');
    const pool = createWorkerPool({
      now: clock.now,
      env: quietEnv,
      overrides: { freeCapPerProcess: 0, paidCapPerProcess: 1 },
    });

    expect(pool.pick('https://cdn.example/a.image').tier).toBe('paid');
    expect(pool.pick('https://cdn.example/b.image')).toBeNull();

    clock.set('2026-11-01T00:00:10Z');
    expect(pool.pick('https://cdn.example/c.image').tier).toBe('paid');
  });
});

describe('HlsRewriteService — rewrite rules', () => {
  test('routes .image segments through a worker', () => {
    withServiceEnv({}, ({ rewriteHlsUri }) => {
      const out = rewriteHlsUri('seg1.image', MANIFEST);
      expect(out).toMatch(/^https:\/\/[^/]+\/seg\.ts\?url=/);
      expect(out).not.toContain('/api/hlschunk');
    });
  });

  test('keeps referer and origin on the worker URL', () => {
    withServiceEnv({}, ({ rewriteHlsUri }) => {
      const out = rewriteHlsUri('seg1.image', MANIFEST, {
        referer: 'https://ref.example/',
        origin: 'https://origin.example',
      });
      expect(out).toContain(`referer=${encodeURIComponent('https://ref.example/')}`);
      expect(out).toContain(`origin=${encodeURIComponent('https://origin.example')}`);
    });
  });

  test('still rewrites nested manifests to /api/manifest', () => {
    withServiceEnv({}, ({ rewriteHlsUri }) => {
      const out = rewriteHlsUri('chunklist.m3u8', MANIFEST, { rckSuffix: '&rck=abc' });
      expect(out).toContain('/api/manifest?url=');
      expect(out).toContain('&rck=abc');
    });
  });

  test('still appends the #.ts hint to disguised TS segments', () => {
    withServiceEnv({}, ({ rewriteHlsUri }) => {
      expect(rewriteHlsUri('seg.png', MANIFEST)).toBe('https://cdn.example/live/seg.png#.ts');
      expect(rewriteHlsUri('seg.webp', MANIFEST)).toBe('https://cdn.example/live/seg.webp#.ts');
      expect(rewriteHlsUri('seg.ts', MANIFEST)).toBe('https://cdn.example/live/seg.ts');
    });
  });
});

describe('HlsRewriteService — exhaustion fallback', () => {
  // A huge instance count drives both per-process caps to ~0, so the pool is
  // exhausted after a few dozen emissions without needing 600k calls.
  const TIGHT = { WORKER_INSTANCE_COUNT: '200000' };

  test('falls back to /api/hlschunk by default', () => {
    withServiceEnv(TIGHT, ({ rewriteHlsUri, workerPool }) => {
      for (let i = 0; i < workerPool.config.paidCapPerProcess; i += 1) {
        rewriteHlsUri(`seg${i}.image`, MANIFEST);
      }
      expect(workerPool.pick('probe.image')).toBeNull();

      const out = rewriteHlsUri('seg-final.image', MANIFEST);
      expect(out).toContain('/api/hlschunk?url=');
    });
  });

  test('emits the upstream URL when HLSCUNK_FALLBACK=off', () => {
    withServiceEnv({ ...TIGHT, HLSCUNK_FALLBACK: 'off' }, ({ rewriteHlsUri, workerPool }) => {
      for (let i = 0; i < workerPool.config.paidCapPerProcess; i += 1) {
        rewriteHlsUri(`seg${i}.image`, MANIFEST);
      }
      expect(workerPool.pick('probe.image')).toBeNull();

      const out = rewriteHlsUri('seg-final.image', MANIFEST);
      expect(out).toBe('https://cdn.example/live/seg-final.image');
    });
  });
});
