const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

export function getTimeZone() {
  const tz = process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Milliseconds the time zone is ahead of UTC at the given instant (IST = +19800000). */
function offsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight for a calendar date in the time zone. */
export function zonedMidnight(year, month, day, timeZone = getTimeZone()) {
  const guess = Date.UTC(year, month - 1, day);
  let ts = guess - offsetMs(new Date(guess), timeZone);
  ts = guess - offsetMs(new Date(ts), timeZone); // second pass handles DST transitions
  return new Date(ts);
}

export function startOfToday(timeZone = getTimeZone(), now = new Date()) {
  const p = zonedParts(now, timeZone);
  return zonedMidnight(p.year, p.month, p.day, timeZone);
}

export function formatInTimeZone(date, timeZone = getTimeZone()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}
