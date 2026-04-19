/**
 * gemini.js — VenueAI Frontend AI Client
 *
 * Calls the Cloud Run backend instead of Gemini directly.
 * This means:
 *   ✅ API key NEVER exposed in browser
 *   ✅ All Gemini + Firebase logic runs server-side
 *   ✅ Scales to 75,000 concurrent fans via Cloud Run
 *
 * Backend repo: /backend/  (FastAPI + Google ADK + Gemini 2.0 Flash)
 *
 * Set BACKEND_URL to your deployed Cloud Run service URL.
 * For local development, the backend runs on port 8080.
 */

// ── Backend URL ──────────────────────────────────────────────────────────────
// Replace with your Cloud Run URL after deployment
// e.g. 'https://venue-ai-api-xyz-as.a.run.app'
const BACKEND_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8080'           // local dev
  : 'https://YOUR_CLOUD_RUN_API_URL'; // production ← replace after deploy

/* =====================================================
   FUNCTION DECLARATIONS — Gemini tool schema
   ===================================================== */
const VENUE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'get_gate_status',
        description: 'Get real-time queue length and crowd density for all stadium entry gates. Use this whenever the user asks about gates, entry, queues, or which gate to use.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_food_wait_times',
        description: 'Get current estimated wait times for all food and beverage concessions. Use this when user asks about food, eating, drinks, or ordering.',
        parameters: {
          type: 'OBJECT',
          properties: {
            category: {
              type: 'STRING',
              description: 'Filter by category: "food", "beverages", "merchandise", or "all"',
              enum: ['food', 'beverages', 'merchandise', 'all']
            }
          },
          required: []
        }
      },
      {
        name: 'get_restroom_availability',
        description: 'Get current wait times for restrooms/washrooms in all zones. Use when user asks about restrooms, toilets, or bathroom.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_crowd_density',
        description: 'Get current crowd density percentage for all stadium zones and an overall venue density. Use when user asks about crowds, busy areas, or where to go.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_parking_availability',
        description: 'Get current available parking spots across all lots. Use when user asks about parking, car, or where to park.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_live_score',
        description: 'Get the current live cricket match score. Use when user asks about the score, match, wickets, overs, or how the game is going.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_nearest_medical',
        description: 'Get location and status of all medical bays in the stadium. Use for medical, first aid, doctor, or emergency questions.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_active_alerts',
        description: 'Get all currently active venue alerts, warnings, and informational messages.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      }
    ]
  }
];

/* =====================================================
   FUNCTION EXECUTOR — Runs Gemini's tool calls
   ===================================================== */
async function executeTool(name, args) {
  const d = crowdEngine.data;
  if (!d) return { error: 'Venue data not yet loaded' };

  switch (name) {
    case 'get_gate_status': {
      const best = crowdEngine.getBestGate();
      return {
        recommended_gate: best?.name,
        recommended_queue_minutes: best?.queue,
        all_gates: d.gates.map(g => ({
          name: g.name,
          status: g.status,
          density_percent: Math.round(g.density * 100),
          queue_minutes: g.queue
        }))
      };
    }

    case 'get_food_wait_times': {
      const cat = args?.category || 'all';
      const items = cat === 'all' ? d.concessions : d.concessions.filter(c => c.category === cat);
      const fastest = [...items].sort((a, b) => a.waitMin - b.waitMin)[0];
      return {
        fastest_option: fastest ? { name: fastest.name, wait_minutes: fastest.waitMin, zone: fastest.zone, items: fastest.items } : null,
        all_concessions: items.map(c => ({
          name: c.name,
          category: c.category,
          zone: c.zone,
          wait_minutes: c.waitMin,
          menu_items: c.items
        }))
      };
    }

    case 'get_restroom_availability': {
      const nearest = crowdEngine.getNearestRestroom();
      return {
        nearest_restroom: { name: nearest?.name, zone: nearest?.zone, wait_minutes: nearest?.waitMin },
        all_restrooms: d.restrooms.map(r => ({
          name: r.name,
          zone: r.zone,
          wait_minutes: r.waitMin,
          status: r.capacity
        }))
      };
    }

    case 'get_crowd_density': {
      const overall = Math.round(crowdEngine.getOverallDensity() * 100);
      const least = [...d.zones].sort((a, b) => a.density - b.density)[0];
      return {
        overall_density_percent: overall,
        least_crowded_zone: least?.name,
        zones: d.zones.map(z => ({
          name: z.name,
          section: z.section,
          density_percent: Math.round(z.density * 100),
          status: z.density < 0.5 ? 'comfortable' : z.density < 0.75 ? 'busy' : 'crowded'
        }))
      };
    }

    case 'get_parking_availability': {
      const avail = crowdEngine.getAvailableParking();
      const best = [...avail].sort((a, b) => b.available - a.available)[0];
      return {
        total_free_spots: d.parking.reduce((s, p) => s + p.available, 0),
        recommended_lot: best ? { name: best.name, available_spots: best.available, distance: best.distance } : null,
        all_lots: d.parking.map(p => ({
          name: p.name,
          available: p.available,
          total: p.total,
          percent_full: Math.round((1 - p.available / p.total) * 100),
          distance_from_gate: p.distance
        }))
      };
    }

    case 'get_live_score': {
      // Try live API first, fall back to simulated state
      const liveScore = await fetchLiveScore();
      return liveScore || {
        match: 'Mumbai Indians vs Chennai Super Kings',
        tournament: 'IPL 2026 Final',
        venue: 'ArenaMax Stadium, Mumbai',
        mi_score: scoreState.mi,
        mi_wickets: 7,
        csk_score: scoreState.csk,
        csk_overs: `${scoreState.over}.${scoreState.ball}`,
        runs_needed: Math.max(0, scoreState.mi - scoreState.csk + 1),
        balls_remaining: Math.max(0, (20 - scoreState.over) * 6 - scoreState.ball),
        status: scoreState.csk > scoreState.mi ? 'CSK wins!' : 'Match in progress — CSK chasing'
      };
    }

    case 'get_nearest_medical': {
      return {
        medical_bays: d.medicalPosts?.map(m => ({
          name: m.name,
          zone: m.zone,
          available: m.available,
          note: 'Staffed by qualified paramedics. Open throughout the event.'
        })),
        emergency_number: '1800-ARENA-911',
        note: 'For life-threatening emergencies, approach any security personnel immediately or call the stadium emergency line.'
      };
    }

    case 'get_active_alerts': {
      return {
        total_alerts: d.alerts?.length,
        alerts: d.alerts?.map(a => ({
          type: a.type,
          severity: a.severity,
          message: a.message,
          time: a.time
        }))
      };
    }

    default:
      return { error: `Unknown function: ${name}` };
  }
}

/* =====================================================
   LIVE SCORE FETCHER — CricAPI (free tier)
   Replace with your own CricAPI key from cricapi.com
   ===================================================== */
const CRICAPI_KEY = 'YOUR_CRICAPI_KEY'; // https://cricapi.com

async function fetchLiveScore() {
  if (CRICAPI_KEY === 'YOUR_CRICAPI_KEY') return null;
  try {
    const res = await fetch(`https://api.cricapi.com/v1/currentMatches?apikey=${CRICAPI_KEY}&offset=0`);
    const data = await res.json();
    if (!data.data || data.status !== 'success') return null;

    // Find the IPL match
    const match = data.data.find(m =>
      m.name?.toLowerCase().includes('mumbai') ||
      m.name?.toLowerCase().includes('chennai') ||
      m.matchType === 'T20'
    );
    if (!match) return null;

    return {
      match: match.name,
      status: match.status,
      venue: match.venue,
      teams: match.teams,
      scores: match.score,
      live: !match.matchEnded
    };
  } catch {
    return null; // Fail silently, use simulated data
  }
}

/* =====================================================
   BACKEND API CLIENT
   Replaces direct Gemini calls — all AI runs server-side
   ===================================================== */
class GeminiClient {
  constructor() {
    this.sessionId = crypto.randomUUID();
    this._backendOnline = null; // null = unknown, true/false = checked
  }

  async chat(userMessage) {
    // Check backend availability on first call
    if (this._backendOnline === null) {
      this._backendOnline = await this._checkBackend();
    }

    if (this._backendOnline) {
      return this._callBackend(userMessage);
    }
    // Backend not available — use intelligent local fallback
    return this._intelligentFallback(userMessage);
  }

  async _checkBackend() {
    try {
      const res = await fetch(`${BACKEND_URL}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      const ok = res.ok;
      if (ok) console.log('✅ Backend connected:', BACKEND_URL);
      else console.warn('⚠️ Backend not healthy — using fallback');
      return ok;
    } catch {
      console.warn('⚠️ Backend unreachable — using local fallback');
      return false;
    }
  }

  async _callBackend(userMessage) {
    try {
      const res = await fetch(`${BACKEND_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          session_id: this.sessionId,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`Backend returned ${res.status}`);

      const data = await res.json();
      if (data.tools_called?.length) {
        console.log('🔧 Tools used by ARIA:', data.tools_called.join(', '));
      }
      return data.response;

    } catch (err) {
      console.error('Backend call failed:', err);
      this._backendOnline = false; // fallback for rest of session
      return this._intelligentFallback(userMessage);
    }
  }

  // ── Intelligent local fallback (backend down / local dev without backend) ──
  async _intelligentFallback(userMessage) {
    const msg = userMessage.toLowerCase();
    const d = crowdEngine.data;

    return new Promise(resolve => {
      setTimeout(() => {
        if (!d) { resolve('Loading venue data — please try again in a moment! 🔄'); return; }

        const bestGate     = crowdEngine.getBestGate();
        const bestFood     = crowdEngine.getFastestFood();
        const bestRestroom = crowdEngine.getNearestRestroom();
        const avail        = crowdEngine.getAvailableParking();

        let response = '';
        if (/restroom|toilet|bathroom|washroom/.test(msg))
          response = `🚻 Fastest restroom: **${bestRestroom?.name}** (~${bestRestroom?.waitMin} min). South zone restrooms are very busy — avoid those!`;
        else if (/gate|entry|enter|queue|line/.test(msg))
          response = `🚪 **${bestGate?.name}** has the shortest queue (~${bestGate?.queue} min). Gate C is at 90% capacity — avoid it!`;
        else if (/food|eat|burger|pizza|snack|drink/.test(msg))
          response = `🍔 Fastest option: **${bestFood?.name}** (~${bestFood?.waitMin} min) serving ${bestFood?.items?.join(', ')}. Grab it before the innings break!`;
        else if (/park|parking|car/.test(msg))
          response = avail.length
            ? `🅿️ **${avail[0]?.name}** has ${avail[0]?.available} free spots (${avail[0]?.distance}). Go soon!`
            : `🅿️ All nearby lots are full. Try Lot D Metro — 12 min walk, plenty of space.`;
        else if (/medical|first.?aid|emergency/.test(msg))
          response = `🏥 Medical bays at North (Gate A) and South (Gate C). Emergency: **1800-ARENA-911** or flag down any security officer!`;
        else if (/score|match|ipl|cricket|wicket|over/.test(msg))
          response = `🏏 **MI ${scoreState.mi}/7 | CSK ${scoreState.csk}** (Ov: ${scoreState.over}.${scoreState.ball}) — CSK needs ${Math.max(0, scoreState.mi - scoreState.csk + 1)} off ${Math.max(0, (20 - scoreState.over) * 6 - scoreState.ball)} balls! 🔥`;
        else if (/crowd|busy|full|dense/.test(msg))
          response = `👥 Stadium at **${Math.round(crowdEngine.getOverallDensity() * 100)}%** capacity. North Stand is least crowded — best spot for easy movement!`;
        else if (/hi|hello|hey|hola/.test(msg))
          response = `👋 Hi there! I'm ARIA — your AI concierge for tonight's IPL Final! Ask me about gates, food, restrooms, parking, or the live score 🏏`;
        else
          response = `🤖 I can help with **gate queues**, **food wait times**, **restrooms**, **parking**, **medical**, and **live score**. What do you need?`;

        resolve(response);
      }, 600 + Math.random() * 400);
    });
  }

  clearHistory() {
    // Reset session so backend starts fresh conversation
    this.sessionId = crypto.randomUUID();
  }
}

const geminiClient = new GeminiClient();


