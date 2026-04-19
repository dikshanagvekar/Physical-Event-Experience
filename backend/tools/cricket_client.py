"""CricAPI client for live cricket scores."""
import os
import logging
import asyncio
import httpx

logger = logging.getLogger("venueai.cricket")

CRICAPI_BASE = "https://api.cricapi.com/v1"


class CricketClient:
    """Fetches live IPL scores from CricAPI. Falls back to simulated data."""

    def __init__(self):
        self.api_key = os.environ.get("CRICAPI_KEY", "")
        self._simulated = {
            "match": "Mumbai Indians vs Chennai Super Kings",
            "tournament": "IPL 2026 Final",
            "venue": "ArenaMax Stadium, Mumbai",
            "status": "Match in progress",
            "mi_score": "186/7",
            "csk_score": "142",
            "csk_overs": "16.3",
            "runs_needed": 45,
            "balls_remaining": 21,
            "live": True,
            "source": "simulated",
        }

    async def get_live_score(self) -> dict:
        """Get live score — CricAPI or simulated fallback."""
        if not self.api_key:
            logger.debug("No CricAPI key — returning simulated score")
            return self._simulated

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(
                    f"{CRICAPI_BASE}/currentMatches",
                    params={"apikey": self.api_key, "offset": 0},
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("status") != "success" or not data.get("data"):
                return self._simulated

            # Find IPL / T20 match
            match = next(
                (
                    m for m in data["data"]
                    if any(
                        kw in (m.get("name", "") + m.get("matchType", "")).lower()
                        for kw in ["ipl", "mumbai", "chennai", "t20"]
                    )
                ),
                None,
            )

            if not match:
                return self._simulated

            scores = match.get("score", [])
            return {
                "match": match.get("name"),
                "tournament": "IPL 2026",
                "venue": match.get("venue"),
                "status": match.get("status"),
                "scores": scores,
                "live": not match.get("matchEnded", False),
                "source": "cricapi",
            }

        except Exception as e:
            logger.warning(f"CricAPI error: {e} — using simulated score")
            return self._simulated
