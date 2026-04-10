// ─── Sun position & shadow calculation ────────────────────────────────────

// Mechelen city centre coordinates
const MECHELEN_LAT = 51.0257;
const MECHELEN_LON = 4.4776;

// Conservative max building height in Mechelen city centre (metres)
// Used to cap the shadow ray length at very low sun angles
const MAX_BUILDING_HEIGHT = 25;

// Minimum sun altitude to consider it "up" (radians, ~1.5°)
// Below this the sun is near-horizon and diffuse — skip shadow calc
const MIN_SUN_ALTITUDE = 0.026;

/**
 * Get the current sun position for Mechelen.
 *
 * SunCalc azimuth convention (different from compass!):
 *   0       = South
 *   π/2     = West
 *   π       = North
 *   -π/2    = East
 *
 * We convert to a standard compass bearing (N=0°, E=90°, S=180°, W=270°).
 *
 * @param {Date} [date] – defaults to now
 * @returns {{ altitude: number, altitudeDeg: number, bearing: number, isUp: boolean }}
 */
function getSunPosition(date) {
  const pos = SunCalc.getPosition(date || new Date(), MECHELEN_LAT, MECHELEN_LON);

  // Convert SunCalc azimuth → compass bearing (degrees, clockwise from North)
  const bearing = ((pos.azimuth * 180 / Math.PI) + 180 + 360) % 360;

  return {
    altitude: pos.altitude,           // radians above horizon
    altitudeDeg: pos.altitude * 180 / Math.PI,
    bearing,                          // compass degrees (N=0)
    isUp: pos.altitude > MIN_SUN_ALTITUDE,
  };
}

/**
 * Determine whether a bar terrace is in direct sunlight given the current
 * sun position and a list of building footprints.
 *
 * Algorithm:
 *  1. If sun is below horizon → false (dark)
 *  2. Compute the maximum shadow length any building can cast
 *     (shadow_length = height / tan(altitude))
 *  3. Cast a ray from the terrace toward the sun (compass bearing)
 *     up to maxShadow metres
 *  4. For each nearby building, check if the ray intersects the polygon
 *  5. For each intersection, check if the building is tall enough to block
 *     the sun at that distance: building.height > distance × tan(altitude)
 *  6. If any building passes the height test → in shadow, else → in sun
 *
 * @param {{ lat: number, lon: number }} bar
 * @param {Array<{ height: number, polygon: object }>} buildings
 * @param {{ altitude: number, bearing: number, isUp: boolean }} sunPos
 * @returns {boolean}
 */
function isTerraceInSun(bar, buildings, sunPos) {
  if (!sunPos.isUp) return false;

  const tanAlt = Math.tan(sunPos.altitude);

  // Maximum shadow distance in metres (cap at 300m for performance)
  const maxShadow = Math.min(MAX_BUILDING_HEIGHT / tanAlt, 300);

  const terracePoint = turf.point([bar.lon, bar.lat]);

  // Endpoint of ray: terrace → sun direction
  const rayEnd = turf.destination(
    terracePoint,
    maxShadow / 1000,        // turf works in km
    sunPos.bearing,
    { units: 'kilometers' }
  );

  const ray = turf.lineString([
    terracePoint.geometry.coordinates,
    rayEnd.geometry.coordinates,
  ]);

  for (const building of buildings) {
    // Quick bounding-box distance pre-filter using centroid
    const centre = turf.centroid(building.polygon);
    const approxDist = turf.distance(terracePoint, centre, { units: 'meters' });
    if (approxDist > maxShadow + 60) continue; // +60m buffer for large buildings

    // Check ray–polygon intersection
    let intersections;
    try {
      intersections = turf.lineIntersect(ray, building.polygon);
    } catch {
      continue;
    }
    if (!intersections || intersections.features.length === 0) continue;

    // Find the nearest intersection point
    let nearestDist = Infinity;
    for (const pt of intersections.features) {
      const d = turf.distance(terracePoint, pt, { units: 'meters' });
      if (d < nearestDist) nearestDist = d;
    }

    // Ignore intersections within 3m (terrace is adjacent to / inside building)
    if (nearestDist < 3) continue;

    // Does this building block the sun at this distance?
    // Sun apparent height at distance d: d × tan(altitude)
    // Building blocks if: building.height >= d × tan(altitude)
    if (building.height >= nearestDist * tanAlt) {
      return false; // terrace is in shadow
    }
  }

  return true; // no obstruction found — in sun
}

/**
 * Convert a compass bearing (degrees) to a short Dutch cardinal direction label.
 * @param {number} bearing
 * @returns {string}
 */
function bearingToLabel(bearing) {
  const labels = ['N', 'NNO', 'NO', 'ONO', 'O', 'OZO', 'ZO', 'ZZO',
                  'Z', 'ZZW', 'ZW', 'WZW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(((bearing % 360) + 360) / 22.5) % 16;
  return labels[idx];
}
