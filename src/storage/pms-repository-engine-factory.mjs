import { IndexedDbPmsRepository, parseLegacyPmsSnapshot } from "./indexeddb-pms-repository.mjs";

/**
 * The sole application composition boundary allowed to instantiate the browser
 * database engine. Domain code receives a repository bridge, never the driver.
 */
export function createIndexedDbPmsRepository(options = {}) {
  return new IndexedDbPmsRepository(options);
}

export { parseLegacyPmsSnapshot };
