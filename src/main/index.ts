import { app, BrowserView, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import { AgentLocalDB } from './db';
import { ActivityTracker } from './tracker';
import { ScreenshotEngine } from './screenshot';
import { AgentSyncEngine } from './sync';
import { AgentTray } from './tray';
import { CHAT_EMBED_CSS } from './chat-embed-css';

let mainWindow: BrowserWindow | null = null;
let chatBrowserView: BrowserView | null = null;
let chatSessionStarted = false;
let tray: AgentTray | null = null;
let chatMediaPermissionsBound = false;

const db = new AgentLocalDB();
const deviceId = `dev_${process.platform}_${Math.random().toString(36).substr(2, 6)}`;

function agentConfigPath() {
  return path.join(app.getPath('userData'), 'agent-config.json');
}

function agentSessionPath() {
  return path.join(app.getPath('userData'), 'agent-session.json');
}

function isLocalUrl(url: string) {
  return /localhost|127\.0\.0\.1/i.test(url || '');
}

function readBakedRuntimeConfig(): { apiUrl?: string; webUrl?: string } | null {
  const candidates = [
    path.join(__dirname, 'runtime-config.json'),
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'runtime-config.json')
      : '',
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        apiUrl?: string;
        webUrl?: string;
      };
      if (parsed?.apiUrl) return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

function loadSavedApiUrl(): string | null {
  try {
    const raw = fs.readFileSync(agentConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as { apiUrl?: string };
    return parsed.apiUrl?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Dev (unpackaged): always prefer local Next/API so .env AGENT_API_URL pointing at
 * Vercel does not cause mystery 401s against a different JWT secret.
 * Packaged installs use baked / AGENT_API_URL production URL.
 */
function resolveDefaultApiUrl(): string {
  const fromEnv = (process.env.AGENT_API_URL || process.env.API_URL || '').replace(/\/$/, '');
  const packaged = app.isPackaged;

  if (!packaged) {
    const saved = loadSavedApiUrl()?.replace(/\/$/, '');
    if (saved && isLocalUrl(saved)) return saved;
    if (fromEnv && isLocalUrl(fromEnv)) return fromEnv;
    return 'http://localhost:3000';
  }

  if (fromEnv && !isLocalUrl(fromEnv)) return fromEnv;

  const baked = readBakedRuntimeConfig()?.apiUrl?.replace(/\/$/, '');
  if (baked && !isLocalUrl(baked)) return baked;

  const saved = loadSavedApiUrl()?.replace(/\/$/, '');
  if (saved && !isLocalUrl(saved)) return saved;

  console.error(
    '[AgentMain] Packaged build has no production API URL. Rebuild with AGENT_API_URL set.',
  );
  return baked || fromEnv || '';
}

const DEFAULT_API = resolveDefaultApiUrl();

const tracker = new ActivityTracker(db, {
  deviceId,
  trackIdleAfterSec: 180,
  pollIntervalMs: 5000,
});

const screenshotEngine = new ScreenshotEngine(db, {
  deviceId,
  screenshotIntervalSec: 600,
  blurScreenshots: false,
  // Idle is recorded in activity as "System Idle" — do NOT skip captures or stop the work timer.
  pauseOnIdle: false,
  trackIdleAfterSec: 180,
});

const syncEngine = new AgentSyncEngine(db, {
  apiUrl: DEFAULT_API,
  accessToken: null,
  syncIntervalMs: 10000,
});

type AttendanceSummary = {
  date: string;
  hasRecord: boolean;
  isCheckedIn: boolean;
  isOnBreak?: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  openCheckInAt: string | null;
  breakStartedAt?: string | null;
  breakType?: string | null;
  totalWorkedMinutes: number;
  totalBreakMinutes?: number;
  workedSeconds?: number;
  status: string;
};

type LiveViewPrompt = {
  sessionId: string;
  fromUserId?: string;
  fromName?: string;
  reason?: string;
  expiresAt?: string;
  targetUserId?: string;
};

let isTrackingActive = false;
let currentUser: any = null;
let accessToken: string | null = null;
let refreshToken: string | null = null;
let tokenRefreshTimer: NodeJS.Timeout | null = null;
let apiBaseUrl = DEFAULT_API;
let attendance: AttendanceSummary | null = null;
let attendancePollTimer: NodeJS.Timeout | null = null;
let liveSocket: Socket | null = null;
let pendingLiveView: LiveViewPrompt | null = null;
let isQuitting = false;
let companySlug: string | null = null;
let chatEnabled = false;
let chatUrl: string | null = null;
let liveSessionId: string | null = null;
let liveTimer: NodeJS.Timeout | null = null;
let liveBusy = false;

function authHeaders() {
  return { Authorization: `Bearer ${accessToken}` };
}

async function refreshAgentTokens(): Promise<boolean> {
  if (!refreshToken || !apiBaseUrl) return false;
  try {
    const res = await axios.post(
      `${apiBaseUrl}/api/v1/agent/auth/refresh`,
      { refreshToken },
      { timeout: 15000 },
    );
    const data = res.data?.success ? res.data.data : null;
    if (!data?.accessToken) return false;
    accessToken = data.accessToken;
    if (data.refreshToken) refreshToken = data.refreshToken;
    syncEngine.setToken(accessToken);
    persistSession();
    if (liveSocket) connectAttendanceSocket();
    return true;
  } catch (err: any) {
    const code = err?.response?.data?.error?.code;
    console.warn('[AgentMain] token refresh failed', err?.message || err, code || '');
    if (
      code === 'MEMBERSHIP_REVOKED' ||
      code === 'USER_INACTIVE' ||
      err?.response?.status === 403
    ) {
      clearSession(true);
    }
    return false;
  }
}

async function withAuthRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    if (err?.response?.status === 401 && (await refreshAgentTokens())) {
      return await run();
    }
    throw err;
  }
}

function persistSession() {
  try {
    if (!accessToken || !refreshToken || !currentUser) {
      if (fs.existsSync(agentSessionPath())) fs.unlinkSync(agentSessionPath());
      return;
    }
    fs.writeFileSync(
      agentSessionPath(),
      JSON.stringify({
        accessToken,
        refreshToken,
        user: currentUser,
        apiBaseUrl,
        companySlug,
        chatEnabled,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    /* ignore */
  }
}

function clearSession(notifyUi = false) {
  stopAttendancePolling();
  stopTokenRefreshLoop();
  stopLiveCapture(true);
  disconnectAttendanceSocket();
  pendingLiveView = null;
  setTracking(false);
  currentUser = null;
  accessToken = null;
  refreshToken = null;
  attendance = null;
  companySlug = null;
  chatEnabled = false;
  chatUrl = null;
  void loadChatUrl(null);
  syncEngine.setToken(null);
  try {
    if (fs.existsSync(agentSessionPath())) fs.unlinkSync(agentSessionPath());
  } catch {
    /* ignore */
  }
  if (notifyUi) {
    mainWindow?.webContents.send('status-update', getStatusPayload());
    mainWindow?.webContents.send('force-logout', {
      message: 'Session ended. Please sign in again.',
    });
  }
}

function startTokenRefreshLoop() {
  stopTokenRefreshLoop();
  // Proactive refresh well before any access-token expiry (web is 15m; agent is days).
  void refreshAgentTokens();
  tokenRefreshTimer = setInterval(
    () => {
      void refreshAgentTokens();
    },
    5 * 60 * 1000,
  );
}

function stopTokenRefreshLoop() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = null;
}

async function restoreSessionIfPossible(): Promise<boolean> {
  try {
    if (!fs.existsSync(agentSessionPath())) return false;
    const raw = JSON.parse(fs.readFileSync(agentSessionPath(), 'utf8')) as {
      accessToken?: string;
      refreshToken?: string;
      user?: any;
      apiBaseUrl?: string;
      companySlug?: string | null;
      chatEnabled?: boolean;
    };
    if (!raw.refreshToken || !raw.user) return false;
    accessToken = raw.accessToken || null;
    refreshToken = raw.refreshToken;
    currentUser = raw.user;
    companySlug = raw.companySlug ?? raw.user?.companySlug ?? null;
    chatEnabled = raw.chatEnabled !== false && Boolean(companySlug);
    if (raw.apiBaseUrl) {
      // Unpackaged: never restore a remote API URL (stale session from a packaged test).
      if (!app.isPackaged && !isLocalUrl(raw.apiBaseUrl)) {
        apiBaseUrl = resolveDefaultApiUrl() || DEFAULT_API;
      } else {
        apiBaseUrl = raw.apiBaseUrl;
      }
      syncEngine.updateApiUrl(apiBaseUrl);
    }
    syncEngine.setToken(accessToken);
    const ok = await refreshAgentTokens();
    if (!ok) {
      clearSession(false);
      return false;
    }
    startTokenRefreshLoop();
    const summary = await fetchAttendanceToday();
    applyAttendance(summary);
    connectAttendanceSocket();
    startAttendancePolling();
    void fetchPendingLiveView();
    void syncEngine.syncNow();
    mainWindow?.webContents.send('status-update', getStatusPayload());
    console.log('[AgentMain] Restored desktop session for', currentUser?.email || currentUser?.id);
    return true;
  } catch (err) {
    console.warn('[AgentMain] session restore failed', (err as Error).message);
    clearSession(false);
    return false;
  }
}

function saveApiUrl(url: string) {
  try {
    fs.writeFileSync(agentConfigPath(), JSON.stringify({ apiUrl: url }));
  } catch {
    /* ignore */
  }
}

function resolveSocketUrl(apiUrl: string) {
  if (process.env.SOCKET_URL) return process.env.SOCKET_URL;
  // Same-origin on Vercel / production — Socket.IO is served from the web host.
  if (!isLocalUrl(apiUrl)) {
    try {
      return new URL(apiUrl).origin;
    } catch {
      return apiUrl;
    }
  }
  try {
    const u = new URL(apiUrl);
    if (u.port === '3000') u.port = '4000';
    return u.origin;
  } catch {
    return 'http://localhost:4000';
  }
}

function resolveWebUrl(apiUrl: string) {
  // Chat handoff JWT is minted by apiUrl — BrowserView must open the SAME deployment.
  // Unpackaged / local API: never prefer a baked production webUrl (causes MONGO_REMOVED
  // stubs or INVALID_HANDOFF against a different JWT secret).
  if (!app.isPackaged || isLocalUrl(apiUrl)) {
    const fromEnv = (process.env.WEB_URL || '').replace(/\/$/, '');
    if (fromEnv && isLocalUrl(fromEnv)) return fromEnv;
    try {
      const u = new URL(apiUrl || 'http://localhost:3000');
      if (u.port === '4000') u.port = '3000';
      if (!u.port && isLocalUrl(u.origin)) {
        /* keep */
      }
      return u.origin;
    } catch {
      return 'http://localhost:3000';
    }
  }

  const bakedWeb = readBakedRuntimeConfig()?.webUrl?.replace(/\/$/, '');
  if (bakedWeb && !isLocalUrl(bakedWeb)) return bakedWeb;
  const fromEnv = (process.env.WEB_URL || '').replace(/\/$/, '');
  if (fromEnv && !isLocalUrl(fromEnv)) return fromEnv;
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl || '';
  }
}

function isChatAppUrl(url: string) {
  try {
    const u = new URL(url);
    // /{slug}/chat or /chat — not the desktop-login handoff page
    if (u.pathname.includes('desktop-login')) return false;
    return (
      /\/chat\/?$/.test(u.pathname) || u.pathname.includes('/chat?') || /\/chat$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function isChatAuthFailureUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      u.pathname === '/login' ||
      u.pathname.startsWith('/login/') ||
      u.pathname === '/auth/callback' ||
      u.pathname.startsWith('/auth/callback')
    );
  } catch {
    return false;
  }
}

let chatReadyTimer: ReturnType<typeof setTimeout> | null = null;

function clearChatReadyTimer() {
  if (chatReadyTimer) {
    clearTimeout(chatReadyTimer);
    chatReadyTimer = null;
  }
}

function failChatLoad(message: string) {
  clearChatReadyTimer();
  mainWindow?.webContents.send('chat-error', message);
  mainWindow?.webContents.send('chat-ready');
}

function bindChatMediaPermissions(chatSession: Electron.Session) {
  if (chatMediaPermissionsBound) return;
  chatMediaPermissionsBound = true;

  chatSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = new Set([
      'media',
      'mediaKeySystem',
      'display-capture',
      'fullscreen',
      'notifications',
    ]);
    callback(allow.has(String(permission)));
  });

  chatSession.setPermissionCheckHandler((_wc, permission) => {
    const p = String(permission);
    return p === 'media' || p === 'display-capture' || p === 'fullscreen' || p === 'notifications';
  });

  // Electron needs an explicit display-media handler for getDisplayMedia in BrowserView.
  chatSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      // Prefer a full screen source so call screen-share matches what users expect on desktop.
      const primary =
        sources.find((s) => String(s.id).startsWith('screen:')) ?? sources[0];
      if (!primary) {
        callback({});
        return;
      }
      try {
        callback({ video: primary, audio: 'loopback' as any });
      } catch {
        // Windows often rejects loopback audio — video-only still works for call screen share.
        callback({ video: primary });
      }
    } catch (err) {
      console.error('[ChatView] display media failed', err);
      callback({});
    }
  });
}

function ensureChatBrowserView() {
  if (chatBrowserView) return chatBrowserView;
  chatBrowserView = new BrowserView({
    webPreferences: {
      partition: 'persist:workforce-chat',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  bindChatMediaPermissions(chatBrowserView.webContents.session);
  chatBrowserView.setBackgroundColor('#ffffff');
  const markLoading = (loading: boolean) => {
    mainWindow?.webContents.send('chat-loading', loading);
  };
  const markReady = () => {
    clearChatReadyTimer();
    const inject = () => void chatBrowserView?.webContents.insertCSS(CHAT_EMBED_CSS);
    inject();
    setTimeout(inject, 400);
    mainWindow?.webContents.send('chat-ready');
    mainWindow?.webContents.send('chat-relayout');
  };
  const maybeReadyFromUrl = (url: string) => {
    if (!chatSessionStarted || !url || url.startsWith('about:')) return;
    if (isChatAppUrl(url)) markReady();
  };
  chatBrowserView.webContents.on('did-start-loading', () => markLoading(true));
  chatBrowserView.webContents.on('did-stop-loading', () => {
    const url = chatBrowserView?.webContents.getURL() || '';
    if (!chatSessionStarted || !url || url.startsWith('about:')) return;
    if (isChatAppUrl(url)) {
      markReady();
      return;
    }
    if (isChatAuthFailureUrl(url)) {
      failChatLoad('Chat sign-in failed. Close chat and try again.');
      return;
    }
    // Stay on loader during desktop-login handoff
    markLoading(true);
  });
  chatBrowserView.webContents.on('did-navigate', (_e, url) => maybeReadyFromUrl(url));
  chatBrowserView.webContents.on('did-navigate-in-page', (_e, url) => maybeReadyFromUrl(url));
  chatBrowserView.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[ChatView] did-fail-load', { code, desc, url });
    // Ignore aborted navigations during redirect
    if (code === -3) return;
    failChatLoad(desc || 'Chat page failed to load');
  });
  chatBrowserView.webContents.on('did-finish-load', () => {
    const url = chatBrowserView?.webContents.getURL() || '';
    if (!isChatAppUrl(url)) return;
    void chatBrowserView?.webContents.insertCSS(CHAT_EMBED_CSS);
    mainWindow?.webContents.send('chat-relayout');
    markReady();
  });
  return chatBrowserView;
}

function hideChatBrowserView() {
  if (!mainWindow || !chatBrowserView) return;
  try {
    mainWindow.removeBrowserView(chatBrowserView);
  } catch {
    /* not attached */
  }
}

function setChatBounds(payload: { top: number } | null) {
  if (!mainWindow) return;
  if (!payload || typeof payload.top !== 'number') {
    hideChatBrowserView();
    return;
  }
  const view = ensureChatBrowserView();
  const attached =
    typeof mainWindow.getBrowserViews === 'function' ? mainWindow.getBrowserViews() : [];
  if (!attached.includes(view)) {
    mainWindow.addBrowserView(view);
  }
  const size = mainWindow.getContentSize();
  const width = size[0] ?? 1100;
  const height = size[1] ?? 760;
  const y = Math.max(0, Math.round(payload.top));
  view.setBounds({
    x: 0,
    y,
    width: Math.max(8, width),
    height: Math.max(8, height - y),
  });
  view.setAutoResize({ width: true, height: true });
}

async function loadChatUrl(url: string | null) {
  const view = ensureChatBrowserView();
  clearChatReadyTimer();
  if (!url) {
    chatSessionStarted = false;
    hideChatBrowserView();
    await view.webContents.loadURL('about:blank');
    return;
  }
  chatSessionStarted = true;
  mainWindow?.webContents.send('chat-loading', true);
  chatReadyTimer = setTimeout(() => {
    const current = chatBrowserView?.webContents.getURL() || '';
    if (isChatAppUrl(current)) {
      mainWindow?.webContents.send('chat-ready');
      return;
    }
    failChatLoad('Chat is taking too long. Check that the website is running, then try again.');
  }, 25_000);
  await view.webContents.loadURL(url);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function fetchPendingLiveView() {
  if (!accessToken) return;
  try {
    const res = await withAuthRetry(() =>
      axios.get(`${apiBaseUrl}/api/v1/screen-share/pending`, {
        headers: authHeaders(),
        timeout: 10000,
      }),
    );
    const pending = (res.data?.success ? res.data.data : null) as LiveViewPrompt | null;
    if (pending?.sessionId) {
      pendingLiveView = pending;
      hideChatBrowserView();
      showMainWindow();
      mainWindow?.webContents.send('live-view-request', pending);
    }
  } catch {
    /* ignore */
  }
}

function disconnectAttendanceSocket() {
  liveSocket?.removeAllListeners();
  liveSocket?.disconnect();
  liveSocket = null;
}

function connectAttendanceSocket() {
  disconnectAttendanceSocket();
  if (!accessToken) return;
  liveSocket = io(resolveSocketUrl(apiBaseUrl), {
    auth: { token: accessToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1500,
  });
  liveSocket.on(
    'attendance:update',
    (payload: { userId?: string; summary?: AttendanceSummary }) => {
      const uid = currentUser?.id ?? currentUser?._id ?? currentUser?.userId;
      if (payload?.userId && uid && String(payload.userId) !== String(uid)) return;
      if (payload?.summary) {
        applyAttendance(payload.summary);
        mainWindow?.webContents.send('status-update', getStatusPayload());
      } else {
        void refreshAttendanceAndNotify();
      }
    },
  );
  liveSocket.on('auth:membership_revoked', (payload: { title?: string; body?: string }) => {
    const message =
      payload?.body ||
      payload?.title ||
      'Your employment has been terminated. You have been signed out.';
    clearSession(false);
    mainWindow?.webContents.send('status-update', getStatusPayload());
    mainWindow?.webContents.send('force-logout', { message });
    showMainWindow();
  });
  liveSocket.on('screen-share:request', (payload: LiveViewPrompt) => {
    if (!payload?.sessionId) return;
    pendingLiveView = payload;
    hideChatBrowserView();
    showMainWindow();
    mainWindow?.webContents.send('live-view-request', payload);
  });
  liveSocket.on('screen-share:session-start', (payload: LiveViewPrompt & { sessionId: string }) => {
    const uid = currentUser?.id ?? currentUser?._id ?? currentUser?.userId;
    if (!payload?.sessionId || !uid) return;
    if (payload.targetUserId && String(payload.targetUserId) !== String(uid)) return;
    startLiveCapture(payload);
  });
  liveSocket.on('screen-share:session-end', (payload: { sessionId?: string }) => {
    if (payload?.sessionId && payload.sessionId === liveSessionId) {
      stopLiveCapture(false);
    }
  });
  liveSocket.on('connect', () => {
    void fetchPendingLiveView();
  });
}

function startLiveCapture(session: { sessionId: string; fromName?: string }) {
  if (!session?.sessionId || liveSessionId === session.sessionId) return;
  stopLiveCapture(false);
  liveSessionId = session.sessionId;
  if (!liveSocket?.connected) connectAttendanceSocket();
  const tick = async () => {
    if (!liveSessionId) return;
    if (liveBusy) return;
    liveBusy = true;
    const sid = liveSessionId;
    try {
      if (liveSocket && !liveSocket.connected) connectAttendanceSocket();
      const frame = await screenshotEngine.captureFrame({
        maxWidth: 880,
        quality: 40,
        skipIfIdle: false,
      });
      if (!frame?.image || liveSessionId !== sid) return;
      if (liveSocket?.connected) {
        liveSocket.emit('screen-share:frame', {
          sessionId: sid,
          image: frame.image,
        });
      }
      await withAuthRetry(() =>
        axios.post(
          `${apiBaseUrl}/api/v1/screen-share/frame`,
          { sessionId: sid, image: frame.image },
          { headers: authHeaders(), timeout: 15000 },
        ),
      );
    } catch (err) {
      console.warn('[AgentMain] live frame failed', (err as Error).message);
    } finally {
      liveBusy = false;
    }
  };
  liveTimer = setInterval(() => {
    void tick();
  }, 1000);
  void tick();
  const capturedSession = session.sessionId;
  setTimeout(
    () => {
      if (liveSessionId === capturedSession) stopLiveCapture(true);
    },
    15 * 60 * 1000,
  );
  showMainWindow();
  mainWindow?.webContents.send('live-share-status', {
    sharing: true,
    sessionId: session.sessionId,
    fromName: session.fromName,
  });
}

function stopLiveCapture(notify = true) {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  const sid = liveSessionId;
  liveSessionId = null;
  if (notify && sid && liveSocket) {
    liveSocket.emit('screen-share:stop', { sessionId: sid });
  }
  mainWindow?.webContents.send('live-share-status', { sharing: false });
}

function setTracking(active: boolean) {
  if (active === isTrackingActive) return;
  if (active) {
    isTrackingActive = true;
    tracker.start();
    screenshotEngine.start();
  } else {
    isTrackingActive = false;
    tracker.stop();
    screenshotEngine.stop();
  }
  tray?.updateTrackingStatus(isTrackingActive);
}

function applyAttendance(summary: AttendanceSummary | null) {
  attendance = summary;
  if (summary?.isCheckedIn) {
    setTracking(true);
    if (summary.isOnBreak) {
      tracker.pause();
      screenshotEngine.stop();
    } else {
      tracker.resume();
      // Ensure screenshots run while actively working
      screenshotEngine.start();
    }
  } else {
    setTracking(false);
  }
}

async function fetchAttendanceToday(): Promise<AttendanceSummary | null> {
  if (!accessToken) return null;
  try {
    const res = await withAuthRetry(() =>
      axios.get(`${apiBaseUrl}/api/v1/agent/attendance/today`, {
        headers: authHeaders(),
        timeout: 10000,
      }),
    );
    if (res.data?.success) return res.data.data as AttendanceSummary;
  } catch (err) {
    console.warn('[AgentMain] attendance poll failed', (err as Error).message);
  }
  return attendance;
}

async function fetchActiveLiveSession() {
  if (!accessToken || liveSessionId) return;
  try {
    const res = await withAuthRetry(() =>
      axios.get(`${apiBaseUrl}/api/v1/screen-share/active`, {
        headers: authHeaders(),
        timeout: 10000,
      }),
    );
    const active = (res.data?.success ? res.data.data : null) as
      (LiveViewPrompt & { status?: string }) | null;
    const uid = currentUser?.id ?? currentUser?._id ?? currentUser?.userId;
    if (!active?.sessionId || !uid) return;
    if (active.targetUserId && String(active.targetUserId) !== String(uid)) return;
    startLiveCapture(active);
  } catch {
    /* ignore */
  }
}

async function refreshAttendanceAndNotify() {
  const summary = await fetchAttendanceToday();
  if (summary) applyAttendance(summary);
  mainWindow?.webContents.send('status-update', getStatusPayload());
  void fetchPendingLiveView();
  void fetchActiveLiveSession();
}

function startAttendancePolling() {
  stopAttendancePolling();
  void refreshAttendanceAndNotify();
  attendancePollTimer = setInterval(() => {
    void refreshAttendanceAndNotify();
  }, 8_000);
}

function stopAttendancePolling() {
  if (attendancePollTimer) {
    clearInterval(attendancePollTimer);
    attendancePollTimer = null;
  }
}

function resolveRendererHtml() {
  const candidates = [
    path.join(__dirname, '../renderer/index.html'),
    path.join(__dirname, '../../src/renderer/index.html'),
    path.join(app.getAppPath(), 'src/renderer/index.html'),
    path.join(app.getAppPath(), 'dist/renderer/index.html'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 640,
    resizable: true,
    title: 'WorkforceHQ Agent',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  const htmlPath = resolveRendererHtml();
  if (!htmlPath) {
    console.error('[AgentMain] renderer HTML not found. Run: npm run build in apps/desktop-agent');
    void mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
        <html><body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;padding:24px">
          <h2>WorkforceHQ Agent</h2>
          <p>UI file missing. From <code>apps/desktop-agent</code> run:</p>
          <pre style="background:#1e293b;padding:12px;border-radius:8px">npm run build && npm start</pre>
        </body></html>
      `)}`,
    );
  } else {
    console.log('[AgentMain] loading UI from', htmlPath);
    void mainWindow.loadFile(htmlPath);
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[AgentMain] did-fail-load', { code, desc, url });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('resize', () => {
    mainWindow?.webContents.send('chat-relayout');
  });

  mainWindow.on('close', (e: any) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    hideChatBrowserView();
    chatBrowserView = null;
    chatSessionStarted = false;
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  apiBaseUrl = resolveDefaultApiUrl() || DEFAULT_API;
  if (apiBaseUrl) {
    saveApiUrl(apiBaseUrl);
    syncEngine.updateApiUrl(apiBaseUrl);
  }
  console.log('[AgentMain] API base URL:', apiBaseUrl || '(missing)');
  createWindow();

  tray = new AgentTray({
    onOpenApp: () => {
      mainWindow?.show();
      mainWindow?.focus();
    },
    onSyncNow: () => {
      syncEngine.syncNow();
    },
    onToggleTracking: () => {
      void (async () => {
        if (!currentUser || !accessToken) return;
        try {
          if (attendance?.isCheckedIn) {
            const res = await withAuthRetry(() =>
              axios.post(
                `${apiBaseUrl}/api/v1/agent/attendance/clock-out`,
                {},
                { headers: authHeaders(), timeout: 15000 },
              ),
            );
            if (res.data?.success) applyAttendance(res.data.data);
          } else {
            const res = await withAuthRetry(() =>
              axios.post(
                `${apiBaseUrl}/api/v1/agent/attendance/clock-in`,
                {},
                { headers: authHeaders(), timeout: 15000 },
              ),
            );
            if (res.data?.success) applyAttendance(res.data.data);
          }
        } catch (err) {
          console.warn('[AgentMain] tray clock toggle failed', (err as Error).message);
        }
        mainWindow?.webContents.send('status-update', getStatusPayload());
      })();
    },
  });
  tray.init();
  syncEngine.setUnauthorizedHandler(refreshAgentTokens);
  syncEngine.start();
  void restoreSessionIfPossible();
});

ipcMain.handle('get-status', async () => getStatusPayload());

ipcMain.handle('chat-load', async (_e, url: string | null) => {
  try {
    await loadChatUrl(url);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
});

ipcMain.handle('chat-open', async () => {
  if (!accessToken || !companySlug) {
    return { success: false, error: 'Not signed in' };
  }
  try {
    const res = await withAuthRetry(() =>
      axios.get(`${apiBaseUrl}/api/v1/agent/chat-handoff`, {
        headers: authHeaders(),
        timeout: 15000,
      }),
    );
    const data = res.data?.success ? res.data.data : null;
    if (!data?.handoffCode || !data?.next) {
      return { success: false, error: 'Could not start chat session' };
    }
    chatUrl = `${resolveWebUrl(apiBaseUrl)}/desktop-login?code=${encodeURIComponent(
      String(data.handoffCode),
    )}&next=${encodeURIComponent(String(data.next))}`;
    console.log('[AgentMain] Opening chat at', resolveWebUrl(apiBaseUrl), '(api:', apiBaseUrl, ')');
    await loadChatUrl(chatUrl);
    return { success: true, chatUrl };
  } catch (err: any) {
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message || 'Could not open chat',
    };
  }
});

ipcMain.on('chat-bounds', (_e, payload: { top: number } | null) => {
  setChatBounds(payload);
});

ipcMain.handle('login', async (_: any, credentials: { email: string; password: string }) => {
  try {
    apiBaseUrl = resolveDefaultApiUrl() || DEFAULT_API;
    if (!apiBaseUrl || (app.isPackaged && isLocalUrl(apiBaseUrl))) {
      return {
        success: false,
        error:
          'This installer has no live server URL. Rebuild with AGENT_API_URL=https://companies-workforce-web.vercel.app',
      };
    }
    saveApiUrl(apiBaseUrl);
    syncEngine.updateApiUrl(apiBaseUrl);

    const res = await axios.post(
      `${apiBaseUrl}/api/v1/agent/auth/login`,
      {
        email: String(credentials.email || '')
          .trim()
          .toLowerCase(),
        password: String(credentials.password || '').trim(),
        deviceId,
        deviceName: `Workforce Agent (${process.platform})`,
      },
      { timeout: 20000 },
    );

    if (res.data && res.data.success) {
      const {
        accessToken: token,
        refreshToken: nextRefresh,
        user,
        chatEnabled: chatOn,
      } = res.data.data;
      accessToken = token;
      refreshToken = nextRefresh || null;
      currentUser = user;
      companySlug = user?.companySlug ?? null;
      chatEnabled = chatOn !== false && Boolean(companySlug);
      chatUrl = null;
      syncEngine.setToken(token);
      persistSession();
      startTokenRefreshLoop();

      try {
        const configRes = await axios.get(`${apiBaseUrl}/api/v1/agent/config`, {
          headers: authHeaders(),
        });
        if (configRes.data && configRes.data.success) {
          const cfg = configRes.data.data;
          screenshotEngine.updateConfig({
            screenshotIntervalSec: cfg.screenshotIntervalSec,
            blurScreenshots: cfg.blurScreenshots,
            trackIdleAfterSec: cfg.trackIdleAfterSec,
            pauseOnIdle: false,
          });
          tracker.updateConfig({
            trackIdleAfterSec: cfg.trackIdleAfterSec,
          });
        }
      } catch (cfgErr) {
        console.warn('[AgentMain] Failed to load server config', cfgErr);
      }

      const summary = await fetchAttendanceToday();
      applyAttendance(summary);
      connectAttendanceSocket();
      startAttendancePolling();
      void fetchPendingLiveView();
      void syncEngine.syncNow();

      return { success: true, user, attendance: summary };
    }

    return { success: false, error: res.data?.error?.message || 'Login failed' };
  } catch (err: any) {
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message || 'Login failed',
    };
  }
});

ipcMain.handle('logout', async () => {
  clearSession(false);
  return getStatusPayload();
});

ipcMain.handle('toggle-tracking', async () => {
  if (!currentUser || !accessToken) return getStatusPayload();
  try {
    if (attendance?.isCheckedIn) {
      // End open break before clock-out
      if (attendance.isOnBreak) {
        await withAuthRetry(() =>
          axios.post(
            `${apiBaseUrl}/api/v1/agent/attendance/break/end`,
            {},
            { headers: authHeaders(), timeout: 15000 },
          ),
        );
      }
      const res = await withAuthRetry(() =>
        axios.post(
          `${apiBaseUrl}/api/v1/agent/attendance/clock-out`,
          {},
          { headers: authHeaders(), timeout: 15000 },
        ),
      );
      if (res.data?.success) applyAttendance(res.data.data);
    } else {
      const res = await withAuthRetry(() =>
        axios.post(
          `${apiBaseUrl}/api/v1/agent/attendance/clock-in`,
          {},
          { headers: authHeaders(), timeout: 15000 },
        ),
      );
      if (res.data?.success) applyAttendance(res.data.data);
    }
    return getStatusPayload();
  } catch (err: any) {
    return {
      ...getStatusPayload(),
      error: err.response?.data?.error?.message || err.message || 'Clock action failed',
    };
  }
});

ipcMain.handle('break-toggle', async (_: any, type?: string) => {
  if (!currentUser || !accessToken) return getStatusPayload();
  try {
    if (!attendance?.isCheckedIn) {
      return { ...getStatusPayload(), error: 'Clock in first before taking a break' };
    }
    if (attendance.isOnBreak) {
      const res = await withAuthRetry(() =>
        axios.post(
          `${apiBaseUrl}/api/v1/agent/attendance/break/end`,
          {},
          { headers: authHeaders(), timeout: 15000 },
        ),
      );
      if (res.data?.success) applyAttendance(res.data.data);
    } else {
      const res = await withAuthRetry(() =>
        axios.post(
          `${apiBaseUrl}/api/v1/agent/attendance/break/start`,
          { type: type || 'short' },
          { headers: authHeaders(), timeout: 15000 },
        ),
      );
      if (res.data?.success) applyAttendance(res.data.data);
    }
    return getStatusPayload();
  } catch (err: any) {
    return {
      ...getStatusPayload(),
      error: err.response?.data?.error?.message || err.message || 'Break action failed',
    };
  }
});

ipcMain.handle(
  'live-view-respond',
  async (_: any, payload: { sessionId: string; accepted: boolean }) => {
    if (!accessToken || !payload?.sessionId) {
      return { success: false, error: 'Not signed in' };
    }
    try {
      const res = await withAuthRetry(() =>
        axios.post(
          `${apiBaseUrl}/api/v1/screen-share/respond`,
          { sessionId: payload.sessionId, accepted: payload.accepted },
          { headers: authHeaders(), timeout: 15000 },
        ),
      );
      const fromName = pendingLiveView?.fromName;
      pendingLiveView = null;
      if (payload.accepted) {
        await screenshotEngine.capture({ force: true });
        void syncEngine.syncNow();
        startLiveCapture({
          sessionId: payload.sessionId,
          fromName,
        });
      }
      return { success: Boolean(res.data?.success), data: res.data?.data };
    } catch (err: any) {
      return {
        success: false,
        error: err.response?.data?.error?.message || err.message || 'Could not respond',
      };
    }
  },
);

ipcMain.handle('live-view-stop', async () => {
  stopLiveCapture(true);
  return { success: true };
});

function getStatusPayload() {
  const win = tracker.getCurrentWindow();
  return {
    isTrackingActive,
    isCheckedIn: Boolean(attendance?.isCheckedIn),
    isOnBreak: Boolean(attendance?.isOnBreak),
    user: currentUser,
    deviceId,
    apiBaseUrl,
    liveViewRequest: pendingLiveView,
    liveSharing: Boolean(liveSessionId),
    chatEnabled,
    chatUrl,
    companySlug,
    attendance,
    checkInAt: attendance?.checkInAt ?? null,
    checkOutAt: attendance?.checkOutAt ?? null,
    openCheckInAt: attendance?.openCheckInAt ?? null,
    breakStartedAt: attendance?.breakStartedAt ?? null,
    breakType: attendance?.breakType ?? null,
    totalWorkedMinutes: attendance?.totalWorkedMinutes ?? 0,
    totalBreakMinutes: attendance?.totalBreakMinutes ?? 0,
    workedSeconds: attendance?.workedSeconds ?? (attendance?.totalWorkedMinutes ?? 0) * 60,
    attendanceStatus: attendance?.status ?? null,
    currentApp: win.app,
    currentWindowTitle: win.title,
  };
}

app.on('before-quit', () => {
  isQuitting = true;
  stopLiveCapture(true);
  stopAttendancePolling();
  stopTokenRefreshLoop();
  disconnectAttendanceSocket();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
