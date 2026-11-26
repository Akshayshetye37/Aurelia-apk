/**
 * Evaluate dependency readiness without exposing dependency errors or secret
 * material. The Secret Manager probe must return a non-empty accessible
 * payload; metadata-only access is not sufficient for payment operations.
 */
export async function inspectReadinessDependencies({ firestoreCheck, secretManagerCheck }) {
  if (typeof firestoreCheck !== 'function' || typeof secretManagerCheck !== 'function') {
    throw new TypeError('readiness_probe_dependencies_required');
  }
  const results = await Promise.allSettled([firestoreCheck(), secretManagerCheck()]);
  const firestore = results[0].status === 'fulfilled';
  const value = results[1].status === 'fulfilled' ? results[1].value : null;
  const secretManager = Buffer.isBuffer(value) ? value.length > 0
    : value instanceof Uint8Array ? value.byteLength > 0
      : typeof value === 'string' && value.length > 0;
  return { firestore, secretManager, ready: firestore && secretManager };
}
