module.exports = {
  apps: [
    {
      name: 'nuvio-sports',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '1300M',
      node_args: '--expose-gc',
      env: {
        NODE_ENV: 'production',
        MALLOC_ARENA_MAX: '2',
        MALLOC_CONF: 'narenas:2,dirty_decay_ms:5000,muzzy_decay_ms:5000',
        LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2',
        UV_THREADPOOL_SIZE: '64',
        PREWARM_MAX_MATCHES: '12',
        PREWARM_CRON_SCHEDULE: '*/3 * * * *',
        WARP_PROXY_URL: 'socks5://127.0.0.1:40000'
      }
    }
  ]
};
