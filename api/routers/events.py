import os
import uuid
import time
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, Query, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, not_, exists

from api.database import get_db, engine
from api.models.ai import SemanticEvent as Event
from api.models.operations import EventReview

router = APIRouter(prefix="/events", tags=["events"])


class EventSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    camera_id: Optional[str] = None
    limit: int = Field(default=50, ge=1, le=200)
    min_confidence: float = Field(default=0.3, ge=0.0, le=1.0)


@router.get("")
async def get_events(
    camera_id: Optional[str] = None,
    object_class: Optional[str] = None,
    unreviewed_only: bool = False,
    limit: int = 50,
    db: AsyncSession = Depends(get_db)
):
    """Retrieve AI events with optional filtering, projecting only required metadata columns."""
    query = select(
        Event.id,
        Event.camera_id,
        Event.object_class,
        Event.confidence,
        Event.timestamp,
        Event.thumbnail_path,
    ).order_by(desc(Event.timestamp))

    if camera_id:
        query = query.where(Event.camera_id == camera_id)
    if object_class:
        query = query.where(Event.object_class == object_class)
    if unreviewed_only:
        stmt = exists().where(EventReview.event_id == Event.id).where(EventReview.verdict == 'reviewed')
        query = query.where(not_(stmt))

    query = query.limit(min(max(limit, 1), 5000))
    result = await db.execute(query)
    events = result.all()

    event_ids = [e.id for e in events]
    reviews = {}
    if event_ids:
        review_result = await db.execute(select(EventReview).where(EventReview.event_id.in_(event_ids)))
        reviews = {review.event_id: review for review in review_result.scalars().all()}

    return [
        {
            "id": str(e.id),
            "camera_id": e.camera_id,
            "object_class": e.object_class or "unknown",
            "confidence": e.confidence,
            "timestamp": e.timestamp.isoformat() if e.timestamp else None,
            "has_thumbnail": bool(e.thumbnail_path and os.path.exists(e.thumbnail_path)),
            "review": {
                "verdict": reviews[e.id].verdict,
                "note": reviews[e.id].note or "",
                "tags": (reviews[e.id].config or {}).get("tags", []),
            } if e.id in reviews else None,
        }
        for e in events
    ]


@router.post("/search")
async def search_events(req: EventSearchRequest, db: AsyncSession = Depends(get_db)):
    """Search stored object labels. A CLIP embedding model is not installed."""
    search_term = req.query.strip()
    if not search_term:
        raise HTTPException(status_code=400, detail="Search query cannot be empty")

    keywords = search_term.lower().split()
    stmt = select(
        Event.id,
        Event.camera_id,
        Event.object_class,
        Event.confidence,
        Event.timestamp,
        Event.thumbnail_path,
    ).order_by(desc(Event.timestamp))

    if req.camera_id:
        stmt = stmt.where(Event.camera_id == req.camera_id)
    if req.min_confidence > 0:
        stmt = stmt.where(Event.confidence >= req.min_confidence)

    for kw in keywords:
        stmt = stmt.where(Event.object_class.ilike(f"%{kw}%"))

    stmt = stmt.limit(req.limit)
    result = await db.execute(stmt)
    events = result.all()

    event_ids = [e.id for e in events]
    reviews = {}
    if event_ids:
        review_result = await db.execute(select(EventReview).where(EventReview.event_id.in_(event_ids)))
        reviews = {review.event_id: review for review in review_result.scalars().all()}

    return {
        "mode": "keyword",
        "engine": "unavailable",
        "results": [
            {
                "id": str(e.id),
                "search_mode": "keyword",
                "camera_id": e.camera_id,
                "object_class": e.object_class or "unknown",
                "confidence": e.confidence,
                "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                "has_thumbnail": bool(e.thumbnail_path and os.path.exists(e.thumbnail_path)),
                "review": {
                    "verdict": reviews[e.id].verdict,
                    "note": reviews[e.id].note or "",
                    "tags": (reviews[e.id].config or {}).get("tags", []),
                } if e.id in reviews else None,
            }
            for e in events
        ],
    }


_ANALYTICS_CACHE: Dict[str, Any] = {"timestamp": 0.0, "data": None}
_ANALYTICS_LOCK = asyncio.Lock()


@router.get("/analytics")
async def get_event_analytics(db: AsyncSession = Depends(get_db)):
    """Retrieve fast 24h event analytics and category breakdown with stampede-protected caching."""
    now_ts = time.time()
    if _ANALYTICS_CACHE["data"] is not None and (now_ts - _ANALYTICS_CACHE["timestamp"]) < 15.0:
        return _ANALYTICS_CACHE["data"]

    async with _ANALYTICS_LOCK:
        if _ANALYTICS_CACHE["data"] is not None and (time.time() - _ANALYTICS_CACHE["timestamp"]) < 15.0:
            return _ANALYTICS_CACHE["data"]

        now = datetime.now(timezone.utc)
        since = now - timedelta(hours=24)

        query = select(Event.timestamp, Event.object_class).where(Event.timestamp >= since).order_by(Event.timestamp.asc())
        result = await db.execute(query)
        events = result.all()

        hourly_counts = {(now - timedelta(hours=i)).strftime("%H:00"): 0 for i in range(23, -1, -1)}
        class_counts: Dict[str, int] = {}

        for ts, obj_class in events:
            if ts:
                h_str = ts.strftime("%H:00")
                if h_str in hourly_counts:
                    hourly_counts[h_str] += 1
                else:
                    hourly_counts[h_str] = 1
            cls = obj_class or "other"
            class_counts[cls] = class_counts.get(cls, 0) + 1

        hourly = [{"hour": k, "count": v} for k, v in hourly_counts.items()]
        top_classes = [{"class": k, "count": v} for k, v in sorted(class_counts.items(), key=lambda x: x[1], reverse=True)]

        payload = {
            "total_events": len(events),
            "hourly": hourly,
            "top_classes": top_classes
        }
        _ANALYTICS_CACHE["timestamp"] = time.time()
        _ANALYTICS_CACHE["data"] = payload
        return payload


@router.get("/{event_id}/thumbnail")
async def get_event_thumbnail(event_id: str, db: AsyncSession = Depends(get_db)):
    from api.security import contained_path
    event = await db.get(Event, event_id)
    thumb = contained_path(settings.thumbnail_path, event.thumbnail_path) if event and event.thumbnail_path else None
    if thumb is None or not thumb.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(str(thumb), media_type="image/jpeg")


@router.delete("/{event_id}")
async def delete_event(event_id: str, db: AsyncSession = Depends(get_db)):
    event = await db.get(Event, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if event.thumbnail_path and os.path.isfile(event.thumbnail_path):
        try:
            os.unlink(event.thumbnail_path)
        except OSError:
            pass

    await db.delete(event)
    await db.commit()
    return {"status": "deleted"}


@router.patch("/{event_id}/review")
async def mark_event_reviewed(event_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(EventReview).where(EventReview.event_id == event_id))
    review = result.scalars().first()
    if review:
        review.verdict = 'reviewed'
    else:
        review = EventReview(id=str(uuid.uuid4()), event_id=event_id, verdict='reviewed')
        db.add(review)
    await db.commit()
    return {"status": "success"}
