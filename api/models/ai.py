import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, DateTime, Float, ForeignKey
from sqlalchemy.orm import relationship
from pgvector.sqlalchemy import Vector
from api.database import Base


def utc_now():
    return datetime.now(timezone.utc)


class Face(Base):
    """
    Stores known faces for Facial Recognition.
    """
    __tablename__ = "faces"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False)
    
    # 512-Dimensional vector from InsightFace
    embedding = Column(Vector(512), nullable=False)
    
    thumbnail_path = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class SemanticEvent(Base):
    """
    Stores video events with their CLIP semantic embeddings for Natural Language Search.
    """
    __tablename__ = "semantic_events"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False, index=True)
    camera = relationship("Camera")
    
    # 512-Dimensional vector from CLIP (optional — not all detectors produce this)
    embedding = Column(Vector(512), nullable=True)
    
    object_class = Column(String, nullable=True, index=True)  # e.g., "person", "car"
    confidence = Column(Float, nullable=True)
    
    thumbnail_path = Column(String, nullable=True)
    clip_path = Column(String, nullable=True)
    timestamp = Column(DateTime(timezone=True), default=utc_now, index=True)
