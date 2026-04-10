// ─── Leaflet map management ────────────────────────────────────────────────

let map;
let barLayerGroup;
let buildingLayerGroup;

const CONFIDENCE_RANK = { yes: 3, likely: 2, maybe: 1, no: 0 };

function initMap() {
  map = L.map('map', {
    center: [51.0257, 4.4776],
    zoom: 15,
    zoomControl: true,
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  barLayerGroup      = L.layerGroup().addTo(map);
  buildingLayerGroup = L.layerGroup();
}

/**
 * Render bar markers based on active filters.
 * @param {Array}  bars
 * @param {{ onlySunny, onlyOpen, minConfidence }} filters
 * @returns {{ sunnyCount, shownCount }}
 */
function updateBarMarkers(bars, filters) {
  const { onlySunny, onlyOpen, minConfidence } = filters;
  barLayerGroup.clearLayers();

  let sunnyCount = 0;
  let shownCount = 0;

  for (const bar of bars) {
    // Confidence filter: skip bars below the required confidence level
    const rank = CONFIDENCE_RANK[bar.terrace] ?? 1;
    if (rank < minConfidence) continue;

    // Hide definitely-no-terrace bars always (rank 0)
    if (rank === 0) continue;

    if (onlySunny && !bar.inSun) continue;
    if (onlyOpen  && bar.isOpen === false) continue;

    createBarMarker(bar).addTo(barLayerGroup);
    shownCount++;
    if (bar.inSun) sunnyCount++;
  }

  return { sunnyCount, shownCount };
}

function createBarMarker(bar) {
  const isSun     = bar.inSun;
  const isNight   = bar._isNight;
  const isUnknown = isSun === null && !isNight;

  let fillColor, strokeColor, cssClass;
  if (isNight) {
    fillColor = '#444866'; strokeColor = '#333'; cssClass = '';
  } else if (isUnknown) {
    fillColor = '#5a6080'; strokeColor = '#8891b4'; cssClass = '';
  } else if (isSun) {
    fillColor = '#FFB800'; strokeColor = '#CC8000'; cssClass = 'marker-sunny';
  } else {
    fillColor = '#4a5580'; strokeColor = '#333a5a'; cssClass = '';
  }

  // Adjust radius slightly by confidence
  const rank = CONFIDENCE_RANK[bar.terrace] ?? 1;
  const radius = rank === 3 ? 10 : rank === 2 ? 8 : 7;

  const marker = L.circleMarker([bar.lat, bar.lon], {
    radius,
    fillColor,
    color: strokeColor,
    weight: rank === 3 ? 2.5 : 1.5,
    opacity: 1,
    fillOpacity: rank === 3 ? 0.95 : rank === 2 ? 0.85 : 0.65,
    className: cssClass,
  });

  marker.bindPopup(buildPopupHtml(bar), { className: 'bar-popup', maxWidth: 280 });
  return marker;
}

function buildPopupHtml(bar) {
  const isNight   = bar._isNight;
  const isUnknown = bar.inSun === null && !isNight;

  let sunHtml;
  if (isNight)        sunHtml = '<span class="status-night">🌙 Nacht</span>';
  else if (isUnknown) sunHtml = '<span class="status-night">⏳ Schaduw laden…</span>';
  else if (bar.inSun) sunHtml = '<span class="status-sun">☀️ Terras in de zon</span>';
  else                sunHtml = '<span class="status-shade">🌥 Terras in de schaduw</span>';

  const confidenceLabels = {
    yes:    '✅ Zeker een terras',
    likely: '🟡 Waarschijnlijk een terras',
    maybe:  '⚪ Misschien een terras',
    no:     '❌ Geen terras',
  };
  const terraceHtml = `<span class="terrace-badge">${confidenceLabels[bar.terrace] || ''}</span>`;

  const amenityLabel = { bar: 'Bar', pub: 'Pub', cafe: 'Café', restaurant: 'Restaurant' }[bar.amenity] || 'Bar';

  let html = `<div class="popup">
    <h3>${escapeHtml(bar.name)}</h3>
    <div class="popup-badges">${sunHtml}${terraceHtml}</div>
    <p class="address">${amenityLabel}${bar.address ? ' · ' + escapeHtml(bar.address) : ''}</p>`;

  if (bar.opening_hours) {
    const status = openLabel(bar.isOpen, bar.opening_hours);
    html += `<p class="hours">${status} · ${escapeHtml(bar.opening_hours)}</p>`;
  } else {
    html += `<p class="hours">🕐 Openingsuren onbekend</p>`;
  }

  if (bar.phone)   html += `<p class="phone">📞 ${escapeHtml(bar.phone)}</p>`;
  if (bar.website) {
    const url = bar.website.startsWith('http') ? bar.website : null;
    if (url) html += `<p class="website"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Website →</a></p>`;
  }

  html += '</div>';
  return html;
}

function renderBuildings(buildings) {
  buildingLayerGroup.clearLayers();
  for (const b of buildings) {
    const ring = b.polygon.geometry.coordinates[0].map(c => [c[1], c[0]]);
    L.polygon(ring, { color: '#6674aa', weight: 1, fillColor: '#3a4070', fillOpacity: 0.35 })
      .addTo(buildingLayerGroup);
  }
}

function toggleBuildings(show) {
  show ? buildingLayerGroup.addTo(map) : map.removeLayer(buildingLayerGroup);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
