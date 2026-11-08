import test from "node:test";
import assert from "node:assert/strict";
import { hydrateCanonicalRoomSnapshot } from "../src/storage/pms-room-read-cutover.mjs";

const snapshot = () => ({
  rooms: [{ n: "101", t: "Deluxe", r: 1500, s: "ready" }, { n: "102", t: "Standard", r: 900, s: "clean" }],
  b: [], g: [], t: [], exp: [], inv: [], led: [], aud: [],
  set: { name: "Aurelia", cur: "₹" }, menu: {}
});
const row = (id, data, version = 1) => ({ key: "room:" + id, type: "room", id, version, data });

test("room read cutover hydrates from canonical entities while preserving snapshot order", async () => {
  const source = snapshot();
  const repository = { async listEntities(type) {
    assert.equal(type, "room");
    return [
      row("102", { ...source.rooms[1], id: "102", legacySource: "rooms", updatedAt: "2026-11-08T00:00:00Z" }),
      row("101", { ...source.rooms[0], id: "101", legacySource: "rooms", updatedAt: "2026-11-08T00:00:00Z" })
    ];
  }};
  const result = await hydrateCanonicalRoomSnapshot({ repository, snapshot: source });
  assert.deepEqual(result.rooms, source.rooms);
  assert.deepEqual(source.rooms, snapshot().rooms, "input snapshot must not be mutated");
});

test("room read cutover ignores retired canonical rows after room retirement", async () => {
  const source = snapshot();
  source.rooms = source.rooms.slice(0, 1);
  const repository = { async listEntities() {
    return [
      row("101", { ...source.rooms[0], updatedAt: "2026-11-08T00:00:00Z" }),
      row("102", { id: "102", retired: true, status: "retired", updatedAt: "2026-11-08T00:00:00Z" })
    ];
  }};
  const result = await hydrateCanonicalRoomSnapshot({ repository, snapshot: source });
  assert.deepEqual(result.rooms, source.rooms);
});

test("room read cutover fails closed on missing or divergent active entities", async () => {
  const source = snapshot();
  await assert.rejects(
    hydrateCanonicalRoomSnapshot({ repository: { async listEntities() { return [row("101", source.rooms[0])]; } }, snapshot: source }),
    /missing for active room 102/
  );
  await assert.rejects(
    hydrateCanonicalRoomSnapshot({ repository: { async listEntities() { return source.rooms.map(x => row(x.n, { ...x, s: "out" })); } }, snapshot: source }),
    /diverges from the committed recovery snapshot/
  );
});

test("room read cutover does not query canonical entities when the projection manifest is unavailable", async () => {
  const source = snapshot();
  const result = await hydrateCanonicalRoomSnapshot({ repository: null, snapshot: source, enabled: false });
  assert.deepEqual(result, source);
});
