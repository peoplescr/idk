/**
 * screenshare.js
 * ---------------------------------------------------------------------------
 * Vanilla JS screen sharing module designed to run alongside a chat feature
 * over WebRTC without ever blocking or slowing down the chat.
 *
 * ARCHITECTURE NOTE ON "TWO CHANNELS"
 * ---------------------------------------------------------------------------
 * The requirements ask for screen share on a "high-bandwidth data channel"
 * and chat on a "low-bandwidth data channel." In WebRTC, video is not sent
 * over an RTCDataChannel (data channels are for arbitrary text/binary
 * messages, not media). Video is sent as a MediaStreamTrack via
 * RTCRtpSender, which negotiates its own bandwidth independently of any
 * data channel. That is the correct, performant way to keep chat snappy
 * while video adapts its bitrate:
 *
 *   - Screen share -> MediaStreamTrack added to the RTCPeerConnection.
 *     Bandwidth is controlled per-quality-level via RTCRtpSender.setParameters
 *     (encodings[0].maxBitrate) so it never starves the connection.
 *   - Chat -> a dedicated, low-priority RTCDataChannel carrying only small
 *     JSON text messages (see chat.js). Because it is a separate logical
 *     channel with tiny payloads, it stays responsive even while the video
 *     track is saturating available bandwidth.
 *
 * This module owns the screen-share track + its RTCRtpSender only. It never
 * touches, pauses, or throttles the chat data channel.
 * ---------------------------------------------------------------------------
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ScreenShareModule = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Quality presets
  // ---------------------------------------------------------------------
  const QUALITY_PRESETS = {
    high: {
      label: 'High (1080p)',
      width: 1920,
      height: 1080,
      frameRate: 30,
      maxBitrate: 2_500_000, // ~2.5 Mbps
    },
    medium: {
      label: 'Medium (720p)',
      width: 1280,
      height: 720,
      frameRate: 24,
      maxBitrate: 1_200_000, // ~1.2 Mbps
    },
    low: {
      label: 'Low (480p)',
      width: 854,
      height: 480,
      frameRate: 15,
      maxBitrate: 500_000, // ~0.5 Mbps
    },
  };

  const QUALITY_ORDER = ['high', 'medium', 'low'];

  // ---------------------------------------------------------------------
  // Browser / platform detection
  // ---------------------------------------------------------------------
  function detectPlatform(ua) {
    ua = ua || (typeof navigator !== 'undefined' ? navigator.userAgent : '');

    const isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      // iPadOS 13+ reports as "Macintosh" but exposes touch points
      (ua.includes('Macintosh') && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

    const isAndroid = /Android/.test(ua);
    const isMobile = isIOS || isAndroid;

    let browser = 'unknown';
    if (/Edg\//.test(ua)) browser = 'edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'chrome';
    else if (/Firefox\//.test(ua)) browser = 'firefox';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'safari';

    return { isIOS, isAndroid, isMobile, browser };
  }

  // ---------------------------------------------------------------------
  // ScreenShareModule
  // ---------------------------------------------------------------------
  class ScreenShareModule {
    /**
     * @param {Object} options
     * @param {RTCPeerConnection} [options.peerConnection] - PC to attach the
     *        screen track to. Optional; module works standalone (getStream())
     *        without a peer connection too.
     * @param {'high'|'medium'|'low'} [options.quality='medium']
     * @param {boolean} [options.audio=false] - include system/app audio
     * @param {number} [options.bandwidthCheckIntervalMs=3000]
     */
    constructor(options = {}) {
      this.peerConnection = options.peerConnection || null;
      this.quality = options.quality || 'medium';
      this.audioEnabled = !!options.audio;
      this.bandwidthCheckIntervalMs = options.bandwidthCheckIntervalMs || 3000;

      this.stream = null;
      this.sender = null; // RTCRtpSender for the video track
      this._bandwidthTimer = null;
      this._lastStatsSnapshot = null;
      this._consecutiveLowBandwidthHits = 0;

      this.platform = detectPlatform();

      // Public event hooks (assign functions directly, e.g. module.onError = fn)
      this.onScreenShareStart = null; // (stream) => {}
      this.onScreenShareStop = null; // () => {}
      this.onQualityChange = null; // (level) => {}
      this.onError = null; // (message) => {}
      this.onBandwidthWarning = null; // () => {}

      // Lightweight pub/sub as an alternative to the direct callbacks above
      this._listeners = {};
    }

    // -- Event emitter helpers (optional, in addition to onX callbacks) ----
    on(event, cb) {
      (this._listeners[event] = this._listeners[event] || []).push(cb);
      return this;
    }

    _emit(event, ...args) {
      const directHandlerName = 'on' + event.charAt(0).toUpperCase() + event.slice(1);
      if (typeof this[directHandlerName] === 'function') {
        try {
          this[directHandlerName](...args);
        } catch (e) {
          console.error(`[ScreenShareModule] error in ${directHandlerName} handler`, e);
        }
      }
      (this._listeners[event] || []).forEach((cb) => {
        try {
          cb(...args);
        } catch (e) {
          console.error(`[ScreenShareModule] error in listener for ${event}`, e);
        }
      });
    }

    // -----------------------------------------------------------------
    // Support / capability checks
    // -----------------------------------------------------------------
    isSupported() {
      if (this.platform.isIOS) return false; // Safari iOS does not expose getDisplayMedia
      return !!(
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function'
      );
    }

    /** Returns a short reason string when unsupported, or null when supported. */
    getUnsupportedReason() {
      if (this.platform.isIOS) {
        return 'Screen sharing is not available yet on iOS.';
      }
      if (!this.isSupported()) {
        return 'Screen sharing is not supported in this browser.';
      }
      return null;
    }

    /** Heuristic pre-flight bandwidth check using the Network Information API. */
    _shouldWarnAboutBandwidth() {
      const conn =
        (typeof navigator !== 'undefined' &&
          (navigator.connection || navigator.mozConnection || navigator.webkitConnection)) ||
        null;

      if (this.platform.isMobile) {
        if (conn && ['slow-2g', '2g', '3g'].includes(conn.effectiveType)) {
          return true;
        }
        if (conn && conn.saveData) return true;
        // Even without Network Information API support, mobile connections
        // are more likely to be bandwidth constrained than desktop wifi/eth.
        if (!conn) return true;
      }
      return false;
    }

    // -----------------------------------------------------------------
    // Start / stop
    // -----------------------------------------------------------------
    /**
     * @param {'high'|'medium'|'low'} [qualityLevel]
     * @returns {Promise<MediaStream|null>}
     */
    async start(qualityLevel) {
      const unsupportedReason = this.getUnsupportedReason();
      if (unsupportedReason) {
        this._emit('error', unsupportedReason);
        return null;
      }

      if (this.stream) {
        // Already sharing; treat as a no-op rather than an error.
        return this.stream;
      }

      if (qualityLevel && QUALITY_PRESETS[qualityLevel]) {
        this.quality = qualityLevel;
      }

      if (this._shouldWarnAboutBandwidth()) {
        this._emit('bandwidthWarning');
      }

      const preset = QUALITY_PRESETS[this.quality];

      const videoConstraints = {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
        cursor: 'always',
      };

      try {
        this.stream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: this.audioEnabled
            ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            : false,
        });
      } catch (err) {
        this._handleGetDisplayMediaError(err);
        return null;
      }

      const videoTrack = this.stream.getVideoTracks()[0];
      if (videoTrack) {
        // Fires when the user stops sharing via the browser's own UI
        // (e.g. the native "Stop sharing" bar), not just our button.
        videoTrack.addEventListener('ended', () => this.stop());
      }

      this._attachToPeerConnection();
      this._applyBitrateForCurrentQuality();
      this._startBandwidthMonitor();

      this._emit('screenShareStart', this.stream);
      return this.stream;
    }

    _handleGetDisplayMediaError(err) {
      let message = 'Could not start screen sharing.';
      switch (err && err.name) {
        case 'NotAllowedError':
          message = 'Screen share permission was denied.';
          break;
        case 'NotFoundError':
          message = 'No shareable screen or window was found.';
          break;
        case 'NotReadableError':
          message = 'The screen could not be captured (it may be in use).';
          break;
        case 'AbortError':
          message = 'Screen share was cancelled.';
          break;
        default:
          if (err && err.message) message = err.message;
      }
      this._emit('error', message);
    }

    stop() {
      this._stopBandwidthMonitor();

      if (this.sender && this.peerConnection) {
        try {
          // Remove the track from the connection rather than leaving a dead sender.
          this.peerConnection.removeTrack(this.sender);
        } catch (e) {
          /* sender may already be gone (e.g. connection closed) */
        }
      }
      this.sender = null;

      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop()); // release camera/OS capture + memory
        this.stream = null;
      }

      this._emit('screenShareStop');
    }

    getStream() {
      return this.stream;
    }

    // -----------------------------------------------------------------
    // Quality / audio controls
    // -----------------------------------------------------------------
    async setQuality(level) {
      if (!QUALITY_PRESETS[level]) {
        this._emit('error', `Unknown quality level: ${level}`);
        return;
      }
      this.quality = level;

      if (this.stream) {
        const preset = QUALITY_PRESETS[level];
        const videoTrack = this.stream.getVideoTracks()[0];
        if (videoTrack) {
          try {
            await videoTrack.applyConstraints({
              width: { ideal: preset.width },
              height: { ideal: preset.height },
              frameRate: { ideal: preset.frameRate },
            });
          } catch (e) {
            // Some browsers/capture sources don't allow constraint changes
            // mid-stream; fall back silently, bitrate cap still applies.
          }
        }
        this._applyBitrateForCurrentQuality();
      }

      this._emit('qualityChange', level);
    }

    /**
     * Audio can only be (re)captured by getDisplayMedia at the moment sharing
     * starts (browsers don't allow adding system audio to a live capture).
     * This sets the flag used on the *next* start(); if sharing is already in
     * progress we surface that limitation clearly via onError.
     */
    toggleAudio(enabled) {
      this.audioEnabled = !!enabled;
      if (this.stream) {
        this._emit(
          'error',
          'Audio setting will apply the next time you start screen sharing.'
        );
      }
    }

    // -----------------------------------------------------------------
    // WebRTC integration
    // -----------------------------------------------------------------
    _attachToPeerConnection() {
      if (!this.peerConnection || !this.stream) return;
      const videoTrack = this.stream.getVideoTracks()[0];
      if (!videoTrack) return;

      this.sender = this.peerConnection.addTrack(videoTrack, this.stream);

      // Also send audio track if present, on its own sender.
      const audioTrack = this.stream.getAudioTracks()[0];
      if (audioTrack) {
        this._audioSender = this.peerConnection.addTrack(audioTrack, this.stream);
      }
    }

    async _applyBitrateForCurrentQuality() {
      if (!this.sender) return;
      const preset = QUALITY_PRESETS[this.quality];
      try {
        const params = this.sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = preset.maxBitrate;
        await this.sender.setParameters(params);
      } catch (e) {
        // setParameters can throw if called before the first negotiation
        // completes on some browsers; safe to ignore, it'll apply on retry.
      }
    }

    // -----------------------------------------------------------------
    // Auto quality: bandwidth monitoring via WebRTC stats
    // -----------------------------------------------------------------
    _startBandwidthMonitor() {
      if (!this.sender) return; // nothing to measure without a live sender
      this._stopBandwidthMonitor();
      this._lastStatsSnapshot = null;
      this._consecutiveLowBandwidthHits = 0;

      this._bandwidthTimer = setInterval(() => this._checkBandwidth(), this.bandwidthCheckIntervalMs);
    }

    _stopBandwidthMonitor() {
      if (this._bandwidthTimer) {
        clearInterval(this._bandwidthTimer);
        this._bandwidthTimer = null;
      }
    }

    async _checkBandwidth() {
      if (!this.sender) return;
      let report;
      try {
        report = await this.sender.getStats();
      } catch (e) {
        return;
      }

      let outbound = null;
      report.forEach((stat) => {
        if (stat.type === 'outbound-rtp' && stat.kind === 'video') outbound = stat;
      });
      if (!outbound) return;

      const now = outbound.timestamp;
      const bytesSent = outbound.bytesSent || 0;
      const packetsLost = outbound.packetsLost || 0;
      const qualityLimitationReason = outbound.qualityLimitationReason; // 'bandwidth' | 'cpu' | 'none' | ...

      if (this._lastStatsSnapshot) {
        const dtSeconds = (now - this._lastStatsSnapshot.timestamp) / 1000;
        const dBytes = bytesSent - this._lastStatsSnapshot.bytesSent;
        const currentBitrate = dtSeconds > 0 ? (dBytes * 8) / dtSeconds : 0;
        const preset = QUALITY_PRESETS[this.quality];

        const isBandwidthLimited =
          qualityLimitationReason === 'bandwidth' || currentBitrate < preset.maxBitrate * 0.5;

        if (isBandwidthLimited) {
          this._consecutiveLowBandwidthHits += 1;
        } else {
          this._consecutiveLowBandwidthHits = 0;
        }

        // Require a couple of consecutive low readings to avoid flapping on
        // a single noisy sample.
        if (this._consecutiveLowBandwidthHits >= 2) {
          this._consecutiveLowBandwidthHits = 0;
          this._emit('bandwidthWarning');
          this._autoDowngradeQuality();
        }
      }

      this._lastStatsSnapshot = { timestamp: now, bytesSent, packetsLost };
    }

    _autoDowngradeQuality() {
      const currentIndex = QUALITY_ORDER.indexOf(this.quality);
      const nextIndex = currentIndex + 1;
      if (nextIndex < QUALITY_ORDER.length) {
        this.setQuality(QUALITY_ORDER[nextIndex]);
      }
      // Already at 'low' -> nothing further to reduce automatically; the
      // bandwidthWarning event is still emitted so the UI can inform the user.
    }

    // -----------------------------------------------------------------
    // Static helpers
    // -----------------------------------------------------------------
    static get QUALITY_PRESETS() {
      return QUALITY_PRESETS;
    }

    static detectPlatform(ua) {
      return detectPlatform(ua);
    }
  }

  return ScreenShareModule;
});
