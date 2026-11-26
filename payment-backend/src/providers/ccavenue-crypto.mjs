import crypto from 'node:crypto';

const IV = Buffer.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
]);
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 128 * 1024;

/**
 * CCAvenue legacy AES envelope codec.
 *
 * Compatibility construction used by CCAvenue integration examples and
 * corroborating implementations: MD5(merchant encryption key) as the
 * 16-byte AES key, fixed 00..0f IV, AES-128-CBC and PKCS#7 padding.
 *
 * IMPORTANT: CCAvenue's public API guide specifies AES and that the API
 * Encryption Key is mapped to the Access Code, but does not publish the
 * primitive/key/IV details or a test vector. This implementation must be
 * matched against the merchant's current official AesCryptUtil kit and a
 * CCAvenue-issued sandbox vector before production qualification.
 */
export class CCAvenueCrypto {
  #key;
  #iv;

  constructor(encryptionKey) {
    if (typeof encryptionKey !== 'string' || encryptionKey.length < 16 ||
        encryptionKey.length > 512 || /[\x00-\x1f\x7f]/.test(encryptionKey)) {
      throw new TypeError('ccavenue_encryption_key_invalid');
    }
    this.#key = crypto.createHash('md5').update(encryptionKey, 'utf8').digest();
    this.#iv = Buffer.from(IV);
  }

  encrypt(plainText) {
    if (typeof plainText !== 'string' || Buffer.byteLength(plainText, 'utf8') < 1 ||
        Buffer.byteLength(plainText, 'utf8') > MAX_PLAINTEXT_BYTES) {
      throw new TypeError('ccavenue_plaintext_invalid');
    }
    const cipher = crypto.createCipheriv('aes-128-cbc', this.#key, this.#iv);
    return cipher.update(plainText, 'utf8', 'hex') + cipher.final('hex');
  }

  decrypt(cipherTextHex) {
    if (typeof cipherTextHex !== 'string' || cipherTextHex.length < 32 ||
        cipherTextHex.length > MAX_CIPHERTEXT_BYTES * 2 ||
        cipherTextHex.length % 32 !== 0 || !/^[a-f0-9]+$/i.test(cipherTextHex)) {
      throw new TypeError('ccavenue_ciphertext_invalid');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', this.#key, this.#iv);
      const plaintext = decipher.update(cipherTextHex, 'hex', 'utf8') + decipher.final('utf8');
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
        throw new Error('oversized');
      }
      return plaintext;
    } catch {
      throw new Error('ccavenue_decryption_failed');
    }
  }
}
