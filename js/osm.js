// ─── OSM / Overpass API ────────────────────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',  // most reliable
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const BBOX      = '51.010,4.460,51.040,4.500'; // Mechelen city + surroundings
const BBOX_BLDG = '51.024,4.474,51.031,4.488'; // tighter box for buildings

/**
 * POST to first working Overpass mirror. Returns data or null on total failure.
 */
async function overpassFetch(query, timeoutMs = 25000) {
  for (const url of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.elements)) throw new Error('Onverwacht antwoord');
      console.log(`Overpass OK via ${url}`);
      return data;
    } catch (err) {
      console.warn(`Overpass mirror ${url} mislukt:`, err.message);
    }
  }
  return null;
}

// ─── Terrace confidence ────────────────────────────────────────────────────

/**
 * Estimate how likely it is that a venue has an outdoor terrace.
 *
 * Returns one of:
 *   'yes'    – explicitly tagged outdoor_seating=yes (zeker terras)
 *   'likely' – bar/pub, no explicit tag (waarschijnlijk)
 *   'maybe'  – cafe/restaurant, no explicit tag (misschien)
 *   'no'     – explicitly tagged outdoor_seating=no (geen terras)
 */
function terraceConfidence(tags) {
  if (!tags) return 'maybe';

  // Explicit OSM tags
  if (tags.outdoor_seating === 'yes')   return 'yes';
  if (tags.outdoor_seating === 'no')    return 'no';
  if (tags.terrace === 'yes')           return 'yes';
  if (tags.terrace === 'no')            return 'no';

  // Amenity heuristic
  const a = tags.amenity || '';
  if (a === 'bar' || a === 'pub')       return 'likely';
  if (a === 'cafe' || a === 'restaurant') return 'maybe';
  return 'maybe';
}

// ─── Bars ──────────────────────────────────────────────────────────────────

async function fetchBarsWithTerraces() {
  const query = `[out:json][timeout:45];
(
  node["amenity"~"bar|pub|cafe"](${BBOX});
  way["amenity"~"bar|pub|cafe"](${BBOX});
);
out body geom;`;
  const data = await overpassFetch(query, 30000);
  if (!data) return null;
  return parseOsmBars(data.elements);
}

async function fetchStaticBars() {
  try {
    const res = await fetch('data/osm_bars.json');
    if (!res.ok) return [];
    const data = await res.json();
    return parseOsmBars(data.elements || []);
  } catch {
    return [];
  }
}

function parseOsmBars(elements) {
  return elements
    .map(el => {
      // Skip non-venue elements (public_bookcase etc. caught by regex)
      const amenity = el.tags?.amenity || '';
      if (!['bar','pub','cafe','restaurant'].includes(amenity)) return null;

      let lat, lon;
      if (el.type === 'node') {
        lat = el.lat; lon = el.lon;
      } else if (el.type === 'way' && el.geometry?.length > 0) {
        lat = el.geometry.reduce((s, n) => s + n.lat, 0) / el.geometry.length;
        lon = el.geometry.reduce((s, n) => s + n.lon, 0) / el.geometry.length;
      }
      if (!lat || !lon) return null;

      const tags = el.tags || {};
      return {
        id: `osm_${el.type}_${el.id}`,
        name: tags.name || 'Naamloze kroeg',
        lat, lon,
        amenity,
        address: buildAddress(tags),
        phone: tags.phone || tags['contact:phone'] || null,
        website: tags.website || tags['contact:website'] || null,
        opening_hours: tags.opening_hours || null,
        terrace: terraceConfidence(tags),
        source: 'osm',
        inSun: null,
        isOpen: null,
      };
    })
    .filter(Boolean);
}

function buildAddress(tags) {
  const parts = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  return parts.length > 0 ? parts.join(' ') : null;
}

// ─── Buildings ─────────────────────────────────────────────────────────────

async function fetchBuildings() {
  const query = `[out:json][timeout:45];
way["building"](${BBOX_BLDG});
out body geom;`;
  const data = await overpassFetch(query, 30000);
  if (!data) return null;
  return parseOsmBuildings(data.elements);
}

function parseOsmBuildings(elements) {
  const buildings = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
    const coords = el.geometry.map(n => [n.lon, n.lat]);
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);

    const tags = el.tags || {};
    let height = 8;
    if (tags.height)              height = parseFloat(tags.height) || 8;
    else if (tags['building:levels']) height = (parseInt(tags['building:levels'], 10) || 2) * 3.2;

    let polygon;
    try { polygon = turf.polygon([coords]); } catch { continue; }
    buildings.push({ id: `osm_way_${el.id}`, height, polygon });
  }
  return buildings;
}
