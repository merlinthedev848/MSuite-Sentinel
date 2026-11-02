import json
import logging
import os
from typing import Optional
import httpx
from aiomqtt import Client as MQTTClient

logger = logging.getLogger("mView-Notifications")


class NotificationService:
    """
    Handles dispatching alerts to external services based on user-defined rules.
    Supports Webhooks, Discord, Telegram, and MQTT.
    """
    def __init__(self, http_client: Optional[httpx.AsyncClient] = None):
        self.mqtt_broker = os.getenv("MQTT_BROKER", "localhost")
        self._http_client = http_client
        logger.info("Notification Service Initialized.")

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=10.0)
        return self._http_client

    async def dispatch(self, rule: dict, event_data: dict):
        """Evaluate a rule and dispatch to the requested channels."""
        channels = rule.get("channels", [])
        
        for channel in channels:
            if channel == "discord":
                await self.send_discord(rule.get("webhook_url"), event_data)
            elif channel == "telegram":
                await self.send_telegram(rule.get("bot_token"), rule.get("chat_id"), event_data)
            elif channel == "mqtt":
                await self.send_mqtt(rule.get("mqtt_topic"), event_data)
            elif channel == "webhook":
                await self.send_generic_webhook(rule.get("webhook_url"), event_data)
            else:
                logger.warning(f"Unsupported notification channel: {channel}")

    async def send_generic_webhook(self, webhook_url: Optional[str], event_data: dict):
        if not webhook_url:
            return
        from api.security import webhook_target_allowed
        if not webhook_target_allowed(webhook_url):
            logger.warning("Refused webhook target that is not a public http(s) address")
            return
        try:
            client = await self._get_client()
            resp = await client.post(webhook_url, json=event_data)
            logger.info(f"Generic webhook sent to {webhook_url}: {resp.status_code}")
        except Exception as e:
            logger.error(f"Failed to send webhook to {webhook_url}: {e}")

    async def send_discord(self, webhook_url: Optional[str], event_data: dict):
        if not webhook_url:
            return
        from api.security import webhook_target_allowed
        if not webhook_target_allowed(webhook_url):
            logger.warning("Refused Discord webhook target that is not a public http(s) address")
            return
            
        payload = {
            "content": f"🚨 **mView Alert**: {event_data.get('object_class', 'Object')} detected on {event_data.get('camera_id', 'camera')} at {event_data.get('timestamp', '')}",
            "embeds": [{
                "title": "Confidence Score",
                "description": f"{round(float(event_data.get('confidence', 0)) * 100, 1)}%",
                "color": 16711680 # Red
            }]
        }
        
        try:
            client = await self._get_client()
            await client.post(webhook_url, json=payload)
            logger.info("Discord webhook sent.")
        except Exception as e:
            logger.error(f"Failed to send Discord webhook: {e}")

    async def send_telegram(self, bot_token: Optional[str], chat_id: Optional[str], event_data: dict):
        if not bot_token or not chat_id:
            return
            
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": f"🚨 mView Alert: {event_data.get('object_class', 'Object')} on {event_data.get('camera_id', 'camera')}"
        }
        
        try:
            client = await self._get_client()
            await client.post(url, json=payload)
            logger.info("Telegram message sent.")
        except Exception as e:
            logger.error(f"Failed to send Telegram message: {e}")

    async def send_mqtt(self, topic: Optional[str], event_data: dict):
        if not topic:
            return
            
        try:
            async with MQTTClient(self.mqtt_broker) as client:
                await client.publish(topic, payload=json.dumps(event_data))
                logger.info(f"MQTT notification published to {topic}")
        except Exception as e:
            logger.error(f"Failed to publish MQTT notification: {e}")

    async def close(self):
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()


notification_service = NotificationService()
