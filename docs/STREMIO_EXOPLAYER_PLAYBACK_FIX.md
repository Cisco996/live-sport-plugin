# Stremio / ExoPlayer playback failure — root cause and fix

Status: fixed in working tree (not yet committed).
Scope: live streams from Streamed.pk, PPV.st and DamiTV (ST-DAMITV) failing in Stremio/ExoPlayer while
DaddyLive played fine and everything played in MPV and Nuvio.

---

## 1. What the players were actually given

Both the working and the failing providers are handed the **same stream-object shape**: a proxied
`/api/manifest?url=...` URL with `behaviorHints.notWebReady: false` and no `proxyHeaders`.
Measured on a live match (`spk_tijuana-vs-santos-laguna-2487577`), all nine resolved streams looked
like this:

```
⚡ Direct Stream  http://<addon>/api/manifest?url=https%3A%2F%2Flb24.strmd.st%2F...%2Fplaylist.m3u8
                 behaviorHints: { notWebReady: false, bingeGroup: "nuvio_sport_..." }
```

So the addon metadata is **not** the difference — and that is why commit `1e2cde4`
(`notWebReady` normalisation + `#EXT-X-VERSION:4`) could not fix playback: those flags were already
correct for these providers, and the manifest was already being served.

## 2. Where the playlists diverge

Two playlists fetched through the addon, same moment, same route:

| | DaddyLive (works in Stremio) | Streamed.pk / PPV / DamiTV (failed) |
|---|---|---|
| `#EXT-X-VERSION` | `3` | `4` (injected by `1e2cde4`) |
| Segment addressing | `#EXTINF` + absolute CDN `..._458.ts` | `#EXT-X-BYTERANGE:<len>@42` + `<addon>/api/hls/resource/<token>/media.ts?psig=...` |
| Requests per segment | 1, straight to the CDN | 1 with a `Range` header, answered by **our 307** back to the CDN |
| Redirect | none | http addon → **https** CDN |

The failing providers use the "cloaked segment" trick: the CDN stores MPEG-TS behind a fake 42-byte
WebP/RIFF header, so the playlist declares `#EXT-X-BYTERANGE:<len>@42` and points at our signed 307
endpoint, which bounces the player's `Range` request to TikTok CDN.

The manifest itself is valid HLS and ExoPlayer supports `#EXT-X-BYTERANGE` natively, so the manifest
was never the blocker. **The blocker is the extra hop.**

## 3. Root cause

ExoPlayer's default data source refuses the redirect:

> "An HttpDataSource that uses Android's HttpURLConnection. **By default this implementation will not
> follow cross-protocol redirects.**"
> — [`androidx.media3.datasource.DefaultHttpDataSource`](https://developer.android.com/reference/androidx/media3/datasource/DefaultHttpDataSource)

The addon is normally served over plain HTTP (`config.js` falls back to `http://<lan-ip>:<port>` when
`ADDON_URL` is unset, and `.env` in this repo does not set it), while every cloaked segment lives on
`https://…tiktokcdn.com`. Every segment therefore came back to ExoPlayer as a bare `307` it will not
follow, and playback died on the first segment.

MPV and Nuvio are unaffected because both follow cross-protocol redirects transparently. DaddyLive
was unaffected because its segments are absolute CDN URLs with no redirect at all.

Two things follow from this, and both matter for the fix:

1. **The `Range` header and the redirect target were never ours to serve.** In the 307 flow the
   *player* re-requests the CDN with its own headers. So the redirect added no capability — only the
   one hop ExoPlayer refuses.
2. **Direct CDN access needs none of our headers.** Verified against the live segment:

   | Probe | Result |
   |---|---|
   | `Range: bytes=42-…`, no `Referer`, generic UA | `206`, exact `Content-Range`, payload starts `0x47` (TS sync) |
   | same with ExoPlayer's `stagefright/1.2` UA | `206`, identical bytes |
   | same with `Origin: https://web.stremio.com` | `206` + `Access-Control-Allow-Origin: *` |
   | `OPTIONS` preflight | `200`, `Access-Control-Allow-Origin: *` |
   | no `Range` at all (player ignores BYTERANGE) | `200`, 2 866 666 bytes, starts `RIFF` — i.e. WebP, as expected |

Ruled out along the way: DRM/encryption (none present), codec mismatch, CORS, `Referer`/`User-Agent`
requirements, malformed manifests, and the `notWebReady` flags.

## 4. The fix

`src/services/HlsRewriteService.js` — cloaked segments are now addressed **directly**:

```
#EXTINF:6.006,
#EXT-X-BYTERANGE:4698496@42
https://p16-common-sign.tiktokcdn.com/tos-alisg-...image?dr=14575&x-expires=...&x-signature=...
```

The player range-requests the CDN itself; TikTok's edge slices the 42 fake WebP bytes off, so server
bandwidth stays at 0 KB/s. No redirect, no header injection, no proxy.

- `segmentAddressMode()` resolves the addressing mode: `direct` (default), `redirect` (the old 307
  hop), `proxy` (CF worker / `/api/hlschunk`).
- `USE_TIKTOK_BYTERANGE_307=off` keeps its historical meaning (`proxy`), so existing deployments
  behave as before.
- `TIKTOK_SEGMENT_MODE` documents/overrides the mode (see `.env.example`).
- `route /api/hls/resource` and `ByteRangeSigner` are kept intact for `redirect` mode.
- The `#EXT-X-VERSION:4` injection from `1e2cde4` is kept — it is genuinely required for
  `#EXT-X-BYTERANGE` (RFC 8216 §7), it simply was not the cause.

Files changed:

| File | Change |
|---|---|
| `src/services/HlsRewriteService.js` | `segmentAddressMode()`; direct URI emitted by default in `rewriteHlsUri` and `rewriteHlsPlaylist`; header docs |
| `tests/hlsRewritePlaylist.test.js` | asserts the CDN URI is emitted, plus a `redirect` mode test that still verifies the signed token |
| `tests/hlsRewriteService.test.js` | default-mode assertions updated; version/byte-range contract covered |
| `.env.example` | documents `TIKTOK_SEGMENT_MODE` |

## 5. Verification

Live, against the running addon, on the real match above — each segment fetched with the exact
`Range` the playlist declares:

| Provider | Segments | Result | Declared == received | TS sync |
|---|---|---|---|---|
| ⚽ PPV.st | 4 | `206` | yes (3393024, 4259328, 4090880, 4349568) | yes |
| ⚽ DamiTV | 4 | `206` | yes | yes |
| ⚽ Streamed.pk | 4 | `206` | yes | yes |
| 📺 DaddyLive (control) | — | unchanged: `#EXT-X-VERSION:3`, no byte ranges, direct `.ts` | n/a | n/a |

All three previously-failing providers now emit `#EXT-X-VERSION:4` + `#EXT-X-BYTERANGE` + the CDN URL,
with no `/api/hls/resource` hop anywhere in the playlist.

Unit tests: 38/38 in `hlsRewriteService`, `hlsRewritePlaylist`, `hlsResource`, `manifestWebReady`.
Full suite: 1165 passed, 3 suites failing (`ak47LiveProvider`, `beforeAndAfterBenchmark`,
`safeFetchTotalDeadline`) — all three fail identically on a clean tree (`git stash` baseline) and do
not touch the rewrite path.

## 6. Remaining limitations

1. **Not tested on a real Stremio client.** No Android device/emulator here. The HTTP layer is proven
   end-to-end (206, exact length, TS sync, CORS), and the mechanism removed is documented ExoPlayer
   behaviour, but a device check is still the final word.
2. **Depends on the player honouring `#EXT-X-BYTERANGE`.** ExoPlayer, MPV and hls.js all do. A client
   that ignores it receives the raw 42-byte-prefixed WebP object — that has always been true of this
   design, redirect or not.
3. **Byte length is estimated until probed.** `SegmentLengthService` pre-probes the live-edge segments
   (1.5 s budget) and returns an aligned bitrate estimate for the rest; an estimate that is short
   truncates a segment tail. Pre-existing, and a wrong length is now read by ExoPlayer directly rather
   than through one of our endpoints.
4. **Serve the addon over HTTPS.** If `ADDON_URL` is unset the addon advertises `http://<lan-ip>`, which
   Stremio Web (https) will block as mixed content even though native players accept it.

## 7. Rollback

`TIKTOK_SEGMENT_MODE=redirect` restores the previous 307 behaviour without a code change.
