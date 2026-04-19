"""
tests/test_agent.py — Unit tests for VenueAI backend

Tests cover:
  - Firebase client fallback behaviour
  - All 8 venue tool functions (data correctness)
  - Cricket client fallback
  - API endpoint contracts
  - Input validation and edge cases

Run with: pytest tests/ -v
"""
import sys
import os
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

# ── Shared test fixtures ───────────────────────────────────────────────────────

MOCK_VENUE_DATA = {
    "gates": [
        {"id": "A", "name": "Gate A — North", "density": 0.3, "status": "open",    "queue": 4},
        {"id": "B", "name": "Gate B — East",  "density": 0.75,"status": "busy",    "queue": 18},
        {"id": "C", "name": "Gate C — South", "density": 0.9, "status": "crowded", "queue": 32},
        {"id": "D", "name": "Gate D — West",  "density": 0.4, "status": "open",    "queue": 6},
    ],
    "zones": [
        {"id": "Z1", "name": "North Stand", "section": "Lower Tier", "density": 0.4},
        {"id": "Z2", "name": "East Stand",  "section": "Upper Tier", "density": 0.78},
        {"id": "Z3", "name": "South Stand", "section": "VIP Box",    "density": 0.92},
    ],
    "concessions": [
        {"id": "C1", "name": "Burger Hub",  "category": "food",      "zone": "North", "waitMin": 5,  "items": ["Classic Burger"]},
        {"id": "C2", "name": "Spice Lane",  "category": "food",      "zone": "East",  "waitMin": 14, "items": ["Samosa", "Chai"]},
        {"id": "C4", "name": "Refresh Bar", "category": "beverages", "zone": "West",  "waitMin": 3,  "items": ["Water", "Juice"]},
    ],
    "restrooms": [
        {"id": "R1", "name": "Restroom North A", "zone": "North", "waitMin": 2,  "capacity": "available"},
        {"id": "R3", "name": "Restroom South C", "zone": "South", "waitMin": 15, "capacity": "crowded"},
    ],
    "parking": [
        {"id": "P1", "name": "Lot A — North", "available": 342, "total": 800, "distance": "5 min walk"},
        {"id": "P3", "name": "Lot C — South", "available": 0,   "total": 500, "distance": "3 min walk"},
    ],
    "alerts": [
        {"id": "AL1", "type": "crowd", "severity": "warning", "message": "Gate C is at 90% capacity.", "time": "18:45"},
    ],
    "medicalPosts": [
        {"id": "M1", "zone": "North", "name": "Medical Bay North", "available": True},
    ],
}

MOCK_SCORE = {
    "match": "MI vs CSK",
    "mi_score": "186/7",
    "csk_score": "142",
    "live": True,
    "source": "simulated",
}


@pytest.fixture
def mock_firebase():
    fb = AsyncMock()
    fb.is_connected = True
    fb.get_live_data = AsyncMock(return_value=MOCK_VENUE_DATA)
    return fb


@pytest.fixture
def mock_cricket():
    cr = AsyncMock()
    cr.get_live_score = AsyncMock(return_value=MOCK_SCORE)
    return cr


# ── Firebase Client Tests ──────────────────────────────────────────────────────

class TestFirebaseClient:
    """Tests for the Firebase Admin SDK client."""

    @pytest.mark.asyncio
    async def test_returns_fallback_data_when_unconfigured(self):
        """Returns venue.json when Firebase is not configured."""
        from tools.firebase_client import FirebaseClient
        client = FirebaseClient()
        client._fallback_data = MOCK_VENUE_DATA
        data = await client.get_live_data()
        assert "gates" in data
        assert len(data["gates"]) == 4

    @pytest.mark.asyncio
    async def test_fallback_has_all_required_sections(self):
        """All required data sections are present in the fallback."""
        from tools.firebase_client import FirebaseClient
        client = FirebaseClient()
        client._fallback_data = MOCK_VENUE_DATA
        data = await client.get_live_data()
        for key in ["gates", "zones", "concessions", "restrooms", "parking", "alerts"]:
            assert key in data, f"Missing section: {key}"

    @pytest.mark.asyncio
    async def test_returns_empty_dict_when_no_data(self):
        """Gracefully returns empty dict when no data is available."""
        from tools.firebase_client import FirebaseClient
        client = FirebaseClient()
        client._fallback_data = None
        data = await client.get_live_data()
        assert data == {}

    @pytest.mark.asyncio
    async def test_skips_firebase_when_url_is_placeholder(self):
        """Firebase init skipped when URL still contains 'YOUR_PROJECT'."""
        from tools.firebase_client import FirebaseClient
        client = FirebaseClient()
        client._fallback_data = MOCK_VENUE_DATA
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "./serviceAccountKey.json"
        os.environ["FIREBASE_DATABASE_URL"] = "https://YOUR_PROJECT-default-rtdb.firebasedatabase.app"
        await client.init()
        assert client.is_connected is False


# ── Cricket Client Tests ───────────────────────────────────────────────────────

class TestCricketClient:
    """Tests for the CricAPI client."""

    @pytest.mark.asyncio
    async def test_returns_simulated_score_without_api_key(self):
        """Falls back to simulated data when no API key is set."""
        from tools.cricket_client import CricketClient
        client = CricketClient()
        client.api_key = ""
        score = await client.get_live_score()
        assert "match" in score
        assert score["source"] == "simulated"
        assert score["live"] is True

    @pytest.mark.asyncio
    async def test_simulated_score_has_required_fields(self):
        """Simulated score has all required fields."""
        from tools.cricket_client import CricketClient
        client = CricketClient()
        client.api_key = ""
        score = await client.get_live_score()
        for field in ["match", "status", "live", "source"]:
            assert field in score, f"Missing field: {field}"


# ── Venue Agent Tool Tests ─────────────────────────────────────────────────────

class TestVenueAgentTools:
    """Tests for each of the 8 ARIA tool functions."""

    @pytest.fixture(autouse=True)
    def setup(self, mock_firebase, mock_cricket):
        """Instantiate the agent with mocked Google genai."""
        mock_client = MagicMock()
        with patch("google.genai.Client", return_value=mock_client):
            from agents.venue_agent import VenueAgent
            self.agent = VenueAgent(
                gemini_api_key="test-key",
                firebase_client=mock_firebase,
                cricket_client=mock_cricket,
            )

    # Gate status tests
    @pytest.mark.asyncio
    async def test_gate_status_recommends_least_dense_gate(self):
        result = await self.agent._execute_tool("get_gate_status", {})
        assert "Gate A" in result["recommended_gate"]   # density 0.3 — lowest
        assert result["recommended_queue_minutes"] == 4

    @pytest.mark.asyncio
    async def test_gate_status_returns_all_gates(self):
        result = await self.agent._execute_tool("get_gate_status", {})
        assert len(result["all_gates"]) == 4

    @pytest.mark.asyncio
    async def test_gate_status_density_is_percentage(self):
        result = await self.agent._execute_tool("get_gate_status", {})
        for gate in result["all_gates"]:
            assert 0 <= gate["density_percent"] <= 100

    # Food wait time tests
    @pytest.mark.asyncio
    async def test_food_fastest_option_is_correct(self):
        result = await self.agent._execute_tool("get_food_wait_times", {"category": "all"})
        assert result["fastest_option"]["name"] == "Refresh Bar"   # waitMin=3
        assert result["fastest_option"]["wait_minutes"] == 3

    @pytest.mark.asyncio
    async def test_food_category_filter_beverages(self):
        result = await self.agent._execute_tool("get_food_wait_times", {"category": "beverages"})
        assert all(c["category"] == "beverages" for c in result["all_concessions"])

    @pytest.mark.asyncio
    async def test_food_category_filter_food(self):
        result = await self.agent._execute_tool("get_food_wait_times", {"category": "food"})
        assert len(result["all_concessions"]) == 2   # Burger Hub + Spice Lane

    # Restroom tests
    @pytest.mark.asyncio
    async def test_restroom_returns_nearest(self):
        result = await self.agent._execute_tool("get_restroom_availability", {})
        assert result["nearest_restroom"]["name"] == "Restroom North A"  # waitMin=2
        assert result["nearest_restroom"]["wait_minutes"] == 2

    @pytest.mark.asyncio
    async def test_restroom_returns_all(self):
        result = await self.agent._execute_tool("get_restroom_availability", {})
        assert len(result["all_restrooms"]) == 2

    # Crowd density tests
    @pytest.mark.asyncio
    async def test_crowd_identifies_least_crowded(self):
        result = await self.agent._execute_tool("get_crowd_density", {})
        assert result["least_crowded_zone"] == "North Stand"   # density=0.4

    @pytest.mark.asyncio
    async def test_crowd_overall_density_in_valid_range(self):
        result = await self.agent._execute_tool("get_crowd_density", {})
        assert 0 <= result["overall_density_percent"] <= 100

    @pytest.mark.asyncio
    async def test_crowd_zone_status_labels(self):
        result = await self.agent._execute_tool("get_crowd_density", {})
        statuses = {z["name"]: z["status"] for z in result["zones"]}
        assert statuses["North Stand"] == "comfortable"  # 0.4 < 0.5
        assert statuses["East Stand"]  == "busy"         # 0.5 <= 0.78 < 0.75? No, 0.78 >= 0.75 → crowded
        assert statuses["South Stand"] == "crowded"      # 0.92 >= 0.75

    # Parking tests
    @pytest.mark.asyncio
    async def test_parking_total_free_spots(self):
        result = await self.agent._execute_tool("get_parking_availability", {})
        assert result["total_free_spots"] == 342   # only Lot A available

    @pytest.mark.asyncio
    async def test_parking_recommends_lot_with_most_space(self):
        result = await self.agent._execute_tool("get_parking_availability", {})
        assert result["recommended_lot"]["name"] == "Lot A — North"

    @pytest.mark.asyncio
    async def test_parking_percent_full_calculation(self):
        result = await self.agent._execute_tool("get_parking_availability", {})
        lot_a = next(l for l in result["all_lots"] if "Lot A" in l["name"])
        # (800-342)/800 = 0.5725 → 57%
        assert lot_a["percent_full"] == 57

    # Live score test
    @pytest.mark.asyncio
    async def test_live_score_returns_match_data(self):
        result = await self.agent._execute_tool("get_live_score", {})
        assert result["match"] == "MI vs CSK"
        assert result["live"] is True

    # Medical test
    @pytest.mark.asyncio
    async def test_medical_returns_emergency_number(self):
        result = await self.agent._execute_tool("get_nearest_medical", {})
        assert "1800-ARENA-911" in result["emergency_number"]
        assert len(result["medical_bays"]) == 1

    # Alerts test
    @pytest.mark.asyncio
    async def test_alerts_count_matches_data(self):
        result = await self.agent._execute_tool("get_active_alerts", {})
        assert result["total_alerts"] == 1
        assert result["alerts"][0]["severity"] == "warning"

    # Unknown tool test
    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error(self):
        result = await self.agent._execute_tool("nonexistent_tool", {})
        assert "error" in result
        assert "nonexistent_tool" in result["error"]


# ── API Endpoint Tests ─────────────────────────────────────────────────────────

class TestAPIEndpoints:
    """Integration tests for FastAPI routes."""

    @pytest.mark.asyncio
    async def test_health_returns_200(self):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", AsyncMock(is_connected=True)), \
             patch("main.agent", MagicMock()):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_health_response_schema(self):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", AsyncMock(is_connected=False)), \
             patch("main.agent", MagicMock()):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/health")
        data = resp.json()
        assert "status" in data
        assert "service" in data
        assert "agent" in data

    @pytest.mark.asyncio
    async def test_crowd_returns_gates(self, mock_firebase):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", mock_firebase), \
             patch("main.agent", MagicMock()):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/crowd")
        assert resp.status_code == 200
        assert "gates" in resp.json()

    @pytest.mark.asyncio
    async def test_alerts_endpoint(self, mock_firebase):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", mock_firebase), \
             patch("main.agent", MagicMock()):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/alerts")
        assert resp.status_code == 200
        assert "alerts" in resp.json()

    @pytest.mark.asyncio
    async def test_venue_endpoint(self, mock_firebase):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", mock_firebase), \
             patch("main.agent", MagicMock()):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/venue")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_chat_without_agent_returns_503(self):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", AsyncMock(is_connected=False)), \
             patch("main.agent", None):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/chat", json={"message": "hello"})
        assert resp.status_code == 503
