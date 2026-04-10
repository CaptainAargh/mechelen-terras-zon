// ─── Leaflet map management ────────────────────────────────────────────────

let map;
let barLayerGroup;
let buildingLayerGroup;
let buildingsVisible = false;

/**
 * Initialise the Leaflet map centred on Mechelen's Grote Markt.
 */
function initMap() {
  map = L.map('map', {
    center: [51.0257, 4.4776],
    zoom: 15,
    zoomControl: true,
  });

  // Dark-styled OSM tile layer
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }
  ).addTo(map);

  barLayerGroup    = L.layerGroup().addTo(map);
  buildingLayerGroup = L.layerGroup(); // not added by default
}

/**
 * Render / update all bar markers on the map.
 * Returns the count of bars currently in sunlight.
 *
 * @param {Array<object>} bars
 * @param {boolean} onlySunny – if true, hide shaded bars
 * @returns {number} sunnyCount
 */
function updateBarMarkers(bars, onlySunny) {
  barLayerGroup.clearLayers();

  let sunnyCount = 0;

  for (const bar of bars) {
    if (onlySunny && !bar.inSun) continue;

    const marker = createBarMarker(bar);
    marker.addTo(barLayerGroup);

    if (bar.inSun) sunnyCount++;
  }

  return sunnyCount;
}

function createBarMarker(bar) {
  const isSun   = bar.inSun;
  const isNight = bar._isNight;

  let fillColor, strokeColor, cssClass;
  if (isNight) {
    fillColor   = '#444866';
    strokeColor = '#333';
    cssClass    = '';
  } else if (isSun) {
    fillColor   = '#FFB800';
    strokeColor = '#CC8000';
    cssClass    = 'marker-sunny';
  } else {
    fillColor   = '#4a5580';
    strokeColor = '#333a5a';
    cssClass    = '';
  }

  const marker = L.circleMarker([bar.lat, bar.lon], {
    radius: 9,
    fillColor,
    color: strokeColor,
    weight: 2,
    opacity: 1,
    fillOpacity: 0.92,
    className: cssClass,
  });

  marker.bindPopup(buildPopupHtml(bar), {
    className: 'bar-popup',
    maxWidth: 280,
  });

  return marker;
}

function buildPopupHtml(bar) {
  const isNight = bar._isNight;

  let statusHtml;
  if (isNight) {
    statusHtml = '<span class="status-night">🌙 Nacht — zon onder horizon</span>';
  } else if (bar.inSun) {
    statusHtml = '<span class="status-sun">☀️ Terras in de zon</span>';
  } else {
    statusHtml = '<span class="status-shade">🌥 Terras in de schaduw</span>';
  }

  const amenityLabel = {
    bar:   'Bar',
    pub:   'Pub',
    cafe:  'Café',
  }[bar.amenity] || 'Bar';

  let html = `<div class="popup">
    <h3>${escapeHtml(bar.name)}</h3>
    ${statusHtml}
    <p class="address">${amenityLabel}${bar.address ? ' · ' + escapeHtml(bar.address) : ''}</p>`;

  if (bar.opening_hours) {
    html += `<p class="hours">🕐 ${escapeHtml(bar.opening_hours)}</p>`;
  }
  if (bar.phone) {
    html += `<p class="phone">📞 ${escapeHtml(bar.phone)}</p>`;
  }
  if (bar.website) {
    // Only render website links that start with http(s) for safety
    const url = bar.website.startsWith('http') ? bar.website : null;
    if (url) {
      html += `<p class="website"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Website →</a></p>`;
    }
  }

  html += '</div>';
  return html;
}

/**
 * Render semi-transparent building footprints onto the map.
 * @param {Array<{ polygon: object }>} buildings
 */
function renderBuildings(buildings) {
  buildingLayerGroup.clearLayers();

  for (const b of buildings) {
    // Convert GeoJSON coordinates [lon, lat] → Leaflet [lat, lon]
    const ring = b.polygon.geometry.coordinates[0].map(c => [c[1], c[0]]);
    L.polygon(ring, {
      color: '#6674aa',
      weight: 1,
      fillColor: '#3a4070',
      fillOpacity: 0.35,
    }).addTo(buildingLayerGroup);
  }
}

/**
 * Show or hide the building footprint layer.
 * @param {boolean} show
 */
function toggleBuildings(show) {
  buildingsVisible = show;
  if (show) {
    buildingLayerGroup.addTo(map);
  } else {
    map.removeLayer(buildingLayerGroup);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
