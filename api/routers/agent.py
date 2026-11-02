import httpx
import os
import json
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from api.database import get_db
from api.models.camera import Camera
from api.models.ai import SemanticEvent
from api.config import settings

logger = logging.getLogger("mView-Agent")
router = APIRouter(prefix="/agent", tags=["agent"])

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = [] # [{"role": "user"|"model", "content": "..."}]

# --- Agent Tools Python Implementation ---

async def run_get_system_health(db: AsyncSession) -> str:
    import psutil
    cpu = psutil.cpu_percent()
    mem = psutil.virtual_memory().percent
    rec_path = settings.recordings_dir
    os.makedirs(rec_path, exist_ok=True)
    disk = psutil.disk_usage(rec_path).percent
    return f"CPU: {cpu}%, Memory: {mem}%, Recordings Disk Usage: {disk}%"

async def run_get_cameras(db: AsyncSession) -> str:
    result = await db.execute(select(Camera))
    cams = result.scalars().all()
    if not cams:
        return "No cameras configured."
    return "\n".join([f"- Name: {c.name}, ID: {c.id}, Location: {c.location or 'Unassigned'}, Status: {c.status}, ONVIF: {'Yes' if c.onvif_endpoint else 'No'}" for c in cams])

async def run_update_camera(db: AsyncSession, camera_id: str, name: str = None, location: str = None, rtsp_url_main: str = None, rtsp_url_sub: str = None) -> str:
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    cam = result.scalar_one_or_none()
    if not cam:
        return f"Camera with ID {camera_id} not found."
    
    if name:
        cam.name = name
    if location:
        cam.location = location
    if rtsp_url_main or rtsp_url_sub:
        return "Refusing to change a camera stream URL from the assistant. Update streams from Settings."
        
    await db.commit()
    from api.services.recorder import recorder_manager
    result = await db.execute(select(Camera))
    await recorder_manager.sync_cameras(result.scalars().all())
    return f"Successfully updated camera '{cam.name}'."

async def run_update_system_config(db: AsyncSession, retention_days: int = None) -> str:
    if retention_days is not None:
        settings.retention_days = retention_days
        return f"System video retention set to {retention_days} days."
    return "No configurations updated."

async def run_get_recent_events(db: AsyncSession, limit: int = 10) -> str:
    result = await db.execute(select(SemanticEvent).order_by(SemanticEvent.timestamp.desc()).limit(limit))
    events = result.scalars().all()
    if not events:
        return "No recent events logged."
    return "\n".join([f"- {e.timestamp.strftime('%H:%M:%S')}: {e.object_class} (Confidence: {int((e.confidence or 0)*100)}%) on Camera {e.camera_id[:8]}" for e in events])

async def execute_tool(name: str, args: dict, db: AsyncSession) -> str:
    try:
        if name == "get_system_health":
            return await run_get_system_health(db)
        elif name == "get_cameras":
            return await run_get_cameras(db)
        elif name == "update_camera":
            return await run_update_camera(db, **args)
        elif name == "update_system_config":
            return await run_update_system_config(db, **args)
        elif name == "get_recent_events":
            return await run_get_recent_events(db, **args)
    except Exception as e:
        logger.error(f"Error executing agent tool {name}: {e}")
        return f"Error executing tool: {str(e)}"
    return f"Unknown tool: {name}"

async def handle_gemini_agent(req: ChatRequest, db: AsyncSession) -> dict:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={settings.gemini_api_key}"
    
    contents = []
    for item in req.history:
        role = "user" if item.get("role") == "user" else "model"
        contents.append({
            "role": role,
            "parts": [{"text": item.get("content", "")}]
        })
    contents.append({
        "role": "user",
        "parts": [{"text": req.message}]
    })

    tools = [
        {
            "functionDeclarations": [
                {
                    "name": "get_system_health",
                    "description": "Get NVR system health, including CPU, memory, and disk usage."
                },
                {
                    "name": "get_cameras",
                    "description": "List all configured cameras with their IDs, names, and online status."
                },
                {
                    "name": "update_camera",
                    "description": "Rename a camera or change its location. Stream URLs are changed in Settings.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "camera_id": {"type": "STRING", "description": "The unique UUID of the camera."},
                            "name": {"type": "STRING", "description": "New name of the camera."},
                            "location": {"type": "STRING", "description": "New location of the camera."}
                        },
                        "required": ["camera_id"]
                    }
                },
                {
                    "name": "update_system_config",
                    "description": "Update system configuration settings like video retention days.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "retention_days": {"type": "INTEGER", "description": "Number of days to keep video recordings."}
                        }
                    }
                },
                {
                    "name": "get_recent_events",
                    "description": "Retrieve recent AI security events log.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "limit": {"type": "INTEGER", "description": "Maximum number of events to return."}
                        }
                    }
                }
            ]
        }
    ]

    payload = {
        "contents": contents,
        "tools": tools,
        "systemInstruction": {
            "parts": [{"text": "You are the Sentinel NVR Active AI Operator. You have direct control over camera configuration, system health query, and settings. Be helpful, concise, and professional. Always tell the user when you perform actions."}]
        }
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                logger.error(f"Gemini API returned status {resp.status_code}: {resp.text}")
                return {"response": f"Gemini API error ({resp.status_code}): {resp.text[:200]}"}
            
            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                return {"response": "No response generated by model."}
            
            parts = candidates[0].get("content", {}).get("parts", [])
            function_calls = [p["functionCall"] for p in parts if isinstance(p, dict) and "functionCall" in p]
            
            if function_calls:
                call = function_calls[0]
                func_name = call.get("name")
                func_args = call.get("args", {})
                
                logger.info(f"AI Operator triggered function call: {func_name} with {func_args}")
                tool_result = await execute_tool(func_name, func_args, db)
                
                contents.append({
                    "role": "model",
                    "parts": [{"functionCall": call}]
                })
                contents.append({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": func_name,
                            "response": {"result": tool_result}
                        }
                    }]
                })
                
                follow_up_payload = {
                    "contents": contents,
                    "tools": tools,
                    "systemInstruction": payload["systemInstruction"]
                }
                
                resp2 = await client.post(url, json=follow_up_payload)
                if resp2.status_code == 200:
                    data2 = resp2.json()
                    candidates2 = data2.get("candidates", [])
                    if candidates2:
                        parts2 = candidates2[0].get("content", {}).get("parts", [])
                        if parts2 and "text" in parts2[0]:
                            return {"response": parts2[0]["text"]}
                    return {"response": f"Action executed successfully ({func_name})."}
                else:
                    return {"response": f"Action completed with result: {tool_result}"}
            else:
                text = parts[0].get("text", "I'm not sure how to answer that.") if parts else "No response generated."
                return {"response": text}
    except Exception as e:
        logger.error(f"Gemini agent failed: {e}")
        return {"response": f"Failed to execute agent loop: {str(e)}"}

async def handle_openai_agent(req: ChatRequest, db: AsyncSession) -> dict:
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json"
    }
    
    messages = [
        {"role": "system", "content": "You are the Sentinel NVR Active AI Operator. You have direct control over camera configuration, system health query, and settings. Be helpful, concise, and professional. Always tell the user when you perform actions."}
    ]
    for item in req.history:
        messages.append({"role": item["role"], "content": item["content"]})
    messages.append({"role": "user", "content": req.message})

    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_system_health",
                "description": "Get NVR system health, including CPU, memory, and disk usage."
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_cameras",
                "description": "List all configured cameras with their IDs, names, and online status."
            }
        },
        {
            "type": "function",
            "function": {
                "name": "update_camera",
                "description": "Rename a camera or change its location. Stream URLs are changed in Settings.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "camera_id": {"type": "string", "description": "The unique UUID of the camera."},
                        "name": {"type": "string", "description": "New name of the camera."},
                        "location": {"type": "string", "description": "New location of the camera."}
                    },
                    "required": ["camera_id"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "update_system_config",
                "description": "Update system configuration settings like video retention days.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "retention_days": {"type": "integer", "description": "Number of days to keep video recordings."}
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_recent_events",
                "description": "Retrieve recent AI security events log.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "description": "Maximum number of events to return."}
                    }
                }
            }
        }
    ]

    payload = {
        "model": "gpt-4o-mini",
        "messages": messages,
        "tools": tools
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                return {"response": f"OpenAI API error: {resp.text}"}
            
            data = resp.json()
            message = data["choices"][0]["message"]
            tool_calls = message.get("tool_calls", [])
            
            if tool_calls:
                call = tool_calls[0]
                func_name = call["function"]["name"]
                func_args = json.loads(call["function"]["arguments"])
                
                logger.info(f"AI Operator triggered OpenAI function call: {func_name} with {func_args}")
                tool_result = await execute_tool(func_name, func_args, db)
                
                messages.append(message)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "name": func_name,
                    "content": tool_result
                })
                
                payload = {
                    "model": "gpt-4o-mini",
                    "messages": messages
                }
                
                resp2 = await client.post(url, headers=headers, json=payload)
                if resp2.status_code == 200:
                    data2 = resp2.json()
                    final_text = data2["choices"][0]["message"]["content"]
                    return {"response": final_text}
                else:
                    return {"response": f"Successfully ran action, but explanation failed: {resp2.text}"}
            else:
                return {"response": message.get("content", "I'm not sure how to answer that.")}
    except Exception as e:
        logger.error(f"OpenAI agent failed: {e}")
        return {"response": f"Failed to execute agent loop: {str(e)}"}

async def handle_fallback_agent(message: str, db: AsyncSession) -> dict:
    msg = message.lower()
    if "health" in msg or "system" in msg:
        health_info = await run_get_system_health(db)
        return {"response": f"Local Fallback AI Operator: System health details: {health_info}"}
    elif "camera" in msg or "cameras" in msg:
        cams_info = await run_get_cameras(db)
        return {"response": f"Local Fallback AI Operator: Cameras list:\n{cams_info}"}
    elif "event" in msg or "events" in msg:
        events_info = await run_get_recent_events(db, limit=5)
        return {"response": f"Local Fallback AI Operator: Recent events:\n{events_info}"}
    
    return {
        "response": (
            "Local Fallback AI Operator active. Configured AI Provider is set to 'local'. "
            "To unlock fully active AI operators (with tool execution, settings changes, and custom voice), "
            "please set a Gemini or OpenAI API Key in settings."
        )
    }

@router.post("/chat")
async def chat_agent(req: ChatRequest, db: AsyncSession = Depends(get_db)):
    provider = settings.ai_provider
    if provider == "gemini" and settings.gemini_api_key:
        return await handle_gemini_agent(req, db)
    elif provider == "openai" and settings.openai_api_key:
        return await handle_openai_agent(req, db)
    return await handle_fallback_agent(req.message, db)
