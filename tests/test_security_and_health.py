"""Unit tests for Sentinel NVR security sanitizers and telemetry validation."""

import unittest
from pathlib import Path
from api.security import (
    can_view_secrets,
    contained_path,
    is_masked_rtsp,
    is_masked_secret,
    mask_rtsp_url,
    mask_secret,
    safe_camera_id,
    webhook_target_allowed,
)


class TestSecurityAndHealth(unittest.TestCase):
    def test_safe_camera_id_valid(self):
        valid_ids = ["cam1", "driveway_01", "front-door", "CAM_NORTH-123"]
        for cid in valid_ids:
            self.assertEqual(safe_camera_id(cid), cid)

    def test_safe_camera_id_path_traversal(self):
        bad_ids = ["../etc/passwd", "..\\windows\\system32", "cam/sub", "cam\\sub"]
        for cid in bad_ids:
            with self.assertRaises(ValueError):
                safe_camera_id(cid)

    def test_contained_path(self):
        root = Path("C:/storage/recordings")
        safe_child = Path("C:/storage/recordings/cam1/segment.mp4")
        traversal = Path("C:/storage/recordings/../../windows/system32")

        self.assertIsNotNone(contained_path(root, safe_child))
        self.assertIsNone(contained_path(root, traversal))

    def test_mask_secret(self):
        self.assertEqual(mask_secret("MySuperSecretToken"), "********")
        self.assertTrue(is_masked_secret("********"))
        self.assertTrue(is_masked_secret("***"))
        self.assertFalse(is_masked_secret("real_password"))

    def test_webhook_target_allowed(self):
        # Disallow loopback and cloud metadata
        self.assertFalse(webhook_target_allowed("http://localhost/hook"))
        self.assertFalse(webhook_target_allowed("http://127.0.0.1:8080/hook"))
        self.assertFalse(webhook_target_allowed("http://metadata.google.internal/computeMetadata"))


if __name__ == "__main__":
    unittest.main()
