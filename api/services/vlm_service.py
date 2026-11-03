import base64
import json
import logging
from typing import Optional
import httpx
from api.config import settings

logger = logging.getLogger("mView-VLM")


class VLMService:
    """
    Multimodal Vision-Language Model analyzer.
    Supports local fallback, Google Gemini API, and OpenAI GPT API.
    """
    def __init__(self, http_client: Optional[httpx.AsyncClient] = None):
        self._http_client = http_client

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=10.0)
        return self._http_client

    def _clean_json_text(self, text: str) -> str:
        text = text.strip()
        if text.startswith("```"):
            lines = text.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            text = "\n".join(lines).strip()
        return text

    async def analyze_frame(self, image_bytes: bytes, detected_classes: list[str]) -> dict:
        """
        Takes raw image bytes, runs VLM analysis, and returns structured summary & threat rating.
        """
        provider = settings.ai_provider
        classes_str = ", ".join(detected_classes) or "unidentified motion"

        if provider == "gemini" and settings.gemini_api_key:
            return await self._analyze_gemini(image_bytes, classes_str)
        elif provider == "openai" and settings.openai_api_key:
            return await self._analyze_openai(image_bytes, classes_str)
        
        # No cloud model is configured. The local path is a keyword table, not a vision model.
        result = self._local_fallback(detected_classes)
        result["engine"] = "keyword-rules"
        return result

    async def _analyze_gemini(self, image_bytes: bytes, classes_str: str) -> dict:
        b64_data = base64.b64encode(image_bytes).decode("utf-8")
        url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
        headers = {
            "x-goog-api-key": settings.gemini_api_key,
            "Content-Type": "application/json",
        }
        
        prompt = (
            f"Analyze this security camera frame. YOLO detected: {classes_str}. "
            "Describe the scene and any activity in a single short sentence (max 15 words). "
            "Assess the threat level as LOW, MEDIUM, or HIGH based on safety/security risk. "
            "You MUST return JSON matching this exact structure: "
            '{"description": "...", "threat_level": "LOW|MEDIUM|HIGH"}'
        )

        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": b64_data
                            }
                        }
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }

        try:
            client = await self._get_client()
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                candidates = data.get("candidates") or []
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts") or []
                    if parts and parts[0].get("text"):
                        return json.loads(self._clean_json_text(parts[0]["text"]))
            else:
                logger.error(f"Gemini API returned status {resp.status_code}")
        except Exception as e:
            logger.error(f"Failed to analyze frame with Gemini: {type(e).__name__}")

        return self._local_fallback(classes_str.split(", "))

    async def _analyze_openai(self, image_bytes: bytes, classes_str: str) -> dict:
        b64_data = base64.b64encode(image_bytes).decode("utf-8")
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json"
        }

        prompt = (
            f"Analyze this security camera frame. YOLO detected: {classes_str}. "
            "Describe the scene and any activity in a single short sentence (max 15 words). "
            "Assess the threat level as LOW, MEDIUM, or HIGH based on safety/security risk. "
            "You MUST return JSON matching this exact structure: "
            '{"description": "...", "threat_level": "LOW|MEDIUM|HIGH"}'
        )

        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{b64_data}"
                            }
                        }
                    ]
                }
            ],
            "response_format": {"type": "json_object"}
        }

        try:
            client = await self._get_client()
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                return json.loads(self._clean_json_text(text))
            else:
                logger.error(f"OpenAI API returned status {resp.status_code}: {resp.text}")
        except Exception as e:
            logger.error(f"Failed to analyze frame with OpenAI: {e}")

        return self._local_fallback(classes_str.split(", "))

    def _local_fallback(self, classes: list[str]) -> dict:
        """Lightweight rules-based security context analyzer."""
        if not classes or classes == [""]:
            return {
                "description": "Motion detected, no recognized objects in view.",
                "threat_level": "LOW"
            }
        
        objects_desc = ", ".join(classes)
        threat = "LOW"
        
        # Simple security rules
        suspicious_classes = {"person", "backpack", "suitcase", "knife", "scissors"}
        if any(c in suspicious_classes for c in classes):
            threat = "MEDIUM"
        
        return {
            "description": f"Keyword rule matched {objects_desc}. This is not a vision-language description.",
            "threat_level": threat,
            "engine": "keyword-rules",
        }

    async def close(self):
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()


vlm_service = VLMService()
