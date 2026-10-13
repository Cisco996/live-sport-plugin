'use strict';

const crypto = require('crypto');

/**
 * SkTechCrypto
 *
 * Implements the complete two-tier cryptographic algorithm used by SK Tech TV:
 * - Tier 1: Bijective English alphabet substitution map + Base64 decode.
 * - Tier 2: String inversion (reverse) + Base64 decode + AES-128-CBC decryption.
 * - Secondary AES: Additional AES-128-CBC cipher for tokenApi payloads.
 *
 * Runs on pure Node.js native crypto with zero external dependencies.
 */
class SkTechCrypto {
  constructor() {
    this.primaryKey = Buffer.from('l2l5kB7xC5qP1rK1', 'utf8');
    this.primaryIv = Buffer.from('p1K5nP7uB8hH1l19', 'utf8');

    this.secondaryKey = Buffer.from('l2K5wB8xC1wP7rK1', 'utf8');
    this.secondaryIv = Buffer.from('n0K4nP8uB8hH1l18', 'utf8');

    this._initSubstitutionMap();
  }

  _initSubstitutionMap() {
    const srcChars = [];
    for (let c = 'a'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
      srcChars.push(String.fromCharCode(c));
      srcChars.push(String.fromCharCode(c).toUpperCase());
    }

    const dstPairs = [
      ['f', 'F'], ['g', 'G'], ['j', 'J'], ['k', 'K'],
      ['a', 'A'], ['p', 'P'], ['b', 'B'], ['m', 'M'],
      ['o', 'O'], ['z', 'Z'], ['e', 'E'], ['n', 'N'],
      ['c', 'C'], ['d', 'D'], ['r', 'R'], ['q', 'Q'],
      ['t', 'T'], ['v', 'V'], ['u', 'U'], ['x', 'X'],
      ['h', 'H'], ['i', 'I'], ['w', 'W'], ['y', 'Y'],
      ['l', 'L'], ['s', 'S']
    ];

    const dstChars = [];
    for (const [lower, upper] of dstPairs) {
      dstChars.push(lower, upper);
    }

    this.dMap = new Map();
    for (let i = 0; i < srcChars.length; i++) {
      this.dMap.set(dstChars[i], srcChars[i]);
    }
  }

  /**
   * Decrypt primary SK Tech payload (events.txt, categories.txt, pro/*.txt, app.txt)
   * @param {string} rawText - Ciphertext from Cloudflare Pages backend
   * @returns {string} Plaintext UTF-8 string
   */
  decryptPrimary(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    const trimmed = rawText.trim();
    if (!trimmed) return '';

    // Tier 1: Bijective alphabet substitution
    let subbed = '';
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      subbed += this.dMap.get(ch) || ch;
    }

    const rem = subbed.length % 4;
    if (rem > 0) {
      subbed += '='.repeat(4 - rem);
    }

    const tier1Decoded = Buffer.from(subbed, 'base64').toString('utf8');

    // Tier 2: String inversion + Base64 + AES-128-CBC
    const reversed = tier1Decoded.split('').reverse().join('');
    const aesData = Buffer.from(reversed, 'base64');
    if (!aesData || aesData.length === 0) return '';

    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.primaryKey, this.primaryIv);
      let decrypted = decipher.update(aesData, null, 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (_) {
      try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', this.primaryKey, this.primaryIv);
        decipher.setAutoPadding(false);
        const ptBuf = Buffer.concat([decipher.update(aesData), decipher.final()]);
        const pad = ptBuf[ptBuf.length - 1];
        const trimmed = (pad && pad <= 16) ? ptBuf.subarray(0, ptBuf.length - pad) : ptBuf;
        return trimmed.toString('utf8');
      } catch (err) {
        throw new Error(`Failed to decrypt SK Tech payload: ${err.message}`);
      }
    }
  }

  /**
   * Decrypt secondary payload (used for encrypted tokenApi payloads)
   * @param {string|Buffer} cipherData - Base64 or binary ciphertext
   * @returns {string} Plaintext UTF-8 string
   */
  decryptSecondary(cipherData) {
    if (!cipherData) return '';
    const buf = Buffer.isBuffer(cipherData) ? cipherData : Buffer.from(cipherData, 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.secondaryKey, this.secondaryIv);
    let decrypted = decipher.update(buf, null, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Decrypt dynamic encrypted M3U playlists (e.g. BIG BOSS worker payloads)
   * Reversed from Dalvik method `Lua/t1;->h`:
   * - Head: substring(0, 10)
   * - IV: substring(10, 34) (Base64 decode -> 16 bytes IV)
   * - Body: substring(34, len - 54)
   * - Key: substring(len - 54, len - 10) (Base64 decode -> 32 bytes AES-256 key)
   * - Tail: substring(len - 10)
   * - Ciphertext: Head + Body + Tail (Base64 decode -> AES-256-CBC cipher bytes)
   *
   * @param {string} rawText - Response text from worker endpoint
   * @returns {string} Plaintext M3U or original string if not encrypted
   */
  decryptM3u(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    const trimmed = rawText.trim();
    if (trimmed.length < 60) return trimmed;

    // Check if payload matches encrypted structure (IV ends with == at char 32-34)
    if (!trimmed.substring(10, 34).includes('==')) {
      return trimmed;
    }

    const len = trimmed.length;
    const v2 = trimmed.substring(0, 10);
    const v4_iv = trimmed.substring(10, 34);
    const v3 = trimmed.substring(34, len - 54);
    const v5_key = trimmed.substring(len - 54, len - 10);
    const v7_tail = trimmed.substring(len - 10);

    const cipherTextB64 = v2 + v3 + v7_tail;

    try {
      const iv = Buffer.from(v4_iv, 'base64');
      const key = Buffer.from(v5_key, 'base64');
      const cipherBytes = Buffer.from(cipherTextB64, 'base64');

      if (iv.length !== 16 || (key.length !== 16 && key.length !== 32) || cipherBytes.length % 16 !== 0) {
        return trimmed;
      }

      const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
      const decipher = crypto.createDecipheriv(algo, key, iv);
      return Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString('utf8');
    } catch (_) {
      return trimmed;
    }
  }
}

module.exports = new SkTechCrypto();
