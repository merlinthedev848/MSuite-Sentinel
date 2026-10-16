from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.models.user import User
from api.routers.auth import get_current_user, get_password_hash, verify_password

router = APIRouter(prefix="/users", tags=["users"])

Permission = Literal["live", "playback", "events", "settings", "operations"]
Role = Literal["admin", "operator", "viewer"]


class UserResponse(BaseModel):
    id: str
    username: str
    role: str
    permissions: list[str]
    created_at: datetime | None = None


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=4, max_length=256)
    role: Role = "viewer"
    permissions: list[Permission] = Field(default_factory=lambda: ["live"])


class PasswordUpdate(BaseModel):
    current_password: str | None = None
    new_password: str = Field(min_length=4, max_length=256)


class UserUpdate(BaseModel):
    username: str | None = Field(None, min_length=2, max_length=64)
    role: Role | None = None
    permissions: list[Permission] | None = None
    password: str | None = Field(None, min_length=4, max_length=256)


def _admin_permissions(role: str, permissions: list[str]) -> list[str]:
    return ["live", "playback", "events", "settings", "operations"] if role == "admin" else permissions


def _serialize(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        username=user.username,
        role=user.role,
        permissions=user.permissions or [],
        created_at=user.created_at,
    )


def _require_admin(current_user: dict):
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")


@router.get("", response_model=list[UserResponse])
async def list_users(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    result = await db.execute(select(User).order_by(User.created_at.asc()))
    return [_serialize(user) for user in result.scalars().all()]


@router.post("", response_model=UserResponse, status_code=201)
async def create_user(
    payload: UserCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    username = payload.username.strip()
    existing = await db.execute(select(User).where(User.username == username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already exists")

    user = User(
        username=username,
        hashed_password=get_password_hash(payload.password),
        role=payload.role,
        permissions=_admin_permissions(payload.role, list(payload.permissions)),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _serialize(user)


@router.delete("/{user_id}")
async def delete_user(
    user_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    if current_user.get("id") == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.username == "admin":
        raise HTTPException(status_code=400, detail="Default admin account cannot be deleted")

    await db.delete(user)
    await db.commit()
    return {"status": "deleted"}


@router.patch("/{user_id}/password")
async def update_password(
    user_id: str,
    payload: PasswordUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    is_admin = current_user.get("role") == "admin"
    is_self = current_user.get("id") == user_id
    if not is_admin and not is_self:
        raise HTTPException(status_code=403, detail="You can only change your own password")

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not is_admin:
        if not payload.current_password or not verify_password(payload.current_password, user.hashed_password):
            raise HTTPException(status_code=400, detail="Current password is incorrect")

    user.hashed_password = get_password_hash(payload.new_password)
    await db.commit()
    return {"status": "updated"}


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: str,
    payload: UserUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.username is not None:
        username = payload.username.strip()
        if username != user.username:
            existing = await db.execute(select(User).where(User.username == username))
            if existing.scalar_one_or_none():
                raise HTTPException(status_code=409, detail="Username already exists")
            user.username = username

    if payload.role is not None:
        user.role = payload.role

    if payload.permissions is not None:
        user.permissions = _admin_permissions(user.role, list(payload.permissions))
    elif payload.role is not None:
        user.permissions = _admin_permissions(user.role, list(user.permissions or []))

    if payload.password is not None:
        user.hashed_password = get_password_hash(payload.password)

    await db.commit()
    await db.refresh(user)
    return _serialize(user)
