import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { scanOverdueRefunds } from './review-scan.mjs';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) throw new Error('refund_review_scan_project_id_required');
if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId });
const db = getFirestore();

try {
  const result = await scanOverdueRefunds({ db });
  process.stdout.write(JSON.stringify({
    severity: 'INFO', event: 'REFUND_REVIEW_SCAN_COMPLETED', ...result,
    alerts: undefined
  }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({
    severity: 'ERROR', event: 'REFUND_REVIEW_SCAN_FAILED',
    code: String(error?.code || error?.message || 'unknown').slice(0, 120)
  }) + '\n');
  process.exitCode = 1;
} finally {
  await db.terminate();
}
