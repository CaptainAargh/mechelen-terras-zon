// ─── MapLibre GL map management ───────────────────────────────────────────

const CONFIDENCE_RANK = { yes: 3, likely: 2, maybe: 1, no: 0 };

let map;
let isMapReady   = false;
let pendingBars  = null; // queued update before map is ready
let glowFrame    = null;

// ─── Init ─────────────────────────────────────────────────────────────────

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [4.4776, 51.0257],
    zoom: 15.5,
    pitch: 50,
    bearing: -15,
    antialias: true,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.on('load', _onMapLoad);
  // Silence "image not found" warnings from the OpenFreeMap liberty style sprite.
  // The event object has an `.id` field — the raw event was mistakenly used before.
  map.on('styleimagemissing', e => {
    const imgId = e.id;
    if (imgId && !map.hasImage(imgId)) {
      map.addImage(imgId, { width: 1, height: 1, data: new Uint8ClampedArray(4) });
    }
  });
}

function _onMapLoad() {
  // Find a good insertion point (before labels/symbols)
  const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;

  // ── 3D building extrusion ──────────────────────────────────────────────
  // The Liberty style already renders buildings; we override with a richer
  // extrusion that uses a height-based colour gradient.
  if (!map.getLayer('building-3d')) {
    map.addLayer({
      id: 'building-3d-custom',
      source: 'openmaptiles',
      'source-layer': 'building',
      type: 'fill-extrusion',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'],
          ['to-number', ['coalesce', ['get', 'render_height'], 8], 8],
           0, '#1e2240',
          10, '#252b4d',
          20, '#2e3660',
          40, '#374175',
        ],
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'],
          14.9, 0,
          15.1, ['to-number', ['coalesce', ['get', 'render_height'], 8], 8],
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'],
          14.9, 0,
          15.1, ['to-number', ['coalesce', ['get', 'render_min_height'], 0], 0],
        ],
        'fill-extrusion-opacity': 0.85,
      },
    }, firstSymbol);
  }

  // ── Shadow overlay source ──────────────────────────────────────────────
  map.addSource('shadows', {
    type: 'geojson',
    data: _emptyGeoJSON(),
  });

  // Build a diagonal-stripe hatch pattern for the shadow fill.
  // Tile: 14×14 px — dark blue base + bright 45° lines.
  _addHatchPattern();

  // Layer 1 – solid tint (gives the zone a blue cast)
  map.addLayer({
    id: 'shadows-tint',
    type: 'fill',
    source: 'shadows',
    paint: {
      'fill-color': '#0d1a6e',
      'fill-opacity': 0.45,
    },
  }, firstSymbol);

  // Layer 2 – hatched pattern on top (adds visible texture)
  map.addLayer({
    id: 'shadows-hatch',
    type: 'fill',
    source: 'shadows',
    paint: {
      'fill-pattern': 'shadow-hatch',
      'fill-opacity': 0.85,
    },
  }, firstSymbol);

  // Layer 3 – soft outer glow (penumbra feel)
  map.addLayer({
    id: 'shadows-glow',
    type: 'line',
    source: 'shadows',
    paint: {
      'line-color': 'rgba(80, 120, 255, 0.50)',
      'line-width': 6,
      'line-blur': 5,
    },
  }, firstSymbol);

  // Layer 4 – sharp inner edge (crisp boundary)
  map.addLayer({
    id: 'shadows-line',
    type: 'line',
    source: 'shadows',
    paint: {
      'line-color': 'rgba(130, 170, 255, 0.90)',
      'line-width': 1.5,
    },
  }, firstSymbol);

  // ── Bar data source ────────────────────────────────────────────────────
  map.addSource('bars', {
    type: 'geojson',
    data: _emptyGeoJSON(),
  });

  // Outer glow ring for sunny bars
  map.addLayer({
    id: 'bars-glow',
    type: 'circle',
    source: 'bars',
    filter: ['==', ['get', 'inSun'], true],
    paint: {
      'circle-radius': 20,
      'circle-color': '#FFB800',
      'circle-opacity': 0.15,
      'circle-blur': 1.2,
      'circle-stroke-width': 0,
    },
  });

  // Main bar dot
  map.addLayer({
    id: 'bars-circle',
    type: 'circle',
    source: 'bars',
    paint: {
      'circle-radius': ['case',
        ['==', ['get', 'terrace'], 'yes'],    10,
        ['==', ['get', 'terrace'], 'likely'],  8,
                                               6,
      ],
      'circle-color': ['case',
        ['get', 'isNight'],       '#444866',
        ['get', 'inSunUnknown'],  '#5a6080',
        ['get', 'inSun'],         '#FFB800',
                                  '#4a5580',
      ],
      'circle-stroke-width': ['case',
        ['==', ['get', 'terrace'], 'yes'], 2.5, 1.5,
      ],
      'circle-stroke-color': ['case',
        ['get', 'inSun'], '#CC8000', '#333a5a',
      ],
      'circle-opacity': ['case',
        ['==', ['get', 'terrace'], 'yes'],    0.97,
        ['==', ['get', 'terrace'], 'likely'], 0.88,
                                              0.70,
      ],
    },
  });

  // Bar name label (only for confirmed terraces at high zoom)
  map.addLayer({
    id: 'bars-label',
    type: 'symbol',
    source: 'bars',
    filter: ['==', ['get', 'terrace'], 'yes'],
    minzoom: 15.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.4],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#FFB800',
      'text-halo-color': 'rgba(20,24,44,0.85)',
      'text-halo-width': 2,
    },
  });

  // Popup on click
  map.on('click', 'bars-circle', e => {
    const props = e.features[0].properties;
    const coords = e.features[0].geometry.coordinates.slice();
    new maplibregl.Popup({ maxWidth: '300px', className: 'bar-popup', offset: 10 })
      .setLngLat(coords)
      .setHTML(_buildPopupHtml(props))
      .addTo(map);
  });

  map.on('mouseenter', 'bars-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'bars-circle', () => { map.getCanvas().style.cursor = ''; });

  // Start pulsing glow
  _animateGlow();

  isMapReady = true;
  if (pendingBars) { _applyBars(pendingBars.features); pendingBars = null; }
}

// ─── Glow animation ────────────────────────────────────────────────────────

function _animateGlow() {
  const t = Date.now() / 800;
  const opacity = 0.08 + Math.abs(Math.sin(t)) * 0.22;
  const radius  = 16 + Math.abs(Math.sin(t)) * 8;

  if (map.getLayer('bars-glow')) {
    map.setPaintProperty('bars-glow', 'circle-opacity', opacity);
    map.setPaintProperty('bars-glow', 'circle-radius',  radius);
  }
  glowFrame = requestAnimationFrame(_animateGlow);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Render bars on the map based on active filters.
 * @returns {{ sunnyCount, shownCount }}
 */
function updateBarMarkers(bars, filters) {
  const { onlySunny, onlyOpen, minConfidence } = filters;
  let sunnyCount = 0, shownCount = 0;

  const features = [];
  for (const bar of bars) {
    const rank = CONFIDENCE_RANK[bar.terrace] ?? 1;
    if (rank === 0 || rank < minConfidence) continue;
    if (onlySunny && !bar.inSun) continue;
    if (onlyOpen  && bar.isOpen === false) continue;

    features.push(_barToFeature(bar));
    shownCount++;
    if (bar.inSun) sunnyCount++;
  }

  if (!isMapReady) {
    pendingBars = { features };
  } else {
    _applyBars(features);
  }

  return { sunnyCount, shownCount };
}

function _applyBars(features) {
  const src = map.getSource('bars');
  if (src) src.setData({ type: 'FeatureCollection', features });
}

function renderBuildings(_buildings) {
  // Visual 3D buildings are rendered natively by MapLibre from vector tiles.
  // The _buildings array is used only for sun/shadow calculation in sun.js.
}

function toggleBuildings(show) {
  if (!map || !isMapReady) return;
  const vis = show ? 'visible' : 'none';

  // Toggle our custom layer
  if (map.getLayer('building-3d-custom')) {
    map.setLayoutProperty('building-3d-custom', 'visibility', vis);
  }

  // Also toggle every building-related layer from the base style
  // (the liberty style renders buildings as fill + fill-extrusion layers)
  map.getStyle().layers.forEach(layer => {
    if (layer['source-layer'] === 'building') {
      map.setLayoutProperty(layer.id, 'visibility', vis);
    }
  });
}

/**
 * Compute and render shadow polygons for all buildings.
 * @param {Array}   buildings - from parseOsmBuildings()
 * @param {Object}  sunPos    - from getSunPosition()
 * @param {boolean} show      - whether the toggle is on
 */
function updateShadowOverlay(buildings, sunPos, show) {
  if (!isMapReady || !map.getSource('shadows')) return;

  if (!show || !buildings || buildings.length === 0 ||
      !sunPos.isUp || sunPos.altitudeDeg < 2) {
    map.getSource('shadows').setData(_emptyGeoJSON());
    return;
  }

  const features = [];
  for (const building of buildings) {
    const shadow = _computeShadowPolygon(building, sunPos);
    if (shadow) features.push(shadow);
  }

  map.getSource('shadows').setData({ type: 'FeatureCollection', features });
}

function _addHatchPattern() {
  if (map.hasImage('shadow-hatch')) return;

  // 14×14 px tile: semi-transparent dark-blue base + bright 45° diagonal stripe
  const sz  = 14;
  const cv  = document.createElement('canvas');
  cv.width  = sz;
  cv.height = sz;
  const ctx = cv.getContext('2d');

  // Base — slightly transparent dark blue
  ctx.fillStyle = 'rgba(18, 35, 130, 0.60)';
  ctx.fillRect(0, 0, sz, sz);

  // Diagonal lines at 45° (top-right → bottom-left direction)
  ctx.strokeStyle = 'rgba(110, 160, 255, 0.85)';
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'square';
  // Draw enough repetitions to fully cover the tile including wrap-around
  for (let offset = -sz; offset <= sz * 2; offset += 9) {
    ctx.beginPath();
    ctx.moveTo(offset,      0);
    ctx.lineTo(offset + sz, sz);
    ctx.stroke();
  }

  const data = ctx.getImageData(0, 0, sz, sz);
  map.addImage('shadow-hatch', { width: sz, height: sz, data: data.data });
}

function _computeShadowPolygon(building, sunPos) {
  // Shadow direction is OPPOSITE to sun bearing
  const shadowBearingDeg = (sunPos.bearing + 180) % 360;

  // Shadow length on the ground (metres): h / tan(alt). Cap at 300 m.
  const shadowLengthM = Math.min(
    building.height / Math.tan(sunPos.altitude),
    300
  );
  if (shadowLengthM < 1) return null;

  const shadowLengthKm = shadowLengthM / 1000;
  const origRing = building.polygon.geometry.coordinates[0];

  // Translate every vertex in the shadow direction
  const shadowRing = origRing.map(([lon, lat]) => {
    try {
      return turf.destination(
        turf.point([lon, lat]), shadowLengthKm, shadowBearingDeg
      ).geometry.coordinates;
    } catch { return [lon, lat]; }
  });

  // Convex hull of original + shadow vertices gives the full shadow footprint
  try {
    const allPts = [...origRing, ...shadowRing].map(c => turf.point(c));
    const hull = turf.convex(turf.featureCollection(allPts));
    return hull;   // may be null if all pts are collinear
  } catch {
    // Fallback: just the translated polygon
    try { return turf.polygon([shadowRing]); } catch { return null; }
  }
}

// ─── Data conversion ───────────────────────────────────────────────────────

function _barToFeature(bar) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [bar.lon, bar.lat] },
    properties: {
      id:            bar.id,
      name:          bar.name,
      amenity:       bar.amenity || 'bar',
      address:       bar.address || '',
      opening_hours: bar.opening_hours || '',
      phone:         bar.phone || '',
      website:       bar.website || '',
      terrace:       bar.terrace || 'maybe',
      inSun:         bar.inSun === true,
      inSunUnknown:  bar.inSun === null,
      isNight:       bar._isNight || false,
      isOpen:        bar.isOpen ?? null,
    },
  };
}

function _emptyGeoJSON() {
  return { type: 'FeatureCollection', features: [] };
}

// ─── Popup HTML ────────────────────────────────────────────────────────────

function _buildPopupHtml(p) {
  const isNight   = p.isNight;
  const isUnknown = p.inSunUnknown && !isNight;

  let sunBadge;
  if (isNight)        sunBadge = '<span class="status-night">🌙 Nacht</span>';
  else if (isUnknown) sunBadge = '<span class="status-night">⏳ Schaduw laden…</span>';
  else if (p.inSun)   sunBadge = '<span class="status-sun">☀️ Terras in de zon</span>';
  else                sunBadge = '<span class="status-shade">🌥 Terras in de schaduw</span>';

  const confidenceMap = {
    yes:    '✅ Zeker een terras',
    likely: '🟡 Waarschijnlijk terras',
    maybe:  '⚪ Misschien terras',
    no:     '❌ Geen terras',
  };
  const terraceBadge = `<span class="terrace-badge">${confidenceMap[p.terrace] || ''}</span>`;

  const amenityLabel = { bar:'Bar', pub:'Pub', cafe:'Café', restaurant:'Restaurant' }[p.amenity] || 'Bar';

  let html = `<div class="popup">
    <h3>${_esc(p.name)}</h3>
    <div class="popup-badges">${sunBadge}${terraceBadge}</div>
    <p class="address">${amenityLabel}${p.address ? ' · ' + _esc(p.address) : ''}</p>`;

  if (p.opening_hours) {
    const oh = p.opening_hours;
    const isOpen = isOpenNow(oh);
    html += `<p class="hours">${openLabel(isOpen, oh)} · ${_esc(oh)}</p>`;
  } else {
    html += `<p class="hours">🕐 Openingsuren onbekend</p>`;
  }

  if (p.phone)   html += `<p class="phone">📞 ${_esc(p.phone)}</p>`;
  if (p.website && p.website.startsWith('http')) {
    html += `<p class="website"><a href="${_esc(p.website)}" target="_blank" rel="noopener noreferrer">Website →</a></p>`;
  }

  html += '</div>';
  return html;
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
