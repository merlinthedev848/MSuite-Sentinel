import sys
from pathlib import Path

# Ensure repo root is on sys.path for test discovery
REPO_ROOT = Path(__file__).resolve().parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
