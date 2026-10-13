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
}

module.exports = new SkTechCrypto();
