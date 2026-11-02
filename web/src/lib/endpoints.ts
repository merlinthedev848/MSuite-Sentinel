const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const joinUrl = (base: string, path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimTrailingSlash(base)}${normalizedPath}`;
};

// The dashboard is same-origin with the API. Vite proxies these paths in dev
// so the session cookie is first-party on port 5173 as well as on the API port.
export const apiBase = () => '';

export const apiUrl = (path: string) => joinUrl(apiBase(), path);

export const mediaUrl = (path: string) => apiUrl(path);

export const go2rtcBase = () => {
  const override = localStorage.getItem('mview_go2rtc_base');
  if (override) return override;
  return apiUrl('/go2rtc');
};

export const go2rtcUrl = (path: string) => {
  const override = localStorage.getItem('mview_go2rtc_base');
  if (override) return joinUrl(override, path);
  return joinUrl(joinUrl(apiBase(), '/go2rtc'), path);
};
