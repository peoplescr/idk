/**
 * sync.js
 * ------------------------------------------------------------------------
 * Vanilla JavaScript PeerJS sync module.
 *
 * Provides four independent channels over a single PeerJS connection pair:
 *   - "sync"        reliable DataConnection  -> video/subtitle sync
 *   - "chat"        unreliable DataConnection -> chat, reactions, typing
 *   - "auth"        reliable DataConnection  -> user info exchange
 *   - screenshare   MediaConnection (peer.call) -> video stream
 *
 * Depends on the PeerJS client library being loaded on the page:
 *   <script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
 *
 * No build step, no bundler. Attach as a plain <script src="sync.js"></script>
 * and use the global `SyncModule`.
 * ------------------------------------------------------------------------
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------
  var CHANNEL = {
    SYNC: 'sync',
    CHAT: 'chat',
    AUTH: 'auth'
  };

  var STATUS = {
    CONNECTED: 'connected',
    CONNECTING: 'connecting',
    DISCONNECTED: 'disconnected'
  };

  var MAX_RETRIES = 5;
  var RETRY_WINDOW_MS = 30000; // spread 5 retries across 30s
  var RETRY_INTERVAL_MS = RETRY_WINDOW_MS / MAX_RETRIES; // 6s apart
  var SYNC_DRIFT_TOLERANCE_MS = 800;

  // ------------------------------------------------------------------
  // Small UUID v4 generator (used as a friendly session label; PeerJS
  // also assigns its own id, but we let the host request this one so
  // the displayed code is short + shareable if desired).
  // ------------------------------------------------------------------
  function uuidv4() {
    if (global.crypto && global.crypto.randomUUID) {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function qrCodeUrlFor(text) {
    // Uses a free public QR rendering endpoint so no extra dependency
    // is required. Swap this out for a bundled QR library if the app
    // needs to work fully offline.
    return (
      'https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=' +
      encodeURIComponent(text)
    );
  }

  function safeParse(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Module factory
  // ------------------------------------------------------------------
  function createSyncModule() {
    var peer = null;
    var isHost = false;
    var currentUser = null;
    var remoteUser = null;
    var remotePeerId = null;
    var hostPeerIdTarget = null; // used by peer to reconnect

    var conns = {
      sync: null,
      chat: null,
      auth: null
    };

    var mediaConn = null; // outgoing/incoming screenshare call
    var localScreenStream = null;
    var pendingScreenStream = null; // queued if attach called before conn ready

    var status = STATUS.DISCONNECTED;
    var retryCount = 0;
    var retryTimer = null;
    var retryCountdownTimer = null;
    var manualDisconnect = false;

    var listeners = {
      onConnected: null,
      onDisconnected: null,
      onSyncMessage: null,
      onChatMessage: null,
      onScreenshareStarted: null,
      onScreenshareEnded: null,
      onError: null,
      onReconnecting: null, // (attempt, maxAttempts, secondsUntilNextTry)
      onStatusChange: null // (status)
    };

    var onScreenshareReceivedCb = null;

    // ------------------------------------------------------------
    // Utility: event emission with try/catch so a bad consumer
    // callback can never break the module's internal state.
    // ------------------------------------------------------------
    function emit(name) {
      var args = Array.prototype.slice.call(arguments, 1);
      var cb = listeners[name];
      if (typeof cb === 'function') {
        try {
          cb.apply(null, args);
        } catch (err) {
          console.error('[SyncModule] listener "' + name + '" threw:', err);
        }
      }
    }

    function setStatus(next) {
      if (status === next) return;
      status = next;
      emit('onStatusChange', status);
    }

    function reportError(message, err) {
      console.error('[SyncModule]', message, err || '');
      emit('onError', message);
    }

    // ------------------------------------------------------------
    // Peer bootstrap
    // ------------------------------------------------------------
    function ensurePeerJsLoaded() {
      if (typeof global.Peer === 'undefined') {
        reportError(
          'PeerJS library not found. Include the peerjs script tag before sync.js.'
        );
        return false;
      }
      return true;
    }

    function createPeer(explicitId) {
      var config = {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
              urls: 'turn:free.expressturn.com:3478',
              username: '000000002098556583',
              credential: 'vY7bgrqKJXCQQnQuuJWxEcstAoQ='
            }
          ]
        }
      };
      return explicitId ? new global.Peer(explicitId, config) : new global.Peer(config);
    }

    // ------------------------------------------------------------
    // Data channel wiring (shared by host + peer sides)
    // ------------------------------------------------------------
    function wireDataConnection(conn) {
      var label = conn.label;

      conn.on('open', function () {
        conns[label] = conn;

        if (label === CHANNEL.AUTH && currentUser) {
          sendOn(CHANNEL.AUTH, { userId: currentUser.userId, username: currentUser.username, avatar: currentUser.avatar, status: 'online' });
        }

        maybeAnnounceConnected();

        // Flush any screenshare stream that was requested before the
        // connection existed.
        if (label === CHANNEL.SYNC && pendingScreenStream) {
          startScreenCall(pendingScreenStream);
          pendingScreenStream = null;
        }
      });

      conn.on('data', function (raw) {
        var msg = typeof raw === 'string' ? safeParse(raw) : raw;
        if (!msg || typeof msg !== 'object') {
          reportError('Received malformed message on "' + label + '" channel.');
          return;
        }
        routeMessage(label, msg);
      });

      conn.on('close', function () {
        conns[label] = null;
        handleChannelDrop(label);
      });

      conn.on('error', function (err) {
        reportError('Data channel "' + label + '" error.', err);
      });
    }

    function routeMessage(label, msg) {
      if (label === CHANNEL.SYNC) {
        handleIncomingSync(msg);
      } else if (label === CHANNEL.CHAT) {
        emit('onChatMessage', msg);
      } else if (label === CHANNEL.AUTH) {
        remoteUser = msg;
        maybeAnnounceConnected();
      }
    }

    // Video sync ships {type, data:{time, trackIndex}}. We surface the
    // raw event to the consumer via onSyncMessage, AND perform the
    // 800ms drift auto-correction contract described in the spec when
    // a getCurrentTime hook has been supplied via init options.
    function handleIncomingSync(msg) {
      var type = msg.type;
      var data = msg.data || {};

      if ((type === 'play' || type === 'seek') && typeof data.time === 'number' && playerAdapter && typeof playerAdapter.getCurrentTime === 'function') {
        var localTime = playerAdapter.getCurrentTime();
        var driftMs = Math.abs(localTime - data.time) * 1000;
        if (driftMs > SYNC_DRIFT_TOLERANCE_MS && typeof playerAdapter.seek === 'function') {
          playerAdapter.seek(data.time);
        }
      }

      if (type === 'play' && playerAdapter && typeof playerAdapter.play === 'function') {
        playerAdapter.play();
      } else if (type === 'pause' && playerAdapter && typeof playerAdapter.pause === 'function') {
        playerAdapter.pause();
      } else if (type === 'seek' && playerAdapter && typeof playerAdapter.seek === 'function') {
        playerAdapter.seek(data.time);
      } else if (type === 'subtitleTrack' && playerAdapter && typeof playerAdapter.selectSubtitleTrack === 'function') {
        playerAdapter.selectSubtitleTrack(data.trackIndex);
      }

      emit('onSyncMessage', type, data);
    }

    function maybeAnnounceConnected() {
      // "Connected" fires once the sync channel (our critical channel)
      // is open. Chat/auth are independent and may arrive slightly
      // later without blocking the connected state.
      if (conns[CHANNEL.SYNC] && status !== STATUS.CONNECTED) {
        setStatus(STATUS.CONNECTED);
        retryCount = 0;
        clearRetryTimers();
        emit('onConnected', remoteUser);
      }
    }

    function handleChannelDrop(label) {
      if (label !== CHANNEL.SYNC) return; // chat/auth dropping doesn't tear down the session
      if (status === STATUS.DISCONNECTED) return;

      setStatus(STATUS.DISCONNECTED);
      emit('onDisconnected');

      if (!manualDisconnect && !isHost && hostPeerIdTarget) {
        beginReconnectLoop();
      }
    }

    // ------------------------------------------------------------
    // Reconnect logic (peer side): up to 5 attempts over 30s
    // ------------------------------------------------------------
    function clearRetryTimers() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (retryCountdownTimer) { clearInterval(retryCountdownTimer); retryCountdownTimer = null; }
    }

    function beginReconnectLoop() {
      clearRetryTimers();
      retryCount = 0;
      attemptReconnect();
    }

    function attemptReconnect() {
      if (manualDisconnect) return;
      if (retryCount >= MAX_RETRIES) {
        reportError('Failed to reconnect after ' + MAX_RETRIES + ' attempts.');
        return;
      }

      retryCount += 1;
      var secondsLeft = Math.round(RETRY_INTERVAL_MS / 1000);
      emit('onReconnecting', retryCount, MAX_RETRIES, secondsLeft);

      retryCountdownTimer = setInterval(function () {
        secondsLeft -= 1;
        if (secondsLeft > 0) {
          emit('onReconnecting', retryCount, MAX_RETRIES, secondsLeft);
        } else {
          clearInterval(retryCountdownTimer);
        }
      }, 1000);

      setStatus(STATUS.CONNECTING);

      try {
        openPeerChannels(hostPeerIdTarget);
      } catch (err) {
        reportError('Reconnect attempt ' + retryCount + ' failed to start.', err);
      }

      retryTimer = setTimeout(function () {
        if (status !== STATUS.CONNECTED) {
          attemptReconnect();
        }
      }, RETRY_INTERVAL_MS);
    }

    // ------------------------------------------------------------
    // Screenshare (MediaConnection) wiring
    // ------------------------------------------------------------
    function startScreenCall(stream) {
      if (!peer || !remotePeerId) {
        pendingScreenStream = stream;
        return;
      }
      localScreenStream = stream;
      mediaConn = peer.call(remotePeerId, stream, { metadata: { kind: 'screenshare' } });
      wireMediaConnection(mediaConn, true);
    }

    function wireMediaConnection(call, isOutgoing) {
      call.on('stream', function (remoteStream) {
        if (!isOutgoing) {
          emit('onScreenshareStarted', remoteStream);
          if (typeof onScreenshareReceivedCb === 'function') {
            onScreenshareReceivedCb(remoteStream);
          }
        }
      });
      call.on('close', function () {
        emit('onScreenshareEnded');
        mediaConn = null;
      });
      call.on('error', function (err) {
        reportError('Screenshare connection error.', err);
      });
    }

    // ------------------------------------------------------------
    // Send helpers
    // ------------------------------------------------------------
    function sendOn(label, payload) {
      var conn = conns[label];
      if (!conn || !conn.open) {
        reportError('Cannot send on "' + label + '" channel: not open.');
        return false;
      }
      try {
        conn.send(payload);
        return true;
      } catch (err) {
        reportError('Failed sending on "' + label + '" channel.', err);
        return false;
      }
    }

    // ------------------------------------------------------------
    // Host-side: open a peer and listen for the three channels plus
    // incoming screenshare calls.
    // ------------------------------------------------------------
    function openHostPeer(explicitId) {
      return new Promise(function (resolve, reject) {
        if (!ensurePeerJsLoaded()) {
          reject(new Error('PeerJS missing'));
          return;
        }

        setStatus(STATUS.CONNECTING);
        peer = createPeer(explicitId || uuidv4());

        peer.on('open', function (id) {
          resolve({ peerId: id, qrCodeUrl: qrCodeUrlFor(id) });
        });

        peer.on('connection', function (conn) {
          remotePeerId = conn.peer;
          wireDataConnection(conn);
        });

        peer.on('call', function (call) {
          call.answer(); // host doesn't send video back automatically
          wireMediaConnection(call, false);
        });

        peer.on('disconnected', function () {
          setStatus(STATUS.DISCONNECTED);
          emit('onDisconnected');
        });

        peer.on('error', function (err) {
          reportError('Peer error: ' + (err && err.type ? err.type : ''), err);
          reject(err);
        });
      });
    }

    // ------------------------------------------------------------
    // Peer-side: connect all three data channels to the host, plus
    // listen for an incoming screenshare call.
    // ------------------------------------------------------------
    function openPeerChannels(hostId) {
      return new Promise(function (resolve, reject) {
        if (!ensurePeerJsLoaded()) {
          reject(new Error('PeerJS missing'));
          return;
        }

        remotePeerId = hostId;

        function afterPeerReady() {
          setStatus(STATUS.CONNECTING);

          var syncConn = peer.connect(hostId, { label: CHANNEL.SYNC, reliable: true, serialization: 'json' });
          var chatConn = peer.connect(hostId, { label: CHANNEL.CHAT, reliable: false, serialization: 'json' });
          var authConn = peer.connect(hostId, { label: CHANNEL.AUTH, reliable: true, serialization: 'json' });

          [syncConn, chatConn, authConn].forEach(wireDataConnection);

          syncConn.on('open', function () { resolve(STATUS.CONNECTED); });
          syncConn.on('error', function (err) { reject(err); });

          peer.on('call', function (call) {
            call.answer();
            wireMediaConnection(call, false);
          });
        }

        if (peer) {
          afterPeerReady();
          return;
        }

        peer = createPeer();
        peer.on('open', afterPeerReady);
        peer.on('disconnected', function () {
          setStatus(STATUS.DISCONNECTED);
          emit('onDisconnected');
          if (!manualDisconnect) beginReconnectLoop();
        });
        peer.on('error', function (err) {
          reportError('Peer error: ' + (err && err.type ? err.type : ''), err);
          reject(err);
        });
      });
    }

    // ------------------------------------------------------------
    // Optional adapters supplied at init() time so the module can
    // drive an app's existing video player / chat UI directly, in
    // addition to always emitting the raw events.
    // ------------------------------------------------------------
    var playerAdapter = null;
    var chatAdapter = null;

    // ==================================================================
    // Public API
    // ==================================================================
    var api = {
      /**
       * init(isHost, currentUser, options?)
       * options.playerAdapter: { getCurrentTime, play, pause, seek, selectSubtitleTrack }
       * options.chatAdapter:   { receiveMessage }
       */
      init: function (hostFlag, user, options) {
        isHost = !!hostFlag;
        currentUser = user || null;
        options = options || {};
        playerAdapter = options.playerAdapter || null;
        chatAdapter = options.chatAdapter || null;
        manualDisconnect = false;
        setStatus(STATUS.DISCONNECTED);
      },

      connectAsHost: function () {
        return openHostPeer();
      },

      connectAsPeer: function (hostPeerId) {
        if (!hostPeerId || typeof hostPeerId !== 'string') {
          return Promise.reject(new Error('A valid host peer ID is required.'));
        }
        hostPeerIdTarget = hostPeerId;
        retryCount = 0;
        return openPeerChannels(hostPeerId);
      },

      broadcastSync: function (event, data) {
        var payload = { type: event, data: data || {} };
        var sent = sendOn(CHANNEL.SYNC, payload);
        if (!sent) {
          reportError('broadcastSync("' + event + '") could not be delivered.');
        }
        return sent;
      },

      broadcastChat: function (message) {
        // message may be { type, payload } already, or a plain string
        // (wrapped as a basic text message for convenience).
        var payload =
          message && typeof message === 'object' && message.type
            ? message
            : { type: 'message', payload: { text: String(message) } };
        var sent = sendOn(CHANNEL.CHAT, payload);
        if (!sent) {
          reportError('broadcastChat() could not be delivered.');
        }
        if (sent && chatAdapter && typeof chatAdapter.receiveMessage === 'function') {
          // Optionally echo locally for a unified render path; consumers
          // that manage their own optimistic UI can ignore this.
        }
        return sent;
      },

      attachScreenshareStream: function (stream) {
        if (!stream) {
          reportError('attachScreenshareStream() requires a MediaStream.');
          return;
        }
        startScreenCall(stream);
      },

      stopScreenshare: function () {
        if (mediaConn) {
          mediaConn.close();
          mediaConn = null;
        }
        if (localScreenStream) {
          localScreenStream.getTracks().forEach(function (t) { t.stop(); });
          localScreenStream = null;
        }
        emit('onScreenshareEnded');
      },

      receiveScreenshareStream: function (onStreamReceived) {
        onScreenshareReceivedCb = onStreamReceived;
      },

      getStatus: function () {
        return status;
      },

      getRemoteUser: function () {
        return remoteUser;
      },

      disconnect: function () {
        manualDisconnect = true;
        clearRetryTimers();
        Object.keys(conns).forEach(function (key) {
          if (conns[key]) { try { conns[key].close(); } catch (e) {} }
          conns[key] = null;
        });
        if (mediaConn) { try { mediaConn.close(); } catch (e) {} }
        if (peer) { try { peer.destroy(); } catch (e) {} }
        peer = null;
        setStatus(STATUS.DISCONNECTED);
      },

      // Generic listener registration, e.g. SyncModule.on('onChatMessage', fn)
      on: function (eventName, callback) {
        if (!(eventName in listeners)) {
          console.warn('[SyncModule] Unknown event "' + eventName + '"');
        }
        listeners[eventName] = callback;
      }
    };

    // Allow direct property assignment too, per the requested contract:
    // SyncModule.onConnected = function (user) {...}
    Object.keys(listeners).forEach(function (key) {
      Object.defineProperty(api, key, {
        get: function () { return listeners[key]; },
        set: function (fn) { listeners[key] = fn; },
        enumerable: true
      });
    });

    return api;
  }

  global.SyncModule = createSyncModule();
})(typeof window !== 'undefined' ? window : this);
