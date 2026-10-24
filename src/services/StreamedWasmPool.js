'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

class StreamedWasmPool {
  constructor(opts = {}) {
    const defaultPoolSize = Math.max(1, Math.min(4, Number(process.env.STREAMED_WORKER_POOL_SIZE || 2)));
    this.poolSize = opts.poolSize || defaultPoolSize;
    this.workers = [];
    this.jobQueue = [];
    this.pendingResolvers = new Map();
    this.jobCounter = 0;
    this.isDestroyed = false;

    this._workerScriptPath = this._resolveWorkerScriptPath();
    this._initPool();
  }

  _resolveWorkerScriptPath() {
    const candidates = [
      path.join(__dirname, '..', 'providers', 'streamed_wasm_worker.js'),
      path.join(__dirname, 'streamed_wasm_worker.js'),
      path.join(process.cwd(), 'src', 'providers', 'streamed_wasm_worker.js'),
      path.join(process.cwd(), 'dist', 'streamed_wasm_worker.js')
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[0];
  }

  _initPool() {
    for (let i = 0; i < this.poolSize; i++) {
      this._spawnWorker(i);
    }
  }

  _spawnWorker(index) {
    if (this.isDestroyed) return;

    try {
      const worker = new Worker(this._workerScriptPath);
      const workerObj = {
        id: index,
        worker,
        ready: false,
        busy: false,
        currentJobId: null
      };

      worker.on('message', (msg) => {
        if (!msg) return;

        if (msg.type === 'ready') {
          workerObj.ready = true;
          this._drainQueue();
          return;
        }

        if (msg.jobId) {
          const resolver = this.pendingResolvers.get(msg.jobId);
          if (resolver) {
            this.pendingResolvers.delete(msg.jobId);
            clearTimeout(resolver.timer);
            if (msg.error) {
              resolver.resolve(null);
            } else {
              resolver.resolve(msg.m3u8Url || null);
            }
          }

          workerObj.busy = false;
          workerObj.currentJobId = null;
          this._drainQueue();
        }
      });

      worker.on('error', (err) => {
        console.error(`[StreamedWasmPool] Worker #${index} encountered error:`, err.message);
        if (workerObj.currentJobId) {
          const resolver = this.pendingResolvers.get(workerObj.currentJobId);
          if (resolver) {
            this.pendingResolvers.delete(workerObj.currentJobId);
            clearTimeout(resolver.timer);
            resolver.resolve(null);
          }
        }
      });

      worker.on('exit', (code) => {
        if (!this.isDestroyed) {
          console.warn(`[StreamedWasmPool] Worker #${index} exited with code ${code}. Respawning...`);
          const idx = this.workers.indexOf(workerObj);
          if (idx !== -1) {
            this.workers.splice(idx, 1);
          }
          this._spawnWorker(index);
        }
      });

      this.workers.push(workerObj);
    } catch (err) {
      console.error(`[StreamedWasmPool] Failed to spawn worker #${index}:`, err.message);
    }
  }

  _drainQueue() {
    if (this.jobQueue.length === 0) return;

    const idleWorker = this.workers.find(w => w.ready && !w.busy);
    if (!idleWorker) return;

    const job = this.jobQueue.shift();
    if (!job) return;

    idleWorker.busy = true;
    idleWorker.currentJobId = job.jobId;
    idleWorker.worker.postMessage({
      jobId: job.jobId,
      user: job.user,
      event: job.event,
      id: job.id,
      embedUrl: job.embedUrl
    });
  }

  async resolveWasmStream(user, event, id, embedUrl, timeoutMs = 12000) {
    if (typeof user === 'string' && (user.startsWith('http://') || user.startsWith('https://'))) {
      embedUrl = user;
      const match = embedUrl.match(/\/embed\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/i);
      if (match) {
        user = match[1];
        event = match[2];
        id = match[3];
      }
    }
    if (this.isDestroyed || this.workers.length === 0) {
      return null;
    }

    const jobId = `job_${++this.jobCounter}_${Date.now()}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingResolvers.has(jobId)) {
          this.pendingResolvers.delete(jobId);
          // Free worker if it was working on this timed-out job
          const w = this.workers.find(work => work.currentJobId === jobId);
          if (w) {
            w.busy = false;
            w.currentJobId = null;
          }
          resolve(null);
          this._drainQueue();
        }
      }, timeoutMs);

      this.pendingResolvers.set(jobId, { resolve, timer });

      const idleWorker = this.workers.find(w => w.ready && !w.busy);
      if (idleWorker) {
        idleWorker.busy = true;
        idleWorker.currentJobId = jobId;
        idleWorker.worker.postMessage({ jobId, user, event, id, embedUrl });
      } else {
        this.jobQueue.push({ jobId, user, event, id, embedUrl });
      }
    });
  }

  async destroy() {
    this.isDestroyed = true;
    for (const [jobId, item] of this.pendingResolvers.entries()) {
      clearTimeout(item.timer);
      item.resolve(null);
    }
    this.pendingResolvers.clear();
    this.jobQueue = [];

    const terminations = this.workers.map(w => w.worker.terminate().catch(() => {}));
    await Promise.allSettled(terminations);
    this.workers = [];
  }
}

// Export singleton instance as well as class
const defaultInstance = new StreamedWasmPool();
defaultInstance.StreamedWasmPool = StreamedWasmPool;

module.exports = defaultInstance;
