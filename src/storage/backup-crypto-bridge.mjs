import { argon2id } from "hash-wasm";

export async function deriveBackupArgon2idKey(password, salt, parameters) {
  if (typeof password !== "string" || password.length < 1 || !(salt instanceof Uint8Array) || salt.length !== 16) {
    throw new TypeError("Invalid Argon2id password or salt.");
  }
  if (!parameters || parameters.kdf !== "ARGON2ID" || parameters.memoryKiB !== 65536 ||
      parameters.iterations !== 3 || parameters.parallelism !== 1) {
    throw new TypeError("Unapproved Argon2id backup parameters.");
  }
  const result = await argon2id({
    password,
    salt,
    parallelism: parameters.parallelism,
    iterations: parameters.iterations,
    memorySize: parameters.memoryKiB,
    hashLength: 32,
    outputType: "binary"
  });
  return new Uint8Array(result);
}

window.AureliaBackupArgon2id = deriveBackupArgon2idKey;
window.AureliaBackupArgon2Ready = Promise.resolve(true);
