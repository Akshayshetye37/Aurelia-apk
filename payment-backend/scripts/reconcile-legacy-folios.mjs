import { readFile } from 'node:fs/promises';

function assertSnapshot(snapshot, label) {
  if (!snapshot || typeof snapshot !== 'object' ||
      !Array.isArray(snapshot.folios) || !Array.isArray(snapshot.entries)) {
    throw new TypeError(label + '_snapshot_invalid');
  }
  const folioKeys = new Set();
  for (const folio of snapshot.folios) {
    if (!folio || typeof folio.tenantId !== 'string' || !folio.tenantId ||
        typeof folio.folioId !== 'string' || !folio.folioId ||
        folio.currency !== 'INR' || !Number.isSafeInteger(folio.balanceMinor) ||
        folio.balanceMinor < 0) throw new TypeError(label + '_folio_invalid');
    const key = folio.tenantId + ':' + folio.folioId;
    if (folioKeys.has(key)) throw new TypeError(label + '_duplicate_folio');
    folioKeys.add(key);
  }
  const intentKeys = new Set();
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.intentId !== 'string' || !entry.intentId ||
        typeof entry.tenantId !== 'string' || !entry.tenantId ||
        typeof entry.folioId !== 'string' || !entry.folioId ||
        typeof entry.providerPaymentId !== 'string' || !entry.providerPaymentId ||
        !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0 ||
        entry.currency !== 'INR' ||
        !['PAYMENT_CREDIT', 'REFUND_DEBIT'].includes(entry.type)) {
      throw new TypeError(label + '_journal_entry_invalid');
    }
    if (intentKeys.has(entry.intentId)) throw new TypeError(label + '_duplicate_intent_entry');
    intentKeys.add(entry.intentId);
  }
}

function byKey(items, keyFn) {
  return new Map(items.map(item => [keyFn(item), item]));
}

/**
 * Read-only comparison of normalized local PMS and legacy Firestore exports.
 * It never writes, repairs, archives, or deletes source records.
 */
export function reconcileLegacySnapshots(localSnapshot, firestoreSnapshot) {
  assertSnapshot(localSnapshot, 'local');
  assertSnapshot(firestoreSnapshot, 'firestore');
  const mismatches = [];
  const localFolios = byKey(localSnapshot.folios, f => f.tenantId + ':' + f.folioId);
  const remoteFolios = byKey(firestoreSnapshot.folios, f => f.tenantId + ':' + f.folioId);
  for (const key of new Set([...localFolios.keys(), ...remoteFolios.keys()])) {
    const local = localFolios.get(key), remote = remoteFolios.get(key);
    if (!local) mismatches.push({ type: 'LOCAL_FOLIO_MISSING', key });
    else if (!remote) mismatches.push({ type: 'FIRESTORE_FOLIO_MISSING', key });
    else if (local.currency !== remote.currency || local.balanceMinor !== remote.balanceMinor) {
      mismatches.push({
        type: 'FOLIO_BALANCE_MISMATCH', key,
        localBalanceMinor: local.balanceMinor, firestoreBalanceMinor: remote.balanceMinor,
        localCurrency: local.currency, firestoreCurrency: remote.currency
      });
    }
  }

  const localEntries = byKey(localSnapshot.entries, entry => entry.intentId);
  const remoteEntries = byKey(firestoreSnapshot.entries, entry => entry.intentId);
  for (const intentId of new Set([...localEntries.keys(), ...remoteEntries.keys()])) {
    const local = localEntries.get(intentId), remote = remoteEntries.get(intentId);
    if (!local) mismatches.push({ type: 'LOCAL_JOURNAL_ENTRY_MISSING', intentId });
    else if (!remote) mismatches.push({ type: 'FIRESTORE_JOURNAL_ENTRY_MISSING', intentId });
    else {
      const fields = ['tenantId', 'folioId', 'providerPaymentId', 'amountMinor', 'currency', 'type'];
      const changed = fields.filter(field => local[field] !== remote[field]);
      if (changed.length) mismatches.push({ type: 'JOURNAL_ENTRY_MISMATCH', intentId, fields: changed });
    }
  }

  const sum = entries => entries.reduce((total, entry) =>
    total + (entry.type === 'PAYMENT_CREDIT' ? entry.amountMinor : -entry.amountMinor), 0);
  return Object.freeze({
    status: mismatches.length ? 'REVIEW_REQUIRED' : 'MATCH',
    counts: {
      localFolios: localSnapshot.folios.length,
      firestoreFolios: firestoreSnapshot.folios.length,
      localEntries: localSnapshot.entries.length,
      firestoreEntries: firestoreSnapshot.entries.length,
      mismatches: mismatches.length
    },
    totals: {
      localBalanceMinor: localSnapshot.folios.reduce((total, folio) => total + folio.balanceMinor, 0),
      firestoreBalanceMinor: firestoreSnapshot.folios.reduce((total, folio) => total + folio.balanceMinor, 0),
      localNetJournalMinor: sum(localSnapshot.entries),
      firestoreNetJournalMinor: sum(firestoreSnapshot.entries)
    },
    mismatches
  });
}

function argument(name, args) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function main() {
  const localPath = argument('--local', process.argv.slice(2));
  const firestorePath = argument('--firestore', process.argv.slice(2));
  if (!localPath || !firestorePath) {
    process.stderr.write('Usage: node scripts/reconcile-legacy-folios.mjs --local <local-export.json> --firestore <firestore-export.json>\n');
    process.exit(64);
  }
  const [localRaw, firestoreRaw] = await Promise.all([
    readFile(localPath, 'utf8'), readFile(firestorePath, 'utf8')
  ]);
  const result = reconcileLegacySnapshots(JSON.parse(localRaw), JSON.parse(firestoreRaw));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'MATCH') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(String(error?.message || 'reconciliation_failed') + '\n');
    process.exitCode = 1;
  });
}
