/**
 * app.js — Watch Party dashboard orchestrator
 * ============================================================================
 * INTEGRATION NOTES — read this before changing how modules talk to each
 * other; these are deliberate decisions, not oversights.
 *
 * 1. AUTH BACKEND
 *    Two interchangeable AuthModule implementations were provided (a
 *    Firebase one and a DIY Node+SQLite one) with identical method names
 *    and events. This file imports the Firebase build from './auth.js'.
 *    >>> You must fill in your real Firebase project config inside that
 *        file (the `firebaseConfig` object) before register()/login() will
 *        work. <<<
 *    To use the Node/SQLite backend instead: change the import below to
 *    './auth-nodejs-sqlite.js' and run the included server (see
 *    Auth/nodejs-sqlite/README.md) — no other code in this file changes.
 *
 * 2. CHAT TRANSPORT
 *    sync.js (SyncModule) is a self-contained PeerJS transport that already
 *    manages its own reliable "sync" channel, an unreliable "chat" channel,
 *    and a MediaConnection for screenshare — all over a Peer/connection
 *    pair it owns internally. chat.js's ChatModule, on the other hand, is
 *    built to call `peerConnection.createDataChannel()` directly on a raw
 *    RTCPeerConnection that the *caller* constructs and owns.
 *    SyncModule never hands out that raw RTCPeerConnection (PeerJS wraps
 *    it privately), so ChatModule has no connection to attach to without
 *    forking sync.js. Rather than do that, this file uses SyncModule's own
 *    `broadcastChat()` / `onChatMessage` for the actual wire transport, and
 *    layers the full chat experience (reactions, replies, GIFs) on top in
 *    the ChatUI class below, reusing the `{type, payload}` envelope shape
 *    chat.js itself models. chat.js is still loaded in index.html and is
 *    ready to use as-is the moment a raw-RTCPeerConnection transport
 *    exists (e.g. if sync.js is ever refactored to expose one).
 *
 * 3. SCREENSHARE TRANSPORT
 *    ScreenShareModule (screenshare.js) is used exactly as designed for
 *    this situation: standalone, with no `peerConnection` option, purely
 *    to capture the local display (getDisplayMedia), manage the
 *    high/medium/low quality presets, and monitor bandwidth. The resulting
 *    MediaStream is then handed to `SyncModule.attachScreenshareStream()`,
 *    which performs the actual PeerJS `peer.call()` to send it. The
 *    receiving side gets the remote stream back via
 *    `SyncModule.receiveScreenshareStream(cb)`.
 *
 * 4. video.js / qrcode.js
 *    Not loaded. player.js is a from-scratch player that never references
 *    video.js. sync.js renders its QR code via a hosted image endpoint
 *    (qrCodeUrlFor), so no client-side qrcode.js library is needed either.
 *    hls.js IS loaded (player.js reads `window.Hls` for non-Safari HLS).
 *
 * 5. SYNC LOOP GUARD
 *    TVPlayer emits the same 'play'/'pause'/'seek' events whether the user
 *    clicked a control or SyncModule just applied a remote command through
 *    the playerAdapter. There's no first-class way to tell those apart from
 *    the outside, so a short suppression window (SYNC_ECHO_GUARD_MS) is used
 *    after every incoming sync message to avoid re-broadcasting it right
 *    back to the peer. This mirrors the 800ms drift tolerance sync.js
 *    already uses internally for seek correction.
 * ============================================================================
 */

import { AuthModule } from './auth.js';

const SYNC_ECHO_GUARD_MS = 600;

/* ============================================================================
   Small DOM + storage utilities
   ============================================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatClock(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/disabled */ }
}

/** Toasts double as the app's error-handling surface (network/peer/permission). */
function toast(message, kind = 'info', { id, sticky = false, timeout = 4200 } = {}) {
  const container = $('#toast-container');
  let el = id ? $(`[data-toast-id="${id}"]`, container) : null;
  if (!el) {
    el = document.createElement('div');
    if (id) el.dataset.toastId = id;
    container.appendChild(el);
  }
  el.className = `toast ${kind}`;
  el.textContent = message;
  if (el._timer) clearTimeout(el._timer);
  if (!sticky) {
    el._timer = setTimeout(() => el.remove(), timeout);
  }
  return el;
}
function dismissToast(id) {
  const el = $(`[data-toast-id="${id}"]`);
  if (el) el.remove();
}

/* ============================================================================
   App state
   ============================================================================ */
const state = {
  user: null,
  friends: [],
  dmThreads: [],
  activeDMFriendId: null,
  chatTab: 'party',            // 'party' | 'dm'
  isHost: false,
  remoteUser: null,
  partyConnected: false,
  player: null,                 // TVPlayer instance
  screenShareModule: null,      // ScreenShareModule instance (local capture)
  isSharingScreen: false,
  watchStartedAt: null,
  syncSuppressUntil: 0,
  settings: lsGet('wp_settings', { volume: 100, quality: 'medium', pinChat: true }),
};

/* ============================================================================
   Screen routing: session-splash -> login-screen -> dashboard
   ============================================================================ */
function showOnly(id) {
  ['session-splash', 'login-screen', 'dashboard'].forEach((s) => {
    $(`#${s}`).classList.toggle('hidden', s !== id);
  });
}

/* ============================================================================
   LOGIN / REGISTER SCREEN
   ============================================================================ */
function initAuthScreen() {
  let mode = 'login';

  $$('.auth-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      $$('.auth-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      $('#auth-submit').textContent = mode === 'login' ? 'Log In' : 'Sign Up';
      hideAuthError();
    });
  });

  function showAuthError(msg) {
    const el = $('#auth-error');
    el.textContent = msg;
    el.classList.add('show');
  }
  function hideAuthError() {
    $('#auth-error').classList.remove('show');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();

    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const remember = $('#auth-remember').checked;
    lsSet('wp_remember', remember);
    // NOTE: AuthModule (as shipped) always persists sessions via Firebase's
    // browserLocalPersistence regardless of this flag. True "sign out when
    // the tab closes" behavior would require branching
    // setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence)
    // inside auth.js itself — flagged here rather than faked.

    if (!username || username.length < 3) return showAuthError('Username must be at least 3 characters.');
    if (!password || password.length < 6) return showAuthError('Password must be at least 6 characters.');

    const submitBtn = $('#auth-submit');
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = mode === 'login' ? 'Logging in…' : 'Creating account…';

    try {
      if (mode === 'login') {
        await AuthModule.login(username, password);
      } else {
        await AuthModule.register(username, password);
      }
      // AuthModule fires onLoginSuccess -> enterDashboard(); nothing else to do here.
    } catch (err) {
      showAuthError(err && err.message ? err.message : 'Something went wrong. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  $('#recover-link').addEventListener('click', async () => {
    const username = $('#auth-username').value.trim();
    if (!username) return showAuthError('Enter your username above first, then tap "Forgot your password?" again.');
    try {
      await AuthModule.recoverPassword(username);
      toast('Password reset email sent.', 'success');
    } catch (err) {
      showAuthError(err && err.message ? err.message : 'Could not send a reset email.');
    }
  });
}

/* ============================================================================
   BOOTSTRAP: check localStorage for an active session before deciding which
   screen to show (requirement: land on page -> check localStorage -> route).
   ============================================================================ */
function bootstrap() {
  initAuthScreen();

  AuthModule.onLoginSuccess((user) => enterDashboard(user));

  const hasStoredSession = !!localStorage.getItem('wp_session_token');
  if (hasStoredSession) {
    showOnly('session-splash');
    // Safety net: if the stored token turns out to be invalid, AuthModule's
    // own restore logic won't call onLoginSuccess, so fall back to login
    // after a few seconds instead of leaving the user on a spinner forever.
    setTimeout(() => {
      if (!state.user) {
        localStorage.removeItem('wp_session_token');
        localStorage.removeItem('wp_user_id');
        showOnly('login-screen');
      }
    }, 5000);
  } else {
    showOnly('login-screen');
  }
}

/* ============================================================================
   DASHBOARD
   ============================================================================ */
async function enterDashboard(user) {
  state.user = user;
  showOnly('dashboard');

  $('#profile-username').textContent = user.username;
  $('#profile-avatar').textContent = (user.avatar || user.username.slice(0, 2)).toUpperCase();

  wireHeader();
  wireModals();
  wireWatchPartyControls();
  wireFileLoading();
  wireSettings();

  initPlayer();
  initChatUI();
  initScreenShareUI();
  wireSync();

  await Promise.all([loadFriends(), loadDMThreads()]);

  AuthModule.onFriendOnline((friendId) => setFriendPresence(friendId, true));
  AuthModule.onFriendOffline((friendId) => setFriendPresence(friendId, false));
  AuthModule.onDMReceived((friendId, msg) => handleIncomingDM(friendId, msg));
  AuthModule.onFriendRequestReceived((fromUserId, requestId) => handleIncomingFriendRequest(fromUserId, requestId));
}

/* ---- Header: profile dropdown, logout, status, settings ---- */
function wireHeader() {
  const menu = $('#profile-menu');
  $('#profile-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => menu.classList.add('hidden'));

  $('#menu-status-online').addEventListener('click', () => AuthModule.setStatus('Online').catch(() => {}));
  $('#menu-status-away').addEventListener('click', () => AuthModule.setStatus('Away').catch(() => {}));
  $('#menu-settings').addEventListener('click', () => openModal('settings-modal-overlay'));
  $('#settings-btn').addEventListener('click', () => openModal('settings-modal-overlay'));
  $('#menu-logout').addEventListener('click', async () => {
    try {
      if (state.partyConnected) window.SyncModule.disconnect();
      await AuthModule.logout(); // AuthModule itself redirects to /login.html
    } catch (err) {
      toast('Could not log out cleanly: ' + err.message, 'error');
    }
  });

  $('#chat-toggle-btn').addEventListener('click', () => $('#chat-panel').classList.toggle('open'));
}

/* ---- Generic modal open/close ---- */
function wireModals() {
  $$('.modal-close').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
  $$('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
  });
}
function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

/* ============================================================================
   FRIENDS + DMs (backed by AuthModule; separate from the live P2P party chat)
   ============================================================================ */
async function loadFriends() {
  // Render the cached list immediately so the sidebar isn't empty while the
  // network call resolves, then replace it once real data arrives.
  const cached = lsGet('wp_friends_cache', []);
  if (cached.length) { state.friends = cached; renderFriendList(); }

  try {
    state.friends = await AuthModule.getFriendList();
    lsSet('wp_friends_cache', state.friends);
  } catch (err) {
    toast('Could not load your friend list.', 'error');
  }
  renderFriendList();
}

async function loadDMThreads() {
  try {
    state.dmThreads = await AuthModule.getDMList();
  } catch (err) {
    state.dmThreads = [];
  }
  renderDMList();
}

function renderFriendList() {
  const list = $('#friend-list');
  const query = ($('#friend-search').value || '').toLowerCase();
  const filtered = state.friends.filter((f) => f.username.toLowerCase().includes(query));

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-hint">${state.friends.length ? 'No matches.' : 'No friends yet — add one to start a watch party.'}</div>`;
    return;
  }

  list.innerHTML = filtered.map((f) => `
    <li class="friend-row" data-friend-id="${f.userId}" title="${escapeHTML(f.username)}">
      <span class="avatar sm" style="position:relative;">${escapeHTML((f.avatar || f.username.slice(0, 2)).toUpperCase())}
        <span class="presence-dot ${f.online ? 'online' : ''}"></span>
      </span>
      <span class="friend-name">${escapeHTML(f.username)}</span>
      <button class="icon-btn invite-inline-btn" data-invite-friend="${f.userId}" title="Invite to watch party" style="width:24px;height:24px;">▶</button>
    </li>
  `).join('');

  $$('.friend-row', list).forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.invite-inline-btn')) return;
      openDM(row.dataset.friendId);
    });
  });
  $$('.invite-inline-btn', list).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal('party-modal-overlay');
    });
  });
}

function renderDMList() {
  const list = $('#dm-list');
  if (!state.dmThreads.length) {
    list.innerHTML = `<div class="empty-hint">No conversations yet.</div>`;
    return;
  }
  list.innerHTML = state.dmThreads.map((t) => `
    <li class="dm-row ${state.activeDMFriendId === t.friendId ? 'active' : ''}" data-friend-id="${t.friendId}">
      <span class="avatar sm">${escapeHTML(t.friendUsername.slice(0, 2).toUpperCase())}</span>
      <span class="friend-name">${escapeHTML(t.friendUsername)}</span>
      ${t.unreadCount ? `<span class="unread-badge">${t.unreadCount > 9 ? '9+' : t.unreadCount}</span>` : ''}
    </li>
  `).join('');
  $$('.dm-row', list).forEach((row) => row.addEventListener('click', () => openDM(row.dataset.friendId)));

  const totalUnread = state.dmThreads.reduce((sum, t) => sum + (t.unreadCount || 0), 0);
  $('#chat-fab-badge').textContent = totalUnread > 9 ? '9+' : String(totalUnread);
  $('#chat-fab-badge').classList.toggle('hidden', totalUnread === 0);
}

function setFriendPresence(friendId, online) {
  const f = state.friends.find((x) => x.userId === friendId);
  if (f) f.online = online;
  renderFriendList();
}

async function handleIncomingDM(friendId, msg) {
  const thread = state.dmThreads.find((t) => t.friendId === friendId);
  if (thread) {
    thread.lastMessage = msg.text;
    thread.unreadCount = state.activeDMFriendId === friendId ? 0 : (thread.unreadCount || 0) + 1;
  } else {
    await loadDMThreads();
  }
  renderDMList();
  if (state.activeDMFriendId === friendId && state.chatTab === 'dm') {
    chatUI.renderDMMessage(msg, false);
  } else {
    toast(`New message from a friend`, 'info');
  }
}

function handleIncomingFriendRequest(fromUserId, requestId) {
  const el = toast(`New friend request received.`, 'info', { sticky: true, id: 'friend-req-' + requestId });
  el.style.cursor = 'pointer';
  el.title = 'Click to accept';
  el.addEventListener('click', async () => {
    try {
      await AuthModule.acceptFriendRequest(requestId, fromUserId);
      dismissToast('friend-req-' + requestId);
      toast('Friend request accepted.', 'success');
      loadFriends();
    } catch (err) {
      toast('Could not accept request: ' + err.message, 'error');
    }
  });
}

$('#friend-search').addEventListener('input', renderFriendList);

$('#add-friend-btn').addEventListener('click', () => openModal('add-friend-modal-overlay'));
$('#send-friend-request-btn').addEventListener('click', async () => {
  const input = $('#add-friend-input');
  const errEl = $('#add-friend-error');
  errEl.classList.remove('show');
  const username = input.value.trim();
  if (!username) return;
  try {
    await AuthModule.addFriend(username);
    toast(`Friend request sent to ${username}.`, 'success');
    input.value = '';
    closeModal('add-friend-modal-overlay');
  } catch (err) {
    errEl.textContent = err.message || 'Could not send request.';
    errEl.classList.add('show');
  }
});

async function openDM(friendId) {
  state.activeDMFriendId = friendId;
  state.chatTab = 'dm';
  setChatTab('dm');
  $('#chat-panel').classList.add('open'); // no-op on desktop, opens overlay on tablet/mobile
  renderDMList();

  const thread = state.dmThreads.find((t) => t.friendId === friendId);
  if (thread) thread.unreadCount = 0;
  try { await AuthModule.markDMRead(friendId); } catch (e) {}
  try { AuthModule.subscribeToDM(friendId); } catch (e) {}

  chatUI.clearDMView();
  try {
    const history = await AuthModule.getDMHistory(friendId);
    history.forEach((m) => chatUI.renderDMMessage(m, m.from === state.user.userId));
  } catch (err) {
    toast('Could not load conversation history.', 'error');
  }
}

/* ============================================================================
   PLAYER — wraps TVPlayer (player.js) and exposes the small adapter shape
   SyncModule expects: { getCurrentTime, play, pause, seek, selectSubtitleTrack }
   ============================================================================ */
function initPlayer() {
  const player = new window.TVPlayer($('#player-container'), {
    startVolume: (state.settings.volume ?? 100) / 100,
  });
  state.player = player;

  player.on('error', (msg) => toast(msg, 'error'));

  player.on('play', () => {
    $('#player-empty').classList.add('hidden');
    if (state.partyConnected && Date.now() > state.syncSuppressUntil) {
      window.SyncModule.broadcastSync('play', { time: player.getCurrentTime() });
    }
  });
  player.on('pause', () => {
    if (state.partyConnected && Date.now() > state.syncSuppressUntil) {
      window.SyncModule.broadcastSync('pause', { time: player.getCurrentTime() });
    }
  });
  player.on('seek', (time) => {
    if (state.partyConnected && Date.now() > state.syncSuppressUntil) {
      window.SyncModule.broadcastSync('seek', { time });
    }
  });
  player.on('timeupdate', (current) => {
    $('#video-sub').textContent = `${formatClock(current)} watched`;
  });
}

function wireFileLoading() {
  $('#local-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.player.loadSource({ file });
    $('#video-title').textContent = file.name;
    $('#player-empty').classList.add('hidden');
    state.watchStartedAt = Date.now();
  });
}

/* ============================================================================
   SYNC — host/join a watch party over SyncModule (PeerJS)
   ============================================================================ */
function wireSync() {
  const Sync = window.SyncModule;
  Sync.init(false, state.user, { playerAdapter: state.player });

  Sync.onConnected = (remoteUser) => {
    state.partyConnected = true;
    state.remoteUser = remoteUser;
    $('#watch-title-text').textContent = remoteUser ? `Watching with ${remoteUser.username}` : 'Watching with a friend';
    $('#party-pulse').classList.add('live');
    $('#end-party-btn').classList.remove('hidden');
    $('#player-frame').classList.add('synced');
    closeModal('party-modal-overlay');
    toast('Connected!', 'success');
  };

  Sync.onDisconnected = () => {
    if (!state.partyConnected) return; // avoid a spurious toast before the first connection
    state.partyConnected = false;
    $('#party-pulse').classList.remove('live');
    $('#player-frame').classList.remove('synced');
    toast('Connection lost, reconnecting…', 'warning', { id: 'sync-status', sticky: true });
  };

  Sync.onReconnecting = (attempt, max, secondsLeft) => {
    toast(`Connection lost, reconnecting… (attempt ${attempt}/${max}, retrying in ${secondsLeft}s)`, 'warning', { id: 'sync-status', sticky: true });
  };

  Sync.onStatusChange = (status) => {
    if (status === 'connected') dismissToast('sync-status');
  };

  Sync.onError = (message) => toast(message, 'error');

  Sync.onSyncMessage = (type) => {
    if (type === 'play' || type === 'pause' || type === 'seek') {
      state.syncSuppressUntil = Date.now() + SYNC_ECHO_GUARD_MS;
    }
  };

  Sync.onChatMessage = (msg) => chatUI.handlePartyMessage(msg, false);

  Sync.onScreenshareStarted = (stream) => screenShareUI.showRemote(stream);
  Sync.onScreenshareEnded = () => screenShareUI.hideRemote();
}

function wireWatchPartyControls() {
  $('#invite-friend-btn').addEventListener('click', () => openModal('party-modal-overlay'));

  $$('.modal-tabs [data-party-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.modal-tabs [data-party-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      $('#party-tab-host').classList.toggle('hidden', btn.dataset.partyTab !== 'host');
      $('#party-tab-join').classList.toggle('hidden', btn.dataset.partyTab !== 'join');
    });
  });

  $('#start-host-btn').addEventListener('click', async () => {
    $('#start-host-btn').disabled = true;
    try {
      const { peerId, qrCodeUrl } = await window.SyncModule.connectAsHost();
      state.isHost = true;
      $('#host-peer-code').textContent = peerId;
      $('#host-qr').src = qrCodeUrl;
      $('#host-code-wrap').classList.remove('hidden');
    } catch (err) {
      toast('Failed to start the watch party, try again.', 'error');
    } finally {
      $('#start-host-btn').disabled = false;
    }
  });

  $('#join-party-btn').addEventListener('click', async () => {
    const code = $('#join-code-input').value.trim();
    if (!code) return;
    $('#join-party-btn').disabled = true;
    try {
      await window.SyncModule.connectAsPeer(code);
      state.isHost = false;
    } catch (err) {
      toast('Failed to connect to peer, try again.', 'error');
    } finally {
      $('#join-party-btn').disabled = false;
    }
  });

  $('#end-party-btn').addEventListener('click', () => {
    window.SyncModule.disconnect();
    if (state.isSharingScreen) screenShareUI.stop();
    state.partyConnected = false;
    state.isHost = false;
    $('#watch-title-text').textContent = 'No one watching yet';
    $('#party-pulse').classList.remove('live');
    $('#player-frame').classList.remove('synced');
    $('#end-party-btn').classList.add('hidden');
  });
}

/* ============================================================================
   CHAT UI — party chat (live P2P via SyncModule) + direct messages
   (persistent, via AuthModule). See integration note #2 at the top of this
   file for why this doesn't instantiate ChatModule directly.
   ============================================================================ */
const EMOJI_SET = ['😀','😂','😍','😎','🤔','😢','😡','👍','👎','🎉','🔥','❤️','😱','🙌','👀','💀','🍿','😴','🤝','🙏','😅','🥳','😭','👏'];

const chatUI = {
  replyTarget: null,

  init() {
    setChatTab('party');
    $('#tab-party').addEventListener('click', () => setChatTab('party'));
    $('#tab-dm').addEventListener('click', () => setChatTab('dm'));

    $('#chat-pin-toggle').addEventListener('click', () => {
      state.settings.pinChat = !state.settings.pinChat;
      $('#pin-chat-toggle').checked = state.settings.pinChat;
      lsSet('wp_settings', state.settings);
      applyChatPinPreference();
    });
    applyChatPinPreference();

    const textarea = $('#chat-input');
    const sendBtn = $('#chat-send-btn');
    textarea.addEventListener('input', () => {
      sendBtn.disabled = !textarea.value.trim();
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 90) + 'px';
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    sendBtn.addEventListener('click', () => this.send());

    $('#reply-cancel').addEventListener('click', () => this.clearReply());

    // Emoji picker (inserts into the text input rather than sending directly)
    const grid = $('#emoji-grid');
    grid.innerHTML = EMOJI_SET.map((e) => `<button type="button">${e}</button>`).join('');
    $('#emoji-btn').addEventListener('click', () => togglePanel('emoji-panel'));
    grid.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      textarea.value += e.target.textContent;
      textarea.dispatchEvent(new Event('input'));
      textarea.focus();
    });

    // GIF panel — paste-a-link approach (see index.html comment for why:
    // no GIF-search API key is available in this environment).
    $('#gif-btn').addEventListener('click', () => togglePanel('gif-panel'));
    $('#gif-url-input').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const url = e.target.value.trim();
      if (!url) return;
      this.sendGif(url);
      e.target.value = '';
      togglePanel('gif-panel', false);
    });

    // Mobile: FAB opens the overlay chat panel; swipe down/up minimizes/maximizes.
    $('#chat-fab').addEventListener('click', () => {
      $('#chat-panel').classList.add('open');
      $('#chat-panel').classList.remove('minimized');
    });
    wireMobileSwipe();
  },

  send() {
    const textarea = $('#chat-input');
    const text = textarea.value.trim();
    if (!text) return;
    const envelope = {
      type: 'message',
      id: uid(),
      from: { userId: state.user.userId, username: state.user.username },
      payload: { text, replyTo: this.replyTarget ? { id: this.replyTarget.id, snippet: this.replyTarget.snippet } : null },
      ts: Date.now(),
    };

    if (state.chatTab === 'party') {
      if (!state.partyConnected) { toast('Start or join a watch party first.', 'warning'); return; }
      window.SyncModule.broadcastChat(envelope);
      this.handlePartyMessage(envelope, true); // optimistic local echo
    } else {
      if (!state.activeDMFriendId) { toast('Pick a friend to message first.', 'warning'); return; }
      AuthModule.sendDM(state.activeDMFriendId, text).catch(() => toast('Message failed to send.', 'error'));
      this.renderDMMessage({ from: state.user.userId, text, timestamp: { seconds: Date.now() / 1000 } }, true);
    }

    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
    this.clearReply();
  },

  sendGif(url) {
    const envelope = {
      type: 'gif', id: uid(),
      from: { userId: state.user.userId, username: state.user.username },
      payload: { url }, ts: Date.now(),
    };
    if (state.chatTab === 'party' && state.partyConnected) {
      window.SyncModule.broadcastChat(envelope);
      this.handlePartyMessage(envelope, true);
    } else {
      toast('GIFs are sent in Party Chat during an active watch party.', 'info');
    }
  },

  react(messageEl, emoji) {
    messageEl.reactions = messageEl.reactions || {};
    messageEl.reactions[emoji] = (messageEl.reactions[emoji] || 0) + 1;
    this.paintReactions(messageEl);
    if (state.partyConnected) {
      window.SyncModule.broadcastChat({ type: 'reaction', id: uid(), payload: { targetId: messageEl.dataset.msgId, emoji }, ts: Date.now() });
    }
  },

  startReply(id, snippet) {
    this.replyTarget = { id, snippet };
    $('#reply-preview').classList.remove('hidden');
    $('#reply-preview-text').textContent = `Replying to: “${snippet.slice(0, 60)}”`;
    $('#chat-input').focus();
  },
  clearReply() {
    this.replyTarget = null;
    $('#reply-preview').classList.add('hidden');
  },

  /** Renders + tracks a party-chat message (either local echo or peer-received). */
  handlePartyMessage(envelope, mine) {
    if (state.chatTab !== 'party') return this._bumpFabBadge();
    $('#chat-empty').remove?.();

    if (envelope.type === 'reaction') {
      const target = $(`.msg[data-msg-id="${envelope.payload.targetId}"]`);
      if (target) this.react(target, envelope.payload.emoji);
      return;
    }

    const container = $('#chat-messages');
    const row = document.createElement('div');
    row.className = `msg ${mine ? 'mine' : ''}`;
    row.dataset.msgId = envelope.id;

    const who = mine ? 'You' : (envelope.from?.username || 'Friend');
    const time = new Date(envelope.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let bodyHtml;
    if (envelope.type === 'gif') {
      bodyHtml = `<div class="msg-bubble msg-gif"><img src="${escapeHTML(envelope.payload.url)}" alt="GIF" loading="lazy" /></div>`;
    } else {
      const replyHtml = envelope.payload.replyTo
        ? `<div class="msg-reply-quote">${escapeHTML(envelope.payload.replyTo.snippet.slice(0, 80))}</div>` : '';
      bodyHtml = `<div class="msg-bubble">${replyHtml}${escapeHTML(envelope.payload.text)}</div>`;
    }

    row.innerHTML = `
      <div class="msg-meta"><span>${escapeHTML(who)}</span><span>${time}</span></div>
      ${bodyHtml}
      <div class="msg-reactions"></div>
      <div class="msg-hover-actions">
        <button data-act="reply" title="Reply">↩</button>
        <button data-act="react" data-emoji="👍">👍</button>
        <button data-act="react" data-emoji="😂">😂</button>
        <button data-act="react" data-emoji="❤️">❤️</button>
      </div>
    `;
    $$('button[data-act="react"]', row).forEach((btn) => {
      btn.addEventListener('click', () => this.react(row, btn.dataset.emoji));
    });
    const replyBtn = $('button[data-act="reply"]', row);
    if (replyBtn) {
      replyBtn.addEventListener('click', () => {
        const snippet = envelope.type === 'gif' ? '[GIF]' : envelope.payload.text;
        this.startReply(envelope.id, snippet);
      });
    }

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    if (!mine) this._bumpFabBadge();
  },

  paintReactions(row) {
    const el = $('.msg-reactions', row);
    el.innerHTML = Object.entries(row.reactions).map(([emoji, count]) => `<span>${emoji} ${count}</span>`).join('');
  },

  clearDMView() {
    $('#chat-messages').innerHTML = '';
  },

  renderDMMessage(msg, mine) {
    if (state.chatTab !== 'dm') return;
    const container = $('#chat-messages');
    const row = document.createElement('div');
    row.className = `msg ${mine ? 'mine' : ''}`;
    const time = msg.timestamp?.seconds
      ? new Date(msg.timestamp.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    row.innerHTML = `
      <div class="msg-meta"><span>${mine ? 'You' : 'Friend'}</span><span>${time}</span></div>
      <div class="msg-bubble">${escapeHTML(msg.text)}</div>
    `;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  },

  _bumpFabBadge() {
    if (window.innerWidth >= 600) return;
    const badge = $('#chat-fab-badge');
    const n = (parseInt(badge.textContent, 10) || 0) + 1;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.classList.remove('hidden');
  },
};

function initChatUI() { chatUI.init(); }

function setChatTab(tab) {
  state.chatTab = tab;
  $('#tab-party').classList.toggle('active', tab === 'party');
  $('#tab-dm').classList.toggle('active', tab === 'dm');
  $('#chat-messages').innerHTML = '';
  if (tab === 'party') {
    $('#chat-messages').innerHTML = '<div class="chat-empty" id="chat-empty">No messages yet. Say hi 👋</div>';
  } else if (state.activeDMFriendId) {
    openDM(state.activeDMFriendId);
  } else {
    $('#chat-messages').innerHTML = '<div class="chat-empty">Pick a friend on the left to start a conversation.</div>';
  }
}

function togglePanel(id, force) {
  const el = $(`#${id}`);
  const show = force !== undefined ? force : el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
}

function applyChatPinPreference() {
  // "Pinned" vs "floating" only makes a visual difference on desktop, where
  // the chat panel already lives in the grid; floating just detaches it
  // into a draggable-feeling corner card instead of a fixed grid column.
  const panel = $('#chat-panel');
  const pinned = state.settings.pinChat;
  panel.style.position = pinned || window.innerWidth < 1200 ? '' : 'fixed';
  if (!pinned && window.innerWidth >= 1200) {
    panel.style.right = '18px';
    panel.style.bottom = '18px';
    panel.style.top = 'auto';
    panel.style.height = '60vh';
    panel.style.borderRadius = '14px';
    panel.style.border = '1px solid var(--border)';
  } else {
    panel.style.right = panel.style.bottom = panel.style.top = panel.style.height = panel.style.borderRadius = '';
  }
}

/* ---- Mobile swipe-to-minimize/maximize on the chat overlay ---- */
function wireMobileSwipe() {
  const handle = $('#chat-swipe-handle');
  const panel = $('#chat-panel');
  let startY = 0, dragging = false;

  handle.addEventListener('touchstart', (e) => {
    dragging = true;
    startY = e.touches[0].clientY;
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 40) panel.classList.add('minimized');
    else if (dy < -20) panel.classList.remove('minimized');
  }, { passive: true });

  handle.addEventListener('touchend', () => { dragging = false; });
}

/* ============================================================================
   SCREENSHARE UI — capture via ScreenShareModule, transport via SyncModule.
   See integration note #3 at the top of this file.
   ============================================================================ */
const screenShareUI = {
  init() {
    const module = new window.ScreenShareModule({ quality: state.settings.quality || 'medium', audio: false });
    state.screenShareModule = module;

    module.onScreenShareStart = (stream) => {
      state.isSharingScreen = true;
      $('#ss-preview').classList.remove('hidden');
      $('#ss-preview-label').textContent = 'You are sharing';
      $('#ss-preview-video').srcObject = stream;
      $('#ss-stop-btn').classList.remove('hidden');
      window.SyncModule.attachScreenshareStream(stream);
      $('#share-screen-btn').textContent = '⏹️ Stop Sharing';
    };
    module.onScreenShareStop = () => {
      state.isSharingScreen = false;
      if (!this._remoteActive) $('#ss-preview').classList.add('hidden');
      $('#ss-preview-video').srcObject = null;
      $('#share-screen-btn').innerHTML = '🖥️ <span class="long">Share Screen</span>';
      window.SyncModule.stopScreenshare();
    };
    module.onError = (msg) => toast(msg, 'error'); // permission denied / unsupported / etc, already friendly text
    module.onBandwidthWarning = () => toast('Your connection is struggling — lowering screen share quality.', 'warning');
    module.onQualityChange = (level) => { /* could reflect into #quality-select if desired */ };

    $('#share-screen-btn').addEventListener('click', () => {
      if (state.isSharingScreen) { module.stop(); return; }
      if (!state.partyConnected) { toast('Start or join a watch party before sharing your screen.', 'warning'); return; }
      const unsupported = module.getUnsupportedReason();
      if (unsupported) { toast(unsupported, 'error'); return; }
      module.start(state.settings.quality || 'medium');
    });

    $('#ss-stop-btn').addEventListener('click', () => module.stop());
    $('#ss-minimize-btn').addEventListener('click', () => $('#ss-preview').classList.toggle('minimized'));

    wireDragForPreview();
  },

  showRemote(stream) {
    this._remoteActive = true;
    $('#ss-preview').classList.remove('hidden');
    $('#ss-preview-label').textContent = state.remoteUser ? `${state.remoteUser.username} is sharing` : 'Friend is sharing';
    $('#ss-preview-video').srcObject = stream;
    $('#ss-stop-btn').classList.add('hidden'); // only the sharer can stop their own share
  },
  hideRemote() {
    this._remoteActive = false;
    if (!state.isSharingScreen) {
      $('#ss-preview').classList.add('hidden');
      $('#ss-preview-video').srcObject = null;
    }
  },

  stop() {
    if (state.screenShareModule) state.screenShareModule.stop();
  },
};

function initScreenShareUI() { screenShareUI.init(); }

/** Drag-to-move for the floating preview — desktop only, per the spec
 *  (tablet/mobile keep a fixed corner position given the smaller viewport). */
function wireDragForPreview() {
  const el = $('#ss-preview');
  const head = $('#ss-preview-head');
  let offsetX = 0, offsetY = 0, dragging = false;

  const saved = lsGet('wp_screenshare_pos', null);
  if (saved && window.innerWidth >= 1200) {
    el.style.left = saved.x + 'px';
    el.style.top = saved.y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }

  head.addEventListener('pointerdown', (e) => {
    if (window.innerWidth < 1200) return; // fixed corner position on tablet/mobile
    dragging = true;
    const rect = el.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const x = Math.min(Math.max(0, e.clientX - offsetX), window.innerWidth - el.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - offsetY), window.innerHeight - el.offsetHeight);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  head.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    const rect = el.getBoundingClientRect();
    lsSet('wp_screenshare_pos', { x: rect.left, y: rect.top });
  });
}

/* ============================================================================
   SETTINGS MODAL
   ============================================================================ */
function wireSettings() {
  $('#volume-slider').value = state.settings.volume ?? 100;
  $('#pin-chat-toggle').checked = state.settings.pinChat !== false;
  $('#quality-select').value = state.settings.quality || 'medium';

  $('#volume-slider').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.settings.volume = v;
    lsSet('wp_settings', state.settings);
    if (state.player) state.player.setVolume(v / 100);
  });

  $('#pin-chat-toggle').addEventListener('change', (e) => {
    state.settings.pinChat = e.target.checked;
    lsSet('wp_settings', state.settings);
    applyChatPinPreference();
  });

  $('#quality-select').addEventListener('change', (e) => {
    state.settings.quality = e.target.value;
    lsSet('wp_settings', state.settings);
    if (state.screenShareModule && state.isSharingScreen) {
      state.screenShareModule.setQuality(e.target.value);
    }
  });
}

/* ============================================================================
   GO
   ============================================================================ */
bootstrap();
