import { formatInTimeZone } from './time.js';

// Optional. The app works normally when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set,
// and a Telegram failure never fails the ESP32 upload.

export function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function notifyDetection(detection) {
  if (!isTelegramConfigured()) return { sent: false };

  const caption = [
    '🚨 <b>Raksha Rail - New RFID detection</b>',
    `<b>RFID UID:</b> <code>${escapeHtml(detection.rfidUid)}</code>`,
    `<b>Reader:</b> ${escapeHtml(detection.readerId)}`,
    `<b>Platform:</b> ${escapeHtml(detection.platform)}`,
    `<b>Device:</b> ${escapeHtml(detection.deviceId)}`,
    `<b>Threat status:</b> ${escapeHtml(detection.threatStatus)} (not analyzed)`,
    `<b>Time:</b> ${escapeHtml(formatInTimeZone(new Date(detection.timestamp)))}`,
  ].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        photo: detection.imageUrl,
        caption,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error('[telegram] sendPhoto failed:', response.status, body.slice(0, 300));
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error('[telegram] request failed:', err.message);
    return { sent: false };
  }
}
