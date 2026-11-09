import test from "node:test";

test("intentional red-SHA probe — never merge", () => {
  throw new Error("Intentional release-tag guard probe: this SHA must remain red.");
});
