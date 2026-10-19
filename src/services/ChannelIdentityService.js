'use strict';

const ChannelCountryService = require('./ChannelCountryService');

/**
 * Common ISO language code -> canonical English language name
 */
const ISO_LANG_MAP = {
  en: 'English',
  eng: 'English',
  fr: 'French',
  fra: 'French',
  de: 'German',
  deu: 'German',
  ger: 'German',
  es: 'Spanish',
  spa: 'Spanish',
  it: 'Italian',
  ita: 'Italian',
  nl: 'Dutch',
  nld: 'Dutch',
  pl: 'Polish',
  pol: 'Polish',
  pt: 'Portuguese',
  por: 'Portuguese',
  tr: 'Turkish',
  tur: 'Turkish',
  ar: 'Arabic',
  ara: 'Arabic',
  hi: 'Hindi',
  hin: 'Hindi',
  ru: 'Russian',
  rus: 'Russian',
  sq: 'Albanian',
  alb: 'Albanian',
  el: 'Greek',
  gre: 'Greek',
  ro: 'Romanian',
  ron: 'Romanian',
  hr: 'Croatian',
  hrv: 'Croatian',
  sr: 'Serbian',
  srp: 'Serbian',
  cs: 'Czech',
  cze: 'Czech',
  sk: 'Slovak',
  slk: 'Slovak',
  hu: 'Hungarian',
  hun: 'Hungarian',
  sv: 'Swedish',
  swe: 'Swedish',
  da: 'Danish',
  dan: 'Danish',
  no: 'Norwegian',
  nor: 'Norwegian',
  fi: 'Finnish',
  fin: 'Finnish',
  ms: 'Malay',
  msa: 'Malay',
  id: 'Indonesian',
  ind: 'Indonesian',
  he: 'Hebrew',
  heb: 'Hebrew'
};

/**
 * Common country names -> canonical primary language fallback
 */
const COUNTRY_LANG_MAP = {
  'United Kingdom': 'English',
  'United States': 'English',
  'USA': 'English',
  'UK': 'English',
  'Canada': 'English',
  'Australia': 'English',
  'New Zealand': 'English',
  'Ireland': 'English',
  'France': 'French',
  'Germany': 'German',
  'Austria': 'German',
  'Switzerland': 'German',
  'Spain': 'Spanish',
  'Mexico': 'Spanish',
  'Argentina': 'Spanish',
  'Italy': 'Italian',
  'Netherlands': 'Dutch',
  'Poland': 'Polish',
  'Portugal': 'Portuguese',
  'Brazil': 'Portuguese',
  'Turkey': 'Turkish',
  'Albania': 'Albanian',
  'Israel': 'Hebrew',
  'Malaysia': 'English', // Sports broadcasting (Astro) is primarily English commentary
  'India': 'Hindi',
  'South Africa': 'English',
  'Arabic': 'Arabic'
};

/**
 * Common network acronyms that should remain UPPERCASE in canonical display titles
 */
const UPPERCASE_TOKENS = new Set([
  'TV', 'HD', 'UHD', 'FHD', 'SD', 'BBC', 'ITV', 'CNN', 'ESPN', 'TNT', 'FOX',
  'NBC', 'CBS', 'ABC', 'TSN', 'WWE', 'UFC', 'MMA', 'NFL', 'NBA', 'MLB', 'NHL',
  'PGA', 'F1', 'USA', 'UK', 'DAZN', 'TUDN', 'MSNBC', 'CNBC', 'MTV', 'VH1', 'SEC',
  'ACC', 'BTN', 'NESN', 'MASN', 'MSG', 'RDS', 'ORF', 'SRF', 'RAI', 'TF1', 'M6',
  'RTE', 'NPO', 'TVP', 'PPV'
]);

class ChannelIdentityService {
  /**
   * Parses raw channel name and returns normalized identity and extracted attributes
   * @param {string} rawName 
   * @param {Object} [meta] { group, league, language, country, is4k, isBackup, isTimeshift }
   * @returns {{
   *   canonicalTitle: string,
   *   identityKey: string,
   *   channelNumber: string|null,
   *   country: string|null,
   *   countryCode: string|null,
   *   countryFlag: string|null,
   *   language: string,
   *   resolution: string,
   *   isBackup: boolean,
   *   isTimeshift: boolean
   * }}
   */
  static parseChannel(rawName, meta = {}) {
    const raw = String(rawName || '').trim();
    if (!raw) {
      return {
        canonicalTitle: 'Unknown Channel',
        identityKey: 'unknownchannel',
        channelNumber: null,
        country: null,
        countryCode: null,
        countryFlag: null,
        language: 'English',
        resolution: 'HD',
        isBackup: false,
        isTimeshift: false
      };
    }

    // 1. Detect Backup Feed
    const isBackup = Boolean(
      meta.isBackup === true ||
      /\b(?:backup(?:\s*\d+)?|bkp|alternate|alt)\b/i.test(raw) ||
      /\(\s*backup(?:\s*\d+)?\s*\)/i.test(raw) ||
      /\[\s*backup(?:\s*\d+)?\s*\]/i.test(raw)
    );

    // 2. Detect Timeshift Feed (+1, +2, etc.)
    const isTimeshift = Boolean(
      meta.isTimeshift === true ||
      /(?:(?:\+|\bplus\s*)\d{1,2}\s*(?:hr|hour|h)?\b|\btime\s*shift\b|\bdelay\b)/i.test(raw)
    );

    // 3. Detect Resolution / Quality
    let resolution = 'HD';
    if (meta.is4k || /\b(?:4k|uhd)\b/i.test(raw)) {
      resolution = '4K';
    } else if (/\b(?:1080p|fhd|full\s*hd)\b/i.test(raw)) {
      resolution = '1080p';
    } else if (/\b(?:720p)\b/i.test(raw)) {
      resolution = '720p';
    } else if (/\b(?:sd|480p|360p)\b/i.test(raw)) {
      resolution = 'SD';
    } else if (meta.resolution) {
      resolution = meta.resolution;
    }

    // 4. Detect Country and Language
    const detectedCountryInfo = ChannelCountryService.detectChannelCountry(raw);
    let country = meta.country || (meta.group && !/^(?:live tv|general|channels|networks|other|multi-region)$/i.test(meta.group.trim()) ? meta.group.trim() : null) || (detectedCountryInfo ? detectedCountryInfo.country : null);
    let countryCode = (detectedCountryInfo && detectedCountryInfo.name) || (country && COUNTRY_LANG_MAP[country] ? country.slice(0, 2).toUpperCase() : null);
    let countryFlag = (detectedCountryInfo && detectedCountryInfo.flag) || null;

    let language = 'English';
    if (meta.language && typeof meta.language === 'string') {
      const code = meta.language.toLowerCase().trim();
      language = ISO_LANG_MAP[code] || meta.language;
    } else {
      // Check explicit language tokens in raw name
      const rawLower = raw.toLowerCase();
      if (/\barabic\b/i.test(rawLower)) language = 'Arabic';
      else if (/\bfrench\b/i.test(rawLower)) language = 'French';
      else if (/\bgerman\b/i.test(rawLower)) language = 'German';
      else if (/\bspanish\b/i.test(rawLower)) language = 'Spanish';
      else if (/\bitalian\b/i.test(rawLower)) language = 'Italian';
      else if (/\bportuguese\b/i.test(rawLower)) language = 'Portuguese';
      else if (/\bpolish\b/i.test(rawLower)) language = 'Polish';
      else if (/\bturkish\b/i.test(rawLower)) language = 'Turkish';
      else if (/\bhindi\b/i.test(rawLower)) language = 'Hindi';
      else if (/\brussian\b/i.test(rawLower)) language = 'Russian';
      else if (/\bdutch\b/i.test(rawLower)) language = 'Dutch';
      else if (detectedCountryInfo && detectedCountryInfo.language) {
        language = detectedCountryInfo.language;
      } else if (country && COUNTRY_LANG_MAP[country]) {
        language = COUNTRY_LANG_MAP[country];
      }
    }

    // 5. Build Canonical Title
    let clean = raw;

    // Strip provider prefix tags like [RAW], [VIP], UK:, US:, etc.
    clean = clean.replace(/^\[(?:raw|vip|st|vavoo|dlv|sktech)\]\s*/i, '');
    clean = clean.replace(/^(?:UK|US|USA|DE|FR|ES|IT|PL|TR|PT|NL|MY|IN|AU|CA)\s*:\s*/i, '');

    // Strip bracketed metadata: (Backup), [Backup 1], (4K), (HD), (+1), (UK), (France), (EN), etc.
    clean = clean.replace(/\[\s*(?:backup(?:\s*\d+)?|bkp|alternate|alt)\s*\]/gi, ' ');
    clean = clean.replace(/\(\s*(?:backup(?:\s*\d+)?|bkp|alternate|alt)\s*\)/gi, ' ');
    clean = clean.replace(/\[\s*(?:4k|uhd|fhd|1080p|720p|hd|sd|hevc|h\.?26[45]|50fps|60fps)\s*\]/gi, ' ');
    clean = clean.replace(/\(\s*(?:4k|uhd|fhd|1080p|720p|hd|sd|hevc|h\.?26[45]|50fps|60fps)\s*\)/gi, ' ');
    clean = clean.replace(/\(\s*(?:\+\s*\d{1,2}|\btime\s*shift\b|\bdelay\b)\s*\)/gi, ' ');
    clean = clean.replace(/\(\s*(?:uk|usa?|united\s*kingdom|united\s*states|france|germany|deutschland|italy|italia|spain|espana|portugal|poland|polska|netherlands|turkey|turkiye|albania|arabic|arab|malaysia|canada|australia|new\s*zealand|ireland|austria|switzerland|india|south\s*africa|latam|balkan)\s*\)/gi, ' ');
    clean = clean.replace(/\(\s*(?:en|eng|english|fr|fra|french|de|deu|ger|german|es|spa|spanish|it|ita|italian|pt|por|portuguese|pl|pol|polish|tr|tur|turkish|ar|ara|arabic|hi|hin|hindi|ru|rus|russian)\s*\)/gi, ' ');

    // Strip quality labels outside brackets: 4K, UHD, FHD, 1080p, 720p, HD, SD, 50fps, etc.
    clean = clean.replace(/\b(?:4k|uhd|fhd|full\s*hd|1080p|720p|hd|sd|hevc|h\.?26[45]|50fps|60fps)\b/gi, ' ');

    // Strip timeshift labels outside brackets (+1, +2, +1 hr, Timeshift)
    clean = clean.replace(/(?:(?:\+|\bplus\s*)\d{1,2}\s*(?:hr|hour|h)?\b|\btime\s*shift\b|\bdelay\b)/gi, ' ');

    // Strip backup labels outside brackets
    clean = clean.replace(/\b(?:backup(?:\s*\d+)?|bkp|alternate|alt)\b/gi, ' ');

    // Strip trailing language qualifiers if substantive brand words remain (e.g. "Cartoon Network Arabic" -> "Cartoon Network")
    const langPattern = /\b(?:arabic|english|french|german|spanish|italian|portuguese|polish|turkish|hindi|russian|dutch)\b/gi;
    const testStrippedLang = clean.replace(langPattern, ' ').trim();
    if (testStrippedLang.replace(/[^a-zA-Z]/g, '').length >= 4) {
      clean = testStrippedLang;
    }

    // Strip trailing or separated country qualifiers if substantive brand words remain
    // e.g., "Astro Cricket Malaysia" -> "Astro Cricket", "Cartoonito UK" -> "Cartoonito", "Cartoonito France" -> "Cartoonito"
    const countryPattern = /\b(?:uk|usa?|france|germany|italy|spain|portugal|poland|netherlands|turkey|albania|malaysia|canada|australia|austria|switzerland|india)\b/gi;
    const testStrippedCountry = clean.replace(countryPattern, ' ').trim();
    // Safety guard: only strip if at least 4 letters remain (so "France 2" or "Spain TV" won't lose "France" or "Spain")
    if (testStrippedCountry.replace(/[^a-zA-Z]/g, '').length >= 4) {
      clean = testStrippedCountry;
    }

    // Collapse punctuation and whitespace
    clean = clean
      .replace(/[|:–—\-_/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 6. Format Canonical Display Title (Title Casing while preserving acronyms)
    let canonicalTitle = clean;
    if (/^[A-Z0-9\s+.]+$/.test(clean) || /^[a-z0-9\s+.]+$/.test(clean)) {
      canonicalTitle = clean.split(' ').map((word) => {
        if (!word) return '';
        const upper = word.toUpperCase();
        if (UPPERCASE_TOKENS.has(upper)) return upper;
        if (/^bein$/i.test(word)) return 'beIN';
        if (/^canal\+?$/i.test(word)) return 'Canal+';
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }).join(' ').trim();
    }

    // 7. Extract Channel Number (Strict Isolation)
    // Preserves numbers like in "Astro Cricket 1", "Astro Cricket 2", "beIN Sports 1", "DAZN 2"
    let channelNumber = null;
    const numMatch = canonicalTitle.match(/\b(\d+)\b(?:\s*$)/);
    if (numMatch) {
      channelNumber = numMatch[1];
    }

    // 8. Compute Deterministic Identity Key
    // Lowercase alphanumeric only, e.g. "astrocricket", "astrocricket1", "cartoonito", "channel4"
    const identityKey = canonicalTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

    return {
      canonicalTitle: canonicalTitle || raw,
      identityKey: identityKey || 'unknown',
      channelNumber,
      country,
      countryCode,
      countryFlag,
      language,
      resolution,
      isBackup,
      isTimeshift
    };
  }
}

module.exports = ChannelIdentityService;
