// ─── Opening-hours parser ──────────────────────────────────────────────────
// Handles the most common OSM opening_hours patterns. Returns true/false/null.
// null = unknown (no data or unparseable format → treated as "maybe open")

const DAY_ABBR = { mo:0, tu:1, we:2, th:3, fr:4, sa:5, su:6 };

/**
 * Is the venue likely open right now?
 * @param {string|null} ohString  OSM opening_hours value
 * @param {Date}        [date]    defaults to now
 * @returns {boolean|null}        true=open, false=closed, null=unknown
 */
function isOpenNow(ohString, date) {
  if (!ohString) return null;

  const now  = date || new Date();
  const dow  = (now.getDay() + 6) % 7; // 0=Mon…6=Sun
  const mins = now.getHours() * 60 + now.getMinutes();

  const raw = ohString.toLowerCase().trim();

  // "24/7"
  if (raw === '24/7') return true;

  // Split on ";" to get rule segments; try each in order (last match wins, like real parsers)
  const rules = raw.split(';').map(r => r.trim()).filter(Boolean);

  let result = null;

  for (const rule of rules) {
    // Strip trailing modifiers like "PH off", "PH open" — skip PH rules
    if (rule.startsWith('ph')) continue;

    // Separate day part from time part
    // Examples:
    //   "mo-fr 09:00-18:00"
    //   "sa-su 10:00-22:00"
    //   "mo,we,fr 08:00-12:00"
    //   "mo-su 09:00-21:00"
    //   "09:00-18:00"   (no day = every day)
    const timeMatch = rule.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
    if (!timeMatch) continue;

    const dayPart  = rule.slice(0, rule.search(/\d{1,2}:\d{2}/)).trim();
    const openMin  = parseTime(timeMatch[1]);
    const closeMin = parseTime(timeMatch[2]);
    if (openMin === null || closeMin === null) continue;

    // Check if today matches the day specification
    const dayMatch = dayPart ? matchesDay(dayPart, dow) : true;
    if (!dayMatch) continue;

    // Check if current time is within range
    // Handle overnight spans (e.g. 22:00-02:00)
    let open;
    if (closeMin > openMin) {
      open = mins >= openMin && mins < closeMin;
    } else {
      // overnight: open if after openMin OR before closeMin
      open = mins >= openMin || mins < closeMin;
    }

    result = open;
  }

  return result;
}

function parseTime(str) {
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Does the day specification cover the given day-of-week index (0=Mon…6=Sun)?
 * Handles "mo-fr", "sa-su", "mo,we,fr", "mo-su", bare "mo", etc.
 */
function matchesDay(dayPart, dow) {
  // Remove trailing whitespace/colons
  const dp = dayPart.replace(/[:\s]+$/, '').trim();
  if (!dp) return true;

  // Split on comma for lists like "mo,we,fr"
  const segments = dp.split(',');

  for (const seg of segments) {
    const s = seg.trim();
    const rangeMatch = s.match(/^([a-z]{2})\s*[-–]\s*([a-z]{2})$/);
    if (rangeMatch) {
      const from = DAY_ABBR[rangeMatch[1]];
      const to   = DAY_ABBR[rangeMatch[2]];
      if (from === undefined || to === undefined) continue;
      // Handle wrap-around ranges (e.g. fr-mo)
      if (to >= from) {
        if (dow >= from && dow <= to) return true;
      } else {
        if (dow >= from || dow <= to) return true;
      }
    } else if (DAY_ABBR[s] !== undefined) {
      if (DAY_ABBR[s] === dow) return true;
    }
  }
  return false;
}

/**
 * Human-readable open/closed label in Dutch.
 * @param {boolean|null} isOpen
 * @param {string|null}  ohString
 * @returns {string}
 */
function openLabel(isOpen, ohString) {
  if (isOpen === true)  return '🟢 Nu open';
  if (isOpen === false) return '🔴 Nu gesloten';
  return ohString ? '⚪ Openingsuren onbekend' : '⚪ Geen openingsuren';
}
