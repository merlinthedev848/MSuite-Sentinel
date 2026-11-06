"""Unit tests for playback timeline snapping, gap calculation, and seek calculations."""

import unittest

# 24 hour snapping limit matching frontend MAX_GAP_SNAP_MS
MAX_GAP_SNAP_MS = 24 * 60 * 60 * 1000


def resolve_playback_target(clips: list[dict], target_ms: int, find_nearest: bool = False) -> dict | None:
    if not clips or target_ms is None:
        return None
    ordered = sorted(clips, key=lambda c: c["startTimestamp"])

    for clip in ordered:
        if clip["startTimestamp"] <= target_ms < clip["endTimestamp"]:
            seek_ms = min(target_ms, max(clip["startTimestamp"], clip["endTimestamp"] - 250))
            return {**clip, "seekMs": seek_ms}

    if not find_nearest:
        return None

    upcoming = next((c for c in ordered if c["startTimestamp"] >= target_ms), None)
    previous = next((c for c in reversed(ordered) if c["endTimestamp"] <= target_ms), None)

    upcoming_dist = abs(upcoming["startTimestamp"] - target_ms) if upcoming else float("inf")
    previous_dist = abs(target_ms - previous["endTimestamp"]) if previous else float("inf")

    if upcoming and upcoming_dist <= previous_dist and upcoming_dist <= MAX_GAP_SNAP_MS:
        return {**upcoming, "seekMs": upcoming["startTimestamp"]}
    if previous and previous_dist <= MAX_GAP_SNAP_MS:
        return {**previous, "seekMs": max(previous["startTimestamp"], previous["endTimestamp"] - 250)}
    if upcoming and upcoming_dist <= MAX_GAP_SNAP_MS:
        return {**upcoming, "seekMs": upcoming["startTimestamp"]}
    return None


class TestPlaybackSeek(unittest.TestCase):
    def setUp(self):
        # 3 clips spaced 1 hour apart, each 10 minutes (600,000 ms) long
        self.t0 = 1700000000000
        self.clips = [
            {"url": "/rec/cam1/seg1.mp4", "startTimestamp": self.t0, "endTimestamp": self.t0 + 600000},
            {"url": "/rec/cam1/seg2.mp4", "startTimestamp": self.t0 + 3600000, "endTimestamp": self.t0 + 4200000},
            {"url": "/rec/cam1/seg3.mp4", "startTimestamp": self.t0 + 7200000, "endTimestamp": self.t0 + 7800000},
        ]

    def test_direct_hit_inside_segment(self):
        # Seek into middle of segment 1
        target = self.t0 + 300000
        hit = resolve_playback_target(self.clips, target, find_nearest=False)
        self.assertIsNotNone(hit)
        self.assertEqual(hit["url"], "/rec/cam1/seg1.mp4")
        self.assertEqual(hit["seekMs"], target)

    def test_gap_without_nearest(self):
        # Seek into gap between seg 1 and seg 2 without find_nearest
        target = self.t0 + 1500000
        hit = resolve_playback_target(self.clips, target, find_nearest=False)
        self.assertIsNone(hit)

    def test_gap_snaps_to_nearest_segment_forward(self):
        # 10 minutes before seg 2 starts -> should snap to start of seg 2
        target = self.t0 + 3000000
        hit = resolve_playback_target(self.clips, target, find_nearest=True)
        self.assertIsNotNone(hit)
        self.assertEqual(hit["url"], "/rec/cam1/seg2.mp4")
        self.assertEqual(hit["seekMs"], self.clips[1]["startTimestamp"])

    def test_gap_snaps_to_nearest_segment_backward(self):
        # 5 minutes after seg 1 ends -> should snap to end of seg 1
        target = self.t0 + 900000
        hit = resolve_playback_target(self.clips, target, find_nearest=True)
        self.assertIsNotNone(hit)
        self.assertEqual(hit["url"], "/rec/cam1/seg1.mp4")
        self.assertEqual(hit["seekMs"], self.clips[0]["endTimestamp"] - 250)

    def test_multi_hour_gap_snaps_under_24h_window(self):
        # 4 hours after seg 3 ends
        target = self.t0 + 7800000 + 4 * 3600 * 1000
        hit = resolve_playback_target(self.clips, target, find_nearest=True)
        self.assertIsNotNone(hit)
        self.assertEqual(hit["url"], "/rec/cam1/seg3.mp4")


if __name__ == "__main__":
    unittest.main()
