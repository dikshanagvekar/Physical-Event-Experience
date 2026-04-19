/**
 * gemini.js — VenueAI Frontend AI Client
 *
 * Communicates with the VenueAI Cloud Run backend.
 * All AI logic (Gemini 2.0 Flash, Firebase, function calling) runs server-side.
 *
 * Security model:
 *   - API keys are NEVER stored or sent from the browser
 *   - All requests go to the backend /chat endpoint
 *   - Falls back to intelligent local responses if backend is unreachable
 *
 * Backend: /backend/  (FastAPI + Google ADK + Gemini 2.0 Flash)
 * Docs:    https://your-backend.run.app/docs
 */

// ── Backend URL ───────────────────────────────────────────────────────────────
// Local dev:  backend runs on port 8080 via `uvicorn main:app --port 8080`
// Production: replace with your deployed Cloud Run backend URL
const BACKEND_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8080'
  : 'https://YOUR_CLOUD_RUN_API_URL'; // ← replace after deploying backend

// ── BackendClient ─────────────────────────────────────────────────────────────
/**
 * GeminiClient wraps the backend /chat API.
 * Named GeminiClient for compatibility with app.js which calls geminiClient.chat().
 */
class GeminiClient {
  constructor() {
    /** Unique session ID — persists across messages for conversation history. */
    this.sessionId = crypto.randomUUID();

    /** Tri-state: null = not yet checked, true = online, false = offline. */
    this._backendOnline = null;
  }

  /**
   * Send a message to ARIA and receive an AI response.
   * Automatically falls back to local heuristics if backend is unreachable.
   *
   * @param {string} userMessage - The fan's question or request.
   * @returns {Promise<string>} ARIA's response text.
   */
  async chat(userMessage) {
    if (this._backendOnline === null) {
      this._backendOnline = await this._checkBackend();
    }

    return this._backendOnline
      ? this._callBackend(userMessage)
      : this._intelligentFallback(userMessage);
  }

  /**
   * Probe the backend health endpoint to confirm it's reachable.
   * @returns {Promise<boolean>}
   */
  async _checkBackend() {
    try {
      const res = await fetch(`${BACKEND_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const ok = res.ok;
      console.info(ok
        ? `✅ VenueAI backend connected: ${BACKEND_URL}`
        : `⚠️ Backend unhealthy — switching to local fallback`
      );
      return ok;
    } catch {
      console.warn('⚠️ Backend unreachable — switching to local fallback');
      return false;
    }
  }

  /**
   * Call the backend /chat endpoint.
   * The backend runs Gemini 2.0 Flash with function calling and returns ARIA's response.
   *
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
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

      if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);

      const data = await res.json();

      if (data.tools_called?.length) {
        console.debug('🔧 ARIA tools used:', data.tools_called.join(', '));
      }

      return data.response;

    } catch (err) {
      console.error('Backend call failed, switching to fallback:', err.message);
      this._backendOnline = false;
      return this._intelligentFallback(userMessage);
    }
  }

  /**
   * Context-aware local fallback for when the backend is unreachable.
   * Uses live crowd engine data for relevant, real-time answers.
   *
   * @param {string} userMessage
   * @returns {Promise<string>}
   */
  async _intelligentFallback(userMessage) {
    const msg = userMessage.toLowerCase();
    const d = crowdEngine?.data;

    return new Promise(resolve => {
      setTimeout(() => {
        if (!d) {
          resolve('Loading venue data — please try again in a moment! 🔄');
          return;
        }

        const bestGate     = crowdEngine.getBestGate();
        const bestFood     = crowdEngine.getFastestFood();
        const bestRestroom = crowdEngine.getNearestRestroom();
        const avail        = crowdEngine.getAvailableParking();
        const density      = Math.round(crowdEngine.getOverallDensity() * 100);

        let response;

        if (/restroom|toilet|bathroom|washroom/.test(msg)) {
          response = `🚻 Fastest restroom: **${bestRestroom?.name}** (~${bestRestroom?.waitMin} min). South zone restrooms are very busy — avoid those!`;
        } else if (/gate|entry|enter|queue|line/.test(msg)) {
          response = `🚪 **${bestGate?.name}** has the shortest queue (~${bestGate?.queue} min). Gate C is at 90% capacity — avoid it!`;
        } else if (/food|eat|burger|pizza|snack|drink|hungry/.test(msg)) {
          response = `🍔 Fastest option: **${bestFood?.name}** (~${bestFood?.waitMin} min) serving ${bestFood?.items?.join(', ')}. Grab it before the innings break!`;
        } else if (/park|parking|car/.test(msg)) {
          response = avail.length
            ? `🅿️ **${avail[0]?.name}** has ${avail[0]?.available} free spots (${avail[0]?.distance}). Go soon!`
            : `🅿️ All nearby lots are full. Try Lot D Metro — 12 min walk, plenty of space.`;
        } else if (/medical|first.?aid|emergency|doctor|ambulance/.test(msg)) {
          response = `🏥 Medical bays at North (Gate A) and South (Gate C). Emergency: **1800-ARENA-911** or flag any security officer!`;
        } else if (/score|match|ipl|cricket|wicket|over|run/.test(msg)) {
          const needed = Math.max(0, scoreState.mi - scoreState.csk + 1);
          const balls  = Math.max(0, (20 - scoreState.over) * 6 - scoreState.ball);
          response = `🏏 **MI ${scoreState.mi}/7 | CSK ${scoreState.csk}** (Ov: ${scoreState.over}.${scoreState.ball}) — CSK needs ${needed} off ${balls} balls! 🔥`;
        } else if (/crowd|busy|full|dense|where/.test(msg)) {
          response = `👥 Stadium at **${density}%** capacity. North Stand is least crowded — best for easy movement!`;
        } else if (/hi|hello|hey|hola|namaste/.test(msg)) {
          response = `👋 Hi! I'm ARIA — your AI concierge for tonight's IPL Final! Ask me about gates, food, restrooms, parking, or the live score 🏏`;
        } else {
          response = `🤖 I can help with **gate queues**, **food wait times**, **restrooms**, **parking**, **medical**, and **live score**. What do you need?`;
        }

        resolve(response);
      }, 600 + Math.random() * 400);
    });
  }

  /**
   * Reset conversation history by generating a new session ID.
   */
  clearHistory() {
    this.sessionId = crypto.randomUUID();
  }
}

// ── Singleton instance used throughout app.js ─────────────────────────────────
const geminiClient = new GeminiClient();
