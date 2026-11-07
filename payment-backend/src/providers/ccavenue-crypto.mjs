import crypto from 'node:crypto';

const IV = Buffer.from('0000000000000000', 'utf8');

function keyFromWorkingKey(workingKey) {
  if (typeof workingKey !== 'string' || !workingKey.trim()) throw new TypeError('ccavenue_working_key_required');
  return crypto.createHash('md5').update(workingKey, 'utf8').digest();
}

export function encryptCCAvenue(plainText, workingKey) {
  if (typeof plainText !== 'string' || !plainText.length) throw new TypeError('ccavenue_plaintext_required');
  const cipher = crypto.createCipheriv('aes-128-cbc', keyFromWorkingKey(workingKey), IV);
  return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]).toString('hex');
}

export function decryptCCAvenue(cipherText, workingKey) {
  if (typeof cipherText !== 'string' || !/^(?:[a-f0-9]{32})+$/i.test(cipherText)) {
    throw new TypeError('ccavenue_ciphertext_invalid');
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyFromWorkingKey(workingKey), IV);
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'hex')), decipher.final()]).toString('utf8');
}
