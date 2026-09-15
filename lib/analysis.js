// Threat analysis model + extension point for a future AI image-analysis service.
//
// IMPORTANT: no narcotics/explosive detection model is integrated. Receiving an image proves
// nothing about its contents, so every new detection starts as PENDING / UNKNOWN / null and
// the dashboard shows it as NOT ANALYZED until a real analysis result is reported.

export const THREAT_STATUSES = ['PENDING', 'CLEAR', 'SUSPICIOUS', 'THREAT'];
export const DETECTION_TYPES = ['UNKNOWN', 'NONE', 'NARCOTICS', 'EXPLOSIVE', 'WEAPON', 'OTHER'];

export function initialAnalysisFields() {
  return {
    threatStatus: 'PENDING',
    detectionType: 'UNKNOWN',
    confidence: null,
    analysis: { status: 'NOT_ANALYZED', source: null, model: null, notes: null, analyzedAt: null, reviewedBy: null },
  };
}

export function isAnalysisServiceConfigured() {
  return Boolean(process.env.ANALYSIS_WEBHOOK_URL && process.env.ANALYSIS_API_KEY);
}

/**
 * When ANALYSIS_WEBHOOK_URL is set, sends the new detection to the external AI service.
 * The service must later call PATCH {callbackUrl} with header X-Analysis-Key and a body like
 * { "threatStatus": "CLEAR", "detectionType": "NONE", "confidence": 0.93, "model": "yolo-v8-custom" }.
 */
export async function requestAnalysis(detection, origin) {
  if (!isAnalysisServiceConfigured()) return { requested: false };
  try {
    const response = await fetch(process.env.ANALYSIS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Analysis-Key': process.env.ANALYSIS_API_KEY },
      body: JSON.stringify({
        eventId: detection.id,
        imageUrl: detection.imageUrl,
        rfidUid: detection.rfidUid,
        readerId: detection.readerId,
        platform: detection.platform,
        deviceId: detection.deviceId,
        timestamp: detection.timestamp,
        callbackUrl: `${origin}/api/detections/${detection.id}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.error('[analysis] webhook responded', response.status);
    return { requested: response.ok };
  } catch (err) {
    console.error('[analysis] webhook failed:', err.message);
    return { requested: false };
  }
}
