// ─── OSM / Overpass API ────────────────────────────────────────────────────

// Multiple Overpass API mirrors — tried in order until one succeeds
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

/**
 * POST a query to the first Overpass mirror that responds successfully.
 * Tries each mirror with a 15-second timeout before moving to the next.
 */
async function overpassFetch(query) {
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: query,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`Overpass mirror ${url} failed:`, err.message);
      lastErr = err;
    }
  }
  throw new Error(`Alle Overpass mirrors mislukt: ${lastErr?.message}`);
}

// Bounding box: covers Mechelen city centre + surrounding neighbourhoods
// south, west, north, east
const BBOX = '51.016,4.465,51.035,4.490';

/**
 * Fetch bars/pubs/cafes with outdoor_seating=yes from Overpass API.
 * Returns an array of bar objects: { id, name, lat, lon, ... }
 */
async function fetchBarsWithTerraces() {
  const query = `[out:json][timeout:30];
(
  node["amenity"~"bar|pub|cafe"]["outdoor_seating"="yes"](${BBOX});
  way["amenity"~"bar|pub|cafe"]["outdoor_seating"="yes"](${BBOX});
);
out body geom;`;

  const data = await overpassFetch(query);
  return parseOsmBars(data.elements);
}

function parseOsmBars(elements) {
  return elements
    .map(el => {
      let lat, lon;
      if (el.type === 'node') {
        lat = el.lat;
        lon = el.lon;
      } else if (el.type === 'way' && el.geometry && el.geometry.length > 0) {
        // Use centroid of way geometry
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
        inSun: false,
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

/**
 * Fetch building footprints from Overpass API.
 * Returns an array of building objects: { id, height, polygon (turf Feature) }
 */
async function fetchBuildings() {
  const query = `[out:json][timeout:60];
(
  way["building"](${BBOX});
);
out body geom;`;

  const data = await overpassFetch(query);
  return parseOsmBuildings(data.elements);
}

function parseOsmBuildings(elements) {
  const buildings = [];

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;

    // Build coordinate ring [lon, lat] (GeoJSON order)
    const coords = el.geometry.map(n => [n.lon, n.lat]);

    // Close ring if not already closed
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coords.push([first[0], first[1]]);
    }

    // Determine height
    const tags = el.tags || {};
    let height = 8; // default ~2-3 storey
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
      continue; // skip malformed polygons
    }

    buildings.push({
      id: `osm_way_${el.id}`,
      height,
      polygon,
    });
  }

  return buildings;
}
