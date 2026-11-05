import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, SafeAreaView, FlatList, ScrollView } from 'react-native';

export default function App() {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<any>(null);
  const [cameras, setCameras] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);

  const fetchHealth = async (url: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(`${url}/system/health`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  };

  const loginToServer = async (url: string, user: string, pass: string): Promise<string | null> => {
    try {
      const body = `username=${encodeURIComponent(user.trim())}&password=${encodeURIComponent(pass)}`;
      const res = await fetch(`${url}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.access_token || null;
    } catch {
      return null;
    }
  };

  const fetchDashboardData = async (url: string, token: string | null) => {
    try {
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const [camsRes, eventsRes] = await Promise.all([
        fetch(`${url}/cameras`, { headers }),
        fetch(`${url}/events?limit=5`, { headers })
      ]);
      if (camsRes.ok) setCameras(await camsRes.json());
      if (eventsRes.ok) setEvents(await eventsRes.json());
    } catch {}
  };

  const handleConnect = async () => {
    if (!serverUrl) {
      setError('Please enter a server address');
      return;
    }

    // Format URL correctly
    let formattedUrl = serverUrl.trim().replace(/\/+$/, '');
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = `http://${formattedUrl}`;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const nextHealth = await fetchHealth(formattedUrl);
      const token = await loginToServer(formattedUrl, username, password);
      if (!token) {
        setIsConnecting(false);
        setError('Invalid username or password');
        return;
      }
      setAuthToken(token);
      setHealth(nextHealth);
      setBaseUrl(formattedUrl);
      await fetchDashboardData(formattedUrl, token);
      setIsConnecting(false);
      setIsConnected(true);
    } catch (e) {
      setIsConnecting(false);
      setError(e instanceof Error ? e.message : 'Unable to reach Sentinel server');
    }
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    setAuthToken(null);
    setHealth(null);
    setCameras([]);
    setEvents([]);
    setBaseUrl('');
    setServerUrl('');
  };

  useEffect(() => {
    if (!isConnected || !baseUrl) return;
    let failedAttempts = 0;
    const timer = setInterval(async () => {
      try {
        const nextHealth = await fetchHealth(baseUrl);
        setHealth(nextHealth);
        await fetchDashboardData(baseUrl, authToken);
        failedAttempts = 0;
      } catch (e) {
        failedAttempts += 1;
        if (failedAttempts >= 3) {
          setError(e instanceof Error ? e.message : 'Lost connection to Sentinel server after multiple retries');
          setIsConnected(false);
        }
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [isConnected, baseUrl, authToken]);

  // -------------------------------------------------------------
  // SCREEN: Server Setup
  // -------------------------------------------------------------
  if (!isConnected) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
        >
          <View style={styles.glassPanel}>
            <View style={styles.iconPlaceholder}>
              <Text style={styles.iconText}>🛡️</Text>
            </View>
            
            <Text style={styles.title}>SentinelNVR</Text>
            <Text style={styles.subtitle}>Connect to your private NVR server</Text>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>SERVER ADDRESS</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 192.168.1.100:8000"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={serverUrl}
                onChangeText={(text) => {
                  setServerUrl(text);
                  setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>USERNAME</Text>
              <TextInput
                style={styles.input}
                placeholder="admin"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.label}>PASSWORD</Text>
              <TextInput
                style={styles.input}
                placeholder="••••••••"
                placeholderTextColor="rgba(255,255,255,0.3)"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {error && <Text style={styles.errorText}>{error}</Text>}

            <TouchableOpacity 
              style={[styles.button, isConnecting && styles.buttonDisabled]} 
              onPress={handleConnect}
              disabled={isConnecting}
            >
              {isConnecting ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={styles.buttonText}>Connect</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.footerText}>
              Your data never leaves your network unless you configure remote access.
            </Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // -------------------------------------------------------------
  // SCREEN: Dashboard
  // -------------------------------------------------------------
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <ScrollView style={{ flex: 1, padding: 20 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <Text style={[styles.title, { marginBottom: 0 }]}>Sentinel Mobile</Text>
          <View style={styles.statusBadge}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>Live</Text>
          </View>
        </View>

        {/* Health Card */}
        <View style={[styles.card, { marginBottom: 16 }]}>
          <Text style={styles.cardTitle}>Appliance Status</Text>
          <Text style={{ color: '#a1a1aa', marginTop: 6, fontSize: 13 }}>
            Server: {baseUrl}
          </Text>
          <View style={{ flexDirection: 'row', gap: 16, marginTop: 12 }}>
            <Text style={{ color: '#00d4ff', fontWeight: '600' }}>
              CPU {typeof health?.cpu_usage_percent === 'number' ? `${health.cpu_usage_percent.toFixed(1)}%` : '--'}
            </Text>
            <Text style={{ color: '#10b981', fontWeight: '600' }}>
              Disk {typeof health?.storage?.usage_percent === 'number' ? `${health.storage.usage_percent}%` : '--'}
            </Text>
            <Text style={{ color: '#f43f5e', fontWeight: '600' }}>
              {cameras.length} Cameras
            </Text>
          </View>
        </View>

        {/* Cameras List */}
        <View style={[styles.card, { marginBottom: 16 }]}>
          <Text style={styles.cardTitle}>Configured Cameras ({cameras.length})</Text>
          {cameras.length === 0 ? (
            <Text style={{ color: '#71717a', marginTop: 10, fontSize: 13 }}>No cameras registered yet.</Text>
          ) : (
            cameras.map(cam => (
              <View key={cam.id} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' }}>
                <View>
                  <Text style={{ color: '#f4f4f5', fontWeight: '600' }}>{cam.name}</Text>
                  <Text style={{ color: '#71717a', fontSize: 12 }}>{cam.resolution || '1080p'}</Text>
                </View>
                <View style={{ backgroundColor: cam.status === 'offline' ? 'rgba(244,63,94,0.15)' : 'rgba(16,185,129,0.15)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 }}>
                  <Text style={{ color: cam.status === 'offline' ? '#f43f5e' : '#10b981', fontSize: 12, fontWeight: '700' }}>
                    {cam.status.toUpperCase()}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Recent Detections */}
        <View style={[styles.card, { marginBottom: 24 }]}>
          <Text style={styles.cardTitle}>Recent AI Detections</Text>
          {events.length === 0 ? (
            <Text style={{ color: '#71717a', marginTop: 10, fontSize: 13 }}>No events detected.</Text>
          ) : (
            events.map((ev, i) => (
              <View key={ev.id || i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
                <Text style={{ color: '#f4f4f5', fontSize: 13, textTransform: 'capitalize' }}>
                  🚨 {ev.object_class || 'Motion'} ({Math.round((ev.confidence || 0) * 100)}%)
                </Text>
                <Text style={{ color: '#71717a', fontSize: 11 }}>
                  {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--'}
                </Text>
              </View>
            ))
          )}
        </View>

        <TouchableOpacity 
          style={[styles.button, { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#3f3f46', marginBottom: 40 }]} 
          onPress={handleDisconnect}
        >
          <Text style={[styles.buttonText, { color: '#e4e4e7' }]}>Disconnect Server</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0f', // Dark background matching web
  },
  keyboardView: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  glassPanel: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 24,
    padding: 30,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  iconPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.3)',
  },
  iconText: {
    fontSize: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#e2e8f0',
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#64748b',
    marginBottom: 32,
  },
  inputContainer: {
    marginBottom: 24,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 8,
    letterSpacing: 1,
  },
  input: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
    padding: 16,
    color: '#e2e8f0',
    fontSize: 16,
  },
  errorText: {
    color: '#f43f5e',
    fontSize: 14,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#00d4ff', // Electric cyan
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#00d4ff',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 5,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
  footerText: {
    textAlign: 'center',
    color: '#64748b',
    fontSize: 12,
    marginTop: 24,
    lineHeight: 18,
  },
  card: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  cardTitle: {
    color: '#e2e8f0',
    fontSize: 18,
    fontWeight: '600',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10b981',
    marginRight: 6,
  },
  statusText: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '600',
  }
});
