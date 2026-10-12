'use strict';

const { isDamitvTarget } = require('../src/impitClient');

describe('DamiTV Selective Proxy Routing', () => {
  test('isDamitvTarget correctly identifies DamiTV domains only', () => {
    // True cases: DamiTV endpoints and CDN streams
    expect(isDamitvTarget('https://damitv.st/papi/api/streams')).toBe(true);
    expect(isDamitvTarget('https://damitv.st/papi/matches/all')).toBe(true);
    expect(isDamitvTarget('https://damitv.st/papi/extract-url/123')).toBe(true);
    expect(isDamitvTarget('https://messi.damitv.st/live-hls/channel/test/playlist.m3u8')).toBe(true);

    // False cases: other providers must never be matched
    expect(isDamitvTarget('https://dlive.sx/stream/1.html')).toBe(false);
    expect(isDamitvTarget('https://dlstreams.st/schedule')).toBe(false);
    expect(isDamitvTarget('https://streamed.pk/api/matches/live')).toBe(false);
    expect(isDamitvTarget('https://cdnlivetv.tv/')).toBe(false);
    expect(isDamitvTarget('https://watchfooty.st/')).toBe(false);
    expect(isDamitvTarget('')).toBe(false);
    expect(isDamitvTarget(null)).toBe(false);
    expect(isDamitvTarget(undefined)).toBe(false);
  });
});
