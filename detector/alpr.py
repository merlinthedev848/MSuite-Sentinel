import logging
import cv2
import numpy as np

logger = logging.getLogger("mView-ALPR")

class ALPREngine:
    """
    License Plate Recognition (ALPR) pipeline.
    This triggers when the primary YOLO model detects a 'vehicle'.
    It crops the vehicle and runs a secondary OCR model (like Tesseract or LPRNet)
    to extract the license plate text.
    """
    def __init__(self, use_gpu=False):
        self.use_gpu = use_gpu
        logger.info("Initializing ALPR Engine (OCR Pipeline)...")
        # In a real deployment, we'd load LPRNet or a Tesseract wrapper here.
        # e.g., self.reader = easyocr.Reader(['en'], gpu=self.use_gpu)

    def extract_plate(self, vehicle_image: np.ndarray) -> str | None:
        """No OCR engine is installed, so this never invents a plate."""
        logger.info("ALPR is not configured; no license plate was read")
        return None

alpr_engine = ALPREngine()
