const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const joinUrl = (base: string, path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimTrailingSlash(base)}${normalizedPath}`;
};

export const apiBase = () => {
  if (window.location.port === '5173') {
    return `http://${window.location.hostname}:8000`;
  }
  return '';
};

const isMediaTokenPath = (path: string) => {
  const cleanPath = path.split('?')[0];
  return (
    cleanPath.startsWith('/recordings/') ||
    cleanPath.startsWith('/system/live') ||
    cleanPath.endsWith('/snapshot') ||
    cleanPath.endsWith('/thumbnail')
  );
};

export const apiUrl = (path: string) => {
  const url = joinUrl(apiBase(), path);
  if (isMediaTokenPath(path) && !/[?&]token=/.test(url)) {
    const token = localStorage.getItem('mview_token');
    if (token) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}token=${encodeURIComponent(token)}`;
    }
  }
  return url;
};

export const mediaUrl = (path: string) => apiUrl(path);

export const go2rtcBase = () => {
  const override = localStorage.getItem('mview_go2rtc_base');
  if (override) return override;
  return apiUrl('/go2rtc');
};

export const go2rtcUrl = (path: string) => joinUrl(go2rtcBase(), path);

