/**
 * app.js — Smart Venue Assistant
 * Main application controller
 *
 * Real Google Service integrations:
 *   - Firebase Auth → Google Sign-In (user identity + ticket binding)
 *   - Firebase Realtime DB → Live crowd data (via crowd.js)
 *   - Gemini 2.0 Flash → Function calling AI concierge (via gemini.js)
 *   - Google Maps JS API → Real venue navigation (initGoogleMap callback)
 *   - CricAPI → Live cricket scores
 */

/* =====================================================
   STATE
   ===================================================== */
const state = {
  activeTab: 'dashboard',
  accessibilityMode: false,
  crowdAlertsEnabled: true,
  mapFilter: 'all',
  chatLoading: false,
  scoreInterval: null,
  user: null,          // Firebase Auth user
  googleMap: null,     // Google Maps instance
};

const scoreState = { mi: 186, csk: 142, over: 16, ball: 3 };

/* =====================================================
   INIT
   ===================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await crowdEngine.init();
    updateDataSourceBadge();
    renderDashboard();
    renderHeatmap();
    renderFood();
    renderNavTips();
    renderNearestFacilities();
    initChat();
    initVenueDiagram();
    startScoreSimulation();
    fetchAndUpdateScore(); // Try live score immediately

    // Register crowd engine updates
    crowdEngine.onUpdate((data) => {
      if (state.activeTab === 'dashboard') renderDashboard();
      if (state.activeTab === 'heatmap')   renderHeatmap();
      if (state.activeTab === 'food')      renderFood();
      updateStatCards();
      updateDataSourceBadge();
    });

    // Start live updates every 30 seconds (simulation fallback)
    crowdEngine.startLive(30000);

    // Refresh live score every 2 minutes
    setInterval(fetchAndUpdateScore, 120000);

    // Register PWA service worker
    registerServiceWorker();

    // Init Firebase Auth
    initFirebaseAuth();

    showToast('🏟️ ArenaMax Stadium — Live data loaded!', 'info');

    // Alert button
    document.getElementById('alertToggleBtn').addEventListener('click', () => {
      switchTab('dashboard');
      document.getElementById('alertsStack')?.scrollIntoView({ behavior: 'smooth' });
    });

    // Chat enter key
    document.getElementById('chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

  } catch (err) {
    console.error('App init failed:', err);
    showToast('⚠️ Could not load venue data. Please refresh.', 'warning');
  }
});

/* =====================================================
   TAB ROUTING
   ===================================================== */
function switchTab(tabId) {
  state.activeTab = tabId;

  // Desktop tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active);
  });

  // Bottom nav buttons
  document.querySelectorAll('.bnav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Panels
  document.querySelectorAll('.section-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tabId}`);
  });

  // Lazy render on first visit
  if (tabId === 'heatmap') renderHeatmap();
  if (tabId === 'food') renderFood();
  if (tabId === 'navigate') { renderNavTips(); updateVenueDiagram(); }
}

// Wire tab buttons
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* =====================================================
   DASHBOARD
   ===================================================== */
function renderDashboard() {
  const d = crowdEngine.data;
  if (!d) return;

  renderAlerts(d.alerts);
  renderGates(d.gates);
  renderRestrooms(d.restrooms);
  updateStatCards();
}

function updateStatCards() {
  const d = crowdEngine.data;
  if (!d) return;

  const openGates = d.gates.filter(g => g.density < 0.6).length;
  const avgWait = Math.round(d.concessions.reduce((s, c) => s + c.waitMin, 0) / d.concessions.length);
  const densityPct = Math.round(crowdEngine.getOverallDensity() * 100);
  const freeParking = d.parking.reduce((s, p) => s + p.available, 0);

  setText('statOpenGates', openGates);
  setText('statAvgWait', avgWait);
  setText('statCrowd', densityPct + '%');
  setText('statParking', freeParking.toLocaleString());
}

function renderAlerts(alerts) {
  const el = document.getElementById('alertsStack');
  if (!el || !alerts) return;

  el.innerHTML = alerts.map(a => {
    const icons = { crowd: '⚠️', info: 'ℹ️', weather: '🌤️', danger: '🚨' };
    return `
    <div class="alert-item ${a.severity}" role="alert">
      <span class="alert-item-icon" aria-hidden="true">${icons[a.type] || 'ℹ️'}</span>
      <div class="alert-item-body">
        <div class="alert-item-msg">${escHtml(a.message)}</div>
        <div class="alert-item-time">⏱ ${escHtml(a.time)}</div>
      </div>
    </div>`;
  }).join('');
}

function renderGates(gates) {
  const el = document.getElementById('gatesGrid');
  if (!el || !gates) return;

  el.innerHTML = gates.map(g => {
    const pct = Math.round(g.density * 100);
    const cls = g.density < 0.5 ? 'green' : g.density < 0.75 ? 'amber' : 'red';
    const icon = g.density < 0.5 ? '🟢' : g.density < 0.75 ? '🟡' : '🔴';
    const badgeCls = g.density < 0.5 ? 'wb-green' : g.density < 0.75 ? 'wb-amber' : 'wb-red';
    const fiCls = g.density < 0.5 ? 'fi-green' : g.density < 0.75 ? 'fi-amber' : 'fi-red';
    const pfCls = g.density < 0.5 ? 'pf-green' : g.density < 0.75 ? 'pf-amber' : 'pf-red';

    return `
    <div class="facility-item" onclick="navigateToGate('${g.id}')" 
         role="button" tabindex="0" aria-label="${g.name}: ${g.status}, ${g.queue} minute wait"
         onkeydown="if(event.key==='Enter') navigateToGate('${g.id}')">
      <div class="facility-icon ${fiCls}" aria-hidden="true">🚪</div>
      <div class="facility-info">
        <div class="facility-name">${escHtml(g.name)}</div>
        <div class="facility-sub">Capacity: ${pct}%</div>
        <div class="progress-wrap">
          <div class="progress-bar">
            <div class="progress-fill ${pfCls}" style="width:${pct}%" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
        </div>
      </div>
      <div class="facility-right">
        <div class="wait-badge ${badgeCls}">${icon} ~${g.queue} min</div>
        <div style="font-size:0.68rem;color:var(--text-muted);margin-top:4px;text-align:right;">${g.status.toUpperCase()}</div>
      </div>
    </div>`;
  }).join('');
}

function renderRestrooms(restrooms) {
  const el = document.getElementById('restroomsGrid');
  if (!el || !restrooms) return;

  el.innerHTML = restrooms.map(r => {
    const badgeCls = r.waitMin <= 3 ? 'wb-green' : r.waitMin <= 9 ? 'wb-amber' : 'wb-red';
    const fiCls     = r.waitMin <= 3 ? 'fi-green' : r.waitMin <= 9 ? 'fi-amber' : 'fi-red';
    const icon      = r.waitMin <= 3 ? '✅' : r.waitMin <= 9 ? '⚠️' : '🔴';

    return `
    <div class="facility-item" role="article" aria-label="${r.name}: ${r.capacity}">
      <div class="facility-icon ${fiCls}" aria-hidden="true">🚻</div>
      <div class="facility-info">
        <div class="facility-name">${escHtml(r.name)}</div>
        <div class="facility-sub">${escHtml(r.zone)} Zone · ${r.capacity}</div>
      </div>
      <div class="facility-right">
        <div class="wait-badge ${badgeCls}">${icon} ${r.waitMin === 0 ? 'No wait' : `~${r.waitMin} min`}</div>
      </div>
    </div>`;
  }).join('');
}

/* =====================================================
   HEAT MAP
   ===================================================== */
function renderHeatmap() {
  const d = crowdEngine.data;
  if (!d) return;

  renderHeatmapSVG(d.zones);
  renderZoneList(d.zones);
}

function renderHeatmapSVG(zones) {
  const wrap = document.getElementById('heatmapSvgWrap');
  if (!wrap) return;

  // Stadium shape SVG — top-down oval view
  const zoneConfigs = [
    { id: 'Z1', cx: 300, cy: 80,  rx: 220, ry: 55,  label: 'North Stand'  },
    { id: 'Z2', cx: 520, cy: 250, rx: 55,  ry: 150, label: 'East Stand'   },
    { id: 'Z3', cx: 300, cy: 420, rx: 220, ry: 55,  label: 'South Stand'  },
    { id: 'Z4', cx: 80,  cy: 250, rx: 55,  ry: 150, label: 'West Stand'   },
    { id: 'Z5', cx: 300, cy: 250, rx: 140, ry: 120, label: 'Center Field' },
  ];

  const zoneData = {};
  zones.forEach(z => zoneData[z.id] = z);

  const svgContent = `
  <svg viewBox="0 0 600 500" class="venue-svg" role="img" aria-label="Stadium crowd density heat map">
    <defs>
      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <radialGradient id="fieldGrad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" style="stop-color:#14532d;stop-opacity:0.8"/>
        <stop offset="100%" style="stop-color:#166534;stop-opacity:0.6"/>
      </radialGradient>
    </defs>

    <!-- Background -->
    <rect width="600" height="500" fill="rgba(15,15,45,0.4)" rx="12"/>

    <!-- Stands -->
    ${zoneConfigs.map(zc => {
      const z = zoneData[zc.id];
      const opacity = z ? 0.55 + z.density * 0.35 : 0.5;
      const color = z ? z.color : '#6b7280';
      const pct = z ? Math.round(z.density * 100) : '?';
      return `
      <ellipse
        cx="${zc.cx}" cy="${zc.cy}" rx="${zc.rx}" ry="${zc.ry}"
        fill="${color}" opacity="${opacity}"
        class="zone-path"
        data-zone="${zc.id}"
        onmouseenter="showZoneTooltip(event, '${zc.id}')"
        onmouseleave="hideZoneTooltip()"
        onclick="showZoneTooltip(event, '${zc.id}')"
        aria-label="${zc.label}: ${pct}% crowd density"
        role="button" tabindex="0"
        style="stroke:${color};filter:drop-shadow(0 0 8px ${color}44)"
      />
      <text x="${zc.cx}" y="${zc.cy - 4}" text-anchor="middle" class="zone-label">${zc.label}</text>
      <text x="${zc.cx}" y="${zc.cy + 12}" text-anchor="middle" class="zone-sublabel">${pct}%</text>
      `;
    }).join('')}

    <!-- Pitch / Center -->
    <ellipse cx="300" cy="250" rx="80" ry="60" fill="url(#fieldGrad)" stroke="#22c55e" stroke-width="1" stroke-opacity="0.4"/>
    <text x="300" y="255" text-anchor="middle" style="fill:#4ade80;font-size:10px;font-weight:700;">PITCH</text>

    <!-- Gate Indicators -->
    <circle cx="300" cy="28"  r="8" fill="#6366f1" filter="url(#glow)"/><text x="300" y="32" text-anchor="middle" style="fill:#fff;font-size:7px;font-weight:700">A</text>
    <circle cx="572" cy="250" r="8" fill="#6366f1" filter="url(#glow)"/><text x="572" y="254" text-anchor="middle" style="fill:#fff;font-size:7px;font-weight:700">B</text>
    <circle cx="300" cy="472" r="8" fill="#6366f1" filter="url(#glow)"/><text x="300" y="476" text-anchor="middle" style="fill:#fff;font-size:7px;font-weight:700">C</text>
    <circle cx="28"  cy="250" r="8" fill="#6366f1" filter="url(#glow)"/><text x="28"  y="254" text-anchor="middle" style="fill:#fff;font-size:7px;font-weight:700">D</text>
  </svg>`;

  wrap.innerHTML = svgContent;
}

function renderZoneList(zones) {
  const el = document.getElementById('zonesGrid');
  if (!el || !zones) return;

  el.innerHTML = zones.map(z => {
    const pct = Math.round(z.density * 100);
    const badgeCls = z.density < 0.5 ? 'wb-green' : z.density < 0.75 ? 'wb-amber' : 'wb-red';
    const fiCls    = z.density < 0.5 ? 'fi-green' : z.density < 0.75 ? 'fi-amber' : 'fi-red';
    const pfCls    = z.density < 0.5 ? 'pf-green' : z.density < 0.75 ? 'pf-amber' : 'pf-red';

    return `
    <div class="facility-item" role="article" aria-label="${z.name}: ${pct}% capacity">
      <div class="facility-icon ${fiCls}" aria-hidden="true">🏟️</div>
      <div class="facility-info">
        <div class="facility-name">${escHtml(z.name)}</div>
        <div class="facility-sub">${escHtml(z.section)}</div>
        <div class="progress-wrap" style="margin-top:6px;">
          <div class="progress-bar">
            <div class="progress-fill ${pfCls}" style="width:${pct}%" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
          </div>
        </div>
      </div>
      <div class="facility-right">
        <div class="wait-badge ${badgeCls}">${pct}%</div>
      </div>
    </div>`;
  }).join('');
}

/* Zone tooltip */
function showZoneTooltip(event, zoneId) {
  const d = crowdEngine.data;
  if (!d) return;
  const zone = d.zones.find(z => z.id === zoneId);
  if (!zone) return;

  const tt = document.getElementById('zoneTooltip');
  const pct = Math.round(zone.density * 100);
  const status = pct < 50 ? '🟢 Low — comfortable' : pct < 75 ? '🟡 Moderate — busy' : '🔴 High — crowded';

  tt.innerHTML = `
    <div class="tooltip-name">${escHtml(zone.name)}</div>
    <div class="tooltip-row"><span>Section</span><span class="tooltip-val">${escHtml(zone.section)}</span></div>
    <div class="tooltip-row"><span>Density</span><span class="tooltip-val">${pct}%</span></div>
    <div class="tooltip-row"><span>Status</span><span class="tooltip-val">${status}</span></div>
  `;

  const x = Math.min(event.clientX + 14, window.innerWidth - 180);
  const y = Math.min(event.clientY - 10, window.innerHeight - 120);
  tt.style.left = x + 'px';
  tt.style.top  = y + 'px';
  tt.classList.add('visible');
  tt.setAttribute('aria-hidden', 'false');
}
function hideZoneTooltip() {
  const tt = document.getElementById('zoneTooltip');
  tt.classList.remove('visible');
  tt.setAttribute('aria-hidden', 'true');
}

/* =====================================================
   FOOD
   ===================================================== */
function renderFood() {
  const d = crowdEngine.data;
  if (!d) return;
  filterConcessions();
  renderParkingCards(d.parking);
}

function filterConcessions() {
  const d = crowdEngine.data;
  if (!d) return;
  const filter = document.getElementById('foodFilter')?.value || 'all';
  const items = filter === 'all' ? d.concessions : d.concessions.filter(c => c.category === filter);

  const el = document.getElementById('concessionGrid');
  if (!el) return;

  el.innerHTML = items.map(c => {
    const badgeCls = c.waitMin <= 5 ? 'wb-green' : c.waitMin <= 15 ? 'wb-amber' : 'wb-red';
    const catIcon = { food: '🍔', beverages: '🥤', merchandise: '👕' }[c.category] || '🛍️';

    return `
    <div class="concession-card" role="article" aria-label="${c.name}: ${c.waitMin} minute wait">
      <div class="cc-top">
        <div>
          <div class="cc-name">${catIcon} ${escHtml(c.name)}</div>
          <div class="cc-zone">📍 ${escHtml(c.zone)} Zone</div>
        </div>
        <div class="wait-badge ${badgeCls}">~${c.waitMin} min</div>
      </div>
      <div class="cc-items">
        ${c.items.map(item => `<span class="cc-item-tag">${escHtml(item)}</span>`).join('')}
      </div>
      <div class="cc-footer">
        <span style="font-size:0.72rem;color:var(--text-muted);">${c.category}</span>
        ${c.category !== 'merchandise' ? `<button class="order-btn" onclick="showToast('🍽️ ${escHtml(c.name)} — table ordering coming soon!', 'info')" aria-label="Order from ${c.name}">Order</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderParkingCards(parking) {
  if (!document.getElementById('panel-food').classList.contains('active')) return;
  // Parking shown on navigate panel mostly — could add here too
}

/* =====================================================
   NAVIGATION
   ===================================================== */
function setMapFilter(filter, btn) {
  state.mapFilter = filter;
  document.querySelectorAll('.map-ctrl-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  updateVenueDiagram();
}

function initVenueDiagram() {
  updateVenueDiagram();
}

function updateVenueDiagram() {
  const el = document.getElementById('venueDiagram');
  if (!el) return;

  const d = crowdEngine.data;
  if (!d) return;

  const filter = state.mapFilter;

  let html = `<div style="background:var(--bg-card);border:1px solid var(--border-light);border-radius:var(--radius-lg);padding:16px;margin-top:0;">
    <div style="text-align:center;font-size:0.75rem;color:var(--text-muted);margin-bottom:12px;">📍 ArenaMax Stadium — Interactive Facility Map</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">`;

  const showGates      = filter === 'all' || filter === 'gates';
  const showFood       = filter === 'all' || filter === 'food';
  const showRestroom   = filter === 'all' || filter === 'restroom';
  const showMedical    = filter === 'all' || filter === 'medical';
  const showParking    = filter === 'all' || filter === 'parking';

  if (showGates) {
    d.gates.forEach(g => {
      const cls = g.density < 0.5 ? '#22c55e' : g.density < 0.75 ? '#f59e0b' : '#ef4444';
      html += `<div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:13px;">🚪 <strong>${g.name}</strong></div>
        <div style="font-size:11px;color:${cls};margin-top:2px;">Queue: ~${g.queue} min</div>
      </div>`;
    });
  }
  if (showFood) {
    d.concessions.forEach(c => {
      html += `<div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:13px;">🍔 <strong>${c.name}</strong></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${c.zone} · ~${c.waitMin} min</div>
      </div>`;
    });
  }
  if (showRestroom) {
    d.restrooms.forEach(r => {
      const cl = r.waitMin <= 3 ? '#22c55e' : r.waitMin <= 9 ? '#f59e0b' : '#ef4444';
      html += `<div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:13px;">🚻 <strong>${r.name}</strong></div>
        <div style="font-size:11px;color:${cl};margin-top:2px;">${r.waitMin === 0 ? 'No wait' : `~${r.waitMin} min`}</div>
      </div>`;
    });
  }
  if (showMedical) {
    d.medicalPosts?.forEach(m => {
      html += `<div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:13px;">🏥 <strong>${m.name}</strong></div>
        <div style="font-size:11px;color:#22c55e;margin-top:2px;">${m.zone} Zone · Available</div>
      </div>`;
    });
  }
  if (showParking) {
    d.parking.forEach(p => {
      const pctUsed = 1 - p.available / p.total;
      const cl = pctUsed < 0.5 ? '#22c55e' : pctUsed < 0.85 ? '#f59e0b' : '#ef4444';
      html += `<div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06);">
        <div style="font-size:13px;">🅿️ <strong>${p.name}</strong></div>
        <div style="font-size:11px;color:${cl};margin-top:2px;">${p.available > 0 ? p.available + ' spots · ' + p.distance : 'FULL'}</div>
      </div>`;
    });
  }

  html += '</div></div>';
  el.innerHTML = html;
}

function renderNavTips() {
  const el = document.getElementById('navTipsGrid');
  if (!el) return;

  const tips = [
    { icon: '🚪', title: 'Gate Recommendation', sub: 'Gate A (North) has shortest queue right now' },
    { icon: '♿', title: 'Accessibility Entrance', sub: 'Gate D has dedicated accessible lanes & ramps' },
    { icon: '🧭', title: 'Your Seat Route', sub: 'East Stand → Escalator B → Upper Tier Level 3' },
    { icon: '🚗', title: 'Parking Exit Route', sub: 'After match: Use North exit to avoid South gridlock' },
    { icon: '🚇', title: 'Metro Access', sub: 'Stadium Metro Station → Line 2 (Blue) → City Center' },
    { icon: '🚕', title: 'Cab Pickup Zone', sub: 'Designated pickup at Gate D — Gate C is restricted' },
  ];

  el.innerHTML = tips.map(t => `
    <div class="facility-item" role="article">
      <div class="facility-icon fi-sky" aria-hidden="true">${t.icon}</div>
      <div class="facility-info">
        <div class="facility-name">${escHtml(t.title)}</div>
        <div class="facility-sub">${escHtml(t.sub)}</div>
      </div>
    </div>
  `).join('');
}

/* Navigate to gate — integrates with map */
function navigateToGate(gateId) {
  showToast(`🗺️ Navigating to Gate ${gateId}...`, 'info');
  switchTab('navigate');
}

/* Navigate to seat */
function navigateToSeat() {
  showToast('🧭 Route to East Stand · Row 14 · Seat 22 — follow the purple guide signs on Level 2!', 'info');
  switchTab('navigate');
}

/* =====================================================
   NEAREST TO SEAT
   ===================================================== */
function renderNearestFacilities() {
  const el = document.getElementById('nearestGrid');
  if (!el) return;

  // Hard-coded relative to East Stand seat
  const items = [
    { icon: '🍔', title: 'Burger Hub', sub: 'North Zone · ~5 min walk · 5 min queue', color: 'fi-amber' },
    { icon: '🚻', title: 'Restroom East B', sub: 'Level 2 · 8 min wait', color: 'fi-sky' },
    { icon: '🥤', title: 'Refresh Bar', sub: 'West Zone · ~7 min walk · 3 min queue', color: 'fi-green' },
    { icon: '🏥', title: 'Medical Bay North', sub: 'Near Gate A · Always staffed', color: 'fi-red' },
  ];

  el.innerHTML = items.map(i => `
    <div class="facility-item" role="article">
      <div class="facility-icon ${i.color}" aria-hidden="true">${i.icon}</div>
      <div class="facility-info">
        <div class="facility-name">${escHtml(i.title)}</div>
        <div class="facility-sub">${escHtml(i.sub)}</div>
      </div>
    </div>
  `).join('');
}

/* =====================================================
   AI CHAT
   ===================================================== */
function initChat() {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  // Clear existing messages first (safe for re-init)
  const existingMsgs = container.querySelectorAll('.msg-row:not(#typingIndicator)');
  existingMsgs.forEach(m => m.remove());

  addMessage('ai', `👋 Welcome to **ArenaMax Stadium**! I'm **ARIA** — your AI concierge for tonight's epic IPL Final 🏏🔥

Tonight: **Mumbai Indians vs Chennai Super Kings** — MI leads 186/7 and CSK is chasing hard at 142!

I can help you with:
• 🚪 Gate queues & navigation
• 🍔 Food & wait times
• 🅿️ Parking availability
• 🚻 Restroom locations
• 🏥 Medical & safety info

What can I help you with?`);
}

async function sendMessage() {
  if (state.chatLoading) return;

  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  addMessage('user', msg);
  setTyping(true);
  state.chatLoading = true;

  // Hide quick prompts after first message
  const qp = document.getElementById('quickPrompts');
  if (qp) qp.style.display = 'none';

  try {
    const context = crowdEngine.buildContextSummary();
    const reply = await geminiClient.chat(msg, context);
    setTyping(false);
    addMessage('ai', reply);
  } catch (err) {
    setTyping(false);
    addMessage('ai', '⚠️ I had trouble connecting. Please try again in a moment!');
    console.error('Chat error:', err);
  } finally {
    state.chatLoading = false;
  }
}

function sendQuickPrompt(prompt) {
  document.getElementById('chatInput').value = prompt;
  sendMessage();
}

function addMessage(role, text) {
  const container = document.getElementById('chatMessages');
  if (!container) return;

  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const div = document.createElement('div');
  div.className = `msg-row ${role}`;
  div.innerHTML = `
    <div class="msg-avatar ${role}" aria-hidden="true">${role === 'ai' ? '🤖' : '👤'}</div>
    <div>
      <div class="msg-bubble ${role}" role="${role === 'ai' ? 'status' : 'none'}">${markdownLite(text)}</div>
      <div class="msg-time">${time}</div>
    </div>
  `;

  // Safely insert — append to messages container directly
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function setTyping(visible) {
  const el = document.getElementById('typingIndicator');
  if (!el) return;
  el.classList.toggle('visible', visible);
  // Move typing indicator to end of messages container to keep it last
  const container = document.getElementById('chatMessages');
  if (container) {
    if (visible) container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }
}

function clearChat() {
  const container = document.getElementById('chatMessages');
  if (container) container.innerHTML = '';
  geminiClient.clearHistory();
  document.getElementById('quickPrompts').style.display = 'flex';
  initChat();
  showToast('🗑️ Chat cleared', 'info');
}

/* =====================================================
   SCORE SIMULATION
   ===================================================== */
function startScoreSimulation() {
  state.scoreInterval = setInterval(() => {
    // CSK scoring simulation
    const runs = Math.random() < 0.15 ? 6 : Math.random() < 0.2 ? 4 : Math.random() < 0.1 ? 0 : Math.round(Math.random() * 2);
    scoreState.csk += runs;
    scoreState.ball++;
    if (scoreState.ball > 5) { scoreState.ball = 0; scoreState.over++; }
    if (scoreState.over >= 20 || scoreState.csk > scoreState.mi) {
      clearInterval(state.scoreInterval);
      const winner = scoreState.csk > scoreState.mi ? 'CSK' : 'MI';
      showToast(`🏆 ${winner} wins the IPL 2026 Final! 🎉`, 'info');
    }

    setText('scoreMI', scoreState.mi);
    setText('scoreCSK', scoreState.csk);

    const ovDisplay = document.querySelector('.event-score-card div:last-child div:last-child');
    if (ovDisplay) ovDisplay.textContent = `Ov: ${scoreState.over}.${scoreState.ball}`;
  }, 8000);
}

/* =====================================================
   PREFERENCES
   ===================================================== */
function toggleAccessibility(checkbox) {
  state.accessibilityMode = checkbox.checked;
  if (checkbox.checked) {
    document.documentElement.style.setProperty('--radius-lg', '4px');
    document.documentElement.style.setProperty('--radius-md', '4px');
    showToast('♿ Accessibility mode enabled — simplified routes preferred', 'info');
  } else {
    document.documentElement.style.removeProperty('--radius-lg');
    document.documentElement.style.removeProperty('--radius-md');
  }
}

function toggleCrowdAlerts(checkbox) {
  state.crowdAlertsEnabled = checkbox.checked;
  showToast(checkbox.checked ? '🔔 Crowd alerts enabled' : '🔕 Crowd alerts disabled', 'info');
}

/* =====================================================
   TOAST NOTIFICATIONS
   ===================================================== */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const icons = { info: 'ℹ️', warning: '⚠️', success: '✅', error: '❌' };
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || 'ℹ️'}</span>
    <span class="toast-msg">${escHtml(message)}</span>
  `;

  container.appendChild(toast);

  // Auto-remove after 4s
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/* =====================================================
   SERVICE WORKER (PWA)
   ===================================================== */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Service worker optional — app works fine without it
    });
  }
}

/* =====================================================
   FIREBASE AUTH — Google Sign-In
   ===================================================== */
async function initFirebaseAuth() {
  // Only runs when Firebase is configured in crowd.js
  if (!FIREBASE_CONFIGURED) return;
  try {
    const { getAuth, GoogleAuthProvider, onAuthStateChanged } =
      await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');
    const auth = getAuth();
    window._firebaseAuth = auth;
    window._GoogleAuthProvider = GoogleAuthProvider;

    onAuthStateChanged(auth, (user) => {
      state.user = user;
      updateAuthButton(user);
      if (user) {
        showToast(`✅ Welcome, ${user.displayName?.split(' ')[0] || 'Fan'}!`, 'success');
        // In production: fetch user's seat from ticketing API using user.email
      }
    });
  } catch (err) {
    console.warn('Firebase Auth not available:', err);
  }
}

async function handleAuthClick() {
  if (!FIREBASE_CONFIGURED) {
    showToast('🔑 Firebase not configured — add config in crowd.js for Google Sign-In', 'info');
    return;
  }
  try {
    if (state.user) {
      // Sign out
      const { signOut } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');
      await signOut(window._firebaseAuth);
      state.user = null;
      updateAuthButton(null);
      showToast('👋 Signed out successfully', 'info');
    } else {
      // Sign in with Google popup
      const { signInWithPopup, GoogleAuthProvider } =
        await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js');
      const provider = new GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      await signInWithPopup(window._firebaseAuth, provider);
    }
  } catch (err) {
    console.error('Auth error:', err);
    showToast('⚠️ Sign-in failed. Please try again.', 'warning');
  }
}

function updateAuthButton(user) {
  const btn = document.getElementById('userAuthBtn');
  if (!btn) return;
  if (user) {
    btn.innerHTML = `<img src="${user.photoURL}" style="width:18px;height:18px;border-radius:50%;object-fit:cover" alt=""> ${user.displayName?.split(' ')[0]}`;
  } else {
    btn.innerHTML = '👤 Sign In';
  }
}

/* =====================================================
   GOOGLE MAPS — Venue Navigation
   Callback invoked by Maps JS API script load.
   Uncomment the script tag in index.html to activate.
   ===================================================== */
window.initGoogleMap = function () {
  const venueCoords = { lat: 19.0760, lng: 72.8777 }; // ArenaMax Stadium, Mumbai

  const map = new google.maps.Map(document.getElementById('googleMap'), {
    center: venueCoords,
    zoom: 17,
    mapTypeId: 'hybrid',
    styles: [
      { elementType: 'geometry', stylers: [{ color: '#0f0f2d' }] },
      { elementType: 'labels.text.fill', stylers: [{ color: '#94a3b8' }] },
      { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1e1e4a' }] },
      { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#07071a' }] },
    ],
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
  });

  state.googleMap = map;

  // Venue marker
  new google.maps.Marker({
    position: venueCoords,
    map,
    title: 'ArenaMax Stadium',
    icon: {
      url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="%236366f1"/><text x="20" y="26" text-anchor="middle" font-size="18">🏟️</text></svg>',
      scaledSize: new google.maps.Size(40, 40),
    }
  });

  // Info window
  const infoWindow = new google.maps.InfoWindow({
    content: `<div style="color:#000;font-family:Inter,sans-serif;">
      <strong>ArenaMax Stadium</strong><br>
      IPL 2026 Grand Final<br>
      Mumbai Indians vs CSK
    </div>`
  });

  // Add gate markers from crowd data
  if (crowdEngine.data) {
    const gatePositions = {
      A: { lat: 19.0768, lng: 72.8777 }, // North
      B: { lat: 19.0760, lng: 72.8785 }, // East
      C: { lat: 19.0752, lng: 72.8777 }, // South
      D: { lat: 19.0760, lng: 72.8769 }, // West
    };
    crowdEngine.data.gates.forEach(g => {
      const pos = gatePositions[g.id];
      if (!pos) return;
      const color = g.density < 0.5 ? '%2322c55e' : g.density < 0.75 ? '%23f59e0b' : '%23ef4444';
      new google.maps.Marker({
        position: pos,
        map,
        title: `${g.name} — ~${g.queue} min queue`,
        icon: {
          url: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="13" fill="${color}"/><text x="15" y="20" text-anchor="middle" font-size="12" font-weight="bold" fill="white">${g.id}</text></svg>`,
          scaledSize: new google.maps.Size(30, 30),
        }
      });
    });
  }

  // Remove placeholder and show map
  const placeholder = document.querySelector('.map-placeholder');
  if (placeholder) placeholder.remove();

  showToast('🗺️ Google Maps loaded — live venue navigation active!', 'success');
};

/* =====================================================
   LIVE CRICKET SCORE — CricAPI Integration
   ===================================================== */
const CRICAPI_KEY = 'YOUR_CRICAPI_KEY'; // https://cricapi.com — free tier available

async function fetchAndUpdateScore() {
  if (CRICAPI_KEY === 'YOUR_CRICAPI_KEY') return; // No key — simulation handles score

  try {
    const res = await fetch(
      `https://api.cricapi.com/v1/currentMatches?apikey=${CRICAPI_KEY}&offset=0`,
      { signal: AbortSignal.timeout(5000) }
    );
    const json = await res.json();
    if (json.status !== 'success' || !json.data) return;

    // Find IPL match
    const match = json.data.find(m =>
      (m.name || '').toLowerCase().includes('mumbai') ||
      (m.name || '').toLowerCase().includes('ipl')
    );

    if (!match) return;

    // Parse scores — format varies by API response
    const scores = match.score || [];
    if (scores.length >= 1 && scores[0].r) setText('scoreMI', scores[0].r);
    if (scores.length >= 2 && scores[1].r) setText('scoreCSK', scores[1].r);

    // Update scoreState for Gemini context
    if (scores[0]?.r) scoreState.mi = scores[0].r;
    if (scores[1]?.r) scoreState.csk = scores[1].r;
    if (scores[1]?.o) {
      const [ov, ball] = String(scores[1].o).split('.');
      scoreState.over = parseInt(ov) || scoreState.over;
      scoreState.ball = parseInt(ball) || scoreState.ball;
    }

    // Update the LIVE badge — show "Live" from real API
    const liveStatus = document.getElementById('liveStatus');
    if (liveStatus && !match.matchEnded) {
      liveStatus.style.borderColor = '#22c55e';
    }

    console.log('✅ Live score updated from CricAPI');
  } catch (err) {
    // Fail silently — score simulation continues
    console.debug('CricAPI fetch failed:', err.message);
  }
}

/* =====================================================
   DATA SOURCE BADGE
   ===================================================== */
function updateDataSourceBadge() {
  const badge = document.getElementById('dataSourceBadge');
  if (!badge) return;
  const label = crowdEngine.getDataSourceLabel?.() || '🔵 Simulated';
  badge.textContent = label;
  badge.style.borderColor = label.includes('Firebase') ? '#22c55e' : 'rgba(99,102,241,0.18)';
  badge.title = label.includes('Firebase')
    ? 'Connected to Firebase Realtime Database — live IoT crowd data'
    : 'Using crowd simulation — configure Firebase for live data';
}

/* =====================================================
   UTILITIES
   ===================================================== */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}

/** Minimal markdown: bold, bullet lists, line breaks */
function markdownLite(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^•\s(.+)$/gm, '<li style="margin-left:12px;margin-top:3px">$1</li>')
    .replace(/\n/g, '<br>');
}
