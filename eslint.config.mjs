export default [
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    ignores: ["src/storage/**", "node_modules/**", "dist/**", "coverage/**"],
    rules: {
      "no-restricted-globals": ["error", "indexedDB", "IDBDatabase", "localStorage"],
      "no-restricted-imports": ["error", { paths: [{ name: "dexie", message: "Import storage repositories from src/storage instead." }], patterns: ["dexie/*"] }]
    }
  },
  {
    files: ["src/storage/**/*.{js,mjs,ts,tsx}"],
    rules: { "no-restricted-globals": "off", "no-restricted-imports": "off" }
  }
];
