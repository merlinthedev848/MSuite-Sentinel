import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Boolean, DateTime, JSON
from api.database import Base


def utc_now():
    return datetime.now(timezone.utc)


class Camera(Base):
    __tablename__ = "cameras"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False)
    
    # Streaming URLs
    rtsp_url_main = Column(String, nullable=True)
    rtsp_url_sub = Column(String, nullable=True)
    
    # ONVIF details for Auto-Adopt
    onvif_endpoint = Column(String, nullable=True)
    onvif_username = Column(String, nullable=True)
    onvif_password = Column(String, nullable=True)
    
    # Camera Metadata
    manufacturer = Column(String, nullable=True)
    model = Column(String, nullable=True)
    resolution = Column(String, nullable=True)
    
    # Status & Configuration
    status = Column(String, default="offline", index=True)  # online, offline, recording, adopting
    enabled = Column(Boolean, default=True)
    auto_adopted = Column(Boolean, default=False)
    config = Column(JSON, nullable=True)  # Custom JSON config for overriding global defaults
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), default=utc_now)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
