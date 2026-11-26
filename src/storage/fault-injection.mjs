// Fault-injection harness for transaction-level atomicity tests.
// Each injected failure gets a fresh fixture so the probe run never contaminates test state.
export const WRITE_METHODS = new Set([
  "put", "add", "delete", "clear", "setEntity", "appendJournal",
  "appendOutbox", "appendAudit", "moveStock"
]);

export function injectFault(transaction, failOnWrite, counter = { writes: 0 }) {
  if (!transaction || typeof transaction !== "object") throw new TypeError("A transaction wrapper is required");
  if ((failOnWrite !== Infinity && !Number.isSafeInteger(failOnWrite)) || failOnWrite < 1) throw new TypeError("failOnWrite must be a positive integer or Infinity");
  return new Proxy(transaction, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || !WRITE_METHODS.has(String(key))) {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args) => {
        counter.writes += 1;
        if (counter.writes === failOnWrite) {
          try { target.abort?.(); } catch {}
          throw new Error("INJECTED_FAULT_" + failOnWrite);
        }
        return value.apply(target, args);
      };
    }
  });
}

export async function assertAtomicAtEveryWrite({ createFixture, run, snapshot, label = "action" } = {}) {
  if (typeof createFixture !== "function" || typeof run !== "function" || typeof snapshot !== "function") {
    throw new TypeError("createFixture, run and snapshot functions are required");
  }
  const probe = await createFixture();
  const counter = { writes: 0 };
  try {
    await run(probe, tx => injectFault(tx, Infinity, counter));
  } finally {
    await probe?.cleanup?.();
  }
  if (counter.writes < 1) throw new Error(`${label}: no writes observed; fault injection is not wired to the action`);

  for (let write = 1; write <= counter.writes; write += 1) {
    const fixture = await createFixture();
    try {
      const before = JSON.stringify(await snapshot(fixture));
      let injected = false;
      try {
        await run(fixture, tx => injectFault(tx, write));
      } catch (error) {
        injected = String(error?.message || error).includes("INJECTED_FAULT_" + write);
        if (!injected) throw error;
      }
      if (!injected) throw new Error(`${label}: failure at write ${write} was swallowed or not reached`);
      const after = JSON.stringify(await snapshot(fixture));
      if (before !== after) throw new Error(`${label}: write ${write} left a partial change`);
    } finally {
      await fixture?.cleanup?.();
    }
  }
  return counter.writes;
}
