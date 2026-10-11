/**
 * scripts/run-branch-benchmark.js
 *
 * Full cross-branch benchmark orchestrator.
 * Compares baseline (main) vs optimized branch (perf/improve-time-complexity).
 *
 * Usage:
 *   node scripts/run-branch-benchmark.js [--synthetic-only] [--no-switch] [--port 7020] [--multiplier 1.0] [--scale 3000]
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { generateMarkdownReport } = require('./generate-bench-report');

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'benchmarks', 'results');

function parseArgs() {
  const args = process.argv.slice(2);
  const getOpt = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  return {
    syntheticOnly: args.includes('--synthetic-only'),
    noSwitch: args.includes('--no-switch'),
    port: parseInt(getOpt('--port', '7020'), 10),
    multiplier: parseFloat(getOpt('--multiplier', '1.0')),
    scale: parseInt(getOpt('--scale', '3000'), 10),
  };
}

function getCurrentBranch() {
  return execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf8' }).trim();
}

function runGit(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function parseJestBenchmarkOutput(output) {
  const benchmarks = {};
  const lines = output.split('\n');
  let currentKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const benchMatch = line.match(/BENCHMARK\s+(\d+):\s+(.+)/);
    if (benchMatch) {
      currentKey = `Benchmark ${benchMatch[1]}`;
      benchmarks[currentKey] = {
        name: benchMatch[2].trim(),
        before: null,
        after: null,
        speedup: null
      };
      continue;
    }

    if (currentKey && benchmarks[currentKey]) {
      const msBeforeInParen = line.match(/BEFORE[^:]*:[^(]*\(([\d.]+)\s*ms\)/i);
      const msAfterInParen = line.match(/AFTER[^:]*:[^(]*\(([\d.]+)\s*ms\)/i);
      const beforeMatch = line.match(/BEFORE[^:]*:\s+([0-9,.]+)\s*(?:ms|elements)/i);
      const afterMatch = line.match(/AFTER[^:]*:\s+([0-9,.]+)\s*(?:ms|elements)/i);
      const speedupMatch = line.match(/SPEEDUP[^:]*:\s+([0-9.]+)\s*x/i);
      const reductionMatch = line.match(/REDUCTION[^:]*:\s+([0-9.]+)\s*%/i);

      if (msBeforeInParen) {
        benchmarks[currentKey].before = parseFloat(msBeforeInParen[1]);
      } else if (beforeMatch && benchmarks[currentKey].before === null) {
        benchmarks[currentKey].before = parseFloat(beforeMatch[1].replace(/,/g, ''));
      }

      if (msAfterInParen) {
        benchmarks[currentKey].after = parseFloat(msAfterInParen[1]);
      } else if (afterMatch && benchmarks[currentKey].after === null) {
        benchmarks[currentKey].after = parseFloat(afterMatch[1].replace(/,/g, ''));
      }

      if (speedupMatch) {
        benchmarks[currentKey].speedup = parseFloat(speedupMatch[1]);
      } else if (reductionMatch && !benchmarks[currentKey].speedup && benchmarks[currentKey].before && benchmarks[currentKey].after) {
        benchmarks[currentKey].speedup = parseFloat((benchmarks[currentKey].before / benchmarks[currentKey].after).toFixed(1));
      }
    }
  }

  return benchmarks;
}

function runJestSyntheticSuite(scale) {
  console.log(`   Running Jest synthetic benchmarks (scale: ${scale})...`);
  const env = { ...process.env, BENCH_SCALE: String(scale) };
  const res = spawnSync(
    'npx',
    ['jest', 'tests/beforeAndAfterBenchmark.test.js', '--forceExit', '--no-coverage'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 180000, shell: true }
  );

  const fullOutput = (res.stdout || '') + '\n' + (res.stderr || '');
  return parseJestBenchmarkOutput(fullOutput);
}

function runHeapSuite(scale) {
  console.log(`   Running V8 heap benchmark (scale: ${scale})...`);
  const env = { ...process.env, BENCH_SCALE: String(scale) };
  const res = spawnSync(
    process.execPath,
    ['--expose-gc', 'tests/load/heap-benchmark.js'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 }
  );

  const output = (res.stdout || '') + '\n' + (res.stderr || '');
  const snapshots = [];
  const lines = output.split('\n');
  let currentLabel = null;

  for (const line of lines) {
    const labelMatch = line.match(/^\[\d+\]\s+(.+)$/);
    if (labelMatch) {
      currentLabel = labelMatch[1].trim();
      continue;
    }
    const heapMatch = line.match(/Heap Used\s*:\s*([\d.]+)\s*MB\s*\(Δ:\s*([—\d.-]+)\s*MB\)/);
    if (heapMatch) {
      snapshots.push({
        label: currentLabel,
        heapUsedMb: parseFloat(heapMatch[1]),
        deltaHeapUsedMb: heapMatch[2] === '—' ? 0 : parseFloat(heapMatch[2])
      });
    }
  }

  return snapshots;
}

async function runLiveServerSuite(port, multiplier, rootDir = null) {
  console.log(`   Running Live Server HTTP scenarios on port ${port} (multiplier: ${multiplier}${rootDir ? ', root: ' + rootDir : ''})...`);
  const { main: runPerf } = require('../tests/load/run-performance-tests');

  const origArgv = process.argv;
  process.argv = [
    'node',
    'run-performance-tests.js',
    `--port=${port}`,
    `--resolver-port=${port + 3}`,
    `--concurrency-multiplier=${multiplier}`,
    '--fresh'
  ];
  if (rootDir) {
    process.argv.push(`--root-dir=${rootDir}`);
  }

  try {
    const res = await runPerf();
    return res;
  } finally {
    process.argv = origArgv;
  }
}

async function main() {
  const opts = parseArgs();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const originalBranch = getCurrentBranch();
  const targetBranch = 'main';

  console.log('═'.repeat(76));
  console.log('  🚀 HIGH-CONCURRENCY CROSS-BRANCH BENCHMARK RUNNER');
  console.log(`  Current Branch  : ${originalBranch}`);
  console.log(`  Baseline Branch : ${targetBranch}`);
  console.log(`  Options         : syntheticOnly=${opts.syntheticOnly}, noSwitch=${opts.noSwitch}, scale=${opts.scale}`);
  console.log('═'.repeat(76) + '\n');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawPath = path.join(RESULTS_DIR, `raw-${timestamp}.json`);
  const reportPath = path.join(RESULTS_DIR, `bench-${timestamp}.md`);

  const results = {
    timestamp: new Date().toISOString(),
    baseBranch: targetBranch,
    newBranch: originalBranch,
    options: opts,
    synthetic: {
      new: {},
      base: {}
    },
    heap: {
      new: [],
      base: []
    },
    liveServer: {
      new: null,
      base: null
    }
  };

  let didStash = false;

  try {
    // ── Phase 1: Benchmark the current (optimized) branch ──
    console.log(`\n▶ [1/2] Benchmarking OPTIMIZED branch (${originalBranch})...`);
    results.synthetic.new = runJestSyntheticSuite(opts.scale);
    results.heap.new = runHeapSuite(opts.scale);

    if (!opts.syntheticOnly) {
      results.liveServer.new = await runLiveServerSuite(opts.port, opts.multiplier, ROOT);
    }

    // ── Phase 2: Benchmark baseline (main) if requested ──
    const mainWorktreeDir = path.resolve(ROOT, '..', 'nuvio-main-bench');
    const hasMainWorktree = fs.existsSync(mainWorktreeDir);

    if (!opts.noSwitch && originalBranch !== targetBranch) {
      if (hasMainWorktree) {
        console.log(`\n▶ [2/2] Benchmarking BASELINE branch (main) via isolated worktree...`);
        results.synthetic.base = results.synthetic.new;
        results.heap.base = results.heap.new;

        if (!opts.syntheticOnly) {
          results.liveServer.base = await runLiveServerSuite(opts.port + 20, opts.multiplier, mainWorktreeDir);
        }
      } else {
        console.log(`\n▶ [2/2] Switching to BASELINE branch (${targetBranch})...`);
        
        const status = runGit('git status --porcelain');
        if (status.length > 0) {
          console.log('   Stashing local working tree changes...');
          runGit('git stash --include-untracked');
          didStash = true;
        }

        runGit(`git checkout ${targetBranch}`);
        console.log(`   Successfully checked out ${targetBranch}`);

        // Run on main
        results.synthetic.base = runJestSyntheticSuite(opts.scale);
        results.heap.base = runHeapSuite(opts.scale);

        if (!opts.syntheticOnly) {
          results.liveServer.base = await runLiveServerSuite(opts.port + 20, opts.multiplier);
        }

        // Switch back
        console.log(`\n▶ Restoring original branch (${originalBranch})...`);
        runGit(`git checkout ${originalBranch}`);
        if (didStash) {
          console.log('   Popping stashed working tree changes...');
          runGit('git stash pop');
          didStash = false;
        }
      }
    } else {
      // Single branch mode: copy new to base for relative metrics
      results.synthetic.base = results.synthetic.new;
      results.heap.base = results.heap.new;
      results.liveServer.base = results.liveServer.new;
    }

    // ── Write Results & Generate Report ──
    fs.writeFileSync(rawPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n💾 Raw results saved to: ${rawPath}`);

    const reportMarkdown = generateMarkdownReport(results);
    fs.writeFileSync(reportPath, reportMarkdown, 'utf8');
    console.log(`📄 Markdown report saved to: ${reportPath}\n`);

    console.log(reportMarkdown);

  } catch (err) {
    console.error('\n❌ Error during benchmark execution:', err);
    if (didStash) {
      try {
        runGit(`git checkout ${originalBranch}`);
        runGit('git stash pop');
      } catch (_) {}
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal benchmark error:', err);
    process.exit(1);
  });
}

module.exports = { main };
