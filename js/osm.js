// ─── OSM / Overpass API ────────────────────────────────────────────────────

// Multiple Overpass API mirrors — tried in order until one succeeds
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

// Bounding box: covers Mechelen city centre + near surroundings
// south, west, north, east
const BBOX      = '51.010,4.460,51.040,4.500';
// Tighter box for buildings (expensive query — smaller area = faster)
const BBOX_BLDG = '51.024,4.474,51.031,4.488';

/**
 * POST a query to the first Overpass mirror that responds successfully.
 * Tries each mirror with the given per-mirror timeout before moving on.
 * Returns null instead of throwing if all mirrors fail.
 */
async function overpassFetch(query, timeoutMs = 20000) {
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
      return data;
    } catch (err) {
      console.warn(`Overpass mirror ${url} mislukt:`, err.message);
    }
  }
  return null; // all mirrors failed — caller handles gracefully
}

// ─── Bars ──────────────────────────────────────────────────────────────────

/**
 * Try to fetch live bars from Overpass.
 * Returns parsed bar array, or null if all mirrors failed.
 */
async function fetchBarsWithTerraces() {
  // No outdoor_seating filter — OSM tagging is too sparse in Mechelen.
  // We fetch all bars/pubs/cafes and assume they may have a terrace.
  const query = `[out:json][timeout:25];
(
  node["amenity"~"bar|pub|cafe"](${BBOX});
  way["amenity"~"bar|pub|cafe"](${BBOX});
);
out body geom;`;

  const data = await overpassFetch(query, 20000);
  if (!data) return null;
  return parseOsmBars(data.elements);
}

/**
 * Load bars from the bundled static snapshot (data/osm_bars.json).
 * Falls back to empty array if the file is missing.
 */
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
      let lat, lon;
      if (el.type === 'node') {
        lat = el.lat;
        lon = el.lon;
      } else if (el.type === 'way' && el.geometry && el.geometry.length > 0) {
        lat = el.geometry.reduce((s, n) => s + n.lat, 0) / el.geometry.length;
        lon = el.geometry.reduce((s, n) => s + n.lon, 0) / el.geometry.length;
      }
      if (!lat || !lon) return null;

      const tags = el.tags || {};
      return {
        id: `osm_${el.type}_${el.id}`,
        name: tags.name || 'Naamloze kroeg',
        lat,
        lon,
        amenity: tags.amenity || 'bar',
        address: buildAddress(tags),
        phone: tags.phone || tags['contact:phone'] || null,
        website: tags.website || tags['contact:website'] || null,
        opening_hours: tags.opening_hours || null,
        source: 'osm',
        inSun: null, // null = unknown (no buildings yet)
      };
    })
    .filter(Boolean);
}

function buildAddress(tags) {
  const parts = [
    tags['addr:street'],
    tags['addr:housenumber'],
  ].filter(Boolean);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  return parts.length > 0 ? parts.join(' ') : null;
}

// ─── Buildings ─────────────────────────────────────────────────────────────

/**
 * Try to fetch building footprints from Overpass.
 * Returns parsed building array, or null if all mirrors failed.
 */
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
    if (tags.height) {
      const h = parseFloat(tags.height);
      if (!isNaN(h) && h > 0) height = h;
    } else if (tags['building:levels']) {
      const lvl = parseInt(tags['building:levels'], 10);
      if (!isNaN(lvl) && lvl > 0) height = lvl * 3.2;
    }

    let polygon;
    try {
      polygon = turf.polygon([coords]);
    } catch {
      continue;
    }

    buildings.push({ id: `osm_way_${el.id}`, height, polygon });
  }

  return buildings;
}
