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

  // Split on ";" to get rule segments; try each in order (last match wins, like real parsers).
  // A day that no rule mentions is closed (OSM semantics), but only when every rule was
  // understood: anything we cannot parse keeps the answer at null (unknown).
  // Some OSM values separate rules with "," after a time ("Mo-Th 16:00-01:00, Fr-Sa 15:00-02:00"):
  // split there too, but not inside "mo,we,fr" or "09:00-12:00,13:00-18:00".
  const rules = raw.split(/;|(?<=\d:\d{2})\s*,\s*(?=[a-z])/).map(r => r.trim()).filter(Boolean);
  const yesterday = (dow + 6) % 7;

  let result = null;
  let understood = true;

  for (const rule of rules) {
    // Public-holiday rules ("PH off", "PH 10:00-14:00") are skipped: we do not know the holidays
    if (rule.startsWith('ph')) continue;

    // "Mo off", "Su closed", "off"
    const off = rule.match(/^(.*?)\s*\b(off|closed)$/);
    if (off) {
      const days = off[1].trim();
      if (!isDayPart(days)) { understood = false; continue; }
      if (matchesDay(days, dow)) result = false;
      continue;
    }

    // Separate day part from time part
    // Examples:
    //   "mo-fr 09:00-18:00"
    //   "sa-su 10:00-22:00"
    //   "mo,we,fr 08:00-12:00"
    //   "mo-fr 09:00-12:00,13:00-18:00"   (several spans)
    //   "09:00-18:00"   (no day = every day)
    const firstTime = rule.search(/\d{1,2}:\d{2}/);
    if (firstTime < 0) { understood = false; continue; }
    const dayPart = rule.slice(0, firstTime).trim();
    if (!isDayPart(dayPart)) { understood = false; continue; }

    const spans = [];
    for (const m of rule.slice(firstTime).matchAll(/(\d{1,2}:\d{2})\s*[-\u2013]\s*(\d{1,2}:\d{2})/g)) {
      const openMin  = parseTime(m[1]);
      const closeMin = parseTime(m[2]);
      if (openMin !== null && closeMin !== null) spans.push([openMin, closeMin]);
    }
    if (!spans.length) { understood = false; continue; }

    // Overnight spans (e.g. 22:00-02:00) run into the next day: the part after
    // midnight belongs to the day the span started on.
    const inToday = spans.some(([o, c]) => (c > o ? mins >= o && mins < c : mins >= o));
    const inYesterdaysNight = matchesDay(dayPart, yesterday)
      && spans.some(([o, c]) => c <= o && mins < c);

    if (matchesDay(dayPart, dow)) {
      result = inToday || inYesterdaysNight;
    } else if (inYesterdaysNight) {
      result = true;
    }
  }

  if (result === null && understood && rules.some(r => !r.startsWith('ph'))) return false;
  return result;
}

/**
 * Is the day part made only of day abbreviations, ranges and lists we understand?
 * ("", "mo", "mo-fr", "mo,we,fr", "sa-su"; not "apr-oct: mo-su" or "sunrise")
 */
function isDayPart(dayPart) {
  const dp = dayPart.replace(/[:\s]+$/, '').trim();
  if (!dp) return true;
  return dp.split(',').every(seg => {
    const s = seg.trim();
    const range = s.match(/^([a-z]{2})\s*[-\u2013]\s*([a-z]{2})$/);
    if (range) return DAY_ABBR[range[1]] !== undefined && DAY_ABBR[range[2]] !== undefined;
    return DAY_ABBR[s] !== undefined;
  });
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
