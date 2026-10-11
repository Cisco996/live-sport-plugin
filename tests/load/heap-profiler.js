/**
 * tests/load/heap-profiler.js
 *
 * Lightweight V8 heap profiler wrapper.
 * Measures RSS and heapUsed before/after each scenario or benchmark block.
 */

'use strict';

const v8 = require('v8');

const snapshots = [];

function snapshot(label) {
  if (typeof global.gc === 'function') {
    global.gc();
  }
  const mem = process.memoryUsage();
  const heap = typeof v8.getHeapStatistics === 'function' ? v8.getHeapStatistics() : {};
  const record = {
    label,
    timestamp: Date.now(),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external || 0,
    heapMallocedBytes: heap.malloced_memory || 0,
  };
  snapshots.push(record);
  return record;
}

function printReport() {
  console.log('\n🔬 HEAP MEMORY REPORT');
  console.log('='.repeat(80));
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const prev = snapshots[i - 1];
    const deltaRss = prev ? ((s.rssBytes - prev.rssBytes) / 1024 / 1024).toFixed(2) : '—';
    const deltaHeap = prev ? ((s.heapUsedBytes - prev.heapUsedBytes) / 1024 / 1024).toFixed(2) : '—';

    console.log(`\n[${i}] ${s.label}`);
    console.log(`   RSS       : ${(s.rssBytes / 1024 / 1024).toFixed(2)} MB  (Δ: ${deltaRss} MB)`);
    console.log(`   Heap Used : ${(s.heapUsedBytes / 1024 / 1024).toFixed(2)} MB  (Δ: ${deltaHeap} MB)`);
    console.log(`   Heap Total: ${(s.heapTotalBytes / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('='.repeat(80) + '\n');
}

function toJSON() {
  return snapshots.map((s, i) => {
    const prev = snapshots[i - 1];
    return {
      ...s,
      deltaRssMb: prev ? Number(((s.rssBytes - prev.rssBytes) / 1024 / 1024).toFixed(2)) : 0,
      deltaHeapUsedMb: prev ? Number(((s.heapUsedBytes - prev.heapUsedBytes) / 1024 / 1024).toFixed(2)) : 0,
    };
  });
}

function reset() {
  snapshots.length = 0;
}

module.exports = {
  snapshot,
  printReport,
  toJSON,
  reset
};
