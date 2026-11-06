"""Unit tests for Sentinel NVR recorder service, caching, and stream helpers."""

import unittest
from pathlib import Path
from unittest.mock import patch

from api.services import recorder


class TestRecorderService(unittest.TestCase):
    def setUp(self):
        recorder.invalidate_storage_cache()

    def tearDown(self):
        recorder.invalidate_storage_cache()

    def test_mask_rtsp_url_with_credentials(self):
        raw = "rtsp://admin:SecretPass123!@192.168.1.50:554/Streaming/Channels/101"
        masked = recorder.mask_rtsp_url(raw)
        self.assertNotIn("SecretPass123!", masked)
        self.assertIn("admin:*****", masked)
        self.assertIn("192.168.1.50:554/Streaming/Channels/101", masked)

    def test_mask_rtsp_url_no_credentials(self):
        raw = "rtsp://192.168.1.50:554/live"
        masked = recorder.mask_rtsp_url(raw)
        self.assertEqual(masked, raw)

    def test_mask_rtsp_url_empty_or_none(self):
        self.assertEqual(recorder.mask_rtsp_url(None), "")
        self.assertEqual(recorder.mask_rtsp_url(""), "")

    def test_browser_stream_sources(self):
        rtsp = "rtsp://10.0.0.10:554/stream1"
        sources = recorder.browser_stream_sources("front_door", rtsp)
        self.assertIn(rtsp, sources)
        self.assertTrue(any("ffmpeg:front_door#video=h264" in s for s in sources))
        self.assertTrue(any("ffmpeg:front_door#audio=aac" in s for s in sources))

    def test_moov_at_start_true(self):
        fake_data = b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x08moov" + (b"\x00" * 1024)
        mock_path = Path("fake_file.mp4")
        with patch("builtins.open", unittest.mock.mock_open(read_data=fake_data)):
            self.assertTrue(recorder.moov_at_start(mock_path))

    def test_moov_at_start_false(self):
        fake_data = b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x08mdat" + (b"\x00" * 1024)
        mock_path = Path("fake_file.mp4")
        with patch("builtins.open", unittest.mock.mock_open(read_data=fake_data)):
            self.assertFalse(recorder.moov_at_start(mock_path))

    def test_storage_report_caching_and_invalidation(self):
        # 1. Initial report
        rep1 = recorder.storage_report()
        self.assertIn("total_gb", rep1)
        self.assertIn("cameras", rep1)

        # 2. Cache should now be populated
        self.assertIsNotNone(recorder._STORAGE_REPORT_CACHE)
        self.assertEqual(recorder._STORAGE_REPORT_CACHE["total_gb"], rep1["total_gb"])

        # 3. Subsequent call within 60s returns cached object
        rep2 = recorder.storage_report()
        self.assertEqual(rep1, rep2)

        # 4. Invalidation clears cache
        recorder.invalidate_storage_cache()
        self.assertIsNone(recorder._STORAGE_REPORT_CACHE)


if __name__ == "__main__":
    unittest.main()
