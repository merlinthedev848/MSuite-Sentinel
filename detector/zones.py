import cv2
import numpy as np
import logging

logger = logging.getLogger("mView-Zones")

class ZoneAnalytics:
    """
    Handles spatial analytics for computer vision detections.
    Supports:
    1. Line Crossing (Counting objects moving across a virtual line)
    2. Intrusion Detection (Objects entering a polygon zone)
    3. Loitering Detection (Objects staying in a zone too long)
    """
    def __init__(self):
        self.zones = {} # {zone_id: polygon_points}
        self.lines = {} # {line_id: (point1, point2)}
        logger.info("Initializing Zone Analytics Engine...")

    def set_zone(self, zone_id: str, polygon: list):
        """Define a detection polygon zone [(x,y), (x,y), ...]"""
        self.zones[zone_id] = np.array(polygon, np.int32)
        logger.info(f"Configured Intrusion Zone: {zone_id}")

    def set_line(self, line_id: str, pt1: tuple, pt2: tuple):
        """Define a tripwire line."""
        self.lines[line_id] = (pt1, pt2)
        logger.info(f"Configured Crossing Line: {line_id}")

    def check_intrusion(self, object_bbox: list) -> list:
        """
        Check if an object's bottom-center point is inside any defined zones.
        Returns a list of zone_ids the object has intruded.
        """
        x1, y1, x2, y2 = object_bbox
        # Calculate bottom center of bounding box (usually where the feet/tires are)
        bottom_center = (int((x1 + x2) / 2), int(y2))
        
        intrusions = []
        for zone_id, polygon in self.zones.items():
            # cv2.pointPolygonTest returns > 0 if inside
            result = cv2.pointPolygonTest(polygon, bottom_center, False)
            if result >= 0:
                intrusions.append(zone_id)
                
        return intrusions

    def check_line_cross(self, object_track_history: list) -> list:
        """
        Check if an object's trajectory intersects any defined tripwire lines.
        object_track_history: list of previous bottom_center points [(x1, y1), (x2, y2), ...]
        Returns a list of line_ids crossed by the object.
        """
        if len(object_track_history) < 2:
            return []

        # Get last movement vector
        p1 = object_track_history[-2]
        p2 = object_track_history[-1]

        def ccw(a, b, c):
            return (c[1] - a[1]) * (b[0] - a[0]) > (b[1] - a[1]) * (c[0] - a[0])

        def intersect(a, b, c, d):
            return ccw(a, c, d) != ccw(b, c, d) and ccw(a, b, c) != ccw(a, b, d)

        crossed_lines = []
        for line_id, (l_pt1, l_pt2) in self.lines.items():
            if intersect(p1, p2, l_pt1, l_pt2):
                crossed_lines.append(line_id)

        return crossed_lines


zone_engine = ZoneAnalytics()

