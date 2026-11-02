import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCircle,
  DatabaseBackup,
  EyeOff,
  HeartPulse,
  Network,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  Video,
} from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

type Tab = 'health' | 'nvrs' | 'rules' | 'privacy' | 'review';

const emptyNvr = {
  name: 'Existing NVR',
  vendor: 'hikvision',
  host: '',
  port: 554,
  username: 'admin',
  password: '',
  channel_count: 4,
  use_substreams: true,
  custom_main_template: '/channel/{channel}/main',
  custom_sub_template: '/channel/{channel}/sub',
};

const emptyRule = {
  name: 'Person after hours',
  severity: 'high',
  enabled: true,
  camera_ids: [] as string[],
  objects: ['person'],
  zone: 'any',
  schedule: '22:00-06:00',
  condition: 'present',
  threshold_seconds: 0,
  cooldown_seconds: 120,
  actions: ['record', 'notify'],
};

const emptyPrivacy = {
  name: 'Home privacy mode',
  enabled: false,
  camera_ids: [] as string[],
  schedule: '18:00-07:00',
  mode: 'disable_ai',
  reason: 'Private household hours',
};

const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 };
const grid4: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 };

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="form-group">
    <label className="form-label">{label}</label>
    {children}
  </div>
);

const Operations: React.FC = () => {
  const [tab, setTab] = useState<Tab>('health');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(false);
  const [cameras, setCameras] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [nvrs, setNvrs] = useState<any[]>([]);
  const [preview, setPreview] = useState<any[]>([]);
  const [nvrForm, setNvrForm] = useState<any>(emptyNvr);
  const [rules, setRules] = useState<any[]>([]);
  const [ruleForm, setRuleForm] = useState<any>(emptyRule);
  const [privacyModes, setPrivacyModes] = useState<any[]>([]);
  const [privacyForm, setPrivacyForm] = useState<any>(emptyPrivacy);
  const [events, setEvents] = useState<any[]>([]);
  const [reviews, setReviews] = useState<Record<string, any>>({});

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  };

  const requestJson = async (path: string, options?: RequestInit) => {
    const res = await fetch(apiUrl(path), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Request failed');
    return data;
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const [cameraData, healthData, nvrData, ruleData, privacyData, eventData, reviewData] = await Promise.all([
        fetch(apiUrl('/cameras')).then(r => r.ok ? r.json() : []),
        fetch(apiUrl('/ops-api/health-center')).then(r => r.ok ? r.json() : null),
        fetch(apiUrl('/ops-api/nvrs')).then(r => r.ok ? r.json() : []),
        fetch(apiUrl('/ops-api/alert-rules')).then(r => r.ok ? r.json() : []),
        fetch(apiUrl('/ops-api/privacy-modes')).then(r => r.ok ? r.json() : []),
        fetch(apiUrl('/events?limit=25')).then(r => r.ok ? r.json() : []),
        fetch(apiUrl('/ops-api/event-reviews')).then(r => r.ok ? r.json() : []),
      ]);
      setCameras(cameraData);
      setHealth(healthData);
      setNvrs(nvrData);
      setRules(ruleData);
      setPrivacyModes(privacyData);
      setEvents(eventData);
      setReviews(Object.fromEntries(reviewData.map((r: any) => [r.event_id, r])));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Failed to load operations data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const previewNvr = async () => {
    try {
      const data = await requestJson('/ops-api/nvrs/preview', { method: 'POST', body: JSON.stringify(nvrForm) });
      setPreview(data.channels || []);
      notify('NVR channels prepared.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Preview failed.');
    }
  };

  const importNvr = async () => {
    try {
      const data = await requestJson('/ops-api/nvrs', { method: 'POST', body: JSON.stringify(nvrForm) });
      setPreview([]);
      setNvrForm(emptyNvr);
      await loadAll();
      notify(`Imported ${data.created_cameras} channel camera${data.created_cameras === 1 ? '' : 's'}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'NVR import failed.');
    }
  };

  const addRule = async () => {
    try {
      await requestJson('/ops-api/alert-rules', { method: 'POST', body: JSON.stringify(ruleForm) });
      setRuleForm(emptyRule);
      await loadAll();
      notify('Alert rule saved.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Rule save failed.');
    }
  };

  const addPrivacyMode = async () => {
    try {
      await requestJson('/ops-api/privacy-modes', { method: 'POST', body: JSON.stringify(privacyForm) });
      setPrivacyForm(emptyPrivacy);
      await loadAll();
      notify('Privacy mode saved.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Privacy mode save failed.');
    }
  };

  const deleteItem = async (path: string, done: string) => {
    try {
      await requestJson(path, { method: 'DELETE' });
      await loadAll();
      notify(done);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Delete failed.');
    }
  };

  const reviewEvent = async (eventId: string, verdict: string) => {
    try {
      await requestJson(`/ops-api/event-reviews/${eventId}`, {
        method: 'PUT',
        body: JSON.stringify({ verdict, note: '', tags: verdict === 'training' ? ['training-candidate'] : [] }),
      });
      await loadAll();
      notify('Event review saved.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Review failed.');
    }
  };

  const cameraNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of cameras) {
      map[c.id] = c.name;
    }
    return map;
  }, [cameras]);

  const cameraOptions = useMemo(() => cameras.map(camera => (
    <option key={camera.id} value={camera.id}>{camera.name}</option>
  )), [cameras]);

  return (
    <div className="settings-shell">
      <div className="settings-topbar">
        <div>
          <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--t1)' }}>Operations Center</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--t3)', marginTop: 2 }}>NVR import, reliability, privacy, rules, and event review</div>
        </div>
        <button className="btn btn-ghost" onClick={loadAll} disabled={loading}>
          <RefreshCw size={15} /> {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-nav">
          {[
            ['health', HeartPulse, 'Health'],
            ['nvrs', Network, 'NVRs'],
            ['rules', BellRing, 'Rules'],
            ['privacy', EyeOff, 'Privacy'],
            ['review', Shield, 'Review'],
          ].map(([id, Icon, label]) => {
            const Cmp = Icon as typeof HeartPulse;
            return (
              <button key={id as string} className={`nav-item ${tab === id ? 'active' : ''}`} onClick={() => setTab(id as Tab)}>
                <Cmp size={15} /> {label as string}
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          {tab === 'health' && (
            <>
              <div style={grid4}>
                {[
                  ['Cameras', health?.summary?.cameras ?? cameras.length],
                  ['Recording', health?.summary?.recording ?? 0],
                  ['NVRs', health?.summary?.nvrs ?? nvrs.length],
                  ['Archive', `${health?.summary?.recording_gb ?? 0} GB`],
                ].map(([label, value]) => (
                  <div className="card" key={label as string} style={{ padding: 18 }}>
                    <div className="card-title">{label as string}</div>
                    <div style={{ fontSize: '1.6rem', fontWeight: 600, color: 'var(--t1)', marginTop: 10 }}>{value as any}</div>
                  </div>
                ))}
              </div>
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Reliability Issues</span>
                  <span className={`badge ${(health?.issues?.length || 0) ? 'recording' : 'online'}`}>{health?.issues?.length || 0}</span>
                </div>
                {(health?.issues || []).length === 0 ? (
                  <div className="empty"><CheckCircle size={24} color="var(--green)" /><div className="empty-title">No active reliability issues</div></div>
                ) : health.issues.map((issue: any, index: number) => (
                  <div className="cam-row" key={`${issue.scope}-${issue.id || index}`}>
                    <AlertTriangle size={16} color={issue.severity === 'critical' ? 'var(--red)' : 'var(--amber)'} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>{issue.name || issue.scope}</div>
                      <div style={{ color: 'var(--t2)', fontSize: '0.76rem', marginTop: 2 }}>{issue.message}</div>
                    </div>
                    <span className={`badge ${issue.severity === 'critical' ? 'recording' : 'offline'}`}>{issue.severity}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'nvrs' && (
            <>
              <div className="card">
                <div className="card-head">
                  <span className="card-title">Import Existing NVR</span>
                  <button className="btn btn-primary" onClick={importNvr}><Plus size={15} /> Import</button>
                </div>
                <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={grid4}>
                    <Field label="Name"><input className="form-input" value={nvrForm.name} onChange={e => setNvrForm((f: any) => ({ ...f, name: e.target.value }))} /></Field>
                    <Field label="Vendor">
                      <select className="form-select" value={nvrForm.vendor} onChange={e => setNvrForm((f: any) => ({ ...f, vendor: e.target.value }))}>
                        {['hikvision', 'dahua', 'amcrest', 'reolink', 'axis', 'generic', 'custom'].map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </Field>
                    <Field label="Host"><input className="form-input" value={nvrForm.host} onChange={e => setNvrForm((f: any) => ({ ...f, host: e.target.value }))} placeholder="192.168.1.20" /></Field>
                    <Field label="Channels"><input className="form-input" type="number" min={1} max={128} value={nvrForm.channel_count} onChange={e => setNvrForm((f: any) => ({ ...f, channel_count: Number(e.target.value) }))} /></Field>
                  </div>
                  <div style={grid4}>
                    <Field label="RTSP Port"><input className="form-input" type="number" value={nvrForm.port} onChange={e => setNvrForm((f: any) => ({ ...f, port: Number(e.target.value) }))} /></Field>
                    <Field label="Username"><input className="form-input" value={nvrForm.username} onChange={e => setNvrForm((f: any) => ({ ...f, username: e.target.value }))} /></Field>
                    <Field label="Password"><input className="form-input" type="password" value={nvrForm.password} onChange={e => setNvrForm((f: any) => ({ ...f, password: e.target.value }))} /></Field>
                    <Field label="Substreams">
                      <select className="form-select" value={nvrForm.use_substreams ? 'yes' : 'no'} onChange={e => setNvrForm((f: any) => ({ ...f, use_substreams: e.target.value === 'yes' }))}>
                        <option value="yes">Create main + sub</option>
                        <option value="no">Main stream only</option>
                      </select>
                    </Field>
                  </div>
                  {nvrForm.vendor === 'custom' && (
                    <div style={grid2}>
                      <Field label="Main Path Template"><input className="form-input" value={nvrForm.custom_main_template} onChange={e => setNvrForm((f: any) => ({ ...f, custom_main_template: e.target.value }))} /></Field>
                      <Field label="Sub Path Template"><input className="form-input" value={nvrForm.custom_sub_template} onChange={e => setNvrForm((f: any) => ({ ...f, custom_sub_template: e.target.value }))} /></Field>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-ghost" onClick={previewNvr}><Video size={15} /> Preview Channels</button>
                    <span style={{ color: 'var(--t3)', fontSize: '0.76rem', alignSelf: 'center' }}>{preview.length ? `${preview.length} channels ready` : 'Preview before import to confirm generated RTSP URLs.'}</span>
                  </div>
                </div>
              </div>

              {preview.length > 0 && (
                <div className="card">
                  <div className="card-head"><span className="card-title">Channel Preview</span></div>
                  {preview.map(channel => (
                    <div className="cam-row" key={channel.channel}>
                      <Video size={15} color="var(--cyan)" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700 }}>{channel.name}</div>
                        <div style={{ color: 'var(--t3)', fontSize: '0.68rem', fontFamily: 'JetBrains Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{channel.rtsp_url_main}</div>
                      </div>
                      <span className="badge online">CH {channel.channel}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="card">
                <div className="card-head"><span className="card-title">Imported NVRs</span></div>
                {nvrs.length === 0 ? <div className="empty"><Network size={22} /><div className="empty-title">No existing NVRs imported</div></div> : nvrs.map(nvr => (
                  <div className="cam-row" key={nvr.id}>
                    <Network size={15} color="var(--cyan)" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>{nvr.name}</div>
                      <div style={{ color: 'var(--t3)', fontSize: '0.72rem' }}>{nvr.vendor} at {nvr.host}:{nvr.port} - {nvr.channel_count} channels</div>
                    </div>
                    <span className={`badge ${nvr.enabled ? 'online' : 'offline'}`}>{nvr.status}</span>
                    <button className="btn btn-danger" onClick={() => deleteItem(`/ops-api/nvrs/${nvr.id}`, 'NVR removed.')}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'rules' && (
            <>
              <div className="card">
                <div className="card-head"><span className="card-title">Smart Alert Rule</span><button className="btn btn-primary" onClick={addRule}><Save size={15} /> Save Rule</button></div>
                <div style={{ padding: 18, ...grid4 }}>
                  <Field label="Name"><input className="form-input" value={ruleForm.name} onChange={e => setRuleForm((f: any) => ({ ...f, name: e.target.value }))} /></Field>
                  <Field label="Severity"><select className="form-select" value={ruleForm.severity} onChange={e => setRuleForm((f: any) => ({ ...f, severity: e.target.value }))}>{['low', 'medium', 'high', 'critical'].map(v => <option key={v}>{v}</option>)}</select></Field>
                  <Field label="Object Classes"><input className="form-input" value={ruleForm.objects.join(', ')} onChange={e => setRuleForm((f: any) => ({ ...f, objects: e.target.value.split(',').map(v => v.trim()).filter(Boolean) }))} /></Field>
                  <Field label="Schedule"><input className="form-input" value={ruleForm.schedule} onChange={e => setRuleForm((f: any) => ({ ...f, schedule: e.target.value }))} /></Field>
                  <Field label="Cameras"><select className="form-select" multiple value={ruleForm.camera_ids} onChange={e => setRuleForm((f: any) => ({ ...f, camera_ids: Array.from(e.target.selectedOptions).map(o => o.value) }))}>{cameraOptions}</select></Field>
                  <Field label="Condition"><input className="form-input" value={ruleForm.condition} onChange={e => setRuleForm((f: any) => ({ ...f, condition: e.target.value }))} /></Field>
                  <Field label="Threshold Seconds"><input className="form-input" type="number" value={ruleForm.threshold_seconds} onChange={e => setRuleForm((f: any) => ({ ...f, threshold_seconds: Number(e.target.value) }))} /></Field>
                  <Field label="Cooldown Seconds"><input className="form-input" type="number" value={ruleForm.cooldown_seconds} onChange={e => setRuleForm((f: any) => ({ ...f, cooldown_seconds: Number(e.target.value) }))} /></Field>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><span className="card-title">Active Rules</span></div>
                {rules.length === 0 ? <div className="empty"><BellRing size={22} /><div className="empty-title">No alert rules yet</div></div> : rules.map(rule => (
                  <div className="cam-row" key={rule.id}>
                    <BellRing size={15} color="var(--pink)" />
                    <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{rule.name}</div><div style={{ color: 'var(--t3)', fontSize: '0.72rem' }}>{rule.objects?.join(', ') || 'objects'} during {rule.schedule}</div></div>
                    <span className={`badge ${rule.enabled ? 'online' : 'offline'}`}>{rule.severity}</span>
                    <button className="btn btn-danger" onClick={() => deleteItem(`/ops-api/alert-rules/${rule.id}`, 'Rule deleted.')}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'privacy' && (
            <>
              <div className="card">
                <div className="card-head"><span className="card-title">Privacy Mode</span><button className="btn btn-primary" onClick={addPrivacyMode}><Save size={15} /> Save Mode</button></div>
                <div style={{ padding: 18, ...grid4 }}>
                  <Field label="Name"><input className="form-input" value={privacyForm.name} onChange={e => setPrivacyForm((f: any) => ({ ...f, name: e.target.value }))} /></Field>
                  <Field label="Mode"><select className="form-select" value={privacyForm.mode} onChange={e => setPrivacyForm((f: any) => ({ ...f, mode: e.target.value }))}>{['disable_camera', 'mask_recording', 'disable_ai', 'local_only'].map(v => <option key={v}>{v}</option>)}</select></Field>
                  <Field label="Schedule"><input className="form-input" value={privacyForm.schedule} onChange={e => setPrivacyForm((f: any) => ({ ...f, schedule: e.target.value }))} /></Field>
                  <Field label="Enabled"><select className="form-select" value={privacyForm.enabled ? 'yes' : 'no'} onChange={e => setPrivacyForm((f: any) => ({ ...f, enabled: e.target.value === 'yes' }))}><option value="yes">Enabled</option><option value="no">Disabled</option></select></Field>
                  <Field label="Cameras"><select className="form-select" multiple value={privacyForm.camera_ids} onChange={e => setPrivacyForm((f: any) => ({ ...f, camera_ids: Array.from(e.target.selectedOptions).map(o => o.value) }))}>{cameraOptions}</select></Field>
                  <Field label="Reason"><input className="form-input" value={privacyForm.reason} onChange={e => setPrivacyForm((f: any) => ({ ...f, reason: e.target.value }))} /></Field>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><span className="card-title">Saved Privacy Modes</span></div>
                {privacyModes.length === 0 ? <div className="empty"><EyeOff size={22} /><div className="empty-title">No privacy modes yet</div></div> : privacyModes.map(mode => (
                  <div className="cam-row" key={mode.id}>
                    <EyeOff size={15} color="var(--cyan)" />
                    <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{mode.name}</div><div style={{ color: 'var(--t3)', fontSize: '0.72rem' }}>{mode.mode} - {mode.schedule}</div></div>
                    <span className={`badge ${mode.enabled ? 'online' : 'offline'}`}>{mode.enabled ? 'enabled' : 'off'}</span>
                    <button className="btn btn-danger" onClick={() => deleteItem(`/ops-api/privacy-modes/${mode.id}`, 'Privacy mode deleted.')}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'review' && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Event Review Workflow</span>
                <DatabaseBackup size={16} color="var(--t2)" />
              </div>
              {events.length === 0 ? <div className="empty"><Shield size={22} /><div className="empty-title">No events to review</div></div> : events.map(event => {
                const review = reviews[event.id] || event.review;
                const camName = event.camera_id ? (cameraNameById[event.camera_id] || `Camera ${event.camera_id.slice(0, 8)}`) : 'Unknown Camera';
                const formattedTime = event.timestamp ? new Date(event.timestamp).toLocaleString() : 'No timestamp';
                return (
                  <div className="cam-row" key={event.id}>
                    <div style={{ width: 42, height: 30, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative' }}>
                      <Shield size={14} color={review?.verdict === 'false_positive' ? 'var(--amber)' : 'var(--cyan)'} />
                      {event.id && (
                        <img
                          src={apiUrl(`/events/${event.id}/thumbnail`)}
                          alt=""
                          onError={e => { e.currentTarget.style.display = 'none'; }}
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      )}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, textTransform: 'capitalize' }}>
                        {event.object_class || 'event'}{' '}
                        <span style={{ color: 'var(--cyan)', fontWeight: 600, fontSize: '0.75rem' }}>{event.confidence ? `${Math.round(event.confidence * 100)}%` : ''}</span>
                        <span style={{ color: 'var(--t2)', fontWeight: 500, fontSize: '0.75rem', marginLeft: 8 }}>· {camName}</span>
                      </div>
                      <div style={{ color: 'var(--t3)', fontSize: '0.72rem' }}>{formattedTime} — <span style={{ color: review?.verdict ? 'var(--cyan)' : 'var(--t3)', fontWeight: 600 }}>{(review?.verdict || 'unreviewed').replace('_', ' ')}</span></div>
                    </div>
                    {['useful', 'false_positive', 'evidence', 'training'].map(verdict => (
                      <button
                        key={verdict}
                        className={`btn ${review?.verdict === verdict ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ padding: '6px 9px', textTransform: 'capitalize' }}
                        onClick={() => reviewEvent(event.id, verdict)}
                      >
                        {verdict.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};

export default Operations;

