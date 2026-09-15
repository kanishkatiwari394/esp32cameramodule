// GET /api/health - public deployment check. Reports only whether things are configured/reachable,
// never the values of any secret.

import { json } from '../lib/http.js';
import { getDb } from '../lib/mongodb.js';
import { isCloudinaryConfigured } from '../lib/cloudinary.js';
import { isTelegramConfigured } from '../lib/telegram.js';
import { isAnalysisServiceConfigured } from '../lib/analysis.js';

export async function GET() {
  const checks = {
    database: 'not_configured',
    cloudinary: isCloudinaryConfigured() ? 'configured' : 'not_configured',
    jwtSecret: (process.env.JWT_SECRET || '').length >= 32 ? 'configured' : 'not_configured',
    deviceApiKey: (process.env.DEVICE_API_KEY || '').length >= 16 || process.env.DEVICE_KEYS ? 'configured' : 'not_configured',
    telegram: isTelegramConfigured() ? 'configured' : 'disabled',
    aiAnalysis: isAnalysisServiceConfigured() ? 'configured' : 'not_integrated',
  };

  if (process.env.MONGODB_URI) {
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      checks.database = 'connected';
    } catch {
      checks.database = 'connection_failed';
    }
  }

  const ok =
    checks.database === 'connected' &&
    checks.cloudinary === 'configured' &&
    checks.jwtSecret === 'configured' &&
    checks.deviceApiKey === 'configured';

  return json({ ok, service: 'raksha-rail', checks, time: new Date().toISOString() }, ok ? 200 : 503);
}
