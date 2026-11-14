import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(here, "..");
const sourcePath = path.join(functionsDir, "src/passkeys.ts");
const original = fs.readFileSync(sourcePath, "utf8");
const testCommand = "cd functions && node --test --test-name-pattern=\"WebAuthn owner action challenge\" test/recovery-emulator-runtime.test.mjs";

function execute(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(functionsDir, ".."),
    encoding: "utf8",
    env: { ...process.env, WEBAUTHN_ASSETLINKS_VERIFIED: "true" },
    maxBuffer: 30 * 1024 * 1024
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(label + " failed unexpectedly:\n" + output.slice(-12000));
  return output;
}

function applyMutation(label, replacements, expectedFailure) {
  let mutated = original;
  for (const [before, after] of replacements) {
    if (!mutated.includes(before)) throw new Error(label + ": mutation anchor not found: " + before);
    mutated = mutated.replace(before, after);
  }
  fs.writeFileSync(sourcePath, mutated);
  execute("npm", ["--prefix", "functions", "run", "build"], label + " TypeScript build");
  const result = spawnSync("firebase", ["emulators:exec", "--only", "auth,firestore", "--project",
    "demo-aurelia-recovery", testCommand], {
    cwd: path.resolve(functionsDir, ".."),
    encoding: "utf8",
    env: { ...process.env, WEBAUTHN_ASSETLINKS_VERIFIED: "true" },
    maxBuffer: 30 * 1024 * 1024
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(label + ": security mutation survived; the test unexpectedly passed");
  if (!/not ok \d+ - WebAuthn owner action challenge/.test(output) ||
      !output.includes(expectedFailure)) {
    throw new Error(label + ": command failed for an unrelated reason; expected test failure marker " +
      JSON.stringify(expectedFailure) + ":\n" + output.slice(-12000));
  }
  console.log(label + ": mutation was detected by the targeted emulator test.");
  fs.writeFileSync(sourcePath, original);
  execute("npm", ["--prefix", "functions", "run", "build"], label + " restore build");
}

try {
  applyMutation("challenge-consumption-before-verification", [
    ["  const verification = await verifyAuthenticationResponse({",
     "  await ref.update({ state: \"CONSUMED\" });\n  const verification = await verifyAuthenticationResponse({"]
  ], "wrong-challenge assertions must not consume the server challenge");

  applyMutation("counter-regression-guard-bypass", [
    ["      counter: Number(stored.counter),", "      counter: 0,"],
    ["  if (verification.authenticationInfo.newCounter <= Number(stored.counter)) throw GENERIC;",
     "  if (false) throw GENERIC;"]
  ], "a non-increasing signature counter is rejected");

  applyMutation("cross-action-binding-bypass", [
    ["      (action !== undefined && data.action !== action)) throw GENERIC;",
     "      (false)) throw GENERIC;"]
  ], "an ack challenge cannot be submitted as a cancel action");
} finally {
  fs.writeFileSync(sourcePath, original);
  execute("npm", ["--prefix", "functions", "run", "build"], "restore original passkey implementation");
}
console.log("All three passkey guard mutations were detected; original source restored and rebuilt.");
