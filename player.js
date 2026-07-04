/**
 * TV Player — vanilla JS video player module for a P2P watch party app.
 *
 * Handles local files (MP4 / WebM reliably; MKV where the browser's own
 * <video> element supports it) and remote sources (MP4 URLs, HLS/M3U8
 * via hls.js or native Safari HLS).
 *
 * ---------------------------------------------------------------------
 * IMPORTANT — read this before wiring up "embedded MKV subtitles":
 *
 * The browser's <video> element and its TextTrack API only ever expose
 * subtitle tracks that the browser's own demuxer decided to parse out of
 * the container. In practice:
 *   - HLS (m3u8) subtitle renditions ARE exposed as TextTracks, whether
 *     played natively (Safari) or through hls.js (which registers them
 *     as native TextTracks on the <video> element). getEmbeddedTracks()
 *     will find these.
 *   - MP4 files with WebVTT/tx3g text tracks are sometimes exposed too,
 *     depending on the browser.
 *   - MKV (Matroska) is the problem case. Chrome/Edge/Firefox can often
 *     *play* an MKV's video/audio if the codecs are natively supported
 *     (H.264/AAC, VP8/VP9/Opus), but none of them demux the embedded
 *     SRT/ASS/PGS subtitle streams into TextTracks — there is no browser
 *     API for that. video.js doesn't change this either: it sits on top
 *     of the same <video> element and TextTrack API, it doesn't ship an
 *     MKV demuxer.
 *
 * So for MKV specifically, this module cannot truthfully offer "embedded
 * track detection" out of the box. What it does instead:
 *   1. Always tries getEmbeddedTracks() — if the file/stream does expose
 *      tracks (HLS, some MP4s), they show up normally in the dropdown.
 *   2. If none are found AND the source is a .mkv file, it surfaces
 *      `onError`/a status message suggesting the reliable workaround:
 *      extract the subtitle stream (e.g. with ffmpeg/mkvextract, or a
 *      client-side WASM demuxer you bundle separately) to an .srt/.vtt
 *      file and use `addExternalSubtitleFile()`, which always works
 *      because it doesn't depend on container demuxing.
 * This module does not silently fake track detection to look complete.
 * ---------------------------------------------------------------------
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  // Tiny event emitter
  // ---------------------------------------------------------------------
  class Emitter {
    constructor() { this._listeners = {}; }
    on(evt, fn) {
      (this._listeners[evt] = this._listeners[evt] || []).push(fn);
      return this;
    }
    off(evt, fn) {
      if (!this._listeners[evt]) return this;
      this._listeners[evt] = this._listeners[evt].filter((f) => f !== fn);
      return this;
    }
    emit(evt, ...args) {
      (this._listeners[evt] || []).slice().forEach((fn) => {
        try { fn(...args); } catch (e) { console.error(`[TVPlayer] listener for "${evt}" threw`, e); }
      });
    }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function parseTimeInput(str) {
    const parts = str.split(':').map((p) => parseInt(p, 10)).filter((n) => !isNaN(n));
    if (!parts.length) return null;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }

  function isMkvSource(url) {
    return /\.mkv(\?|#|$)/i.test(url || '');
  }

  function isHlsSource(url, mimeType) {
    return (mimeType && /mpegurl/i.test(mimeType)) || /\.m3u8(\?|#|$)/i.test(url || '');
  }

  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    volHigh: '<svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    volMute: '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.14v2.06a8.99 8.99 0 0 0 3.69-1.86L19.73 21 21 19.73l-9-9L4.27 3zM12 4l-1.88 1.88L12 7.76V4z"/></svg>',
    fsEnter: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 9h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/></svg>',
    fsExit: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z"/></svg>',
    pip: '<svg viewBox="0 0 24 24"><path d="M19 7H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4v-2H5V9h14v6h-3.99v2H19a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM11 13h6v6h-6z"/></svg>',
    theater: '<svg viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM7 15H5v-2h2zm0-4H5V9h2zm12 4h-2v-2h2zm0-4h-2V9h2z"/></svg>',
    speed: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>',
    cc: '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8.5 5.5H10c-.14-.42-.5-.7-1-.7-.7 0-1.05.5-1.05 1.2v2c0 .7.35 1.2 1.05 1.2.5 0 .86-.28 1-.7h1.5c-.2 1.13-1.17 2-2.5 2-1.5 0-2.55-1.13-2.55-2.5v-2c0-1.37 1.05-2.5 2.55-2.5 1.33 0 2.3.87 2.5 2zm6.5 0h-1.5c-.14-.42-.5-.7-1-.7-.7 0-1.05.5-1.05 1.2v2c0 .7.35 1.2 1.05 1.2.5 0 .86-.28 1-.7H17c-.2 1.13-1.17 2-2.5 2-1.5 0-2.55-1.13-2.55-2.5v-2c0-1.37 1.05-2.5 2.55-2.5 1.33 0 2.3.87 2.5 2z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.32.66.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.28.27.42.5.42h3.84c.24 0 .46-.14.5-.42l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.24.1.51.02.66-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>',
  };

  const SUB_SIZES = { small: '3vh', normal: '4.2vh', large: '5.6vh' };
  const SUB_COLORS = ['#ffffff', '#ffe066', '#7fd8ff', '#ff8a80'];

  // ---------------------------------------------------------------------
  // Self-contained CSS — injected once into <head> on first use.
  // ---------------------------------------------------------------------
  const TVP_CSS = `
/* =========================================================================
   TV Player — self-contained styles
   Design language: a quiet reference monitor. Charcoal chassis, one warm
   "tally lamp" amber accent (the color a broadcast camera's rec light
   uses), monospaced time readout like a tape counter, and a faint
   scanline texture on the buffered range as the signature touch.
   ========================================================================= */

.tvp {
  --tvp-bg: #121214;
  --tvp-chrome: #1b1b1f;
  --tvp-chrome-2: #232328;
  --tvp-text: #e8e6e1;
  --tvp-text-dim: #9a9a9e;
  --tvp-accent: #ffb020;       /* tally-lamp amber */
  --tvp-accent-dim: #8a5f1c;
  --tvp-track: rgba(255,255,255,0.16);
  --tvp-buffer: rgba(255,255,255,0.32);
  --tvp-radius: 6px;
  --tvp-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --tvp-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--tvp-bg);
  color: var(--tvp-text);
  font-family: var(--tvp-sans);
  overflow: hidden;
  border-radius: var(--tvp-radius);
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.tvp.tvp-theater {
  aspect-ratio: auto;
  width: 100%;
  height: 92vh;
  border-radius: 0;
}

.tvp:fullscreen,
.tvp:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  aspect-ratio: auto;
  border-radius: 0;
}

.tvp video {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
  object-fit: contain;
}

/* -- subtitle rendering (native cue styling, cross-browser best effort) -- */
.tvp video::cue {
  color: var(--tvp-sub-color, #fff);
  font-size: var(--tvp-sub-size, 4.2vh);
  font-family: var(--tvp-sans);
  text-shadow:
    -1px -1px 0 #000, 1px -1px 0 #000,
    -1px  1px 0 #000, 1px  1px 0 #000,
    0 0 3px rgba(0,0,0,0.9);
  background: transparent;
  line-height: 1.35;
}
/* We keep cues visually pinned near the top via a wrapper trick: browsers
   don't let CSS reposition ::cue vertically in a standard way, so we also
   offer a JS-rendered top-subtitle overlay for browsers/tracks that need it
   (see .tvp-sub-overlay below), and default video captions to their native
   (usually bottom) position for tracks rendered natively by the UA. */

.tvp-sub-overlay {
  position: absolute;
  top: 6%;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 5;
  padding: 0 4%;
}
.tvp-sub-overlay span {
  color: var(--tvp-sub-color, #fff);
  font-size: var(--tvp-sub-size, 4.2vh);
  text-align: center;
  text-shadow:
    -1px -1px 0 #000, 1px -1px 0 #000,
    -1px  1px 0 #000, 1px  1px 0 #000,
    0 0 4px rgba(0,0,0,0.9);
  line-height: 1.3;
  max-width: 90%;
}

/* -- loading / error states -- */
.tvp-status {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  z-index: 20;
  background: rgba(10,10,11,0.55);
  text-align: center;
  padding: 24px;
}
.tvp-status.show { display: flex; }
.tvp-status .tvp-spinner {
  width: 34px; height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255,255,255,0.2);
  border-top-color: var(--tvp-accent);
  animation: tvp-spin 0.8s linear infinite;
}
.tvp-status .tvp-err-title { font-weight: 600; color: var(--tvp-text); }
.tvp-status .tvp-err-detail { font-size: 13px; color: var(--tvp-text-dim); max-width: 420px; }
@keyframes tvp-spin { to { transform: rotate(360deg); } }

/* -- big center play button -- */
.tvp-center-btn {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%) scale(1);
  width: 74px; height: 74px;
  border-radius: 50%;
  background: rgba(18,18,20,0.62);
  border: 1.5px solid rgba(255,255,255,0.25);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  z-index: 15;
  opacity: 1;
  transition: opacity 0.18s ease, transform 0.18s ease, background 0.15s ease;
  backdrop-filter: blur(2px);
}
.tvp-center-btn:hover { background: rgba(28,28,31,0.78); transform: translate(-50%, -50%) scale(1.05); }
.tvp-center-btn svg { width: 30px; height: 30px; fill: var(--tvp-text); margin-left: 3px; }
.tvp.tvp-playing .tvp-center-btn { opacity: 0; pointer-events: none; transform: translate(-50%, -50%) scale(0.8); }

/* -- tally lamp: small rec-style dot that pulses briefly on peer sync -- */
.tvp-tally {
  position: absolute;
  top: 14px; left: 14px;
  display: flex; align-items: center; gap: 6px;
  padding: 4px 9px 4px 7px;
  background: rgba(10,10,11,0.55);
  border-radius: 999px;
  font-family: var(--tvp-mono);
  font-size: 11px;
  color: var(--tvp-text-dim);
  z-index: 15;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.tvp-tally.show { opacity: 1; transform: translateY(0); }
.tvp-tally .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--tvp-accent);
  box-shadow: 0 0 6px 1px rgba(255,176,32,0.7);
  animation: tvp-tally-pulse 1s ease-in-out infinite;
}
@keyframes tvp-tally-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

/* -- controls bar -- */
.tvp-controls {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  z-index: 25;
  padding: 10px 14px 10px;
  background: linear-gradient(to top, rgba(8,8,9,0.88) 0%, rgba(8,8,9,0.55) 55%, transparent 100%);
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.tvp.tvp-hide-controls .tvp-controls { opacity: 0; transform: translateY(6px); pointer-events: none; }
.tvp.tvp-hide-controls { cursor: none; }

/* seek row */
.tvp-seek-row {
  position: relative;
  height: 16px;
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  cursor: pointer;
}
.tvp-seek-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 3px;
  background: var(--tvp-track);
  overflow: visible;
  transition: height 0.12s ease;
}
.tvp-seek-row:hover .tvp-seek-track,
.tvp-seek-row.dragging .tvp-seek-track { height: 6px; }

.tvp-seek-buffered {
  position: absolute; top: 0; left: 0; height: 100%;
  width: 0%;
  border-radius: 3px;
  background: var(--tvp-buffer);
  /* subtle scanline texture — the signature detail */
  background-image: repeating-linear-gradient(
    90deg, rgba(255,255,255,0.0) 0px, rgba(255,255,255,0.0) 3px,
    rgba(0,0,0,0.12) 3px, rgba(0,0,0,0.12) 4px
  );
}
.tvp-seek-played {
  position: absolute; top: 0; left: 0; height: 100%;
  width: 0%;
  border-radius: 3px;
  background: var(--tvp-accent);
}
.tvp-seek-handle {
  position: absolute; top: 50%; left: 0%;
  width: 13px; height: 13px;
  border-radius: 50%;
  background: var(--tvp-accent);
  transform: translate(-50%, -50%) scale(0);
  box-shadow: 0 0 0 3px rgba(255,176,32,0.22);
  transition: transform 0.12s ease;
}
.tvp-seek-row:hover .tvp-seek-handle,
.tvp-seek-row.dragging .tvp-seek-handle { transform: translate(-50%, -50%) scale(1); }

.tvp-seek-tooltip {
  position: absolute;
  bottom: 18px;
  transform: translateX(-50%);
  background: var(--tvp-chrome-2);
  border: 1px solid rgba(255,255,255,0.08);
  color: var(--tvp-text);
  font-family: var(--tvp-mono);
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.tvp-seek-row:hover .tvp-seek-tooltip,
.tvp-seek-row.dragging .tvp-seek-tooltip { opacity: 1; }

/* button row */
.tvp-btn-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.tvp-btn-row .tvp-spacer { flex: 1; }

.tvp-btn {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  border: none;
  color: var(--tvp-text);
  cursor: pointer;
  border-radius: 5px;
  position: relative;
  flex-shrink: 0;
}
.tvp-btn:hover { background: rgba(255,255,255,0.08); }
.tvp-btn:active { background: rgba(255,255,255,0.14); }
.tvp-btn svg { width: 19px; height: 19px; fill: currentColor; }
.tvp-btn.active { color: var(--tvp-accent); }

.tvp-time {
  font-family: var(--tvp-mono);
  font-size: 12.5px;
  color: var(--tvp-text-dim);
  padding: 0 8px;
  cursor: pointer;
  letter-spacing: 0.2px;
  white-space: nowrap;
}
.tvp-time:hover { color: var(--tvp-text); }
.tvp-time input {
  font-family: var(--tvp-mono);
  font-size: 12.5px;
  background: var(--tvp-chrome-2);
  color: var(--tvp-text);
  border: 1px solid var(--tvp-accent-dim);
  border-radius: 3px;
  width: 62px;
  padding: 1px 3px;
}

/* volume */
.tvp-volume {
  display: flex;
  align-items: center;
  gap: 0;
}
.tvp-vol-slider-wrap {
  width: 0;
  overflow: hidden;
  transition: width 0.18s ease;
  display: flex;
  align-items: center;
}
.tvp-volume:hover .tvp-vol-slider-wrap,
.tvp-volume.dragging .tvp-vol-slider-wrap { width: 78px; }
.tvp-vol-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 70px;
  height: 4px;
  border-radius: 3px;
  background: var(--tvp-track);
  outline: none;
  margin-left: 6px;
}
.tvp-vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--tvp-accent);
  cursor: pointer;
}
.tvp-vol-slider::-moz-range-thumb {
  width: 12px; height: 12px; border: none; border-radius: 50%;
  background: var(--tvp-accent); cursor: pointer;
}

/* -- dropdown menus (speed / subtitles / settings) -- */
.tvp-menu-wrap { position: relative; }
.tvp-menu {
  position: absolute;
  bottom: 44px;
  right: 0;
  min-width: 190px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--tvp-chrome);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.5);
  padding: 6px;
  display: none;
  z-index: 40;
  font-size: 13px;
}
.tvp-menu.open { display: block; }
.tvp-menu-title {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--tvp-text-dim);
  padding: 6px 8px 4px;
}
.tvp-menu-item {
  padding: 7px 9px;
  border-radius: 5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--tvp-text);
  gap: 10px;
}
.tvp-menu-item:hover { background: rgba(255,255,255,0.08); }
.tvp-menu-item.selected { color: var(--tvp-accent); }
.tvp-menu-item .chk { width: 14px; text-align: center; }
.tvp-menu-sep { height: 1px; background: rgba(255,255,255,0.08); margin: 5px 2px; }
.tvp-menu-back {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; margin-bottom: 2px;
  color: var(--tvp-text-dim); cursor: pointer;
  font-size: 12px;
}
.tvp-menu-back:hover { color: var(--tvp-text); }

.tvp-swatches { display: flex; gap: 6px; padding: 4px 8px 8px; }
.tvp-swatch {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.15);
  cursor: pointer;
}
.tvp-swatch.selected { border-color: var(--tvp-accent); }

.tvp-toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 9px;
}
.tvp-toggle {
  width: 32px; height: 18px; border-radius: 999px;
  background: var(--tvp-track);
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
}
.tvp-toggle.on { background: var(--tvp-accent-dim); }
.tvp-toggle .knob {
  position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #fff;
  transition: left 0.15s ease;
}
.tvp-toggle.on .knob { left: 16px; background: var(--tvp-accent); }

.tvp-file-row {
  padding: 7px 9px;
  color: var(--tvp-text-dim);
  font-size: 12px;
  border-top: 1px solid rgba(255,255,255,0.06);
  margin-top: 4px;
}
.tvp-file-row label {
  color: var(--tvp-accent);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* -- mobile / touch -- */
@media (max-width: 720px) {
  .tvp-btn { width: 42px; height: 42px; }
  .tvp-btn svg { width: 21px; height: 21px; }
  .tvp-time { font-size: 11.5px; padding: 0 4px; }
  .tvp-controls { padding: 8px 8px; }
  .tvp-center-btn { width: 64px; height: 64px; }
  .tvp-vol-slider-wrap { width: 0 !important; }
  .tvp-volume.dragging .tvp-vol-slider-wrap { width: 56px !important; }
}

@media (orientation: landscape) and (max-height: 500px) {
  .tvp-controls { padding: 6px 10px; }
  .tvp-btn { width: 34px; height: 34px; }
}

.tvp-hidden { display: none !important; }

`;
  function injectStylesOnce() {
    if (document.getElementById('tvp-styles')) return;
    const style = document.createElement('style');
    style.id = 'tvp-styles';
    style.textContent = TVP_CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // TVPlayer
  // ---------------------------------------------------------------------
  class TVPlayer extends Emitter {
    /**
     * @param {HTMLElement} target  A container <div>, OR an existing <video>
     *                              element already in the DOM (it will be
     *                              wrapped automatically).
     * @param {Object} options
     */
    constructor(target, options = {}) {
      super();
      this.opts = Object.assign({
        autoplayNext: false,
        startVolume: 1,
        subtitleSize: 'normal',
        subtitleColor: '#ffffff',
      }, options);

      injectStylesOnce();
      this._buildDom(target);
      this._state = {
        draggingSeek: false,
        draggingVolume: false,
        hideTimer: null,
        activeSubtitleTrack: -1, // index into this.getEmbeddedTracks(), -1 = off
        lastVolume: this.opts.startVolume,
        hls: null,
        menuOpen: null,
        rotationLocked: false,
      };

      this._applySubtitleStyle();
      this._wireVideoEvents();
      this._wireControlEvents();
      this._resizeObserver();
      this._resetHideTimer();
    }

    // ---- DOM scaffolding ------------------------------------------------
    _buildDom(target) {
      let container, video;

      if (target.tagName === 'VIDEO') {
        video = target;
        container = document.createElement('div');
        video.parentElement.insertBefore(container, video);
        container.appendChild(video);
      } else {
        container = target;
        video = document.createElement('video');
        container.appendChild(video);
      }

      container.classList.add('tvp');
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      // We render our own subtitle overlay, so keep native cues hidden
      // rather than fighting the browser's default (usually bottom) box.
      video.disableRemotePlayback = false;

      container.innerHTML += `
        <div class="tvp-sub-overlay" style="display:none"><span></span></div>

        <div class="tvp-status">
          <div class="tvp-spinner"></div>
          <div class="tvp-err-title"></div>
          <div class="tvp-err-detail"></div>
        </div>

        <div class="tvp-tally"><span class="dot"></span><span class="tvp-tally-text">synced by peer</span></div>

        <div class="tvp-center-btn" data-role="center-play">${ICONS.play}</div>

        <div class="tvp-controls">
          <div class="tvp-seek-row" data-role="seek-row">
            <div class="tvp-seek-track">
              <div class="tvp-seek-buffered"></div>
              <div class="tvp-seek-played"></div>
              <div class="tvp-seek-handle"></div>
            </div>
            <div class="tvp-seek-tooltip" data-role="seek-tooltip">0:00</div>
          </div>

          <div class="tvp-btn-row">
            <button class="tvp-btn" data-action="playpause" title="Play/Pause">${ICONS.play}</button>

            <div class="tvp-volume" data-role="volume">
              <button class="tvp-btn" data-action="mute" title="Mute">${ICONS.volHigh}</button>
              <div class="tvp-vol-slider-wrap">
                <input class="tvp-vol-slider" data-role="vol-slider" type="range" min="0" max="100" value="100" />
              </div>
            </div>

            <div class="tvp-time" data-role="time-display">
              <span data-role="time-current">0:00</span> / <span data-role="time-duration">0:00</span>
            </div>

            <div class="tvp-spacer"></div>

            <div class="tvp-menu-wrap">
              <button class="tvp-btn" data-action="toggle-cc" title="Subtitles on/off">${ICONS.cc}</button>
            </div>

            <div class="tvp-menu-wrap">
              <button class="tvp-btn" data-menu="subtitles" title="Subtitle track">${ICONS.chevron}</button>
              <div class="tvp-menu" data-menu-panel="subtitles"></div>
            </div>

            <div class="tvp-menu-wrap">
              <button class="tvp-btn" data-menu="speed" title="Playback speed">${ICONS.speed}</button>
              <div class="tvp-menu" data-menu-panel="speed"></div>
            </div>

            <div class="tvp-menu-wrap">
              <button class="tvp-btn" data-menu="settings" title="Settings">${ICONS.gear}</button>
              <div class="tvp-menu" data-menu-panel="settings"></div>
            </div>

            <button class="tvp-btn" data-action="pip" title="Picture in picture">${ICONS.pip}</button>
            <button class="tvp-btn" data-action="theater" title="Theater mode">${ICONS.theater}</button>
            <button class="tvp-btn" data-action="fullscreen" title="Fullscreen">${ICONS.fsEnter}</button>
          </div>
        </div>
      `;

      this.container = container;
      this.video = video;
      this.$ = (sel) => container.querySelector(sel);
      this.$$ = (sel) => container.querySelectorAll(sel);

      this._renderSpeedMenu();
      this._renderSettingsMenu();
      this._renderSubtitleMenu(); // empty until tracks known
    }

    // ---- Source loading --------------------------------------------------
    /**
     * @param {Object} src
     * @param {string} [src.url]        Remote URL (mp4, webm, m3u8) or object URL.
     * @param {File}   [src.file]       A local File (from <input type=file>).
     * @param {string} [src.mimeType]   Optional explicit mime type / 'application/x-mpegURL'.
     */
    loadSource(src) {
      this._clearHls();
      this._showStatus('loading', 'Loading…', '');

      let url = src.url;
      if (src.file) {
        url = URL.createObjectURL(src.file);
        this._objectUrl = url;
      }
      this._currentUrl = url;
      this._currentMkv = isMkvSource(url) || (src.file && /\.mkv$/i.test(src.file.name || ''));

      if (isHlsSource(url, src.mimeType)) {
        this._loadHls(url);
      } else {
        this.video.src = url;
      }

      this.video.load();
      this.selectSubtitleTrack(-1, { silent: true });
      this._renderSubtitleMenu();
    }

    _loadHls(url) {
      const video = this.video;
      const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
      if (nativeHls) {
        // Safari / iOS: native HLS + subtitle rendition support.
        video.src = url;
        return;
      }
      if (global.Hls && global.Hls.isSupported()) {
        const hls = new global.Hls({ enableWorker: true });
        this._state.hls = hls;
        hls.on(global.Hls.Events.ERROR, (evt, data) => {
          if (data.fatal) {
            this.emit('error', `HLS error: ${data.details}`);
            this._showStatus('error', 'Playback error', data.details);
          }
        });
        hls.on(global.Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this._renderSubtitleMenu());
        hls.on(global.Hls.Events.MANIFEST_PARSED, () => {
          this._hideStatus();
          this._renderQualityOptions(hls.levels);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        const msg = 'This browser can\'t play HLS streams and hls.js was not found. Include hls.js (see example.html) or use a browser with native HLS support.';
        this.emit('error', msg);
        this._showStatus('error', 'Can\'t play this stream', msg);
      }
    }

    _clearHls() {
      if (this._state && this._state.hls) {
        this._state.hls.destroy();
        this._state.hls = null;
      }
      if (this._objectUrl) {
        URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = null;
      }
    }

    // ---- Playback control API (per spec) ---------------------------------
    play() { const p = this.video.play(); if (p && p.catch) p.catch((e) => this.emit('error', e.message)); }
    pause() { this.video.pause(); }
    seek(time) {
      this.video.currentTime = Math.max(0, Math.min(time, this.video.duration || time));
      this.emit('seek', this.video.currentTime);
    }
    setVolume(vol /* 0..1 */) {
      this.video.volume = Math.max(0, Math.min(1, vol));
      this.video.muted = this.video.volume === 0;
      this._syncVolumeUi();
    }
    getCurrentTime() { return this.video.currentTime; }
    getDuration() { return this.video.duration || 0; }

    setPlaybackRate(rate) { this.video.playbackRate = rate; this._renderSpeedMenu(); }

    // ---- Subtitles ---------------------------------------------------------
    /** @returns {{index:number,label:string,language:string,kind:string,source:'embedded'|'external'}[]} */
    getEmbeddedTracks() {
      const tracks = [];
      const tt = this.video.textTracks;
      for (let i = 0; i < tt.length; i++) {
        const t = tt[i];
        if (t.kind === 'subtitles' || t.kind === 'captions') {
          tracks.push({
            index: i,
            label: t.label || t.language || `Track ${i + 1}`,
            language: t.language || '',
            kind: t.kind,
            source: t.__tvpExternal ? 'external' : 'embedded',
          });
        }
      }
      return tracks;
    }

    /**
     * @param {number} trackIndex   -1 = Off, otherwise index from getEmbeddedTracks().
     * @param {Object} [opts]
     * @param {boolean} [opts.silent]  If true, don't emit 'subtitleTrackChanged'
     *                                 (use this when applying a track selection
     *                                 that arrived from a peer, to avoid an echo).
     */
    selectSubtitleTrack(trackIndex, opts = {}) {
      const tt = this.video.textTracks;
      for (let i = 0; i < tt.length; i++) {
        tt[i].mode = (i === trackIndex) ? 'hidden' : 'disabled'; // 'hidden' = parsed, not natively rendered
      }
      this._state.activeSubtitleTrack = trackIndex;
      this._updateSubOverlay(null);
      this._renderSubtitleMenu();
      this.$('[data-action="toggle-cc"]').classList.toggle('active', trackIndex !== -1);

      if (!opts.silent) {
        this.emit('subtitleTrackChanged', trackIndex);
        this._flashTally('you changed subtitles');
      } else {
        this._flashTally('synced by peer');
      }
    }

    /** Add an external .srt or .vtt file as a selectable subtitle track. */
    addExternalSubtitleFile(file, label, language = '') {
      const isSrt = /\.srt$/i.test(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        let vttText = reader.result;
        if (isSrt) vttText = this._srtToVtt(vttText);
        const blob = new Blob([vttText], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);

        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = label || file.name.replace(/\.(srt|vtt)$/i, '');
        trackEl.srclang = language || 'en';
        trackEl.src = url;
        this.video.appendChild(trackEl);

        trackEl.addEventListener('load', () => {
          const idx = Array.from(this.video.textTracks).indexOf(trackEl.track);
          trackEl.track.__tvpExternal = true;
          this._renderSubtitleMenu();
          this.selectSubtitleTrack(idx);
        });
      };
      reader.readAsText(file);
    }

    _srtToVtt(srt) {
      let vtt = srt.replace(/\r+/g, '');
      vtt = vtt.replace(/^\uFEFF/, '');
      vtt = vtt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      return 'WEBVTT\n\n' + vtt;
    }

    setSubtitleSize(size /* 'small'|'normal'|'large' */) {
      this.opts.subtitleSize = size;
      this._applySubtitleStyle();
    }
    setSubtitleColor(color) {
      this.opts.subtitleColor = color;
      this._applySubtitleStyle();
    }
    _applySubtitleStyle() {
      this.container.style.setProperty('--tvp-sub-size', SUB_SIZES[this.opts.subtitleSize] || SUB_SIZES.normal);
      this.container.style.setProperty('--tvp-sub-color', this.opts.subtitleColor);
    }

    _updateSubOverlay(text) {
      const overlay = this.$('.tvp-sub-overlay');
      const span = overlay.querySelector('span');
      if (text) {
        span.textContent = text;
        overlay.style.display = 'flex';
      } else {
        overlay.style.display = 'none';
      }
    }

    // ---- Video element event wiring --------------------------------------
    _wireVideoEvents() {
      const v = this.video;

      v.addEventListener('play', () => {
        this.container.classList.add('tvp-playing');
        this.$('[data-action="playpause"]').innerHTML = ICONS.pause;
        this.$('[data-role="center-play"]').innerHTML = ICONS.pause;
        this.emit('play');
        this._resetHideTimer();
      });

      v.addEventListener('pause', () => {
        this.container.classList.remove('tvp-playing');
        this.$('[data-action="playpause"]').innerHTML = ICONS.play;
        this.$('[data-role="center-play"]').innerHTML = ICONS.play;
        this.emit('pause');
        this._showControls();
      });

      v.addEventListener('timeupdate', () => {
        if (!this._state.draggingSeek) this._syncSeekUi();
        this.emit('timeupdate', v.currentTime, v.duration || 0);
      });

      v.addEventListener('progress', () => this._syncBufferedUi());
      v.addEventListener('volumechange', () => this._syncVolumeUi());

      v.addEventListener('loadedmetadata', () => {
        this._hideStatus();
        this._syncSeekUi();
        this._syncVolumeUi();
        this._renderSubtitleMenu();
      });

      // Track list can populate asynchronously (HLS subtitle renditions,
      // some MP4 text tracks). Re-render the dropdown when it changes.
      v.textTracks.addEventListener('addtrack', () => this._renderSubtitleMenu());
      v.textTracks.addEventListener('removetrack', () => this._renderSubtitleMenu());

      v.addEventListener('error', () => {
        const err = v.error;
        let detail = 'Unknown playback error.';
        if (err) {
          const map = { 1: 'Loading aborted.', 2: 'Network error.', 3: 'Decoding error — the file/codec may be unsupported.', 4: 'Source not supported by this browser.' };
          detail = map[err.code] || detail;
        }
        if (this._currentMkv) {
          detail += ' This is an MKV file — browser support for Matroska depends on the codecs inside it (H.264/AAC or VP8-VP9/Opus tend to work; others will not play natively).';
        }
        this.emit('error', detail);
        this._showStatus('error', 'Can\'t play this video', detail);
      });

      v.addEventListener('waiting', () => this._showStatus('loading', 'Buffering…', ''));
      v.addEventListener('playing', () => this._hideStatus());
      v.addEventListener('canplay', () => this._hideStatus());

      v.addEventListener('ended', () => {
        this._showControls(true);
        this.emit('ended');
        if (this.opts.autoplayNext) this.emit('autoplayNext');
      });

      v.addEventListener('cuechange', () => {
        const tt = v.textTracks;
        const active = tt[this._state.activeSubtitleTrack];
        if (!active || !active.activeCues || active.activeCues.length === 0) {
          this._updateSubOverlay(null);
          return;
        }
        const text = Array.from(active.activeCues).map((c) => c.text.replace(/<[^>]+>/g, '')).join('\n');
        this._updateSubOverlay(text);
      });

      v.addEventListener('enterpictureinpicture', () => this.emit('pipChange', true));
      v.addEventListener('leavepictureinpicture', () => this.emit('pipChange', false));
    }

    // ---- UI wiring ---------------------------------------------------------
    _wireControlEvents() {
      const c = this.container;

      this.$('[data-role="center-play"]').addEventListener('click', () => this._togglePlay());
      this.$('[data-action="playpause"]').addEventListener('click', () => this._togglePlay());

      // seek bar
      const seekRow = this.$('[data-role="seek-row"]');
      const seekTrack = this.$('.tvp-seek-track');
      const tooltip = this.$('[data-role="seek-tooltip"]');

      const posToTime = (clientX) => {
        const rect = seekTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio * (this.video.duration || 0);
      };
      const showTooltip = (clientX) => {
        const rect = seekTrack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        tooltip.style.left = `${ratio * 100}%`;
        tooltip.textContent = fmtTime(posToTime(clientX));
      };

      seekRow.addEventListener('mousemove', (e) => showTooltip(e.clientX));
      seekRow.addEventListener('mousedown', (e) => {
        this._state.draggingSeek = true;
        seekRow.classList.add('dragging');
        this._resetHideTimer(true);
        const t = posToTime(e.clientX);
        this._setSeekBarRatio(t / (this.video.duration || 1));
        showTooltip(e.clientX);
        const onMove = (ev) => { const tt = posToTime(ev.clientX); this._setSeekBarRatio(tt / (this.video.duration || 1)); showTooltip(ev.clientX); };
        const onUp = (ev) => {
          seekRow.classList.remove('dragging');
          this._state.draggingSeek = false;
          this.seek(posToTime(ev.clientX));
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          this._resetHideTimer();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
      // touch support
      seekRow.addEventListener('touchstart', (e) => {
        this._state.draggingSeek = true;
        seekRow.classList.add('dragging');
        this._resetHideTimer(true);
        const touch = e.touches[0];
        const t = posToTime(touch.clientX);
        this._setSeekBarRatio(t / (this.video.duration || 1));
        const onMove = (ev) => { const tc = ev.touches[0]; const tt = posToTime(tc.clientX); this._setSeekBarRatio(tt / (this.video.duration || 1)); showTooltip(tc.clientX); };
        const onEnd = (ev) => {
          seekRow.classList.remove('dragging');
          this._state.draggingSeek = false;
          this.seek(posToTime((ev.changedTouches[0] || touch).clientX));
          window.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onEnd);
          this._resetHideTimer();
        };
        window.addEventListener('touchmove', onMove, { passive: true });
        window.addEventListener('touchend', onEnd);
      }, { passive: true });

      // volume
      const volSlider = this.$('[data-role="vol-slider"]');
      const volWrap = this.$('[data-role="volume"]');
      volSlider.addEventListener('input', () => {
        this._state.draggingVolume = true;
        volWrap.classList.add('dragging');
        this.setVolume(volSlider.value / 100);
      });
      volSlider.addEventListener('change', () => { this._state.draggingVolume = false; volWrap.classList.remove('dragging'); });
      this.$('[data-action="mute"]').addEventListener('click', () => {
        if (this.video.muted || this.video.volume === 0) {
          this.setVolume(this._state.lastVolume || 1);
        } else {
          this._state.lastVolume = this.video.volume;
          this.setVolume(0);
        }
      });

      // time display click -> jump to time
      const timeDisplay = this.$('[data-role="time-display"]');
      timeDisplay.addEventListener('click', () => {
        const current = fmtTime(this.video.currentTime);
        timeDisplay.innerHTML = `<input type="text" value="${current}" />`;
        const input = timeDisplay.querySelector('input');
        input.focus();
        input.select();
        const commit = () => {
          const t = parseTimeInput(input.value);
          if (t !== null) this.seek(t);
          this._syncSeekUi();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') this._syncSeekUi(); });
        input.addEventListener('blur', commit);
      });

      // subtitles toggle button
      this.$('[data-action="toggle-cc"]').addEventListener('click', () => {
        if (this._state.activeSubtitleTrack === -1) {
          const tracks = this.getEmbeddedTracks();
          if (tracks.length) this.selectSubtitleTrack(tracks[0].index);
        } else {
          this.selectSubtitleTrack(-1);
        }
      });

      // dropdown menus
      this.$$('[data-menu]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = btn.dataset.menu;
          const panel = this.$(`[data-menu-panel="${name}"]`);
          const isOpen = panel.classList.contains('open');
          this.$$('.tvp-menu').forEach((m) => m.classList.remove('open'));
          if (!isOpen) { panel.classList.add('open'); this._state.menuOpen = name; this._resetHideTimer(true); }
          else { this._state.menuOpen = null; }
        });
      });
      document.addEventListener('click', () => { this.$$('.tvp-menu').forEach((m) => m.classList.remove('open')); this._state.menuOpen = null; });

      // PiP / theater / fullscreen
      this.$('[data-action="pip"]').addEventListener('click', () => this._togglePip());
      this.$('[data-action="theater"]').addEventListener('click', () => this._toggleTheater());
      this.$('[data-action="fullscreen"]').addEventListener('click', () => this._toggleFullscreen());

      document.addEventListener('fullscreenchange', () => this._onFullscreenChange());
      document.addEventListener('webkitfullscreenchange', () => this._onFullscreenChange());

      // auto-hide controls
      ['mousemove', 'touchstart', 'click'].forEach((evt) => {
        c.addEventListener(evt, () => this._resetHideTimer());
      });
      c.addEventListener('mouseleave', () => { if (!this.video.paused) this._resetHideTimer(true, 400); });

      // keyboard shortcuts when focused
      c.tabIndex = 0;
      c.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        switch (e.code) {
          case 'Space': e.preventDefault(); this._togglePlay(); break;
          case 'ArrowRight': this.seek(this.video.currentTime + 5); break;
          case 'ArrowLeft': this.seek(this.video.currentTime - 5); break;
          case 'ArrowUp': e.preventDefault(); this.setVolume(Math.min(1, this.video.volume + 0.05)); break;
          case 'ArrowDown': e.preventDefault(); this.setVolume(Math.max(0, this.video.volume - 0.05)); break;
          case 'KeyF': this._toggleFullscreen(); break;
          case 'KeyM': this.$('[data-action="mute"]').click(); break;
          case 'KeyC': this.$('[data-action="toggle-cc"]').click(); break;
        }
        this._resetHideTimer();
      });
    }

    _togglePlay() { this.video.paused ? this.play() : this.pause(); }

    // ---- Menus --------------------------------------------------------------
    _renderSpeedMenu() {
      const panel = this.$('[data-menu-panel="speed"]');
      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
      panel.innerHTML = `<div class="tvp-menu-title">Speed</div>` + speeds.map((s) => `
        <div class="tvp-menu-item ${this.video.playbackRate === s ? 'selected' : ''}" data-speed="${s}">
          <span>${s === 1 ? 'Normal' : s + 'x'}</span>
          <span class="chk">${this.video.playbackRate === s ? '✓' : ''}</span>
        </div>`).join('');
      panel.querySelectorAll('[data-speed]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setPlaybackRate(parseFloat(el.dataset.speed));
          panel.classList.remove('open');
        });
      });
    }

    _renderSubtitleMenu() {
      const panel = this.$('[data-menu-panel="subtitles"]');
      const tracks = this.getEmbeddedTracks();
      const active = this._state ? this._state.activeSubtitleTrack : -1;

      let html = `<div class="tvp-menu-title">Subtitles</div>`;
      html += `<div class="tvp-menu-item ${active === -1 ? 'selected' : ''}" data-sub="-1"><span>Off</span><span class="chk">${active === -1 ? '✓' : ''}</span></div>`;
      if (tracks.length === 0) {
        html += `<div class="tvp-menu-item" style="opacity:.55;cursor:default">
          <span>${this._currentMkv ? 'No tracks detected (MKV)' : 'No tracks found'}</span></div>`;
        if (this._currentMkv) {
          html += `<div class="tvp-file-row">MKV subtitle streams usually aren't exposed by the browser. Extract to .srt/.vtt and upload below.</div>`;
        }
      } else {
        tracks.forEach((t) => {
          html += `<div class="tvp-menu-item ${active === t.index ? 'selected' : ''}" data-sub="${t.index}">
            <span>${t.label}${t.source === 'external' ? ' (uploaded)' : ''}</span>
            <span class="chk">${active === t.index ? '✓' : ''}</span></div>`;
        });
      }
      html += `<div class="tvp-file-row">
        <label>Upload .srt / .vtt<input type="file" accept=".srt,.vtt" data-role="sub-upload" style="display:none" /></label>
      </div>`;

      panel.innerHTML = html;
      panel.querySelectorAll('[data-sub]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectSubtitleTrack(parseInt(el.dataset.sub, 10));
          panel.classList.remove('open');
        });
      });
      const upload = panel.querySelector('[data-role="sub-upload"]');
      if (upload) {
        upload.addEventListener('click', (e) => e.stopPropagation());
        upload.addEventListener('change', () => {
          if (upload.files[0]) this.addExternalSubtitleFile(upload.files[0], upload.files[0].name);
        });
      }
    }

    _renderSettingsMenu(qualityLevels) {
      const panel = this.$('[data-menu-panel="settings"]');
      const sizes = ['small', 'normal', 'large'];
      let html = `<div class="tvp-menu-title">Subtitle size</div>` + sizes.map((s) => `
        <div class="tvp-menu-item ${this.opts.subtitleSize === s ? 'selected' : ''}" data-subsize="${s}">
          <span style="text-transform:capitalize">${s}</span><span class="chk">${this.opts.subtitleSize === s ? '✓' : ''}</span>
        </div>`).join('');

      html += `<div class="tvp-menu-title">Subtitle color</div>
        <div class="tvp-swatches">` + SUB_COLORS.map((c) => `
          <div class="tvp-swatch ${this.opts.subtitleColor === c ? 'selected' : ''}" style="background:${c}" data-subcolor="${c}"></div>`).join('') +
          `<div class="tvp-swatch" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" data-subcolor-custom title="Custom color"></div>
        </div>`;

      html += `<div class="tvp-menu-sep"></div>`;

      if (qualityLevels && qualityLevels.length) {
        html += `<div class="tvp-menu-title">Quality</div>
          <div class="tvp-menu-item" data-quality="-1"><span>Auto</span></div>` +
          qualityLevels.map((lvl, i) => `<div class="tvp-menu-item" data-quality="${i}"><span>${lvl.height}p</span></div>`).join('');
        html += `<div class="tvp-menu-sep"></div>`;
      }

      html += `<div class="tvp-toggle-row">
          <span>Auto-play next</span>
          <div class="tvp-toggle ${this.opts.autoplayNext ? 'on' : ''}" data-role="autoplay-toggle"><div class="knob"></div></div>
        </div>`;

      panel.innerHTML = html;

      panel.querySelectorAll('[data-subsize]').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation(); this.setSubtitleSize(el.dataset.subsize); this._renderSettingsMenu(qualityLevels);
      }));
      panel.querySelectorAll('[data-subcolor]').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation(); this.setSubtitleColor(el.dataset.subcolor); this._renderSettingsMenu(qualityLevels);
      }));
      const customSwatch = panel.querySelector('[data-subcolor-custom]');
      if (customSwatch) customSwatch.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'color';
        input.value = this.opts.subtitleColor;
        input.addEventListener('input', () => this.setSubtitleColor(input.value));
        input.click();
      });
      if (qualityLevels) {
        panel.querySelectorAll('[data-quality]').forEach((el) => el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this._state.hls) this._state.hls.currentLevel = parseInt(el.dataset.quality, 10);
          panel.classList.remove('open');
        }));
      }
      const autoplayToggle = panel.querySelector('[data-role="autoplay-toggle"]');
      autoplayToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.autoplayNext = !this.opts.autoplayNext;
        this._renderSettingsMenu(qualityLevels);
      });
    }

    _renderQualityOptions(levels) { this._renderSettingsMenu(levels); }

    // ---- UI sync helpers ------------------------------------------------
    _setSeekBarRatio(ratio) {
      ratio = Math.max(0, Math.min(1, ratio || 0));
      this.$('.tvp-seek-played').style.width = `${ratio * 100}%`;
      this.$('.tvp-seek-handle').style.left = `${ratio * 100}%`;
    }
    _syncSeekUi() {
      const d = this.video.duration || 0;
      const c = this.video.currentTime || 0;
      this._setSeekBarRatio(d ? c / d : 0);
      this.$('[data-role="time-current"]').textContent = fmtTime(c);
      this.$('[data-role="time-duration"]').textContent = fmtTime(d);
    }
    _syncBufferedUi() {
      const d = this.video.duration || 0;
      if (!d || !this.video.buffered.length) return;
      const end = this.video.buffered.end(this.video.buffered.length - 1);
      this.$('.tvp-seek-buffered').style.width = `${Math.min(100, (end / d) * 100)}%`;
    }
    _syncVolumeUi() {
      const v = this.video;
      const pct = v.muted ? 0 : Math.round(v.volume * 100);
      this.$('[data-role="vol-slider"]').value = pct;
      const btn = this.$('[data-action="mute"]');
      btn.innerHTML = (pct === 0) ? ICONS.volMute : ICONS.volHigh;
    }

    _showStatus(kind, title, detail) {
      const box = this.$('.tvp-status');
      box.classList.add('show');
      box.querySelector('.tvp-spinner').style.display = kind === 'loading' ? 'block' : 'none';
      box.querySelector('.tvp-err-title').textContent = title || '';
      box.querySelector('.tvp-err-detail').textContent = detail || '';
    }
    _hideStatus() { this.$('.tvp-status').classList.remove('show'); }

    _flashTally(text) {
      const tally = this.$('.tvp-tally');
      tally.querySelector('.tvp-tally-text').textContent = text;
      tally.classList.add('show');
      clearTimeout(this._tallyTimer);
      this._tallyTimer = setTimeout(() => tally.classList.remove('show'), 1800);
    }

    // ---- Controls auto-hide ---------------------------------------------
    _showControls() { this.container.classList.remove('tvp-hide-controls'); }
    _resetHideTimer(stayVisible = false, delay = 4000) {
      this._showControls();
      clearTimeout(this._state.hideTimer);
      if (stayVisible || this.video.paused || this._state.menuOpen) return;
      this._state.hideTimer = setTimeout(() => {
        if (!this._state.draggingSeek && !this._state.draggingVolume && !this._state.menuOpen && !this.video.paused) {
          this.container.classList.add('tvp-hide-controls');
        }
      }, delay);
    }

    // ---- PiP / theater / fullscreen --------------------------------------
    _togglePip() {
      if (!document.pictureInPictureEnabled) { this.emit('error', 'Picture-in-picture is not supported in this browser.'); return; }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      } else {
        this.video.requestPictureInPicture().catch((e) => this.emit('error', e.message));
      }
    }

    _toggleTheater() {
      this.container.classList.toggle('tvp-theater');
    }

    _toggleFullscreen() {
      const el = this.container;
      const isFs = document.fullscreenElement || document.webkitFullscreenElement;
      if (!isFs) {
        (el.requestFullscreen || el.webkitRequestFullscreen).call(el)
          .then(() => this._tryLockOrientation())
          .catch((e) => this.emit('error', e.message));
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        this._unlockOrientation();
      }
    }
    _onFullscreenChange() {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      this.$('[data-action="fullscreen"]').innerHTML = isFs ? ICONS.fsExit : ICONS.fsEnter;
      this.emit('fullscreenChange', isFs);
      if (!isFs) this._unlockOrientation();
    }
    _tryLockOrientation() {
      // Best-effort: most browsers only allow orientation lock inside an
      // installed PWA / same-origin fullscreen context, and will reject
      // this silently otherwise — that's expected, not a bug.
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').then(() => {
          this._state.rotationLocked = true;
        }).catch(() => { /* not permitted in this context — ignore */ });
      }
    }
    _unlockOrientation() {
      if (this._state.rotationLocked && screen.orientation && screen.orientation.unlock) {
        try { screen.orientation.unlock(); } catch (e) { /* ignore */ }
        this._state.rotationLocked = false;
      }
    }

    _resizeObserver() {
      // Re-flow tooltip/handle position on resize (no-op hook kept simple;
      // percentage-based CSS handles most of this already).
      window.addEventListener('resize', () => this._syncSeekUi());
    }

    destroy() {
      this._clearHls();
      clearTimeout(this._state.hideTimer);
      clearTimeout(this._tallyTimer);
    }
  }

  // ---------------------------------------------------------------------
  // Spec-shaped convenience export: PlayerModule.init(videoElement)
  // Wraps TVPlayer so callers who just want the flat API from the brief
  // can use it directly. For multi-instance use (e.g. this demo, which
  // runs two players side by side to simulate two peers), prefer
  // `new TVPlayer(container, options)` directly.
  // ---------------------------------------------------------------------
  const PlayerModule = {
    /** @returns {TVPlayer} */
    init(videoElementOrContainer, options) {
      return new TVPlayer(videoElementOrContainer, options);
    },
  };

  global.TVPlayer = TVPlayer;
  global.PlayerModule = PlayerModule;
})(typeof window !== 'undefined' ? window : this);
