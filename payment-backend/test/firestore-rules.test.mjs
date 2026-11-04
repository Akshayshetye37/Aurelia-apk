import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");

test("payment control documents and nested audit are never directly accessible to clients", () => {
  assert.match(rules, /match \/paymentControls\/\{tenantId\}/);
  assert.match(rules, /match \/audit\/\{auditId\}/);
  assert.match(rules, /allow read, write: if false;/);
});

test("release approval documents are never directly accessible to clients", () => {
  assert.match(rules, /match \/paymentControlApprovals\/\{tenantId\}\/controls\/\{controlId\}/);
  assert.match(rules, /allow read, write: if false;/);
});
