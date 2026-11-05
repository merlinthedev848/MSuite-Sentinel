/**
 * Cross-browser, cross-device fullscreen and theater view utility.
 * Handles desktop Fullscreen API, vendor prefixes, iOS Safari video fullscreen,
 * and event listener bindings.
 */

export function isNativeFullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.fullscreenEnabled ||
    (document as any).webkitFullscreenEnabled ||
    (document as any).mozFullScreenEnabled ||
    (document as any).msFullscreenEnabled
  );
}

export function isNativeFullscreenActive(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    (document as any).msFullscreenElement
  );
}

/**
 * Requests native fullscreen on an element (or fallback video element).
 * Returns true if native fullscreen was entered, false if rejected or unsupported.
 */
export async function requestNativeFullscreen(
  targetElement: HTMLElement | null,
  fallbackVideo?: HTMLVideoElement | null
): Promise<boolean> {
  if (!targetElement && !fallbackVideo) return false;

  // 1. Try standard container fullscreen first (preserves HUD and overlay controls)
  if (targetElement) {
    try {
      if (typeof targetElement.requestFullscreen === 'function') {
        await targetElement.requestFullscreen();
        return true;
      }
      if (typeof (targetElement as any).webkitRequestFullscreen === 'function') {
        (targetElement as any).webkitRequestFullscreen();
        return true;
      }
      if (typeof (targetElement as any).mozRequestFullScreen === 'function') {
        (targetElement as any).mozRequestFullScreen();
        return true;
      }
      if (typeof (targetElement as any).msRequestFullscreen === 'function') {
        (targetElement as any).msRequestFullscreen();
        return true;
      }
    } catch {
      // Element fullscreen request failed (e.g. not user-gesture or blocked by policy)
    }
  }

  // 2. Try iOS Safari native video fullscreen
  if (fallbackVideo) {
    try {
      if (typeof (fallbackVideo as any).webkitEnterFullscreen === 'function') {
        (fallbackVideo as any).webkitEnterFullscreen();
        return true;
      }
      if (typeof fallbackVideo.requestFullscreen === 'function') {
        await fallbackVideo.requestFullscreen();
        return true;
      }
    } catch {
      // Video fullscreen failed
    }
  }

  return false;
}

/**
 * Exits native browser fullscreen if active.
 */
export async function exitNativeFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;
  try {
    if (document.exitFullscreen && isNativeFullscreenActive()) {
      await document.exitFullscreen();
    } else if ((document as any).webkitExitFullscreen) {
      (document as any).webkitExitFullscreen();
    } else if ((document as any).mozCancelFullScreen) {
      (document as any).mozCancelFullScreen();
    } else if ((document as any).msExitFullscreen) {
      (document as any).msExitFullscreen();
    }
  } catch {}
}

/**
 * Subscribes to fullscreen change events across standard and vendor prefixes.
 */
export function addFullscreenChangeListener(callback: (isActive: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};

  const handler = () => {
    callback(isNativeFullscreenActive());
  };

  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
  document.addEventListener('mozfullscreenchange', handler);
  document.addEventListener('MSFullscreenChange', handler);

  return () => {
    document.removeEventListener('fullscreenchange', handler);
    document.removeEventListener('webkitfullscreenchange', handler);
    document.removeEventListener('mozfullscreenchange', handler);
    document.removeEventListener('MSFullscreenChange', handler);
  };
}
