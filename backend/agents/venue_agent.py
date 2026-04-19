"""
venue_agent.py — Google ADK Venue Agent (ARIA)

Uses google-genai (the new Gemini SDK) with function calling in an agentic loop.
Replaces deprecated google-generativeai package.
"""

import os
import logging
import json
from typing import Optional

from google import genai
from google.genai import types

logger = logging.getLogger("venueai.agent")

SYSTEM_PROMPT = """You are ARIA (AI Arena Intelligence Assistant) — a friendly, knowledgeable venue concierge for ArenaMax Stadium during the IPL 2026 Final (Mumbai Indians vs Chennai Super Kings).

Your job: Help fans with navigation, queues, food, parking, safety, and real-time match info.

Rules:
- Be friendly, enthusiastic, and CONCISE (2-4 sentences max)
- ALWAYS call the relevant tool before answering venue questions — never guess
- Use emojis sparingly but effectively
- Accessibility and safety always come first
- Recommend the LEAST crowded / fastest options
- If you can't help, say so honestly"""

# ── Tool declarations ─────────────────────────────────────────────────────────
TOOLS = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="get_gate_status",
                description="Get real-time queue length and density for all stadium entry gates. Call when user asks about gates, entry, or which gate to use.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
            types.FunctionDeclaration(
                name="get_food_wait_times",
                description="Get current wait times for all food/beverage concessions. Call when user asks about food, drinks, or ordering.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "category": types.Schema(
                            type=types.Type.STRING,
                            description="Filter: 'food', 'beverages', 'merchandise', or 'all'"
                        )
                    }
                )
            ),
            types.FunctionDeclaration(
                name="get_restroom_availability",
                description="Get wait times for restrooms in all zones. Call when user asks about restrooms or bathrooms.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
            types.FunctionDeclaration(
                name="get_crowd_density",
                description="Get current crowd density for all stadium zones. Call when user asks about crowds or where it's less busy.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
            types.FunctionDeclaration(
                name="get_parking_availability",
                description="Get available parking spots across all lots. Call when user asks about parking.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
            types.FunctionDeclaration(
                name="get_live_score",
                description="Get the live cricket match score. Call when user asks about the score, match, or how the game is going.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
            types.FunctionDeclaration(
                name="get_nearest_medical",
                description="Get medical bay locations and status. Call when user asks about medical help or emergencies.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
            types.FunctionDeclaration(
                name="get_active_alerts",
                description="Get all active venue alerts and warnings.",
                parameters=types.Schema(type=types.Type.OBJECT, properties={})
            ),
        ]
    )
]


class VenueAgent:
    """
    Gemini 2.0 Flash agent with function calling — agentic loop:
      1. User sends message
      2. Gemini decides which tool(s) to call
      3. We execute the tools (real Firebase/CricAPI data)
      4. Gemini generates a grounded natural-language response
    """

    def __init__(self, gemini_api_key: str, firebase_client, cricket_client):
        self.client = genai.Client(api_key=gemini_api_key)
        self.firebase = firebase_client
        self.cricket = cricket_client
        self.sessions: dict[str, list] = {}  # session_id → message history
        logger.info("✅ VenueAgent (ARIA) initialized with Gemini 2.0 Flash + 8 tools")

    async def chat(self, message: str, session_id: str = "default", user_id: Optional[str] = None) -> dict:
        """
        Agentic conversation: send message → handle tool calls → return grounded response.
        """
        history = self.sessions.get(session_id, [])
        tools_called = []

        # Add the new user turn to history
        history.append(types.Content(role="user", parts=[types.Part(text=message)]))

        import asyncio
        loop = asyncio.get_event_loop()

        # ── Agentic loop ──────────────────────────────────────────────────────
        max_iters = 5
        for _ in range(max_iters):
            response = await loop.run_in_executor(
                None,
                lambda: self.client.models.generate_content(
                    model="gemini-2.0-flash",
                    contents=history,
                    config=types.GenerateContentConfig(
                        system_instruction=SYSTEM_PROMPT,
                        tools=TOOLS,
                        tool_config=types.ToolConfig(
                            function_calling_config=types.FunctionCallingConfig(mode="AUTO")
                        ),
                        temperature=0.7,
                        max_output_tokens=350,
                    )
                )
            )

            candidate = response.candidates[0]
            content = candidate.content

            # Collect function calls
            fn_calls = [p for p in content.parts if p.function_call]
            if not fn_calls:
                break  # Gemini returned a text response — done

            # Add model's tool-call message to history
            history.append(content)

            # Execute each tool call and build function responses
            fn_response_parts = []
            for part in fn_calls:
                fn_name = part.function_call.name
                fn_args = dict(part.function_call.args) if part.function_call.args else {}
                tools_called.append(fn_name)

                logger.info(f"🔧 Tool call: {fn_name}({fn_args})")
                result = await self._execute_tool(fn_name, fn_args)

                fn_response_parts.append(
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=fn_name,
                            response={"content": json.dumps(result)}
                        )
                    )
                )

            # Add tool results as "tool" turn in history
            history.append(types.Content(role="tool", parts=fn_response_parts))

        # Extract final text
        text = self._extract_text(response)

        # Add model's final response to history
        history.append(types.Content(role="model", parts=[types.Part(text=text)]))

        # Keep history bounded (last 20 messages)
        self.sessions[session_id] = history[-20:]

        # Prevent memory leaks from too many sessions
        if len(self.sessions) > 1000:
            del self.sessions[next(iter(self.sessions))]

        return {"text": text, "tools_called": tools_called}

    def _extract_text(self, response) -> str:
        for part in response.candidates[0].content.parts:
            if hasattr(part, "text") and part.text:
                return part.text
        return "I'm processing your request — please try again in a moment! 🔄"

    async def _execute_tool(self, name: str, args: dict) -> dict:
        """Dispatch tool calls to live data sources (Firebase / CricAPI)."""
        data = await self.firebase.get_live_data()

        if name == "get_gate_status":
            gates = data.get("gates", [])
            best = min(gates, key=lambda g: g.get("density", 1), default=None)
            return {
                "recommended_gate": best.get("name") if best else "Gate A",
                "recommended_queue_minutes": best.get("queue") if best else 5,
                "all_gates": [
                    {
                        "name": g["name"],
                        "status": g.get("status", "open"),
                        "density_percent": round(g.get("density", 0) * 100),
                        "queue_minutes": g.get("queue", 0),
                    }
                    for g in gates
                ],
            }

        elif name == "get_food_wait_times":
            cat = args.get("category", "all")
            concessions = data.get("concessions", [])
            if cat != "all":
                concessions = [c for c in concessions if c.get("category") == cat]
            fastest = min(concessions, key=lambda c: c.get("waitMin", 99), default=None)
            return {
                "fastest_option": {
                    "name": fastest.get("name"),
                    "wait_minutes": fastest.get("waitMin"),
                    "zone": fastest.get("zone"),
                    "items": fastest.get("items", []),
                } if fastest else None,
                "all_concessions": [
                    {
                        "name": c["name"],
                        "category": c.get("category"),
                        "zone": c.get("zone"),
                        "wait_minutes": c.get("waitMin"),
                        "menu_items": c.get("items", []),
                    }
                    for c in concessions
                ],
            }

        elif name == "get_restroom_availability":
            restrooms = data.get("restrooms", [])
            nearest = min(restrooms, key=lambda r: r.get("waitMin", 99), default=None)
            return {
                "nearest_restroom": {
                    "name": nearest.get("name"),
                    "zone": nearest.get("zone"),
                    "wait_minutes": nearest.get("waitMin"),
                } if nearest else None,
                "all_restrooms": [
                    {
                        "name": r["name"],
                        "zone": r.get("zone"),
                        "wait_minutes": r.get("waitMin"),
                        "status": r.get("capacity", "available"),
                    }
                    for r in restrooms
                ],
            }

        elif name == "get_crowd_density":
            zones = data.get("zones", [])
            overall = sum(z.get("density", 0) for z in zones) / max(len(zones), 1)
            least = min(zones, key=lambda z: z.get("density", 1), default=None)
            return {
                "overall_density_percent": round(overall * 100),
                "least_crowded_zone": least.get("name") if least else "North Stand",
                "zones": [
                    {
                        "name": z["name"],
                        "section": z.get("section"),
                        "density_percent": round(z.get("density", 0) * 100),
                        "status": (
                            "comfortable" if z.get("density", 0) < 0.5
                            else "busy" if z.get("density", 0) < 0.75
                            else "crowded"
                        ),
                    }
                    for z in zones
                ],
            }

        elif name == "get_parking_availability":
            parking = data.get("parking", [])
            available = [p for p in parking if p.get("available", 0) > 0]
            best = max(available, key=lambda p: p.get("available", 0), default=None)
            return {
                "total_free_spots": sum(p.get("available", 0) for p in parking),
                "recommended_lot": {
                    "name": best.get("name"),
                    "available_spots": best.get("available"),
                    "distance": best.get("distance"),
                } if best else None,
                "all_lots": [
                    {
                        "name": p["name"],
                        "available": p.get("available"),
                        "total": p.get("total"),
                        "distance": p.get("distance"),
                        "percent_full": round(
                            (1 - p.get("available", 0) / max(p.get("total", 1), 1)) * 100
                        ),
                    }
                    for p in parking
                ],
            }

        elif name == "get_live_score":
            return await self.cricket.get_live_score()

        elif name == "get_nearest_medical":
            return {
                "medical_bays": data.get("medicalPosts", []),
                "emergency_number": "1800-ARENA-911",
                "note": "For life-threatening emergencies, approach any security personnel immediately.",
            }

        elif name == "get_active_alerts":
            return {
                "total_alerts": len(data.get("alerts", [])),
                "alerts": data.get("alerts", []),
            }

        return {"error": f"Unknown tool: {name}"}
