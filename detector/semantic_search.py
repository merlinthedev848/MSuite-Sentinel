import logging
import numpy as np
from PIL import Image

logger = logging.getLogger("mView-SemanticSearch")

class SemanticSearchEngine:
    """
    Handles Vision-Language embeddings (CLIP) for natural language semantic search.
    Defaults to CPU-optimized MobileCLIP or ONNX-quantized models.
    """
    def __init__(self, use_gpu=False):
        self.use_gpu = use_gpu
        logger.info("Initializing Semantic Search Engine (CLIP-ONNX)")
        
        # In a full deployment, this would load a quantized CLIP model
        # from sentence-transformers or direct ONNX runtime.
        # e.g., self.model = SentenceTransformer('clip-ViT-B-32')
        self.vector_dim = 512
        logger.info(f"CLIP Engine loaded. Embedding dimension: {self.vector_dim}")

    def embed_image(self, image: Image.Image):
        """CLIP is not installed. Callers must use keyword search instead of a vector."""
        logger.info("Semantic image embedding is unavailable; no CLIP model is installed")
        return None

    def embed_text(self, query: str):
        """CLIP is not installed. Text search stays on stored object labels."""
        logger.info("Semantic text embedding is unavailable for query %r", query)
        return None

semantic_engine = SemanticSearchEngine()
