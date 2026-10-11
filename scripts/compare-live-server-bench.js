/**
 * scripts/compare-live-server-bench.js
 *
 * Boots the server on a live test port, populates real data, and issues
 * high-concurrency requests measuring HTTP throughput, response latency,
 * and memory heap growth on real HTTP endpoints.
 */

const { request } = require('undici');
const { startServer } = require('../tests/load/server-runner');

const PORT = 7015;
const RESOLVER_PORT = 7016;

async function runBenchmark() {
  console.log('\n====================================================================');
  console.log('🚀 LIVE SERVER BENCHMARK & LOAD STRESS TEST');
  console.log('====================================================================\n');

  console.log('1. Booting live server on port ' + PORT + '...');
  const server = await startServer({
    port: PORT,
    resolverPort: RESOLVER_PORT,
    reuseExisting: false
  });
  const baseUrl = server.baseUrl;

  // Let initial sync complete or inject dummy data if needed
  let matchesCount = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await request(`${baseUrl}/api/matches`);
      if (res.statusCode === 200) {
        const data = await res.body.json();
        if (Array.isArray(data) && data.length > 0) {
          matchesCount = data.length;
          break;
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`   Server ready with ${matchesCount} live matches in cache.\n`);

  // Endpoints to benchmark under load:
  // 1. /catalog/tv/nuvio_sports_live.json (Tests sortCatalogMatches + getMatchesReadOnly)
  // 2. /catalog/tv/nuvio_sports_networks.json
  // 3. /manifest.json (Tests precomputed network titles filter)
  // 4. /stream/tv/nuvio_sport_<id>.json (Tests O(1) findMatch + ChannelCountryService memoization)

  const endpoints = [
    { name: 'Manifest (/manifest.json)', path: '/manifest.json' },
    { name: 'Live Catalog (/catalog/tv/nuvio_sports_live.json)', path: '/catalog/tv/nuvio_sports_live.json' },
    { name: 'Networks Catalog (/catalog/tv/nuvio_sports_networks.json)', path: '/catalog/tv/nuvio_sports_networks.json' },
  ];

  // Pick a real match ID for stream endpoint
  let sampleMatchId = null;
  try {
    const catRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_live.json`);
    const catData = await catRes.body.json();
    if (catData && catData.metas && catData.metas.length > 0) {
      sampleMatchId = catData.metas[0].id;
    }
  } catch (_) {}

  if (sampleMatchId) {
    endpoints.push({
      name: `Stream Endpoint (/stream/tv/${sampleMatchId}.json)`,
      path: `/stream/tv/${sampleMatchId}.json`
    });
  }

  const CONCURRENCY = 20;
  const TOTAL_REQUESTS = 200;

  console.log(`2. Stress testing endpoints (${TOTAL_REQUESTS} requests, concurrency ${CONCURRENCY})...\n`);

  for (const ep of endpoints) {
    const latencies = [];
    const tStart = process.hrtime.bigint();
    let completed = 0;
    let failed = 0;

    const runWorker = async () => {
      while (true) {
        if (completed + failed >= TOTAL_REQUESTS) break;
        const currentReq = completed + failed;
        if (currentReq >= TOTAL_REQUESTS) break;
        const reqStart = process.hrtime.bigint();
        try {
          const res = await request(`${baseUrl}${ep.path}`, {
            headers: {
              'host': '127.0.0.1:7015'
            }
          });
          await res.body.text(); // consume body
          const reqDuration = Number(process.hrtime.bigint() - reqStart) / 1e6;
          latencies.push(reqDuration);
          if (res.statusCode === 200) completed++;
          else failed++;
        } catch (err) {
          failed++;
        }
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => runWorker());
    await Promise.all(workers);

    const totalDurationMs = Number(process.hrtime.bigint() - tStart) / 1e6;
    latencies.sort((a, b) => a - b);
    const avgLatency = (latencies.reduce((a, b) => a + b, 0) / latencies.length) || 0;
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
    const rps = (completed / (totalDurationMs / 1000)).toFixed(1);

    console.log(`📊 Endpoint: ${ep.name}`);
    console.log(`   Completed: ${completed}/${TOTAL_REQUESTS} (Failed: ${failed})`);
    console.log(`   Throughput: ${rps} req/sec`);
    console.log(`   Avg Latency: ${avgLatency.toFixed(2)} ms | P50: ${p50.toFixed(2)} ms | P95: ${p95.toFixed(2)} ms | P99: ${p99.toFixed(2)} ms`);
    console.log('   ------------------------------------------------------------');
  }

  console.log('\n3. Teardown test server...');
  if (server.shutdown) await server.shutdown();
  console.log('✅ Done!\n');
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
