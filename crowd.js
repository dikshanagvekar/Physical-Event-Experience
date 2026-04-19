/**
 * crowd.js — Real-time Crowd Intelligence Engine
 *
 * Data sources (in priority order):
 *   1. Firebase Realtime Database (LIVE shared state — admin/IoT pushes updates)
 *   2. CricAPI (live cricket scores)
 *   3. Local simulation (fallback when Firebase not configured)
 *
 * In a real deployment, IoT sensors at gates and CCTV computer vision
 * (via Google Cloud Vision API) would push data to Firebase.
 *
 * Firebase setup:
 *   1. Create project at console.firebase.google.com
 *   2. Enable Realtime Database
 *   3. Import data/venue.json as the initial DB structure
 *   4. Replace FIREBASE_CONFIG below
 */

// ── Firebase config ─────────────────────────────────────────────────────────
// Replace with your Firebase project config from console.firebase.google.com
const FIREBASE_CONFIG = {
  apiKey:            'YOUR_FIREBASE_API_KEY',
  authDomain:        'YOUR_PROJECT.firebaseapp.com',
  databaseURL:       'https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'YOUR_PROJECT',
  storageBucket:     'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId:             'YOUR_APP_ID'
};

const FIREBASE_CONFIGURED = FIREBASE_CONFIG.apiKey !== 'YOUR_FIREBASE_API_KEY';

// ── Firebase SDK (loaded dynamically) ───────────────────────────────────────
let firebaseDb = null;

async function initFirebase() {
  if (!FIREBASE_CONFIGURED) return false;
  try {
    // Dynamically import Firebase SDK
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js');
    const { getDatabase, ref, onValue, set } = await import('https://www.gstatic.com/firebasejs/10.11.0/firebase-database.js');

    const app = initializeApp(FIREBASE_CONFIG);
    firebaseDb = getDatabase(app);

    window._firebaseRef  = ref;
    window._firebaseOnValue = onValue;
    window._firebaseSet  = set;
    console.log('✅ Firebase Realtime Database connected');
    return true;
  } catch (err) {
    console.warn('Firebase init failed — using local simulation:', err);
    return false;
  }
}

/* =====================================================
   CROWD ENGINE
   ===================================================== */
class CrowdEngine {
  constructor() {
    this.data = null;
    this.listeners = [];
    this.updateInterval = null;
    this.usingFirebase = false;
    this.tickCount = 0;
  }

  async init() {
    // Load baseline data from JSON
    const res = await fetch('./data/venue.json');
    this.data = await res.json();
    this._applyNoise(); // always apply initial randomization for realism

    // Try Firebase
    this.usingFirebase = await initFirebase();

    if (this.usingFirebase && firebaseDb) {
      this._listenToFirebase();
    } else {
      console.log('📡 Using local crowd simulation (no Firebase configured)');
    }
    return this.data;
  }

  /**
   * Firebase listener — syncs ALL crowd data in real-time.
   * When an admin or IoT sensor pushes to Firebase, all clients update instantly.
   */
  _listenToFirebase() {
    const ref  = window._firebaseRef;
    const onValue = window._firebaseOnValue;

    // Listen to /liveData node for real-time updates
    onValue(ref(firebaseDb, '/liveData'), (snapshot) => {
      const live = snapshot.val();
      if (!live) return;

      // Apply Firebase data over baseline venue.json
      if (live.gates)       this._mergeGates(live.gates);
      if (live.zones)       this._mergeZones(live.zones);
      if (live.concessions) this._mergeConcessions(live.concessions);
      if (live.restrooms)   this._mergeRestrooms(live.restrooms);
      if (live.parking)     this._mergeParking(live.parking);
      if (live.alerts)      this.data.alerts = live.alerts;

      this._notifyListeners();
      this.tickCount++;
    });
  }

  _mergeGates(liveGates) {
    liveGates.forEach(lg => {
      const gate = this.data.gates.find(g => g.id === lg.id);
      if (gate) Object.assign(gate, lg);
    });
  }
  _mergeZones(liveZones) {
    liveZones.forEach(lz => {
      const zone = this.data.zones.find(z => z.id === lz.id);
      if (zone) {
        Object.assign(zone, lz);
        zone.color = this._densityColor(zone.density);
      }
    });
  }
  _mergeConcessions(live) {
    live.forEach(lc => {
      const item = this.data.concessions.find(c => c.id === lc.id);
      if (item) Object.assign(item, lc);
    });
  }
  _mergeRestrooms(live) {
    live.forEach(lr => {
      const item = this.data.restrooms.find(r => r.id === lr.id);
      if (item) Object.assign(item, lr);
    });
  }
  _mergeParking(live) {
    live.forEach(lp => {
      const item = this.data.parking.find(p => p.id === lp.id);
      if (item) Object.assign(item, lp);
    });
  }

  /** Push updated data TO Firebase (admin/kiosk use) */
  async pushToFirebase(path, data) {
    if (!this.usingFirebase || !firebaseDb) return false;
    try {
      await window._firebaseSet(window._firebaseRef(firebaseDb, path), data);
      return true;
    } catch { return false; }
  }

  // ── Local simulation (fallback) ──────────────────────────────────────────

  /** Register a callback invoked on every data update */
  onUpdate(fn) { this.listeners.push(fn); }

  /** Start auto-updating every 30 seconds (simulation only) */
  startLive(intervalMs = 30000) {
    if (this.usingFirebase) return; // Firebase handles updates natively
    this.updateInterval = setInterval(() => {
      this._applyNoise();
      this._notifyListeners();
      this.tickCount++;
    }, intervalMs);
  }

  stopLive() {
    if (this.updateInterval) clearInterval(this.updateInterval);
  }

  /** Realistic drift noise for simulation mode */
  _applyNoise() {
    if (!this.data) return;

    this.data.zones.forEach(z => {
      z.density = Math.min(0.98, Math.max(0.05, z.density + (Math.random() - 0.48) * 0.06));
      z.color = this._densityColor(z.density);
    });
    this.data.gates.forEach(g => {
      g.density = Math.min(0.99, Math.max(0.05, g.density + (Math.random() - 0.45) * 0.08));
      g.queue = Math.max(0, Math.round(g.queue + (Math.random() - 0.45) * 4));
      g.status = g.density < 0.5 ? 'open' : g.density < 0.75 ? 'moderate' : 'busy';
    });
    this.data.concessions.forEach(c => {
      c.waitMin = Math.max(1, c.waitMin + Math.round((Math.random() - 0.4) * 3));
    });
    this.data.restrooms.forEach(r => {
      r.waitMin = Math.max(0, r.waitMin + Math.round((Math.random() - 0.45) * 2));
      r.capacity = r.waitMin <= 3 ? 'available' : r.waitMin <= 9 ? 'busy' : 'crowded';
    });
    this.data.parking.forEach(p => {
      p.available = Math.max(0, Math.min(p.total, p.available + Math.round((Math.random() - 0.4) * 12)));
    });
  }

  _notifyListeners() {
    this.listeners.forEach(fn => { try { fn(this.data); } catch(e) {} });
  }

  _densityColor(d) {
    if (d < 0.5)  return '#22c55e';
    if (d < 0.75) return '#f59e0b';
    return '#ef4444';
  }

  // ── Helper getters ──────────────────────────────────────────────────────
  getBestGate()     { return this.data ? [...this.data.gates].sort((a,b) => a.density - b.density)[0] : null; }
  getFastestFood()  { return this.data ? [...this.data.concessions].filter(c=>c.category==='food').sort((a,b)=>a.waitMin-b.waitMin)[0] : null; }
  getNearestRestroom() { return this.data ? [...this.data.restrooms].sort((a,b) => a.waitMin - b.waitMin)[0] : null; }
  getAvailableParking() { return this.data ? this.data.parking.filter(p => p.available > 0) : []; }
  getOverallDensity()   { return this.data ? this.data.zones.reduce((s,z)=>s+z.density, 0) / this.data.zones.length : 0; }

  /** Data source label for UI display */
  getDataSourceLabel() {
    return this.usingFirebase ? '🔴 Firebase Live' : '🔵 Simulated';
  }

  /**
   * Build context summary string for Gemini fallback responses.
   * (Not used in function-calling mode — kept for offline fallback.)
   */
  buildContextSummary() {
    if (!this.data) return '';
    const d = this.data;
    return `
Venue: ArenaMax Stadium | Event: IPL 2026 Final (MI vs CSK) | Source: ${this.getDataSourceLabel()}
Gates: ${d.gates.map(g=>`${g.name}:${g.status}(${g.queue}min)`).join(',')}
Best gate: ${this.getBestGate()?.name}
Zones: ${d.zones.map(z=>`${z.name}:${Math.round(z.density*100)}%`).join(',')}
Food fastest: ${this.getFastestFood()?.name}(${this.getFastestFood()?.waitMin}min)
Restroom fastest: ${this.getNearestRestroom()?.name}(${this.getNearestRestroom()?.waitMin}min)
Parking free: ${this.getAvailableParking().map(p=>`${p.name}:${p.available}`).join(',')}
    `.trim();
  }
}

// ── Export singleton ─────────────────────────────────────────────────────────
const crowdEngine = new CrowdEngine();
