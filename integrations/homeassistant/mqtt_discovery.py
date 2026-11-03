import json
import logging
from typing import Optional
from aiomqtt import Client as MQTTClient

logger = logging.getLogger("mView-HomeAssistant")

class HomeAssistantDiscovery:
    """
    Publishes Home Assistant MQTT auto-discovery payloads for mView Sentinel.
    This makes cameras and AI events automatically appear in Home Assistant without manual YAML configuration.
    """
    def __init__(
        self,
        mqtt_broker: str,
        prefix: str = "homeassistant",
        port: int = 1883,
        username: Optional[str] = None,
        password: Optional[str] = None
    ):
        self.mqtt_broker = mqtt_broker
        self.prefix = prefix
        self.port = port
        self.username = username
        self.password = password
        self.device = {
            "identifiers": ["mview_sentinel_nvr"],
            "name": "mView Sentinel",
            "manufacturer": "mView",
            "model": "Sentinel NVR Server",
            "sw_version": "1.0.0"
        }

    async def register_camera(self, camera_id: str, camera_name: str, rtsp_url: str):
        """Register the camera stream as a camera entity in HA."""
        topic = f"{self.prefix}/camera/mview_{camera_id}/config"
        payload = {
            "name": f"{camera_name} Stream",
            "unique_id": f"mview_{camera_id}_stream",
            "device": self.device,
            "topic": f"sentinel/cameras/{camera_id}/stream",
            # HA doesn't natively support RTSP via generic MQTT camera perfectly,
            # but usually users integrate the WebRTC proxy stream url directly.
            # We expose the camera's state here instead.
            "availability_topic": f"sentinel/cameras/{camera_id}/status",
        }
        await self._publish(topic, payload)
        
        # Also register a binary sensor for AI motion detection
        await self.register_motion_sensor(camera_id, camera_name)

    async def register_motion_sensor(self, camera_id: str, camera_name: str):
        """Register a binary sensor for AI motion events (Person, Vehicle, etc)."""
        topic = f"{self.prefix}/binary_sensor/mview_{camera_id}_motion/config"
        payload = {
            "name": f"{camera_name} AI Motion",
            "unique_id": f"mview_{camera_id}_ai_motion",
            "device_class": "motion",
            "state_topic": f"sentinel/events/{camera_id}",
            "value_template": "{{ 'ON' if value_json.objects | length > 0 else 'OFF' }}",
            "off_delay": 30, # Automatically clear the motion state after 30 seconds
            "device": self.device
        }
        await self._publish(topic, payload)

    async def _publish(self, topic: str, payload: dict):
        try:
            client_kwargs = {
                "hostname": self.mqtt_broker,
                "port": self.port,
            }
            if self.username:
                client_kwargs["username"] = self.username
            if self.password:
                client_kwargs["password"] = self.password

            async with MQTTClient(**client_kwargs) as client:
                await client.publish(topic, payload=json.dumps(payload), retain=True)
                logger.info(f"Published HA discovery for {topic}")
        except Exception as e:
            logger.error(f"Failed to publish HA discovery: {e}")

# Usage Example:
# async def main():
#     ha = HomeAssistantDiscovery("mqtt")
#     await ha.register_camera("cam_1", "Front Door", "rtsp://...")
