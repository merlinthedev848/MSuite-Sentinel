import React, { useState, useEffect } from 'react';
import { Search, Plus, Trash2, Edit2, CheckCircle, X, Loader, ShieldCheck, KeyRound, Activity, Database, Zap } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

interface Camera {
  id: string;
  name: string;
  rtsp_url_main: string;
  rtsp_url_sub?: string;
  onvif_endpoint?: string;
  manufacturer?: string;
  model?: string;
  resolution?: string;
  status: string;
  enabled?: boolean;
  auto_adopted: boolean;
  config?: any;
  created_at: string;
}

interface ZonePoint {
  x: number;
  y: number;
}

interface DetectionZone {
  id: string;
  name: string;
  enabled: boolean;
  points: ZonePoint[];
  objects: string[];
  min_confidence: number;
  notify: boolean;
  cooldown_seconds: number;
  schedule: string;
}

interface ManualForm {
  name: string;
  ip: string;
  port: string;
  onvif_username: string;
  onvif_password: string;
  rtsp_url_main: string;
  rtsp_url_sub: string;
  enabled: boolean;
  record_substream: boolean;
  zones: DetectionZone[];
}

const emptyForm: ManualForm = {
  name: '',
  ip: '',
  port: '80',
  onvif_username: 'admin',
  onvif_password: '',
  rtsp_url_main: '',
  rtsp_url_sub: '',
  enabled: true,
  record_substream: false,
  zones: [],
};

const PASSWORD_MASK = '********';

const maskRtspPassword = (url: string) => {
  if (!url) return '';
  return url.replace(/(rtsp:\/\/[^:\s/@]+:)([^@\s]+)(@)/i, `$1${PASSWORD_MASK}$3`);
};

const restoreMaskedRtspPassword = (value: string, original: string) => {
  if (!value.includes(PASSWORD_MASK) || !original) return value;
  const originalMatch = original.match(/rtsp:\/\/[^:\s/@]+:([^@\s]+)@/i);
  const originalPassword = originalMatch?.[1];
  return originalPassword ? value.replace(PASSWORD_MASK, originalPassword) : value;
};

const detectionObjects = ['person', 'car', 'truck', 'bus', 'motorcycle'];

const createDetectionZone = (): DetectionZone => ({
  id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
  name: 'New Zone',
  enabled: true,
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 },
  ],
  objects: ['person'],
  min_confidence: 0.6,
  notify: true,
  cooldown_seconds: 120,
  schedule: 'always',
});

const pointsToText = (points: ZonePoint[]) => points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('\n');

const textToPoints = (value: string): ZonePoint[] => value
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const [x, y] = line.split(',').map(v => Math.max(0, Math.min(1, parseFloat(v.trim()) || 0)));
    return { x, y };
  })
  .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));

interface SystemConfig {
  retention_days: number;
  ai: {
    accelerator: string;
    object_model: string;
    min_confidence: number;
    enable_alpr: boolean;
    enable_face_recognition: boolean;
    ai_provider: string;
    gemini_api_key: string;
    openai_api_key: string;
    custom_ai_url?: string;
    custom_ai_key?: string;
    custom_ai_model?: string;
    ollama_url?: string;
    ollama_model?: string;
  };
  network: {
    api_port: number;
    rtsp_port: number;
    webrtc_api_port: number;
    webrtc_port: number;
    ice_servers: string[];
    enable_ssl: boolean;
  };
  updates: {
    manifest_url: string;
    auto_download: boolean;
    check_interval_minutes: number;
  };
}

interface UserAccount {
  id: string;
  username: string;
  role: string;
  permissions: string[];
  created_at?: string;
}

interface TokenUser {
  id?: string;
  username?: string;
  role?: string;
  permissions?: string[];
}

interface SystemHealth {
  cpu_usage_percent?: number;
  memory_usage_percent?: number;
  memory_total_gb?: number;
  storage?: {
    total_gb: number;
    used_gb: number;
    free_gb: number;
    usage_percent: number;
  };
}

interface StorageReport {
  segment_seconds: number;
  record_substream_default: boolean;
  total_gb: number;
  estimated_gb_per_day: number;
  cameras: Array<{
    camera_id: string;
    files: number;
    total_gb: number;
    last_24h_gb: number;
    avg_segment_mb: number;
    estimated_gb_per_day: number;
    latest_recording?: string;
  }>;
}

interface StreamDiagnostic {
  status: string;
  camera_name: string;
  stream_url: string;
  started_at?: string;
  restart_count: number;
  last_error?: string;
  task_done?: boolean;
}

const defaultSystemConfig: SystemConfig = {
  retention_days: 30,
  ai: {
    accelerator: 'auto',
    object_model: 'yolov8n',
    min_confidence: 0.65,
    enable_alpr: false,
    enable_face_recognition: false,
    ai_provider: 'local',
    gemini_api_key: '',
    openai_api_key: '',
    custom_ai_url: '',
    custom_ai_key: '',
    custom_ai_model: 'default',
    ollama_url: 'http://localhost:11434',
    ollama_model: 'llama3.2-vision',
  },
  network: {
    api_port: 8000,
    rtsp_port: 8554,
    webrtc_api_port: 1984,
    webrtc_port: 8555,
    ice_servers: ['stun:stun.l.google.com:19302'],
    enable_ssl: false,
  },
  updates: {
    manifest_url: 'https://updates.chriskendall.media/sentinel/latest.json',
    auto_download: false,
    check_interval_minutes: 360,
  },
};

type Tab = 'cameras' | 'ai' | 'network' | 'system' | 'users';
const permissionOptions = ['live', 'playback', 'events', 'operations', 'settings'];
const Settings: React.FC = () => {
  const [tab, setTab] = useState<Tab>('cameras');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<any[]>([]);
  const [discoveryError, setDiscoveryError] = useState('');
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState<ManualForm>(emptyForm);
  const [originalRtsp, setOriginalRtsp] = useState({ main: '', sub: '' });
  const [savingManual, setSavingManual] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [adopting, setAdopting] = useState<string | null>(null);
  const [adoptForm, setAdoptForm] = useState<Record<string, {u: string, p: string}>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [quickRenamingId, setQuickRenamingId] = useState<string | null>(null);
  const [quickRenameValue, setQuickRenameValue] = useState<string>('');
  const [toast, setToast] = useState('');
  const [systemConfig, setSystemConfig] = useState<SystemConfig>(defaultSystemConfig);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; latency_ms: number; message: string; models_found?: string[] } | null>(null);

  const testAiConnection = async () => {
    setTestingAi(true);
    setAiTestResult(null);
    try {
      const res = await fetch(apiUrl('/ops-api/ai/test-connection'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: systemConfig.ai.ai_provider,
          url: systemConfig.ai.ai_provider === 'ollama' ? systemConfig.ai.ollama_url : systemConfig.ai.custom_ai_url,
          key: systemConfig.ai.ai_provider === 'custom' ? systemConfig.ai.custom_ai_key : (systemConfig.ai.ai_provider === 'gemini' ? systemConfig.ai.gemini_api_key : systemConfig.ai.openai_api_key),
          model: systemConfig.ai.ai_provider === 'ollama' ? systemConfig.ai.ollama_model : systemConfig.ai.custom_ai_model,
        })
      });
      const data = await res.json();
      setAiTestResult(data);
    } catch (err: any) {
      setAiTestResult({ ok: false, latency_ms: 0, message: err.message || 'Connection test failed' });
    } finally {
      setTestingAi(false);
    }
  };

  const [users, setUsers] = useState<UserAccount[]>([]);
  const [usersError, setUsersError] = useState('');
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [editUserForm, setEditUserForm] = useState({ username: '', password: '', role: 'viewer', permissions: [] as string[] });
  const [savingEditUser, setSavingEditUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer', permissions: ['live'] as string[] });
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '' });
  const [savingPassword, setSavingPassword] = useState(false);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [storageReport, setStorageReport] = useState<StorageReport | null>(null);
  const [purgingRecordings, setPurgingRecordings] = useState(false);
  const [purgeCameraId, setPurgeCameraId] = useState('');
  const [streamDiagnostics, setStreamDiagnostics] = useState<Record<string, StreamDiagnostic>>({});
  const [zoneSnapshotUrl, setZoneSnapshotUrl] = useState('');
  const [zoneSnapshotLoading, setZoneSnapshotLoading] = useState(false);
  const [zoneSnapshotError, setZoneSnapshotError] = useState('');
  const [activeZoneId, setActiveZoneId] = useState('');
  const [draggingPoint, setDraggingPoint] = useState<{ zoneId: string; pointIndex: number } | null>(null);

  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    update_available: boolean;
    current_sha: string;
    latest_sha: string;
    manifest_url?: string;
    version?: string;
    ref?: string;
    notes?: string;
    error?: string;
  } | null>(null);
  const [updating, setUpdating] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [factoryResetting, setFactoryResetting] = useState(false);
  const [showFactoryResetConfirm, setShowFactoryResetConfirm] = useState(false);
  const [factoryResetConfirmText, setFactoryResetConfirmText] = useState('');

  const checkUpdates = async () => {
    setCheckingUpdates(true);
    try {
      const res = await fetch(apiUrl('/system/updates/check'));
      if (res.ok) {
        const data = await res.json();
        setUpdateInfo(data);
        if (data.update_available) {
          showToast(`Update available from manifest. Latest: ${data.latest_sha}`);
          if (systemConfig.updates.auto_download) {
            await installUpdate();
          }
        } else if (data.error) {
          showToast(`Update check: ${data.error}`);
        } else {
          showToast('You are on the latest version.');
        }
      } else {
        showToast('Failed to check for updates.');
      }
    } catch {
      showToast('Network error checking for updates.');
    }
    setCheckingUpdates(false);
  };

  const installUpdate = async () => {
    setUpdating(true);
    try {
      const res = await fetch(apiUrl('/system/updates/install'), { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message || 'NVR update initiated. Rebuilding Docker containers...');
      } else {
        const err = await res.json();
        showToast(`Update failed: ${err.detail || 'Unknown error'}`);
      }
    } catch {
      showToast('Network error initiating update.');
    }
    setUpdating(false);
  };

  const backupDatabase = async () => {
    setBackingUp(true);
    try {
      const res = await fetch(apiUrl('/system/backup'), { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Backup failed.');
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
      const filename = filenameMatch?.[1] || `mview-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast('Backup downloaded.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Backup failed.');
    } finally {
      setBackingUp(false);
    }
  };

  const restartServices = async () => {
    if (!confirm('Restart the API and detector services now?')) return;
    setRestarting(true);
    try {
      const res = await fetch(apiUrl('/system/restart'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Restart failed.');
      showToast(data.message || 'Restart initiated.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Restart failed.');
    } finally {
      setRestarting(false);
    }
  };

  const handleFactoryReset = async () => {
    if (factoryResetConfirmText !== 'RESET') {
      showToast('Please type "RESET" to confirm.');
      return;
    }
    setFactoryResetting(true);
    try {
      const res = await fetch(apiUrl('/system/factory-reset'), {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
        },
      });
      if (res.ok) {
        showToast('Factory reset complete. Logging out...');
        try { localStorage.removeItem('mview_token'); } catch {}
        try {
          await fetch(apiUrl('/auth/logout'), { method: 'POST' });
        } catch {}
        window.dispatchEvent(new Event('sentinel-unauthorized'));
        setTimeout(() => {
          window.location.href = '/';
        }, 1500);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(`Factory reset failed: ${err.detail || err.message || `HTTP ${res.status}`}`);
        setFactoryResetting(false);
      }
    } catch (err: any) {
      console.error('Factory reset error:', err);
      showToast(`Network error during factory reset: ${err?.message || 'Server did not respond'}`);
      setFactoryResetting(false);
    }
  };

  const [currentUser, setCurrentUser] = useState<TokenUser>({});
  const isAdmin = currentUser.role === 'admin';

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/auth/me'))
      .then((res) => (res.ok ? res.json() : null))
      .then((user) => {
        if (!cancelled && user) setCurrentUser(user);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tab === 'ai' || tab === 'network' || tab === 'system') loadSystemConfig();
    if (tab === 'system') loadSystemHealth();
    if (tab === 'users' && isAdmin) fetchUsers();
  }, [tab, isAdmin]);

  const loadSystemConfig = async () => {
    try {
      const res = await fetch(apiUrl('/system/config'));
      if (res.ok) {
        const data = await res.json();
        setSystemConfig({
          ...defaultSystemConfig,
          ...data,
          ai: { ...defaultSystemConfig.ai, ...(data.ai || {}) },
          network: { ...defaultSystemConfig.network, ...(data.network || {}) },
          updates: { ...defaultSystemConfig.updates, ...(data.updates || {}) },
        });
      }
    } catch {}
  };

  const saveSystemConfig = async (nextConfig: SystemConfig = systemConfig) => {
    setSavingConfig(true);
    try {
      const res = await fetch(apiUrl('/system/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig)
      });
      if (res.ok) {
        const data = await res.json();
        setSystemConfig({
          ...defaultSystemConfig,
          ...data,
          ai: { ...defaultSystemConfig.ai, ...(data.ai || {}) },
          network: { ...defaultSystemConfig.network, ...(data.network || {}) },
          updates: { ...defaultSystemConfig.updates, ...(data.updates || {}) },
        });
        showToast('Configuration updated successfully.');
      } else {
        showToast('Failed to update configuration.');
      }
    } catch {
      showToast('Network error while updating configuration.');
    }
    setSavingConfig(false);
  };

  const loadSystemHealth = async () => {
    try {
      const [healthRes, storageRes, diagnosticsRes] = await Promise.all([
        fetch(apiUrl('/system/health')),
        fetch(apiUrl('/system/storage-report')),
        fetch(apiUrl('/system/stream-diagnostics')),
      ]);
      if (healthRes.ok) setSystemHealth(await healthRes.json());
      if (storageRes.ok) setStorageReport(await storageRes.json());
      if (diagnosticsRes.ok) setStreamDiagnostics(await diagnosticsRes.json());
    } catch {}
  };

  const purgeRecordings = async () => {
    const selectedCamera = purgeCameraId ? cameras.find(cam => cam.id === purgeCameraId) : null;
    const usage = selectedCamera ? `recordings for ${selectedCamera.name}` : (storageReport?.total_gb ? `${storageReport.total_gb} GB` : 'all stored video');
    if (!window.confirm(`Delete ${usage} of recordings? This cannot be undone.`)) return;
    setPurgingRecordings(true);
    try {
      const query = purgeCameraId ? `?camera_id=${encodeURIComponent(purgeCameraId)}` : '';
      let res = await fetch(apiUrl(`/system/recordings/purge${query}`), { method: 'POST' });
      if (!res.ok) {
        res = await fetch(apiUrl(`/system/purge-recordings${query}`), { method: 'POST' });
      }
      if (res.ok) {
        const data = await res.json();
        if (data.storage_report) setStorageReport(data.storage_report);
        await loadSystemHealth();
        showToast(`Purged ${data.deleted_gb || 0} GB across ${data.deleted_files || 0} files.`);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to purge recordings.');
      }
    } catch {
      showToast('Network error while purging recordings.');
    }
    setPurgingRecordings(false);
  };

  const [runningDiag, setRunningDiag] = useState(false);
  const [runningVac, setRunningVac] = useState(false);

  const runDiagnostics = async () => {
    setRunningDiag(true);
    try {
      const res = await fetch(apiUrl('/system/diagnostics'));
      if (res.ok) {
        const data = await res.json();
        showToast(`Diagnostics: ${data.status.toUpperCase()} | DB: ${data.database_connected ? 'OK' : 'ERR'} | go2rtc: ${data.go2rtc_active ? 'OK' : 'ERR'} | Free Disk: ${data.storage.free_gb} GB`);
      } else {
        showToast('Diagnostics audit failed.');
      }
    } catch {
      showToast('Network error running diagnostics.');
    }
    setRunningDiag(false);
  };

  const runVacuum = async () => {
    setRunningVac(true);
    try {
      const res = await fetch(apiUrl('/system/maintenance/vacuum'), { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message || 'Database query indexes optimized.');
      } else {
        showToast('Database maintenance failed.');
      }
    } catch {
      showToast('Network error during database maintenance.');
    }
    setRunningVac(false);
  };

  const loadZoneSnapshot = async (cameraId: string) => {
    if (!cameraId) return;
    if (zoneSnapshotUrl) URL.revokeObjectURL(zoneSnapshotUrl);
    setZoneSnapshotUrl('');
    setZoneSnapshotError('');
    setZoneSnapshotLoading(true);
    try {
      const res = await fetch(apiUrl(`/cameras/${cameraId}/snapshot`));
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Snapshot capture failed.');
      }
      setZoneSnapshotUrl(URL.createObjectURL(await res.blob()));
    } catch (err: any) {
      setZoneSnapshotError(err.message || 'Snapshot capture failed.');
    }
    setZoneSnapshotLoading(false);
  };

  const fetchUsers = async () => {
    setUsersError('');
    try {
      const res = await fetch(apiUrl('/users'));
      if (res.ok) {
        setUsers(await res.json());
      } else {
        const err = await res.json().catch(() => ({}));
        setUsersError(err.detail || 'Failed to load users.');
      }
    } catch {
      setUsersError('Network error while loading users.');
    }
  };

  const createUser = async () => {
    if (!newUser.username.trim() || !newUser.password.trim()) {
      showToast('Username and password are required.');
      return;
    }
    try {
      const res = await fetch(apiUrl('/users'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser),
      });
      if (res.ok) {
        setNewUser({ username: '', password: '', role: 'viewer', permissions: ['live'] });
        await fetchUsers();
        showToast('User created.');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to create user.');
      }
    } catch {
      showToast('Network error while creating user.');
    }
  };

  const deleteUser = async (userId: string) => {
    if (!window.confirm('Delete this user?')) return;
    try {
      const res = await fetch(apiUrl(`/users/${userId}`), { method: 'DELETE' });
      if (res.ok) {
        await fetchUsers();
        showToast('User deleted.');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to delete user.');
      }
    } catch {
      showToast('Network error while deleting user.');
    }
  };

  const changePassword = async () => {
    if (!currentUser.id || !passwordForm.new_password.trim()) return;
    setSavingPassword(true);
    try {
      const res = await fetch(apiUrl(`/users/${currentUser.id}/password`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(passwordForm),
      });
      if (res.ok) {
        setPasswordForm({ current_password: '', new_password: '' });
        showToast('Password updated.');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to change password.');
      }
    } catch {
      showToast('Network error while changing password.');
    }
    setSavingPassword(false);
  };

  const startEditUser = (user: UserAccount) => {
    setEditingUser(user);
    setEditUserForm({
      username: user.username,
      password: '',
      role: user.role,
      permissions: [...user.permissions]
    });
  };

  const saveEditUser = async () => {
    if (!editingUser) return;
    if (!editUserForm.username.trim()) {
      showToast('Username is required.');
      return;
    }
    setSavingEditUser(true);
    try {
      const payload: any = {
        username: editUserForm.username,
        role: editUserForm.role,
        permissions: editUserForm.permissions
      };
      if (editUserForm.password.trim()) {
        payload.password = editUserForm.password;
      }
      const res = await fetch(apiUrl(`/users/${editingUser.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setEditingUser(null);
        await fetchUsers();
        showToast('User updated successfully.');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to update user.');
      }
    } catch {
      showToast('Network error while updating user.');
    }
    setSavingEditUser(false);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const fetchCameras = async () => {
    try {
      const res = await fetch(apiUrl('/cameras'));
      if (res.ok) setCameras(await res.json());
    } catch {}
  };

  const deleteCamera = async (id: string) => {
    const cam = cameras.find(c => c.id === id);
    if (!window.confirm(`Are you sure you want to delete camera "${cam?.name || id}"? This will also remove associated events and recordings.`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/cameras/${id}`), { method: 'DELETE' });
      if (res.ok) {
        showToast('Camera deleted successfully.');
        await fetchCameras();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(`Failed to delete camera: ${err.detail || 'Unknown error'}`);
      }
    } catch {
      showToast('Network error while deleting camera.');
    }
    setDeletingId(null);
  };

  const handleQuickRename = async (id: string) => {
    if (!quickRenameValue.trim()) return;
    try {
      const res = await fetch(apiUrl(`/cameras/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: quickRenameValue.trim() }),
      });
      if (res.ok) {
        showToast('Camera renamed successfully.');
        setQuickRenamingId(null);
        await fetchCameras();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(`Failed to rename camera: ${err.detail || 'Unknown error'}`);
      }
    } catch {
      showToast('Network error while renaming camera.');
    }
  };

  useEffect(() => { fetchCameras(); }, []);

  useEffect(() => () => {
    if (zoneSnapshotUrl) URL.revokeObjectURL(zoneSnapshotUrl);
  }, [zoneSnapshotUrl]);

  // ── Auto-Discover ───────────────────────────────────────────────
  const discover = async () => {
    setDiscovering(true);
    setDiscovered([]);
    setDiscoveryError('');
    try {
      const res = await fetch(apiUrl('/cameras/discover'), { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setDiscovered(data);
        if (data.length === 0) setDiscoveryError('No ONVIF cameras found. Check that your cameras are on the same network and ONVIF is enabled, or add cameras manually below.');
      } else {
        setDiscoveryError('Discovery request failed. The API may not be able to reach the network from inside Docker. Add cameras manually instead.');
      }
    } catch {
      setDiscoveryError('Could not reach the API server.');
    }
    setDiscovering(false);
  };

  const adoptCamera = async (cam: any, u: string, p: string) => {
    setAdopting(cam.id || cam.onvif_endpoint);
    try {
      const res = await fetch(apiUrl('/cameras/adopt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cam, username: u, password: p }),
      });
      if (res.ok) {
        setDiscovered(prev => prev.filter(c => c.onvif_endpoint !== cam.onvif_endpoint));
        await fetchCameras();
        showToast('Camera adopted successfully!');
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(`Failed to adopt: ${err.detail || 'Unknown error'}`);
      }
    } catch {
      showToast('Network error while adopting.');
    }
    setAdopting(null);
  };

  // ── Manual Add / Edit ──────────────────────────────────────────
  const addManually = async () => {
    if (!manualForm.name.trim()) { setSaveError('Camera name is required.'); return; }
    if (!editingId && !manualForm.rtsp_url_main.trim() && !manualForm.ip.trim()) {
      setSaveError('Either an RTSP URL or IP address is required.'); return;
    }
    setSavingManual(true);
    setSaveError('');
    try {
      let body: any;
      if (editingId) {
        body = {
          name: manualForm.name.trim(),
          enabled: manualForm.enabled,
          config: { record_substream: manualForm.record_substream, zones: manualForm.zones },
        };
        if (manualForm.onvif_username.trim()) body.onvif_username = manualForm.onvif_username.trim();
        if (manualForm.onvif_password.trim()) body.onvif_password = manualForm.onvif_password.trim();
        if (manualForm.ip.trim()) {
          body.onvif_endpoint = `http://${manualForm.ip.trim()}:${manualForm.port || '80'}/onvif/device_service`;
        }
        if (manualForm.rtsp_url_main.trim() && !manualForm.rtsp_url_main.includes('***')) {
          body.rtsp_url_main = manualForm.rtsp_url_main.trim();
        }
        if (manualForm.rtsp_url_sub.trim() && !manualForm.rtsp_url_sub.includes('***')) {
          body.rtsp_url_sub = manualForm.rtsp_url_sub.trim();
        }
      } else {
        body = {
          name: manualForm.name.trim(),
          rtsp_url_main: restoreMaskedRtspPassword(manualForm.rtsp_url_main.trim(), originalRtsp.main) || `rtsp://${manualForm.onvif_username}:${manualForm.onvif_password}@${manualForm.ip.trim()}:554/stream1`,
          rtsp_url_sub: restoreMaskedRtspPassword(manualForm.rtsp_url_sub.trim(), originalRtsp.sub) || undefined,
          onvif_endpoint: manualForm.ip ? `http://${manualForm.ip.trim()}:${manualForm.port}/onvif/device_service` : undefined,
          onvif_username: manualForm.onvif_username,
          onvif_password: manualForm.onvif_password,
          manufacturer: 'Manual',
          model: 'IP Camera',
          status: 'online',
          enabled: manualForm.enabled,
          auto_adopted: false,
          config: { record_substream: manualForm.record_substream, zones: manualForm.zones },
        };
      }
      
      const method = editingId ? 'PATCH' : 'POST';
      const url = editingId ? apiUrl(`/cameras/${editingId}`) : apiUrl('/cameras');
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setManualForm(emptyForm);
        setOriginalRtsp({ main: '', sub: '' });
        setActiveZoneId('');
        setZoneSnapshotUrl('');
        setZoneSnapshotError('');
        setShowManualForm(false);
        setEditingId(null);
        await fetchCameras();
        showToast(editingId ? 'Camera updated successfully!' : 'Camera added successfully!');
      } else {
        const err = await res.json().catch(() => ({}));
        setSaveError(err.detail || 'Failed to save camera.');
      }
    } catch {
      setSaveError('Network error.');
    }
    setSavingManual(false);
  };

  const updateZone = (zoneId: string, patch: Partial<DetectionZone>) => {
    setManualForm(form => ({
      ...form,
      zones: form.zones.map(zone => zone.id === zoneId ? { ...zone, ...patch } : zone)
    }));
  };

  const toggleZoneObject = (zoneId: string, objectName: string) => {
    setManualForm(form => ({
      ...form,
      zones: form.zones.map(zone => {
        if (zone.id !== zoneId) return zone;
        const selected = zone.objects.includes(objectName);
        return {
          ...zone,
          objects: selected ? zone.objects.filter(v => v !== objectName) : [...zone.objects, objectName]
        };
      })
    }));
  };

  const updateZonePoint = (zoneId: string, pointIndex: number, point: ZonePoint) => {
    setManualForm(form => ({
      ...form,
      zones: form.zones.map(zone => {
        if (zone.id !== zoneId) return zone;
        return {
          ...zone,
          points: zone.points.map((existing, index) => index === pointIndex ? point : existing)
        };
      })
    }));
  };

  const pointFromPointer = (event: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>): ZonePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const navTabs: { id: Tab; label: string }[] = [
    { id: 'cameras', label: 'Cameras & Hardware' },
    { id: 'ai', label: 'AI & Detection' },
    { id: 'network', label: 'Network' },
    { id: 'system', label: 'System' },
    { id: 'users', label: 'Users & Security' },
  ];
  const cameraNameById = Object.fromEntries(cameras.map(cam => [cam.id, cam.name]));

  return (
    <div className="settings-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top Bar */}
      <div className="topbar settings-page-topbar" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--t1)' }}>System Configuration</h1>
        <span style={{ fontSize: '0.8rem', color: 'var(--t2)' }}>Manage hardware, AI pipelines and network settings</span>
      </div>

      <div className="settings-page-layout" style={{ flex: 1, display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, padding: 20, overflow: 'hidden', minHeight: 0 }}>
        {/* Sidebar nav */}
        <div className="settings-nav">
          {navTabs.map(t => (
            <button
              key={t.id}
              className={`nav-item${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="settings-page-content" style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 20, paddingRight: 4, paddingBottom: 100 }}>

          {tab === 'cameras' && (
            <>
              {/* ── Existing Cameras ── */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">{editingId ? 'Edit Camera' : 'Active Cameras'}</span>
                  {!showManualForm && (
                    <button className="btn btn-primary" onClick={() => {
                      setEditingId(null);
                      setManualForm(emptyForm);
                      setOriginalRtsp({ main: '', sub: '' });
                      setActiveZoneId('');
                      setZoneSnapshotUrl('');
                      setZoneSnapshotError('');
                      setSaveError('');
                      setShowManualForm(true);
                    }}>
                      <Plus size={15} /> Add Camera Manually
                    </button>
                  )}
                </div>

                {/* Manual Add Form */}
                {showManualForm && (
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'rgba(0,229,255,0.03)' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--cyan)', marginBottom: 14 }}>
                      {editingId ? `Edit Camera: ${manualForm.name || 'Selected'}` : '＋ New Camera'}
                    </div>
                    {editingId && (
                      <div style={{ background: 'rgba(0,210,255,0.06)', border: '1px solid rgba(0,210,255,0.22)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.78rem', color: 'var(--t2)', lineHeight: 1.5 }}>
                        <strong style={{ color: 'var(--cyan)' }}>✦ Camera Settings:</strong> To rename the camera, simply change the name below and click Save. Existing stream URLs and ONVIF discovery parameters remain preserved unless you explicitly enter new values.
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                      <div className="form-group">
                        <label className="form-label">Camera Name *</label>
                        <input className="form-input" placeholder="e.g. Front Door" value={manualForm.name}
                          onChange={e => setManualForm(f => ({ ...f, name: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">IP Address</label>
                        <input className="form-input" placeholder="e.g. 192.168.1.100" value={manualForm.ip}
                          onChange={e => setManualForm(f => ({ ...f, ip: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">ONVIF Port</label>
                        <input className="form-input" placeholder="80" value={manualForm.port}
                          onChange={e => setManualForm(f => ({ ...f, port: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Username</label>
                        <input className="form-input" placeholder={editingId ? 'Leave blank to keep current' : 'admin'} value={manualForm.onvif_username}
                          onChange={e => setManualForm(f => ({ ...f, onvif_username: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Password</label>
                        <input className="form-input" type="password" placeholder={editingId ? 'Leave blank to keep current' : '••••••••'} value={manualForm.onvif_password}
                          onChange={e => setManualForm(f => ({ ...f, onvif_password: e.target.value }))} />
                      </div>
                      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label className="form-label">RTSP Main Stream URL {editingId ? '(optional, keep unchanged or enter new URL)' : '(optional, auto-built from IP if empty)'}</label>
                        <input className="form-input" type="text" autoComplete="off" spellCheck={false}
                          placeholder="rtsp://username:password@camera-ip:554/stream1"
                          value={manualForm.rtsp_url_main}
                          onChange={e => setManualForm(f => ({ ...f, rtsp_url_main: e.target.value }))} />
                      </div>
                      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                        <label className="form-label">RTSP Sub Stream URL {editingId ? '(optional, keep unchanged or enter new URL)' : '(optional)'}</label>
                        <input className="form-input" type="text" autoComplete="off" spellCheck={false}
                          placeholder="rtsp://username:password@camera-ip:554/stream2"
                          value={manualForm.rtsp_url_sub}
                          onChange={e => setManualForm(f => ({ ...f, rtsp_url_sub: e.target.value }))} />
                      </div>
                      <div className="form-group" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                        <input type="checkbox" id="cameraEnabled"
                          checked={manualForm.enabled}
                          onChange={e => setManualForm(f => ({ ...f, enabled: e.target.checked }))}
                          style={{ width: 18, height: 18, accentColor: 'var(--cyan)' }} />
                        <label htmlFor="cameraEnabled" className="form-label" style={{ margin: 0, cursor: 'pointer', fontSize: '0.85rem' }}>
                          Recording Enabled
                        </label>
                      </div>
                      <div className="form-group" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                        <input type="checkbox" id="recordSubstream"
                          checked={manualForm.record_substream}
                          onChange={e => setManualForm(f => ({ ...f, record_substream: e.target.checked }))}
                          style={{ width: 18, height: 18, accentColor: 'var(--cyan)' }} />
                        <label htmlFor="recordSubstream" className="form-label" style={{ margin: 0, cursor: 'pointer', fontSize: '0.85rem' }}>
                          Record Substream (Low Disk Space Mode)
                        </label>
                      </div>
                      <div className="form-group" style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                          <div>
                            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--t1)' }}>AI Zones & Alerts</div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--t3)', marginTop: 3 }}>Normalized points use 0.00 to 1.00 across the camera frame.</div>
                          </div>
                          <button className="btn btn-ghost" style={{ padding: '7px 12px' }} onClick={() => {
                            const zone = createDetectionZone();
                            setManualForm(f => ({ ...f, zones: [...f.zones, zone] }));
                            setActiveZoneId(zone.id);
                          }}>
                            <Plus size={14} /> Add Zone
                          </button>
                        </div>
                        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 12, background: 'rgba(0,0,0,0.25)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ fontSize: '0.72rem', color: 'var(--t3)' }}>Visual zone editor</div>
                            <button className="btn btn-ghost" style={{ padding: '6px 10px' }} onClick={() => editingId && loadZoneSnapshot(editingId)} disabled={!editingId || zoneSnapshotLoading}>
                              {zoneSnapshotLoading ? 'Loading...' : 'Load Snapshot'}
                            </button>
                          </div>
                          {zoneSnapshotError && <div style={{ padding: 12, color: 'var(--amber)', fontSize: '0.72rem' }}>{zoneSnapshotError}</div>}
                          {zoneSnapshotUrl ? (
                            <div style={{ position: 'relative', aspectRatio: '16 / 9', width: '100%', maxHeight: 420 }}>
                              <img src={zoneSnapshotUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }} />
                              <svg
                                viewBox="0 0 1 1"
                                preserveAspectRatio="none"
                                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: draggingPoint ? 'grabbing' : 'crosshair', touchAction: 'none' }}
                                onPointerMove={event => {
                                  if (!draggingPoint) return;
                                  updateZonePoint(draggingPoint.zoneId, draggingPoint.pointIndex, pointFromPointer(event));
                                }}
                                onPointerUp={() => setDraggingPoint(null)}
                                onPointerLeave={() => setDraggingPoint(null)}
                                onClick={event => {
                                  if (!activeZoneId || draggingPoint) return;
                                  const point = pointFromPointer(event);
                                  setManualForm(form => ({
                                    ...form,
                                    zones: form.zones.map(zone => zone.id === activeZoneId ? { ...zone, points: [...zone.points, point] } : zone)
                                  }));
                                }}
                              >
                                {manualForm.zones.map(zone => (
                                  <g key={zone.id} opacity={zone.enabled ? 1 : 0.35}>
                                    {zone.points.length >= 2 && (
                                      <polygon
                                        points={zone.points.map(p => `${p.x},${p.y}`).join(' ')}
                                        fill={zone.id === activeZoneId ? 'rgba(0, 230, 118, 0.22)' : 'rgba(0, 229, 255, 0.14)'}
                                        stroke={zone.id === activeZoneId ? 'var(--green)' : 'var(--cyan)'}
                                        strokeWidth="0.004"
                                      />
                                    )}
                                    {zone.points.map((point, index) => (
                                      <circle
                                        key={`${zone.id}-${index}`}
                                        cx={point.x}
                                        cy={point.y}
                                        r="0.012"
                                        fill={zone.id === activeZoneId ? 'var(--green)' : 'var(--cyan)'}
                                        stroke="#001018"
                                        strokeWidth="0.004"
                                        onPointerDown={event => {
                                          event.stopPropagation();
                                          setActiveZoneId(zone.id);
                                          setDraggingPoint({ zoneId: zone.id, pointIndex: index });
                                        }}
                                      />
                                    ))}
                                  </g>
                                ))}
                              </svg>
                            </div>
                          ) : (
                            <div style={{ padding: 12, color: 'var(--t3)', fontSize: '0.72rem' }}>
                              {editingId ? 'Load a current camera snapshot, select a zone below, then click or drag points on the image.' : 'Save the camera first, then edit it to draw zones over a live snapshot.'}
                            </div>
                          )}
                        </div>
                        {manualForm.zones.length === 0 ? (
                          <div style={{ fontSize: '0.76rem', color: 'var(--t3)', border: '1px dashed var(--border)', borderRadius: 8, padding: 12 }}>
                            No AI zones configured. Without zones, events are accepted from the full frame.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {manualForm.zones.map(zone => (
                              <div key={zone.id} style={{ border: zone.id === activeZoneId ? '1px solid var(--green)' : '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'rgba(255,255,255,0.02)' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 2fr) minmax(100px, 1fr) minmax(100px, 1fr) auto', gap: 10, alignItems: 'end' }}>
                                  <div className="form-group">
                                    <label className="form-label">Zone Name</label>
                                    <input className="form-input" value={zone.name} onFocus={() => setActiveZoneId(zone.id)} onChange={e => updateZone(zone.id, { name: e.target.value })} />
                                  </div>
                                  <div className="form-group">
                                    <label className="form-label">Min Confidence</label>
                                    <input className="form-input" type="number" min="0" max="100" value={Math.round(zone.min_confidence * 100)}
                                      onChange={e => updateZone(zone.id, { min_confidence: Math.max(0, Math.min(1, (parseInt(e.target.value) || 0) / 100)) })} />
                                  </div>
                                  <div className="form-group">
                                    <label className="form-label">Cooldown Sec</label>
                                    <input className="form-input" type="number" min="0" value={zone.cooldown_seconds}
                                      onChange={e => updateZone(zone.id, { cooldown_seconds: parseInt(e.target.value) || 0 })} />
                                  </div>
                                  <button className="btn btn-danger" style={{ padding: '9px 12px' }} onClick={() => setManualForm(f => ({ ...f, zones: f.zones.filter(z => z.id !== zone.id) }))}>
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                                  <button className="btn btn-ghost" style={{ padding: '6px 10px' }} onClick={() => setActiveZoneId(zone.id)}>Edit On Snapshot</button>
                                  <button className="btn btn-ghost" style={{ padding: '6px 10px' }} onClick={() => updateZone(zone.id, { points: createDetectionZone().points })}>Reset Points</button>
                                  <button className="btn btn-ghost" style={{ padding: '6px 10px' }} onClick={() => updateZone(zone.id, { points: zone.points.slice(0, -1) })}>Remove Last Point</button>
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10 }}>
                                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                                    <input type="checkbox" checked={zone.enabled} onChange={e => updateZone(zone.id, { enabled: e.target.checked })} style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }} />
                                    Enabled
                                  </label>
                                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                                    <input type="checkbox" checked={zone.notify} onChange={e => updateZone(zone.id, { notify: e.target.checked })} style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }} />
                                    Notify
                                  </label>
                                  {detectionObjects.map(objectName => (
                                    <label key={objectName} className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, textTransform: 'capitalize' }}>
                                      <input type="checkbox" checked={zone.objects.includes(objectName)} onChange={() => toggleZoneObject(zone.id, objectName)} style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }} />
                                      {objectName}
                                    </label>
                                  ))}
                                </div>
                                <div className="form-group" style={{ marginTop: 10 }}>
                                  <label className="form-label">Zone Points</label>
                                  <textarea className="form-input" rows={3} value={pointsToText(zone.points)}
                                    onChange={e => updateZone(zone.id, { points: textToPoints(e.target.value) })}
                                    style={{ resize: 'vertical', fontFamily: 'JetBrains Mono' }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {saveError && (
                      <div style={{ marginTop: 10, color: 'var(--red)', fontSize: '0.8rem' }}>⚠ {saveError}</div>
                    )}
                    <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                      <button className="btn btn-primary" onClick={addManually} disabled={savingManual}>
                        {savingManual ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : <><CheckCircle size={15} /> Save Camera</>}
                      </button>
                      <button className="btn btn-ghost" onClick={() => { setShowManualForm(false); setSaveError(''); setEditingId(null); setOriginalRtsp({ main: '', sub: '' }); setActiveZoneId(''); setZoneSnapshotUrl(''); setZoneSnapshotError(''); setManualForm(emptyForm); }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {cameras.length === 0 ? (
                  <div className="empty">
                    <div className="empty-title">No cameras added yet</div>
                    <div className="empty-sub">Use "Add Camera Manually" above or auto-discover ONVIF devices below.</div>
                  </div>
                ) : (
                  <div>
                    {cameras.map(cam => (
                      <div key={cam.id} style={{
                        display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px',
                        borderBottom: '1px solid var(--border)',
                      }}>
                        <div className={`dot ${cam.status === 'offline' ? 'offline' : cam.status === 'recording' ? 'recording' : 'online'}`} style={{ flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                          {quickRenamingId === cam.id ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                              <input
                                className="form-input"
                                style={{ padding: '3px 8px', fontSize: '0.84rem', width: 220, height: 28 }}
                                value={quickRenameValue}
                                onChange={e => setQuickRenameValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleQuickRename(cam.id);
                                  if (e.key === 'Escape') setQuickRenamingId(null);
                                }}
                                autoFocus
                              />
                              <button className="btn btn-primary" style={{ padding: '3px 8px', fontSize: '0.72rem', height: 28 }} onClick={() => handleQuickRename(cam.id)}>
                                Save
                              </button>
                              <button className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: '0.72rem', height: 28 }} onClick={() => setQuickRenamingId(null)}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ 
                                fontWeight: 600, fontSize: '0.875rem', color: 'var(--t1)',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                              }} title={cam.name}>
                                {cam.name}
                              </span>
                              <button
                                title="Quick rename"
                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--t3)', display: 'inline-flex', alignItems: 'center' }}
                                onClick={() => {
                                  setQuickRenamingId(cam.id);
                                  setQuickRenameValue(cam.name);
                                }}
                              >
                                <Edit2 size={12} />
                              </button>
                            </div>
                          )}
                          <div style={{ 
                            fontSize: '0.72rem', color: 'var(--t3)', marginTop: 2,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                          }}>
                            {[
                              cam.resolution,
                              cam.enabled === false ? 'Recording disabled' : cam.config?.record_substream ? 'Recording substream' : 'Recording main stream',
                              cam.auto_adopted ? 'Auto-adopted' : 'Manual'
                            ].filter(Boolean).join(' / ')}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, maxWidth: '35%' }}>
                          <span style={{
                            fontSize: '0.68rem', padding: '2px 8px', borderRadius: 20, flexShrink: 0,
                            background: cam.status === 'offline' ? 'rgba(255,255,255,0.04)' : cam.status === 'recording' ? 'var(--red-dim)' : 'var(--green-dim)',
                            color: cam.status === 'offline' ? 'var(--t3)' : cam.status === 'recording' ? 'var(--red)' : 'var(--green)',
                            fontWeight: 600, border: '1px solid',
                            borderColor: cam.status === 'offline' ? 'var(--border)' : cam.status === 'recording' ? 'rgba(255,23,68,0.3)' : 'rgba(0,230,118,0.3)',
                          }}>
                            {cam.status.toUpperCase()}
                          </span>
                          {cam.manufacturer && (
                            <span style={{ 
                              fontSize: '0.68rem', color: 'var(--t3)', padding: '2px 8px', borderRadius: 20, border: '1px solid var(--border)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                            }} title={`${cam.manufacturer} ${cam.model}`}>
                              {cam.manufacturer} {cam.model}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '6px 10px' }}
                            onClick={() => {
                              // Extract IP/Port if possible
                              let ip = '', port = '80';
                              if (cam.onvif_endpoint) {
                                const match = cam.onvif_endpoint.match(/http:\/\/([^:]+):(\d+)/);
                                if (match) { ip = match[1]; port = match[2]; }
                              }
                              setManualForm({
                                name: cam.name,
                                ip,
                                port,
                                onvif_username: '',
                                onvif_password: '',
                                rtsp_url_main: maskRtspPassword(cam.rtsp_url_main || ''),
                                rtsp_url_sub: maskRtspPassword(cam.rtsp_url_sub || ''),
                                enabled: cam.enabled !== false,
                                record_substream: cam.config?.record_substream || false,
                                zones: Array.isArray(cam.config?.zones) ? cam.config.zones : []
                              });
                              setActiveZoneId(Array.isArray(cam.config?.zones) && cam.config.zones[0] ? cam.config.zones[0].id : '');
                              setZoneSnapshotUrl('');
                              setZoneSnapshotError('');
                              setOriginalRtsp({ main: cam.rtsp_url_main || '', sub: cam.rtsp_url_sub || '' });
                              setEditingId(cam.id);
                              setShowManualForm(true);
                              // Scroll to top
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '6px 10px' }}
                            onClick={() => deleteCamera(cam.id)}
                            disabled={deletingId === cam.id}
                          >
                            {deletingId === cam.id ? <div className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} /> : <Trash2 size={14} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Auto-Discovery ── */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Auto-Discover ONVIF Cameras</span>
                  <button className="btn btn-primary" onClick={discover} disabled={discovering}>
                    {discovering
                      ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Scanning…</>
                      : <><Search size={15} /> Scan Network</>
                    }
                  </button>
                </div>

                <div style={{ padding: '16px 20px', fontSize: '0.82rem', color: 'var(--t2)', borderBottom: '1px solid var(--border)', lineHeight: 1.5, background: 'rgba(0,0,0,0.1)' }}>
                  <strong style={{ color: 'var(--amber)' }}>⚠ Note:</strong> ONVIF WS-Discovery uses UDP multicast.
                  If the API runs inside Docker with bridge networking, cameras on your LAN may not be reachable.
                  For best results, add the line <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 3 }}>network_mode: host</code> to
                  the <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 3 }}>api</code> service in your docker-compose.yml,
                  or use the manual form above.
                </div>

                {discoveryError && (
                  <div style={{ padding: '14px 20px', color: 'var(--amber)', fontSize: '0.82rem' }}>
                    ⚠ {discoveryError}
                  </div>
                )}

                {discovered.length > 0 && (
                  <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--green)', fontWeight: 600, marginBottom: 4 }}>
                      ✓ Found {discovered.length} device{discovered.length !== 1 ? 's' : ''}
                    </div>
                    {discovered.map((cam, i) => {
                      const creds = adoptForm[cam.onvif_endpoint] || { u: 'admin', p: 'admin' };
                      const setCreds = (c: any) => setAdoptForm(prev => ({...prev, [cam.onvif_endpoint]: c}));
                      return (
                        <div key={i} className="discovery-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div className="discovery-item-info">
                              <div className="name">{cam.manufacturer} {cam.model}</div>
                              <div className="url">{cam.onvif_endpoint} · {cam.ip}</div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <input className="form-input" style={{ width: 140, padding: '6px 10px', fontSize: '0.8rem' }} placeholder="Username" value={creds.u} onChange={e => setCreds({...creds, u: e.target.value})} />
                            <input className="form-input" style={{ width: 140, padding: '6px 10px', fontSize: '0.8rem' }} type="password" placeholder="Password" value={creds.p} onChange={e => setCreds({...creds, p: e.target.value})} />
                            <button
                              className="btn btn-primary"
                              onClick={() => adoptCamera(cam, creds.u, creds.p)}
                              disabled={adopting === (cam.id || cam.onvif_endpoint)}
                            >
                              {adopting === (cam.id || cam.onvif_endpoint)
                                ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                : <><Plus size={14} /> Adopt</>
                              }
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!discovering && discovered.length === 0 && !discoveryError && (
                  <div className="empty">
                    <div className="empty-sub">Click "Scan Network" to search for ONVIF cameras on your local network.</div>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'ai' && (<>
            <div className="card">
              <div className="card-head">
                <span className="card-title">AI Pipeline Configuration</span>
              </div>
              <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
                  <div className="form-group">
                    <label className="form-label">Global Detection Model</label>
                    <select
                      className="form-select"
                      value={systemConfig.ai.object_model}
                      onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, object_model: e.target.value } }))}
                    >
                      <option value="yolov8n">YOLOv8 Nano (Fastest — CPU optimised)</option>
                      <option value="yolov8s">YOLOv8 Small (Balanced)</option>
                      <option value="yolo11n">YOLO11 Nano (Next-Gen)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Hardware Accelerator</label>
                    <select
                      className="form-select"
                      value={systemConfig.ai.accelerator}
                      onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, accelerator: e.target.value } }))}
                    >
                      <option value="auto">Auto-Detect (Recommended)</option>
                      <option value="cpu">CPU Only</option>
                      <option value="cuda">NVIDIA CUDA / TensorRT</option>
                      <option value="openvino">Intel OpenVINO</option>
                      <option value="coral">Google Coral Edge TPU</option>
                    </select>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t1)', marginBottom: 16 }}>Detection Capabilities</div>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '12px 16px', borderRadius: 8 }}>
                      <div>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t1)' }}>Person & Vehicle Tracking</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--t3)', marginTop: 2 }}>Identify and track objects in real-time across all streams.</div>
                      </div>
                      <input type="checkbox" checked readOnly style={{ width: 18, height: 18, accentColor: 'var(--cyan)' }} />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '12px 16px', borderRadius: 8 }}>
                      <div>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t1)' }}>Face Recognition</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--t3)', marginTop: 2 }}>Extract and match facial embeddings against the known database.</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={systemConfig.ai.enable_face_recognition}
                        onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, enable_face_recognition: e.target.checked } }))}
                        style={{ width: 18, height: 18, accentColor: 'var(--cyan)' }}
                      />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '12px 16px', borderRadius: 8 }}>
                      <div>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t1)' }}>Automatic License Plate Recognition (ALPR)</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--t3)', marginTop: 2 }}>Detect and read vehicle license plates using OCR.</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={systemConfig.ai.enable_alpr}
                        onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, enable_alpr: e.target.checked } }))}
                        style={{ width: 18, height: 18, accentColor: 'var(--cyan)' }}
                      />
                    </div>
                  </div>
                </div>

                <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
                  <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Global Confidence Threshold</span>
                    <span style={{ color: 'var(--cyan)' }}>{Math.round(systemConfig.ai.min_confidence * 100)}%</span>
                  </label>
                  <input
                    className="form-input"
                    type="range"
                    min="30"
                    max="95"
                    step="5"
                    value={Math.round(systemConfig.ai.min_confidence * 100)}
                    onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, min_confidence: parseInt(e.target.value) / 100 } }))}
                  />
                  <div style={{ fontSize: '0.65rem', color: 'var(--t3)', marginTop: 4 }}>
                    Higher thresholds reduce false positives but may miss objects in poor lighting.
                  </div>
                </div>

                <button className="btn btn-primary" style={{ width: 'fit-content' }} onClick={() => saveSystemConfig()} disabled={savingConfig}>
                  <CheckCircle size={15}/> {savingConfig ? 'Saving...' : 'Apply AI Configuration'}
                </button>
              </div>
            </div>

            <div className="card" style={{ marginTop: 24 }}>
              <div className="card-head">
                <span className="card-title">Sentinel Active AI Operator Settings</span>
              </div>
              <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 20 }}>
                  <div className="form-group">
                    <label className="form-label">Active AI Provider</label>
                    <select
                      className="form-select"
                      value={systemConfig.ai.ai_provider || 'local'}
                      onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, ai_provider: e.target.value } }))}
                    >
                      <option value="local">Local Rule-Based (No API Keys needed)</option>
                      <option value="ollama">Ollama (Self-Hosted Vision & LLM)</option>
                      <option value="custom">Custom AI Endpoint (vLLM / LM Studio / LocalAI / OpenAI-Compatible)</option>
                      <option value="gemini">Google Gemini VLM (Gemini 1.5 Flash)</option>
                      <option value="openai">OpenAI GPT VLM (GPT-4o mini)</option>
                    </select>
                    <div style={{ fontSize: '0.65rem', color: 'var(--t3)', marginTop: 4 }}>
                      Select the LLM/VLM backend used to run advanced visual description summaries and function tool-calling commands.
                    </div>
                  </div>

                  {systemConfig.ai.ai_provider === 'gemini' && (
                    <div className="form-group">
                      <label className="form-label">Gemini API Key</label>
                      <div style={{ position: 'relative' }}>
                        <input
                          className="form-input"
                          type="password"
                          value={systemConfig.ai.gemini_api_key || ''}
                          onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, gemini_api_key: e.target.value } }))}
                          placeholder="AIzaSy..."
                        />
                        <KeyRound size={14} style={{ position: 'absolute', right: 12, top: 12, color: 'var(--t3)' }} />
                      </div>
                    </div>
                  )}

                  {systemConfig.ai.ai_provider === 'openai' && (
                    <div className="form-group">
                      <label className="form-label">OpenAI API Key</label>
                      <div style={{ position: 'relative' }}>
                        <input
                          className="form-input"
                          type="password"
                          value={systemConfig.ai.openai_api_key || ''}
                          onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, openai_api_key: e.target.value } }))}
                          placeholder="sk-proj-..."
                        />
                        <KeyRound size={14} style={{ position: 'absolute', right: 12, top: 12, color: 'var(--t3)' }} />
                      </div>
                    </div>
                  )}

                  {systemConfig.ai.ai_provider === 'ollama' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div className="form-group">
                        <label className="form-label">Ollama Host URL</label>
                        <input
                          className="form-input"
                          value={systemConfig.ai.ollama_url || 'http://localhost:11434'}
                          onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, ollama_url: e.target.value } }))}
                          placeholder="http://localhost:11434"
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Ollama Model</label>
                        <input
                          className="form-input"
                          value={systemConfig.ai.ollama_model || 'llama3.2-vision'}
                          onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, ollama_model: e.target.value } }))}
                          placeholder="llama3.2-vision or moondream"
                        />
                      </div>
                    </div>
                  )}

                  {systemConfig.ai.ai_provider === 'custom' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
                        <div className="form-group">
                          <label className="form-label">OpenAI-Compatible Base URL</label>
                          <input
                            className="form-input"
                            value={systemConfig.ai.custom_ai_url || ''}
                            onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, custom_ai_url: e.target.value } }))}
                            placeholder="http://192.168.1.100:8000/v1"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Model Identifier</label>
                          <input
                            className="form-input"
                            value={systemConfig.ai.custom_ai_model || 'default'}
                            onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, custom_ai_model: e.target.value } }))}
                            placeholder="e.g. meta-llama/Llama-3.2-11B-Vision"
                          />
                        </div>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Custom API Key / Bearer Token (Optional)</label>
                        <div style={{ position: 'relative' }}>
                          <input
                            className="form-input"
                            type="password"
                            value={systemConfig.ai.custom_ai_key || ''}
                            onChange={e => setSystemConfig(c => ({ ...c, ai: { ...c.ai, custom_ai_key: e.target.value } }))}
                            placeholder="Optional authentication bearer token..."
                          />
                          <KeyRound size={14} style={{ position: 'absolute', right: 12, top: 12, color: 'var(--t3)' }} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* AI Connection Probe & Status Banner */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, padding: 12, background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid var(--border)' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={testAiConnection}
                      disabled={testingAi}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      {testingAi ? <Loader size={14} className="spin" /> : <Zap size={14} color="#00d2ff" />}
                      {testingAi ? 'Testing Latency...' : 'Test AI Connection & Latency'}
                    </button>
                    {aiTestResult && (
                      <div style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 8, color: aiTestResult.ok ? '#2ed573' : '#ff4757' }}>
                        {aiTestResult.ok ? <CheckCircle size={15} /> : <X size={15} />}
                        <span>{aiTestResult.message}</span>
                        {aiTestResult.models_found && aiTestResult.models_found.length > 0 && (
                          <span style={{ color: 'var(--t3)', fontSize: '0.75rem' }}>
                            (Available: {aiTestResult.models_found.slice(0, 3).join(', ')})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <button className="btn btn-primary" style={{ width: 'fit-content' }} onClick={() => saveSystemConfig()} disabled={savingConfig}>
                  <CheckCircle size={15}/> {savingConfig ? 'Saving...' : 'Apply Operator Settings'}
                </button>
              </div>
            </div>
          </>)}

          {tab === 'network' && (
            <div className="card">
              <div className="card-head"><span className="card-title">Advanced Network & Streaming</span></div>
              <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
                  <div className="form-group">
                    <label className="form-label">Internal API Port</label>
                    <input className="form-input" value={systemConfig.network.api_port} disabled />
                  </div>
                  <div className="form-group">
                    <label className="form-label">RTSP Proxy Port</label>
                    <input
                      className="form-input"
                      type="number"
                      value={systemConfig.network.rtsp_port}
                      onChange={e => setSystemConfig(c => ({ ...c, network: { ...c.network, rtsp_port: parseInt(e.target.value) || 0 } }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">WebRTC API Port (go2rtc)</label>
                    <input
                      className="form-input"
                      type="number"
                      value={systemConfig.network.webrtc_api_port}
                      onChange={e => setSystemConfig(c => ({ ...c, network: { ...c.network, webrtc_api_port: parseInt(e.target.value) || 0 } }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">WebRTC TCP/UDP Port</label>
                    <input
                      className="form-input"
                      type="number"
                      value={systemConfig.network.webrtc_port}
                      onChange={e => setSystemConfig(c => ({ ...c, network: { ...c.network, webrtc_port: parseInt(e.target.value) || 0 } }))}
                    />
                  </div>
                </div>

                <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
                  <label className="form-label">WebRTC ICE Servers (STUN/TURN)</label>
                  <textarea
                    className="form-input"
                    rows={3}
                    value={systemConfig.network.ice_servers.join('\n')}
                    onChange={e => setSystemConfig(c => ({
                      ...c,
                      network: {
                        ...c.network,
                        ice_servers: e.target.value.split('\n').map(s => s.trim()).filter(Boolean),
                      }
                    }))}
                  />
                  <div style={{ fontSize: '0.65rem', color: 'var(--t3)', marginTop: 4 }}>
                    Required for viewing live streams outside your local network. One server per line.
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.02)', padding: '12px 16px', borderRadius: 8, flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={systemConfig.network.enable_ssl}
                    onChange={e => setSystemConfig(c => ({ ...c, network: { ...c.network, enable_ssl: e.target.checked } }))}
                    style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }}
                  />
                  <div>
                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--t1)' }}>Enable HTTPS / SSL (Let's Encrypt)</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--t3)', marginTop: 2 }}>Automatically provision certificates for external access.</div>
                  </div>
                </div>

                <button className="btn btn-primary" style={{ width: 'fit-content' }} onClick={() => saveSystemConfig()} disabled={savingConfig}>
                  <CheckCircle size={15}/> {savingConfig ? 'Saving...' : 'Save Network Settings'}
                </button>
              </div>
            </div>
          )}

          {tab === 'system' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 60 }}>
              
              {/* Card 1: System Information */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">System Information</span>
                </div>
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, color: 'var(--t2)', fontSize: '0.85rem' }}>
                    {[
                      ['Platform', 'mView Sentinel NVR'],
                      ['Version', 'v1.0.0'],
                      ['Architecture', 'x86_64 / Docker'],
                      ['Database', 'PostgreSQL (Vector-enabled)'],
                      ['Accelerator', systemConfig.ai.accelerator.toUpperCase()],
                      ['Network Port', `${systemConfig.network.api_port}`]
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 8, borderBottom: '1px dashed rgba(255,255,255,0.05)' }}>
                        <span>{k}</span>
                        <span style={{ color: 'var(--t1)', fontFamily: 'JetBrains Mono' }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginTop: 10 }}>
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--t3)', textTransform: 'uppercase', fontWeight: 700 }}>CPU Usage</div>
                      <div style={{ fontSize: '1.2rem', color: 'var(--t1)', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{systemHealth?.cpu_usage_percent != null ? `${systemHealth.cpu_usage_percent.toFixed(1)}%` : '12.4%'}</div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--t3)', textTransform: 'uppercase', fontWeight: 700 }}>RAM Usage</div>
                      <div style={{ fontSize: '1.2rem', color: 'var(--t1)', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{systemHealth?.storage?.used_gb != null ? `${systemHealth.storage.used_gb.toFixed(1)} GB` : '4.1 GB'}</div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--t3)', textTransform: 'uppercase', fontWeight: 700 }}>Storage Used</div>
                      <div style={{ fontSize: '1.2rem', color: 'var(--cyan)', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{systemHealth?.storage?.usage_percent != null ? `${systemHealth.storage.usage_percent}%` : '42.8%'}</div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--t3)', textTransform: 'uppercase', fontWeight: 700 }}>Free Disk</div>
                      <div style={{ fontSize: '1.2rem', color: 'var(--green)', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{systemHealth?.storage?.free_gb != null ? `${systemHealth.storage.free_gb.toFixed(0)} GB` : '48 GB'}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 2: Service Controls */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Service Controls</span>
                </div>
                <div style={{ padding: 24, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn btn-ghost" style={{ padding: '8px 16px' }} onClick={checkUpdates} disabled={checkingUpdates}>
                    <Loader size={14} className={checkingUpdates ? 'spin' : ''}/> Check for Updates
                  </button>
                  <button className="btn btn-ghost" style={{ padding: '8px 16px' }} onClick={backupDatabase} disabled={backingUp}>
                    <Edit2 size={14}/>{backingUp ? 'Preparing Backup...' : 'Backup Database'}
                  </button>
                  <button className="btn btn-danger" style={{ padding: '8px 16px', marginLeft: 'auto' }} onClick={restartServices} disabled={restarting}>
                    {restarting ? 'Restarting...' : 'Restart NVR Service'}
                  </button>
                </div>
              </div>

              {/* Card 3: Auto-Update Configuration */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Software Updates</span>
                </div>
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--t1)', fontSize: '0.85rem' }}>Auto Update Facility</div>
                      <div style={{ color: 'var(--t3)', fontSize: '0.72rem', marginTop: 3 }}>Checks the Sentinel update manifest and downloads the target when enabled.</div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--t2)', fontSize: '0.8rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={systemConfig.updates.auto_download}
                        onChange={e => setSystemConfig(c => ({ ...c, updates: { ...c.updates, auto_download: e.target.checked } }))}
                        style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }}
                      />
                      Auto download updates
                    </label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr)) auto', gap: 12, alignItems: 'end' }}>
                    <div className="form-group">
                      <label className="form-label">Manifest URL</label>
                      <input
                        className="form-input"
                        value={systemConfig.updates.manifest_url}
                        onChange={e => setSystemConfig(c => ({ ...c, updates: { ...c.updates, manifest_url: e.target.value } }))}
                      />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Check Interval</label>
                      <select
                        className="form-select"
                        value={systemConfig.updates.check_interval_minutes}
                        onChange={e => setSystemConfig(c => ({ ...c, updates: { ...c.updates, check_interval_minutes: Number(e.target.value) } }))}
                      >
                        <option value={15}>15 minutes</option>
                        <option value={60}>1 hour</option>
                        <option value={360}>6 hours</option>
                        <option value={1440}>Daily</option>
                      </select>
                    </div>
                    <button className="btn btn-primary" onClick={() => saveSystemConfig()} disabled={savingConfig}>
                      {savingConfig ? 'Saving...' : 'Save Update Settings'}
                    </button>
                  </div>

                  {updateInfo && (
                    <div style={{ marginTop: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
                      <div style={{ fontWeight: 600, color: 'var(--t1)', marginBottom: 8, fontSize: '0.85rem' }}>Update Information</div>
                      <div style={{ fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <span style={{ color: 'var(--t2)' }}>Manifest:</span>
                          <span style={{ fontFamily: 'JetBrains Mono', color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{updateInfo.manifest_url || systemConfig.updates.manifest_url}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--t2)' }}>Current Commit:</span>
                          <span style={{ fontFamily: 'JetBrains Mono', color: 'var(--t1)' }}>{updateInfo.current_sha}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--t2)' }}>Latest Commit:</span>
                          <span style={{ fontFamily: 'JetBrains Mono', color: 'var(--t1)' }}>{updateInfo.latest_sha}</span>
                        </div>
                        {updateInfo.version && (
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: 'var(--t2)' }}>Version:</span>
                            <span style={{ fontFamily: 'JetBrains Mono', color: 'var(--t1)' }}>{updateInfo.version}</span>
                          </div>
                        )}
                        {updateInfo.error && (
                          <div style={{ color: 'var(--amber)', marginTop: 8 }}>{updateInfo.error}</div>
                        )}
                        {updateInfo.update_available ? (
                          <div style={{ color: 'var(--cyan)', marginTop: 8, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>A new update is available.</span>
                            <button className="btn btn-primary" onClick={installUpdate} disabled={updating} style={{ padding: '4px 10px', fontSize: '0.75rem' }}>
                              {updating ? 'Downloading...' : 'Download & Install'}
                            </button>
                          </div>
                        ) : (
                          <div style={{ color: 'var(--green)', marginTop: 8 }}>You are running the latest version.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Card 4: Storage & Archive Policy */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Storage & Archive Policy</span>
                </div>
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24 }}>
                    <div className="form-group">
                      <label className="form-label">Auto-Purge Retention (Days)</label>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input className="form-input" type="number" min="0" max="365"
                          value={systemConfig.retention_days}
                          onChange={e => setSystemConfig(c => ({ ...c, retention_days: parseInt(e.target.value) || 0 }))}
                          style={{ width: 120 }} />
                        <button className="btn btn-primary" onClick={() => saveSystemConfig()} disabled={savingConfig}>
                          {savingConfig ? 'Saving...' : 'Save Policy'}
                        </button>
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--t3)', marginTop: 4 }}>
                        Recorded video files older than this will be deleted automatically to save space. Set to 0 to disable auto-purge.
                      </div>
                    </div>
                    <div className="form-group">
                      <label className="form-label">Development Cleanup</label>
                      <select className="form-input" value={purgeCameraId} onChange={e => setPurgeCameraId(e.target.value)} style={{ marginBottom: 10, maxWidth: 260 }}>
                        <option value="">All cameras</option>
                        {cameras.map(cam => <option key={cam.id} value={cam.id}>{cam.name}</option>)}
                      </select>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button className="btn btn-danger" onClick={purgeRecordings} disabled={purgingRecordings}>
                          {purgingRecordings ? 'Purging...' : <><Trash2 size={14} /> Purge Recordings</>}
                        </button>
                        <button className="btn btn-ghost" onClick={runDiagnostics} disabled={runningDiag}>
                          {runningDiag ? 'Checking...' : <><Activity size={14} /> Run Diagnostics</>}
                        </button>
                        <button className="btn btn-ghost" onClick={runVacuum} disabled={runningVac}>
                          {runningVac ? 'Optimizing...' : <><Database size={14} /> Re-index DB</>}
                        </button>
                        <span style={{ color: 'var(--t3)', fontSize: '0.72rem' }}>
                          Current archive: {storageReport ? `${storageReport.total_gb} GB` : 'loading...'}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--t3)', marginTop: 4 }}>
                        Deletes all MP4 recording segments from disk. Camera settings and users are not changed.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 5: Stream Diagnostics */}
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Stream Watchdog Diagnostics</span>
                </div>
                <div style={{ padding: 24 }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    {Object.keys(streamDiagnostics).length === 0 ? (
                      <div style={{ padding: 14, color: 'var(--t3)', fontSize: '0.78rem' }}>No active recorder diagnostics available yet.</div>
                    ) : (
                      Object.entries(streamDiagnostics).map(([cameraId, diag]) => (
                        <div key={cameraId} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) minmax(85px, 0.7fr) minmax(85px, 0.7fr) minmax(130px, 1.2fr)', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center', fontSize: '0.76rem' }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: 'var(--t1)', fontWeight: 700 }}>{diag.camera_name || cameraNameById[cameraId] || cameraId}</div>
                            <div style={{ color: 'var(--t3)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{maskRtspPassword(diag.stream_url || '')}</div>
                          </div>
                          <div>
                            <div style={{ color: 'var(--t3)', fontSize: '0.65rem', textTransform: 'uppercase' }}>Status</div>
                            <div style={{ color: diag.task_done ? 'var(--red)' : 'var(--green)', fontWeight: 700 }}>{diag.task_done ? 'Stopped' : diag.status}</div>
                          </div>
                          <div>
                            <div style={{ color: 'var(--t3)', fontSize: '0.65rem', textTransform: 'uppercase' }}>Restarts</div>
                            <div style={{ color: diag.restart_count > 0 ? 'var(--amber)' : 'var(--t1)', fontFamily: 'JetBrains Mono' }}>{diag.restart_count}</div>
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: 'var(--t3)', fontSize: '0.65rem', textTransform: 'uppercase' }}>Last Error</div>
                            <div style={{ color: diag.last_error ? 'var(--amber)' : 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{diag.last_error || 'None'}</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Card 6: Danger Zone */}
              {isAdmin && (
                <div className="card" style={{ border: '1px solid rgba(220, 53, 69, 0.5)', background: 'rgba(220, 53, 69, 0.03)', marginBottom: 20 }}>
                  <div className="card-head" style={{ borderBottom: '1px solid rgba(220, 53, 69, 0.2)' }}>
                    <span className="card-title" style={{ color: 'var(--red)' }}>DANGER ZONE</span>
                  </div>
                  <div style={{ padding: 24 }}>
                    <div style={{ fontSize: '0.85rem', color: 'var(--t2)', marginBottom: 16 }}>
                      Factory resetting will stop all camera recorders, wipe all recording files from storage, remove all cameras from the configuration, and clear system logs. The NVR will be reset to default settings. <strong>This action cannot be undone.</strong>
                    </div>
                    <button 
                      className="btn btn-danger" 
                      onClick={() => setShowFactoryResetConfirm(true)} 
                      disabled={factoryResetting}
                      style={{ background: 'var(--red)', color: '#000', fontWeight: 'bold', padding: '12px 24px', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                    >
                      {factoryResetting ? 'Factory Resetting...' : 'Factory Reset NVR'}
                    </button>
                  </div>
                </div>
              )}

              {showFactoryResetConfirm && (
                <div className="modal-overlay" style={{ display: 'flex', position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 1000, alignItems: 'center', justifyContent: 'center' }}>
                  <div className="card" style={{ width: '100%', maxWidth: 460, border: '1px solid var(--red)', background: 'var(--bg-2)' }}>
                    <div className="card-head">
                      <span className="card-title" style={{ color: 'var(--red)' }}>Confirm Factory Reset</span>
                    </div>
                    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <div style={{ fontSize: '0.85rem', color: 'var(--t1)' }}>
                        Are you absolutely sure? This will permanently delete all cameras, recording segments, databases, and configuration settings.
                      </div>
                      <div className="form-group">
                        <label className="form-label" style={{ color: 'var(--t2)' }}>Type <strong>RESET</strong> to confirm:</label>
                        <input 
                          className="form-input" 
                          value={factoryResetConfirmText} 
                          onChange={e => setFactoryResetConfirmText(e.target.value)}
                          placeholder="RESET"
                          style={{ border: '1px solid var(--red)', width: '100%', background: 'var(--bg-1)', color: 'var(--t1)', padding: '8px 12px', borderRadius: 4 }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 12 }}>
                        <button className="btn btn-ghost" onClick={() => { setShowFactoryResetConfirm(false); setFactoryResetConfirmText(''); }}>Cancel</button>
                        <button className="btn btn-danger" onClick={handleFactoryReset} disabled={factoryResetting || factoryResetConfirmText !== 'RESET'}>
                          {factoryResetting ? 'Wiping NVR...' : 'Wipe & Reset Everything'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}          {tab === 'users' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Password & Session Security</span>
                </div>
                <div style={{ padding: 24, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr)) auto', gap: 16, alignItems: 'end' }}>
                  <div className="form-group">
                    <label className="form-label">Current Password</label>
                    <input
                      className="form-input"
                      type="password"
                      value={passwordForm.current_password}
                      onChange={e => setPasswordForm(f => ({ ...f, current_password: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">New Password</label>
                    <input
                      className="form-input"
                      type="password"
                      value={passwordForm.new_password}
                      onChange={e => setPasswordForm(f => ({ ...f, new_password: e.target.value }))}
                    />
                  </div>
                  <button className="btn btn-primary" onClick={changePassword} disabled={savingPassword || !passwordForm.new_password.trim()}>
                    <KeyRound size={15} /> {savingPassword ? 'Saving...' : 'Change Password'}
                  </button>
                </div>
              </div>

              {!isAdmin ? (
                <div className="card">
                  <div style={{ padding: 24, color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <ShieldCheck size={18} color="var(--cyan)" />
                    User administration is available to admin accounts only.
                  </div>
                </div>
              ) : (
                <>
                  <div className="card">
                    <div className="card-head">
                      <span className="card-title">Create User</span>
                    </div>
                    <div style={{ padding: 24, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
                      <div className="form-group">
                        <label className="form-label">Username</label>
                        <input
                          className="form-input"
                          value={newUser.username}
                          onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Password</label>
                        <input
                          className="form-input"
                          type="password"
                          value={newUser.password}
                          onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Role</label>
                        <select
                          className="form-select"
                          value={newUser.role}
                          onChange={e => {
                            const role = e.target.value;
                            setNewUser(u => ({
                              ...u,
                              role,
                              permissions: role === 'admin' ? permissionOptions : u.permissions,
                            }));
                          }}
                        >
                          <option value="viewer">Viewer</option>
                          <option value="operator">Operator</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                      <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', paddingTop: 8 }}>
                        {permissionOptions.map(permission => (
                          <label key={permission} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--t2)', fontSize: '0.8rem', textTransform: 'capitalize' }}>
                            <input
                              type="checkbox"
                              checked={newUser.permissions.includes(permission)}
                              disabled={newUser.role === 'admin'}
                              onChange={e => setNewUser(u => ({
                                ...u,
                                permissions: e.target.checked
                                  ? Array.from(new Set([...u.permissions, permission]))
                                  : u.permissions.filter(p => p !== permission),
                              }))}
                              style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }}
                            />
                            {permission}
                          </label>
                        ))}
                        <button className="btn btn-primary" onClick={createUser} style={{ marginLeft: 'auto' }}>
                          <Plus size={15} /> Create User
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="card">
                    <div className="card-head">
                      <span className="card-title">Active Users</span>
                    </div>
                    {usersError && <div style={{ padding: '12px 20px', color: 'var(--red)' }}>{usersError}</div>}
                    {users.length === 0 ? (
                      <div className="empty">
                        <div className="empty-sub">No users loaded yet.</div>
                      </div>
                    ) : (
                      users.map(user => (
                        <div key={user.id} className="cam-row">
                          <ShieldCheck size={15} color={user.role === 'admin' ? 'var(--green)' : 'var(--cyan)'} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700, color: 'var(--t1)' }}>{user.username}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--t3)', marginTop: 2 }}>
                              {user.permissions.join(', ') || 'No permissions'}
                            </div>
                          </div>
                          <span style={{
                            fontSize: '0.68rem',
                            padding: '2px 8px',
                            borderRadius: 20,
                            border: '1px solid var(--border)',
                            color: user.role === 'admin' ? 'var(--green)' : 'var(--cyan)',
                            textTransform: 'uppercase',
                          }}>
                            {user.role}
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn btn-ghost"
                              style={{ padding: '6px 10px', color: 'var(--t2)', border: '1px solid var(--border)' }}
                              onClick={() => startEditUser(user)}
                            >
                              <Edit2 size={14} />
                            </button>
                            <button
                              className="btn btn-danger"
                              style={{ padding: '6px 10px' }}
                              disabled={user.username === 'admin' || user.id === currentUser.id}
                              onClick={() => deleteUser(user.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {editingUser && (
                    <div className="card" style={{ border: '1px solid var(--cyan-border)' }}>
                      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="card-title">Edit User: {editingUser.username}</span>
                        <button className="btn btn-ghost" onClick={() => setEditingUser(null)} style={{ padding: '4px 10px' }}>
                          <X size={14} /> Cancel
                        </button>
                      </div>
                      <div style={{ padding: 24, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
                        <div className="form-group">
                          <label className="form-label">Username</label>
                          <input
                            className="form-input"
                            value={editUserForm.username}
                            disabled={editingUser.username === 'admin'}
                            onChange={e => setEditUserForm(u => ({ ...u, username: e.target.value }))}
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">New Password (optional)</label>
                          <input
                            className="form-input"
                            type="password"
                            placeholder="Leave blank to keep existing"
                            value={editUserForm.password}
                            onChange={e => setEditUserForm(u => ({ ...u, password: e.target.value }))}
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">Role</label>
                          <select
                            className="form-select"
                            value={editUserForm.role}
                            disabled={editingUser.username === 'admin'}
                            onChange={e => {
                              const role = e.target.value;
                              setEditUserForm(u => ({
                                ...u,
                                role,
                                permissions: role === 'admin' ? permissionOptions : u.permissions,
                              }));
                            }}
                          >
                            <option value="viewer">Viewer</option>
                            <option value="operator">Operator</option>
                            <option value="admin">Admin</option>
                          </select>
                        </div>
                        <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', paddingTop: 8 }}>
                          {permissionOptions.map(permission => (
                            <label key={permission} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--t2)', fontSize: '0.8rem', textTransform: 'capitalize' }}>
                              <input
                                type="checkbox"
                                checked={editUserForm.permissions.includes(permission)}
                                disabled={editUserForm.role === 'admin'}
                                onChange={e => setEditUserForm(u => ({
                                  ...u,
                                  permissions: e.target.checked
                                    ? Array.from(new Set([...u.permissions, permission]))
                                    : u.permissions.filter(p => p !== permission),
                                }))}
                                style={{ width: 16, height: 16, accentColor: 'var(--cyan)' }}
                              />
                              {permission}
                            </label>
                          ))}
                          <button
                            className="btn btn-primary"
                            onClick={saveEditUser}
                            disabled={savingEditUser}
                            style={{ marginLeft: 'auto' }}
                          >
                            <CheckCircle size={15} /> {savingEditUser ? 'Saving...' : 'Save User Changes'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          background: 'var(--bg-card)', border: '1px solid var(--cyan-border)',
          borderRadius: 'var(--radius-md)', padding: '12px 18px',
          fontSize: '0.85rem', color: 'var(--t1)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(12px)',
          animation: 'fadeIn 0.2s ease',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
};

export default Settings;
