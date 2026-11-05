import base64
import json
import logging
import os
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
        elif provider == "ollama":
            return await self._analyze_ollama(image_bytes, classes_str)
        elif provider == "custom" and getattr(settings, "custom_ai_url", ""):
            return await self._analyze_custom(image_bytes, classes_str)
        
        # Local rule-based analyzer when no cloud or local VLM is selected
        result = self._local_fallback(detected_classes)
        return result

    async def _analyze_ollama(self, image_bytes: bytes, classes_str: str) -> dict:
        """Query local Ollama instance (e.g. llama3.2-vision, moondream, or llava)."""
        ollama_url = getattr(settings, "ollama_url", os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")).rstrip("/")
        model = getattr(settings, "ollama_model", os.getenv("OLLAMA_MODEL", "llama3.2-vision"))
        b64_data = base64.b64encode(image_bytes).decode("utf-8")
        
        prompt = (
            f"Analyze this security camera frame. YOLO detected: {classes_str}. "
            "Describe the scene and any activity in a single short sentence (max 15 words). "
            "Assess the threat level as LOW, MEDIUM, or HIGH. "
            'Return JSON: {"description": "...", "threat_level": "LOW|MEDIUM|HIGH"}'
        )

        try:
            client = await self._get_client()
            resp = await client.post(
                f"{ollama_url}/api/chat",
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "user",
                            "content": prompt,
                            "images": [b64_data],
                        }
                    ],
                    "format": "json",
                    "stream": False,
                },
                timeout=12.0
            )
            if resp.status_code == 200:
                data = resp.json()
                content = data.get("message", {}).get("content", "")
                parsed = json.loads(self._clean_json_text(content))
                if isinstance(parsed, dict) and "description" in parsed:
                    parsed["engine"] = f"ollama-{model}"
                    return parsed
        except Exception as e:
            logger.debug(f"Ollama local vision inference skipped or timed out: {e}")

        return self._local_fallback(classes_str.split(", "))

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
                        parsed = json.loads(self._clean_json_text(parts[0]["text"]))
                        if isinstance(parsed, dict) and "description" in parsed:
                            return parsed
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
                parsed = json.loads(self._clean_json_text(text))
                if isinstance(parsed, dict) and "description" in parsed:
                    return parsed
            else:
                logger.error(f"OpenAI API returned status {resp.status_code}: {resp.text}")
        except Exception as e:
            logger.error(f"Failed to analyze frame with OpenAI: {e}")

        return self._local_fallback(classes_str.split(", "))

    async def _analyze_custom(self, image_bytes: bytes, classes_str: str) -> dict:
        """Query custom OpenAI-compatible vision endpoint (e.g. vLLM, LM Studio, LocalAI, LiteLLM)."""
        base_url = getattr(settings, "custom_ai_url", "").rstrip("/")
        if not base_url:
            return self._local_fallback(classes_str.split(", "))

        # Normalize endpoint path
        url = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
        api_key = getattr(settings, "custom_ai_key", "")
        model = getattr(settings, "custom_ai_model", "") or "default"

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        b64_data = base64.b64encode(image_bytes).decode("utf-8")
        prompt = (
            f"Analyze this security camera frame. YOLO detected: {classes_str}. "
            "Describe the scene and any activity in a single short sentence (max 15 words). "
            "Assess the threat level as LOW, MEDIUM, or HIGH based on safety/security risk. "
            "You MUST return JSON matching this exact structure: "
            '{"description": "...", "threat_level": "LOW|MEDIUM|HIGH"}'
        )

        payload = {
            "model": model,
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
            resp = await client.post(url, headers=headers, json=payload, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                parsed = json.loads(self._clean_json_text(text))
                if isinstance(parsed, dict) and "description" in parsed:
                    parsed["engine"] = f"custom-{model}"
                    return parsed
            else:
                logger.error(f"Custom AI API returned status {resp.status_code}: {resp.text[:200]}")
        except Exception as e:
            logger.error(f"Failed to analyze frame with Custom AI: {e}")

        return self._local_fallback(classes_str.split(", "))

    def _local_fallback(self, classes: list[str]) -> dict:
        """Lightweight rules-based security context analyzer producing clear incident summaries."""
        clean_classes = [c.strip().lower() for c in classes if c and c.strip()]
        if not clean_classes or clean_classes == [""]:
            return {
                "description": "Motion activity observed in camera field of view.",
                "threat_level": "LOW",
                "engine": "local-rule-engine",
            }

        suspicious_high = {"knife", "gun", "weapon", "fire", "smoke", "crowbar"}
        suspicious_medium = {"person", "backpack", "suitcase", "scissors"}

        if any(c in suspicious_high for c in clean_classes):
            threat = "HIGH"
        elif any(c in suspicious_medium for c in clean_classes):
            threat = "MEDIUM"
        else:
            threat = "LOW"

        vehicles = [c for c in clean_classes if c in ("car", "truck", "motorcycle", "bus", "bicycle")]
        animals = [c for c in clean_classes if c in ("dog", "cat", "bird", "bear", "horse", "animal")]

        if "person" in clean_classes and vehicles:
            desc = f"Person and {vehicles[0]} movement detected in zone"
        elif "person" in clean_classes:
            desc = "Person activity detected in monitored zone"
        elif vehicles:
            desc = f"Vehicle activity ({', '.join(vehicles)}) observed"
        elif animals:
            desc = f"Animal movement ({', '.join(animals)}) detected"
        else:
            desc = f"{', '.join(clean_classes).capitalize()} detected in camera view"

        return {
            "description": desc,
            "threat_level": threat,
            "engine": "local-rule-engine",
        }

    async def close(self):
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()


vlm_service = VLMService()
