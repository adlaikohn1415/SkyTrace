import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/+esm';

const els = {
  video: document.getElementById('camera'), canvas: document.getElementById('overlay'), status: document.getElementById('status'),
  startBtn: document.getElementById('startBtn'), permissionPanel: document.getElementById('permissionPanel'), settingsBtn: document.getElementById('settingsBtn'),
  settings: document.getElementById('settings'), closeSettings: document.getElementById('closeSettings'), typeFilter: document.getElementById('typeFilter'),
  minElev: document.getElementById('minElev'), minElevVal: document.getElementById('minElevVal'), maxLabels: document.getElementById('maxLabels'),
  maxLabelsVal: document.getElementById('maxLabelsVal'), pathLength: document.getElementById('pathLength'), nightMode: document.getElementById('nightMode'),
  showHorizon: document.getElementById('showHorizon'), demoFallback: document.getElementById('demoFallback'), refreshData: document.getElementById('refreshData')
};
const ctx = els.canvas.getContext('2d');

const state = {
  lat: null, lon: null, alt: 0, heading: 0, pitch: 0, roll: 0, satellites: [], lastFrame: 0,
  settings: { typeFilter:'visible', minElev:10, maxLabels:18, pathLength:60, nightMode:false, showHorizon:true, demoFallback:true }
};

const DEMO_TLES = `ISS (ZARYA)\n1 25544U 98067A   26166.54345833  .00010417  00000+0  19124-3 0  9995\n2 25544  51.6309 302.0739 0004536  88.8532  35.5270 15.49715391516409\nTIANGONG\n1 48274U 21035A   26165.91806713  .00022482  00000+0  24593-3 0  9991\n2 48274  41.4665 106.0421 0004521 239.1636 120.8744 15.62617386292576\nNOAA 19\n1 33591U 09005A   26165.75137037  .00000214  00000+0  13925-3 0  9990\n2 33591  99.1941 220.0243 0014051  90.6789 269.6024 14.12789143894901\nSTARLINK-30000\n1 70000U 23001A   26165.50000000  .00012000  00000+0  85000-3 0  9991\n2 70000  53.0000 180.0000 0001000  90.0000 270.0000 15.06390000 10000\nGPS BIIR-2\n1 24876U 97035A   26165.70500000  .00000034  00000+0  00000+0 0  9992\n2 24876  55.7000  85.0000 0100000  40.0000 320.0000  2.00560000123456`;

function parseTLE(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i+1]?.startsWith('1 ') && lines[i+2]?.startsWith('2 ')) {
      try {
        const name = lines[i].replace(/^0 /,'');
        out.push({ name, line1: lines[i+1], line2: lines[i+2], satrec: satellite.twoline2satrec(lines[i+1], lines[i+2]), kind: classify(name) });
      } catch {}
      i += 2;
    }
  }
  return out;
}
function classify(name) {
  const n = name.toLowerCase();
  if (n.includes('starlink')) return 'starlink';
  if (n.includes('iss') || n.includes('tiangong')) return 'stations';
  if (n.includes('noaa') || n.includes('meteor')) return 'weather';
  if (n.includes('gps') || n.includes('galileo') || n.includes('glonass')) return 'gps';
  return 'other';
}
async function loadSatellites() {
  els.status.textContent = 'Loading satellites…';
  try {
    const urls = [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle'
    ];
    const texts = await Promise.all(urls.map(u => fetch(u, {cache:'no-store'}).then(r => { if(!r.ok) throw new Error('fetch failed'); return r.text(); })));
    state.satellites = parseTLE(texts.join('\n'));
    localStorage.setItem('skytrace_tles', texts.join('\n'));
  } catch (e) {
    const cached = localStorage.getItem('skytrace_tles');
    state.satellites = parseTLE(cached || DEMO_TLES);
    if (!cached && !state.settings.demoFallback) state.satellites = [];
  }
  els.status.textContent = `${state.satellites.length} satellites loaded`;
}

async function start() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio:false });
    els.video.srcObject = stream;
    navigator.geolocation.watchPosition(p => { state.lat=p.coords.latitude; state.lon=p.coords.longitude; state.alt=p.coords.altitude || 0; }, err => { els.status.textContent = 'Location needed'; }, {enableHighAccuracy:true, maximumAge:2000});
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
    window.addEventListener('deviceorientation', onOrientation, true);
    els.permissionPanel.classList.add('hidden');
    await loadSatellites();
    requestAnimationFrame(draw);
  } catch (e) { els.status.textContent = 'Permission denied or unavailable'; }
}
function onOrientation(e) {
  state.heading = e.webkitCompassHeading ?? (360 - (e.alpha || 0));
  state.pitch = e.beta || 0;
  state.roll = e.gamma || 0;
}
function satAzEl(sat, date = new Date()) {
  if (state.lat == null || state.lon == null) return null;
  const gmst = satellite.gstime(date);
  const pv = satellite.propagate(sat.satrec, date);
  if (!pv.position) return null;
  const posGd = { longitude: satellite.degreesToRadians(state.lon), latitude: satellite.degreesToRadians(state.lat), height: state.alt / 1000 };
  const look = satellite.ecfToLookAngles(posGd, satellite.eciToEcf(pv.position, gmst));
  return { az: satellite.radiansToDegrees(look.azimuth), el: satellite.radiansToDegrees(look.elevation), range: look.rangeSat };
}
function matchesFilter(sat, el) {
  if (el < state.settings.minElev) return false;
  const f = state.settings.typeFilter;
  if (f === 'all') return true;
  if (f === 'visible') return sat.kind === 'stations' || sat.kind === 'starlink' || sat.kind === 'weather';
  return sat.kind === f;
}
function project(az, el) {
  const w = els.canvas.width, h = els.canvas.height;
  let relAz = ((az - state.heading + 540) % 360) - 180;
  const fovX = 62, fovY = 48;
  const centerEl = Math.max(-15, Math.min(85, 35 - state.pitch));
  const x = w/2 + (relAz / fovX) * w;
  const y = h/2 - ((el - centerEl) / fovY) * h;
  return {x,y,on:x>-120&&x<w+120&&y>-120&&y<h+120, relAz};
}
function draw(now) {
  resize();
  ctx.clearRect(0,0,els.canvas.width,els.canvas.height);
  if (state.settings.nightMode) { ctx.fillStyle='rgba(80,0,0,.22)'; ctx.fillRect(0,0,els.canvas.width,els.canvas.height); }
  if (state.settings.showHorizon) drawHorizon();
  const visible = [];
  for (const sat of state.satellites) {
    const p = satAzEl(sat); if (!p || !matchesFilter(sat, p.el)) continue;
    const screen = project(p.az, p.el); if (!screen.on) continue;
    visible.push({...sat, ...p, ...screen});
  }
  visible.sort((a,b)=>b.el-a.el);
  for (const sat of visible.slice(0,state.settings.maxLabels)) drawSatellite(sat);
  els.status.textContent = `${visible.length} in view • heading ${Math.round(state.heading)}°`;
  requestAnimationFrame(draw);
}
function drawHorizon() {
  const w=els.canvas.width,h=els.canvas.height;
  const y = project(state.heading,0).y;
  ctx.strokeStyle = state.settings.nightMode ? 'rgba(255,60,60,.55)' : 'rgba(120,220,255,.55)';
  ctx.lineWidth = 1.5; ctx.setLineDash([8,10]); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = ctx.strokeStyle; ctx.font='13px system-ui'; ctx.fillText('HORIZON', 16, y-8);
}
function drawSatellite(sat) {
  const night = state.settings.nightMode;
  const color = night ? '255,70,70' : sat.kind==='starlink' ? '255,212,92' : sat.kind==='stations' ? '112,255,186' : '122,205,255';
  if (state.settings.pathLength > 0) drawPath(sat, color);
  ctx.shadowColor = `rgba(${color},.9)`; ctx.shadowBlur = 14;
  ctx.fillStyle = `rgba(${color},.95)`; ctx.beginPath(); ctx.arc(sat.x, sat.y, 5, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  const label = sat.name.length > 22 ? sat.name.slice(0,21)+'…' : sat.name;
  const text = `${label}  ${Math.round(sat.el)}°`;
  ctx.font='600 13px system-ui'; const tw = ctx.measureText(text).width;
  ctx.fillStyle='rgba(0,0,0,.52)'; roundRect(ctx, sat.x+10, sat.y-24, tw+16, 25, 10); ctx.fill();
  ctx.fillStyle=`rgba(${color},.98)`; ctx.fillText(text, sat.x+18, sat.y-7);
}
function drawPath(sat, color) {
  ctx.strokeStyle = `rgba(${color},.58)`; ctx.lineWidth = 2; ctx.beginPath();
  for (let t=0; t<=state.settings.pathLength; t+=15) {
    const future = new Date(Date.now()+t*1000); const pos = satAzEl(sat, future); if (!pos) continue;
    const s = project(pos.az,pos.el); if (t===0) ctx.moveTo(s.x,s.y); else ctx.lineTo(s.x,s.y);
  }
  ctx.stroke();
}
function resize(){ const dpr=devicePixelRatio||1; const w=innerWidth*dpr,h=innerHeight*dpr; if(els.canvas.width!==w){els.canvas.width=w;els.canvas.height=h;ctx.setTransform(dpr,0,0,dpr,0,0);els.canvas.width=innerWidth;els.canvas.height=innerHeight;} }
function roundRect(ctx,x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
function bind() {
  els.startBtn.onclick=start; els.settingsBtn.onclick=()=>els.settings.classList.remove('hidden'); els.closeSettings.onclick=()=>els.settings.classList.add('hidden');
  for (const [id,key] of [['typeFilter','typeFilter'],['pathLength','pathLength']]) els[id].onchange=e=>{state.settings[key]=isNaN(+e.target.value)?e.target.value:+e.target.value};
  els.minElev.oninput=e=>{state.settings.minElev=+e.target.value;els.minElevVal.textContent=e.target.value+'°'};
  els.maxLabels.oninput=e=>{state.settings.maxLabels=+e.target.value;els.maxLabelsVal.textContent=e.target.value};
  els.nightMode.onchange=e=>state.settings.nightMode=e.target.checked; els.showHorizon.onchange=e=>state.settings.showHorizon=e.target.checked; els.demoFallback.onchange=e=>state.settings.demoFallback=e.target.checked;
  els.refreshData.onclick=loadSatellites;
}
bind();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
