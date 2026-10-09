import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, JSON, String

from api.database import Base


def utc_now():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    username = Column(String, nullable=False, unique=True, index=True)
    hashed_password = Column(String, nullable=False)
    role = Column(String, nullable=False, default="viewer")
    permissions = Column(JSON, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), default=utc_now)
