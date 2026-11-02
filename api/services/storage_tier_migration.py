import asyncio
import logging
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from api.config import settings

logger = logging.getLogger("mView-StorageMigration")


class StorageTierMigration:
    """
    Moves older video recordings from HOT storage (e.g., NVMe/SSD) 
    to COLD storage (e.g., HDD/NAS) automatically to save expensive disk space.
    """
    def __init__(self):
        self.hot_storage_dir = Path(getattr(settings, "recordings_dir", os.getenv("HOT_STORAGE_PATH", "/mnt/storage/mview/recordings")))
        raw_cold = os.getenv("COLD_STORAGE_PATH", "").strip()
        self.cold_storage_dir = Path(raw_cold) if raw_cold else None
        self.migrate_after_days = int(os.getenv("MIGRATE_AFTER_DAYS", "3"))

    def run_migration(self) -> dict:
        """Move aged recordings only when cold storage was explicitly configured."""
        if self.cold_storage_dir is None:
            return {"files_migrated": 0, "bytes_migrated": 0, "enabled": False}
        if not self.hot_storage_dir.exists():
            return {"files_migrated": 0, "bytes_migrated": 0, "enabled": True}

        try:
            self.cold_storage_dir.mkdir(parents=True, exist_ok=True)
            probe = self.cold_storage_dir / ".write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
        except Exception as e:
            logger.error(f"Cold storage not accessible at {self.cold_storage_dir}: {e}")
            return {"files_migrated": 0, "bytes_migrated": 0, "enabled": True, "error": str(e)}

        cutoff_time = datetime.now(timezone.utc) - timedelta(days=self.migrate_after_days)
        files_migrated = 0
        bytes_migrated = 0

        for cam_dir in self.hot_storage_dir.iterdir():
            if not cam_dir.is_dir():
                continue

            dest_cam_dir = self.cold_storage_dir / cam_dir.name
            dest_cam_dir.mkdir(parents=True, exist_ok=True)

            for file_path in cam_dir.glob("*.mp4"):
                try:
                    stat = file_path.stat()
                    file_time = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
                except OSError:
                    continue

                if file_time < cutoff_time:
                    dest_file = dest_cam_dir / file_path.name
                    try:
                        file_size = stat.st_size
                        shutil.move(str(file_path), str(dest_file))
                        files_migrated += 1
                        bytes_migrated += file_size
                        logger.debug(f"Migrated {file_path.name} to cold storage.")
                    except Exception as e:
                        logger.error(f"Failed to migrate {file_path.name}: {e}")

        if files_migrated > 0:
            logger.info(f"Storage Migration Complete: Moved {files_migrated} segments ({round(bytes_migrated / (1024**3), 2)} GB) to cold storage.")

        return {
            "files_migrated": files_migrated,
            "bytes_migrated": bytes_migrated,
            "gb_migrated": round(bytes_migrated / (1024**3), 3),
        }

    async def run_migration_async(self) -> dict:
        """Asynchronously run migration in a worker thread to prevent event loop stalls."""
        return await asyncio.to_thread(self.run_migration)


storage_migration_service = StorageTierMigration()


async def storage_migration_worker():
    """Autonomous background loop running daily storage migration."""
    logger.info("Starting autonomous Storage Tier Migration worker...")
    while True:
        try:
            await storage_migration_service.run_migration_async()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in storage tier worker: {e}")
        # Run every 24 hours
        await asyncio.sleep(24 * 3600)
