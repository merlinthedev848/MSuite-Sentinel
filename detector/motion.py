import cv2
import numpy as np
import logging

logger = logging.getLogger("mView-Motion")

class MotionGating:
    """
    Background subtractor used as a pre-filter before running expensive YOLO inference.
    If no pixel change is detected (nobody moving), we skip running the neural network
    to massively save CPU/GPU cycles.
    Maintains per-camera background models so switching cameras does not discard learned scene models.
    """
    def __init__(self, threshold=500):
        self._subtractors: dict[str, cv2.BackgroundSubtractorMOG2] = {}
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=16, detectShadows=False)
        self.threshold = threshold
        logger.info("Motion Gating Engine Initialized.")

    def _get_subtractor(self, camera_id: str | None = None) -> cv2.BackgroundSubtractorMOG2:
        if not camera_id:
            return self.bg_subtractor
        if camera_id not in self._subtractors:
            self._subtractors[camera_id] = cv2.createBackgroundSubtractorMOG2(
                history=500, varThreshold=16, detectShadows=False
            )
        return self._subtractors[camera_id]

    def reset(self, camera_id: str | None = None) -> None:
        """Drop the background model when the detector moves to another camera or explicitly requested."""
        if camera_id and camera_id in self._subtractors:
            del self._subtractors[camera_id]
        else:
            self._subtractors.clear()
            self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
                history=500, varThreshold=16, detectShadows=False
            )

    def has_motion(self, frame: np.ndarray, camera_id: str | None = None) -> bool:
        """
        Returns True if motion (pixel change) exceeds the threshold.
        """
        if frame is None or getattr(frame, "size", 0) == 0:
            return False
        try:
            # Downscale for faster processing
            small_frame = cv2.resize(frame, (640, 360))
            subtractor = self._get_subtractor(camera_id)
            fg_mask = subtractor.apply(small_frame)
            
            # Count non-zero (white) pixels in the mask
            motion_pixels = cv2.countNonZero(fg_mask)
            
            return motion_pixels > self.threshold
        except Exception as exc:
            logger.debug("Motion gating error: %s", exc)
            return True

motion_gate = MotionGating()
