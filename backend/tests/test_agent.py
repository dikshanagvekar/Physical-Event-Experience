"""
tests/test_agent.py — Unit tests for VenueAI backend

Run with: pytest tests/ -v
"""
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch


# ── Fixtures ──────────────────────────────────────────────────────────────────

MOCK_VENUE_DATA = {
    "gates": [
        {"id": "A", "name": "Gate A — North", "density": 0.3, "status": "open", "queue": 4},
        {"id": "B", "name": "Gate B — East",  "density": 0.75,"status": "busy", "queue": 18},
        {"id": "C", "name": "Gate C — South", "density": 0.9, "status": "crowded","queue": 32},
        {"id": "D", "name": "Gate D — West",  "density": 0.4, "status": "open", "queue": 6},
    ],
    "zones": [
        {"id": "Z1", "name": "North Stand", "section": "Lower Tier", "density": 0.4},
        {"id": "Z2", "name": "East Stand",  "section": "Upper Tier", "density": 0.78},
        {"id": "Z3", "name": "South Stand", "section": "VIP Box",    "density": 0.92},
    ],
    "concessions": [
        {"id": "C1", "name": "Burger Hub",  "category": "food",      "zone": "North", "waitMin": 5,  "items": ["Burger"]},
        {"id": "C2", "name": "Spice Lane",  "category": "food",      "zone": "East",  "waitMin": 14, "items": ["Samosa"]},
        {"id": "C4", "name": "Refresh Bar", "category": "beverages", "zone": "West",  "waitMin": 3,  "items": ["Water"]},
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
        {"id": "AL1", "type": "crowd", "severity": "warning",
         "message": "Gate C is at 90% capacity.", "time": "18:45"},
    ],
    "medicalPosts": [
        {"id": "M1", "zone": "North", "name": "Medical Bay North", "available": True},
    ],
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
    cr.get_live_score = AsyncMock(return_value={
        "match": "MI vs CSK",
        "mi_score": "186/7",
        "csk_score": "142",
        "live": True,
        "source": "simulated",
    })
    return cr


# ── Firebase Client Tests ─────────────────────────────────────────────────────

class TestFirebaseClient:
    @pytest.mark.asyncio
    async def test_get_live_data_fallback(self, tmp_path):
        """Returns fallback data when Firebase not configured."""
        from tools.firebase_client import FirebaseClient
        client = FirebaseClient()
        client._fallback_data = MOCK_VENUE_DATA
        data = await client.get_live_data()
        assert "gates" in data
        assert len(data["gates"]) == 4

    @pytest.mark.asyncio
    async def test_fallback_includes_all_sections(self, tmp_path):
        from tools.firebase_client import FirebaseClient
        client = FirebaseClient()
        client._fallback_data = MOCK_VENUE_DATA
        data = await client.get_live_data()
        for key in ["gates", "zones", "concessions", "restrooms", "parking", "alerts"]:
            assert key in data, f"Missing key: {key}"


# ── Tool Execution Tests ──────────────────────────────────────────────────────

class TestVenueAgentTools:
    """Test each tool function returns correct structure."""

    @pytest.fixture(autouse=True)
    def setup(self, mock_firebase, mock_cricket):
        """Patch the agent without real Gemini API key."""
        with patch("google.generativeai.configure"), \
             patch("google.generativeai.GenerativeModel") as mock_model:
            mock_model.return_value = MagicMock()
            from agents.venue_agent import VenueAgent
            self.agent = VenueAgent(
                gemini_api_key="test-key",
                firebase_client=mock_firebase,
                cricket_client=mock_cricket,
            )

    @pytest.mark.asyncio
    async def test_get_gate_status(self):
        result = await self.agent._execute_tool("get_gate_status", {})
        assert "recommended_gate" in result
        assert "all_gates" in result
        # Gate A should be recommended (lowest density=0.3)
        assert "Gate A" in result["recommended_gate"]
        assert result["recommended_queue_minutes"] == 4

    @pytest.mark.asyncio
    async def test_get_gate_status_all_gates_present(self):
        result = await self.agent._execute_tool("get_gate_status", {})
        assert len(result["all_gates"]) == 4

    @pytest.mark.asyncio
    async def test_get_food_wait_times_all(self):
        result = await self.agent._execute_tool("get_food_wait_times", {"category": "all"})
        assert "fastest_option" in result
        assert result["fastest_option"]["name"] == "Refresh Bar"  # waitMin=3
        assert result["fastest_option"]["wait_minutes"] == 3

    @pytest.mark.asyncio
    async def test_get_food_wait_times_filtered(self):
        result = await self.agent._execute_tool("get_food_wait_times", {"category": "food"})
        items = result["all_concessions"]
        assert all(c.get("category") == "food" or "category" not in c for c in items)

    @pytest.mark.asyncio
    async def test_get_restroom_availability(self):
        result = await self.agent._execute_tool("get_restroom_availability", {})
        assert "nearest_restroom" in result
        assert result["nearest_restroom"]["name"] == "Restroom North A"  # waitMin=2
        assert result["nearest_restroom"]["wait_minutes"] == 2

    @pytest.mark.asyncio
    async def test_get_crowd_density(self):
        result = await self.agent._execute_tool("get_crowd_density", {})
        assert "overall_density_percent" in result
        assert "least_crowded_zone" in result
        assert result["least_crowded_zone"] == "North Stand"  # density=0.4
        assert 0 <= result["overall_density_percent"] <= 100

    @pytest.mark.asyncio
    async def test_get_parking_availability(self):
        result = await self.agent._execute_tool("get_parking_availability", {})
        assert "total_free_spots" in result
        assert result["total_free_spots"] == 342  # only Lot A has spots
        assert result["recommended_lot"]["name"] == "Lot A — North"

    @pytest.mark.asyncio
    async def test_get_live_score(self):
        result = await self.agent._execute_tool("get_live_score", {})
        assert "match" in result
        assert result["live"] is True

    @pytest.mark.asyncio
    async def test_get_nearest_medical(self):
        result = await self.agent._execute_tool("get_nearest_medical", {})
        assert "medical_bays" in result
        assert "emergency_number" in result
        assert len(result["medical_bays"]) == 1

    @pytest.mark.asyncio
    async def test_get_active_alerts(self):
        result = await self.agent._execute_tool("get_active_alerts", {})
        assert "total_alerts" in result
        assert result["total_alerts"] == 1
        assert result["alerts"][0]["type"] == "crowd"

    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error(self):
        result = await self.agent._execute_tool("nonexistent_tool", {})
        assert "error" in result


# ── API Endpoint Tests ────────────────────────────────────────────────────────

class TestAPIEndpoints:
    @pytest.mark.asyncio
    async def test_health_endpoint(self):
        from httpx import AsyncClient, ASGITransport
        with patch("main.firebase", AsyncMock(is_connected=True)), \
             patch("main.agent", MagicMock()):
            from main import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_crowd_endpoint_returns_gates(self, mock_firebase):
        with patch("main.firebase", mock_firebase), \
             patch("main.agent", MagicMock()):
            from main import app
            from httpx import AsyncClient, ASGITransport
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.get("/crowd")
            assert resp.status_code == 200
            data = resp.json()
            assert "gates" in data
