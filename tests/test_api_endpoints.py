"""Integration tests for Sentinel NVR FastAPI core endpoints."""

import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from api.main import app


class TestApiEndpoints(unittest.TestCase):
    def setUp(self):
        # Override auth dependency to simulate an authenticated admin session
        async def mock_open_principal(token):
            if token == "mock_admin_token":
                return {
                    "sub": "admin",
                    "role": "admin",
                    "permissions": ["live", "playback", "events", "settings"],
                }
            return None

        self.patcher = patch("api.routers.auth.open_principal", side_effect=mock_open_principal)
        self.patcher.start()
        self.client = TestClient(app, headers={"Authorization": "Bearer mock_admin_token"})

    def tearDown(self):
        self.patcher.stop()

    def test_system_health(self):
        # /system/health returns detailed host telemetry
        response = self.client.get("/system/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("cpu_usage_percent", data)
        self.assertIn("storage", data)
        self.assertIn("network", data)
        self.assertIn("record_codec", data)

    def test_system_storage_report(self):
        # /system/storage-report returns cached or live storage usage
        response = self.client.get("/system/storage-report")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("total_gb", data)
        self.assertIn("cameras", data)


if __name__ == "__main__":
    unittest.main()
