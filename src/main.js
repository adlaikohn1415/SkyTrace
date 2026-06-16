import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/+esm';

const els = {
  video: document.getElementById('camera'),
  canvas: document.getElementById('overlay'),
  status: document.getElementById('status'),
  startBtn: document.getElementById('startBtn'),
  permissionPanel: document.getElementById('permissionPanel'),
  settingsBtn: document.getElementById('settingsBtn'),
  settings: document.getElementById('settings'),
  closeSettings: document.getElementById('closeSettings'),
  typeFilter: document.getElementById('typeFilter'),
  minElev: document.getElementById('minElev'),
  minElevVal: document.getElementById('minElevVal'),
  maxLabels: document.getElementById('maxLabels'),
  maxLabelsVal: document.getElementById('maxLabelsVal'),
  pathLength: document.getElementById('pathLength'),
  nightMode: document.getElementById('nightMode'),
  showHorizon: document.getElementById('showHorizon'),
  demoFallback: document.getElementById('demoFallback'),
  refreshData: document.getElementById('refreshData'),
  calibrateHorizon: document.getElementById('calibrateHorizon'),
  horizonOffset: document.getElementById('horizonOffset'),
  horizonOffsetVal: document.getElementById('horizonOffsetVal'),
  permissionDetails: document.getElementById('permissionDetails')
};
const ctx = els.canvas.getContext('2d');

const state = {
  lat: null,
  lon: null,
  alt: 0,
  heading: 0,
  pitch: 90,
  roll: 0,
  cameraOK: false,
  motionOK: false,
  locationOK: false,
  started: false,
  satellites: [],
  syntheticDemo: false,
  usingCachedData: false,
  usingDemoData: false,
  screenSats: [],
  aboveHorizonCount: 0,
  lastPositionUpdate: 0,
  lastDataLoadMessage: 'not loaded',
  settings: {
    typeFilter: 'all',
    minElev: 0,
    maxLabels: 18,
    pathLength: 60,
    nightMode: false,
    showHorizon: true,
    demoFallback: true,
    horizonOffset: 0,
    fovX: 78,
    fovY: 62
  }
};

// Local fallback is intentionally small and labeled as demo/cache only.
// Live data is fetched from CelesTrak when network/CORS allow it.
const DEMO_TLES = `ISS (ZARYA)
1 25544U 98067A   26166.54345833  .00010417  00000+0  19124-3 0  9995
2 25544  51.6309 302.0739 0004536  88.8532  35.5270 15.49715391516409
TIANGONG
1 48274U 21035A   26165.91806713  .00022482  00000+0  24593-3 0  9991
2 48274  41.4665 106.0421 0004521 239.1636 120.8744 15.62617386292576
NOAA 19
1 33591U 09005A   26165.75137037  .00000214  00000+0  13925-3 0  9990
2 33591  99.1941 220.0243 0014051  90.6789 269.6024 14.12789143894901
HUBBLE SPACE TELESCOPE
1 20580U 90037B   26165.90160880  .00006112  00000+0  31500-3 0  9997
2 20580  28.4696  79.4804 0002762 110.4549 249.6381 15.08700000200001
GPS BIIR-2
1 24876U 97035A   26165.70500000  .00000034  00000+0  00000+0 0  9992
2 24876  55.7000  85.0000 0100000  40.0000 320.0000  2.00560000123456`;

function setStatus(text) {
  els.status.textContent = text;
}

function setPermissionDetails(lines) {
  if (!els.permissionDetails) return;
  els.permissionDetails.innerHTML = lines.map(line => `<li>${escapeHtml(line)}</li>`).join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function classify(name, sourceGroup = '') {
  const n = name.toLowerCase();
  if (n.includes('starlink')) return 'starlink';
  if (n.includes('iss') || n.includes('zarya') || n.includes('tiangong')) return 'stations';
  if (n.includes('noaa') || n.includes('meteor') || n.includes('goes')) return 'weather';
  if (n.includes('gps') || n.includes('galileo') || n.includes('glonass') || n.includes('beidou')) return 'gps';
  if (sourceGroup === 'visual') return 'visible';
  return 'other';
}

function parseTLE(text, sourceGroup = 'unknown') {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let name = '';
    let line1 = '';
    let line2 = '';

    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      name = `SAT-${lines[i].slice(2, 7).trim()}`;
      line1 = lines[i];
      line2 = lines[i + 1];
      i += 1;
    } else if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      name = lines[i].replace(/^0 /, '').trim();
      line1 = lines[i + 1];
      line2 = lines[i + 2];
      i += 2;
    } else {
      continue;
    }

    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      if (!Number.isFinite(satrec.no)) continue;
      out.push({ name, line1, line2, satrec, kind: classify(name, sourceGroup), sourceGroup });
    } catch (err) {
      console.warn('Bad TLE skipped:', name, err);
    }
  }
  return out;
}

function dedupeSats(sats) {
  const seen = new Set();
  const out = [];
  for (const sat of sats) {
    const key = sat.line1.slice(2, 7) || sat.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sat);
  }
  return out;
}

async function fetchTextWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal, mode: 'cors' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSatellites() {
  setStatus('Loading satellite data…');
  state.syntheticDemo = false;
  state.usingCachedData = false;
  state.usingDemoData = false;
  state.lastDataLoadMessage = 'loading';

  const groups = [
    ['stations', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle'],
    ['visual', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle'],
    ['weather', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=weather&FORMAT=tle'],
    ['gps', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle'],
    ['starlink', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle']
  ];

  try {
    const chunks = [];
    for (const [group, url] of groups) {
      try {
        const text = await fetchTextWithTimeout(url);
        const parsed = parseTLE(text, group);
        chunks.push(...parsed);
      } catch (err) {
        console.warn(`CelesTrak ${group} failed:`, err);
      }
    }

    state.satellites = dedupeSats(chunks);
    if (!state.satellites.length) throw new Error('No live TLEs parsed');

    const cachePayload = JSON.stringify({ savedAt: Date.now(), tles: state.satellites.map(s => [s.name, s.line1, s.line2, s.sourceGroup]) });
    localStorage.setItem('skytrace_tles_v4', cachePayload);
    state.lastDataLoadMessage = `live: ${state.satellites.length} loaded`;
  } catch (liveError) {
    console.warn('Live TLE fetch failed; trying cache/demo:', liveError);
    const cached = localStorage.getItem('skytrace_tles_v4');
    if (cached) {
      try {
        const payload = JSON.parse(cached);
        state.satellites = dedupeSats(payload.tles.flatMap(([name, l1, l2, group]) => parseTLE(`${name}\n${l1}\n${l2}`, group || 'cache')));
        state.usingCachedData = true;
        state.lastDataLoadMessage = `cached: ${state.satellites.length} loaded`;
      } catch (err) {
        console.warn('Cache parse failed:', err);
        state.satellites = [];
      }
    }

    if (!state.satellites.length && state.settings.demoFallback) {
      state.satellites = parseTLE(DEMO_TLES, 'demo');
      state.usingDemoData = true;
      state.syntheticDemo = true;
      state.lastDataLoadMessage = 'demo mode: live data unavailable';
    }
  }

  updateSatellitePositions(true);
  setStatus(state.lastDataLoadMessage);
}

async function requestMotionPermissionFirst() {
  let orientation = 'not needed';
  let motion = 'not needed';

  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      orientation = await DeviceOrientationEvent.requestPermission();
    }
  } catch (err) {
    orientation = `error: ${err.name || 'unknown'}`;
  }

  try {
    if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
      motion = await DeviceMotionEvent.requestPermission();
    }
  } catch (err) {
    motion = `error: ${err.name || 'unknown'}`;
  }

  state.motionOK = (orientation === 'granted' || orientation === 'not needed');
  return { orientation, motion };
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable. Use the HTTPS GitHub Pages URL in Safari.');
  }

  const constraintsList = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    { video: true, audio: false }
  ];

  let lastError;
  for (const constraints of constraintsList) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      els.video.srcObject = stream;
      els.video.setAttribute('playsinline', 'true');
      els.video.muted = true;
      await els.video.play().catch(() => {});
      state.cameraOK = true;
      return stream;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Camera failed');
}

function startLocation() {
  if (!navigator.geolocation) {
    setStatus('Location unavailable');
    return;
  }

  navigator.geolocation.watchPosition(
    p => {
      state.lat = p.coords.latitude;
      state.lon = p.coords.longitude;
      state.alt = p.coords.altitude || 0;
      state.locationOK = true;
      updateSatellitePositions(true);
    },
    err => {
      console.warn('Location error:', err);
      state.locationOK = false;
      if (!state.started) setStatus('Location permission needed');
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 }
  );
}

async function start() {
  els.startBtn.disabled = true;
  els.startBtn.textContent = 'Starting…';
  setStatus('Requesting permissions…');
  setPermissionDetails(['Requesting motion/orientation…']);

  const motionResult = await requestMotionPermissionFirst();
  window.addEventListener('deviceorientation', onOrientation, true);
  window.addEventListener('deviceorientationabsolute', onOrientation, true);

  let cameraError = null;
  try {
    setPermissionDetails([
      `Orientation: ${motionResult.orientation}`,
      `Motion: ${motionResult.motion}`,
      'Requesting camera…'
    ]);
    await startCamera();
  } catch (err) {
    cameraError = err;
    console.error('Camera failed:', err);
  }

  startLocation();

  if (!state.cameraOK) {
    setStatus('Camera denied or unavailable');
    els.startBtn.disabled = false;
    els.startBtn.textContent = 'Try Again';
    setPermissionDetails([
      `Camera: ${cameraError?.name || 'failed'}`,
      `Orientation: ${motionResult.orientation}`,
      'Open the live GitHub Pages URL in Safari, not github.com.',
      'iPhone Settings → Safari → Camera → Allow can help if the prompt was denied.'
    ]);
    return;
  }

  els.permissionPanel.classList.add('hidden');
  state.started = true;
  setStatus('Camera active • loading satellites…');
  await loadSatellites();
  requestAnimationFrame(draw);
}

function onOrientation(e) {
  state.motionOK = true;

  if (typeof e.webkitCompassHeading === 'number') {
    state.heading = normalizeDegrees(e.webkitCompassHeading);
  } else if (typeof e.alpha === 'number') {
    // alpha is clockwise from north in some browsers but inverted in others; this is a useful fallback.
    state.heading = normalizeDegrees(360 - e.alpha);
  }

  if (typeof e.beta === 'number') state.pitch = e.beta;
  if (typeof e.gamma === 'number') state.roll = e.gamma;
}

function normalizeDegrees(v) {
  return ((v % 360) + 360) % 360;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function currentCenterElevationRaw() {
  // iOS portrait behavior: beta ≈ 90 when phone/camera points at the horizon,
  // beta ≈ 0 when the phone points straight up. Therefore center elevation ≈ 90 - beta.
  if (!state.motionOK || !Number.isFinite(state.pitch)) return 15;
  return clamp(90 - state.pitch, -45, 95);
}

function currentCenterElevation() {
  return clamp(currentCenterElevationRaw() + state.settings.horizonOffset, -45, 95);
}

function satAzEl(sat, date = new Date()) {
  if (state.lat == null || state.lon == null) return null;
  const pv = satellite.propagate(sat.satrec, date);
  if (!pv.position) return null;
  const gmst = satellite.gstime(date);
  const observerGd = {
    longitude: satellite.degreesToRadians(state.lon),
    latitude: satellite.degreesToRadians(state.lat),
    height: (state.alt || 0) / 1000
  };
  const positionEcf = satellite.eciToEcf(pv.position, gmst);
  const look = satellite.ecfToLookAngles(observerGd, positionEcf);
  return {
    az: normalizeDegrees(satellite.radiansToDegrees(look.azimuth)),
    el: satellite.radiansToDegrees(look.elevation),
    range: look.rangeSat
  };
}

function syntheticAzEl(index, date = new Date()) {
  const t = date.getTime() / 1000;
  const base = [15, 48, 82, 129, 174, 222, 268, 315, 342][index % 9];
  const speed = [0.07, 0.045, -0.055, 0.035, -0.04, 0.05, -0.035, 0.06, -0.025][index % 9];
  const az = normalizeDegrees(base + t * speed);
  const el = 12 + ((Math.sin(t / 27 + index * 0.9) + 1) / 2) * 58;
  return { az, el, range: 500 + index * 120 };
}

function matchesFilter(sat, el) {
  if (el < state.settings.minElev) return false;
  const f = state.settings.typeFilter;
  if (f === 'all') return true;
  if (f === 'visible') return sat.kind === 'stations' || sat.kind === 'starlink' || sat.kind === 'weather' || sat.kind === 'visible' || sat.sourceGroup === 'visual';
  return sat.kind === f || sat.sourceGroup === f;
}

function project(az, el) {
  const w = innerWidth;
  const h = innerHeight;
  const relAz = ((az - state.heading + 540) % 360) - 180;
  const centerEl = currentCenterElevation();
  const x0 = w / 2 + (relAz / state.settings.fovX) * w;
  const y0 = h / 2 - ((el - centerEl) / state.settings.fovY) * h;
  const { x, y } = rotateAroundCenter(x0, y0, -state.roll);
  return { x, y, on: x > -170 && x < w + 170 && y > -170 && y < h + 170, relAz };
}

function rotateAroundCenter(x, y, degrees) {
  if (!state.motionOK || !Number.isFinite(degrees)) return { x, y };
  const angle = degrees * Math.PI / 180;
  const cx = innerWidth / 2;
  const cy = innerHeight / 2;
  const dx = x - cx;
  const dy = y - cy;
  return {
    x: cx + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: cy + dx * Math.sin(angle) + dy * Math.cos(angle)
  };
}

function updateSatellitePositions(force = false) {
  const now = Date.now();
  if (!force && now - state.lastPositionUpdate < 500) return;
  state.lastPositionUpdate = now;

  const computed = [];
  let aboveHorizon = 0;

  if (state.syntheticDemo && (!state.satellites.length || state.usingDemoData)) {
    const demoNames = ['DEMO-ISS', 'DEMO-STARLINK', 'DEMO-NOAA', 'DEMO-HUBBLE', 'DEMO-GPS', 'DEMO-SAT-6', 'DEMO-SAT-7', 'DEMO-SAT-8', 'DEMO-SAT-9'];
    for (let i = 0; i < demoNames.length; i++) {
      const p = syntheticAzEl(i);
      if (p.el >= 0) aboveHorizon++;
      if (p.el < state.settings.minElev) continue;
      const screen = project(p.az, p.el);
      computed.push({ name: demoNames[i], kind: i === 0 ? 'stations' : i === 1 ? 'starlink' : 'visible', sourceGroup: 'demo', demoIndex: i, ...p, ...screen });
    }
  } else if (state.lat != null && state.lon != null) {
    for (const sat of state.satellites) {
      const p = satAzEl(sat);
      if (!p) continue;
      if (p.el >= 0) aboveHorizon++;
      if (!matchesFilter(sat, p.el)) continue;
      const screen = project(p.az, p.el);
      computed.push({ ...sat, ...p, ...screen });
    }
  }

  computed.sort((a, b) => {
    const ao = a.on ? 1 : 0;
    const bo = b.on ? 1 : 0;
    if (bo !== ao) return bo - ao;
    return b.el - a.el;
  });

  state.aboveHorizonCount = aboveHorizon;
  state.screenSats = computed;
}

function draw() {
  resize();
  updateSatellitePositions();
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  if (state.settings.nightMode) {
    ctx.fillStyle = 'rgba(80,0,0,.22)';
    ctx.fillRect(0, 0, innerWidth, innerHeight);
  }

  if (state.settings.showHorizon) drawHorizon();

  const onScreen = state.screenSats.filter(s => s.on);
  const labels = onScreen.slice(0, state.settings.maxLabels);
  for (const sat of labels) drawSatellite(sat);

  // If satellites exist above the horizon but are outside the camera view, draw small edge arrows.
  if (labels.length < 3) {
    const offscreen = state.screenSats.filter(s => !s.on).slice(0, 8);
    for (const sat of offscreen) drawEdgeArrow(sat);
  }

  const bits = [];
  bits.push(`${labels.length} on screen`);
  bits.push(`${state.aboveHorizonCount} above horizon`);
  bits.push(`${state.satellites.length} loaded`);
  if (state.usingCachedData) bits.push('cache');
  if (state.usingDemoData || state.syntheticDemo) bits.push('demo');
  if (!state.locationOK && !state.syntheticDemo) bits.push('location waiting');
  if (!state.motionOK) bits.push('motion waiting');
  setStatus(bits.join(' • '));
  requestAnimationFrame(draw);
}

function drawHorizon() {
  const w = innerWidth;
  const h = innerHeight;
  const centerEl = currentCenterElevation();
  const y = h / 2 + (centerEl / state.settings.fovY) * h;
  const night = state.settings.nightMode;
  const color = night ? 'rgba(255,70,70,.62)' : 'rgba(120,220,255,.62)';

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.setLineDash([8, 10]);

  const clampedY = clamp(y, -80, h + 80);
  ctx.translate(w / 2, clampedY);
  ctx.rotate((-state.roll) * Math.PI / 180);
  ctx.beginPath();
  ctx.moveTo(-w * 1.3, 0);
  ctx.lineTo(w * 1.3, 0);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '700 12px system-ui';
  ctx.fillText(y < -60 ? 'HORIZON ABOVE' : y > h + 60 ? 'HORIZON BELOW' : 'HORIZON', -w / 2 + 18, -10);
  ctx.restore();
}

function drawSatellite(sat) {
  const night = state.settings.nightMode;
  const color = night ? '255,70,70' : sat.kind === 'starlink' ? '255,212,92' : sat.kind === 'stations' ? '112,255,186' : sat.kind === 'gps' ? '180,150,255' : '122,205,255';

  if (state.settings.pathLength > 0) drawPath(sat, color);

  ctx.shadowColor = `rgba(${color},.9)`;
  ctx.shadowBlur = 14;
  ctx.fillStyle = `rgba(${color},.95)`;
  ctx.beginPath();
  ctx.arc(sat.x, sat.y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  const label = sat.name.length > 22 ? sat.name.slice(0, 21) + '…' : sat.name;
  const text = `${label}  ${Math.round(sat.el)}°`;
  ctx.font = '700 13px system-ui';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,.58)';
  roundRect(ctx, sat.x + 10, sat.y - 25, tw + 17, 26, 10);
  ctx.fill();
  ctx.fillStyle = `rgba(${color},.98)`;
  ctx.fillText(text, sat.x + 18, sat.y - 8);
}

function drawPath(sat, color) {
  ctx.strokeStyle = `rgba(${color},.55)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (let t = 0; t <= state.settings.pathLength; t += 15) {
    let pos;
    if (sat.sourceGroup === 'demo' && Number.isInteger(sat.demoIndex)) {
      pos = syntheticAzEl(sat.demoIndex, new Date(Date.now() + t * 1000));
    } else {
      pos = satAzEl(sat, new Date(Date.now() + t * 1000));
    }
    if (!pos) continue;
    const s = project(pos.az, pos.el);
    if (!started) {
      ctx.moveTo(s.x, s.y);
      started = true;
    } else {
      ctx.lineTo(s.x, s.y);
    }
  }
  if (started) ctx.stroke();
}

function drawEdgeArrow(sat) {
  const w = innerWidth;
  const h = innerHeight;
  const margin = 24;
  const cx = w / 2;
  const cy = h / 2;
  const dx = sat.x - cx;
  const dy = sat.y - cy;
  const angle = Math.atan2(dy, dx);
  const x = clamp(cx + Math.cos(angle) * Math.min(w / 2 - margin, Math.abs(dx)), margin, w - margin);
  const y = clamp(cy + Math.sin(angle) * Math.min(h / 2 - margin, Math.abs(dy)), margin + 50, h - margin);
  const color = state.settings.nightMode ? 'rgba(255,70,70,.75)' : 'rgba(170,230,255,.75)';

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(-7, -6);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-7, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(innerWidth * dpr);
  const h = Math.round(innerHeight * dpr);
  if (els.canvas.width !== w || els.canvas.height !== h) {
    els.canvas.width = w;
    els.canvas.height = h;
    els.canvas.style.width = `${innerWidth}px`;
    els.canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bind() {
  els.startBtn.onclick = start;
  els.settingsBtn.onclick = () => els.settings.classList.remove('hidden');
  els.closeSettings.onclick = () => els.settings.classList.add('hidden');

  for (const [id, key] of [['typeFilter', 'typeFilter'], ['pathLength', 'pathLength']]) {
    els[id].onchange = e => {
      state.settings[key] = isNaN(+e.target.value) ? e.target.value : +e.target.value;
      updateSatellitePositions(true);
    };
  }

  els.minElev.oninput = e => {
    state.settings.minElev = +e.target.value;
    els.minElevVal.textContent = e.target.value + '°';
    updateSatellitePositions(true);
  };
  els.maxLabels.oninput = e => {
    state.settings.maxLabels = +e.target.value;
    els.maxLabelsVal.textContent = e.target.value;
  };
  els.horizonOffset.oninput = e => {
    state.settings.horizonOffset = +e.target.value;
    els.horizonOffsetVal.textContent = e.target.value + '°';
    updateSatellitePositions(true);
  };
  els.nightMode.onchange = e => state.settings.nightMode = e.target.checked;
  els.showHorizon.onchange = e => state.settings.showHorizon = e.target.checked;
  els.demoFallback.onchange = e => state.settings.demoFallback = e.target.checked;
  els.refreshData.onclick = loadSatellites;
  els.calibrateHorizon.onclick = () => {
    const offset = clamp(-currentCenterElevationRaw(), -30, 30);
    state.settings.horizonOffset = offset;
    els.horizonOffset.value = String(Math.round(offset));
    els.horizonOffsetVal.textContent = `${Math.round(offset)}°`;
    updateSatellitePositions(true);
  };
}

bind();
resize();
setPermissionDetails([
  'Camera: not started',
  'Orientation: not started',
  'Location: not started'
]);
setStatus('Ready');

if ('serviceWorker' in navigator) {
  const swUrl = new URL('./sw.js', import.meta.url);
  navigator.serviceWorker.register(swUrl).catch(err => console.warn('SW failed:', err));
}
