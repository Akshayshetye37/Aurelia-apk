export default [
  {
    files: ["src/**/*.{js,mjs}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "**/indexeddb-pms-repository.mjs",
            "@capacitor-community/sqlite",
            "better-sqlite3",
            "sqlite3",
            "sql.js",
            "sqlcipher"
          ],
          message: "Import database engines only through src/storage/pms-repository-engine-factory.mjs; domain code must use BaseRepo/PmsRepositoryBridge."
        }]
      }]
    }
  },
  {
    files: ["src/storage/pms-repository-engine-factory.mjs"],
    rules: { "no-restricted-imports": "off" }
  }
];
