// ─── Main application ──────────────────────────────────────────────────────

const CACHE_KEY_BARS      = 'mtz_bars_v3';
const CACHE_KEY_BUILDINGS = 'mtz_buildings_v3';
const CACHE_DURATION_MS   = 30 * 60 * 1000;
const SUN_UPDATE_MS       = 5 * 60 * 1000;

let allBars        = [];
let allBuildings   = [];
let buildingsReady = false;
let openFilter     = 'all'; // 'all' | 'open'

// ─── Init ──────────────────────────────────────────────────────────────────

async function init() {
  initMap();
  showLoading(true, 'Terrassen laden…');

  try {
    allBars = await loadBarsInstant();
    console.log(`${allBars.length} terrassen geladen (statisch)`);
  } catch (err) {
    console.error('Kon statische bars niet laden:', err);
  }

  runUpdate();
  showLoading(false);

  setInterval(tickClock, 1000);
  setInterval(runUpdate, SUN_UPDATE_MS);

  loadLiveDataInBackground();
}

// ─── Phase 1: instant bar loading ─────────────────────────────────────────

async function loadBarsInstant() {
  const cached = cacheGet(CACHE_KEY_BARS);
  if (cached) return cached;

  const [staticBars, manualBars] = await Promise.all([
    fetchStaticBars(),
    loadManualBars(),
  ]);
  return mergeBars(staticBars, manualBars);
}

// ─── Phase 2: background live refresh ─────────────────────────────────────

async function loadLiveDataInBackground() {
  fetchBuildingsBackground();

  try {
    if (!cacheGet(CACHE_KEY_BARS)) {
      const liveBars = await fetchBarsWithTerraces();
      if (liveBars) {
        const manualBars = await loadManualBars();
        const merged = mergeBars(liveBars, manualBars);
        cacheSet(CACHE_KEY_BARS, merged);
        allBars = merged;
        console.log(`${allBars.length} terrassen bijgewerkt via Overpass`);
        runUpdate();
      }
    }
  } catch (err) {
    console.warn('Live bar update mislukt:', err.message);
  }
}

async function fetchBuildingsBackground() {
  const cached = cacheGet(CACHE_KEY_BUILDINGS);
  if (cached) {
    allBuildings   = cached;
    buildingsReady = true;
    console.log(`${allBuildings.length} gebouwen uit cache`);
    runUpdate();
    return;
  }
  try {
    const buildings = await fetchBuildings();
    if (buildings && buildings.length > 0) {
      allBuildings   = buildings;
      buildingsReady = true;
      cacheSet(CACHE_KEY_BUILDINGS, buildings);
      console.log(`${allBuildings.length} gebouwen geladen`);
      runUpdate();
    }
  } catch (err) {
    console.warn('Gebouwen ophalen mislukt:', err.message);
  }
}

// ─── Filters ───────────────────────────────────────────────────────────────

function getFilters() {
  return {
    onlySunny:     document.getElementById('filter-sunny').checked,
    onlyOpen:      openFilter === 'open',
    minConfidence: parseInt(document.getElementById('filter-confidence').value, 10),
  };
}

// ─── Update loop ───────────────────────────────────────────────────────────

function runUpdate() {
  const now    = new Date();
  const sunPos = getSunPosition(now);
  const f      = getFilters();

  for (const bar of allBars) {
    bar._isNight = !sunPos.isUp;
    bar.isOpen   = isOpenNow(bar.opening_hours || null, now);

    if (!sunPos.isUp) {
      bar.inSun = false;
    } else if (buildingsReady) {
      bar.inSun = isTerraceInSun(bar, allBuildings, sunPos);
    } else {
      bar.inSun = null;
    }
  }

  const { sunnyCount, shownCount } = updateBarMarkers(allBars, f);
  updateInfoPanel(sunPos, sunnyCount, shownCount, now);
  updateSunCompass(sunPos);

  document.getElementById('last-updated').textContent =
    `Bijgewerkt om ${now.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── Sun compass ───────────────────────────────────────────────────────────

function updateSunCompass(sunPos) {
  const dot   = document.getElementById('sun-dot');
  const label = document.getElementById('sun-compass-label');
  if (!dot || !label) return;

  if (!sunPos.isUp) {
    // Night: place moon in centre
    dot.className = 'is-night';
    dot.style.left = '50%';
    dot.style.top  = '50%';
    label.textContent = '🌙 Nacht';
    return;
  }

  dot.className = '';

  // Convert bearing (compass, 0=N) + altitude to x,y inside the 100×100 inner circle.
  // r=1 at horizon, r=0 at zenith.
  // Centre of inner element = (50px, 50px). Usable radius = 42px.
  const altRad     = sunPos.altitude;            // radians
  const bearingRad = (sunPos.bearing * Math.PI) / 180;
  const r          = Math.cos(altRad);           // 1 at horizon, 0 at zenith
  const RADIUS_PX  = 42;

  const x = 50 + r * Math.sin(bearingRad) * RADIUS_PX;  // sin for E-W
  const y = 50 - r * Math.cos(bearingRad) * RADIUS_PX;  // cos for N-S, inverted Y

  dot.style.left = `${x}px`;
  dot.style.top  = `${y}px`;

  const dir = bearingToLabel(sunPos.bearing);
  label.textContent = `${dir} · ${Math.round(sunPos.altitudeDeg)}° hoogte`;
}

// ─── Data helpers ──────────────────────────────────────────────────────────

async function loadManualBars() {
  try {
    const res = await fetch('data/bars.json');
    if (!res.ok) return [];
    const arr = await res.json();
    return arr.map(b => ({
      ...b,
      terrace: b.terrace || (b.amenity === 'bar' || b.amenity === 'pub' ? 'likely' : 'maybe'),
      inSun: null, isOpen: null,
    }));
  } catch {
    return [];
  }
}

function mergeBars(primary, manual) {
  const result = [...primary];
  for (const m of manual) {
    const dup = primary.some(p => {
      try {
        return turf.distance(
          turf.point([p.lon, p.lat]),
          turf.point([m.lon, m.lat]),
          { units: 'meters' }
        ) < 40;
      } catch { return false; }
    });
    if (!dup) result.push({ ...m, source: m.source || 'manual' });
  }
  return result;
}

// ─── UI helpers ────────────────────────────────────────────────────────────

function tickClock() {
  const el = document.getElementById('current-time');
  if (el) el.textContent = new Date().toLocaleTimeString('nl-BE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function updateInfoPanel(sunPos, sunnyCount, shownCount, now) {
  document.getElementById('current-date').textContent =
    now.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' });

  const sunInfoEl = document.getElementById('sun-info');
  if (!sunPos.isUp) {
    sunInfoEl.textContent = '🌙 Zon staat onder de horizon';
    sunInfoEl.style.color = '#8891b4';
  } else {
    sunInfoEl.textContent = `☀️ ${Math.round(sunPos.altitudeDeg)}° hoogte · richting ${bearingToLabel(sunPos.bearing)}`;
    sunInfoEl.style.color = '';
  }

  const total       = allBars.length;
  const yesCount    = allBars.filter(b => b.terrace === 'yes').length;
  const likelyCount = allBars.filter(b => b.terrace === 'likely').length;
  const maybeCount  = allBars.filter(b => b.terrace === 'maybe').length;

  let sunLine = '';
  if (sunPos.isUp && buildingsReady) {
    sunLine = `<br><span class="count-sunny">☀️ ${sunnyCount} van ${shownCount} getoond in de zon</span>`;
  } else if (sunPos.isUp && !buildingsReady) {
    sunLine = `<br>Schaduwberekening laden…`;
  }

  document.getElementById('bar-counts').innerHTML =
    `<strong>${total}</strong> bars gevonden` +
    ` · <span title="Zeker terras">✅ ${yesCount}</span>` +
    ` · <span title="Waarschijnlijk">🟡 ${likelyCount}</span>` +
    ` · <span title="Misschien">⚪ ${maybeCount}</span>` +
    sunLine;
}

function showLoading(show, text) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.style.display = show ? 'flex' : 'none';
  if (text) { const t = document.getElementById('loading-text'); if (t) t.textContent = text; }
}

function updateSliderFill() {
  const slider = document.getElementById('filter-confidence');
  const val = parseInt(slider.value, 10);
  slider.style.setProperty('--pct', (val / 3 * 100) + '%');
  document.querySelectorAll('#confidence-labels span').forEach((el, i) => {
    el.style.color      = i === val ? 'var(--sun)' : '';
    el.style.fontWeight = i === val ? '700' : '';
  });
}

// ─── SessionStorage cache ──────────────────────────────────────────────────

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_DURATION_MS) return null;
    return data;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch { /* ITP or storage full — ignore */ }
}

// ─── Events ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  updateSliderFill();
  init();

  const refilter = () => { updateSliderFill(); runUpdate(); };

  document.getElementById('filter-confidence').addEventListener('input', refilter);
  document.getElementById('filter-sunny').addEventListener('change', refilter);
  document.getElementById('show-buildings').addEventListener('change', e => {
    toggleBuildings(e.target.checked);
  });

  // Open/all pill buttons
  document.querySelectorAll('.pill[data-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      openFilter = btn.dataset.open;
      document.querySelectorAll('.pill[data-open]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      runUpdate();
    });
  });
});
