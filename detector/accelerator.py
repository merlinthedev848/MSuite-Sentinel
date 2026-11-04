import logging
import subprocess
import os

logger = logging.getLogger(__name__)

class HardwareAccelerator:
    """
    Detects available hardware accelerators to optimize AI inference.
    Supports NVIDIA (CUDA/TensorRT), Intel (OpenVINO), Google Coral, and CPU fallback.
    """
    
    @staticmethod
    def detect_best_backend() -> str:
        """Returns the optimal backend: 'tensorrt', 'cuda', 'openvino', 'coral', or 'cpu'"""
        
        # 1. Check for NVIDIA GPU
        try:
            subprocess.run(
                ["nvidia-smi"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=3.0,
            )
            logger.info("NVIDIA GPU detected. Using CUDA/TensorRT backend.")
            # If tensorrt is installed, prefer it, else fallback to cuda
            return "tensorrt" if HardwareAccelerator._has_tensorrt() else "cuda"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
            pass

        # 2. Check for Intel OpenVINO (requires compatible CPU/iGPU)
        if HardwareAccelerator._has_openvino():
            logger.info("Intel architecture detected. Using OpenVINO backend.")
            return "openvino"

        # 3. Check for Google Coral Edge TPU
        if os.path.exists("/dev/apex_0"):
            logger.info("Google Coral TPU detected. Using EdgeTPU backend.")
            return "coral"

        # Fallback to CPU with ONNX Runtime
        logger.warning("No hardware accelerator detected. Falling back to CPU.")
        return "cpu"

    @staticmethod
    def _has_tensorrt() -> bool:
        try:
            import tensorrt
            return True
        except ImportError:
            return False

    @staticmethod
    def _has_openvino() -> bool:
        try:
            import openvino
            return True
        except ImportError:
            return False

accelerator = HardwareAccelerator()
