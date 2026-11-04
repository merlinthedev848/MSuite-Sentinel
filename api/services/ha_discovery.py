"""Publish Home Assistant MQTT discovery records for adopted cameras.

Discovery is best-effort. A broker that is down does not stop the API.
The payload describes motion state and does not include camera passwords.
"""

from __future__ import annotations

import json
import logging

from aiomqtt import Client as MQTTClient

from api.config import settings

logger = logging.getLogger("mView-HomeAssistant")


class HomeAssistantDiscovery:
    def __init__(self) -> None:
        self.prefix = "homeassistant"
        self.device = {
            "identifiers": ["mview_sentinel_nvr"],
            "name": "mView Sentinel",
            "manufacturer": "mView",
            "model": "Sentinel NVR Server",
            "sw_version": settings.app_version,
        }

    async def register_camera(self, camera_id: str, camera_name: str) -> None:
        await self._publish(
            f"{self.prefix}/binary_sensor/mview_{camera_id}_motion/config",
            {
                "name": f"{camera_name} AI Motion",
                "unique_id": f"mview_{camera_id}_ai_motion",
                "device_class": "motion",
                "state_topic": f"sentinel/events/{camera_id}",
                "value_template": "{{ 'ON' if value_json.objects | length > 0 else 'OFF' }}",
                "off_delay": 30,
                "device": self.device,
            },
        )

    async def _publish(self, topic: str, payload: dict) -> None:
        kwargs = {}
        if settings.mqtt_username:
            kwargs["username"] = settings.mqtt_username
            kwargs["password"] = settings.mqtt_password or None
        async with MQTTClient(settings.mqtt_broker, port=settings.mqtt_port, **kwargs) as client:
            await client.publish(topic, payload=json.dumps(payload), retain=True, qos=1)
        logger.info("Published Home Assistant discovery for %s", topic)


async def publish_camera_discovery(cameras: list) -> None:
    publisher = HomeAssistantDiscovery()
    for camera in cameras:
        if not getattr(camera, "enabled", False):
            continue
        try:
            await publisher.register_camera(camera.id, camera.name or camera.id)
        except Exception as exc:
            logger.warning("Home Assistant discovery skipped for %s: %s", camera.id, exc)
            continue
