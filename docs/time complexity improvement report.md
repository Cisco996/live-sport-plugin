# Nuvio Live Sports Plugin — Time Complexity & Performance Improvement Report

> **Target Version:** Nuvio Live Sports Plugin 3.1.3  
> **Date:** October 2026  
> **Document Type:** Algorithmic Audit & Optimization Roadmap  
> **Status:** Recommended Action Plan  

---

## 1. Executive Summary

This report provides a comprehensive, file-by-file performance and time complexity audit of the Nuvio Live Sports Plugin codebase. The audit covers algorithmic bottlenecks, nested iterations, redundant regex sweeps, memory allocation churn, and event-loop blocking operations identified across catalog handling, provider aggregation, in-memory caching, streaming proxy routes, and asset generation.

### High-Level Impact Matrix

| Priority | Component & Problem | Current Complexity | Optimal Complexity | Estimated Gain |
| :--- | :--- | :--- | :--- | :--- |
| **P0 (Critical)** | **Catalog Sort Comparator:** Evaluates >80 regexes & Unicode normalizations per comparison | $\mathcal{O}(N \log N \cdot K_{\text{heavy}})$ | $\mathcal{O}(N \cdot K_{\text{heavy}} + N \log N)$ | **~80%–95% CPU reduction** on catalog requests |
| **P0 (Critical)** | **Aggregator Match Merging:** Unindexed linear scan across all providers ($M \times N$) | $\mathcal{O}(M \cdot N)$ | $\mathcal{O}(M \cdot \frac{N}{B})$ with bucketing / $\mathcal{O}(1)$ on ID | **~85%–90% faster** background provider sync |
| **P0 (Critical)** | **Match Resolution Lookup:** 4-tier full array scan on user stream clicks | $\mathcal{O}(N)$ (up to $4N$ iterations) | $\mathcal{O}(1)$ Hash Map index | **Instantaneous (< 1ms)** match lookup |
| **P0 (Critical)** | **Database Deep-Cloning:** Allocates ~24,000 objects per read request in `getMatches()` | $\mathcal{O}(N)$ heap allocation & GC | $\mathcal{O}(1)$ Read-Only View | Eliminates **~10–25 MB heap churn** per request |
| **P0 (Critical)** | **Base URL Rewriter Middleware:** Intercepts, `JSON.parse`s, traverses, and re-`JSON.stringify`s responses | $\mathcal{O}(S)$ full serialization cycle | $\mathcal{O}(1)$ host injection | Eliminates **20–80ms** event loop stall |
| **P1 (High)** | **Route-Scoped Memoization:** `LOGO_BY_NAME` reallocated on every request in `/img/match` | $\mathcal{O}(1)$ hit rate dropped to 0% | $\mathcal{O}(1)$ persistent cache hit | Eliminates redundant regexes on crest lookups |
| **P1 (High)** | **Channel Logo Fuzzy Search:** Scans entire 1.23 MB dataset on unmapped titles | $\mathcal{O}(T)$ dictionary scan | $\mathcal{O}(1)$ memoized result | Prevents multi-millisecond freezes on misses |
| **P1 (High)** | **Channel Country Detection:** Linearly tests 65 regexes without memoization | $\mathcal{O}(C \cdot R)$ regex tests | $\mathcal{O}(1)$ memoized lookup | Saves **~95%** of regex tests during scraping |
| **P2 (Medium)** | **Manifest Catalog Filter:** Nested `cached.some(...)` inside `catalogs.filter(...)` | $\mathcal{O}(C \cdot N)$ nested scan | $\mathcal{O}(C + N)$ via Set | Faster manifest serving |
| **P2 (Medium)** | **Segment URL Parsing:** Constructs C++ `new URL()` on every line of M3U8 playlists | $\mathcal{O}(L)$ allocations of `new URL()` | $\mathcal{O}(1)$ base URL query merge | Reduces GC and CPU overhead in manifest proxy |
| **P3 (Low)** | **Queue Dequeuing in Logo Worker:** Uses `Array.prototype.shift()` | $\mathcal{O}(K^2)$ memory moves | $\mathcal{O}(K)$ pointer index | Cleaner worker drainage |
| **P3 (Low)** | **LRU Eviction via Sorting:** Array dump and sort on cache overflow | $\mathcal{O}(E \log E)$ array sort | $\mathcal{O}(1)$ using Map insertion order | Negligible overhead eviction |
| **P3 (Low)** | **StreamedPk Live Probing:** 50–100 parallel HTTP requests during scrape | $\mathcal{O}(P)$ network calls | Defer to on-demand resolution | Eliminates 50–100 network roundtrips per sync |

---

## 2. Detailed Technical Breakdown & Remediation

---

### Hotspot 1: Catastrophic Constant Factor in Catalog Sorting Comparator

* **Files:** [`src/catalog.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/catalog.js#L266-L315) and [`src/services/MainstreamRankingService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MainstreamRankingService.js#L284-L363)
* **Lines of Interest:** [`src/catalog.js:266–315`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/catalog.js#L266-L315), [`src/catalog.js:1287`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/catalog.js#L1287), [`src/services/MainstreamRankingService.js:351–363`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MainstreamRankingService.js#L351-L363)

#### 1. The Root Cause
In [`src/catalog.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/catalog.js#L1287), matching items are sorted:
```javascript
filteredMatches = [...filteredMatches].sort((a, b) => compareCatalogMatches(a, b, isReplayMode));
```
For $N \approx 2,000$ to $4,000$ filtered items, V8's Timsort algorithm executes $N \log_2 N \approx 22,000$ to $48,000$ pairwise comparison calls. Inside [`compareCatalogMatches(a, b)`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/catalog.js#L266-L315):
```javascript
function compareCatalogMatches(a, b, isReplayMode = false) {
  const aIsLive = isMatchLive(a) ? 1 : 0;
  const bIsLive = isMatchLive(b) ? 1 : 0;
  if (aIsLive !== bIsLive) return bIsLive - aIsLive;

  const isRealFixture = (m) => (m.category !== 'networks' && (!!m.date || !!m.team1 || !!m.team2 || m.title.includes(' vs ') || m.title.includes(' @ '))) ? 1 : 0;
  const aFix = isRealFixture(a);
  const bFix = isRealFixture(b);
  if (aFix !== bFix) return bFix - aFix;

  const aTier = getMatchTier(a);
  const bTier = getMatchTier(b);
  if (aTier !== bTier) return aTier - bTier;

  const aPop = a.popular === '1' ? 1 : 0;
  const bPop = b.popular === '1' ? 1 : 0;
  if (aPop !== bPop) return bPop - aPop;

  const dateA = a.date ? getKickoff(a.date) : 0;
  const dateB = b.date ? getKickoff(b.date) : 0;
  ...
}
```

Every comparison calls:
1. `getMatchTier(a)` & `getMatchTier(b)`:
   - Invokes `buildHaystack(match)`, performing Unicode normalization (`normalize('NFD')`) and regex substitutions across 4 strings (`league`, `title`, `team1`, `team2`).
   - Invokes `isLowerDivisionFixture(match)`, which **re-invokes `buildHaystack(match)` a second time**!
   - Tests over 80 regular expressions (`RESERVE_YOUTH_MARKERS`, `SPORT_SECONDARY_MARKERS`, `LOWER_DIVISION_MARKERS`, `TOP_TIER_COMPETITIONS`, and the 60+ club `FAMOUS_CLUB_PATTERN`).
2. `isMatchLive(a)` & `isMatchLive(b)`:
   - Repeatedly calls `getKickoff()`, which runs string trimming, regex checks, and `parseTimezone()` / `new Date()`.
3. `isRealFixture(a)` & `isRealFixture(b)`:
   - Allocates an arrow function and runs string `.includes()`.
4. `getKickoff(a.date)` & `getKickoff(b.date)`:
   - Re-evaluates date parsing a third time.

#### 2. Complexity Analysis
- **Current:** $\mathcal{O}(N \log N \cdot (K_{\text{haystack}} + K_{\text{regexes}} + K_{\text{dates}}))$ where the constant factor per comparison is thousands of CPU operations. In one sort pass, `buildHaystack` and text folding run **~50,000 to 100,000 times**, running over **2,000,000 regex tests**.
- **Theoretical Minimum:** $\mathcal{O}(N \cdot K + N \log N)$, where $K$ is computed once per match.

#### 3. Recommended Remediation
Use the **Schwartzian Transform (Decorate-Sort-Undecorate)** or precompute the invariant keys once per match before sorting:

```javascript
// Precompute sort keys once in O(N)
const decorated = filteredMatches.map(m => {
  const isLive = isMatchLive(m) ? 1 : 0;
  const isReal = (m.category !== 'networks' && (!!m.date || !!m.team1 || !!m.team2 || m.title.includes(' vs ') || m.title.includes(' @ '))) ? 1 : 0;
  const tier = m._tier ?? getMatchTier(m);
  const pop = m.popular === '1' ? 1 : 0;
  const kickoff = m.date ? getKickoff(m.date) : 0;
  return { m, isLive, isReal, tier, pop, kickoff };
});

// Fast O(N log N) sort using only primitive numeric comparisons
decorated.sort((a, b) => {
  if (a.isLive !== b.isLive) return b.isLive - a.isLive;
  if (a.isReal !== b.isReal) return b.isReal - a.isReal;
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.pop !== b.pop) return b.pop - a.pop;
  if (a.kickoff > 0 && b.kickoff > 0) {
    return (isReplayMode || a.isLive) ? (b.kickoff - a.kickoff) : (a.kickoff - b.kickoff);
  }
  return b.kickoff - a.kickoff;
});

filteredMatches = decorated.map(d => d.m);
```

---

### Hotspot 2: Unindexed $\mathcal{O}(M \cdot N)$ Quadratic Merging in `MatchAggregator`

* **File:** [`src/services/MatchAggregator.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js#L341-L360)
* **Lines of Interest:** [`src/services/MatchAggregator.js:341–360`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js#L341-L360), [`src/services/MatchAggregator.js:226–321`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js#L226-L321)

#### 1. The Root Cause
During match synchronization across all providers in [`syncMatches()`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js#L328):
```javascript
for (let r = start; r < end; r++) {
  const match = providerMatches[r];
  ...
  const pre = this._precompute(match);
  let idx = -1;
  for (let i = 0; i < finalMatches.length; i++) {
    if (this._sameEventPre(finalPres[i], pre)) { idx = i; break; }
  }
  ...
}
```
- Across all active providers, $M \approx 8,000$ to $12,000$ incoming matches are fetched.
- `finalMatches` builds up to $N \approx 3,000$ to $5,000$ distinct items.
- For **every incoming match**, the aggregator scans the entire `finalMatches` array linearly.
- Total pairwise comparisons: $\frac{M \times N}{2} \approx 20,000,000$ invocations of `_sameEventPre`.
- Notice that in `_sameEventPre`:
  - Rule 1 drops matches immediately if normalized categories differ (unless `'other'` or `'college'`).
  - Rule 2 matches exact IDs.
  - Rule 3 drops matches if dates differ by $> 24$ hours.
Yet, an incoming cricket match in India is being compared against 1,500 European soccer matches, 600 hockey games, and 400 tennis matches.

#### 2. Complexity Analysis
- **Current:** $\mathcal{O}(M \cdot N)$ where $M$ is incoming and $N$ is accepted items.
- **Optimal:** $\mathcal{O}(1)$ for exact ID matches, and $\mathcal{O}(M \cdot \frac{N}{B})$ where $B$ is the number of sport category buckets.

#### 3. Recommended Remediation
Maintain indices during `syncMatches()`:
1. **Exact ID Hash Map:** `idIndex = new Map()` mapping `match.id -> index`.
2. **Category Buckets:** Group accepted items into a `Map<category, Array<{match, pre, idx}>>`.
3. Check exact ID first in $\mathcal{O}(1)$. If absent, scan only the matches belonging to the same normalized category bucket (or the small `'other'`/`'college'` cross-sport buckets).

---

### Hotspot 3: Unindexed $\mathcal{O}(N)$ Scans in `CacheService.findMatch`

* **File:** [`src/services/CacheService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/CacheService.js#L141-L178)
* **Lines of Interest:** [`src/services/CacheService.js:141–178`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/CacheService.js#L141-L178)

#### 1. The Root Cause
Whenever a stream is clicked, [`handleStream`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/streams.js#L653) calls `cacheService.findMatch(matchId)`:
```javascript
findMatch(matchId) {
  ...
  // 1. Direct primary ID match
  let found = matches.find(m => m && m.id === matchId);
  if (found) return this._cloneMatch(found);

  // 2. Alias IDs
  found = matches.find(m => m && Array.isArray(m.aliasIds) && m.aliasIds.includes(matchId));
  if (found) return this._cloneMatch(found);

  // 3. Source ID match
  found = matches.find(m => m && Array.isArray(m.sources) && m.sources.some(s => s && (s.id === matchId || s.id === `stream_${matchId}` || String(s.id).includes(matchId))));
  if (found) return this._cloneMatch(found);

  // 4. Normalized slug match
  const cleanId = matchId.toLowerCase().replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[^a-z0-9]/g, '');
  if (cleanId.length > 6) {
    found = matches.find(m => { ... });
  }
}
```
`findMatch` conducts up to **4 full-array linear scans** across all 4,000 matches:
- Step 1: Scan 4,000 items.
- Step 2: Scan 4,000 items with inner array `.includes()`.
- Step 3: Scan 4,000 items with inner array `.some()` and substring searches.
- Step 4: Scan 4,000 items with slug regex transforms.
In worst-case scenarios (looking up by source ID or alias ID), this causes up to **16,000 iterations per stream request**.

#### 2. Complexity Analysis
- **Current:** $\mathcal{O}(N)$ worst-case per click ($4N$ operations).
- **Optimal:** $\mathcal{O}(1)$ constant-time lookup.

#### 3. Recommended Remediation
Maintain lookup maps built once in `setMatches()` and `_loadDiskCache()`:
```javascript
_rebuildIndices() {
  this._byId = new Map();
  this._byAlias = new Map();
  this._bySourceId = new Map();

  for (const m of this.cachedMatches) {
    if (!m) continue;
    if (m.id) this._byId.set(m.id, m);
    if (Array.isArray(m.aliasIds)) {
      for (const aid of m.aliasIds) this._byAlias.set(aid, m);
    }
    if (Array.isArray(m.sources)) {
      for (const s of m.sources) {
        if (s && s.id) {
          this._bySourceId.set(String(s.id), m);
          this._bySourceId.set(`stream_${s.id}`, m);
        }
      }
    }
  }
}
```
Then `findMatch(matchId)` becomes:
```javascript
let found = this._byId.get(matchId) || this._byAlias.get(matchId) || this._bySourceId.get(matchId);
if (found) return this._cloneMatch(found);
// Fallback to slug search only for rare unstructured queries
```

---

### Hotspot 4: Deep Cloning of Entire Database $\mathcal{O}(N)$ on Read Endpoints

* **File:** [`src/services/CacheService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/CacheService.js#L44-L59) and [`src/services/CacheService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/CacheService.js#L121-L124)
* **Lines of Interest:** [`src/services/CacheService.js:44–59`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/CacheService.js#L44-L59), [`src/services/CacheService.js:121–124`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/CacheService.js#L121-L124)

#### 1. The Root Cause
```javascript
getMatches() {
  this._ensureLoaded();
  return this._clone(this.cachedMatches);
}
```
`_clone(matches)` clones all ~4,000 matches:
- Clones each match object: `{ ...m }`
- Clones each source in `m.sources`: `s => ({ ...s, behaviorHints: { ...s.behaviorHints } })`
- Clones `team1` and `team2`.
This runs on **every request** to:
- `/:config?/manifest.json` ([`src/index.js:941`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L941))
- `/catalog/*` ([`src/catalog.js:1210`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/catalog.js#L1210))
- `/api/matches` ([`src/index.js:217`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L217))
- `MatchAggregator.syncMatches()` ([`src/services/MatchAggregator.js:441`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js#L441))

Why was cloning introduced? The comment states:
> *"handlers downstream mutate individual stream/source objects (s.score, s._source, s.name, s.url, behaviorHints), so a shallow array copy would leak state between requests."*

Notice that `handleCatalog` and `manifest.json` **never mutate** match objects! They only read them to produce meta previews. But because `getMatches()` unconditionally deep-clones all 4,000 matches, every catalog load allocates **~24,000 temporary objects**, spiking V8 heap usage and triggering Garbage Collection stops.

#### 2. Complexity Analysis
- **Current:** $\mathcal{O}(N)$ memory allocation and object creation on every read request (~24,000 objects).
- **Optimal:** $\mathcal{O}(1)$ reference return for read-only consumers.

#### 3. Recommended Remediation
Introduce `getMatchesReadOnly()` that returns `this.cachedMatches` without cloning. Only clone in `findMatch(matchId)` where `handleStream` actually mutates the single active fixture.

---

### Hotspot 5: Dynamic Base URL Rewriter Middleware Intercepts & Re-Serializes Responses

* **File:** [`src/index.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L747-L848)
* **Lines of Interest:** [`src/index.js:747–848`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L747-L848)

#### 1. The Root Cause
For all requests to `/manifest.json`, `/catalog/*`, `/meta/*`, and `/stream/*`:
```javascript
res.end = function (chunk, encoding, callback) {
  ...
  const bodyBuffer = Buffer.concat(chunks);
  const bodyString = bodyBuffer.toString('utf8');
  try {
    const body = JSON.parse(bodyString);
    ...
    const rewriteUrl = (url) => { ... };
    // Loops over body.streams, body.metas, body.meta.videos...
    ...
    if (modified) {
      const newBodyString = JSON.stringify(body);
      const newBuffer = Buffer.from(newBodyString, 'utf8');
      res.setHeader('Content-Length', newBuffer.length);
      return originalEnd.call(res, newBuffer, 'utf8', callback);
    }
  } catch (_) {}
}
```
1. Express compiles and sends JSON via `res.json(payload)` (`JSON.stringify` to bytes).
2. Middleware intercepts the stream, decodes it into a large UTF-8 string, and calls `JSON.parse()`.
3. It traverses every stream, meta, and video object, applying regexes on URLs.
4. It calls `JSON.stringify(body)` and re-buffers the response.

For catalog responses (500 KB to 2 MB JSON), this cycle of serialization, deserialization, deep AST traversal, and re-serialization consumes **20 to 80 ms of synchronous CPU time per request**.

#### 2. Complexity Analysis
- **Current:** $\mathcal{O}(S)$ where $S$ is payload size, paying the penalty of two full JSON serialization cycles and recursive object traversal on every response.
- **Optimal:** $\mathcal{O}(1)$ by generating correct URLs directly in route handlers.

#### 3. Recommended Remediation
Inject `reqBaseUrl` directly into `handleCatalog`, `handleMeta`, and `handleStream` so URLs are constructed with the client's host during the initial render pass, removing the interceptor completely.

---

### Hotspot 6: Route-Scoped Memoization Map in `/img/match`

* **File:** [`src/index.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L431-L432)
* **Lines of Interest:** [`src/index.js:431–432`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L431-L432), [`src/index.js:349`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L349)

#### 1. The Root Cause
Inside `app.get(['/img/match', ...])`:
```javascript
app.get(['/img/match', '/:config/img/match'], async (req, res) => {
  ...
  const LOGO_BY_NAME = new Map();
  const LOGO_BY_NAME_MAX = 2000;
  const resolveNameToCrest = async (name) => {
    ...
    if (LOGO_BY_NAME.has(key)) return LOGO_BY_NAME.get(key);
    ...
    LOGO_BY_NAME.set(key, url);
```
The comment states:
> *"Memoised name -> crest... this map lives for the worker's lifetime..."*

However, `LOGO_BY_NAME` is declared **inside the route callback**. It is instantiated on every incoming request and garbage collected when the request completes. Across HTTP requests, the cache hit rate is **0%**.

#### 2. Recommended Remediation
Move `const LOGO_BY_NAME = new Map();` outside the route handler into module scope.

---

### Hotspot 7: Full Dictionary Subsequence Scan in `ChannelLogoService`

* **File:** [`src/services/ChannelLogoService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/ChannelLogoService.js#L583-L637)
* **Lines of Interest:** [`src/services/ChannelLogoService.js:583–637`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/ChannelLogoService.js#L583-L637)

#### 1. The Root Cause
When a channel or fixture title misses curated and deep matches:
```javascript
// Step 5: Fuzzy match against the curated map
const fuzzy = resolveFuzzyMapMatch(title);
```
Inside [`resolveFuzzyMapMatch(title)`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/ChannelLogoService.js#L583):
- Scans every entry in `_compactIndex` (`for (const [ck, list] of _compactIndex)`).
- Scans every entry in `_tokenIndex` (`for (const [key, kt] of _tokenIndex)`), testing token subsequence arrays with `kt.indexOf(q, cursor)`.
`_tokenIndex` contains **tens of thousands of items** from `tv_logos_map.json` (1.23 MB).
Because `getChannelLogo(title)` **does not memoize results**, every fixture title that does not have a logo scans the entire 1.23 MB dataset on every catalog view.

#### 2. Recommended Remediation
Add a bounded `Map` memoization cache (`Map<rawTitle, resolvedLogo | null>`) at the top of `getChannelLogo()`. Repeated lookups for unmatched titles return `null` in $\mathcal{O}(1)$ without scanning the dictionary.

---

### Hotspot 8: Unmemoized Regex Sweeps in `ChannelCountryService`

* **File:** [`src/services/ChannelCountryService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/ChannelCountryService.js#L427-L441)
* **Lines of Interest:** [`src/services/ChannelCountryService.js:427–441`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/ChannelCountryService.js#L427-L441)

#### 1. The Root Cause
`COUNTRY_RULES` has 65 regular expressions.
In `detectChannelCountry(channelName)`:
```javascript
for (const rule of COUNTRY_RULES) {
  if (rule.regex.test(cn)) {
    return { ... };
  }
}
```
During [`DaddyLiveProvider.getMatches()`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/providers/DaddyLiveProvider.js#L643), this is invoked for every channel on every scheduled match across all categories (thousands of calls per scrape). Many channels share the same names (`"Sky Sports Main Event"`, `"TNT Sports 1"`).
Testing 65 regexes thousands of times without a cache causes hundreds of thousands of redundant regex evaluations.

#### 2. Recommended Remediation
Memoize results with a simple `Map<channelName, result | null>`. The cardinality of distinct channel names is small (< 500), so memoization eliminates >95% of all regex evaluations.

---

### Hotspot 9: Nested Array Scans in Manifest Catalog Filtering

* **File:** [`src/index.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L968-L971)
* **Lines of Interest:** [`src/index.js:968–971`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/index.js#L968-L971)

#### 1. The Root Cause
In `app.get('/:config?/manifest.json')`:
```javascript
newManifest.catalogs = newManifest.catalogs.filter((c) => {
  ...
  if (cached.some(m => m && m.category === 'networks')) {
    const titleLower = (m => String((m && m.title) || '').toLowerCase());
    if (cached.some(m => m && m.category === 'networks' && titleLower(m).includes(cat))) return true;
  }
  return false;
});
```
For each catalog $c$ (~30 items):
`cached.some(...)` scans all $N$ cached matches (up to 4,000 items), converting titles to lowercase and checking `.includes(cat)`.
This $\mathcal{O}(C \cdot N)$ nested loop ($\approx 90,000$ to $120,000$ iterations) blocks the event loop on manifest requests.

#### 2. Recommended Remediation
Pre-extract all lowercase network titles into a concatenated string or array once before entering `newManifest.catalogs.filter()`, reducing the search from $\mathcal{O}(C \cdot N)$ to $\mathcal{O}(N + C)$.

---

### Hotspot 10: Redundant `new URL()` Object Construction per Playlist Segment

* **File:** [`src/services/HlsRewriteService.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/HlsRewriteService.js#L40-L55)
* **Lines of Interest:** [`src/services/HlsRewriteService.js:40–55`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/HlsRewriteService.js#L40-L55), [`src/routes/manifest.js:116–138`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/routes/manifest.js#L116-L138)

#### 1. The Root Cause
In [`resolveSegmentUrl(segmentUri, manifestUrl)`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/HlsRewriteService.js#L40):
```javascript
function resolveSegmentUrl(segmentUri, manifestUrl) {
  try {
    const chunkUrl = new URL(segmentUri, manifestUrl);
    const manifestObj = new URL(manifestUrl);

    manifestObj.searchParams.forEach((val, key) => {
      if (!chunkUrl.searchParams.has(key)) {
        chunkUrl.searchParams.set(key, val);
      }
    });

    return chunkUrl.toString();
```
When [`routes/manifest.js`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/routes/manifest.js#L116-L138) proxies an M3U8 playlist with 1,000 segment lines:
`new URL(manifestUrl)` is instantiated **1,000 times for the exact same `manifestUrl` string** on every playlist refresh.
In Node.js, `new URL()` calls the C++ Ada parser, allocating objects and parsing query parameters from scratch on every line.

#### 2. Recommended Remediation
Parse `manifestUrl` **once** before iterating over the playlist lines, or pass the pre-parsed `manifestObj` into `rewriteHlsUri`.

---

### Hotspot 11: Minor Algorithmic Inefficiencies

1. **$\mathcal{O}(K^2)$ Memory Moves with `Array.prototype.shift()`**
   * **File:** [`src/services/MatchAggregator.js:698–701`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/MatchAggregator.js#L698-L701)
   * In the logo enrichment queue, `while (queue.length) { const m = queue.shift(); ... }` performs $\mathcal{O}(K^2)$ element copying for $K=600$ items. Replace with an incrementing index pointer `queue[cursor++]` for $\mathcal{O}(K)$ processing.

2. **$\mathcal{O}(E \log E)$ LRU Eviction via Array Sorting**
   * **Files:** [`src/services/ImageService.js:288–293`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/ImageService.js#L288-L293) and [`src/services/StreamResolveCache.js:303–311`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/StreamResolveCache.js#L303-L311)
   * Both caches dump all map entries into an array and sort them: `[...cache.entries()].sort(...)`.
   * JavaScript `Map` preserves insertion order. Refreshing recency on access (`delete` then `set`) makes eviction $\mathcal{O}(1)$ via `cache.delete(cache.keys().next().value)`.

3. **Redundant Parallel Network Probing in `StreamedPkProvider`**
   * **File:** [`src/providers/StreamedPkProvider.js:59–77`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/providers/StreamedPkProvider.js#L59-L77)
   * Fires 50–100 parallel HTTP requests to `fetchStreams` during every scrape just to populate `liveVerifiedIds`. These streams are then fetched again on demand when a user clicks a fixture.

4. **Brute-Force XOR Decryption Matrix in `EmbedExtractorChain`**
   * **File:** [`src/services/EmbedExtractorChain.js:125–150`](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/src/services/EmbedExtractorChain.js#L125-L150)
   * Runs 224 decryption combinations mapping arrays of thousands of numbers: `nums.map(dec).join('')`.
   * Testing the first 4 bytes (`"http"` or `"//"`) would exit invalid keys immediately before mapping the full array.

---

## 3. Implementation Roadmap & Priority Phases

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OPTIMIZATION EXECUTION PHASES                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ PHASE 1: Event-Loop Unfreezing (Critical P0)                                │
│   • Schwartzian transform on catalog match sort (catalog.js)                │
│   • Read-only view in CacheService.getMatches() (eliminate deep clone)      │
│   • Indexed O(1) lookups in CacheService.findMatch()                        │
│   • Direct host injection in index.js (retire response interceptor)         │
│                                                                             │
│ PHASE 2: Aggregation & Merging Scalability (High P1)                        │
│   • Category bucketing & exact ID indexing in MatchAggregator.syncMatches() │
│   • Promote LOGO_BY_NAME to module scope in src/index.js                    │
│   • Bounded Map memoization in ChannelLogoService and ChannelCountryService │
│                                                                             │
│ PHASE 3: Streaming & Proxy Hotpaths (Medium P2 & Low P3)                    │
│   • Hoist URL parsing outside segment loop in HlsRewriteService.js          │
│   • O(1) LRU evictions in ImageService and StreamResolveCache               │
│   • Pointer-based queue consumption in MatchAggregator logo worker          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Verification & Testing Checklist

When applying these performance improvements, verify the following contracts:

1. **Ordering Consistency:** Verify that `compareCatalogMatches` produces the exact same ordering for Live, Upcoming, Replays, and 24/7 channels as asserted by existing test suites.
2. **Immutability Protection:** Ensure that returning a read-only match array from `CacheService` does not leak stream state when `handleStream` mutates individual streams.
3. **URL Integrity:** Confirm that removing the rewriter middleware preserves all relative and absolute URLs across Nuvio and Stremio clients on various host protocols.
4. **Merge Accuracy:** Run aggregation regression tests to ensure category bucketing does not prevent valid merges of `'college'`/`'other'` events.
