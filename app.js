// ============================================================
//  RepChat — popup.js  (Firebase real-time, cross-PC)
//  Admin password : OT147147%%
//  Reps use a generated key (RC-XXXX-XXXX) to enter
// ============================================================

const ADMIN_PASSWORD = 'OT147147%%';
const ADMIN = { id: 'admin', name: 'Admin', role: 'admin', avatar: 'AD', color: '#FF6B35' };
const AVATAR_COLORS = ['#4ECDC4','#45B7D1','#96CEB4','#DDA0DD','#F0A500','#7EC8E3','#FF6B6B','#A8E6CF'];

// ── Active Firebase listeners (unsubscribe on channel change) ──
let activeListeners = [];

let state = {
  currentUser:  null,
  reps:         [],
  messages:     {},       // { channelId: [ {id,from,text,ts}, … ] }
  accessKeys:   {},       // { key: repId }
  activeChannel:'general',
  adminTab:     'chat',
  deleteTarget: null,
  loginMode:    'choose', // 'choose' | 'admin' | 'rep'
  loginError:   '',
  connected:    false,    // Firebase connection state
  loading:      true,     // initial data load
  unread:       {},        // { channelId: true } — channels with unread messages
};

// ════════════════════════════════════════════════════════════
//  FIREBASE HELPERS
// ════════════════════════════════════════════════════════════

function fbRef(path) { return db.ref(path); }

// Write helpers
function fbSetReps()       { fbRef('reps').set(arrayToObj(state.reps, 'id')); }
function fbSetKeys()       { fbRef('accessKeys').set(state.accessKeys); }

function fbSendMessage(channel, text) {
  const msg = { from: state.currentUser.id, text, ts: Date.now() };
  fbRef(`messages/${channel}`).push(msg);
}

// Convert array → keyed object for Firebase
function arrayToObj(arr, keyField) {
  const obj = {};
  arr.forEach(item => { obj[item[keyField]] = item; });
  return obj;
}

// Convert Firebase snapshot object → array
function objToArray(obj) {
  if (!obj) return [];
  return Object.values(obj);
}

// ════════════════════════════════════════════════════════════
//  BOOTSTRAP — load everything from Firebase on open
// ════════════════════════════════════════════════════════════

function bootstrap() {
  // Show the login screen immediately — don't wait for Firebase
  state.loading = false;
  restoreSession(() => {
    render();
    if (state.currentUser) subscribeToChannel(state.activeChannel);
  });

  // Load Firebase data in the background — updates UI when ready
  fbRef('.info/connected').on('value', snap => {
    state.connected = !!snap.val();
    updateConnectionBadge();
  });

  fbRef('reps').on('value', snap => {
    const data = snap.val();
    state.reps = data ? Object.values(data) : getDefaultReps();
    if (!data) fbSetReps();
    partialRender();
  });

  fbRef('accessKeys').on('value', snap => {
    state.accessKeys = snap.val() || {};
  });
}

function getDefaultReps() {
  return [
    { id: 'rep1', name: 'Sarah Chen',  avatar: 'SC', color: '#4ECDC4', online: false },
    { id: 'rep2', name: 'Marcus Webb', avatar: 'MW', color: '#45B7D1', online: false },
    { id: 'rep3', name: 'Priya Nair',  avatar: 'PN', color: '#96CEB4', online: false },
  ];
}

function finishLoading() {
  state.loading = false;
  restoreSession(() => {
    render();
    if (state.currentUser) subscribeToChannel(state.activeChannel);
  });
}

// ════════════════════════════════════════════════════════════
//  SESSION PERSISTENCE (chrome.storage for login only)
// ════════════════════════════════════════════════════════════

function restoreSession(cb) {
  chrome.storage.local.get(['currentUserId', 'activeChannel'], data => {
    if (data.currentUserId) {
      if (data.currentUserId === 'admin') {
        state.currentUser = ADMIN;
      } else {
        state.currentUser = state.reps.find(r => r.id === data.currentUserId) || null;
      }
      if (data.activeChannel) state.activeChannel = data.activeChannel;
    }
    cb();
  });
}

function saveSession() {
  chrome.storage.local.set({
    currentUserId: state.currentUser ? state.currentUser.id : null,
    activeChannel: state.activeChannel,
  });
}

// ════════════════════════════════════════════════════════════
//  REAL-TIME MESSAGE SUBSCRIPTION
// ════════════════════════════════════════════════════════════

// ── Audio beep (generated via Web Audio API — no file needed) ──
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

// Track which channels have been fully loaded (to avoid beeping on initial history)
const channelsInitialized = new Set();

function subscribeToChannel(channel) {
  // Remove old listeners
  activeListeners.forEach(({ ref, event, fn }) => ref.off(event, fn));
  activeListeners = [];

  state.messages[channel] = [];
  channelsInitialized.delete(channel);

  // Mark channel as read when we open it
  delete state.unread[channel];

  const ref = fbRef(`messages/${channel}`);

  // Load last 100 messages, then listen for new ones
  const fn = ref.limitToLast(100).on('child_added', snap => {
    const msg = snap.val();
    msg.id = snap.key;
    if (!state.messages[channel]) state.messages[channel] = [];

    // Avoid duplicates
    if (!state.messages[channel].find(m => m.id === msg.id)) {
      state.messages[channel].push(msg);
      state.messages[channel].sort((a, b) => a.ts - b.ts);
    }

    // Only beep + mark unread for NEW messages from others (after initial load)
    const isFromMe = state.currentUser && msg.from === state.currentUser.id;
    if (channelsInitialized.has(channel) && !isFromMe) {
      playBeep();
      state.unread[channel] = true;
      updateSidebarUnread();
      showInAppNotif(channel, msg);
    }

    renderMessagesOnly();
    scrollToBottom();
  });

  // Mark as initialized after first batch loads (small delay)
  setTimeout(() => { channelsInitialized.add(channel); }, 800);

  activeListeners.push({ ref: ref.limitToLast(100), event: 'child_added', fn });
}

// Subscribe to ALL channels in background so we get notifications everywhere
function subscribeToAllChannels() {
  if (!state.currentUser) return;
  const myId = state.currentUser.id;
  const allChannels = ['general'];

  // All DM channels involving this user
  const everyone = [ADMIN, ...state.reps];
  everyone.forEach(u => {
    if (u.id !== myId) allChannels.push(dmChannelId(myId, u.id));
  });

  allChannels.forEach(ch => {
    if (ch === state.activeChannel) return; // already subscribed
    const ref = fbRef(`messages/${ch}`);
    const bgRef = ref.limitToLast(1);
    let initialized = false;
    setTimeout(() => { initialized = true; }, 800);

    bgRef.on('child_added', snap => {
      if (!initialized) return;
      const msg = snap.val();
      const isFromMe = state.currentUser && msg.from === state.currentUser.id;
      if (!isFromMe) {
        playBeep();
        state.unread[ch] = true;
        updateSidebarUnread();
        showInAppNotif(ch, msg);
      }
    });
  });
}

function updateSidebarUnread() {
  // Update unread dots in sidebar without full re-render
  document.querySelectorAll('[data-channel]').forEach(el => {
    const ch = el.dataset.channel;
    const dot = el.querySelector('.unread-dot');
    if (state.unread[ch]) {
      if (!dot) {
        const d = document.createElement('span');
        d.className = 'unread-dot';
        el.appendChild(d);
      }
    } else {
      if (dot) dot.remove();
    }

    // Bold the sender name in DM list if unread
    const nameEl = el.querySelector('.dm-name');
    if (nameEl) {
      nameEl.style.fontWeight = state.unread[ch] ? '700' : '500';
      nameEl.style.color = state.unread[ch] ? '#fff' : '';
    }
  });
}

function showInAppNotif(channel, msg) {
  const sender = getUserById(msg.from);
  const chName = getChannelName(channel);
  const label = channel === state.activeChannel ? null : chName;
  if (!label) return;

  // Remove any existing message notif
  document.querySelector('.msg-notif')?.remove();

  const el = document.createElement('div');
  el.className = 'msg-notif';
  el.innerHTML = `
    <div class="msg-notif-avatar" style="background:${sender.color}">${esc(sender.avatar)}</div>
    <div class="msg-notif-body">
      <div class="msg-notif-name">${esc(sender.name)} <span class="msg-notif-ch">${esc(label)}</span></div>
      <div class="msg-notif-text">${esc(msg.text.length > 50 ? msg.text.slice(0,50)+'…' : msg.text)}</div>
    </div>
  `;
  el.addEventListener('click', () => {
    state.activeChannel = channel;
    state.adminTab = 'chat';
    delete state.unread[channel];
    saveSession();
    render();
    subscribeToChannel(channel);
    el.remove();
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ════════════════════════════════════════════════════════════
//  RENDER ROUTER
// ════════════════════════════════════════════════════════════

function render() {
  const app = document.getElementById('app');

  // Never block on loading — always show something immediately
  if (!state.currentUser) {
    if (state.loginMode === 'admin') {
      app.innerHTML = renderAdminLogin();
      bindAdminLogin();
    } else if (state.loginMode === 'rep') {
      app.innerHTML = renderRepKeyLogin();
      bindRepKeyLogin();
    } else {
      app.innerHTML = renderChooseLogin();
      bindChooseLogin();
    }
    return;
  }

  app.innerHTML = renderChatApp();
  bindChatApp();
  scrollToBottom();
}

// Re-render only the messages pane (avoids full DOM wipe on each message)
function partialRender() {
  if (!state.currentUser) { render(); return; }
  const existing = document.getElementById('chat-app');
  if (!existing) { render(); return; }
  const app = document.getElementById('app');
  app.innerHTML = renderChatApp();
  bindChatApp();
  scrollToBottom();
}

function renderMessagesOnly() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  const msgs = state.messages[state.activeChannel] || [];
  if (msgs.length === 0) {
    area.innerHTML = `<div class="empty-chat"><div class="empty-chat-icon">💬</div>No messages yet. Say hello!</div>`;
    return;
  }
  let html = '';
  let lastFrom = null;
  msgs.forEach(msg => {
    const isMe = msg.from === state.currentUser?.id;
    const sender = getUserById(msg.from);
    const showMeta = msg.from !== lastFrom;
    lastFrom = msg.from;
    html += `
      <div class="msg-row ${isMe ? 'me' : ''}" style="margin-top:${showMeta ? '8px' : '2px'}">
        ${!isMe ? (showMeta
          ? `<div class="avatar" style="background:${sender.color};align-self:flex-end">${esc(sender.avatar)}</div>`
          : `<div class="msg-avatar-space"></div>`
        ) : ''}
        <div class="msg-content">
          ${showMeta ? `<div class="msg-sender" style="color:${isMe ? '#FF6B35' : sender.color}">${isMe ? 'You' : esc(sender.name)}</div>` : ''}
          <div class="msg-bubble ${isMe ? 'me' : 'them'}">${esc(msg.text)}</div>
          <div class="msg-time">${formatTime(msg.ts)}</div>
        </div>
      </div>
    `;
  });
  area.innerHTML = html;
}

function updateConnectionBadge() {
  const badge = document.getElementById('conn-badge');
  if (!badge) return;
  badge.textContent = state.connected ? '● Live' : '○ Offline';
  badge.style.color  = state.connected ? '#4ECDC4' : '#ff5555';
}

// ════════════════════════════════════════════════════════════
//  SCREENS
// ════════════════════════════════════════════════════════════

function renderLoadingScreen() {
  return `
    <div id="login-screen">
      <div class="login-logo" style="animation:pulse 1.5s infinite">💬</div>
      <div class="login-title">RepChat</div>
      <div class="login-sub" style="color:#555">Connecting to server…</div>
      <div class="spinner"></div>
    </div>
  `;
}

function renderChooseLogin() {
  return `
    <div id="login-screen">
      <div class="login-logo">💬</div>
      <div class="login-title">RepChat</div>
      <div class="login-sub">Team Communication Hub</div>
      <div style="width:100%;display:flex;flex-direction:column;gap:10px;margin-top:8px">
        <button class="choose-btn" id="choose-admin">
          <span class="choose-icon">👑</span>
          <div class="choose-text">
            <div class="choose-label">Admin</div>
            <div class="choose-hint">Password required</div>
          </div>
          <span class="choose-arrow">→</span>
        </button>
        <button class="choose-btn" id="choose-rep">
          <span class="choose-icon">👤</span>
          <div class="choose-text">
            <div class="choose-label">Rep</div>
            <div class="choose-hint">Access key required</div>
          </div>
          <span class="choose-arrow">→</span>
        </button>
      </div>
      <div style="margin-top:16px;font-size:10px;color:#2a2a3a">
        ${state.connected ? '<span style="color:#4ECDC4">● Connected</span>' : '<span style="color:#555">○ Connecting…</span>'}
      </div>
    </div>
  `;
}

function bindChooseLogin() {
  document.getElementById('choose-admin').addEventListener('click', () => { state.loginMode = 'admin'; state.loginError = ''; render(); });
  document.getElementById('choose-rep').addEventListener('click',   () => { state.loginMode = 'rep';   state.loginError = ''; render(); });
}

function renderAdminLogin() {
  return `
    <div id="login-screen">
      <div class="login-logo">👑</div>
      <div class="login-title">Admin Login</div>
      <div class="login-sub">Enter your admin password</div>
      <div class="login-label">Password</div>
      <div class="input-wrap">
        <input id="admin-pw-input" type="password" placeholder="Enter password…" class="login-input" autocomplete="off" />
        <button id="toggle-pw" class="pw-toggle">👁</button>
      </div>
      ${state.loginError ? `<div class="login-error">⚠ ${esc(state.loginError)}</div>` : ''}
      <button id="admin-login-btn" class="login-btn-primary">Sign In →</button>
      <button id="back-btn" class="back-btn">← Back</button>
    </div>
  `;
}

function bindAdminLogin() {
  const input = document.getElementById('admin-pw-input');
  document.getElementById('toggle-pw').addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  const tryLogin = () => {
    if (input.value === ADMIN_PASSWORD) {
      state.currentUser = ADMIN;
      state.loginMode   = 'choose';
      state.loginError  = '';
      state.activeChannel = 'general';
      state.adminTab    = 'chat';
      saveSession();
      render();
      subscribeToChannel('general');
      setTimeout(subscribeToAllChannels, 900);
    } else {
      state.loginError = 'Incorrect password. Try again.';
      input.value = '';
      render(); bindAdminLogin();
    }
  };
  document.getElementById('admin-login-btn').addEventListener('click', tryLogin);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  document.getElementById('back-btn').addEventListener('click', () => { state.loginMode = 'choose'; state.loginError = ''; render(); });
  input.focus();
}

function renderRepKeyLogin() {
  return `
    <div id="login-screen">
      <div class="login-logo">🔑</div>
      <div class="login-title">Rep Access</div>
      <div class="login-sub">Enter your access key from Admin</div>
      <div class="login-label">Access Key</div>
      <input id="rep-key-input" type="text" placeholder="RC-XXXX-XXXX" class="login-input key-input" autocomplete="off" />
      ${state.loginError ? `<div class="login-error">⚠ ${esc(state.loginError)}</div>` : ''}
      <button id="rep-login-btn" class="login-btn-primary">Enter Chat →</button>
      <button id="back-btn" class="back-btn">← Back</button>
    </div>
  `;
}

function bindRepKeyLogin() {
  const input = document.getElementById('rep-key-input');
  const tryKey = () => {
    const key = input.value.trim().toUpperCase();
    const repId = state.accessKeys[key];
    if (repId) {
      const rep = state.reps.find(r => r.id === repId);
      if (rep) {
        state.currentUser   = rep;
        state.loginMode     = 'choose';
        state.loginError    = '';
        state.activeChannel = 'general';
        saveSession();
        render();
        subscribeToChannel('general');
        setTimeout(subscribeToAllChannels, 900);
        return;
      }
    }
    state.loginError = 'Invalid key. Contact your Admin.';
    input.value = '';
    render(); bindRepKeyLogin();
  };
  document.getElementById('rep-login-btn').addEventListener('click', tryKey);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryKey(); });
  document.getElementById('back-btn').addEventListener('click', () => { state.loginMode = 'choose'; state.loginError = ''; render(); });
  input.focus();
}

// ════════════════════════════════════════════════════════════
//  MAIN APP
// ════════════════════════════════════════════════════════════

function renderChatApp() {
  const isAdmin = state.currentUser.role === 'admin';
  return `
    <div id="chat-app">
      ${renderSidebar(isAdmin)}
      ${isAdmin && state.adminTab === 'manage' ? renderManagePanel() : renderChatPanel()}
    </div>
    ${state.deleteTarget ? renderDeleteModal() : ''}
  `;
}

function renderSidebar(isAdmin) {
  const u = state.currentUser;
  return `
    <div id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-logo-icon">💬</div>
        <span class="sidebar-logo-text">RepChat</span>
        <span id="conn-badge" style="margin-left:auto;font-size:9px;color:${state.connected ? '#4ECDC4' : '#ff5555'}">${state.connected ? '● Live' : '○ Off'}</span>
      </div>
      <div class="current-user-bar">
        <div class="avatar" style="background:${u.color}">${esc(u.avatar)}</div>
        <div style="min-width:0">
          <div class="user-name-small">${esc(u.name)}</div>
          <div class="user-role-small ${isAdmin ? 'admin' : ''}">${isAdmin ? '👑 Admin' : 'Rep'}</div>
        </div>
      </div>
      ${isAdmin ? `
        <div class="admin-tabs">
          <button class="admin-tab ${state.adminTab === 'chat'   ? 'active' : ''}" data-tab="chat">💬 Chat</button>
          <button class="admin-tab ${state.adminTab === 'manage' ? 'active' : ''}" data-tab="manage">⚙️ Mgmt</button>
        </div>
      ` : ''}
      <div class="sidebar-scroll">
        ${isAdmin && state.adminTab === 'manage' ? renderManageSidebarHint() : renderChannelList(isAdmin)}
      </div>
      <div class="sidebar-footer">
        <button class="signout-btn" id="signout-btn">← Sign out</button>
      </div>
    </div>
  `;
}

function dmChannelId(idA, idB) {
  return 'dm_' + [idA, idB].sort().join('_');
}

function getChannelDisplayName(ch) {
  if (ch === 'general') return '# General';
  if (ch.startsWith('dm_')) {
    const myId = state.currentUser ? state.currentUser.id : '';
    const parts = ch.replace('dm_', '').split('_');
    // Find the other person's ID (not mine)
    // IDs can contain underscores so we stored sorted pair
    const otherId = parts.find(p => p !== myId) || parts[0];
    if (otherId === 'admin') return '@ Admin';
    const rep = state.reps.find(r => r.id === otherId);
    return rep ? `@ ${rep.name}` : ch;
  }
  return ch;
}

function renderChannelList(isAdmin) {
  const myId = state.currentUser.id;

  let html = `<div class="section-label">Channels</div>
    <div class="channel-item ${state.activeChannel === 'general' ? 'active' : ''}" data-channel="general">
      <span class="channel-name"># general</span>
      ${state.unread['general'] ? '<span class="unread-dot"></span>' : ''}
    </div>`;

  html += `<div class="section-label" style="margin-top:6px">Direct Messages</div>`;

  if (isAdmin) {
    state.reps.forEach(rep => {
      const chId = dmChannelId('admin', rep.id);
      html += `
        <div class="dm-item ${state.activeChannel === chId ? 'active' : ''}" data-channel="${chId}">
          <div class="avatar" style="background:${rep.color};width:22px;height:22px;border-radius:5px;font-size:8px">${esc(rep.avatar)}</div>
          <div class="dm-info"><div class="dm-name" style="font-weight:${state.unread[chId] ? '700' : '500'};color:${state.unread[chId] ? '#fff' : ''}">${esc(rep.name)}</div></div>
          ${state.unread[chId] ? '<span class="unread-dot"></span>' : ''}
        </div>`;
    });
  } else {
    // Rep sees Admin DM
    const adminChId = dmChannelId(myId, 'admin');
    html += `
      <div class="dm-item ${state.activeChannel === adminChId ? 'active' : ''}" data-channel="${adminChId}">
        <div class="avatar" style="background:#FF6B35;width:22px;height:22px;border-radius:5px;font-size:8px">AD</div>
        <div class="dm-info"><div class="dm-name" style="font-weight:${state.unread[adminChId] ? '700' : '500'};color:${state.unread[adminChId] ? '#fff' : ''}">Admin</div></div>
        ${state.unread[adminChId] ? '<span class="unread-dot"></span>' : ''}
      </div>`;
    // Rep sees all other reps
    state.reps.forEach(rep => {
      if (rep.id === myId) return;
      const chId = dmChannelId(myId, rep.id);
      html += `
        <div class="dm-item ${state.activeChannel === chId ? 'active' : ''}" data-channel="${chId}">
          <div class="avatar" style="background:${rep.color};width:22px;height:22px;border-radius:5px;font-size:8px">${esc(rep.avatar)}</div>
          <div class="dm-info"><div class="dm-name" style="font-weight:${state.unread[chId] ? '700' : '500'};color:${state.unread[chId] ? '#fff' : ''}">${esc(rep.name)}</div></div>
          ${state.unread[chId] ? '<span class="unread-dot"></span>' : ''}
        </div>`;
    });
  }
  return html;
}

function renderManageSidebarHint() {
  return `<div style="padding:6px 8px;color:#333;font-size:10px;text-align:center;margin-top:10px;">Manage reps in the main panel →</div>`;
}

function renderManagePanel() {
  const totalMsgs = Object.values(state.messages).flat().length;
  const repKeyMap = {};
  Object.entries(state.accessKeys).forEach(([k, v]) => { repKeyMap[v] = k; });

  return `
    <div id="manage-panel">
      <div class="manage-header">
        <div class="manage-title">Team Management</div>
        <div class="manage-subtitle">Add reps &amp; manage access keys</div>
      </div>
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-num" style="color:#FF6B35">${state.reps.length}</div>
          <div class="stat-label">Total Reps</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="color:#4ECDC4">${state.connected ? '●' : '○'}</div>
          <div class="stat-label">${state.connected ? 'Live' : 'Offline'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="color:#45B7D1">${totalMsgs}</div>
          <div class="stat-label">Msgs Loaded</div>
        </div>
      </div>
      <div class="add-rep-section">
        <div class="add-rep-row">
          <input class="add-rep-input" id="new-rep-input" placeholder="Rep full name…" />
          <button class="add-rep-btn" id="add-rep-btn">+ Add</button>
        </div>
      </div>
      <div class="reps-list">
        ${state.reps.length === 0
          ? `<div style="text-align:center;color:#333;font-size:12px;padding:20px">No reps yet.</div>`
          : state.reps.map(rep => {
              const key = repKeyMap[rep.id];
              return `
                <div class="rep-manage-row">
                  <div class="avatar lg" style="background:${rep.color}">${esc(rep.avatar)}</div>
                  <div class="rep-manage-info">
                    <div class="rep-manage-name">${esc(rep.name)}</div>
                    ${key
                      ? `<div class="key-display">
                           <span class="key-tag">${esc(key)}</span>
                           <button class="icon-btn copy-key-btn" data-key="${esc(key)}" title="Copy">📋</button>
                           <button class="icon-btn regen-key-btn" data-repid="${rep.id}" title="New key">🔄</button>
                         </div>`
                      : `<div class="no-key-row">
                           <button class="gen-key-btn" data-repid="${rep.id}">🔑 Generate Key</button>
                         </div>`
                    }
                  </div>
                  <button class="delete-btn" data-repid="${rep.id}" title="Remove">✕</button>
                </div>`;
            }).join('')
        }
      </div>
    </div>
  `;
}

function renderChatPanel() {
  const ch     = state.activeChannel;
  const msgs   = state.messages[ch] || [];
  const chName = getChannelName(ch);

  let msgsHtml = '';
  if (msgs.length === 0) {
    msgsHtml = `<div class="empty-chat"><div class="empty-chat-icon">💬</div>No messages yet. Say hello!</div>`;
  } else {
    let lastFrom = null;
    msgs.forEach(msg => {
      const isMe     = msg.from === state.currentUser.id;
      const sender   = getUserById(msg.from);
      const showMeta = msg.from !== lastFrom;
      lastFrom = msg.from;
      msgsHtml += `
        <div class="msg-row ${isMe ? 'me' : ''}" style="margin-top:${showMeta ? '8px' : '2px'}">
          ${!isMe ? (showMeta
            ? `<div class="avatar" style="background:${sender.color};align-self:flex-end">${esc(sender.avatar)}</div>`
            : `<div class="msg-avatar-space"></div>`
          ) : ''}
          <div class="msg-content">
            ${showMeta ? `<div class="msg-sender" style="color:${isMe ? '#FF6B35' : sender.color}">${isMe ? 'You' : esc(sender.name)}</div>` : ''}
            <div class="msg-bubble ${isMe ? 'me' : 'them'}">${esc(msg.text)}</div>
            <div class="msg-time">${formatTime(msg.ts)}</div>
          </div>
        </div>`;
    });
  }

  return `
    <div id="chat-panel">
      <div class="chat-header">
        <div class="chat-header-name">${esc(chName)}</div>
        <div class="chat-header-status">${state.connected ? '● Live sync' : '○ Reconnecting…'}</div>
      </div>
      <div class="messages-area" id="messages-area">${msgsHtml}</div>
      <div class="input-area">
        <div class="input-row">
          <textarea id="msg-input" placeholder="Message ${esc(chName)}…" rows="1"></textarea>
          <button id="send-btn" disabled>↑</button>
        </div>
        <div class="input-hint">Enter to send · Shift+Enter new line</div>
      </div>
    </div>`;
}

function renderDeleteModal() {
  const rep = state.reps.find(r => r.id === state.deleteTarget);
  if (!rep) return '';
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <div class="modal-icon">🗑️</div>
        <div class="modal-title">Remove Rep?</div>
        <div class="modal-desc">${esc(rep.name)} will be removed and their access key revoked.</div>
        <div class="modal-btns">
          <button class="modal-cancel" id="modal-cancel">Cancel</button>
          <button class="modal-confirm" id="modal-confirm">Remove</button>
        </div>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════════
//  EVENT BINDING
// ════════════════════════════════════════════════════════════

function bindChatApp() {
  document.getElementById('signout-btn')?.addEventListener('click', () => {
    state.currentUser = null;
    state.loginMode   = 'choose';
    activeListeners.forEach(({ ref, event, fn }) => ref.off(event, fn));
    activeListeners = [];
    saveSession();
    render();
  });

  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => { state.adminTab = btn.dataset.tab; render(); bindChatApp(); });
  });

  document.querySelectorAll('[data-channel]').forEach(el => {
    el.addEventListener('click', () => {
      state.activeChannel = el.dataset.channel;
      state.adminTab = 'chat';
      delete state.unread[state.activeChannel];
      saveSession();
      render();
      subscribeToChannel(state.activeChannel);
    });
  });

  // Delete rep
  document.querySelectorAll('.delete-btn[data-repid]').forEach(btn => {
    btn.addEventListener('click', () => { state.deleteTarget = btn.dataset.repid; render(); bindChatApp(); });
  });
  document.getElementById('modal-cancel')?.addEventListener('click', () => { state.deleteTarget = null; render(); bindChatApp(); });
  document.getElementById('modal-overlay')?.addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') { state.deleteTarget = null; render(); bindChatApp(); }
  });
  document.getElementById('modal-confirm')?.addEventListener('click', () => {
    const repId = state.deleteTarget;
    const rep   = state.reps.find(r => r.id === repId);
    state.reps  = state.reps.filter(r => r.id !== repId);
    Object.keys(state.accessKeys).forEach(k => { if (state.accessKeys[k] === repId) delete state.accessKeys[k]; });
    if (state.activeChannel === repId) state.activeChannel = 'general';
    state.deleteTarget = null;
    fbSetReps(); fbSetKeys();
    render(); bindChatApp();
    showNotif(`${rep.name} removed`, 'error');
  });

  // Add rep
  document.getElementById('add-rep-btn')?.addEventListener('click', addRep);
  document.getElementById('new-rep-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') addRep(); });

  // Key actions
  document.querySelectorAll('.gen-key-btn, .regen-key-btn').forEach(btn => {
    btn.addEventListener('click', () => generateKey(btn.dataset.repid));
  });
  document.querySelectorAll('.copy-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.key).then(() => {
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 2000);
      });
    });
  });

  bindMessageInput();
}

function bindMessageInput() {
  const sendBtn  = document.getElementById('send-btn');
  const msgInput = document.getElementById('msg-input');
  if (!sendBtn || !msgInput) return;

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener('input', () => {
    sendBtn.disabled = !msgInput.value.trim();
    autoResize(msgInput);
  });
}

// ════════════════════════════════════════════════════════════
//  ACTIONS
// ════════════════════════════════════════════════════════════

function sendMessage() {
  const input = document.getElementById('msg-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  // Write to Firebase — the listener will receive it and update UI
  fbSendMessage(state.activeChannel, text);
}

function addRep() {
  const input = document.getElementById('new-rep-input');
  if (!input || !input.value.trim()) return;
  const name   = input.value.trim();
  const id     = 'rep_' + Date.now();
  const parts  = name.split(' ');
  const avatar = (parts[0][0] + (parts[1] ? parts[1][0] : parts[0][1] || '')).toUpperCase();
  const color  = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  state.reps.push({ id, name, avatar, color, online: false });
  input.value = '';
  fbSetReps();
  showNotif(`${name} added — generate their key!`);
}

function generateKey(repId) {
  // Revoke old key for this rep
  Object.keys(state.accessKeys).forEach(k => { if (state.accessKeys[k] === repId) delete state.accessKeys[k]; });

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg   = len => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const key   = `RC-${seg(4)}-${seg(4)}`;

  state.accessKeys[key] = repId;
  fbSetKeys();

  const rep = state.reps.find(r => r.id === repId);
  render(); bindChatApp();
  showNotif(`Key generated for ${rep?.name}`);
}

// ════════════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════════════

function getUserById(id) {
  if (id === 'admin') return ADMIN;
  return state.reps.find(r => r.id === id) || { name: 'Unknown', avatar: '?', color: '#555' };
}
function getChannelName(ch) {
  if (ch === 'general') return '# General';
  if (ch.startsWith('dm_')) {
    const myId = state.currentUser ? state.currentUser.id : '';
    // Strip the dm_ prefix, remaining is two sorted IDs joined by _
    const rest = ch.slice(3); // remove 'dm_'
    // Try to find which rep or admin is the other party
    const everyone = [ADMIN, ...state.reps];
    const other = everyone.find(u => u.id !== myId && rest.includes(u.id));
    if (other) return `@ ${other.name}`;
  }
  return ch;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function scrollToBottom() {
  setTimeout(() => { const a = document.getElementById('messages-area'); if (a) a.scrollTop = a.scrollHeight; }, 40);
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}
function showNotif(msg, type = 'success') {
  document.querySelector('.notif')?.remove();
  const el = document.createElement('div');
  el.className = `notif ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════

// Start app — show login immediately, Firebase loads in background
bootstrap();
