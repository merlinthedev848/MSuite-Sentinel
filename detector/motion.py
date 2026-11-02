import cv2
import numpy as np
import logging

logger = logging.getLogger("mView-Motion")

class MotionGating:
    """
    Background subtractor used as a pre-filter before running expensive YOLO inference.
    If no pixel change is detected (nobody moving), we skip running the neural network
    to massively save CPU/GPU cycles.
    """
    def __init__(self, threshold=500):
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=16, detectShadows=False)
        self.threshold = threshold
        logger.info("Motion Gating Engine Initialized.")

    def reset(self) -> None:
        """Drop the background model when the detector moves to another camera."""
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=500, varThreshold=16, detectShadows=False
        )

    def has_motion(self, frame: np.ndarray) -> bool:
        """
        Returns True if motion (pixel change) exceeds the threshold.
        """
        # Downscale for faster processing
        small_frame = cv2.resize(frame, (640, 360))
        fg_mask = self.bg_subtractor.apply(small_frame)
        
        # Count non-zero (white) pixels in the mask
        motion_pixels = cv2.countNonZero(fg_mask)
        
        return motion_pixels > self.threshold

motion_gate = MotionGating()
