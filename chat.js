/**
 * chat.js
 * ---------------------------------------------------------------------------
 * Minimal text-only chat transport over a dedicated RTCDataChannel.
 *
 * Kept intentionally separate from screenshare.js: this channel only ever
 * carries small JSON text payloads, is created once at connection setup, and
 * is never paused, throttled, or renegotiated because of screen share state.
 * That separation is what keeps chat responsive even while the screen share
 * video track is consuming most of the available bandwidth.
 * ---------------------------------------------------------------------------
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChatModule = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ChatModule {
    /**
     * @param {RTCPeerConnection} peerConnection
     * @param {Object} [options]
     * @param {boolean} [options.isInitiator=true] - true if this side should
     *        create the data channel (createDataChannel), false if it should
     *        wait for the remote side via 'datachannel' event.
     */
    constructor(peerConnection, options = {}) {
      this.peerConnection = peerConnection;
      this.channel = null;

      this.onMessage = null; // (text, meta) => {}
      this.onOpen = null; // () => {}
      this.onClose = null; // () => {}

      if (options.isInitiator !== false) {
        // ordered: true keeps message order sane for a chat UI; the payload
        // size is tiny so this never competes meaningfully with video.
        this.channel = peerConnection.createDataChannel('chat', {
          ordered: true,
        });
        this._wireChannel(this.channel);
      } else {
        peerConnection.addEventListener('datachannel', (event) => {
          if (event.channel.label === 'chat') {
            this.channel = event.channel;
            this._wireChannel(this.channel);
          }
        });
      }
    }

    _wireChannel(channel) {
      channel.addEventListener('open', () => {
        if (typeof this.onOpen === 'function') this.onOpen();
      });
      channel.addEventListener('close', () => {
        if (typeof this.onClose === 'function') this.onClose();
      });
      channel.addEventListener('message', (event) => {
        if (typeof this.onMessage === 'function') {
          try {
            const parsed = JSON.parse(event.data);
            this.onMessage(parsed.text, parsed);
          } catch (e) {
            this.onMessage(event.data, {});
          }
        }
      });
    }

    isOpen() {
      return !!this.channel && this.channel.readyState === 'open';
    }

    send(text) {
      if (!this.isOpen()) return false;
      const payload = JSON.stringify({ text, ts: Date.now() });
      this.channel.send(payload);
      return true;
    }
  }

  return ChatModule;
});
