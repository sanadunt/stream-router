import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { currentSession } from '../../plugins/auth.js';
import { failingChecks, healthReport, readinessFailureSummary } from './health-service.js';

const READINESS_LOG_INTERVAL_MS = 5 * 60_000;
let lastReadinessLog: { signature: string; at: number } | null = null;

// Detail kegagalan hanya dikirim ke admin/operator, jadi penyebabnya juga ditulis ke log server
// (`pm2 logs`). Satu baris per perubahan status atau per lima menit, bukan per polling.
function logReadiness(log: FastifyBaseLogger, report: Awaited<ReturnType<typeof healthReport>>): void {
  if (report.ok) {
    if (lastReadinessLog) log.info('Pemeriksaan kesiapan kembali sehat');
    lastReadinessLog = null;
    return;
  }
  const checks = readinessFailureSummary(report);
  const signature = JSON.stringify(checks);
  const now = Date.now();
  if (lastReadinessLog?.signature === signature && now - lastReadinessLog.at < READINESS_LOG_INTERVAL_MS) return;
  lastReadinessLog = { signature, at: now };
  log.warn({ checks }, 'Pemeriksaan kesiapan gagal');
}

// Laporan lengkap memuat versi binary, port, path storage, memori proses, dan teks error.
// Endpoint tetap terbuka untuk curl/monitoring, tetapi tanpa sesi admin/operator hanya
// status ringkas yang dikirim (Viewer tidak memakai password, jadi diperlakukan sama).
async function canReadFullReport(request: FastifyRequest): Promise<boolean> {
  const session = await currentSession(request).catch(() => null);
  return session?.role === 'admin' || session?.role === 'operator';
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (request, reply) => {
    const [report, full] = await Promise.all([healthReport(), canReadFullReport(request)]);
    logReadiness(request.log, report);
    return reply.code(200).send(full ? report : { ok: report.ok, timestamp: report.timestamp });
  });
  app.get('/api/ready', async (request, reply) => {
    const [report, full] = await Promise.all([healthReport(), canReadFullReport(request)]);
    logReadiness(request.log, report);
    if (full) return reply.code(report.ok ? 200 : 503).send({ ready: report.ok, checks: report });
    // Pemanggil anonim hanya menerima nama pemeriksaan yang gagal, tanpa detail.
    return reply.code(report.ok ? 200 : 503).send(report.ok ? { ready: true } : { ready: false, failing: failingChecks(report) });
  });
}
