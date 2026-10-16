import uuid
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from api.database import get_db
from api.models.operations import AlertRule

router = APIRouter(prefix="/automations", tags=["automations"])


class AutomationRule(BaseModel):
    id: Optional[str] = None
    name: str
    trigger_event: str  # "person_detected", "motion", "camera_tampered", "signal_loss"
    camera_id: Optional[str] = None
    webhook_url: Optional[str] = None
    mqtt_topic: Optional[str] = None
    enabled: bool = True


@router.get("", response_model=List[AutomationRule])
async def list_automations(db: AsyncSession = Depends(get_db)):
    """List all registered webhook & automation rules from database."""
    result = await db.execute(select(AlertRule).order_by(AlertRule.created_at.desc()))
    rules = []
    for row in result.scalars().all():
        cfg = row.config or {}
        if cfg.get("type") == "automation" or "trigger_event" in cfg:
            rules.append(AutomationRule(
                id=row.id,
                name=row.name,
                trigger_event=cfg.get("trigger_event", "person_detected"),
                camera_id=cfg.get("camera_id"),
                webhook_url=cfg.get("webhook_url"),
                mqtt_topic=cfg.get("mqtt_topic"),
                enabled=row.enabled,
            ))
    return rules


@router.post("", response_model=AutomationRule)
async def create_automation(rule: AutomationRule, db: AsyncSession = Depends(get_db)):
    """Create or update an automation rule in database."""
    rule_id = rule.id or f"rule_{str(uuid.uuid4())[:8]}"

    existing = await db.get(AlertRule, rule_id) if rule.id else None
    config_dict = {
        "type": "automation",
        "trigger_event": rule.trigger_event,
        "camera_id": rule.camera_id,
        "webhook_url": rule.webhook_url,
        "mqtt_topic": rule.mqtt_topic,
    }

    if existing:
        existing.name = rule.name
        existing.enabled = rule.enabled
        existing.config = config_dict
    else:
        new_row = AlertRule(
            id=rule_id,
            name=rule.name,
            enabled=rule.enabled,
            severity="medium",
            config=config_dict
        )
        db.add(new_row)

    await db.commit()
    out = rule.model_dump()
    out["id"] = rule_id
    return out


@router.delete("/{rule_id}")
async def delete_automation(rule_id: str, db: AsyncSession = Depends(get_db)):
    """Delete an automation rule."""
    existing = await db.get(AlertRule, rule_id)
    if not existing:
        raise HTTPException(404, "Rule not found")

    await db.delete(existing)
    await db.commit()
    return {"status": "deleted"}
