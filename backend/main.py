"""
main.py — VenueAI Cloud Run Backend
FastAPI server with Google ADK venue agent

Endpoints:
  POST /chat          — AI concierge (Gemini via ADK, server-side key)
  GET  /crowd         — Live crowd data from Firebase
  GET  /score         — Live cricket score from CricAPI
  GET  /alerts        — Active venue alerts
  GET  /health        — Health check for Cloud Run
"""

import os
import json
import logging
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

# Load .env BEFORE importing agents (they read env vars at import time)
load_dotenv()

from agents.venue_agent import VenueAgent
from tools.firebase_client import FirebaseClient
from tools.cricket_client import CricketClient

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("venueai")

# ── Singletons ────────────────────────────────────────────────────────────────
firebase: FirebaseClient = None
cricket: CricketClient = None
agent: VenueAgent = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    global firebase, cricket, agent
    logger.info("🏟️  VenueAI backend starting...")

    firebase = FirebaseClient()
    await firebase.init()

    cricket = CricketClient()

    agent = VenueAgent(
        gemini_api_key=os.environ["GEMINI_API_KEY"],
        firebase_client=firebase,
        cricket_client=cricket,
    )

    logger.info("✅ All services initialized")
    yield

    logger.info("🛑 VenueAI backend shutting down")


# ── FastAPI App ────────────────────────────────────────────────────────────────
app = FastAPI(
    title="VenueAI Backend",
    description="Smart Sporting Event Assistant — Powered by Google Gemini + ADK",
    version="1.0.0",
    lifespan=lifespan,
)

# Allow all origins for hackathon demo (restrict in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response Models ─────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = "default"
    user_id: Optional[str] = None


class ChatResponse(BaseModel):
    response: str
    tools_called: list[str] = []
    session_id: str


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Cloud Run health check — must return 200."""
    return {
        "status": "healthy",
        "service": "venueai-backend",
        "firebase": firebase.is_connected if firebase else False,
        "agent": agent is not None,
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """
    AI concierge endpoint.
    Gemini API key stays server-side — never exposed to browser.
    """
    if not agent:
        raise HTTPException(503, "Agent not ready")

    try:
        result = await agent.chat(
            message=req.message,
            session_id=req.session_id,
            user_id=req.user_id,
        )
        return ChatResponse(
            response=result["text"],
            tools_called=result.get("tools_called", []),
            session_id=req.session_id,
        )
    except Exception as e:
        logger.error(f"Chat error: {e}")
        raise HTTPException(500, f"Agent error: {str(e)}")


@app.get("/crowd")
async def get_crowd():
    """Live crowd data — from Firebase or fallback JSON."""
    if not firebase:
        raise HTTPException(503, "Firebase not ready")
    data = await firebase.get_live_data()
    return JSONResponse(content=data)


@app.get("/crowd/gates")
async def get_gates():
    data = await firebase.get_live_data()
    return JSONResponse(content={"gates": data.get("gates", [])})


@app.get("/crowd/zones")
async def get_zones():
    data = await firebase.get_live_data()
    return JSONResponse(content={"zones": data.get("zones", [])})


@app.get("/score")
async def get_score():
    """Live cricket score from CricAPI."""
    if not cricket:
        raise HTTPException(503, "Cricket client not ready")
    score = await cricket.get_live_score()
    return JSONResponse(content=score)


@app.get("/alerts")
async def get_alerts():
    data = await firebase.get_live_data()
    return JSONResponse(content={"alerts": data.get("alerts", [])})


@app.get("/venue")
async def get_venue():
    """Full venue data snapshot."""
    data = await firebase.get_live_data()
    return JSONResponse(content=data)
