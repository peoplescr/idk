/**
 * auth-client.js — front-end AuthModule for the DIY Node + SQLite backend.
 * Same method names and events as the Firebase auth.js, so the dashboard
 * HTML/JS can be reused unchanged against either backend.
 */

// >>> REQUIRED: set window.WP_BACKEND_URL in index.html (before this
// script loads) to your deployed backend's URL, e.g.
// "https://watchparty-server.onrender.com". Falls back to localhost for
// local development against `npm start` in the server folder. <<<
const BACKEND_URL = (window.WP_BACKEND_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_BASE = `${BACKEND_URL}/api`;
const WS_URL = BACKEND_URL.replace(/^http/, "ws") + "/ws";

const listeners = {
  loginSuccess: [],
  friendOnline: [],
  friendOffline: [],
  dmReceived: [],
  friendRequestReceived: [],
};
function emit(event, ...args) {
  (listeners[event] || []).forEach((cb) => {
    try { cb(...args); } catch (err) { console.error(`AuthModule listener error (${event}):`, err); }
  });
}

let currentUser = null;
let socket = null;

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function authHeaders() {
  const token = localStorage.getItem("wp_session_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch(path, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed.");
      return data;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        throw new Error(err.message || "Server is waking up, please try again in a moment.");
      }
    }
  }
}

function connectSocket(token) {
  socket = new WebSocket(WS_URL);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "friend_online") emit("friendOnline", msg.friendId);
    else if (msg.type === "friend_offline") emit("friendOffline", msg.friendId);
    else if (msg.type === "dm_received") emit("dmReceived", msg.fromFriendId, msg.message);
    else if (msg.type === "friend_request_received") emit("friendRequestReceived", msg.fromUserId);
  });
  socket.addEventListener("close", () => setTimeout(() => { if (currentUser) connectSocket(token); }, 2000));
}

async function loadCurrentUser() {
  const profile = await apiFetch("/me");
  currentUser = profile;
  return profile;
}

// Wake up the backend server immediately on page load (Render free tier sleeps
// after ~15 min of inactivity and takes up to 10s to start responding).
fetch(`${API_BASE}/health`).catch(() => {});

// Auto-login on page load if a session token is already stored.
(async function restoreSession() {
  const token = localStorage.getItem("wp_session_token");
  if (!token) return;
  try {
    await loadCurrentUser();
    connectSocket(token);
    emit("loginSuccess", currentUser);
  } catch {
    localStorage.removeItem("wp_session_token");
    localStorage.removeItem("wp_user_id");
  }
})();

export const AuthModule = {
  async register(username, password) {
    const passwordHash = await hashPassword(password);
    const { userId, token } = await apiFetch("/register", {
      method: "POST",
      body: JSON.stringify({ username, passwordHash }),
    });
    localStorage.setItem("wp_session_token", token);
    localStorage.setItem("wp_user_id", userId);
    await loadCurrentUser();
    connectSocket(token);
    emit("loginSuccess", currentUser);
    return { userId, token };
  },

  async login(username, password) {
    const passwordHash = await hashPassword(password);
    const { userId, token } = await apiFetch("/login", {
      method: "POST",
      body: JSON.stringify({ username, passwordHash }),
    });
    localStorage.setItem("wp_session_token", token);
    localStorage.setItem("wp_user_id", userId);
    await loadCurrentUser();
    connectSocket(token);
    emit("loginSuccess", currentUser);
    return { userId, token };
  },

  async recoverPassword(username) {
    return apiFetch("/recover", { method: "POST", body: JSON.stringify({ username }) });
  },

  async logout() {
    try { await apiFetch("/logout", { method: "POST" }); } catch {}
    if (socket) socket.close();
    localStorage.removeItem("wp_session_token");
    localStorage.removeItem("wp_user_id");
    currentUser = null;
    window.location.href = "/login.html";
  },

  getCurrentUser() {
    return currentUser;
  },

  async updateProfile({ avatar, bio } = {}) {
    await apiFetch("/me", { method: "PATCH", body: JSON.stringify({ avatar, bio }) });
    if (avatar !== undefined) currentUser.avatar = avatar;
    if (bio !== undefined) currentUser.bio = bio.slice(0, 100);
  },

  async setStatus(status) {
    await apiFetch("/status", { method: "POST", body: JSON.stringify({ status }) });
    currentUser.status = status;
  },

  async addFriend(usernameOrId) {
    return apiFetch("/friends/request", { method: "POST", body: JSON.stringify({ usernameOrId }) });
  },

  async getIncomingRequests() {
    return apiFetch("/friends/requests");
  },

  async acceptFriendRequest(requestId) {
    return apiFetch("/friends/accept", { method: "POST", body: JSON.stringify({ requestId }) });
  },

  async rejectFriendRequest(requestId) {
    return apiFetch("/friends/reject", { method: "POST", body: JSON.stringify({ requestId }) });
  },

  async removeFriend(friendId) {
    return apiFetch(`/friends/${friendId}`, { method: "DELETE" });
  },

  async blockUser(friendId) {
    return apiFetch(`/friends/${friendId}/block`, { method: "POST" });
  },

  async unblockUser(friendId) {
    return apiFetch(`/friends/${friendId}/unblock`, { method: "POST" });
  },

  async getFriendList() {
    return apiFetch("/friends");
  },

  async sendDM(friendId, message) {
    return apiFetch(`/dm/${friendId}`, { method: "POST", body: JSON.stringify({ message }) });
  },

  async getDMHistory(friendId) {
    return apiFetch(`/dm/${friendId}`);
  },

  async getDMList() {
    return apiFetch("/dm");
  },

  async markDMRead(friendId) {
    return apiFetch(`/dm/${friendId}/read`, { method: "POST" });
  },

  subscribeToDM() {
    // No-op: the WebSocket connection already pushes dm_received globally.
  },

  onLoginSuccess(cb) { listeners.loginSuccess.push(cb); },
  onFriendOnline(cb) { listeners.friendOnline.push(cb); },
  onFriendOffline(cb) { listeners.friendOffline.push(cb); },
  onDMReceived(cb) { listeners.dmReceived.push(cb); },
  onFriendRequestReceived(cb) { listeners.friendRequestReceived.push(cb); },
};
