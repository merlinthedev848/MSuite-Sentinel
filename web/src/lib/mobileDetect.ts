export type ViewPreference = 'auto' | 'mobile' | 'desktop';

const PREF_KEY = 'sentinel_view_mode';

/**
 * Determines whether the current client is a mobile device or small touchscreen viewport.
 */
export function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  
  const ua = navigator.userAgent || navigator.vendor || (window as any).opera || '';
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  
  const isSmallScreen = window.innerWidth <= 840;
  const hasTouch = (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) || ('ontouchstart' in window);
  
  return isMobileUA || (isSmallScreen && hasTouch);
}

/**
 * Gets the user's manual view preference: 'auto' (default), 'mobile', or 'desktop'.
 */
export function getViewPreference(): ViewPreference {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(PREF_KEY);
      if (val === 'mobile' || val === 'desktop' || val === 'auto') {
        return val;
      }
    }
  } catch {}
  return 'auto';
}

/**
 * Persists the user's view preference to localStorage.
 */
export function setViewPreference(pref: ViewPreference): void {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      localStorage.setItem(PREF_KEY, pref);
    }
  } catch {}
}

/**
 * Determines if the dedicated mobile experience should be rendered.
 * If user explicitly requested 'desktop', returns false even on mobile.
 * If user explicitly requested 'mobile', returns true even on desktop.
 * Otherwise, autodetects based on mobile device heuristics.
 */
export function shouldUseMobileView(): boolean {
  const pref = getViewPreference();
  if (pref === 'mobile') return true;
  if (pref === 'desktop') return false;
  return isMobileDevice();
}
