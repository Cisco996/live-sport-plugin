# Project Guidelines & Agent Instructions

## Git Commit & GitHub Push Standards

Whenever staging, committing, or pushing changes to Git/GitHub in this workspace, you MUST follow these mandatory guidelines:

### 1. Detailed Commit Messages Required
Never create vague, one-line commit messages (e.g., "fix bug", "perf improvements", "update code").
Every commit message must be structured, descriptive, and follow the Conventional Commits format (`perf(...)`, `feat(...)`, `fix(...)`, `refactor(...)`).

### 2. Mandatory "Before & After" Section
Every commit message MUST include an explicit **Before & After** breakdown explaining:
- **Before:** The previous state, algorithmic complexity, memory churn, or behavior.
- **After:** The new optimized state, improved complexity, and architectural design.
- **Measured Impact:** Concrete benchmark/test metrics (e.g. latency, object allocations, comparison counts, throughput speedup).

### Example Commit Format:
```text
perf(catalog): implement Schwartzian transform and O(1) cache indexing

Summary:
- Precomputes expensive Unicode normalizations and regex classifiers once in O(N).
- Replaces 4-tier linear scans in CacheService with O(1) Map indices.
- Introduces getMatchesReadOnly() to eliminate deep-clone heap churn on read paths.
- Implements category bucketing in MatchAggregator to avoid quadratic provider scans.

Before & After:
• Catalog Sorting:
  - Before: O(N log N * K_regex) pairwise comparator evaluates 80+ regexes (690 ms on 3,000 items)
  - After:  O(N * K + N log N) Schwartzian transform with numeric primitives (75 ms on 3,000 items)
  - Impact: 89.1% faster CPU response

• Stream Match Resolution:
  - Before: Up to 4 consecutive linear scans through all matches (2,798 ms per 3,000 lookups)
  - After:  O(1) Hash Map index lookups (_byId, _byAlias, _bySourceId) (152 ms per 3,000 lookups)
  - Impact: 18.4x faster lookup throughput

• Memory & Database Reads:
  - Before: getMatches() deep-clones ~24,000 objects per read request (228 ms for 100 reads)
  - After:  getMatchesReadOnly() returns direct O(1) reference (0.17 ms for 100 reads)
  - Impact: 99.9% faster, zero GC heap allocation churn

• Aggregator Provider Merging:
  - Before: 1,500,000 comparisons across unindexed providers
  - After:  187,500 comparisons via sport category bucketing
  - Impact: 87.5% fewer iterations

Verification:
- Tested under 10,000 concurrent user mutations (tests/concurrencyStressAndIsolation.test.js)
- 40 test suites, 592 tests passing (100% green)
```
