import React, { useState } from 'react';
import { ShieldCheck, Lock, User } from 'lucide-react';
import { apiUrl } from '../lib/endpoints';

interface LoginProps {
  onLogin: () => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setLoading(true);
    setError('');

    try {
      const formData = new URLSearchParams();
      formData.append('username', username.trim());
      formData.append('password', password);

      const res = await fetch(apiUrl('/auth/login'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      });

      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.access_token) {
          try {
            localStorage.setItem('mview_token', data.access_token);
          } catch {
            /* storage may be restricted */
          }
        }
        onLogin();
      } else {
        setError('Invalid username or password');
      }
    } catch {
      setError('Network error connecting to API');
    }

    setLoading(false);
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw',
      alignItems: 'center', justifyContent: 'center', background: 'var(--bg)',
      color: 'var(--t1)'
    }}>
      <div className="card" style={{ width: 380, padding: 32, display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div className="sidebar-logo-icon" style={{ width: 48, height: 48, borderRadius: 12 }}>
            <ShieldCheck size={24} color="var(--cyan)" strokeWidth={2.5} />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 600 }}>mView Sentinel</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--t3)', fontWeight: 500, marginTop: 4 }}>NVR platform</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <User size={14} /> Username
            </label>
            <input
              type="text"
              className="form-input"
              style={{ padding: '10px 14px', fontSize: '0.95rem' }}
              placeholder="Username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoCapitalize="none"
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Lock size={14} /> Password
            </label>
            <input
              type="password"
              className="form-input"
              style={{ padding: '10px 14px', fontSize: '1rem' }}
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </div>

          {error && <div style={{ color: 'var(--red)', fontSize: '0.8rem', textAlign: 'center' }}>{error}</div>}

          <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={loading}>
            {loading ? <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
