import test from "node:test";
import assert from "node:assert/strict";
import { assertAtomicAtEveryWrite, injectFault } from "../src/storage/fault-injection.mjs";

test("fault injector counts writes and leaves non-write methods bound", () => {
  const target = {
    writes: 0,
    put() { this.writes += 1; },
    read() { return this.writes; }
  };
  const wrapped = injectFault(target, Infinity);
  wrapped.put();
  assert.equal(wrapped.read(), 1);
});

test("atomicity harness tests each write using isolated fixtures", async () => {
  const createFixture = async () => {
    const fixture = { state: { balance: 0, audit: [] } };
    const before = structuredClone(fixture.state);
    fixture.tx = {
      put(key, value) { fixture.state[key] = value; },
      add(value) { fixture.state.audit.push(value); },
      abort() { fixture.state = structuredClone(before); }
    };
    return fixture;
  };
  const writes = await assertAtomicAtEveryWrite({
    createFixture,
    run: async (fixture, wrap) => {
      const tx = wrap(fixture.tx);
      tx.put("balance", 500);
      tx.add({ type: "payment", amount: 500 });
    },
    snapshot: fixture => fixture.state,
    label: "payment"
  });
  assert.equal(writes, 2);
});

test("atomicity harness rejects actions that swallow injected write failures", async () => {
  await assert.rejects(assertAtomicAtEveryWrite({
    createFixture: async () => ({ state: { value: 0 }, tx: { put() {} } }),
    run: async (fixture, wrap) => {
      try { wrap(fixture.tx).put(); } catch { /* deliberately swallowed */ }
    },
    snapshot: fixture => fixture.state,
    label: "broken action"
  }), /failure at write 1 was swallowed/);
});
