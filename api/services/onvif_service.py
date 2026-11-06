"""
ONVIF Discovery Service — WS-Discovery + IP range fallback scanner.

WS-Discovery (UDP multicast) often fails inside Docker bridge networking.
We implement two methods:
  1. WS-Discovery (fast, works on host network)
  2. Active IP range scan (reliable fallback — probes every host on the subnet)
"""

import asyncio
import logging
import ipaddress
import urllib.parse
from wsdiscovery.discovery import ThreadedWSDiscovery

logger = logging.getLogger("mView-ONVIF")

COMMON_ONVIF_PORTS = [80, 8080, 8000, 8899]


async def _probe_onvif(ip: str, port: int, timeout: float = 2.0) -> dict | None:
    """Try to connect to an ONVIF device_service endpoint and return its info."""
    url = f"http://{ip}:{port}/onvif/device_service"
    try:
        import httpx
        import re
        async with httpx.AsyncClient(timeout=timeout) as client:
            # A minimal GetDeviceInformation SOAP request
            soap = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
                ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl">'
                '<s:Body><tds:GetDeviceInformation/></s:Body></s:Envelope>'
            )
            resp = await client.post(
                url,
                content=soap,
                headers={"Content-Type": "application/soap+xml"},
            )
            # Any 200/400/401 means something is listening on ONVIF
            if resp.status_code in (200, 400, 401, 500):
                manufacturer = "Unknown"
                model = "IP Camera"
                resp_text = resp.text or ""

                # 1. Parse XML if returned
                if resp.status_code == 200 and resp_text:
                    m_match = re.search(r"<(?:tds:)?Manufacturer>([^<]+)</(?:tds:)?Manufacturer>", resp_text, re.IGNORECASE)
                    if m_match:
                        manufacturer = m_match.group(1).strip()
                    mod_match = re.search(r"<(?:tds:)?Model>([^<]+)</(?:tds:)?Model>", resp_text, re.IGNORECASE)
                    if mod_match:
                        model = mod_match.group(1).strip()

                # 2. Check HTTP headers and auth realms for vendor signatures
                if manufacturer == "Unknown":
                    combined_sig = (
                        resp.headers.get("server", "") + " " +
                        resp.headers.get("www-authenticate", "") + " " +
                        resp_text[:500]
                    ).lower()
                    if any(k in combined_sig for k in ("hikvision", "hik-", "hik_")):
                        manufacturer, model = "Hikvision", "Hikvision Camera"
                    elif any(k in combined_sig for k in ("dahua", "dh-", "dhi-")):
                        manufacturer, model = "Dahua", "Dahua Camera"
                    elif "amcrest" in combined_sig:
                        manufacturer, model = "Amcrest", "Amcrest Camera"
                    elif "reolink" in combined_sig:
                        manufacturer, model = "Reolink", "Reolink Camera"
                    elif "axis" in combined_sig:
                        manufacturer, model = "Axis", "Axis Camera"
                    elif "foscam" in combined_sig:
                        manufacturer, model = "Foscam", "Foscam Camera"
                    elif any(k in combined_sig for k in ("uniview", "unv")):
                        manufacturer, model = "Uniview", "UNV Camera"
                    elif any(k in combined_sig for k in ("hanwha", "wisenet")):
                        manufacturer, model = "Hanwha", "Wisenet Camera"

                return {
                    "id": f"{ip}:{port}",
                    "ip": ip,
                    "manufacturer": manufacturer,
                    "model": model,
                    "onvif_endpoint": url,
                    "status": "online",
                }
    except Exception:
        pass
    return None


async def _scan_subnet(subnet: str, max_concurrent: int = 64) -> list[dict]:
    """Scan all hosts on a subnet for ONVIF devices."""
    try:
        network = ipaddress.IPv4Network(subnet, strict=False)
    except ValueError:
        return []

    hosts = list(network.hosts())
    if len(hosts) > 512:
        hosts = hosts[:512]  # Safety cap

    sem = asyncio.Semaphore(max_concurrent)
    results = []

    async def probe_host(ip_obj):
        ip = str(ip_obj)
        async with sem:
            for port in COMMON_ONVIF_PORTS:
                result = await _probe_onvif(ip, port)
                if result:
                    results.append(result)
                    return  # Found one, no need to check more ports

    await asyncio.gather(*[probe_host(h) for h in hosts])
    return results


def _get_local_subnets() -> list[str]:
    """Detect the local subnets the machine is on across all active interfaces."""
    subnets = []
    import socket
    try:
        import netifaces
        for iface in netifaces.interfaces():
            # Skip loopback, docker, bridge, tunnel and virtual interfaces to prevent slow scanning
            if iface.startswith(('lo', 'docker', 'br-', 'veth', 'virbr', 'tun', 'tap', 'wg')):
                continue
            addrs = netifaces.ifaddresses(iface)
            if netifaces.AF_INET in addrs:
                for addr in addrs[netifaces.AF_INET]:
                    ip = addr.get('addr', '')
                    netmask = addr.get('netmask', '255.255.255.0')
                    if ip and not ip.startswith('127.'):
                        try:
                            network = ipaddress.IPv4Network(f"{ip}/{netmask}", strict=False)
                            subnets.append(str(network))
                        except Exception:
                            pass
    except Exception:
        pass

    if not subnets:
        try:
            import psutil
            addrs = psutil.net_if_addrs()
            for iface, if_addrs in addrs.items():
                if iface.startswith(('lo', 'docker', 'br-', 'veth', 'virbr', 'tun', 'tap', 'wg')):
                    continue
                for addr in if_addrs:
                    if getattr(addr, "family", None) == socket.AF_INET and addr.address and not addr.address.startswith('127.'):
                        netmask = getattr(addr, "netmask", None) or '255.255.255.0'
                        try:
                            network = ipaddress.IPv4Network(f"{addr.address}/{netmask}", strict=False)
                            subnets.append(str(network))
                        except Exception:
                            pass
        except Exception:
            pass

    return list(dict.fromkeys(subnets)) if subnets else ["192.168.1.0/24", "192.168.0.0/24", "10.0.0.0/24"]


async def discover_cameras(timeout: int = 5) -> list[dict]:
    """
    Discover ONVIF cameras using WS-Discovery first, then IP scan fallback.
    Returns a deduplicated list of discovered devices.
    """
    discovered: dict[str, dict] = {}

    # ── Method 1: WS-Discovery ───────────────────────────────────
    logger.info("Starting ONVIF WS-Discovery scan…")
    wsd = None
    try:
        wsd = ThreadedWSDiscovery()
        wsd.start()
        await asyncio.sleep(timeout)
        services = wsd.searchServices()

        for service in services:
            try:
                xaddrs = service.getXAddrs()
                if not xaddrs:
                    continue
                url = xaddrs[0]
                parsed = urllib.parse.urlparse(url)
                ip = parsed.hostname or "unknown"

                manufacturer = "Unknown"
                model = "Unknown"
                for scope in service.getScopes():
                    s = str(scope)
                    if "onvif://www.onvif.org/name/" in s:
                        manufacturer = urllib.parse.unquote(s.split("/")[-1])
                    elif "onvif://www.onvif.org/hardware/" in s:
                        model = urllib.parse.unquote(s.split("/")[-1])

                cam_id = str(service.getEPR()).replace("urn:uuid:", "")
                discovered[ip] = {
                    "id": cam_id,
                    "ip": ip,
                    "manufacturer": manufacturer,
                    "model": model,
                    "onvif_endpoint": url,
                    "status": "online",
                }
            except Exception as e:
                logger.debug(f"WS-Discovery parse error: {e}")

        logger.info(f"WS-Discovery found {len(discovered)} device(s).")
    except Exception as e:
        logger.warning(f"WS-Discovery failed: {e}. Falling back to IP scan.")
    finally:
        if wsd is not None:
            try:
                wsd.stop()
            except Exception:
                pass

    # ── Method 2: IP Range Scan (fallback if WS-Discovery found nothing) ──
    if not discovered:
        logger.info("No WS-Discovery results. Starting active IP range scan…")
        subnets = _get_local_subnets()
        logger.info(f"Scanning subnets: {subnets}")
        for subnet in subnets:
            results = await _scan_subnet(subnet)
            for r in results:
                if r["ip"] not in discovered:
                    discovered[r["ip"]] = r

        logger.info(f"IP scan found {len(discovered)} device(s).")

    return list(discovered.values())


class ONVIFService:
    """Legacy wrapper kept for compatibility with cameras.py router."""

    async def discover_cameras(self, timeout: int = 5) -> list[dict]:
        return await discover_cameras(timeout)

    def get_camera_streams(self, ip, port, username, password) -> list | None:
        """Probe a camera for its RTSP stream URIs via ONVIF Profile S."""
        try:
            from onvif import ONVIFCamera
            import os
            wsdl_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'wsdl')
            if os.path.exists(wsdl_dir):
                mycam = ONVIFCamera(ip, port, username, password, wsdl_dir=wsdl_dir)
            else:
                mycam = ONVIFCamera(ip, port, username, password)
            media = mycam.create_media_service()
            profiles = media.GetProfiles()
            streams = []
            for profile in profiles:
                try:
                    obj = media.create_type('GetStreamUri')
                    obj.ProfileToken = profile.token
                    obj.StreamSetup = {'Stream': 'RTP-Unicast', 'Transport': {'Protocol': 'RTSP'}}
                    uri = media.GetStreamUri(obj)
                    res = getattr(getattr(profile, 'VideoEncoderConfiguration', None), 'Resolution', None)
                    streams.append({
                        "profile_name": profile.Name,
                        "resolution": f"{res.Width}x{res.Height}" if res else "Unknown",
                        "rtsp_url": uri.Uri,
                    })
                except Exception as e:
                    logger.warning(f"Stream probe error for profile {profile.Name}: {e}")
            return streams
        except Exception as e:
            logger.error(f"ONVIF connect failed for {ip}: {e}")
            return None

    def move_ptz(self, onvif_endpoint: str, username: str, password: str, action: str, speed: float = 0.5) -> bool:
        """Send a continuous ONVIF PTZ move command."""
        try:
            cam = self._connect_from_endpoint(onvif_endpoint, username, password)
            media = cam.create_media_service()
            ptz = cam.create_ptz_service()
            profiles = media.GetProfiles()
            if not profiles:
                logger.error("No ONVIF media profiles found on %s", onvif_endpoint)
                return False
            profile = profiles[0]
            request = ptz.create_type("ContinuousMove")
            request.ProfileToken = profile.token
            x, y, z = self._ptz_velocity(action, speed)
            request.Velocity = {
                "PanTilt": {"x": x, "y": y},
                "Zoom": {"x": z},
            }
            ptz.ContinuousMove(request)
            return True
        except Exception as e:
            logger.error("PTZ move failed for %s: %s", onvif_endpoint, e)
            return False

    def stop_ptz(self, onvif_endpoint: str, username: str, password: str) -> bool:
        """Stop ONVIF PTZ movement."""
        try:
            cam = self._connect_from_endpoint(onvif_endpoint, username, password)
            media = cam.create_media_service()
            ptz = cam.create_ptz_service()
            profiles = media.GetProfiles()
            if not profiles:
                logger.error("No ONVIF media profiles found on %s", onvif_endpoint)
                return False
            profile = profiles[0]
            request = ptz.create_type("Stop")
            request.ProfileToken = profile.token
            request.PanTilt = True
            request.Zoom = True
            ptz.Stop(request)
            return True
        except Exception as e:
            logger.error("PTZ stop failed for %s: %s", onvif_endpoint, e)
            return False

    def _connect_from_endpoint(self, onvif_endpoint: str, username: str, password: str):
        from onvif import ONVIFCamera
        import os

        parsed = urllib.parse.urlparse(onvif_endpoint)
        if not parsed.hostname:
            raise ValueError("Invalid ONVIF endpoint")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        wsdl_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'wsdl')
        if os.path.exists(wsdl_dir):
            return ONVIFCamera(parsed.hostname, port, username, password, wsdl_dir=wsdl_dir)
        else:
            return ONVIFCamera(parsed.hostname, port, username, password)

    def get_presets(self, onvif_endpoint: str, username: str, password: str) -> list[dict]:
        """Retrieve hardware presets directly from the physical camera."""
        try:
            cam = self._connect_from_endpoint(onvif_endpoint, username, password)
            media = cam.create_media_service()
            ptz = cam.create_ptz_service()
            profiles = media.GetProfiles()
            if not profiles:
                logger.error("No ONVIF media profiles found on %s", onvif_endpoint)
                return []
            profile = profiles[0]
            presets = ptz.GetPresets({"ProfileToken": profile.token})
            result = []
            for p in presets:
                name = getattr(p, "Name", None) or getattr(p, "token", "Unnamed")
                token = getattr(p, "token", str(name))
                result.append({"name": str(name), "token": str(token)})
            return result
        except Exception as e:
            logger.error(f"Failed to fetch ONVIF presets for {onvif_endpoint}: {e}")
            return []

    def set_preset(self, onvif_endpoint: str, username: str, password: str, preset_name: str) -> str | None:
        """Save current camera position as a named preset on the device."""
        try:
            cam = self._connect_from_endpoint(onvif_endpoint, username, password)
            media = cam.create_media_service()
            ptz = cam.create_ptz_service()
            profiles = media.GetProfiles()
            if not profiles:
                logger.error("No ONVIF media profiles found on %s", onvif_endpoint)
                return None
            profile = profiles[0]
            request = ptz.create_type("SetPreset")
            request.ProfileToken = profile.token
            request.PresetName = preset_name
            token = ptz.SetPreset(request)
            logger.info(f"Preset '{preset_name}' saved on {onvif_endpoint} with token: {token}")
            return str(token)
        except Exception as e:
            logger.error(f"Failed to set preset '{preset_name}' on {onvif_endpoint}: {e}")
            return None

    def goto_preset(self, onvif_endpoint: str, username: str, password: str, preset_identifier: str) -> bool:
        """Drive PTZ motors to a saved preset by token or name."""
        try:
            cam = self._connect_from_endpoint(onvif_endpoint, username, password)
            media = cam.create_media_service()
            ptz = cam.create_ptz_service()
            profiles = media.GetProfiles()
            if not profiles:
                logger.error("No ONVIF media profiles found on %s", onvif_endpoint)
                return False
            profile = profiles[0]

            target_token = preset_identifier
            try:
                camera_presets = ptz.GetPresets({"ProfileToken": profile.token})
                for p in camera_presets:
                    if getattr(p, "Name", "") == preset_identifier:
                        target_token = getattr(p, "token")
                        break
            except Exception:
                pass

            request = ptz.create_type("GotoPreset")
            request.ProfileToken = profile.token
            request.PresetToken = target_token
            ptz.GotoPreset(request)
            logger.info(f"Commanded camera to goto preset token: {target_token}")
            return True
        except Exception as e:
            logger.error(f"Goto preset '{preset_identifier}' failed for {onvif_endpoint}: {e}")
            return False

    @staticmethod
    def _ptz_velocity(action: str, speed: float) -> tuple[float, float, float]:
        speed = max(0.0, min(1.0, speed))
        if action == "left":
            return -speed, 0.0, 0.0
        if action == "right":
            return speed, 0.0, 0.0
        if action == "up":
            return 0.0, speed, 0.0
        if action == "down":
            return 0.0, -speed, 0.0
        if action == "zoom_in":
            return 0.0, 0.0, speed
        if action == "zoom_out":
            return 0.0, 0.0, -speed
        raise ValueError(f"Unsupported PTZ action: {action}")


onvif_service = ONVIFService()



async def request_onvif_keyframe(
    ip: str,
    port: int = 80,
    username: str | None = None,
    password: str | None = None,
    profile_token: str | None = None,
    timeout: float = 1.0,
) -> bool:
    """Send an ONVIF SetSynchronizationPoint command to force immediate IDR keyframe emission."""
    import httpx
    token = profile_token or "Profile_1"
    body_media1 = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:trt="http://www.onvif.org/ver10/media/wsdl">'
        f'<s:Body><trt:SetSynchronizationPoint><trt:ProfileToken>{token}</trt:ProfileToken></trt:SetSynchronizationPoint></s:Body>'
        '</s:Envelope>'
    )
    body_media2 = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:tr2="http://www.onvif.org/ver20/media/wsdl">'
        f'<s:Body><tr2:SetSynchronizationPoint><tr2:ProfileToken>{token}</tr2:ProfileToken></tr2:SetSynchronizationPoint></s:Body>'
        '</s:Envelope>'
    )
    headers = {"Content-Type": "application/soap+xml; charset=utf-8"}
    endpoints = [
        f"http://{ip}:{port}/onvif/media_service",
        f"http://{ip}:{port}/onvif/Media",
        f"http://{ip}:{port}/onvif/media2_service",
        f"http://{ip}:{port}/onvif/Media2",
    ]
    auth = httpx.DigestAuth(username, password) if username and password else None
    basic = (username, password) if username and password else None

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        for ep in endpoints:
            is_m2 = "media2" in ep.lower()
            soap_body = body_media2 if is_m2 else body_media1
            try:
                resp = await client.post(ep, content=soap_body, headers=headers, auth=auth)
                if resp.status_code == 401 and basic:
                    resp = await client.post(ep, content=soap_body, headers=headers, auth=basic)
                if resp.status_code in (200, 204):
                    logger.debug("ONVIF SetSynchronizationPoint succeeded on %s", ep)
                    return True
            except Exception:
                continue
    return False
