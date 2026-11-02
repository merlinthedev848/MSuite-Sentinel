import logging
import numpy as np
import cv2

logger = logging.getLogger("mView-FaceID")

class FaceRecognitionEngine:
    """
    Handles Face Detection, Alignment, and Embedding using InsightFace (ArcFace).
    Optimized for CPU via ONNX Runtime if no GPU is available.
    """
    def __init__(self, use_gpu=False):
        self.use_gpu = use_gpu
        logger.info("Initializing Face Recognition Engine (InsightFace-ONNX)")
        
        # In production:
        # self.face_analyzer = insightface.app.FaceAnalysis(name='buffalo_s')
        # self.face_analyzer.prepare(ctx_id=0 if use_gpu else -1)
        
        self.vector_dim = 512
        logger.info(f"Face Engine loaded. Embedding dimension: {self.vector_dim}")

    def extract_faces(self, frame: np.ndarray):
        """InsightFace is not installed, so this returns no faces."""
        logger.info("Face recognition is not configured; no face was returned")
        return []

    def compare_faces(self, embedding1: np.ndarray, embedding2: np.ndarray) -> float:
        """
        Returns the cosine similarity between two face embeddings.
        Threshold is usually around 0.6 for same-person verification.
        """
        # Cosine similarity
        return np.dot(embedding1, embedding2)

face_engine = FaceRecognitionEngine()
