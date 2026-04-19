"""Firebase Admin SDK client for VenueAI backend."""
import os
import json
import logging
import asyncio
from pathlib import Path

logger = logging.getLogger("venueai.firebase")

VENUE_JSON_PATH = Path(__file__).parent.parent.parent / "data" / "venue.json"


class FirebaseClient:
    """
    Wraps Firebase Admin SDK for server-side crowd data access.

    Priority:
      1. Firebase Realtime DB (real IoT data)
      2. Local venue.json (fallback)
    """

    def __init__(self):
        self.db = None
        self.is_connected = False
        self._fallback_data = None

    async def init(self):
        """Initialize Firebase Admin SDK."""
        creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        db_url = os.environ.get("FIREBASE_DATABASE_URL")

        # Skip Firebase if credentials file is a placeholder or missing
        if not creds_path or not db_url or "YOUR_PROJECT" in (db_url or ""):
            logger.info("ℹ️  Firebase not configured — using local venue.json (this is fine for local dev)")
            self._load_fallback()
            return

        if not Path(creds_path).exists():
            logger.warning(
                f"⚠️  Service account key not found at: {creds_path}\n"
                "   → Using local venue.json fallback\n"
                "   → To enable live Firebase data, download your key from:\n"
                "     Firebase Console → Project Settings → Service Accounts → Generate new private key"
            )
            self._load_fallback()
            return

        try:
            import firebase_admin
            from firebase_admin import credentials, db

            if not firebase_admin._apps:
                cred = credentials.Certificate(creds_path)
                firebase_admin.initialize_app(cred, {"databaseURL": db_url})

            self.db = db
            self.is_connected = True
            logger.info(f"✅ Firebase connected: {db_url}")
        except Exception as e:
            logger.warning(f"⚠️  Firebase init failed: {e} — using local venue.json fallback")
            self._load_fallback()

    def _load_fallback(self):
        """Load venue.json as fallback data source."""
        try:
            with open(VENUE_JSON_PATH) as f:
                self._fallback_data = json.load(f)
            logger.info("📄 Fallback: loaded venue.json")
        except Exception as e:
            logger.error(f"Could not load venue.json: {e}")
            self._fallback_data = {}

    async def get_live_data(self) -> dict:
        """Get live crowd data — Firebase or fallback."""
        if self.is_connected and self.db:
            try:
                loop = asyncio.get_event_loop()
                ref = self.db.reference("/liveData")
                data = await loop.run_in_executor(None, ref.get)
                if data:
                    return data
            except Exception as e:
                logger.warning(f"Firebase read failed: {e} — using fallback")

        return self._fallback_data or {}

    async def push_update(self, path: str, value) -> bool:
        """Push a live update (for admin/IoT use)."""
        if not self.is_connected:
            return False
        try:
            loop = asyncio.get_event_loop()
            ref = self.db.reference(f"/liveData/{path}")
            await loop.run_in_executor(None, ref.set, value)
            return True
        except Exception as e:
            logger.error(f"Firebase push failed: {e}")
            return False
