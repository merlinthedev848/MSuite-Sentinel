const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const joinUrl = (base: string, path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimTrailingSlash(base)}${normalizedPath}`;
};

const getStorageItem = (key: string): string | null => {
  try {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {
    /* storage access may be blocked */
  }
  return null;
};

// The dashboard is same-origin with the API. Vite proxies these paths in dev
// so the session cookie is first-party on port 5173 as well as on the API port.
export const apiBase = () => {
  const override = getStorageItem('mview_api_base');
  if (override) return override;
  return '';
};

export const apiUrl = (path: string) => joinUrl(apiBase(), path);

export const mediaUrl = (path: string) => apiUrl(path);

export const go2rtcBase = () => {
  const override = getStorageItem('mview_go2rtc_base');
  if (override) return override;
  return apiUrl('/go2rtc');
};

export const go2rtcUrl = (path: string) => {
  const override = getStorageItem('mview_go2rtc_base');
  if (override) return joinUrl(override, path);
  return joinUrl(joinUrl(apiBase(), '/go2rtc'), path);
};
