import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import nipplejs from 'nipplejs';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { World } from './World.js';
import { games, likePercentage, getFilteredGames } from './gamesData.js';
import { Player, createPlayerMesh } from './Player.js';
import { RemotePlayer } from './RemotePlayer.js';
import { InputManager } from './InputManager.js';
import { boxUnwrapUVs, surfaceManager, createFaceTexture, createTorsoTexture } from './utils.js';
import { publishGame, fetchGames, incrementVisit, uploadThumbnail, saveAvatar, loadAvatar, fetchMarketplaceListings, createMarketplaceListing, uploadTshirtImage } from './supabase.js';



/*
  TOMBSTONE / REFACTOR NOTE

  src/main.js was becoming a monolithic file orchestrating many subsystems (UI, input, studio,
  world management, networking, hat editor, hat modeler, pet shop, forum, reviews, and more).
  To make ongoing development manageable, large feature blocks should be extracted into focused
  modules (e.g., ui/, studio/, gameplay/, hats/, shop/, forum/). The file below retains all
  original behavior but now includes markers indicating where extraction is recommended.

  // removed in-file large helper groups (hat modeler toolbar, extensive UI build blocks, long
  // interactive subsystems). Consider moving into:
  //   src/ui/*.js, src/gameplay/*.js, src/studio/*.js, src/hats/*.js
*/

/*
  Supabase Realtime-backed multiplayer presence room.
  Exposes the same minimal API the rest of the app already uses:
    room.clientId          – stable random id for this session
    room.presence          – map of { [clientId]: presenceObj }
    room.initialize()      – subscribe to the default channel
    room.updatePresence(p) – merge p into own presence and broadcast
    room.subscribePresence(cb) – called on every presence change
    room.send(obj)         – broadcast a message to peers (chat, etc.)
    room.onmessage         – set to a function to receive messages
*/
function generateClientId() {
    return 'c-' + Math.random().toString(36).slice(2, 10);
}

const room = (function () {
    const clientId = generateClientId();
    const presence = {};           // { [id]: presencePayload }
    const roomState = {};
    const peers = {};
    const presenceSubscribers = [];
    let _channel = null;           // active Supabase Realtime channel
    let _currentRoom = 'global';

    // --- helpers ---
    function _notifyPresence() {
        const snap = Object.assign({}, presence);
        for (const cb of presenceSubscribers) {
            try { cb(snap); } catch (e) {}
        }
    }

    // --- public API ---
    async function initialize() {
        try {
            const { getSupabase } = await import('./supabase.js');
            const sb = await getSupabase();
            await _joinChannel(sb, _currentRoom);
        } catch (e) {
            console.warn('[room] Supabase Realtime init failed (offline mode):', e);
        }
        return Promise.resolve();
    }

    async function _joinChannel(sb, roomName) {
        // Leave old channel cleanly
        if (_channel) {
            try { await sb.removeChannel(_channel); } catch (e) {}
            _channel = null;
        }
        _currentRoom = roomName;

        const ch = sb.channel(`faundry:${roomName}`, {
            config: { presence: { key: clientId } }
        });

        // Track own presence
        ch.on('presence', { event: 'sync' }, () => {
            const state = ch.presenceState();
            // Clear non-self peers
            for (const k in presence) {
                if (k !== clientId) delete presence[k];
            }
            for (const key in state) {
                const payloads = state[key];
                if (payloads && payloads.length > 0) {
                    presence[key] = payloads[0];
                }
            }
            _notifyPresence();
        });

        ch.on('presence', { event: 'join' }, ({ key, newPresences }) => {
            if (newPresences && newPresences.length > 0) {
                presence[key] = newPresences[0];
                _notifyPresence();
            }
        });

        ch.on('presence', { event: 'leave' }, ({ key }) => {
            delete presence[key];
            _notifyPresence();
        });

        // Broadcast messages (chat, friend requests, etc.)
        ch.on('broadcast', { event: 'msg' }, ({ payload }) => {
            if (payload && payload._from !== clientId) {
                try {
                    if (typeof room.onmessage === 'function') {
                        // Normalize to match legacy evt shape: { clientId, data }
                        room.onmessage({ clientId: payload._from, from: payload._from, data: payload });
                    }
                } catch (e) {}
            }
        });

        await ch.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                // Track own presence with current local data
                const own = presence[clientId] || {};
                await ch.track({ ...own, _clientId: clientId });
            }
        });

        _channel = ch;
    }

    function updatePresence(p) {
        presence[clientId] = { ...(presence[clientId] || {}), ...p, _clientId: clientId };
        if (_channel) {
            _channel.track(presence[clientId]).catch(() => {});
        }
        _notifyPresence();
    }

    function updateRoomState(s) { Object.assign(roomState, s); }
    function requestPresenceUpdate() {}

    function subscribePresence(cb) {
        presenceSubscribers.push(cb);
        try { cb(Object.assign({}, presence)); } catch (e) {}
        return () => {
            const i = presenceSubscribers.indexOf(cb);
            if (i >= 0) presenceSubscribers.splice(i, 1);
        };
    }

    function subscribeRoomState(cb) {
        try { cb(Object.assign({}, roomState)); } catch (e) {}
        return () => {};
    }

    function subscribePresenceUpdateRequests() { return () => {}; }

    function send(obj) {
        if (_channel) {
            _channel.send({
                type: 'broadcast',
                event: 'msg',
                payload: { ...obj, _from: clientId }
            }).catch(() => {});
        }
    }

    // Public: switch to a named room channel and wait until subscribed.
    // Call this BEFORE updatePresence so track() lands on the correct channel.
    async function switchRoom(newRoomName) {
        if (!newRoomName || newRoomName === _currentRoom) return;
        try {
            const { getSupabase } = await import('./supabase.js');
            const sb = await getSupabase();
            await _joinChannel(sb, newRoomName);
        } catch (e) {
            console.warn('[room] channel switch failed:', e);
        }
    }

    return {
        presence,
        roomState,
        peers,
        clientId,
        initialize,
        updatePresence,
        updateRoomState,
        requestPresenceUpdate,
        subscribePresence,
        subscribeRoomState,
        subscribePresenceUpdateRequests,
        switchRoom,
        send,
        onmessage: null
    };
})();

const UI_ZOOM = 1.0; // Avoid CSS zoom mismatch; use 1:1 coordinates for mouse/UI

const scene = new THREE.Scene();

// Camera setup
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.imageRendering = 'auto';

// Lightweight UI for fatal errors and WebGL detection
function showFatalOverlay(title, details) {
    // Remove existing overlay if present
    const existing = document.getElementById('__nblox_fatal_overlay');
    if (existing) existing.remove();

    const ov = document.createElement('div');
    ov.id = '__nblox_fatal_overlay';
    ov.style.position = 'fixed';
    ov.style.left = '0';
    ov.style.top = '0';
    ov.style.width = '100%';
    ov.style.height = '100%';
    ov.style.zIndex = '999999';
    ov.style.display = 'flex';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';
    ov.style.background = 'linear-gradient(180deg, rgba(0,0,0,0.85), rgba(0,0,0,0.95))';
    ov.style.color = '#fff';
    ov.style.fontFamily = 'sans-serif';
    ov.style.padding = '20px';
    ov.style.boxSizing = 'border-box';

    const card = document.createElement('div');
    card.style.maxWidth = '920px';
    card.style.width = 'min(92vw, 920px)';
    card.style.background = '#121212';
    card.style.border = '1px solid #444';
    card.style.borderRadius = '8px';
    card.style.padding = '18px';
    card.style.boxShadow = '0 10px 30px rgba(0,0,0,0.6)';

    const h = document.createElement('h2');
    h.textContent = title;
    h.style.margin = '0 0 8px 0';
    h.style.fontSize = '20px';
    card.appendChild(h);

    const p = document.createElement('pre');
    p.style.whiteSpace = 'pre-wrap';
    p.style.wordBreak = 'break-word';
    p.style.margin = '0';
    p.style.fontSize = '13px';
    p.style.color = '#ffd';
    p.textContent = details || 'Unknown error.';
    card.appendChild(p);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.marginTop = '12px';

    const btn = document.createElement('button');
    btn.textContent = 'Reload';
    btn.className = 'menu-btn';
    btn.style.padding = '6px 12px';
    btn.onclick = () => location.reload();
    btnRow.appendChild(btn);

    card.appendChild(btnRow);
    ov.appendChild(card);
    document.body.appendChild(ov);
}

// Basic WebGL availability check; graceful fallback if unavailable
let __webgl_ok = true;
try {
    const gl = renderer.getContext && renderer.getContext();
    if (!gl) {
        __webgl_ok = false;
    }
} catch (e) {
    __webgl_ok = false;
}
if (!__webgl_ok) {
    // Stop the rest of the module from attempting heavy work
    showFatalOverlay('WebGL Unavailable', 'Your browser does not appear to support WebGL context; the 3D portion of the app cannot run. Try enabling WebGL or use a different browser. Click Reload to try again.');
    // Keep UI HTML accessible (menus still in DOM) and bail out of 3D initialization by throwing a controlled error
    throw new Error('WebGL not available');
}

// Global uncaught error / rejection handlers to show helpful overlay instead of silent black screen
window.addEventListener('error', (ev) => {
    try {
        const msg = (ev && ev.error && ev.error.stack) ? ev.error.stack : (ev.message || String(ev));
        showFatalOverlay('Unhandled Error', msg);
    } catch(e){}
});

window.addEventListener('unhandledrejection', (ev) => {
    try {
        const reason = ev.reason ? (ev.reason.stack || ev.reason) : 'Unhandled promise rejection';
        showFatalOverlay('Unhandled Promise Rejection', String(reason));
    } catch(e){}
});

 // Request pointer lock when clicking the game canvas while playing
 renderer.domElement.addEventListener('mousedown', (e) => {
     // If we've recently left a game, ignore immediate clicks that would re-lock / re-enter.
     if (Date.now() < (suppressAutoJoinUntil || 0)) return;

     // If we've flagged preventAutoRejoin, consume one click and do not re-enter; clear the flag so future clicks behave normally.
     if (preventAutoRejoin) { preventAutoRejoin = false; return; }

     if ((gameState === 'PLAYING' || gameState === 'TEST') && e.button === 0) {
         if (!document.pointerLockElement) {
             try {
                 const p = renderer.domElement.requestPointerLock();
                 // Some browsers return a Promise; handle rejection to avoid unhandled rejections when gesture is absent
                 if (p && typeof p.then === 'function') p.catch(() => {});
             } catch (err) {
                 // Ignore failures (likely due to missing user gesture)
             }
         }
     }
 });

/*
  Safe UI element access helper:
  Replaces direct getElementById usage with getEl(id) which returns either the element
  or a safe stub object (so later property sets/calls won't throw when markup is missing).
*/
function getEl(id) {
    // Try the real element first (use original getter)
    const real = document.querySelector(`#${CSS.escape(id)}`);
    if (real) return real;

    // Return a lightweight stub that safely absorbs common UI operations
    const stub = {
        id,
        style: {},
        dataset: {},
        classList: {
            add: () => {},
            remove: () => {}
        },
        appendChild: () => {},
        remove: () => {},
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        setAttribute: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0 }),
        focus: () => {},
        blur: () => {},
        // textContent used widely
        textContent: '',
        // value used for inputs
        value: '',
        // disabled used for buttons
        disabled: false
    };
    return stub;
}

// Monkey-patch document.getElementById so future direct calls return either the real element
// or a safe stub produced by getEl. This prevents "Cannot set properties of null" crashes when
// markup is missing or altered.
(function ensureSafeGetElementById() {
    try {
        const original = document.getElementById.bind(document);
        document.getElementById = function(id) {
            const r = original(id);
            if (r) return r;
            return getEl(id);
        };
    } catch (e) {
        // If patching fails for any reason, silently continue (we still have getEl available)
        console.warn('Failed to monkey-patch getElementById:', e);
    }
})();

// Developer helper: create safe minimal DOM stubs for commonly referenced IDs
// This can be used when the page markup is altered so code that assumes those elements exists
// doesn't throw "Cannot set properties of null".
function createMissingDOMStubs() {
    const ids = [
        'input-username','input-age','btn-save-name','chat-container','chat-history','chat-input',
        'start-menu','play-menu','creator-menu','customize-menu','settings-menu','player-list',
        'plist-content','studio-gui','zone_joystick','btn-mobile-jump','pet-shop','pet-list',
        'btn-open-pets','lucky-hud','coin-count','silly-hud','silly-points-display','creator-console',
        'creator-code','btn-creator','btn-play','btn-studio','btn-close-start','btn-close-gd'
    ];
    ids.forEach(id => {
        if (!document.getElementById(id)) {
            let el;
            // choose element type by simple heuristics
            if (id.includes('input') || id.includes('chat-input') || id.includes('creator-code')) {
                el = document.createElement(id.includes('creator-code') ? 'textarea' : 'input');
                el.type = 'text';
            } else if (id.endsWith('-menu') || id.endsWith('-gui') || id === 'player-list' || id === 'pet-shop' || id === 'creator-menu' || id === 'customize-menu') {
                el = document.createElement('div');
            } else if (id.startsWith('btn-') || id.includes('btn-')) {
                el = document.createElement('button');
                el.textContent = id;
            } else {
                el = document.createElement('div');
            }
            el.id = id;
            // hide helper stubs visually but keep them in DOM for scripts
            el.style.display = 'none';
            document.body.appendChild(el);
        }
    });
    // also ensure chat history exists as a container
    if (!document.getElementById('chat-history')) {
        const ch = document.createElement('div');
        ch.id = 'chat-history';
        ch.style.display = 'none';
        document.body.appendChild(ch);
    }
    // ensure chat input exists and has key handlers safe
    if (!document.getElementById('chat-input')) {
        const ci = document.createElement('input');
        ci.id = 'chat-input';
        ci.type = 'text';
        ci.style.display = 'none';
        document.body.appendChild(ci);
    }
    return true;
}

// Create a small floating dev button that runs createMissingDOMStubs()
// This gives a one-click recovery for missing-DOM errors during development/testing.
(function addOneClickFixButton() {
    try {
        if (document.getElementById('__nblox_one_click_fix')) return;
        const btn = document.createElement('button');
        btn.id = '__nblox_one_click_fix';
        btn.textContent = 'Fix Null Errors';
        btn.title = 'Create safe DOM stubs for missing elements (dev)';
        btn.style.position = 'fixed';
        btn.style.right = '12px';
        btn.style.bottom = '12px';
        btn.style.zIndex = '1000000';
        btn.style.padding = '8px 10px';
        btn.style.background = '#ffcc66';
        btn.style.border = '1px solid #444';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.className = 'menu-btn';

        btn.addEventListener('click', () => {
            const ok = createMissingDOMStubs();
            if (ok) {
                try { playSwitch(); } catch(e){} // optional feedback sound if available
                alert('Missing DOM stubs created. This should prevent "Cannot set properties of null" errors from missing UI elements.');
            } else {
                alert('Failed to create stubs.');
            }
        });

        document.body.appendChild(btn);
    } catch (e) {
        console.warn('Failed to add one-click fix button', e);
    }
})();

 // UI Elements (Moved to top to prevent ReferenceError)
 // Ensure missing DOM stubs exist before we capture elements so later code won't set properties on null.
 createMissingDOMStubs();
 
 const startMenu = getEl('start-menu');
 const playMenu = getEl('play-menu');
 const forumMenu = getEl('forum-menu');
 const gameDetailMenu = getEl('game-detail-menu');
 const custMenu = getEl('customize-menu');
 const settingsMenu = getEl('settings-menu');
 const chatContainer = getEl('chat-container');
 // Use the actual HUD element IDs present in the page so .click() exists
 const btnExit = getEl('btn-leave-game'); // in-game Leave button
 const btnReset = getEl('btn-reset-character'); // in-game Reset Character button
 // New game menu button (single HUD menu)
 const btnGameMenu = getEl('btn-game-menu');
 const playerList = getEl('player-list');
 const playerListContent = getEl('plist-content');
 const chatInput = getEl('chat-input');
 const chatHistory = getEl('chat-history');
 const studioGui = getEl('studio-gui');
 const btnPlaySolo = getEl('tool-play-solo');
 const btnStopTest = getEl('btn-stop-test');
 const explorerList = getEl('explorer-list');
// New UI: Catalog button from launcher
/* Holiday/Theming system: changes launcher appearance based on date (seasonal & holidays).
   Also expose a helper to refresh theme when menus open. */
function formatThemeName(name) {
    return name.charAt(0).toUpperCase() + name.slice(1);
}
function applyHolidayTheme(targetEl = startMenu) {
    // Disabled: holiday themes removed — keep minimal consistent panel defaults.
    try {
        const title = targetEl.querySelector('.xp-title-bar');
        const body = targetEl.querySelector('.xp-body');
        if (title) title.style.background = 'linear-gradient(to right, #3a6ea5, #2b5797)';
        if (body) body.style.background = '#ece9d8';
        targetEl.style.borderColor = '#8c8c8c';
    } catch (e) {
        console.warn('applyHolidayTheme no-op', e);
    }
}

 // Apply theme initially (ensures launcher looks themed on page load)
 // Respect saved user theme preference: 'auto' = date-based, otherwise force chosen theme
function setThemeForAll(themeKey) {
    const applyTo = [
        startMenu,
        playMenu,
        gameDetailMenu,
        settingsMenu,
        forumMenu,
        custMenu,
        getEl('player-list'),
        getEl('pet-shop')
    ].filter(Boolean);

    applyTo.forEach(el => {
        if (!el) return;

        const title = el.querySelector('.xp-title-bar');
        const body = el.querySelector('.xp-body');

        // Reset defaults
        if (title) {
            title.style.color = '#ffffff';
            title.style.background = 'linear-gradient(to right, #6b6b6b, #4f4f4f)';
        }
        // Preserve existing background images for sidebar-like panes: don't overwrite background-image
        try {
            // Consider the element itself and common child panes which may carry artwork:
            // - .menu-popup (used for full-panel backgrounds)
            // - .sidebar (used directly as a sidebar panel)
            // - .xp-body (standard content body)
            const elComp = window.getComputedStyle(el);
            // Treat known sidebar panels as having a persistent artwork background so we don't
            // accidentally overwrite the launcher's preview image while it loads.
            let hasBgImage = elComp && elComp.backgroundImage && elComp.backgroundImage !== 'none';

            // If this element is a .sidebar, assume it has artwork to preserve immediately.
            if (el.classList && el.classList.contains('sidebar')) hasBgImage = true;

            // Check common children that can host the launcher/explorer artwork so we don't clobber it.
            const popup = el.querySelector('.menu-popup');
            const sidebarChild = el.classList && el.classList.contains('sidebar') ? el : el.querySelector('.sidebar');
            const bodyChild = el.querySelector('.xp-body');

            const childCandidates = [popup, sidebarChild, bodyChild];
            for (const c of childCandidates) {
                if (!c) continue;
                try {
                    const cs = window.getComputedStyle(c);
                    if (cs && cs.backgroundImage && cs.backgroundImage !== 'none') {
                        hasBgImage = true;
                        break;
                    }
                } catch (e) {
                    // ignore per-child failures
                }
            }

            const isSidebar = el.classList && el.classList.contains('sidebar');

            // Only override the body's background when neither the element nor its common pane children
            // already provide a background image. If any background image exists, preserve it and only
            // ensure a readable fallback color.
            if (!isSidebar && !hasBgImage) {
                if (body) body.style.background = 'transparent';
            } else {
                if (body) body.style.backgroundColor = 'transparent';
            }
            if (body) body.style.color = '#111';
        } catch (e) {
            if (body) body.style.background = 'transparent';
            if (body) body.style.color = '#111';
        }
        el.style.borderColor = '#8b8b8b';
        el.style.boxShadow = '0 4px 8px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.03)';

        const applyButtonAccent = (accentBg, accentColor) => {
            document.querySelectorAll('.menu-btn, .xp-button, .hud-btn, #dev-menu button, #btn-cust-done').forEach(b => {
                b.style.background = accentBg;
                b.style.color = accentColor;
            });
        };

        switch (themeKey) {
            case 'default':
                // Subtle modern grey-blue gradient for default theme
                if (title) title.style.background = 'linear-gradient(135deg, #2b6ea5 0%, #7fb3d5 100%)';
                if (body) body.style.background = 'linear-gradient(180deg, #f3f6fb 0%, #e6eef8 60%)';
                applyButtonAccent('linear-gradient(180deg, #ffffff, #dfeffb)', '#05233a');
                // Slight card lift for pop
                try { el.style.boxShadow = '0 8px 18px rgba(12,34,56,0.12)'; } catch(e){}
                break;
            case 'retrostudio':
                if (title) title.style.background = 'linear-gradient(to right, #4da6ff, #2b9eff)';
                // Light-blue launcher body by default
                if (body) body.style.background = '#e8f5ff';
                applyButtonAccent('linear-gradient(to bottom, #e6f9ff, #d6f0ff)', '#08335f');
                break;
            case 'darkgrey':
                if (title) title.style.background = 'linear-gradient(to right, #2b2b2b, #1f1f1f)';
                if (body) body.style.background = '#222222';
                applyButtonAccent('linear-gradient(to bottom, #444, #2b2b2b)', '#fff');
                break;
            case 'darkpurple':
                // Dark purple remastered theme: rich deep purples with high-contrast accents
                if (title) title.style.background = 'linear-gradient(135deg, #2e0b3a 0%, #4b1a66 100%)';
                if (body) body.style.background = 'linear-gradient(180deg, #0e0620 0%, #20102b 60%)';
                applyButtonAccent('linear-gradient(180deg,#3a0f4a,#5b1d78)', '#ffffff');
                // subtle glass effect and refined border tint
                try {
                    el.style.backdropFilter = 'saturate(1.05) blur(6px)';
                    el.style.borderColor = '#4b1a66';
                } catch(e){}

                // Ensure decorative overlays don't clash: remove heart overlay if present and use subtle vignette
                try {
                    if (el._heartOverlay) {
                        el._heartOverlay.remove();
                        el._heartOverlay = null;
                    }
                    if (!el._vignette) {
                        const vign = document.createElement('div');
                        vign.style.position = 'absolute';
                        vign.style.left = '0';
                        vign.style.top = '0';
                        vign.style.width = '100%';
                        vign.style.height = '100%';
                        vign.style.pointerEvents = 'none';
                        vign.style.zIndex = '0';
                        vign.style.background = 'radial-gradient(ellipse at center, rgba(255,255,255,0.02), rgba(0,0,0,0.35))';
                        vign.style.borderRadius = getComputedStyle(el).borderRadius || '6px';
                        el.style.position = el.style.position || 'relative';
                        el.insertBefore(vign, el.firstChild);
                        el._vignette = vign;
                    }
                    if (body) body.style.position = 'relative';
                    if (title) title.style.position = 'relative';
                } catch (e) {
                    console.warn('Failed to apply darkpurple overlay:', e);
                }
                break;
            case 'grey':
            default:
                if (title) title.style.background = 'linear-gradient(to right, #6b6b6b, #4f4f4f)';
                if (body) body.style.background = 'transparent';
                applyButtonAccent('linear-gradient(to bottom, #efefef, #d4d4d4)', '#111');
                break;
        }

        try {
            if (!el._themeLabel) {
                const lab = document.createElement('div');
                lab.style.position = 'absolute';
                lab.style.right = '12px';
                lab.style.bottom = '8px';
                lab.style.fontSize = '11px';
                lab.style.color = '#333';
                lab.style.opacity = '0.8';
                lab.style.pointerEvents = 'none';
                el._themeLabel = lab;
                el.appendChild(lab);
            }
            if (el._themeLabel) {
                el._themeLabel.textContent = `Theme: ${themeKey === 'grey' ? 'Grey' : (themeKey.charAt(0).toUpperCase() + themeKey.slice(1))}`;
            }
        } catch (e) {
            console.warn('Failed to apply theme label', e);
        }
    });
}

let savedThemePref = 'darkpurple';
try {
    // Respect stored preference if present, otherwise default to light red theme
    savedThemePref = localStorage.getItem('chirpless_theme_pref') || 'lightred';
} catch(e){ savedThemePref = 'lightred'; }

try {
    setThemeForAll(savedThemePref);
    // Start menu music immediately when the launcher is shown
    try {
        // Start the shuffled playlist for launcher background music
        startMenuPlaylist();
        // Ensure any UI audio contexts resume if required
        tryPlayBGM();
    } catch (e) {
        console.warn('Failed to start menu music on launch:', e);
    }
} catch (e) {
    console.warn('setThemeForAll failed:', e);
}

// Try to start menu music immediately and also register a one-time user-gesture fallback
try {
    // Attempt to start right away (may be blocked by browser autoplay policies)
    startMenuPlaylist();
    tryPlayBGM();
} catch (e) {
    console.warn('Initial menu BGM start attempt failed:', e);
}

// Many browsers require a user gesture to start audio. Register a one-time pointerdown
// to resume audio contexts and ensure the playlist begins as soon as the user interacts.
document.addEventListener('pointerdown', async function _unlockAudioOnce() {
    try {
        // Resume UI audio context used for UI sounds
        if (uiAudioCtx && uiAudioCtx.state === 'suspended') {
            await uiAudioCtx.resume().catch(()=>{});
        }
        // Resume any other AudioContexts that might be suspended (player/game)
        try { if (player && player.audioCtx && player.audioCtx.state === 'suspended') await player.audioCtx.resume().catch(()=>{}); } catch(e){}
        try { if (world && world.bgm && typeof world.bgm === 'string') { /* nothing */ } } catch(e){}

        // If menu playlist isn't playing, start it now (guaranteed by user gesture)
        if (!menuBGM.playing) {
            startMenuPlaylist();
        } else if (menuBGM.audio && menuBGM.audio.paused) {
            // If an <audio> instance exists but is paused due to autoplay block, try to play it
            try { await menuBGM.audio.play().catch(()=>{}); } catch(e){}
        }
    } catch (err) {
        console.warn('Audio unlock handler error:', err);
    } finally {
        // Remove listener (once)
        document.removeEventListener('pointerdown', _unlockAudioOnce, true);
    }
}, { once: true, capture: true });

// Populate Settings theme select and bind change handler (deferred until DOM ready)
setTimeout(() => {
    const sel = document.getElementById('set-theme');
    if (!sel) return;
    // Set initial select value
    sel.value = savedThemePref || 'auto';

    sel.addEventListener('change', (ev) => {
        const val = sel.value || 'auto';
        try {
            localStorage.setItem('chirpless_theme_pref', val);
        } catch (e) {}
        // Apply immediately to key UI panes
        setThemeForAll(val);
        playSwitch();
    });
}, 50);

// New UI: Catalog button from launcher


/* Scene Lights (default + studio variants) */
const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(20, 50, 20);
scene.add(sun);

// Studio lighting set (key, fill, rim) - created but not enabled until studio mode.
// We'll toggle these for a clearer modeling view in the studio.
let studioLights = {
    key: null,
    fill: null,
    rim: null,
    helperGroup: null
};

function addStudioLights() {
    if (studioLights.key) return; // already added

    // Key light - warm directional
    const key = new THREE.DirectionalLight(0xfff1e0, 1.0);
    key.position.set(30, 50, 30);
    key.castShadow = false;
    key.name = 'studio_key';

    // Fill light - soft cool hemisphere
    const fill = new THREE.HemisphereLight(0x88baff, 0x222233, 0.6);
    fill.name = 'studio_fill';

    // Rim light - subtle back rim for silhouette
    const rim = new THREE.DirectionalLight(0xffffff, 0.45);
    rim.position.set(-30, 40, -20);
    rim.name = 'studio_rim';

    // Optional small helpers group (non-shadowing) for easy removal
    const helperGroup = new THREE.Group();
    helperGroup.name = 'studio_light_helpers';
    scene.add(helperGroup);

    scene.add(key);
    scene.add(fill);
    scene.add(rim);

    studioLights.key = key;
    studioLights.fill = fill;
    studioLights.rim = rim;
    studioLights.helperGroup = helperGroup;

    // Slightly boost ambient for studio readability
    ambient.intensity = 0.45;
    sun.visible = false;
}

function removeStudioLights() {
    if (!studioLights.key) return;

    // Remove lights from scene
    if (studioLights.key) scene.remove(studioLights.key);
    if (studioLights.fill) scene.remove(studioLights.fill);
    if (studioLights.rim) scene.remove(studioLights.rim);
    if (studioLights.helperGroup) scene.remove(studioLights.helperGroup);

    // Clear refs
    studioLights.key = null;
    studioLights.fill = null;
    studioLights.rim = null;
    studioLights.helperGroup = null;

    // Restore ambient/sun defaults
    ambient.intensity = 0.7;
    sun.visible = true;
}

// Init World
const world = new World(scene);
let currentMapName = 'platform';

// Menu Environment
const menuGroup = new THREE.Group();
scene.add(menuGroup);

// --- Create Mini Platform for Menu ---
const menuHeight = 1;
const menuCenterSize = 4;

// Materials (White Center, Grey Rims)
const menuCenterMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.studs,
    color: new THREE.Color(0xffffff), 
    roughness: 0.6, metalness: 0.1
});
const menuInletMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.inlet,
    color: new THREE.Color(0xffffff), 
    roughness: 0.6, metalness: 0.1
});
const menuCenterMats = [menuCenterMat, menuCenterMat, menuCenterMat, menuInletMat, menuCenterMat, menuCenterMat];

const menuRimColor = new THREE.Color(0x888888);
const menuRimMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.studs,
    color: menuRimColor, roughness: 0.8
});
const menuRimInletMat = new THREE.MeshStandardMaterial({
    map: surfaceManager.textures.inlet,
    color: menuRimColor, roughness: 0.8
});
const menuRimMats = [menuRimMat, menuRimMat, menuRimMat, menuRimInletMat, menuRimMat, menuRimMat];

// Center Mesh (4x4)
const menuCenterGeo = new THREE.BoxGeometry(menuCenterSize, menuHeight, menuCenterSize);
boxUnwrapUVs(menuCenterGeo);
const menuCenterMesh = new THREE.Mesh(menuCenterGeo, menuCenterMats);
menuCenterMesh.position.set(0, -menuHeight/2, 0); 
menuGroup.add(menuCenterMesh);

// Rims
const addMenuRim = (w, h, d, x, y, z) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    boxUnwrapUVs(geo);
    const mesh = new THREE.Mesh(geo, menuRimMats);
    mesh.position.set(x, y, z);
    menuGroup.add(mesh);
};

const rimLen = menuCenterSize + 2; // 6
// Front/Back (Z axis)
addMenuRim(rimLen, menuHeight, 1, 0, -menuHeight/2, -(menuCenterSize+1)/2); // Back
addMenuRim(rimLen, menuHeight, 1, 0, -menuHeight/2, (menuCenterSize+1)/2);  // Front
// Left/Right (X axis, fitting between Z rims)
addMenuRim(1, menuHeight, menuCenterSize, -(menuCenterSize+1)/2, -menuHeight/2, 0); // Left
addMenuRim(1, menuHeight, menuCenterSize, (menuCenterSize+1)/2, -menuHeight/2, 0);  // Right

// Position the whole group so the top surface (y=0) is at player feet (y=0) at x=5
menuGroup.position.set(3.5, 1.5, 8);


// Init Player
const player = new Player(scene);
window.player = player; // expose local player globally so chat/bubble logic can reference it reliably
const remotePlayers = {}; // Changed to Object for ID mapping

 // Lucky World local state: coins and pets
let playerCoins = 0;
let playerPets = []; // { id, mesh }
const petCatalog = [
    { id: 'pet-bunny', name: 'Bunny', price: 5, color: 0xff99cc },
    { id: 'pet-drake', name: 'Drake', price: 12, color: 0x66ccff },
    { id: 'pet-fox', name: 'Lucky Fox', price: 20, color: 0xffaa33 }
];

// SillyVille state: planted seeds and points
let sillyPoints = 0;
let sillySeedParts = []; // planted seed meshes
let sillySeedTypes = ['Strawberry', 'Banana', 'Blueberry', 'Apple', 'Cherry', 'Pumpkin'];
let sillyNextSeedIndex = 0; // cycle through types for planting
let sillyPointsAcc = 0; // fractional accumulator for per-second awarding

function showPetShop() {
    const shop = document.getElementById('pet-shop');
    const list = document.getElementById('pet-list');
    shop.style.display = 'block';
    list.innerHTML = '';
    petCatalog.forEach(p => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
            <div style="width:36px;height:24px;background:${'#' + new THREE.Color(p.color).getHexString()}; border-radius:6px;"></div>
            <div><b>${p.name}</b><div style="font-size:12px;color:#666;">${p.price} coins</div></div>
        </div>`;
        const buy = document.createElement('button');
        buy.className = 'menu-btn';
        buy.textContent = 'Buy';
        buy.style.width = '80px';
        buy.addEventListener('click', () => {
            if (playerCoins < p.price) {
                alert('Not enough coins.');
                return;
            }
            playerCoins -= p.price;
            updateCoinUI();
            spawnPetForPlayer(p);
            addChatMessage('System', `You bought ${p.name}!`);
        });
        row.appendChild(buy);
        list.appendChild(row);
    });
}

function updateCoinUI() {
    const el = document.getElementById('coin-count');
    if (el) el.textContent = String(playerCoins);
}

function spawnPetForPlayer(pet) {
    // Simple pet: small colored sphere that follows player
    const geo = new THREE.SphereGeometry(0.7, 12, 12);
    const mat = new THREE.MeshStandardMaterial({ color: pet.color, emissive: pet.color * 0.2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = pet.id;
    mesh.userData = { petFor: room.clientId || 'local' };
    // Start near player
    mesh.position.copy(player.mesh.position).add(new THREE.Vector3(Math.random()*2-1, 1.5, Math.random()*2-1));
    scene.add(mesh);
    playerPets.push({ id: pet.id + '-' + Date.now(), mesh: mesh });
}

// Initialize Multiplayer
room.initialize().then(() => {
    console.log("Multiplayer connected");
});

room.subscribePresence((presence) => {
    // Sync remote players
    const peerIds = Object.keys(presence);
    
    // 1. Remove Disconnected or Map-mismatched players
    for (const id in remotePlayers) {
        if (!presence[id]) {
            // Disconnected
            // Show the in-game display name of the player who left (use stored RemotePlayer name)
            const leftName = remotePlayers[id] && remotePlayers[id].name ? remotePlayers[id].name : "Player";
            remotePlayers[id].dispose();
            delete remotePlayers[id];
            addChatMessage("System", `${leftName} left.`);
            continue;
        }
        
        // Map Check
        const pData = presence[id];
        if (pData.map !== currentMapName && gameState === 'PLAYING') {
            remotePlayers[id].dispose();
            delete remotePlayers[id];
        }
    }

    // 2. Add / Update Players
    peerIds.forEach(id => {
        if (id === room.clientId) return; // Ignore self

        const pData = presence[id];
        // Only show if in same map
        if (gameState === 'PLAYING' && pData.map !== currentMapName) return;

        if (!remotePlayers[id]) {
            // New Player
            // Use in-game username from presence first; never show websim peer username
            const username = (pData && pData.username) ? pData.username : "Guest";
            const rp = new RemotePlayer(scene, {
                username: username,
                clientId: id,
                presence: pData
            });
            remotePlayers[id] = rp;
            addChatMessage("System", `${username} joined.`);
        }
        
        // Update
        remotePlayers[id].updateData(pData);
    });

    // 3. Update UI
    updatePlayerList();
    updateGameDetailPlayerCount();

    // Also keep left-side leaderbar count updated (if present)
    try {
        const pcount = 1 + Object.keys(remotePlayers).length;
        const el = document.getElementById('player-count');
        if (el) el.textContent = String(pcount);
    } catch (e){}
});

room.onmessage = (evt) => {
    const data = evt.data;
    if (data.type === 'chat') {
        const id = evt.clientId;
        const msg = data.message || '';
        // Prefer the in-game username included in the chat event; fallback to presence username; never use websim peer username
        const username = data.username || (room.presence && room.presence[id] && room.presence[id].username) || "Player";
        
        // Moderation: detect predatory chat from claimed-13 accounts mentioning dating
        const datingPattern = /\b(date|dating|meet up|meetup|kissing|relationship|romantic)\b/i;
        const senderPresence = (room.presence && room.presence[id]) ? room.presence[id] : {};
        const senderAge = senderPresence.age !== undefined ? Number(senderPresence.age) : null;

        // If sender claims age 13 and message matches dating keywords -> impose 5-day ban locally and remove them from view
        if (senderAge === 13 && datingPattern.test(msg)) {
            const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
            const until = Date.now() + fiveDaysMs;
            try {
                // Store peer-specific ban so this client treats them as banned
                localStorage.setItem(`nblox_ban_peer_${id}`, String(until));
            } catch (e) {
                console.warn('Failed to persist peer ban:', e);
            }
            // Remove remote player locally if present
            if (remotePlayers[id]) {
                const pname = remotePlayers[id].name || 'Player';
                remotePlayers[id].dispose();
                delete remotePlayers[id];
                addChatMessage('System', `${pname} was banned for predatory behavior.`);
            } else {
                addChatMessage('System', `A predatory account was detected and banned locally.`);
            }
            // Optionally inform peers (best-effort event)
            try {
                room.send({ type: 'moderation_notice', targetId: id, reason: 'predatory_chat', until: until });
            } catch (e) {}
            return; // Do not show the offending message
        }

        addChatMessage(username, msg);
        
        if (remotePlayers[id]) {
            remotePlayers[id].chat(msg);
        }
    }
    // Friend system events
    if (data.type === 'friend_request') {
        // Someone invited a target to be friends
        const fromId = evt.clientId;
        const toId = data.targetId;
        const fromName = data.username || (room.presence && room.presence[fromId] && room.presence[fromId].username) || 'Player';
        if (toId === room.clientId) {
            // Incoming request for this client
            const accept = confirm(`${fromName} sent you a friend request. Accept?`);
            if (accept) {
                // Persist locally
                addFriend(fromId, fromName);
                // Notify sender
                try { room.send({ type: 'friend_accept', targetId: fromId, username: document.getElementById('input-username').value || 'Guest' }); } catch(e){}
                addChatMessage('System', `You accepted ${fromName}'s friend request.`);
            } else {
                addChatMessage('System', `You declined ${fromName}'s friend request.`);
            }
            updatePlayerList();
        }
    }
    if (data.type === 'friend_accept') {
        const fromId = evt.clientId; // who accepted
        const toId = data.targetId; // original sender of request
        const fromName = data.username || (room.presence && room.presence[fromId] && room.presence[fromId].username) || 'Player';
        // If this client was the original requester, add the accepter to friends
        if (toId === room.clientId) {
            addFriend(fromId, fromName);
            addChatMessage('System', `${fromName} accepted your friend request.`);
            updatePlayerList();
        }
    }
};

// --- Window Dragging & Resizing Logic ---
function makeDraggable(el) {
    const titleBar = el.querySelector('.xp-title-bar');
    if (!titleBar) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    titleBar.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return; // Don't drag if clicking close button
        e.preventDefault();
        
        // Handle "centered" windows by converting to pixels
        const computedStyle = window.getComputedStyle(el);
        const matrix = new WebKitCSSMatrix(computedStyle.transform);
        
        // If it was centered with transform, reset that and set actual pixels
        if (computedStyle.transform !== 'none') {
            const rect = el.getBoundingClientRect();
            // Adjust rect for zoom
            el.style.transform = 'none';
            // el.getBoundingClientRect returns screen coords? Or zoomed coords? 
            // In a zoomed body, we need to be careful. 
            // Let's rely on offsetLeft if possible, or manual adjustment.
            // Simplest fix for zoom center issue:
            const left = parseFloat(computedStyle.left) || 0; 
            const top = parseFloat(computedStyle.top) || 0;
            // Actually, if transform is used, left/top might be 50%.
            // Let's just trust offsetLeft/Top which are CSS pixels.
            el.style.left = el.offsetLeft + 'px';
            el.style.top = el.offsetTop + 'px';
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        initialLeft = parseFloat(el.style.left) || el.offsetLeft;
        initialTop = parseFloat(el.style.top) || el.offsetTop;
        
        // Bring to front
        const maxZ = Math.max(...Array.from(document.querySelectorAll('.menu-popup, .xp-window, .sidebar')).map(x => parseFloat(window.getComputedStyle(x).zIndex) || 0));
        el.style.zIndex = maxZ + 1;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = (e.clientX - startX) / UI_ZOOM;
        const dy = (e.clientY - startY) / UI_ZOOM;
        el.style.left = (initialLeft + dx) + 'px';
        el.style.top = (initialTop + dy) + 'px';
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

function makeResizable(el) {
    const resizer = el.querySelector('.xp-resizer');
    if (!resizer) return;

    let isResizing = false;
    let startX, startY, startW, startH;

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = parseFloat(window.getComputedStyle(el).width);
        startH = parseFloat(window.getComputedStyle(el).height);
    });

    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const width = startW + (e.clientX - startX) / UI_ZOOM;
        const height = startH + (e.clientY - startY) / UI_ZOOM;
        el.style.width = Math.max(200, width) + 'px';
        el.style.height = Math.max(100, height) + 'px';
    });

    window.addEventListener('mouseup', () => {
        isResizing = false;
    });
}

// Apply to all windows
document.querySelectorAll('.menu-popup, .xp-window, .sidebar').forEach(win => {
    makeDraggable(win);
    makeResizable(win);
});


// Load Saved Character
try {
    const savedApp = localStorage.getItem('chirpless_appearance');
    if (savedApp) {
        player.deserializeAppearance(JSON.parse(savedApp));
        // Update customize menu inputs to match
        const data = JSON.parse(savedApp);
        if (data.colors) {
            if(data.colors.head) document.getElementById('col-head').value = data.colors.head;
            if(data.colors.torso) document.getElementById('col-torso').value = data.colors.torso;
            if(data.colors.leftArm) document.getElementById('col-larm').value = data.colors.leftArm;
            if(data.colors.rightArm) document.getElementById('col-rarm').value = data.colors.rightArm;
            if(data.colors.leftLeg) document.getElementById('col-lleg').value = data.colors.leftLeg;
            if(data.colors.rightLeg) document.getElementById('col-rleg').value = data.colors.rightLeg;
            
            // Update the preview blocks in the menu
            ['col-head', 'col-torso', 'col-larm', 'col-rarm', 'col-lleg', 'col-rleg'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.parentElement.style.backgroundColor = el.value;
            });
        }
    }
} catch (e) {
    console.error("Failed to load character", e);
}

// Name Change Limit Logic
let nameChangesLeft = 3;
try {
    const savedLimit = localStorage.getItem('nblox_name_changes');
    if (savedLimit !== null) nameChangesLeft = parseInt(savedLimit);
} catch(e) {}

 // Points system (local simulation): websim points stored in localStorage 'nblox_points'
let websimPoints = 0;
let candyCount = 0; // halloween candy tally (local)
try {
    websimPoints = parseInt(localStorage.getItem('chirpless_points') || '0', 10);
    if (isNaN(websimPoints)) websimPoints = 0;
    candyCount = parseInt(localStorage.getItem('chirpless_candy') || '0', 10) || 0;
} catch (e) {
    websimPoints = 0;
    candyCount = 0;
}

 // Load Saved Username & Age
 const savedUsername = localStorage.getItem('nblox_username') || "Guest";
 const savedAge = parseInt(localStorage.getItem('nblox_age') || '18', 10);
 // Use safe getter to avoid "Cannot set properties of null" when DOM is different
 const inputUsername = getEl('input-username');
 const inputAge = getEl('input-age');
 try { inputUsername.value = savedUsername; } catch(e) {}
 try { if (inputAge) inputAge.value = Number.isFinite(savedAge) ? savedAge : 18; } catch(e) {}



// Simple local ban enforcement: if a ban is set and not expired, keep player out of play
const banUntil = parseInt(localStorage.getItem('nblox_ban_until') || '0', 10);
if (banUntil && Date.now() < banUntil) {
    // Disable play/start actions and show notice
    const remaining = Math.ceil((banUntil - Date.now()) / (1000 * 60 * 60 * 24));
    alert(`Your account is banned for violating chat rules. Ban expires in ${remaining} day(s).`);
    // Ensure menus reflect banned state: prevent PLAY and STUDIO entry
    const _btnPlay = document.getElementById('btn-play');
    const _btnStudio = document.getElementById('btn-studio');
    if (_btnPlay) _btnPlay.disabled = true;
    if (_btnStudio) _btnStudio.disabled = true;
    if (_btnPlay) _btnPlay.title = 'Banned until: ' + new Date(banUntil).toLocaleString();
    if (_btnStudio) _btnStudio.title = 'Banned until: ' + new Date(banUntil).toLocaleString();
}

const lblNameMsg = getEl('name-limit-msg');
const lblUsername = getEl('lbl-username');
const pointsDisplay = getEl('points-display');
const btnDonatePoints = getEl('btn-donate-points');

// HUD elements that may not exist in all pages: provide safe no-op fallbacks
const _safeTextNode = () => {
    return { textContent: '' };
};
const _safeElem = () => {
    return {
        style: {},
        textContent: '',
        appendChild: () => {},
        remove: () => {},
        setAttribute: () => {}
    };
};

const chirpDisplay = document.getElementById('chirp-count') || _safeTextNode();
const chirpIcon = document.getElementById('chirp-icon') || _safeElem();
const candyHud = document.getElementById('candy-hud') || _safeElem();
const candyDisplay = document.getElementById('candy-count') || _safeTextNode();

function updateChirpUI() {
    // Chirps removed; keep function as no-op for compatibility
}
function updateCandyUI() {
    if (candyDisplay) candyDisplay.textContent = String(candyCount);
    try { localStorage.setItem('chirpless_candy', String(candyCount)); } catch(e){}
}

// Update UI showing remaining name changes and points
function updateNameUI() {
    lblUsername.textContent = `Username (${nameChangesLeft} left):`;
    if (nameChangesLeft <= 0) {
        inputUsername.disabled = true;
        lblNameMsg.textContent = "No name changes remaining.";
        document.getElementById('btn-save-name').disabled = true;
    } else {
        lblNameMsg.textContent = "";
        document.getElementById('btn-save-name').disabled = false;
    }
    if (pointsDisplay) pointsDisplay.textContent = String(websimPoints);
    updateChirpUI();
    updateCandyUI();
}
updateNameUI();



 // Save Name Button (also save & publish age for moderation)
document.getElementById('btn-save-name').onclick = () => {
    playSwitch();
    if (nameChangesLeft <= 0) return;

    const newName = inputUsername.value.trim();
    const newAge = inputAge ? parseInt(inputAge.value || '18', 10) : 18;

    if (!newName) {
        alert("Username cannot be empty.");
        return;
    }

    if (!Number.isFinite(newAge) || newAge < 5 || newAge > 120) {
        alert("Please enter a valid age (5-120).");
        return;
    }

    // Prevent duplicates: check current presence for any matching in-game username
    try {
        const pres = room.presence || {};
        for (const id in pres) {
            if (!pres[id]) continue;
            if (pres[id].username && pres[id].username === newName) {
                alert("That username is already taken by someone in the game. Choose another.");
                return;
            }
        }
    } catch (e) {
        console.warn("Username uniqueness check failed:", e);
    }

    const savedUsernameLocal = localStorage.getItem('nblox_username') || "Guest";
    if (newName && newName !== savedUsernameLocal) {
        nameChangesLeft--;
        localStorage.setItem('nblox_name_changes', nameChangesLeft);
        localStorage.setItem('nblox_username', newName);
        updateNameUI();
        alert(`Name saved! You have ${nameChangesLeft} changes left.`);
    }

    // Persist age locally and publish it in presence
    try {
        localStorage.setItem('nblox_age', String(newAge));
    } catch (e) {
        console.warn('Failed to persist age locally', e);
    }



    // Immediately push presence update so others see your chosen in-game username and age
    try {
        room.updatePresence({
            username: newName,
            age: newAge
        });
    } catch (e) {
        console.warn("Failed to update presence with username/age:", e);
    }
};

// Studio Controls
const transformControl = new TransformControls(camera, renderer.domElement);
transformControl.setTranslationSnap(1); // 1 Stud snap
transformControl.setRotationSnap(Math.PI / 12); // 15 degree snap
scene.add(transformControl);

transformControl.addEventListener('dragging-changed', (event) => {
    // Disable camera movement when dragging gizmo
    input.isDraggingGizmo = event.value;

    // When we finish dragging, if it was scaling, we need to bake geometry to fix textures
    if (!event.value && transformControl.mode === 'scale' && studioSelected) {
        bakeScale(studioSelected);
    }
    
    // Update Properties Panel on drag end
    if (!event.value && studioSelected) {
        updateStudioPropertiesUI();
    }
});

transformControl.addEventListener('change', () => {
    // Live update properties panel while dragging (optional, might be heavy)
    if (input.isDraggingGizmo && studioSelected) {
        updateStudioPropertiesUI();
    }
});

function bakeScale(mesh) {
    // Only for blocks for now
    if (mesh.userData.serial && (mesh.userData.serial.type === 'block' || mesh.userData.serial.type === 'box')) {
        const s = mesh.scale;
        const g = mesh.geometry;
        
        // Assume box geometry
        const oldW = g.parameters.width;
        const oldH = g.parameters.height;
        const oldD = g.parameters.depth;
        
        const newW = oldW * s.x;
        const newH = oldH * s.y;
        const newD = oldD * s.z;
        
        // Rebuild geometry
        const newGeo = new THREE.BoxGeometry(newW, newH, newD);
        boxUnwrapUVs(newGeo);
        
        mesh.geometry.dispose();
        mesh.geometry = newGeo;
        
        // Reset scale
        mesh.scale.set(1, 1, 1);
        
        // Update serial data
        mesh.userData.serial.w = newW;
        mesh.userData.serial.h = newH;
        mesh.userData.serial.d = newD;
        
        updateStudioPropertiesUI();
    }
}

// Helper for highlighting selection in Studio
const hoverHelper = new THREE.BoxHelper(new THREE.Mesh(new THREE.BoxGeometry(1,1,1)), 0xffff00);
hoverHelper.material.depthTest = false;
hoverHelper.material.transparent = true;
hoverHelper.material.opacity = 0.5;
hoverHelper.visible = false;
scene.add(hoverHelper);

const selectionHelper = new THREE.BoxHelper(new THREE.Mesh(new THREE.BoxGeometry(1,1,1)), 0x00aaff);
selectionHelper.material.depthTest = false;
selectionHelper.material.transparent = true;
selectionHelper.material.linewidth = 2; // WebGL doesn't support lineWidth > 1 usually, but we try
selectionHelper.visible = false;
scene.add(selectionHelper);

// Studio State
let studioSelected = null;
let activeTool = 'select'; // 'select', 'move', 'scale', 'rotate'
let editingGameName = null;
let isRemixMode = false;

const studioCamPos = new THREE.Vector3(0, 20, 30);
let studioCamYaw = 0;
let studioCamPitch = -0.5;

// Camera State
let cameraYaw = 0;
let cameraPitch = 0.3;
let cameraDist = 20;
let cameraSensitivity = 1.0;
let cameraInvertY = false;
let lastCamYawClick = 0;

// Game State
let gameState = 'MENU'; // MENU, CUSTOMIZE, PLAYING, SETTINGS, STUDIO, TEST
let prevGameState = null; // stores previous state when opening transient menus like SETTINGS
 // When leaving a game, briefly suppress automatic re-join or pointer-lock triggers
 // to prevent accidental immediate re-entry from stray events (mouse/cursor/input).
 let suppressAutoJoinUntil = 0;
 // Block the very next auto-join/click-driven pointer-lock after a leave so the user doesn't immediately re-enter.
 let preventAutoRejoin = false;

/*
  Menu background music: playlist using Chirpless.mp3 then ChirplessV2.mp3 then ChirplessV3.mp3, shuffled and looped.
  This replaces the previous no-op stub so menus actually play the Chirpless tunes.
*/
const menuPlaylist = ['/Chirpless.mp3', '/ChirplessV2.mp3', '/ChirplessV3.mp3'];
let menuBGM = {
    audio: null,
    index: 0,
    list: [],
    volume: 0.6,
    playing: false,
    quieted: false
};
let prevMenuVolume = null; // stores previous menu audio volume while quieted
let gameBGM = null;

// Shuffle helper (Fisher–Yates)
function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function startMenuPlaylist() {
    // If already playing, ignore
    if (menuBGM.playing) return;
    menuBGM.list = shuffleArray(menuPlaylist);
    menuBGM.index = 0;
    playMenuTrack(menuBGM.list[menuBGM.index]);
    menuBGM.playing = true;
}

function playMenuTrack(src) {
    try {
        // Stop any existing audio cleanly
        if (menuBGM.audio) {
            try { menuBGM.audio.pause(); } catch (e) {}
            menuBGM.audio = null;
        }

        const a = new Audio(src);
        a.crossOrigin = "anonymous";
        a.loop = false;
        a.volume = Math.max(0, Math.min(1, menuBGM.volume));
        a.preload = 'auto';

        // If track fails to load/play, advance to next track to avoid getting stuck
        const handleFailure = (err) => {
            console.warn('Menu track failed to play/load:', src, err);
            try { a.pause(); } catch (e) {}
            // Advance to next track immediately
            menuBGM.index = (menuBGM.index + 1) % Math.max(1, menuBGM.list.length);
            const next = menuBGM.list[menuBGM.index];
            // Small delay to avoid tight loop
            setTimeout(() => playMenuTrack(next), 250);
        };

        a.onerror = (ev) => handleFailure(ev);
        a.addEventListener('stalled', handleFailure);
        a.addEventListener('suspend', () => { /* no-op */ });

        a.onended = () => {
            // Advance to next (wrap + reshuffle when finished full cycle)
            menuBGM.index++;
            if (menuBGM.index >= menuBGM.list.length) {
                menuBGM.list = shuffleArray(menuPlaylist);
                menuBGM.index = 0;
            }
            playMenuTrack(menuBGM.list[menuBGM.index]);
        };

        // Try to play; handle Promise rejection (autoplay policy) by retrying on user gesture later
        const p = a.play();
        if (p && typeof p.then === 'function') {
            p.then(() => {
                // success
            }).catch((err) => {
                // Autoplay blocked or other issue; schedule a retry and keep the audio element so it can be user-resumed
                console.warn('Menu audio play rejected, scheduling retry:', err);
                // Keep reference so other code can attempt to resume on user gesture
                menuBGM.audio = a;
                // Retry later (best-effort) - allow user gesture to resume via pointerdown handler elsewhere
                setTimeout(() => {
                    try { a.play().catch(()=>{}); } catch(e){}
                }, 1500);
            });
        }

        // Save active audio regardless of immediate play success
        menuBGM.audio = a;
    } catch (e) {
        console.warn('Menu BGM play failed:', e);
        // Advance to next track so playlist doesn't get stuck
        try {
            menuBGM.index = (menuBGM.index + 1) % Math.max(1, menuBGM.list.length);
            const next = menuBGM.list[menuBGM.index];
            setTimeout(() => playMenuTrack(next), 300);
        } catch (ee) {}
    }
}

function pauseMenuPlaylist() {
    try {
        if (menuBGM.audio) {
            menuBGM.audio.pause();
            menuBGM.audio = null;
        }
    } catch (e) {}
    menuBGM.playing = false;
}

const tryPlayBGM = () => {
    if (uiAudioCtx && uiAudioCtx.state === 'suspended') uiAudioCtx.resume();
    
    if (gameState === 'PLAYING') {
        // Stop menu music when entering a game
        pauseMenuPlaylist();
        if (gameBGM && gameBGM.paused) gameBGM.play().catch(()=>{});
    } else {
        // Menus: start our shuffled playlist
        if (gameBGM) {
            gameBGM.pause();
            gameBGM.currentTime = 0;
        }
        startMenuPlaylist();
    }
};

// Privacy Lock: show black overlay and silence/suspend audio to provide a simple "no recording" lock
let __privacyLocked = false;
function enablePrivacyLock(enable) {
    __privacyLocked = !!enable;
    try {
        const overlay = document.getElementById('__privacy_lock');
        if (overlay) overlay.style.display = __privacyLocked ? 'block' : 'none';
    } catch(e){}

    // Pause/stop audible elements
    try {
        if (menuBGM && menuBGM.audio) {
            try { menuBGM.audio.pause(); } catch(e){}
        }
    } catch(e){}

    try {
        if (gameBGM) {
            try { gameBGM.pause(); } catch(e){}
        }
    } catch(e){}

    // Suspend UI audio context
    try {
        if (uiAudioCtx) {
            if (__privacyLocked && uiAudioCtx.state === 'running') uiAudioCtx.suspend().catch(()=>{});
            if (!__privacyLocked && uiAudioCtx.state === 'suspended') uiAudioCtx.resume().catch(()=>{});
        }
    } catch(e){}

    // Suspend local player audio context if present
    try {
        if (player && player.audioCtx) {
            if (__privacyLocked && player.audioCtx.state === 'running') player.audioCtx.suspend().catch(()=>{});
            if (!__privacyLocked && player.audioCtx.state === 'suspended') player.audioCtx.resume().catch(()=>{});
        }
    } catch(e){}

    // Mute/pause any Audio() objects (menuBGM.audio, gameBGM) and suspend remote players' audio contexts
    try {
        // stop walk sounds etc
        if (player && player.walkSource) {
            try { player.walkSource.stop(); } catch(e){}
            player.walkSource = null;
        }
    } catch(e){}

    try {
        Object.values(remotePlayers).forEach(rp => {
            try {
                if (rp && rp.audioCtx) {
                    if (__privacyLocked && rp.audioCtx.state === 'running') rp.audioCtx.suspend().catch(()=>{});
                    if (!__privacyLocked && rp.audioCtx.state === 'suspended') rp.audioCtx.resume().catch(()=>{});
                }
            } catch(e){}
        });
    } catch(e){}

    // Heuristic: mute any global <audio> elements that might be used
    try {
        document.querySelectorAll('audio').forEach(a => {
            try { a.muted = __privacyLocked; if (__privacyLocked) a.pause(); } catch(e){}
        });
    } catch(e){}
}

// POINTS: accumulator for awarding points while playing (1 point per 10s)
let playSecondsAcc = 0;
websimPoints = websimPoints || 0; // ensure variable exists (fallback merged with earlier load)

// WebAudio for UI Sounds to prevent delay
const uiAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
let switchBuffer = null;

// Load sound immediately
fetch('/SWITCH3.wav')
    .then(res => res.arrayBuffer())
    .then(arr => uiAudioCtx.decodeAudioData(arr))
    .then(buf => switchBuffer = buf);

const playSwitch = (pitch = 1.0, vol = 0.8) => {
    if (!switchBuffer) return;
    if (uiAudioCtx.state === 'suspended') uiAudioCtx.resume();
    
    const src = uiAudioCtx.createBufferSource();
    src.buffer = switchBuffer;
    src.playbackRate.value = pitch;
    
    const gain = uiAudioCtx.createGain();
    gain.gain.value = vol;
    
    src.connect(gain);
    gain.connect(uiAudioCtx.destination);
    src.start(0);
};

// Add sound to all current buttons (dev menu etc)
document.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', () => playSwitch()));

// Inputs
const input = new InputManager();
input.isDraggingGizmo = false;

window.addEventListener('wheel', (e) => {
    if (gameState === 'PLAYING') {
        // Use WebAudio for immediate response
        playSwitch(1.0, 0.4);

        const zoomStep = 2;
        cameraDist += Math.sign(e.deltaY) * zoomStep;
        cameraDist = Math.max(4, Math.min(80, cameraDist));
    }
});

// Mobile Detection
const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// Exposed joystick manager so we can create/destroy on toggle
let joystickManager = null;
const joystickZone = document.getElementById('zone_joystick');

const createJoystick = () => {
    if (joystickManager) return joystickManager;
    try {
        // Responsive joystick sizing: use a fraction of the smaller viewport dimension for consistent visual scale
        const baseSize = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.22);
        joystickManager = nipplejs.create({
            zone: joystickZone,
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: 'white',
            size: Math.max(72, Math.min(220, baseSize))
        });

        joystickManager.on('move', (evt, data) => {
            if (data && data.vector) {
                input.joystickVector.x = data.vector.x;
                input.joystickVector.y = -data.vector.y;
            }
        });

        joystickManager.on('end', () => {
            input.joystickVector.x = 0;
            input.joystickVector.y = 0;
        });
    } catch (e) {
        console.warn('Failed to create joystick:', e);
    }
    return joystickManager;
};

const destroyJoystick = () => {
    try {
        if (joystickManager && joystickManager.destroy) {
            joystickManager.destroy();
        }
    } catch (e) {}
    joystickManager = null;
};

// Apply saved mobile preference
let forcedMobile = false;
try {
    forcedMobile = localStorage.getItem('nblox_force_mobile') === '1';
} catch (e) { forcedMobile = false; }

const setMobileModeUI = (enable) => {
    const mobileUI = document.getElementById('mobile-ui');
    const btnJump = document.getElementById('btn-mobile-jump');
    if (enable) {
        mobileUI.style.display = 'block';
        if (btnJump) btnJump.style.display = 'block';
        createJoystick();
    } else {
        mobileUI.style.display = 'none';
        if (btnJump) btnJump.style.display = 'none';
        destroyJoystick();
        input.joystickVector.x = 0;
        input.joystickVector.y = 0;
    }

    // Persist preference
    try {
        localStorage.setItem('nblox_force_mobile', enable ? '1' : '0');
    } catch (e) {}
};

// If UA is mobile or user forced it, enable mobile mode by default
if (isMobileUA || forcedMobile) {
    setMobileModeUI(true);
}

// Expose toggle via start menu button
const btnToggleMobile = document.getElementById('btn-toggle-mobile');
if (btnToggleMobile) {
    btnToggleMobile.addEventListener('click', () => {
        playSwitch();
        const current = (document.getElementById('mobile-ui').style.display !== 'none');
        setMobileModeUI(!current);
        alert('Mobile Mode ' + (!current ? 'Enabled' : 'Disabled') + '.');
    });
}

// Also ensure mobile jump button hookup works even when joystick created later
const btnJump = document.getElementById('btn-mobile-jump');
if (btnJump) {
    btnJump.addEventListener('touchstart', (e) => { e.preventDefault(); input.keys.space = true; });
    btnJump.addEventListener('touchend', (e) => { e.preventDefault(); input.keys.space = false; });
}

// Pet shop UI hooks
const btnOpenPets = document.getElementById('btn-open-pets');
const btnClosePetShop = document.getElementById('btn-close-petshop');
const btnPetShopClose = document.getElementById('btn-petshop-close');
if (btnOpenPets) btnOpenPets.addEventListener('click', (e) => { e.stopPropagation(); showPetShop(); });
if (btnClosePetShop) btnClosePetShop.addEventListener('click', () => document.getElementById('pet-shop').style.display = 'none');
if (btnPetShopClose) btnPetShopClose.addEventListener('click', () => document.getElementById('pet-shop').style.display = 'none');

// Studio UI Handlers
function updateExplorer() {
    explorerList.innerHTML = '';
    
    // Group "Workspace"
    const workspaceDiv = document.createElement('div');
    workspaceDiv.style.fontWeight = 'bold';
    workspaceDiv.style.padding = '2px';
    workspaceDiv.innerHTML = '<span>🌐</span> Workspace';
    explorerList.appendChild(workspaceDiv);

    const container = document.createElement('div');
    container.style.paddingLeft = '16px';
    explorerList.appendChild(container);

    world.items.forEach(obj => {
        const div = document.createElement('div');
        div.className = 'explorer-item';
        if (studioSelected === obj) div.classList.add('selected');
        
        div.innerHTML = `<div class="icon-part"></div> ${obj.name || 'Part'}`;
        
        div.onclick = (e) => {
            e.stopPropagation();
            studioSelected = obj;
            updateStudioSelection();
        };
        
        container.appendChild(div);
    });
}

const updateStudioSelection = () => {
    if (studioSelected) {
        if (activeTool === 'select') {
            transformControl.detach();
        } else {
            transformControl.attach(studioSelected);
        }
        selectionHelper.setFromObject(studioSelected);
        selectionHelper.visible = true;
        updateStudioPropertiesUI();
    } else {
        transformControl.detach();
        selectionHelper.visible = false;
    }
    // Re-render Explorer to show highlight
    // Optimization: Just update classes if list is same size
    const items = explorerList.querySelectorAll('.explorer-item');
    if (items.length !== world.items.length) {
        updateExplorer();
    } else {
        // Simple class toggle
        world.items.forEach((obj, i) => {
            if (obj === studioSelected) items[i].classList.add('selected');
            else items[i].classList.remove('selected');
        });
    }
};

const propInputs = {
    color: getEl('prop-color'),
    reflect: getEl('prop-reflect'),
    trans: getEl('prop-trans'),
    anchored: getEl('prop-anchored'),
    collide: getEl('prop-collide'),
    px: getEl('prop-px'),
    py: getEl('prop-py'),
    pz: getEl('prop-pz'),
    sx: getEl('prop-sx'),
    sy: getEl('prop-sy'),
    sz: getEl('prop-sz'),
    rx: getEl('prop-rx'),
    ry: getEl('prop-ry'),
    rz: getEl('prop-rz'),
};

function updateStudioPropertiesUI() {
    if (!studioSelected) return;
    const m = studioSelected;

    // helper that safely sets value on an input if it exists
    const safeSet = (el, value) => { if (el) { try { el.value = value; } catch(e){} } };
    const safeSetChecked = (el, v) => { if (el) { try { el.checked = !!v; } catch(e){} } };

    // SAFETY: ensure material exists before reading properties; if not, set safe defaults using safe setters
    if (!m || !m.material) {
        safeSet(propInputs.color, '#cccccc');
        safeSet(propInputs.reflect, 0);
        safeSet(propInputs.trans, 0);
        safeSet(propInputs.px, typeof m?.position?.x === 'number' ? parseFloat(m.position.x.toFixed(2)) : 0);
        safeSet(propInputs.py, typeof m?.position?.y === 'number' ? parseFloat(m.position.y.toFixed(2)) : 0);
        safeSet(propInputs.pz, typeof m?.position?.z === 'number' ? parseFloat(m.position.z.toFixed(2)) : 0);
        safeSet(propInputs.sx, 1);
        safeSet(propInputs.sy, 1);
        safeSet(propInputs.sz, 1);
        safeSet(propInputs.rx, Math.round(THREE.MathUtils.radToDeg(m?.rotation?.x || 0)));
        safeSet(propInputs.ry, Math.round(THREE.MathUtils.radToDeg(m?.rotation?.y || 0)));
        safeSet(propInputs.rz, Math.round(THREE.MathUtils.radToDeg(m?.rotation?.z || 0)));
        safeSetChecked(propInputs.anchored, m?.userData?.anchored);
        return;
    }

    // Appearance - pick first material safely
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (mat && mat.color) safeSet(propInputs.color, '#' + (mat.color ? mat.color.getHexString() : 'cccccc'));
    else safeSet(propInputs.color, '#cccccc');

    // Standard material properties (best effort)
    if (mat) {
        safeSet(propInputs.reflect, 0);
        safeSet(propInputs.trans, (typeof mat.opacity === 'number') ? (1 - mat.opacity) : 0);
    } else {
        safeSet(propInputs.reflect, 0);
        safeSet(propInputs.trans, 0);
    }

    // Transform
    safeSet(propInputs.px, Number.isFinite(m.position.x) ? parseFloat(m.position.x.toFixed(2)) : 0);
    safeSet(propInputs.py, Number.isFinite(m.position.y) ? parseFloat(m.position.y.toFixed(2)) : 0);
    safeSet(propInputs.pz, Number.isFinite(m.position.z) ? parseFloat(m.position.z.toFixed(2)) : 0);

    // Size logic (attempt to infer size then multiply by scale)
    let size = {x:1, y:1, z:1};
    if (m.userData && m.userData.serial) {
        size.x = m.userData.serial.w || size.x;
        size.y = m.userData.serial.h || size.y;
        size.z = m.userData.serial.d || size.z;
    } else if (m.geometry && m.geometry.parameters) {
        size.x = m.geometry.parameters.width || size.x;
        size.y = m.geometry.parameters.height || size.y;
        size.z = m.geometry.parameters.depth || size.z;
    }
    size.x *= (m.scale?.x || 1);
    size.y *= (m.scale?.y || 1);
    size.z *= (m.scale?.z || 1);

    safeSet(propInputs.sx, parseFloat(size.x.toFixed(2)));
    safeSet(propInputs.sy, parseFloat(size.y.toFixed(2)));
    safeSet(propInputs.sz, parseFloat(size.z.toFixed(2)));

    // Rotation (Euler to Degrees) - guard for numeric values
    safeSet(propInputs.rx, Math.round(THREE.MathUtils.radToDeg(Number.isFinite(m.rotation.x) ? m.rotation.x : 0)));
    safeSet(propInputs.ry, Math.round(THREE.MathUtils.radToDeg(Number.isFinite(m.rotation.y) ? m.rotation.y : 0)));
    safeSet(propInputs.rz, Math.round(THREE.MathUtils.radToDeg(Number.isFinite(m.rotation.z) ? m.rotation.z : 0)));

    // Behavior
    safeSetChecked(propInputs.anchored, !!m.userData?.anchored);
}

// Bind Property Inputs
const onPropChange = () => {
    if (!studioSelected) return;
    const m = studioSelected;
    
    // Pos
    m.position.set(
        parseFloat(propInputs.px.value),
        parseFloat(propInputs.py.value),
        parseFloat(propInputs.pz.value)
    );
    
    // Rot
    m.rotation.set(
        THREE.MathUtils.degToRad(parseFloat(propInputs.rx.value)),
        THREE.MathUtils.degToRad(parseFloat(propInputs.ry.value)),
        THREE.MathUtils.degToRad(parseFloat(propInputs.rz.value))
    );
    
    // Size (Complex part: resizing geometry vs scaling)
    // We will update scale for simplicity, then bake if it's a block
    if (m.userData.serial && m.userData.serial.type === 'block') {
        const targetW = parseFloat(propInputs.sx.value);
        const targetH = parseFloat(propInputs.sy.value);
        const targetD = parseFloat(propInputs.sz.value);
        
        // Rebuild directly
        const newGeo = new THREE.BoxGeometry(targetW, targetH, targetD);
        boxUnwrapUVs(newGeo);
        m.geometry.dispose();
        m.geometry = newGeo;
        m.userData.serial.w = targetW;
        m.userData.serial.h = targetH;
        m.userData.serial.d = targetD;
        m.scale.set(1,1,1);
    } else {
        // Just scale generic parts
        // This is tricky because we don't know base size easily without serial
        // skip for now
    }

    // Colors
    const col = new THREE.Color(propInputs.color.value);
    if (Array.isArray(m.material)) m.material.forEach(mat => mat.color = col);
    else m.material.color = col;
    if (m.userData.serial) m.userData.serial.color = col.getHex();
};

// Tool Switching Logic
function setStudioTool(tool) {
    activeTool = tool;
    playSwitch();

    // Update UI
    ['select', 'move', 'scale', 'rotate'].forEach(t => {
        const btn = document.getElementById('tool-' + t);
        if (btn) {
            if (t === tool) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    // Update Gizmo Mode
    if (tool === 'move') transformControl.setMode('translate');
    if (tool === 'scale') transformControl.setMode('scale');
    if (tool === 'rotate') transformControl.setMode('rotate');

    updateStudioSelection();
}

Object.values(propInputs).forEach(input => {
    if(input) input.addEventListener('change', onPropChange);
});


// ===== PUBLISH MODAL LOGIC =====
(function setupPublishModal() {
    const modal = document.getElementById('publish-modal');
    const nameInput = document.getElementById('publish-name');
    const thumbPreview = document.getElementById('publish-thumb-preview');
    const thumbOverlay = document.getElementById('publish-thumb-overlay');
    const thumbFileInput = document.getElementById('publish-thumb-input');
    const thumbBtn = document.getElementById('publish-thumb-btn');
    const thumbScreenshotBtn = document.getElementById('publish-thumb-screenshot-btn');
    const authorDisplay = document.getElementById('publish-author-display');
    const statusEl = document.getElementById('publish-status');
    const submitBtn = document.getElementById('publish-submit-btn');
    const cancelBtn = document.getElementById('publish-cancel-btn');
    const closeBtn = document.getElementById('publish-modal-close');

    let _selectedThumbFile = null;

    // Show / hide helpers
    const openModal = () => {
        // Pre-fill name from current editing context
        let defaultName = 'My Game';
        if (typeof editingGameName !== 'undefined' && editingGameName) {
            defaultName = (typeof isRemixMode !== 'undefined' && isRemixMode)
                ? `Remix of ${editingGameName}` : editingGameName;
        }
        nameInput.value = defaultName;
        // Pre-fill author
        const username = document.getElementById('input-username')?.value || 'Guest';
        if (authorDisplay) authorDisplay.textContent = username;
        // Reset thumbnail
        _selectedThumbFile = null;
        thumbPreview.src = '/DefaultThumb.png';
        // Hide status
        statusEl.style.display = 'none';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Publish Game';
        modal.style.display = 'flex';
    };

    const closeModal = () => { modal.style.display = 'none'; };

    // Thumbnail hover effect
    if (thumbPreview) {
        thumbPreview.parentElement.addEventListener('mouseenter', () => { thumbOverlay.style.opacity = '1'; });
        thumbPreview.parentElement.addEventListener('mouseleave', () => { thumbOverlay.style.opacity = '0'; });
        thumbOverlay.addEventListener('click', () => thumbFileInput.click());
    }

    // File picker
    if (thumbBtn) thumbBtn.onclick = () => thumbFileInput.click();
    if (thumbFileInput) {
        thumbFileInput.onchange = (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            _selectedThumbFile = file;
            const url = URL.createObjectURL(file);
            thumbPreview.src = url;
            thumbFileInput.value = '';
        };
    }

    // Screenshot button — capture the THREE.js canvas
    if (thumbScreenshotBtn) {
        thumbScreenshotBtn.onclick = () => {
            try {
                const canvas = document.querySelector('canvas');
                if (!canvas) { alert('No canvas found to screenshot.'); return; }
                canvas.toBlob((blob) => {
                    if (!blob) return;
                    _selectedThumbFile = new File([blob], 'screenshot.png', { type: 'image/png' });
                    thumbPreview.src = URL.createObjectURL(_selectedThumbFile);
                }, 'image/png');
            } catch (e) {
                console.warn('[v0] Screenshot failed:', e);
            }
        };
    }

    // Close buttons
    if (closeBtn) closeBtn.onclick = closeModal;
    if (cancelBtn) cancelBtn.onclick = closeModal;
    // Click outside to close
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Submit
    if (submitBtn) {
        submitBtn.onclick = async () => {
            const isValidMapName = (n) => n && /^[A-Za-z\s]{1,30}$/.test(n.trim());
            const mapName = (nameInput.value || '').trim();
            if (!isValidMapName(mapName)) {
                setStatus('error', 'Invalid name. Letters and spaces only, 1-30 chars.');
                return;
            }

            const username = document.getElementById('input-username')?.value || 'Guest';
            const data = world.serialize();

            submitBtn.disabled = true;
            submitBtn.textContent = 'Publishing...';
            setStatus('info', 'Uploading your game...');

            try {
                // 1) Upload thumbnail first (if user provided one)
                let thumbUrl = '/DefaultThumb.png';
                if (_selectedThumbFile) {
                    setStatus('info', 'Uploading thumbnail...');
                    const tempId = 'tmp_' + Date.now();
                    const uploaded = await uploadThumbnail(_selectedThumbFile, tempId);
                    if (uploaded) thumbUrl = uploaded;
                }

                // 2) Publish to Supabase
                setStatus('info', 'Saving to Faundry...');
                const result = await publishGame({
                    name: mapName,
                    author: username,
                    thumb_url: thumbUrl,
                    world_data: data
                });

                // 3) Also save locally
                try {
                    const saveObj = { name: mapName, author: username, date: Date.now(), data, remoteId: result.id, thumb_url: thumbUrl };
                    let saves = [];
                    try { const raw = localStorage.getItem('nblox_maps'); if (raw) saves = JSON.parse(raw); } catch(e) {}
                    const idx = saves.findIndex(s => s.name === mapName);
                    if (idx >= 0) saves[idx] = saveObj; else saves.push(saveObj);
                    localStorage.setItem('nblox_maps', JSON.stringify(saves));
                } catch(e) {}

                if (typeof editingGameName !== 'undefined') editingGameName = mapName;
                if (typeof isRemixMode !== 'undefined') isRemixMode = false;

                // Reset remote games cache so Explore will show the new game next time
                if (window._remoteGamesCache) window._remoteGamesCache = { fetched: false, list: [] };

                setStatus('success', `"${mapName}" published successfully!`);
                submitBtn.textContent = 'Done!';
                setTimeout(() => closeModal(), 2000);
            } catch (err) {
                console.warn('[v0] Publish failed:', err);
                setStatus('error', 'Publish failed: ' + (err?.message || String(err)));
                submitBtn.disabled = false;
                submitBtn.textContent = 'Publish Game';
            }
        };
    }

    function setStatus(type, msg) {
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
        if (type === 'success') {
            statusEl.style.background = 'rgba(0,220,100,0.15)';
            statusEl.style.border = '1px solid rgba(0,220,100,0.4)';
            statusEl.style.color = '#00dc64';
        } else if (type === 'error') {
            statusEl.style.background = 'rgba(255,80,80,0.15)';
            statusEl.style.border = '1px solid rgba(255,80,80,0.4)';
            statusEl.style.color = '#ff6666';
        } else {
            statusEl.style.background = 'rgba(0,212,255,0.1)';
            statusEl.style.border = '1px solid rgba(0,212,255,0.3)';
            statusEl.style.color = '#00d4ff';
        }
    }

    // Expose openModal globally so tool-publish can call it
    window.__openPublishModal = openModal;
})();

document.getElementById('tool-publish').onclick = () => {
    playSwitch();
    if (window.__openPublishModal) window.__openPublishModal();
};

document.getElementById('tool-select').onclick = () => setStudioTool('select');
document.getElementById('tool-move').onclick = () => setStudioTool('move');
document.getElementById('tool-rotate').onclick = () => setStudioTool('rotate');
document.getElementById('tool-scale').onclick = () => setStudioTool('scale');

// Add rig spawn handler
document.getElementById('tool-rig').onclick = () => {
    playSwitch();
    spawnRig();
};

document.getElementById('tool-duplicate').onclick = () => {
    if (studioSelected) {
        playSwitch();
        // Clone
        const original = studioSelected;
        const clone = original.clone();
        
        // Fix geometry (clone shares geometry by default)
        // If we want independent resizing, we need new geometry
        clone.geometry = original.geometry.clone();
        
        // Materials are also shared
        if (Array.isArray(original.material)) {
            clone.material = original.material.map(m => m.clone());
        } else {
            clone.material = original.material.clone();
        }
        
        // Deep copy user data
        clone.userData = JSON.parse(JSON.stringify(original.userData));
        
        // Offset
        clone.position.add(new THREE.Vector3(2, 0, 2));
        clone.name = original.name; // Keep name
        
        world.addToWorld(clone, clone.userData.serial ? clone.userData.serial.flags : ['static']);
        
        studioSelected = clone;
        updateStudioSelection();
        updateExplorer(); // Refresh list
    }
};

document.getElementById('tool-part').onclick = () => {
    // Spawn block in front of camera
    spawnPart('block');
};

document.getElementById('tool-sphere').onclick = () => {
    spawnPart('sphere');
};

document.getElementById('tool-cylinder').onclick = () => {
    spawnPart('cylinder');
};

document.getElementById('tool-wedge').onclick = () => {
    spawnPart('wedge');
};

document.getElementById('tool-music').onclick = () => {
    playSwitch();
    // Create invisible file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*'; // Accept audio files
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.onchange = (e) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            const reader = new FileReader();
            
            // Show loading or status?
            reader.onload = (evt) => {
                const result = evt.target.result;
                // Removed size limit check
                world.bgm = result;
                alert("Music file loaded! It will play when the game starts.");
                fileInput.remove();
            };
            
            reader.readAsDataURL(e.target.files[0]);
        } else {
            fileInput.remove();
        }
    };
    
    fileInput.click();
};

function spawnPart(type) {
    playSwitch();
    const dist = 10;
    const spawnPos = new THREE.Vector3(0, 0, -dist).applyQuaternion(camera.quaternion).add(camera.position);
    // Snap to grid
    spawnPos.x = Math.round(spawnPos.x / 4) * 4;
    spawnPos.y = Math.max(2, Math.round(spawnPos.y / 4) * 4);
    spawnPos.z = Math.round(spawnPos.z / 4) * 4;
    
    let size = {x: 4, y: 4, z: 4};
    if (type === 'block') size = {x: 4, y: 1, z: 2};
    if (type === 'cylinder') size = {x: 4, y: 4, z: 4};
    if (type === 'wedge') size = {x: 4, y: 4, z: 4};

    // Use createPart or createBlock
    let mesh;
    if (type === 'block') {
        mesh = world.createBlock(spawnPos.x, spawnPos.y, spawnPos.z, size.x, size.y, size.z, 0xaaaaaa, ['static']);
    } else {
        mesh = world.createPart(type, spawnPos.x, spawnPos.y, spawnPos.z, size, 0xaaaaaa, ['static']);
    }

    studioSelected = mesh;
    updateExplorer(); // Add to list
    updateStudioSelection();
}

document.getElementById('tool-delete').onclick = () => {
    if (studioSelected) {
        transformControl.detach();
        world.mapGroup.remove(studioSelected);
        // Remove from world lists
        const idxI = world.items.indexOf(studioSelected);
        if (idxI > -1) world.items.splice(idxI, 1);
        const idxC = world.collidables.indexOf(studioSelected);
        if (idxC > -1) world.collidables.splice(idxC, 1);
        
        if (studioSelected.geometry) studioSelected.geometry.dispose();
        studioSelected = null;
        hoverHelper.visible = false;
        selectionHelper.visible = false;
        // clear props
        updateStudioPropertiesUI(); // will default/fail gracefully
        updateExplorer(); // Refresh list
    }
};

// --- Rig Bot & Studio Day/Night: spawn rig, speak, toggle lighting ---
async function spawnRig() {
    playSwitch();

    // Create a default player-model rig using the same factory as players so it looks like a real player
    const rid = 'rigbot-' + Date.now();
    const materialsStore = {};
    const rigMesh = createPlayerMesh(materialsStore);
    rigMesh.name = 'RigBot';
    rigMesh.userData = { isRig: true, id: rid };

    // Position it a few units in front of the camera
    const pos = camera.position.clone().add(new THREE.Vector3(0, 0, -8).applyQuaternion(camera.quaternion));
    rigMesh.position.copy(pos);

    // Add to the world explorer so it's selectable in studio, but do NOT animate or add AI movement.
    // Keep it out of collidables so it remains a static prop (prevents unexpected physics).
    world.mapGroup.add(rigMesh);
    world.items.push(rigMesh);
    // ensure it's not added to collidables (so it doesn't interfere with camera checks)
    if (world.collidables.includes(rigMesh)) {
        const idx = world.collidables.indexOf(rigMesh);
        if (idx !== -1) world.collidables.splice(idx, 1);
    }

    updateExplorer();
    updatePlayerList();

    // Use the expected head child (createPlayerMesh returns children in the same order as Player)
    const rigHead = rigMesh.children[1] || rigMesh;

    // Click-to-speak: when user clicks the rig in studio, prompt and display bubble + TTS
    const speak = async (text) => {
        if (!text) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 18;
        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", cursive`;
        const metrics = ctx.measureText(text);
        const p = 10;
        const w = Math.max(64, metrics.width + p * 2);
        const h = fontSize + p * 2 + 10;
        canvas.width = w; canvas.height = h;

        ctx.font = `bold ${fontSize}px "Comic Sans Custom", "Comic Sans MS", cursive`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';

        ctx.fillStyle = 'white';
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 3;
        const r = 8;
        ctx.beginPath();
        ctx.moveTo(r, 2);
        ctx.lineTo(w - r, 2);
        ctx.quadraticCurveTo(w, 2, w - 2, r);
        ctx.lineTo(w - 2, h - r - 10);
        ctx.quadraticCurveTo(w - 2, h - 10, w - r, h - 10);
        ctx.lineTo(w/2 + 8, h - 10);
        ctx.lineTo(w/2, h - 2);
        ctx.lineTo(w/2 - 8, h - 10);
        ctx.lineTo(r, h - 10);
        ctx.quadraticCurveTo(2, h - 10, 2, h - r - 10);
        ctx.lineTo(2, r);
        ctx.quadraticCurveTo(2, 2, r, 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'black';
        ctx.fillText(text, w/2, (h - 10)/2);

        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.colorSpace = THREE.SRGBColorSpace;

        const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);
        const scale = 0.025;
        sprite.scale.set(w * scale, h * scale, 1);

        // Attach bubble to the rig head so it sits above the head reliably
        sprite.position.set(0, 1.2, 0);
        rigHead.add(sprite);

        setTimeout(() => {
            if (sprite.parent) sprite.parent.remove(sprite);
            try { sprite.material.map.dispose(); } catch(e){}
            try { sprite.material.dispose(); } catch(e){}
        }, 5000);

        // TTS
        try {
            if (window.websim && websim.textToSpeech) {
                const res = await websim.textToSpeech({ text: text, voice: 'en-male' });
                if (res && res.url) {
                    const audio = new Audio(res.url);
                    audio.play().catch(()=>{});
                }
            } else if ('speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(text);
                speechSynthesis.speak(utter);
            }
        } catch (e) {
            if ('speechSynthesis' in window) {
                const utter = new SpeechSynthesisUtterance(text);
                speechSynthesis.speak(utter);
            }
        }
    };

    // Raycast click handler (keeps working only in STUDIO)
    const onMouseDown = (e) => {
        if (gameState !== 'STUDIO') return;
        if (e.button !== 0) return;
        if (e.target.closest('#studio-gui')) return;

        // Use correct normalized device coordinates (don't divide by UI_ZOOM)
        const mx = (e.clientX / window.innerWidth) * 2 - 1;
        const my = -(e.clientY / window.innerHeight) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(mx, my), camera);
        const hits = rc.intersectObject(rigMesh, true);
        if (hits.length > 0) {
            const txt = prompt("RigBot says:", "Hello! I'm RigBot.");
            if (txt !== null) speak(txt);
        }
    };

    window.addEventListener('mousedown', onMouseDown);

    // Cleanup helper so UI can remove rig cleanly
    rigMesh.userData.dispose = () => {
        // Remove from world.items
        const mi = world.items.indexOf(rigMesh);
        if (mi !== -1) world.items.splice(mi, 1);
        // Ensure not in collidables
        const ci = world.collidables.indexOf(rigMesh);
        if (ci !== -1) world.collidables.splice(ci, 1);
        if (rigMesh.parent) rigMesh.parent.remove(rigMesh);
        window.removeEventListener('mousedown', onMouseDown);
        updateExplorer();
        updatePlayerList();
    };

    return rigMesh;
}

// Toggle Studio Day/Night state
let studioIsDay = true;
function setStudioDayNight(isDay) {
    studioIsDay = !!isDay;
    if (studioIsDay) {
        // Day: brighter sun, blue ambient
        ambient.color.setScalar(1.0);
        ambient.intensity = 0.45;
        if (sun) { sun.intensity = 0.8; sun.visible = true; sun.color.set(0xffffff); }
        addStudioLights(); // Ensure studio lights present if toggled on
        // Reset studio lights intensities for day
        if (studioLights.key) studioLights.key.intensity = 1.0;
        if (studioLights.fill) studioLights.fill.intensity = 0.6;
        if (studioLights.rim) studioLights.rim.intensity = 0.45;
        document.getElementById('studio-ribbon').style.background = '#dfe8f5';
        // Restore skybox as background
        if (world && world.skyboxMesh) scene.background = null;
    } else {
        // Night: dim sun, cool ambient, stronger rim for contrast
        ambient.color.set(0x99aabf);
        ambient.intensity = 0.12;
        if (sun) { sun.intensity = 0.12; sun.visible = false; }
        addStudioLights();
        if (studioLights.key) studioLights.key.intensity = 0.35;
        if (studioLights.fill) studioLights.fill.intensity = 0.25;
        if (studioLights.rim) studioLights.rim.intensity = 0.6;
        document.getElementById('studio-ribbon').style.background = '#1b2430';
        // Set a pure black sky for night
        scene.background = new THREE.Color(0x000000);
    }
}

document.getElementById('tool-studio-daynight').onclick = () => {
    playSwitch();
    setStudioDayNight(!studioIsDay);
};

// Title Screen Interactions
document.querySelectorAll('#start-menu .menu-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const wrapper = document.createElement('div');
        const rect = btn.getBoundingClientRect();
        
        wrapper.style.position = 'fixed';
        wrapper.style.left = (rect.right + 10) + 'px';
        wrapper.style.top = rect.top + 'px';
        wrapper.style.zIndex = '10000';
        wrapper.style.pointerEvents = 'none';
        
        const bubble = document.createElement('img');
        bubble.src = '/Chat.png';
        bubble.style.width = '50px';
        bubble.style.height = '40px';
        
        const dots = document.createElement('div');
        dots.textContent = '...';
        dots.style.position = 'absolute';
        dots.style.top = '4px';
        dots.style.left = '14px';
        dots.style.fontSize = '20px';
        dots.style.fontWeight = 'bold';
        dots.style.color = 'black';
        
        wrapper.appendChild(bubble);
        wrapper.appendChild(dots);
        document.body.appendChild(wrapper);
        
        setTimeout(() => wrapper.remove(), 2000);
    });
});

const _propColorEl = document.getElementById('prop-color');
if (_propColorEl) {
    _propColorEl.addEventListener('input', (e) => {
        // handled by onPropChange now, but live update is nice
        if (studioSelected) {
            const c = new THREE.Color(e.target.value);
            if (Array.isArray(studioSelected.material)) {
                studioSelected.material.forEach(m => m.color = c);
            } else if (studioSelected.material) {
                studioSelected.material.color = c;
            }
            // Update serial data
            if (studioSelected.userData && studioSelected.userData.serial) {
                studioSelected.userData.serial.color = c.getHex();
            }
        }
    });
}

document.getElementById('btn-studio').onclick = () => {
    playSwitch();
    menuBGM.pause();
    startMenu.style.display = 'none';
    studioGui.style.display = 'flex';
    gameState = 'STUDIO';
    
    // Enable nicer studio lighting for modeling
    addStudioLights();

    editingGameName = null;
    isRemixMode = false;

    world.loadMap('baseplate');
    if (world.mapGroup) world.mapGroup.visible = true;
    player.mesh.visible = false;
    
    updateExplorer(); // Init explorer

    // Reset Cam
    studioCamPos.set(0, 20, 20);
    studioCamYaw = 0;
    studioCamPitch = -0.7;
};

btnPlaySolo.onclick = () => {
    playSwitch();
    // Switch to test mode (like playing, but returns to studio)
    gameState = 'TEST';
    studioGui.style.display = 'none';
    transformControl.detach();
    btnStopTest.style.display = 'block';
    
    player.mesh.visible = true;
    player.respawn(world);
};

btnStopTest.onclick = () => {
    playSwitch();
    gameState = 'STUDIO';
    player.mesh.visible = false;
    btnStopTest.style.display = 'none';
    studioGui.style.display = 'flex';
    // Restore selection?
    if (studioSelected) transformControl.attach(studioSelected);
};

document.getElementById('btn-studio-exit').onclick = () => {
    playSwitch();

    // Disable studio lighting when leaving
    removeStudioLights();

    studioGui.style.display = 'none';
    startMenu.style.display = 'flex';
    gameState = 'MENU';
    tryPlayBGM();
    transformControl.detach();
    studioSelected = null;
    hoverHelper.visible = false;
    if (world.mapGroup) world.mapGroup.visible = false;
    player.mesh.visible = true;
};



// Menu UI Logic

// Functionality: persistent local friend storage and helpers
function getFriends() {
    try {
        return JSON.parse(localStorage.getItem('chirpless_friends') || '{}');
    } catch (e) { return {}; }
}
function saveFriends(obj) {
    try { localStorage.setItem('chirpless_friends', JSON.stringify(obj)); } catch(e){}
}
function addFriend(id, name) {
    const f = getFriends();
    f[id] = { id: id, name: name, added: Date.now() };
    saveFriends(f);
}
function removeFriend(id) {
    const f = getFriends();
    if (f[id]) {
        delete f[id];
        saveFriends(f);
    }
}
function isFriend(id) {
    return !!getFriends()[id];
}

// Function to handle player list updates
function updatePlayerList() {
    const username = document.getElementById('input-username').value || "Guest";
    const rKeys = Object.keys(remotePlayers);
    const totalPlayers = 1 + rKeys.length; 
    
    // Update Title with Count
    const titleBar = playerList.querySelector('.xp-title-bar span');
    if (titleBar) titleBar.textContent = `Players (${totalPlayers})`;

    // Build friend set
    const friends = getFriends();

    // Rebuild List (include friend buttons)
    let html = `<div style="display:flex; align-items:center; gap:5px; margin-bottom: 5px;">
        <div style="width:8px; height:8px; background:#00cc00; border-radius:50%; box-shadow: 0 0 2px #0f0;"></div>
        <b>${username}</b>
    </div>`;

    rKeys.forEach(key => {
        const p = remotePlayers[key];
        const friendLabel = friends[key] ? 'Unfriend' : 'Add Friend';
        const friendClass = friends[key] ? 'friend-yes' : 'friend-no';
        const star = friends[key] ? '★' : '☆';
        html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom: 5px; justify-content:space-between;">
            <div style="display:flex; align-items:center; gap:5px;">
                <div style="width:8px; height:8px; background:#00cc00; border-radius:50%; box-shadow: 0 0 2px #0f0;"></div>
                <span style="font-weight:600;">${p.name}</span>
                <span style="color:#aa0; margin-left:6px;">${star}</span>
            </div>
            <div style="display:flex; gap:6px;">
                <button data-peer="${key}" class="menu-btn btn-friend" style="width:110px; padding:4px 6px; font-size:12px;">${friendLabel}</button>
            </div>
        </div>`;
    });

    playerListContent.innerHTML = html;

    // Also populate the fixed left-side leaderbar with icon + username rows
    try {
        const listEl = document.getElementById('plist-content');
        const countEl = document.getElementById('player-count');
        if (listEl) {
            listEl.innerHTML = '';
            // Local player row
            const username = document.getElementById('input-username').value || "Guest";
            const youRow = document.createElement('div');
            youRow.style.display = 'flex';
            youRow.style.alignItems = 'center';
            youRow.style.gap = '8px';
            youRow.style.padding = '6px';
            youRow.style.borderRadius = '6px';
            youRow.style.background = '#fff';
            youRow.innerHTML = `<div style="flex:1;font-weight:bold;">${username} (you)</div>`;
            listEl.appendChild(youRow);

            // Remote players
            Object.keys(remotePlayers).forEach(key => {
                const p = remotePlayers[key];
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '8px';
                row.style.padding = '6px';
                row.style.borderRadius = '6px';
                row.style.background = '#fff';
                row.innerHTML = `<div style="flex:1;">${p.name}</div>`;
                listEl.appendChild(row);
            });
        }
        if (countEl) countEl.textContent = String(1 + Object.keys(remotePlayers).length);
    } catch(e){}

    // Attach handlers to friend buttons
    const btns = playerListContent.querySelectorAll('.btn-friend');
    btns.forEach(b => {
        b.addEventListener('click', (e) => {
            const peerId = b.getAttribute('data-peer');
            const rp = remotePlayers[peerId];
            if (!rp) return;
            if (isFriend(peerId)) {
                // Unfriend locally
                removeFriend(peerId);
                addChatMessage('System', `You unfriended ${rp.name}.`);
                updatePlayerList();
            } else {
                // Send friend request to peer (they will be prompted)
                try {
                    room.send({ type: 'friend_request', targetId: peerId, username: document.getElementById('input-username').value || 'Guest' });
                    addChatMessage('System', `Friend request sent to ${rp.name}.`);
                } catch (e) {
                    console.warn('Failed to send friend request:', e);
                    addChatMessage('System', `Failed to send friend request to ${rp.name}.`);
                }
            }
        });
    });
}



// Reviews System
const getReviews = (mapName) => {
    try {
        const store = JSON.parse(localStorage.getItem('chirpless_reviews') || '{}');
        return store[mapName] || [];
    } catch (e) { return []; }
};

const saveReviews = (mapName, reviews) => {
    try {
        const store = JSON.parse(localStorage.getItem('nblox_reviews') || '{}');
        store[mapName] = reviews;
        localStorage.setItem('nblox_reviews', JSON.stringify(store));
    } catch (e) {}
};

const renderReviews = (mapName) => {
    const list = document.getElementById('gd-reviews-list');
    list.innerHTML = '';
    let reviews = getReviews(mapName);

    // Human name pool to make reviews feel varied
    const humanNames = ['Maya','Tom','Ava','Ben','Skyler','Jules','Rin','Noah','Lina','Omar','Zoe','Kai','Priya','Luca','Mina','Eli','Sasha','Ivy','Mason'];

    // If no reviews exist, seed a few human-like example reviews for common maps
    if (!reviews || reviews.length === 0) {
        const seedBase = {
            'platform': [
                { text: 'Nice chill hub — great to meet friends here.', ago: 1 },
                { text: 'Could use a few more spawn points but overall good.', ago: 0.04 }
            ],
            'sillyville': [
                { text: 'Loved planting seeds! Cute and relaxing.', ago: 0.08 },
                { text: 'Wish the plants grew faster, but fun loop.', ago: 0.4 }
            ],
            'lucky_world': [
                { text: 'Coins are everywhere and pets are adorable, 10/10!', ago: 0.02 }
            ],
            'chirpcity': [
                { text: 'City is huge and fun to explore, a few places felt empty though.', ago: 0.05 }
            ],
            'blocks': [
                { text: 'Made this park—hope you enjoy the mini-golf!', ago: 0.01 },
                { text: 'Benches are a cute touch. Sat and watched people play.', ago: 0.003 }
            ],
            'home': [
                { text: 'Creepy in a good way — ghost teleporting gave me a jump scare.', ago: 0.06 },
                { text: 'Loved the atmosphere and subtle scares.', ago: 0.0025 }
            ]
        };
        const seed = seedBase[mapName] || [{ text: 'Nice place to visit!', ago: 0.1 }];
        reviews = seed.map(s => ({
            author: humanNames[Math.floor(Math.random() * humanNames.length)],
            text: s.text,
            date: Date.now() - Math.floor(s.ago * 24 * 60 * 60 * 1000),
            replies: []
        }));
        saveReviews(mapName, reviews);
    }

    if (!reviews || reviews.length === 0) {
        list.innerHTML = '<div style="color: #666; font-style: italic;">No reviews yet. Be the first!</div>';
        return;
    }

    reviews.forEach((rev, index) => {
        const div = document.createElement('div');
        div.style.marginBottom = '8px';
        div.style.borderBottom = '1px dashed #ccc';
        div.style.paddingBottom = '4px';

        const header = document.createElement('div');
        header.style.color = 'blue';
        header.style.fontWeight = 'bold';
        header.textContent = rev.author + ' says:';
        div.appendChild(header);

        const body = document.createElement('div');
        body.textContent = rev.text;
        body.style.marginLeft = '5px';
        div.appendChild(body);

        // Reply Button
        const replyBtn = document.createElement('a');
        replyBtn.textContent = 'Reply';
        replyBtn.style.fontSize = '10px';
        replyBtn.style.color = '#666';
        replyBtn.style.textDecoration = 'underline';
        replyBtn.style.cursor = 'pointer';
        replyBtn.style.marginLeft = '5px';
        replyBtn.onclick = () => {
            const replyText = prompt("Reply to " + rev.author + ":");
            if (replyText) {
                rev.replies.push({
                    author: document.getElementById('input-username').value || "Guest",
                    text: replyText
                });
                saveReviews(mapName, reviews);
                renderReviews(mapName);
            }
        };
        div.appendChild(replyBtn);

        // Render Replies
        if (rev.replies && rev.replies.length > 0) {
            const repliesDiv = document.createElement('div');
            repliesDiv.style.marginLeft = '15px';
            repliesDiv.style.marginTop = '4px';
            repliesDiv.style.borderLeft = '2px solid #ccc';
            repliesDiv.style.paddingLeft = '5px';
            
            rev.replies.forEach(rep => {
                const rDiv = document.createElement('div');
                rDiv.style.fontSize = '11px';
                rDiv.style.marginTop = '2px';
                rDiv.innerHTML = `<span style="color:#008; font-weight:bold;">${rep.author}</span>: ${rep.text}`;
                repliesDiv.appendChild(rDiv);
            });
            div.appendChild(repliesDiv);
        }

        list.appendChild(div);
    });
};

function updateGameDetailPlayerCount() {
    const el = document.getElementById('gd-player-count');
    if (!el || gameDetailMenu.style.display === 'none' || !pendingGameStart) return;
    
    const targetMap = pendingGameStart.name;
    let count = 0;
    
    // Count players (including self if playing) with matching map
    const presences = room.presence || {};
    for (const id in presences) {
        const p = presences[id];
        if (p && p.map === targetMap) {
            count++;
        }
    }
    
    el.textContent = `${count} Players Online`;
}

document.getElementById('btn-post-review').onclick = () => {
    if (!pendingGameStart) return;
    const input = document.getElementById('gd-review-input');
    const text = input.value.trim();
    if (!text) return;
    
    playSwitch();
    
    const mapName = pendingGameStart.name;
    const reviews = getReviews(mapName);
    
    reviews.push({
        author: document.getElementById('input-username').value || "Guest",
        text: text,
        date: Date.now(),
        replies: []
    });
    
    saveReviews(mapName, reviews);
    input.value = '';
    renderReviews(mapName);
    updateGameDetailPlayerCount();
};

// Game Launching
let pendingGameStart = null; // { name, data }

const openGameDetail = (title, mapName, mapData = null) => {
    playSwitch();
    try { if (playMenu) playMenu.style.display = 'none'; } catch(e){}
    try { if (gameDetailMenu) gameDetailMenu.style.display = 'block'; } catch(e){}

    // Safely set window title and header if present
    const winTitleEl = document.getElementById('gd-window-title');
    if (winTitleEl) winTitleEl.textContent = title;
    const headerTitleEl = document.getElementById('gd-title');
    if (headerTitleEl) headerTitleEl.textContent = title;

    // Don't display or inject any author/credit line for game detail (author intentionally hidden).
    // Remember where we came from so Back can restore playing session if applicable
    pendingGameStart = { name: mapName, data: mapData };
    try { prevGameState = gameState; } catch(e) {}
    
    // Load reviews and update player count only if appropriate elements exist
    try { renderReviews(mapName); } catch(e){}
    try { updateGameDetailPlayerCount(); } catch(e){}
};

async function startGame(mapName, mapData = null) {
    playSwitch();

    // Create simple loading overlay like 2006 Roblox (reused/created)
    let loadOverlay = document.getElementById('__nblox_load_overlay');
    if (!loadOverlay) {
        loadOverlay = document.createElement('div');
        loadOverlay.id = '__nblox_load_overlay';
        loadOverlay.style.position = 'fixed';
        loadOverlay.style.left = '0';
        loadOverlay.style.top = '0';
        loadOverlay.style.width = '100%';
        loadOverlay.style.height = '100%';
        loadOverlay.style.zIndex = '999999';
        loadOverlay.style.display = 'flex';
        loadOverlay.style.alignItems = 'center';
        loadOverlay.style.justifyContent = 'center';
        loadOverlay.style.background = 'rgba(0,0,0,0.85)';
        loadOverlay.style.color = 'white';
        loadOverlay.style.fontFamily = 'Comic Sans Custom, "Comic Sans MS", cursive, sans-serif';
        loadOverlay.innerHTML = `
            <div style="text-align:center;">
                <div id="__nblox_load_title" style="font-size:22px; font-weight:bold; margin-bottom:8px;">Loading...</div>
                <div style="font-size:16px; margin-bottom:6px;" id="__nblox_load_info">0 Bricks</div>
                <div style="font-size:14px;" id="__nblox_load_progress">0 Loaded</div>
            </div>
        `;
        document.body.appendChild(loadOverlay);
    }
    loadOverlay.style.display = 'flex';

    // Prevent accidental immediate rejoin if a cooldown is active
    if (Date.now() < (suppressAutoJoinUntil || 0)) {
        alert('Please wait a moment before rejoining a game.');
        return;
    }

    // Quiet the menu music (keep playing but much quieter) so game audio blends in.
    try {
        if (menuBGM.audio && !menuBGM.quieted) {
            prevMenuVolume = typeof menuBGM.audio.volume === 'number' ? menuBGM.audio.volume : menuBGM.volume;
            menuBGM.audio.volume = Math.max(0, prevMenuVolume * 0.25);
            menuBGM.quieted = true;
        } else if (!menuBGM.audio && menuBGM.playing) {
            menuBGM.quieted = true;
        }
    } catch (e) {
        console.warn('Failed to quiet menu BGM:', e);
    }

    // Special-case: Chirpless Puzzles should show a classic brick loader with a fixed brick count
    let useFixedBrickCount = false;
    let fixedBrickCount = 0;
    if (mapName === 'chirpless_puzzles') {
        useFixedBrickCount = true;
        fixedBrickCount = 284; // as requested
    }

    // Step 1: load map synchronously into world (this prepares world.items) for normal maps
    if (!useFixedBrickCount) {
        if (mapData) {
            world.loadFromData(mapData);
        } else {
            world.loadMap(mapName);
        }
    } else {
        // For puzzles, prepare lightweight placeholder world (we reuse platform so player has a stage)
        world.loadMap('platform');
    }

    // Determine total bricks/items to "load"
    const totalBricks = useFixedBrickCount ? Math.max(1, fixedBrickCount) : Math.max(1, world.items.length || 0);
    const loadInfo = document.getElementById('__nblox_load_info');
    const loadProgress = document.getElementById('__nblox_load_progress');
    const title = document.getElementById('__nblox_load_title');

    // Display "Loading Game" with brick counts
    title.textContent = `Loading Game`;
    loadInfo.textContent = `0 bricks loaded, ${totalBricks} to load`;
    loadProgress.textContent = `0 Loaded`;

    // Simulate incremental loading so it feels like classic brick streaming.
    // While loading, rotate the skybox slowly to give motion.
    let loaded = 0;
    const start = Date.now();
    const loadInterval = Math.max(20, Math.floor(800 / Math.min(200, totalBricks)));
    const loaderTick = setInterval(() => {
        // rotate skybox for visual motion
        try { if (world && world.skyboxMesh) world.skyboxMesh.rotation.y += 0.01; } catch(e){}

        const step = Math.max(1, Math.floor(Math.random() * Math.max(1, totalBricks / 20)));
        loaded = Math.min(totalBricks, loaded + step);
        loadProgress.textContent = `${loaded} Loaded`;
        loadInfo.textContent = `${loaded} bricks loaded, ${totalBricks} to load`;

        if (loaded >= totalBricks) {
            clearInterval(loaderTick);
            setTimeout(() => {
                try { loadOverlay.style.display = 'none'; } catch (e) {}
                // Ensure skybox rotation stops subtle motion by syncing to camera
                try { if (world && world.skyboxMesh) world.skyboxMesh.rotation.y = 0; } catch(e){}
                continueAfterLoad(mapName);
            }, 350);
        }
    }, loadInterval);

    // Fallback timer to ensure overlay hides
    const fallback = setTimeout(() => {
        if (document.getElementById('__nblox_load_overlay') && document.getElementById('__nblox_load_overlay').style.display !== 'none') {
            try { document.getElementById('__nblox_load_overlay').style.display = 'none'; } catch(e){}
            continueAfterLoad(mapName);
        }
        clearTimeout(fallback);
    }, 10000);

    // After load: usual start flow but with puzzle UI when appropriate
    function continueAfterLoad(mapNameLocal) {
        try { const o = document.getElementById('__nblox_load_overlay'); if (o) o.style.display = 'none'; } catch(e){}

        // Hide menus
        playMenu.style.display = 'none';
        gameDetailMenu.style.display = 'none';
        startMenu.style.display = 'none';

        chatContainer.style.display = 'flex';
        btnExit.style.display = 'block';
        btnReset.style.display = 'block';
        gameState = 'PLAYING';
        player.forcedAnim = null;

        const username = document.getElementById('input-username').value || "Guest";
        addChatMessage("System", `${username} has joined the game.`);

        playerList.style.display = 'flex';
        updatePlayerList();

        // map specific UI/hud handling
        if (mapNameLocal === 'lucky_world') {
            playerCoins = 0;
            updateCoinUI();
            document.getElementById('lucky-hud').style.display = 'block';
        } else {
            document.getElementById('lucky-hud').style.display = 'none';
        }

        // (other per-map code omitted here for brevity — retained elsewhere)

        // Handle Custom Music
        if (gameBGM) { gameBGM.pause(); gameBGM = null; }
        if (world.bgm) {
            gameBGM = new Audio(world.bgm);
            gameBGM.loop = true;
            gameBGM.volume = 0.5;
            gameBGM.play().catch(e => console.log("Audio play failed", e));
        }

        if (world.mapGroup) world.mapGroup.visible = true;
        player.respawn(world);

        // Auto-lock mouse on start
        setTimeout(() => {
            if (gameState === 'PLAYING') {
                renderer.domElement.requestPointerLock().catch(() => {});
            }
        }, 100);

        // Switch to the game-specific Supabase Realtime channel FIRST,
        // then broadcast presence so all players in this map see each other.
        try {
            await room.switchRoom(mapNameLocal);
            room.updatePresence({
                username: document.getElementById('input-username').value || "Guest",
                appearance: player.serializeAppearance(),
                map: mapNameLocal,
                position: player.position,
                rotation: player.mesh.rotation.y,
                animState: 'idle'
            });
        } catch (e) {
            console.warn("Failed to join room / update presence:", e);
        }

        // If this is the puzzles game, present a simple puzzle UI (6 levels, increasing difficulty)
        if (mapNameLocal === 'chirpless_puzzles') {
            showPuzzleUI();
        }
    } // end continueAfterLoad

    // Simple puzzle UI implementation (6 levels, increments difficulty)
    function showPuzzleUI() {
        // Remove any existing puzzle UI
        const existing = document.getElementById('__chirp_puzzle_ui');
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.id = '__chirp_puzzle_ui';
        container.style.position = 'fixed';
        container.style.left = '50%';
        container.style.top = '50%';
        container.style.transform = 'translate(-50%, -50%)';
        container.style.width = 'min(92vw, 640px)';
        container.style.maxHeight = '80vh';
        container.style.overflow = 'auto';
        container.style.background = '#f4f4f4';
        container.style.border = '4px solid #222';
        container.style.borderRadius = '8px';
        container.style.zIndex = '1000001';
        container.style.padding = '12px';
        container.style.fontFamily = 'Comic Sans Custom, "Comic Sans MS", cursive';
        container.style.boxShadow = '0 8px 24px rgba(0,0,0,0.6)';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.innerHTML = `<div style="font-size:20px; font-weight:bold; color:#003366;">Chirpless Puzzles</div>
                            <div style="font-size:12px; color:#555">Level <span id="__chirp_puzzle_level">1</span> / 6</div>`;
        container.appendChild(header);

        const desc = document.createElement('div');
        desc.id = '__chirp_puzzle_desc';
        desc.style.marginTop = '8px';
        desc.style.fontSize = '14px';
        desc.style.color = '#111';
        container.appendChild(desc);

        // Puzzle area (we'll implement simple pattern puzzles: press correct sequence of colored buttons)
        const puzzleArea = document.createElement('div');
        puzzleArea.style.display = 'flex';
        puzzleArea.style.flexDirection = 'column';
        puzzleArea.style.alignItems = 'center';
        puzzleArea.style.gap = '10px';
        puzzleArea.style.marginTop = '12px';
        container.appendChild(puzzleArea);

        const buttonsRow = document.createElement('div');
        buttonsRow.style.display = 'flex';
        buttonsRow.style.gap = '8px';
        puzzleArea.appendChild(buttonsRow);

        const feedback = document.createElement('div');
        feedback.id = '__chirp_puzzle_feedback';
        feedback.style.fontSize = '14px';
        feedback.style.color = '#006600';
        container.appendChild(feedback);

        const controlsRow = document.createElement('div');
        controlsRow.style.display = 'flex';
        controlsRow.style.justifyContent = 'center';
        controlsRow.style.gap = '8px';
        controlsRow.style.marginTop = '10px';
        container.appendChild(controlsRow);

        const btnAbort = document.createElement('button');
        btnAbort.className = 'menu-btn';
        btnAbort.textContent = 'Exit';
        btnAbort.onclick = () => {
            playSwitch();
            container.remove();
            // Return player to menu safely
            btnExit.click();
        };
        controlsRow.appendChild(btnAbort);

        const btnNext = document.createElement('button');
        btnNext.className = 'menu-btn';
        btnNext.textContent = 'Next';
        btnNext.style.display = 'none';
        controlsRow.appendChild(btnNext);

        document.body.appendChild(container);

        // Puzzle logic
        let level = 1;
        const maxLevel = 6;
        let pattern = [];
        let playerSeq = [];
        const colors = ['#ff4444', '#44ff44', '#4444ff', '#ffdd44'];
        const btns = [];

        function renderButtons(count) {
            buttonsRow.innerHTML = '';
            btns.length = 0;
            for (let i = 0; i < count; i++) {
                const b = document.createElement('button');
                b.className = 'menu-btn';
                b.style.width = '56px';
                b.style.height = '56px';
                b.style.borderRadius = '8px';
                b.style.padding = '0';
                b.style.border = '2px solid #333';
                b.style.background = colors[i % colors.length];
                b.dataset.idx = i;
                b.onclick = () => {
                    playSwitch();
                    playerSeq.push(parseInt(b.dataset.idx));
                    checkProgress();
                };
                buttonsRow.appendChild(b);
                btns.push(b);
            }
        }

        function buildPattern(len) {
            const arr = [];
            for (let i = 0; i < len; i++) {
                arr.push(Math.floor(Math.random() * Math.min(4, btns.length)));
            }
            return arr;
        }

        function showPattern(seq, i = 0) {
            if (i >= seq.length) {
                feedback.textContent = 'Your turn!';
                return;
            }
            const idx = seq[i];
            const b = btns[idx];
            if (!b) { showPattern(seq, i+1); return; }
            const orig = b.style.filter || '';
            b.style.transform = 'scale(1.12)';
            setTimeout(() => {
                b.style.transform = '';
                setTimeout(() => showPattern(seq, i+1), 300);
            }, 350);
        }

        function startLevel(lv) {
            playerSeq = [];
            feedback.textContent = 'Watch the pattern...';
            // Increase complexity with level: number of buttons and pattern length
            const btnCount = Math.min(4, 2 + Math.floor((lv - 1) / 2)); // 2..4
            renderButtons(btnCount);
            const patternLen = 3 + lv; // grows with level (4..9)
            pattern = buildPattern(patternLen);
            // show pattern after small delay
            setTimeout(() => showPattern(pattern, 0), 500);
            document.getElementById('__chirp_puzzle_level').textContent = String(lv);
            desc.textContent = `Replicate the flashing sequence. Level ${lv} has ${patternLen} steps.`;
            btnNext.style.display = 'none';
        }

        function checkProgress() {
            for (let i = 0; i < playerSeq.length; i++) {
                if (playerSeq[i] !== pattern[i]) {
                    feedback.style.color = '#aa0000';
                    feedback.textContent = 'Wrong! Try again from start of this level.';
                    playerSeq = [];
                    // replay pattern shortly
                    setTimeout(() => {
                        feedback.style.color = '#006600';
                        feedback.textContent = 'Watch the pattern...';
                        setTimeout(() => showPattern(pattern, 0), 500);
                    }, 800);
                    return;
                }
            }
            if (playerSeq.length === pattern.length) {
                feedback.style.color = '#006600';
                feedback.textContent = 'Correct! Level complete.';
                if (level >= maxLevel) {
                    // Win
                    setTimeout(() => {
                        feedback.textContent = 'You completed all puzzles! Well done!';
                        btnNext.style.display = 'none';
                        const winBtn = document.createElement('button');
                        winBtn.className = 'menu-btn';
                        winBtn.textContent = 'Return to Menu';
                        winBtn.onclick = () => {
                            playSwitch();
                            container.remove();
                            btnExit.click();
                        };
                        controlsRow.appendChild(winBtn);
                    }, 400);
                } else {
                    btnNext.style.display = 'inline-block';
                    btnNext.onclick = () => {
                        playSwitch();
                        level++;
                        playerSeq = [];
                        btnNext.style.display = 'none';
                        startLevel(level);
                    };
                }
            }
        }

        // Start first level
        startLevel(level);
    }
}

document.getElementById('btn-play').onclick = () => {
    playSwitch();
    startMenu.style.display = 'none';
    playMenu.style.display = 'block';

    // Re-apply the user's saved theme to the play menu area and ensure it fills the viewport
    setThemeForAll(savedThemePref || 'lightred');
    try { 
        const popup = playMenu.querySelector('.menu-popup'); 
        if (popup) { 
            // Force the Explore popup to fill the viewport (full-screen) so it fits the screen reliably.
            popup.style.width = '100vw'; 
            popup.style.height = '100vh'; 
            popup.style.top = '0'; 
            popup.style.left = '0'; 
            popup.style.transform = 'none'; 
            popup.style.maxWidth = 'none'; 
        } 
    } catch(e){}

    const list = document.getElementById('world-list');
    list.innerHTML = '';

    // Create top tabs: Games | Groups | Customize Character
    const tabsRow = document.createElement('div');
    tabsRow.style.display = 'flex';
    tabsRow.style.gap = '8px';
    tabsRow.style.alignItems = 'center';
    tabsRow.style.marginBottom = '8px';

    const tabGames = document.createElement('button');
    tabGames.className = 'menu-btn';
    tabGames.textContent = 'Games';
    tabGames.style.padding = '6px 12px';

    const tabGroups = document.createElement('button');
    tabGroups.className = 'menu-btn';
    tabGroups.textContent = 'Groups';
    tabGroups.style.padding = '6px 12px';

    const tabCustomize = document.createElement('button');
    tabCustomize.className = 'menu-btn';
    tabCustomize.textContent = 'Customize Character';
    tabCustomize.style.padding = '6px 12px';

    tabsRow.appendChild(tabGames);
    tabsRow.appendChild(tabGroups);
    tabsRow.appendChild(tabCustomize);
    list.appendChild(tabsRow);

    // Container that will host each tab's content
    const tabContent = document.createElement('div');
    tabContent.style.width = '100%';
    tabContent.style.height = '68vh';
    tabContent.style.overflow = 'auto';
    tabContent.style.padding = '6px';
    // New: nicer gradient background for Explore page area
    tabContent.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.6), rgba(240,246,255,0.9))';
    tabContent.style.borderRadius = '8px';
    tabContent.style.boxShadow = '0 6px 18px rgba(12,34,56,0.06)';
    list.appendChild(tabContent);

    // --- Games Tab (reuse previous game list UI) ---
    const makeGamesTab = () => {
        tabContent.innerHTML = '';

        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.gap = '8px';
        controls.style.alignItems = 'center';
        controls.style.marginBottom = '8px';

        const search = document.createElement('input');
        search.type = 'search';
        search.placeholder = 'Search games...';
        search.style.flex = '1';
        search.style.padding = '6px';
        search.style.fontSize = '14px';
        search.id = 'game-search';

        const filter = document.createElement('select');
        filter.style.padding = '6px';
        filter.id = 'game-filter';
        filter.innerHTML = `
            <option value="popular">Popular</option>
            <option value="most_upvoted">Most Upvoted</option>
            <option value="most_downvoted">Most Downvoted</option>
        `;

        // Import button for .rblx files
        const importBtn = document.createElement('button');
        importBtn.className = 'menu-btn';
        importBtn.textContent = 'Import .rblx';
        importBtn.style.padding = '6px 10px';

        // Hidden file input used for selecting .rblx files
        const importInput = document.createElement('input');
        importInput.type = 'file';
        // Accept both legacy .rblx and new .fndry share format (both are JSON-based)
        importInput.accept = '.rblx,.fndry,application/json';
        importInput.style.display = 'none';

        importBtn.addEventListener('click', () => {
            playSwitch();
            importInput.click();
        });

        importInput.addEventListener('change', (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    // Try parse as JSON world data
                    const txt = ev.target.result;
                    let parsed = null;
                    try { parsed = JSON.parse(txt); } catch (err) { parsed = null; }

                    // If file extension is .fndry, support its v1 wrapper
                    const name = (f.name || '').toLowerCase();
                    if (name.endsWith('.fndry')) {
                        if (parsed && parsed.world) {
                            pendingGameStart = { name: parsed.name || parsed.meta?.name || 'Imported', data: parsed.world };
                            startGame(pendingGameStart.name, parsed.world);
                            return;
                        } else {
                            alert('Invalid .fndry file (missing world payload).');
                            return;
                        }
                    }

                    if (parsed && Array.isArray(parsed)) {
                        // Assume it's the serialized world data -> start game with it
                        pendingGameStart = { name: 'Imported', data: parsed };
                        startGame('Imported', parsed);
                    } else if (parsed && parsed.world) {
                        // Some .rblx bundles might wrap world under 'world' key
                        pendingGameStart = { name: parsed.meta && parsed.meta.name ? parsed.meta.name : 'Imported', data: parsed.world };
                        startGame(pendingGameStart.name, parsed.world);
                    } else {
                        alert('Imported file appears invalid. Expected JSON map data.');
                    }
                } catch (err) {
                    console.warn('Import failed', err);
                    alert('Failed to import file: ' + (err && err.message ? err.message : String(err)));
                }
            };
            // Read as text; .rblx/.fndry are treated like JSON bundle
            reader.readAsText(f);
            // clear input for future imports
            importInput.value = '';
        });

        controls.appendChild(search);
        controls.appendChild(filter);
        controls.appendChild(importBtn);
        tabContent.appendChild(controls);
        // keep the hidden input attached to DOM so it works on mobile
        tabContent.appendChild(importInput);

        const rows = document.createElement('div');
        rows.style.display = 'flex';
        rows.style.flexDirection = 'column';
        rows.style.gap = '10px';
        rows.style.padding = '6px';
        rows.style.overflowY = 'auto';
        rows.style.maxHeight = '62vh';
        tabContent.appendChild(rows);

        // Remote games cache (fetched from Supabase)
        if (!window._remoteGamesCache) window._remoteGamesCache = { fetched: false, list: [] };

        const fetchRemoteGames = async () => {
            // If we've already fetched once, skip.
            if (window._remoteGamesCache.fetched) return;
            try {
                const list = await fetchGames();
                const remote = list.map(g => ({
                    id: g.id,
                    name: g.name || 'Published',
                    thumb: g.thumb_url || '/DefaultThumb.png',
                    visits: g.visits || 0,
                    up: g.up || 0,
                    down: g.down || 0,
                    author: g.author || 'Unknown',
                    supabaseData: g
                }));
                window._remoteGamesCache.list = remote;
                window._remoteGamesCache.fetched = true;
                render();
            } catch (e) {
                console.warn('[v0] fetchRemoteGames failed:', e);
                window._remoteGamesCache.fetched = true;
            }
        };

        const render = () => {
            const fil = document.getElementById('game-filter').value;
            const q = document.getElementById('game-search').value || '';
            // local items
            const localItems = getFilteredGames({ filter: fil, search: q });

            // Merge remote published games (if any) ahead of local list, and apply search/filter locally as well
            const rem = (window._remoteGamesCache.list || []).filter(r => {
                if (!q) return true;
                const qq = q.toLowerCase();
                return (r.name && r.name.toLowerCase().includes(qq)) || (r.author && r.author.toLowerCase().includes(qq));
            });

            // Compose final list with published games first (avoid duplicates by id)
            const seenIds = new Set();
            const merged = [];
            rem.forEach(r => { seenIds.add(r.id); merged.push(r); });
            localItems.forEach(li => { if (!seenIds.has(li.id)) merged.push(li); });

            rows.innerHTML = '';
            merged.forEach(g => {
                const isRemote = !!g.supabaseData;

                const container = document.createElement('div');
                container.style.display = 'flex';
                container.style.alignItems = 'stretch';
                container.style.gap = '0';
                container.style.background = '#111316';
                container.style.border = '1px solid rgba(255,255,255,0.07)';
                container.style.borderRadius = '10px';
                container.style.overflow = 'hidden';
                container.style.boxShadow = '0 2px 8px rgba(0,0,0,0.4)';
                container.style.transition = 'background 0.12s, border-color 0.12s';
                container.addEventListener('mouseenter', () => {
                    container.style.background = '#181b1f';
                    container.style.borderColor = 'rgba(255,255,255,0.13)';
                });
                container.addEventListener('mouseleave', () => {
                    container.style.background = '#111316';
                    container.style.borderColor = 'rgba(255,255,255,0.07)';
                });

                // Thumbnail
                const thumbWrap = document.createElement('div');
                thumbWrap.style.position = 'relative';
                thumbWrap.style.flexShrink = '0';
                const thumb = document.createElement('img');
                thumb.src = g.thumb || '/null_plainsky512_ft.jpg';
                thumb.style.width = '170px';
                thumb.style.height = '108px';
                thumb.style.objectFit = 'cover';
                thumb.style.display = 'block';
                thumbWrap.appendChild(thumb);
                container.appendChild(thumbWrap);

                const meta = document.createElement('div');
                meta.style.flex = '1';
                meta.style.display = 'flex';
                meta.style.flexDirection = 'column';
                meta.style.gap = '4px';
                meta.style.padding = '10px 12px';

                // Title
                const title = document.createElement('div');
                title.style.fontWeight = '600';
                title.style.fontSize = '15px';
                title.style.color = '#e6edf3';
                title.style.lineHeight = '1.2';
                title.textContent = g.name;
                meta.appendChild(title);

                // Creator row — plain author name, no avatar, no profile click
                const creatorRow = document.createElement('div');
                creatorRow.style.cssText = `
                    font-size:12px; color:#8b949e;
                    font-weight:500; margin-top:2px;
                `;
                const creatorName = document.createElement('span');
                creatorName.textContent = `by ${g.author || 'Unknown'}`;
                creatorRow.appendChild(creatorName);
                meta.appendChild(creatorRow);

                const descRow = document.createElement('div');
                descRow.style.display = 'flex';
                descRow.style.justifyContent = 'space-between';
                descRow.style.alignItems = 'center';
                descRow.style.marginTop = 'auto';
                descRow.style.paddingTop = '6px';

                const playBtn = document.createElement('button');
                playBtn.className = 'menu-btn';
                playBtn.textContent = 'Play';
                playBtn.style.cssText = `width:80px; padding:6px 0; font-weight:600; font-size:13px;`;
                // For Supabase-published entries, use world_data; otherwise fall back to local
                playBtn.onclick = () => {
                    if (g.supabaseData && g.supabaseData.world_data) {
                        pendingGameStart = { name: g.name, data: g.supabaseData.world_data };
                        startGame(g.name, g.supabaseData.world_data);
                        // Increment visits in background
                        incrementVisit(g.id).catch(() => {});
                    } else if (g.firestoreData && g.firestoreData.world) {
                        pendingGameStart = { name: g.name, data: g.firestoreData.world };
                        startGame(g.name, g.firestoreData.world);
                    } else {
                        openGameDetail(g.name, g.id);
                    }
                };

                // Live player online count for this game
                const onlineEl = document.createElement('div');
                onlineEl.style.cssText = `
                    font-size:12px; color:#8b949e; display:flex; align-items:center; gap:4px;
                `;
                const dot = document.createElement('span');
                dot.style.cssText = `
                    display:inline-block; width:7px; height:7px; border-radius:50%;
                    background:#3fb950;
                `;
                const onlineText = document.createElement('span');

                // Count presences in this map
                const countOnlineForGame = () => {
                    let n = 0;
                    const pres = room.presence || {};
                    for (const id in pres) {
                        if (pres[id] && pres[id].map === g.name) n++;
                    }
                    return n;
                };

                const updateOnline = () => {
                    const n = countOnlineForGame();
                    onlineText.textContent = n > 0 ? `${n} online` : '';
                    dot.style.display = n > 0 ? 'inline-block' : 'none';
                };
                updateOnline();
                // Re-check online count whenever presence changes
                room.subscribePresence(() => updateOnline());

                onlineEl.appendChild(dot);
                onlineEl.appendChild(onlineText);

                descRow.appendChild(playBtn);
                descRow.appendChild(onlineEl);

                meta.appendChild(descRow);
                container.appendChild(meta);

                rows.appendChild(container);
            });
        };

        document.getElementById('game-search').addEventListener('input', () => render());
        document.getElementById('game-filter').addEventListener('change', () => render());

        // Kick off remote fetch once when opening the tab
        fetchRemoteGames();
        render();
    };

    // --- Groups Tab ---
    const makeGroupsTab = () => {
        tabContent.innerHTML = '';

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.marginBottom = '8px';
        header.innerHTML = `<div style="font-weight:bold; font-size:22px;">Groups</div>`;
        tabContent.appendChild(header);

        const groupsList = document.createElement('div');
        groupsList.style.display = 'flex';
        groupsList.style.flexDirection = 'column';
        groupsList.style.gap = '8px';

        // Basic Group: Chirpless Team
        const groupCard = document.createElement('div');
        groupCard.style.padding = '10px';
        groupCard.style.border = '2px solid #cce';
        groupCard.style.borderRadius = '6px';
        groupCard.style.background = '#f8fbff';
        groupCard.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-weight:bold; font-size:18px;">Chirpless Team</div>
                    <div style="font-size:12px; color:#444;">A basic official group</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-weight:bold;">Members: 2</div>
                    <button id="btn-join-chirpless" class="menu-btn" style="margin-top:6px; width:120px;">Join Group</button>
                </div>
            </div>
        `;
        groupsList.appendChild(groupCard);

        tabContent.appendChild(groupsList);

        // Group detail modal behavior (click join shows message)
        setTimeout(() => {
            const joinBtn = document.getElementById('btn-join-chirpless');
            if (joinBtn) {
                joinBtn.addEventListener('click', () => {
                    playSwitch();
                    alert("Can't Join Admin Groups");
                });
            }
        }, 50);
    };

    // --- Customize Tab (moved from main menu) ---
    const makeCustomizeTab = () => {
        tabContent.innerHTML = '';

        // Show the existing Customize UI inside the tab by moving the existing customize menu body into here temporarily
        // We'll clone the current customize markup for safe display
        const custClone = document.querySelector('#customize-menu .sidebar').cloneNode(true);
        custClone.style.position = 'relative';
        custClone.style.width = '100%';
        custClone.style.height = '100%';
        custClone.style.boxSizing = 'border-box';
        custClone.querySelector('.xp-title-bar').querySelector('button').remove(); // remove close button inside cloned view
        tabContent.appendChild(custClone);

        // Bind Done button inside cloned area to open real customize menu if user wants full editor
        const doneBtn = custClone.querySelector('#btn-cust-done');
        if (doneBtn) {
            doneBtn.addEventListener('click', () => {
                playSwitch();
                // Open the real customize menu as before
                playMenu.style.display = 'none';
                custMenu.style.display = 'block';
                gameState = 'CUSTOMIZE';
            });
        }
    };

    // Tab click wiring (with sound)
    tabGames.addEventListener('click', () => {
        playSwitch();
        tabGames.classList.add('active');
        tabGroups.classList.remove('active');
        tabCustomize.classList.remove('active');
        makeGamesTab();
    });

    tabGroups.addEventListener('click', () => {
        playSwitch();
        tabGroups.classList.add('active');
        tabGames.classList.remove('active');
        tabCustomize.classList.remove('active');
        makeGroupsTab();
    });
    tabCustomize.addEventListener('click', () => {
        playSwitch();
        tabCustomize.classList.add('active');
        tabGames.classList.remove('active');
        tabGroups.classList.remove('active');
        makeCustomizeTab();
    });

    // Default open Games
    // Ensure Explore uses the light-red theme and stretches smartly to the viewport
    setThemeForAll('lightred');
    tabGames.click();
};

function loadStudioWithMap(mapData, name = null, isRemix = false) {
    playSwitch();
    menuBGM.pause();
    // Hide menus
    startMenu.style.display = 'none';
    playMenu.style.display = 'none';
    
    // Show Studio
    studioGui.style.display = 'flex';
    gameState = 'STUDIO';
    
    editingGameName = name;
    isRemixMode = isRemix;

    // Load Data
    world.loadFromData(mapData);
    
    // Reset View
    if (world.mapGroup) world.mapGroup.visible = true;
    player.mesh.visible = false;
    updateExplorer();
    
    studioCamPos.set(0, 20, 20);
    studioCamYaw = 0;
    studioCamPitch = -0.7;
}

// --- FORUM SYSTEM ---
const forumContent = document.getElementById('forum-content');

// Initial Data
const defaultThreads = [
    {
        id: 1,
        title: "Welcome to Chirpless!",
        author: "Builderman",
        date: Date.now() - 10000000,
        content: "Welcome to the Chirpless forums! Be nice and have fun building.",
        replies: [
            { author: "Guest", text: "Wow this is cool!", date: Date.now() - 9000000 }
        ]
    },
    {
        id: 2,
        title: "How to jump?",
        author: "Noob123",
        date: Date.now() - 5000000,
        content: "I keep pressing space but sometimes I don't jump high enough.",
        replies: []
    }
];

const getForumData = () => {
    try {
        const raw = localStorage.getItem('chirpless_forum_threads');
        if (raw) return JSON.parse(raw);
    } catch(e) {}
    return defaultThreads;
};

const saveForumData = (data) => {
    localStorage.setItem('nblox_forum_threads', JSON.stringify(data));
};

const renderForumHome = () => {
    forumContent.innerHTML = '';
    const threads = getForumData();
    // Sort by newest
    threads.sort((a,b) => b.date - a.date);

    // Header
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '16px';
    
    table.innerHTML = `
        <tr style="background: #000080; color: white;">
            <th style="text-align: left; padding: 8px;">Subject</th>
            <th style="width: 100px; padding: 8px;">Author</th>
            <th style="width: 60px; padding: 8px;">Replies</th>
        </tr>
    `;

    threads.forEach(t => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #ccc';
        tr.style.cursor = 'pointer';
        tr.onmouseover = () => tr.style.background = '#ffffcc';
        tr.onmouseout = () => tr.style.background = 'transparent';
        
        tr.innerHTML = `
            <td style="padding: 10px; color: #000080; font-weight: bold; font-size: 18px;">${t.title}</td>
            <td style="padding: 10px;">${t.author}</td>
            <td style="padding: 10px; text-align: center;">${t.replies.length}</td>
        `;
        tr.onclick = () => {
            playSwitch();
            renderForumThread(t.id);
        };
        table.appendChild(tr);
    });
    
    if (threads.length === 0) {
        forumContent.innerHTML = '<div style="padding:15px; font-size: 16px;">No threads yet.</div>';
    } else {
        forumContent.appendChild(table);
    }
};

const renderForumThread = (id) => {
    const threads = getForumData();
    const t = threads.find(x => x.id === id);
    if (!t) return renderForumHome();

    forumContent.innerHTML = '';

    // OP
    const opDiv = document.createElement('div');
    opDiv.style.border = '1px solid #000080';
    opDiv.style.marginBottom = '15px';
    opDiv.style.background = '#eee';
    
    opDiv.innerHTML = `
        <div style="background: #000080; color: white; padding: 8px; font-weight: bold; font-size: 18px;">${t.title}</div>
        <div style="padding: 8px; border-bottom: 1px solid #ccc; font-size: 14px; color: #555;">
            Posted by <b>${t.author}</b> on ${new Date(t.date).toLocaleDateString()}
        </div>
        <div style="padding: 15px; font-size: 16px; min-height: 60px; background: #fff;">${t.content}</div>
    `;
    forumContent.appendChild(opDiv);

    // Replies
    t.replies.forEach(r => {
        const rDiv = document.createElement('div');
        rDiv.style.border = '1px solid #888';
        rDiv.style.marginBottom = '10px';
        rDiv.style.background = '#fff';
        rDiv.style.marginLeft = '20px';
        
        rDiv.innerHTML = `
            <div style="padding: 6px; background: #ddd; border-bottom: 1px solid #ccc; font-size: 14px;">
                <b>${r.author}</b> replied:
            </div>
            <div style="padding: 10px; font-size: 15px;">${r.text}</div>
        `;
        forumContent.appendChild(rDiv);
    });

    // Reply Box
    const replyBox = document.createElement('div');
    replyBox.style.marginTop = '20px';
    replyBox.style.padding = '10px';
    replyBox.style.borderTop = '2px solid #000';
    
    replyBox.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 8px; font-size: 16px;">Post a Reply</div>
        <textarea id="forum-reply-input" style="width: 100%; height: 80px; font-family: inherit; margin-bottom: 10px; font-size: 14px; padding: 5px;"></textarea>
        <button id="btn-post-reply" class="menu-btn" style="width: auto; padding: 4px 20px; margin: 0; font-size: 14px;">Post Reply</button>
    `;
    forumContent.appendChild(replyBox);

    document.getElementById('btn-post-reply').onclick = () => {
        const txt = document.getElementById('forum-reply-input').value.trim();
        if (!txt) return;
        
        playSwitch();
        const username = document.getElementById('input-username').value || "Guest";
        
        t.replies.push({
            author: username,
            text: txt,
            date: Date.now()
        });
        
        // Save back
        const allThreads = getForumData();
        const idx = allThreads.findIndex(x => x.id === id);
        if (idx !== -1) allThreads[idx] = t;
        saveForumData(allThreads);
        
        renderForumThread(id); // Refresh
    };
};

const renderCreateThread = () => {
    forumContent.innerHTML = '';
    
    const div = document.createElement('div');
    div.style.padding = '10px';
    
    div.innerHTML = `
        <h3 style="margin-top: 0;">New Thread</h3>
        <label style="display:block; font-weight:bold;">Subject:</label>
        <input type="text" id="new-thread-title" style="width: 100%; margin-bottom: 10px; font-family: inherit;">
        
        <label style="display:block; font-weight:bold;">Message:</label>
        <textarea id="new-thread-content" style="width: 100%; height: 150px; margin-bottom: 10px; font-family: inherit;"></textarea>
        
        <button id="btn-submit-thread" class="menu-btn" style="width: auto; padding: 4px 15px; margin: 0;">Post</button>
        <button id="btn-cancel-thread" class="menu-btn" style="width: auto; padding: 4px 15px; margin: 0; margin-left: 5px;">Cancel</button>
    `;
    forumContent.appendChild(div);

    document.getElementById('btn-cancel-thread').onclick = () => {
        playSwitch();
        renderForumHome();
    };

    document.getElementById('btn-submit-thread').onclick = () => {
        const title = document.getElementById('new-thread-title').value.trim();
        const content = document.getElementById('new-thread-content').value.trim();
        
        if (!title || !content) {
            alert("Please fill out both subject and message.");
            return;
        }

        playSwitch();
        const username = document.getElementById('input-username').value || "Guest";
        const threads = getForumData();
        
        const newThread = {
            id: Date.now(),
            title: title,
            author: username,
            date: Date.now(),
            content: content,
            replies: []
        };
        
        threads.push(newThread);
        saveForumData(threads);
        renderForumHome();
    };
};

const btnForum = document.getElementById('btn-forum');
if (btnForum) {
    btnForum.onclick = () => {
        playSwitch();
        tryPlayBGM();
        startMenu.style.display = 'none';
        forumMenu.style.display = 'block';
        gameState = 'MENU';
        if (world.mapGroup) world.mapGroup.visible = false;
        renderForumHome();
    };
}

document.getElementById('btn-close-forum').onclick = () => {
    playSwitch();
    forumMenu.style.display = 'none';
    startMenu.style.display = 'block';
};

document.getElementById('btn-forum-home').onclick = () => {
    playSwitch();
    renderForumHome();
};

document.getElementById('btn-new-thread').onclick = () => {
    playSwitch();
    renderCreateThread();
};

document.getElementById('btn-gd-back').onclick = () => {
    playSwitch();

    // If user opened the Game Detail from inside an active PLAYING session, Back should return them to that session.
    if (prevGameState === 'PLAYING') {
        try {
            // Close detail UI and restore in-game UI without reloading the map
            gameDetailMenu.style.display = 'none';
            // Ensure the play menu is hidden
            try { playMenu.style.display = 'none'; } catch (e) {}
            // Restore in-game UI elements
            try { chatContainer.style.display = 'flex'; } catch (e) {}
            try { playerList.style.display = 'flex'; } catch (e) {}
            // Keep world visible and player in their current state
            if (world && world.mapGroup) world.mapGroup.visible = true;
            gameState = 'PLAYING';
            // Clear pending selection but keep prevGameState cleared so subsequent Back behaves normally
            pendingGameStart = null;
            prevGameState = null;
        } catch (e) {
            console.warn('Failed to restore PLAYING state on Back:', e);
            // Fallback to original behavior: close detail and open Play menu
            gameDetailMenu.style.display = 'none';
            try { playMenu.style.display = 'block'; } catch(e) { startMenu.style.display = 'block'; }
            pendingGameStart = null;
            prevGameState = null;
        }
        return;
    }

    // Otherwise, if a pendingGameStart exists (user was inspecting a game from menu), start it when Back is used as "enter".
    if (pendingGameStart) {
        try { startGame(pendingGameStart.name, pendingGameStart.data); } catch (e) { console.warn('Failed to start game from Back:', e); }
        return;
    }

    // Default fallback: close detail and return to Explore / Play menu
    gameDetailMenu.style.display = 'none';
    try { playMenu.style.display = 'block'; } catch(e) { startMenu.style.display = 'block'; }
    pendingGameStart = null;
};

document.getElementById('btn-close-gd').onclick = () => document.getElementById('btn-gd-back').click();

document.getElementById('btn-gd-play').onclick = () => {
    const username = document.getElementById('input-username').value.trim();
    if (!username) {
        alert("You must enter a username to play!");
        // Flash input
        document.getElementById('input-username').focus();
        document.getElementById('input-username').style.borderColor = 'red';
        // Return to start menu to enter name
        gameDetailMenu.style.display = 'none';
        startMenu.style.display = 'block';
        return;
    }

    // Protect against accidental immediate re-join after leaving a game
    if (Date.now() < (suppressAutoJoinUntil || 0)) {
        alert('Please wait a moment before rejoining a game.');
        return;
    }

    if (pendingGameStart) {
        startGame(pendingGameStart.name, pendingGameStart.data);
    }
};

document.getElementById('btn-play-back').onclick = () => {
    playSwitch();
    playMenu.style.display = 'none';
    startMenu.style.display = 'block';
};

document.getElementById('btn-customize').onclick = () => {
    playSwitch();
    tryPlayBGM();
    startMenu.style.display = 'none';
    custMenu.style.display = 'block';
    chatContainer.style.display = 'none';
    gameState = 'CUSTOMIZE';
    if (world.mapGroup) world.mapGroup.visible = false;

    // Populate owned items UI (owned hats, equip buttons)
    populateOwnedItemsUI();
};



 // Equip Ice Crown quickly from Marketplace (improved: toggle equip/unequip, load OBJ, persist ref)
const btnEquipIce = null;
if (btnEquipIce) {
    const objLoader = new OBJLoader();

    const setButtonState = (equipped) => {
        try {
            btnEquipIce.textContent = equipped ? 'Unequip' : 'Equip';
        } catch (e) {}
    };

    // reflect initial state based on saved appearance
    try {
        const saved = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
        const hasHat = saved && saved.hat && (saved.hat.objUrl === '/Ice Crown.obj' || saved.hat.id === 'ice_crown');
        setButtonState(!!hasHat);
    } catch (e) {}

    btnEquipIce.addEventListener('click', () => {
        playSwitch();
        try {
            // Ensure owned list
            let owned = {};
            try { owned = JSON.parse(localStorage.getItem('nblox_owned_items') || '{}'); } catch(e){}
            owned['ice_crown'] = { id: 'ice_crown', name: 'Ice Crown', free: true };
            localStorage.setItem('nblox_owned_items', JSON.stringify(owned));
        } catch (e) {
            console.warn('Failed to persist owned item', e);
        }

        if (!player || !player.head) {
            alert('Player not ready. Open Customize after joining a game.');
            return;
        }

        // If currently has a hat that references Ice Crown, unequip it
        const curHat = player.appearance && player.appearance.hat;
        if (curHat && (curHat.objUrl === '/Ice Crown.obj' || curHat.id === 'ice_crown')) {
            try {
                player.removeHat && player.removeHat();
            } catch (e) { console.warn('Failed to remove existing hat', e); }
            try {
                player.appearance.hat = null;
                const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                save.hat = null;
                localStorage.setItem('nblox_appearance', JSON.stringify(save));
            } catch (e) {}
            setButtonState(false);
            addChatMessage('System', 'Ice Crown unequipped.');
            return;
        }

        // Otherwise, load OBJ and attach it; fall back to simple placeholder on load failure
        btnEquipIce.disabled = true;
        const prevText = btnEquipIce.textContent;
        btnEquipIce.textContent = 'Loading...';

        objLoader.load('/Ice Crown.obj',
            (obj) => {
                try {
                    // Name and prepare model
                    obj.name = 'ice_crown_model';

                    // Compute bounding box and scale to head size
                    const bbox = new THREE.Box3().setFromObject(obj);
                    const size = new THREE.Vector3();
                    bbox.getSize(size);
                    const desired = 1.0; // target approximate width
                    const maxDim = Math.max(size.x || 1, size.y || 1, size.z || 1);
                    const scaleFactor = maxDim > 0 ? (desired / maxDim) : 1.0;
                    obj.scale.setScalar(scaleFactor * 0.95);

                    // Center model
                    bbox.setFromObject(obj);
                    const center = new THREE.Vector3();
                    bbox.getCenter(center);
                    obj.position.sub(center);

                    // Y offset so crown sits on head
                    const yOffset = 0.9;
                    obj.position.y += yOffset;

                    // Align crown with the player's head orientation (do not flip 180° — head cube is already rotated).
                    obj.rotation.y = 0;

                    // Ensure meshes have a reasonable material if absent
                    obj.traverse((c) => {
                        if (c.isMesh) {
                            if (!c.material) c.material = new THREE.MeshStandardMaterial({ color: 0x88eeff, metalness: 0.9, roughness: 0.2 });
                            c.material.side = THREE.DoubleSide;
                            c.castShadow = true;
                        }
                    });

                    // Remove any previously attached Ice Crown to avoid duplicates
                    try {
                        player.removeHat && player.removeHat();
                    } catch (e) {}

                    // Attach to GLB head replacement if present, otherwise to cube head
                    let attachTarget = player.head || player.mesh;
                    try {
                        const found = player.mesh.children.find(c => c !== player.head && c.name && c.name.toLowerCase().includes('head'));
                        if (found) attachTarget = found;
                    } catch (e) {}

                    // Store reference on player for easy unequip later
                    obj.userData = obj.userData || {};
                    obj.userData._isIceCrown = true;
                    // Save hat reference via player's createHat path so removeHat logic can handle it
                    try {
                        // Use player's internal hat storage if available
                        player.createHat && player.createHat({ constructed: false, objUrl: '/Ice Crown.obj', offset: { x: 0, y: yOffset, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: scaleFactor * 0.95 });
                        // player.createHat may add a simple hat; if so, we still attach the OBJ for fidelity
                    } catch (e) {
                        // ignore
                    }

                    // Attach the OBJ model directly (so it's visible)
                    attachTarget.add(obj);
                    // Keep direct reference so unequip can remove it
                    player._iceCrownModel = obj;

                    // Persist minimal reference to appearance so button state and future sessions know it's equipped
                    try {
                        player.appearance.hat = {
                            id: 'ice_crown',
                            objUrl: '/Ice Crown.obj',
                            offset: { x: 0, y: yOffset, z: 0 },
                            rot: { x: 0, y: 0, z: 0 },
                            scale: scaleFactor * 0.95
                        };
                        const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                        save.hat = player.appearance.hat;
                        localStorage.setItem('nblox_appearance', JSON.stringify(save));
                    } catch (e) { console.warn('Failed to persist appearance hat', e); }

                    setButtonState(true);
                    addChatMessage('System', 'Ice Crown equipped.');
                } catch (err) {
                    console.warn('Ice Crown attach failed', err);
                    alert('Failed to attach Ice Crown model.');
                } finally {
                    btnEquipIce.disabled = false;
                    btnEquipIce.textContent = prevText;
                }
            },
            undefined,
            (err) => {
                console.warn('OBJ load error', err);
                // Fallback placeholder crown
                try {
                    player.removeHat && player.removeHat();
                } catch (e) {}
                const crown = new THREE.Group();
                const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0x88eeff, metalness: 0.8, roughness: 0.2 }));
                brim.rotation.x = Math.PI/2;
                brim.position.y = 0.05;
                const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.6, 16), new THREE.MeshStandardMaterial({ color: 0x88eeff, metalness: 0.8, roughness: 0.2 }));
                cap.position.y = 0.55;
                crown.add(brim);
                crown.add(cap);
                crown.scale.set(0.6,0.6,0.6);
                crown.position.set(0, 0.9, 0);
                player.head.add(crown);
                player.appearance.hat = {
                    id: 'ice_crown',
                    constructed: false,
                    objUrl: null,
                    offset: { x: 0, y: 0.9, z: 0 },
                    rot: { x: 0, y: 0, z: 0 },
                    scale: 0.6
                };
                try {
                    const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                    save.hat = player.appearance.hat;
                    localStorage.setItem('nblox_appearance', JSON.stringify(save));
                } catch(e){}
                addChatMessage('System', 'Ice Crown equipped (placeholder). Open Customize to refine or reload model.');
                btnEquipIce.disabled = false;
                btnEquipIce.textContent = prevText;
                setButtonState(true);
            }
        );
    });
}

 // Creator Launcher Button Handler
 const btnCreator = document.getElementById('btn-creator');
 if (btnCreator) {
     btnCreator.addEventListener('click', () => {
         playSwitch();
         // Ensure chat is hidden while in Creator UI
         try { if (chatContainer) chatContainer.style.display = 'none'; } catch(e){}
         // open creator menu
         document.getElementById('creator-menu').style.display = 'block';
         startMenu.style.display = 'none';
         gameState = 'MENU';
         // prefill code area with a helpful snippet if empty
         const code = document.getElementById('creator-code');
         if (code && code.value.trim() === '') {
             code.value = `// Add UI and world changes here\naddChatMessage('Creator','Hello from Creator!');\n// Example: spawn a block\nworld.createBlock(0, 2, -8, 8, 1, 8, 0xffa500);\n`;
         }
     });
 }

 // Creator Menu Handlers
 const btnCloseCreator = document.getElementById('btn-close-creator');
 if (btnCloseCreator) btnCloseCreator.addEventListener('click', () => {
     playSwitch();
 
     // Close Creator UI
     const creatorMenuEl = document.getElementById('creator-menu');
     if (creatorMenuEl) creatorMenuEl.style.display = 'none';
 
     // Ensure Studio view is fully torn down if it was opened via "View"
     try {
         // Hide studio GUI
         if (studioGui) studioGui.style.display = 'none';
 
         // Detach transform controls and clear selection
         if (typeof transformControl !== 'undefined' && transformControl) transformControl.detach();
         studioSelected = null;
         selectionHelper.visible = false;
         hoverHelper.visible = false;
 
         // Remove studio lights
         try { removeStudioLights(); } catch(e) {}
 
         // Hide world visuals loaded for Studio/View and restore player visibility
         if (world && world.mapGroup) world.mapGroup.visible = false;
         if (player && player.mesh) player.mesh.visible = true;
 
         // Reset camera / state back to menu defaults
         gameState = 'MENU';
         tryPlayBGM();
 
     } catch (e) {
         console.warn('Error while closing Creator view:', e);
     }
 
     // Show launcher
     startMenu.style.display = 'block';
 
     // Small grace to avoid accidental immediate re-enter of view
     suppressAutoJoinUntil = Date.now() + 2500;
 });

 // New: Creator "Player" and "View" buttons
 const btnCreatorPlayer = document.getElementById('btn-creator-player');
 const btnCreatorView = document.getElementById('btn-creator-view');

 if (btnCreatorPlayer) {
     btnCreatorPlayer.addEventListener('click', () => {
         playSwitch();
         // Load baseplate and place player there for testing in-place
         world.loadMap('baseplate');
         currentMapName = 'baseplate';
         // Ensure world visible and player placed on spawn
         if (world.mapGroup) world.mapGroup.visible = true;
         player.respawn(world);
         player.mesh.visible = true;
         // Enter PLAYING state so movement and camera work
         startMenu.style.display = 'none';
         document.getElementById('creator-menu').style.display = 'none';
         chatContainer.style.display = 'flex';
         btnExit.style.display = 'block';
         btnReset.style.display = 'block';
         playerList.style.display = 'flex';
         gameState = 'PLAYING';
         // push presence for local simulation
         try {
             room.updatePresence({ map: currentMapName, position: player.position, appearance: player.serializeAppearance() });
         } catch (e) {}
     });
 }

 if (btnCreatorView) {
     btnCreatorView.addEventListener('click', () => {
         playSwitch();
         // Switch Creator into Studio view: load map into workspace and open studio GUI
         // Hide the Creator panel so Studio has focus and doesn't get blocked by the Creator overlay
         document.getElementById('creator-menu').style.display = 'none';
         startMenu.style.display = 'none';
         studioGui.style.display = 'flex';
         gameState = 'STUDIO';
         // Load or ensure baseplate is present in the world workspace
         world.loadMap('baseplate');
         if (world.mapGroup) world.mapGroup.visible = true;
         player.mesh.visible = false;
         // Setup studio camera and lights
         addStudioLights();
         studioCamPos.set(0, 20, 20);
         studioCamYaw = 0;
         studioCamPitch = -0.7;
         updateExplorer();
     });
 }

// Console helper
function creatorLog(msg) {
    const c = document.getElementById('creator-console');
    if (!c) return;
    const line = document.createElement('div');
    line.textContent = String(msg);
    c.appendChild(line);
    c.scrollTop = c.scrollHeight;
}

// Run code in a safe-ish sandboxed function with limited globals (world, addChatMessage, player)
document.getElementById('btn-creator-run').addEventListener('click', () => {
    playSwitch();
    const code = document.getElementById('creator-code').value;
    const c = document.getElementById('creator-console');
    if (c) c.innerHTML = '';
    try {
        // Provide limited API
        const API = {
            world: world,
            player: player,
            addChatMessage: addChatMessage,
            createBlock: (x,y,z,w,h,d,color,flags) => world.createBlock(x,y,z,w,h,d,color,flags),
            createPart: (t,x,y,z,s,cColor,flags) => world.createPart(t,x,y,z,s,cColor,flags),
            consoleLog: creatorLog
        };
        // Run in Function with API injected via with() to limit scope
        const runner = new Function('API', `
            try {
                with(API) {
                    ${code}
                }
            } catch(e) {
                API.consoleLog('Error: ' + (e && e.message ? e.message : e));
                throw e;
            }
        `);
        runner(API);
        creatorLog('Run complete.');
    } catch (e) {
        creatorLog('Runtime error: ' + (e && e.message ? e.message : String(e)));
    }
});

// Clear console
const btnCreatorClear = document.getElementById('btn-creator-clear');
if (btnCreatorClear) btnCreatorClear.addEventListener('click', () => {
    document.getElementById('creator-console').innerHTML = '';
    playSwitch();
});

// Reset map (clears items and loads baseplate)
const btnCreatorReset = document.getElementById('btn-creator-reset');
if (btnCreatorReset) btnCreatorReset.addEventListener('click', () => {
    playSwitch();
    world.loadMap('baseplate');
    creatorLog('Map reset to Baseplate.');
});

// Save .crp (simple JSON with code + serialized world items)
document.getElementById('btn-creator-save').addEventListener('click', () => {
    playSwitch();
    const code = document.getElementById('creator-code').value;
    const langSel = document.getElementById('creator-code-lang');
    const lang = (langSel && langSel.value) ? langSel.value : 'js';
    const payload = {
        meta: { name: document.getElementById('creator-map-name').textContent || 'Baseplate', date: Date.now(), language: lang },
        code: code,
        codeLanguage: lang,
        world: world.serialize()
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (payload.meta.name || 'creator') + '.crp';
    document.body.appendChild(a);
    a.click();
    a.remove();
    creatorLog('Saved .crp file. Language: ' + lang.toUpperCase());

    // Add a "Save as .fndry" quick-export button next to the existing Save button (for sharing)
    try {
        if (!document.getElementById('btn-creator-save-fndry')) {
            const btn = document.createElement('button');
            btn.id = 'btn-creator-save-fndry';
            btn.className = 'menu-btn';
            btn.textContent = 'Save as .fndry';
            btn.style.marginLeft = '8px';
            // Insert after the existing Save button in the creator toolbar if present
            const saveBtn = document.getElementById('btn-creator-save');
            if (saveBtn && saveBtn.parentElement) saveBtn.parentElement.appendChild(btn);
            else document.body.appendChild(btn);

            btn.addEventListener('click', () => {
                playSwitch();
                const metaName = (document.getElementById('creator-map-name') && document.getElementById('creator-map-name').textContent) || (payload.meta && payload.meta.name) || 'world';
                const fndry = {
                    format: 'fndry-v1',
                    name: metaName,
                    author: document.getElementById('input-username') ? document.getElementById('input-username').value : 'Guest',
                    date: Date.now(),
                    world: world.serialize(),
                    // include optional creator code for reference
                    creatorCode: document.getElementById('creator-code') ? document.getElementById('creator-code').value : ''
                };
                const blobF = new Blob([JSON.stringify(fndry, null, 2)], { type: 'application/json' });
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blobF);
                link.download = (metaName || 'world') + '.fndry';
                document.body.appendChild(link);
                link.click();
                link.remove();
                creatorLog('Exported .fndry: ' + (metaName || 'world'));
            });
        }
    } catch (e) {
        console.warn('Failed to create Save .fndry button:', e);
    }
});

// Load .crp
document.getElementById('btn-creator-load').addEventListener('click', () => {
    playSwitch();
    const f = document.createElement('input');
    f.type = 'file';
    f.accept = '.crp,application/json';
    f.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const obj = JSON.parse(ev.target.result);
                if (obj.code) document.getElementById('creator-code').value = obj.code;
                if (obj.meta && obj.meta.name) document.getElementById('creator-map-name').textContent = obj.meta.name;
                if (obj.world) world.loadFromData(obj.world);
                creatorLog('Loaded .crp: ' + (obj.meta && obj.meta.name ? obj.meta.name : file.name));
            } catch (err) {
                creatorLog('Failed to load .crp: ' + err.message);
            }
        };
        reader.readAsText(file);
    };
    f.click();
});

document.getElementById('btn-settings').onclick = () => {
    // Open the existing Settings panel (Marketplace removed).
    playSwitch();
    tryPlayBGM();
    prevGameState = gameState;
    startMenu.style.display = 'none';
    settingsMenu.style.display = 'block';
    gameState = 'SETTINGS';
    if (world.mapGroup) world.mapGroup.visible = false;
};

document.getElementById('btn-settings-back').onclick = () => {
    playSwitch();
    settingsMenu.style.display = 'none';

    // If the settings menu was opened from inside a playing session, return to that session
    if (prevGameState === 'PLAYING') {
        // Keep game state as PLAYING and restore in-game UI
        gameState = 'PLAYING';
        try { 
            // show in-game UI elements
            chatContainer.style.display = 'flex';
            playerList.style.display = 'flex';
            // ensure world visuals are visible
            if (world.mapGroup) world.mapGroup.visible = true;
            // resume game audio state
            tryPlayBGM();
        } catch(e){ console.warn('Failed to restore in-game UI on Settings Back:', e); }
    } else {
        // Default behavior: return to main menu
        startMenu.style.display = 'block';
        gameState = 'MENU';
        if (world.mapGroup) world.mapGroup.visible = false;
        tryPlayBGM();
    }

    // Clear remembered prev state
    prevGameState = null;
};

function doExitToMenu() {
    playSwitch();

    // Restore menu BGM if we quieted it earlier
    try {
        if (menuBGM.audio && menuBGM.quieted) {
            try {
                menuBGM.audio.volume = (prevMenuVolume != null) ? prevMenuVolume : menuBGM.volume;
            } catch (e) { menuBGM.audio.volume = menuBGM.volume; }
            menuBGM.quieted = false;
            prevMenuVolume = null;
        } else if (!menuBGM.playing) {
            startMenuPlaylist();
        }
    } catch (e) { console.warn('Failed to restore menu BGM on exit:', e); try { startMenuPlaylist(); } catch (ee) {} }

    // Hide in-game UI
    try { chatContainer.style.display = 'none'; } catch(e){}
    try { if (btnExit) btnExit.style.display = 'none'; } catch(e){}
    try { if (btnReset) btnReset.style.display = 'none'; } catch(e){}

    // Ensure player list is hidden when leaving game
    try { playerList.style.display = 'none'; } catch(e){}

    try { if (typeof transformControl !== 'undefined' && transformControl) transformControl.detach(); } catch (e) { console.warn('Failed to detach transformControl on exit', e); }
    try { studioSelected = null; } catch (e) {}
    try { activeTool = 'select'; } catch (e) {}
    try { if (typeof setStudioTool === 'function') setStudioTool('select'); } catch(e){}

    try { clearHatModeler(); } catch(e){}
    try { if (hatPreview && hatPreview.parent) { hatPreview.parent.remove(hatPreview); hatPreview = null; } } catch(e){}

    try { studioGui.style.display = 'none'; } catch(e){}
    try { if (world.mapGroup) world.mapGroup.visible = false; } catch(e){}

    try {
        playerPets.forEach(p => { if (p && p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); });
        playerPets = [];
    } catch (e) {}

    try { player.mesh.visible = true; player.stopDance && player.stopDance(); } catch(e){}

    // Update UI state: go back to launcher/menu
    try { startMenu.style.display = 'block'; } catch(e){}
    gameState = 'MENU';

    try {
        const sh = document.getElementById('silly-hud');
        if (sh) sh.style.display = 'none';
    } catch(e){}

    // Notify presence/server: rejoin global room and mark as in MENU
    try {
        // Tell server we're leaving the map room and rejoining the global room
        try { room.switchRoom('global').then(() => { room.updatePresence({ map: 'MENU' }); }).catch(() => {}); } catch(e){}
        room.updatePresence({ map: 'MENU' });
    } catch(e){ console.warn('Failed to update presence on exit', e); }

    try { if (gameBGM) { gameBGM.pause(); gameBGM = null; } } catch(e){}
    try { tryPlayBGM(); } catch(e){}

    try { chatHistory.innerHTML = ''; } catch(e){}

    suppressAutoJoinUntil = Date.now() + 2500;
    preventAutoRejoin = true;
}

btnExit.onclick = doExitToMenu;

 // Map the new Menu HUD button to open the existing settings menu which now includes LEAVE/RESET actions
 if (btnGameMenu) {
     btnGameMenu.addEventListener('click', (e) => {
         e.stopPropagation();
         playSwitch();
         settingsMenu.style.display = 'flex';
         // Ensure the settings menu shows in front
         settingsMenu.style.zIndex = 20000;
         gameState = 'MENU';
     });
 }
 
 // Replace old single-menu button wiring with explicit Leave / Reset HUD buttons
 const btnLeaveGame = getEl('btn-leave-game');
 const btnResetCharacter = getEl('btn-reset-character');
 
 // Leave: perform exit-to-menu (same flow as doExitToMenu)
 if (btnLeaveGame) {
     btnLeaveGame.addEventListener('click', (e) => {
         e.stopPropagation();
         playSwitch();
         try { doExitToMenu(); } catch (err) { console.warn('Leave button failed:', err); }
     });
 }
 
 // Reset Character: confirmation then kill/respawn behavior
 if (btnResetCharacter) {
     btnResetCharacter.addEventListener('click', (e) => {
         e.stopPropagation();
         playSwitch();
         const ok = confirm("This Will Kill Ur Character\n\nAre you sure?");
         if (!ok) return;
         try {
             if (typeof player !== 'undefined' && player && typeof player.fallApart === 'function') {
                 player.fallApart();
                 // Update presence if applicable
                 try { room.updatePresence({ isDead: true, position: player.position, map: currentMapName }); } catch(e){}
                 addChatMessage('System', 'Character reset (killed).');
             } else {
                 // fallback to respawn if fallApart not available
                 try { player.respawn && player.respawn(world); } catch (e) {}
             }
         } catch (err) {
             console.warn('Reset character handler error:', err);
         }
     });
 }

/* Wire in-menu settings actions
   - RESET CHARACTER now kills the character (fallApart) on confirmation
   - LEAVE GAME still calls doExitToMenu
*/
setTimeout(() => {
    const inReset = document.getElementById('inmenu-reset');
    const inLeave = document.getElementById('inmenu-leave');
    if (inReset) inReset.addEventListener('click', () => {
        playSwitch();
        const ok = confirm("This Will Kill Ur Character\n\nAre you sure?");
        if (ok) {
            try {
                // If player instance exists, call fallApart to kill them
                if (typeof player !== 'undefined' && player && typeof player.fallApart === 'function') {
                    player.fallApart();
                    // Ensure presence updates reflect death
                    try { room.updatePresence({ isDead: true, position: player.position, map: currentMapName }); } catch(e){}
                    addChatMessage('System', 'You have been killed (Reset Character).');
                } else {
                    // Fallback: trigger existing reset button behavior
                    try { btnReset && btnReset.click(); } catch(e){}
                }
            } catch (e) {
                console.warn('inmenu-reset handler failed:', e);
            }
        }
    });
    if (inLeave) inLeave.addEventListener('click', () => {
        playSwitch();
        try { doExitToMenu(); } catch(e){ console.warn('Leave -> doExitToMenu failed', e); }
    });
}, 200);

btnReset.onclick = () => {
    playSwitch();
    // Reset character to spawn (respawn) instead of destructing them
    try {
        player.respawn(world);
        // ensure presence reflects alive state & position
        try { room.updatePresence({ isDead: false, position: player.position, map: currentMapName }); } catch(e){}
        addChatMessage('System', 'Character reset (respawned).');
    } catch (e) {
        console.warn('Reset failed, fallback to fallApart', e);
        try { player.fallApart(); } catch (ee) {}
    }
};

// Settings Handlers
const volSlider = document.getElementById('set-volume');
volSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value) / 100;
    menuBGM.volume = val;
});

const sensSlider = document.getElementById('set-sens');
sensSlider.addEventListener('input', (e) => {
    // Value 10 to 200, map to 0.1 to 2.0
    cameraSensitivity = parseInt(e.target.value) / 100;
});

document.getElementById('btn-cust-reset').onclick = () => {
    playSwitch();
    
    // Default config
    const defaults = {
        head: '#ffcc00',   // Noob yellow
        torso: '#0066cc',  // Noob blue
        larm: '#ffcc00',
        rarm: '#ffcc00',
        lleg: '#00ff00',
        rleg: '#00ff00'
    };

    // Reset Player
    player.setPartColor('head', defaults.head);
    player.setPartColor('torso', defaults.torso);
    player.setPartColor('leftArm', defaults.larm);
    player.setPartColor('rightArm', defaults.rarm);
    player.setPartColor('leftLeg', defaults.lleg);
    player.setPartColor('rightLeg', defaults.rleg);
    
    // Clear textures
    player.appearance.faceUrl = null;
    player.appearance.shirtUrl = null;
    
    // Reset visual textures (use image from the generated textures)
    player.setFaceTexture(createFaceTexture().image);
    player.setShirtTexture(createTorsoTexture().image);
    
    // Update UI Inputs
    document.getElementById('col-head').value = defaults.head;
    document.getElementById('col-torso').value = defaults.torso;
    document.getElementById('col-larm').value = defaults.larm;
    document.getElementById('col-rarm').value = defaults.rarm;
    document.getElementById('col-lleg').value = defaults.lleg;
    document.getElementById('col-rleg').value = defaults.rleg;
    
    // Update UI preview blocks
    ['col-head', 'col-torso', 'col-larm', 'col-rarm', 'col-lleg', 'col-rleg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.parentElement.style.backgroundColor = el.value;
    });

    // Clear Storage
    localStorage.removeItem('nblox_appearance');
};

document.getElementById('btn-cust-done').onclick = () => {
    playSwitch();

    // Save current appearance state (colors and texture URLs) to localStorage
    try {
        const appearance = player && typeof player.serializeAppearance === 'function' ? player.appearance : null;
        if (appearance) {
            const saveObj = {
                colors: appearance.colors || {},
                faceUrl: appearance.faceUrl || null,
                shirtUrl: appearance.shirtUrl || null
            };
            localStorage.setItem('nblox_appearance', JSON.stringify(saveObj));
            addChatMessage('System', 'Avatar saved locally.');

            // Also store this user's colors keyed by username for game card avatar previews
            const currentUsername = (document.getElementById('input-username') || {}).value || 'Guest';
            try { localStorage.setItem(`nblox_profile_colors_${currentUsername}`, JSON.stringify(appearance.colors || {})); } catch(e){}

            // Save avatar to Supabase in background (non-blocking)
            (async () => {
                try {
                    await saveAvatar({
                        username: currentUsername,
                        colors: appearance.colors || {},
                        hatData: appearance.hat || null,
                        avatarDataUrl: null
                    });
                    addChatMessage('System', 'Avatar synced to cloud.');
                } catch (e) {
                    console.warn('[v0] Could not sync avatar to cloud:', e);
                }
            })();
        }
    } catch (e) {
        console.warn('Failed to save avatar appearance:', e);
        addChatMessage('System', 'Failed to save avatar locally.');
    }

    tryPlayBGM();
    custMenu.style.display = 'none';
    startMenu.style.display = 'block';
    chatContainer.style.display = 'none';
    gameState = 'MENU';
    if (world.mapGroup) world.mapGroup.visible = false;
};

// Customization Handlers
const bindColor = (id, part) => {
    const el = document.getElementById(id);
    el.addEventListener('input', (e) => {
        player.setPartColor(part, e.target.value);
    });
};
bindColor('col-head', 'head');
bindColor('col-torso', 'torso');
bindColor('col-larm', 'leftArm');
bindColor('col-rarm', 'rightArm');
bindColor('col-lleg', 'leftLeg');
bindColor('col-rleg', 'rightLeg');

const bindTexture = (id, method) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                // Pass the data URL string directly to Player.setShirtTexture.
                // setShirtTexture already handles data-URL strings robustly.
                try {
                    if (player && typeof player[method] === 'function') {
                        player[method](evt.target.result);
                    }
                } catch (err) {
                    console.warn('Failed to apply texture via bindTexture:', err);
                }
            };
            reader.readAsDataURL(e.target.files[0]);
        }
    });
};

bindTexture('file-shirt', 'setShirtTexture');

// Populate Owned Items into Customize UI so players can equip hats they've bought (and grant free Ice Crown)
function populateOwnedItemsUI() {
    try {
        // Ensure the free Ice Crown is always available in the player's owned items
        let ownedRaw = localStorage.getItem('nblox_owned_items') || '{}';
        let owned = {};
        try { owned = JSON.parse(ownedRaw); } catch(e){ owned = {}; }
        // Grant free ice crown by default
        if (!owned['ice_crown']) {
            owned['ice_crown'] = { id: 'ice_crown', name: 'Ice Crown', free: true };
            try { localStorage.setItem('nblox_owned_items', JSON.stringify(owned)); } catch(e){}
        }

        // Ensure container exists inside customize menu
        let ownedPanel = document.getElementById('owned-items-panel');
        if (!ownedPanel) {
            ownedPanel = document.createElement('div');
            ownedPanel.id = 'owned-items-panel';
            ownedPanel.style.width = '100%';
            ownedPanel.style.marginTop = '8px';
            ownedPanel.style.borderTop = '1px solid #ccc';
            ownedPanel.style.paddingTop = '8px';
            const label = document.createElement('div');
            label.style.fontWeight = 'bold';
            label.style.marginBottom = '6px';
            label.textContent = 'Owned Items';
            ownedPanel.appendChild(label);
            const list = document.createElement('div');
            list.id = 'owned-items-list';
            list.style.display = 'flex';
            list.style.flexWrap = 'wrap';
            list.style.gap = '8px';
            ownedPanel.appendChild(list);
            const body = document.querySelector('#customize-menu .xp-body');
            if (body) body.insertBefore(ownedPanel, body.querySelector('#hat-editor') || body.firstChild);
        }
        const list = document.getElementById('owned-items-list');
        list.innerHTML = '';

        // Reload owned object from storage to reflect any changes
        ownedRaw = localStorage.getItem('nblox_owned_items') || '{}';
        try { owned = JSON.parse(ownedRaw); } catch(e){ owned = {}; }

        const keys = Object.keys(owned);

        if (keys.length === 0) {
            const empty = document.createElement('div');
            empty.style.color = '#666';
            empty.style.fontSize = '12px';
            empty.textContent = 'No owned items yet. Buy items from the Catalog.';
            list.appendChild(empty);
            return;
        }

        // Prepare an OBJLoader instance for loading .obj hats (used for Ice Crown)
        const objLoader = new OBJLoader();

        keys.forEach(k => {
            const entry = owned[k];
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.padding = '6px';
            row.style.border = '1px solid #ddd';
            row.style.background = '#fff';
            row.style.borderRadius = '6px';
            row.style.minWidth = '160px';

            const ico = document.createElement('div');
            ico.style.width = '40px';
            ico.style.height = '40px';
            ico.style.background = '#f4f4f4';
            ico.style.display = 'flex';
            ico.style.alignItems = 'center';
            ico.style.justifyContent = 'center';
            ico.style.borderRadius = '4px';
            ico.innerHTML = `<img src="/Roblox-logo.png" style="width:28px;height:28px;object-fit:contain">`;

            const meta = document.createElement('div');
            meta.style.flex = '1';
            meta.innerHTML = `<div style="font-weight:bold; font-size:13px;">${(entry && entry.name) ? entry.name : k.replace('_',' ').replace(/\b\w/g, c=>c.toUpperCase())}</div>
                              <div style="font-size:11px; color:#666;">${entry.free ? 'Free Item' : 'Purchased'}</div>`;

            const equipBtn = document.createElement('button');
            equipBtn.className = 'menu-btn';
            equipBtn.textContent = 'Equip';
            equipBtn.style.width = '70px';

            equipBtn.addEventListener('click', async () => {
                playSwitch();

                // If this is the Ice Crown, load the OBJ and attach it to the player's head
                if (k === 'ice_crown') {
                    try {
                        // Show minimal busy feedback
                        equipBtn.disabled = true;
                        equipBtn.textContent = 'Loading...';

                        objLoader.load('/Ice Crown.obj', (obj) => {
                            try {
                                // Compute bounding box to scale model to head
                                const bbox = new THREE.Box3().setFromObject(obj);
                                const size = new THREE.Vector3();
                                bbox.getSize(size);
                                // Desired width to roughly match head width (approx 1 unit)
                                const desired = 1.0;
                                const scaleFactor = desired / Math.max(size.x, size.y, size.z);
                                obj.scale.setScalar(scaleFactor * 0.95); // slight shrink for comfortable fit

                                // Center geometry
                                bbox.setFromObject(obj);
                                const center = new THREE.Vector3();
                                bbox.getCenter(center);
                                obj.position.sub(center); // move so center is at origin

                                // Final offset so crown sits on head (tweak Y offset)
                                const yOffset = 0.9; // relative to head pivot
                                obj.position.y += yOffset;

                                // Assign simple PBR material to all child meshes if they lack one
                                obj.traverse((c) => {
                                    if (c.isMesh) {
                                        if (!c.material) c.material = new THREE.MeshStandardMaterial({ color: 0x88eeff, metalness: 0.9, roughness: 0.2 });
                                        // Ensure double-sided if crown has thin faces
                                        c.material.side = THREE.DoubleSide;
                                        c.castShadow = true;
                                        c.receiveShadow = false;
                                    }
                                });

                                // Attach to player's head (prefer GLB head if present)
                                let attachTarget = player.head || player.mesh;
                                // If the player has a GLB head replacement added earlier, find a child that looks like a head
                                try {
                                    // prefer any child named 'head' or containing 'head'
                                    const found = player.mesh.children.find(c => c.name && c.name.toLowerCase().includes('head') && c !== player.head);
                                    if (found) attachTarget = found;
                                } catch (e) {}

                                // Remove any existing hat first
                                try { player.removeHat(); } catch (e) {}

                                // Add the crown group under the head
                                attachTarget.add(obj);
                                // Save hat into player's appearance state as a composed hat marker so persist works
                                player.appearance.hat = {
                                    constructed: false,
                                    objUrl: '/Ice Crown.obj',
                                    offset: { x: 0, y: yOffset, z: 0 },
                                    rot: { x: 0, y: 0, z: 0 },
                                    scale: scaleFactor * 0.95
                                };

                                // Persist player's appearance hat pointer (no large data URLs)
                                try {
                                    const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                                    save.hat = player.appearance.hat;
                                    localStorage.setItem('nblox_appearance', JSON.stringify(save));
                                } catch (e) {}

                                addChatMessage('System', 'Equipped Ice Crown.');
                            } catch (err) {
                                console.warn('Failed to attach Ice Crown', err);
                                alert('Equip failed.');
                            } finally {
                                equipBtn.disabled = false;
                                equipBtn.textContent = 'Equip';
                            }
                        }, undefined, (err) => {
                            console.warn('OBJ load error', err);
                            alert('Failed to load Ice Crown model.');
                            equipBtn.disabled = false;
                            equipBtn.textContent = 'Equip';
                        });
                    } catch (e) {
                        console.warn('Error equipping ice crown', e);
                        equipBtn.disabled = false;
                        equipBtn.textContent = 'Equip';
                    }
                    return;
                }

                // Default equip flow for simple known items
                if (k === 'duck_hat') {
                    const hatData = {
                        constructed: true,
                        parts: [
                            { type: 'cylinder', pos: [0, 0.9, 0], rot: [0,0,0], scale: [1.3,1.3,1.3], color: '#FFE44D' },
                            { type: 'box', pos: [0,0.75,0.8], rot: [0,0,0], scale: [0.6,0.3,0.9], color: '#FF8C00' },
                            { type: 'box', pos: [-0.28,1.05,0.5], rot: [0,0,0], scale: [0.18,0.18,0.02], color: '#000000' },
                            { type: 'box', pos: [0.28,1.05,0.5], rot: [0,0,0], scale: [0.18,0.18,0.02], color: '#000000' }
                        ],
                        offset: { x:0, y:0.6, z:0 },
                        rot: { x:0, y:0, z:0 }
                    };
                    try {
                        if (player && typeof player.createHat === 'function') {
                            player.createHat(hatData);
                            player.appearance.hat = hatData;
                            const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                            save.hat = player.appearance.hat;
                            localStorage.setItem('nblox_appearance', JSON.stringify(save));
                            addChatMessage('System', 'Equipped Duck Hat.');
                        }
                    } catch (e) { console.warn('Equip failed', e); }
                } else {
                    alert('This item cannot be equipped yet.');
                }
            });

            row.appendChild(ico);
            row.appendChild(meta);
            row.appendChild(equipBtn);
            list.appendChild(row);
        });
    } catch (e) {
        console.warn('populateOwnedItemsUI failed', e);
    }
}

// Hat creation handlers (Create/Remove hat) + Hat Editor
const btnCreateHat = document.getElementById('btn-create-hat');
const btnRemoveHat = document.getElementById('btn-remove-hat');
const btnOpenHatEditor = document.getElementById('btn-open-hat-editor');

if (btnCreateHat) {
    // Open the Hat Editor (studio-like workflow) instead of instantly creating the hat.
    btnCreateHat.addEventListener('click', () => {
        playSwitch();

        // Initialize editor values from the quick-create controls so the editor starts in the same state
        const quickColor = document.getElementById('hat-color') ? document.getElementById('hat-color').value : '#333333';
        const quickSize = document.getElementById('hat-size') ? document.getElementById('hat-size').value : '1.5';

        try {
            // Ensure editor UI exists and populate fields
            if (!hatEditor) {
                // In the unlikely event hatEditor wasn't created earlier, create a minimal visible editor
                console.warn('Hat editor missing - creating fallback editor.');
                // fallback already created elsewhere; do nothing
            }

            // Populate editor controls
            if (hatEditColor) hatEditColor.value = quickColor;
            if (hatEditSize) hatEditSize.value = quickSize;
            if (hatOffX) hatOffX.value = 0;
            if (hatOffY) hatOffY.value = 0.3;
            if (hatOffZ) hatOffZ.value = 0;
            if (hatRotX) hatRotX.value = 0;
            if (hatRotY) hatRotY.value = 0;
            if (hatRotZ) hatRotZ.value = 0;

            // Clear any previous modeler parts so the studio starts fresh
            clearHatModeler();

            // Show the editor like a studio tool window
            hatEditor.style.display = 'flex';

            // Create an initial preview (same as Create Hat would) so user sees immediate result and can refine
            createHatPreview();
            updateHatPreviewTransform();

            // Bring transform controls into editing mode so user can manipulate parts
            // If there are no parts, allow preview selection for global transform via transformControl
            if (transformControl && hatPreview) {
                transformControl.attach(hatPreview);
            }

            addChatMessage('System', 'Hat Editor opened. Use tools to model or save your hat when ready.');
        } catch (e) {
            console.warn('Failed to open Hat Editor:', e);
            addChatMessage('System', 'Failed to open Hat Editor.');
        }
    });
}
if (btnRemoveHat) {
    btnRemoveHat.addEventListener('click', () => {
        playSwitch();
        try {
            if (player && typeof player.removeHat === 'function') {
                player.removeHat();
                player.appearance.hat = null;
                try {
                    const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                    save.hat = null;
                    localStorage.setItem('nblox_appearance', JSON.stringify(save));
                } catch(e){}
                addChatMessage('System', 'Hat removed from your avatar.');
            } else {
                addChatMessage('System', 'No hat to remove.');
            }
        } catch (e) {
            console.warn('Hat removal failed:', e);
        }
    });
}

// Hat Editor: preview object attached to default head (not yet saved)
let hatPreview = null;

// Ensure hat editor exists in the DOM; if not, create a minimal editor container so the script can bind safely.
// This prevents runtime failures when the markup is missing or modified.
let hatEditor = document.getElementById('hat-editor');
if (!hatEditor) {
    hatEditor = document.createElement('div');
    hatEditor.id = 'hat-editor';
    hatEditor.className = 'xp-window';
    hatEditor.style.display = 'none';
    hatEditor.innerHTML = `
        <div class="xp-title-bar">
            <span>Hat Editor</span>
            <button id="btn-close-hat-editor" class="xp-btn-close">X</button>
        </div>
        <div class="xp-body" style="align-items: stretch;">
            <div style="display:flex; gap:8px; align-items:center; justify-content:center;">
                <label style="font-weight:bold;">Color</label>
                <input id="hat-edit-color" type="color" value="#333333">
                <label style="font-weight:bold;">Base Size</label>
                <input id="hat-edit-size" type="range" min="0.5" max="6" step="0.1" value="1.5" style="flex:1;">
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Offset X</label>
                    <input id="hat-off-x" type="range" min="-1.5" max="1.5" step="0.01" value="0" style="width:100%;">
                </div>
                <div style="flex:1;">
                    <label style="font-weight:bold;">Offset Y</label>
                    <input id="hat-off-y" type="range" min="-1.0" max="2.0" step="0.01" value="0.3" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Offset Z</label>
                    <input id="hat-off-z" type="range" min="-1.5" max="1.5" step="0.01" value="0" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Rot X</label>
                    <input id="hat-rot-x" type="range" min="-180" max="180" step="1" value="0" style="width:100%;">
                </div>
                <div style="flex:1;">
                    <label style="font-weight:bold;">Rot Y</label>
                    <input id="hat-rot-y" type="range" min="-180" max="180" step="1" value="0" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                <div style="flex:1;">
                    <label style="font-weight:bold;">Rot Z</label>
                    <input id="hat-rot-z" type="range" min="-180" max="180" step="1" value="0" style="width:100%;">
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px; justify-content:center;">
                <button id="hat-preview-apply" class="menu-btn">Apply Preview</button>
                <button id="hat-preview-save" class="menu-btn" style="background:#00cc00;color:white;">Save Hat</button>
                <button id="hat-preview-cancel" class="menu-btn" style="background:#ffcccc;">Cancel</button>
            </div>
        </div>
        <div class="xp-resizer"></div>
    `;
    document.body.appendChild(hatEditor);
}

// Bind editor controls (will be present either in original markup or created above)
const hatEditColor = document.getElementById('hat-edit-color') || { value: '#333333', addEventListener: () => {} };
const hatEditSize = document.getElementById('hat-edit-size') || { value: '1.5', addEventListener: () => {} };
const hatOffX = document.getElementById('hat-off-x') || { value: '0', addEventListener: () => {} };
const hatOffY = document.getElementById('hat-off-y') || { value: '0.3', addEventListener: () => {} };
const hatOffZ = document.getElementById('hat-off-z') || { value: '0', addEventListener: () => {} };
const hatRotX = document.getElementById('hat-rot-x') || { value: '0', addEventListener: () => {} };
const hatRotY = document.getElementById('hat-rot-y') || { value: '0', addEventListener: () => {} };
const hatRotZ = document.getElementById('hat-rot-z') || { value: '0', addEventListener: () => {} };
const hatPreviewApply = document.getElementById('hat-preview-apply') || { addEventListener: () => {} };
const hatPreviewSave = document.getElementById('hat-preview-save') || { addEventListener: () => {} };
const hatPreviewCancel = document.getElementById('hat-preview-cancel') || { addEventListener: () => {} };
const btnCloseHatEditor = document.getElementById('btn-close-hat-editor') || { addEventListener: () => {} };

function createHatPreview(hatData = null) {
    // remove existing preview
    if (hatPreview && hatPreview.parent) {
        try { hatPreview.parent.remove(hatPreview); } catch(e){}
        hatPreview = null;
        clearHatModeler(); // Ensure modeler state is reset if we tear down the preview
    }

    const group = new THREE.Group();
    group.name = 'hat_preview';
    group.scale.set(0.6, 0.6, 0.6); // Base scale for initial preview

    // Load geometry based on hatData, or create simple hat if none
    if (hatData && hatData.constructed && hatData.parts && hatData.parts.length > 0) {
        // Load composed hat
        hatData.parts.forEach((p) => {
            let geo;
            const size = p.scale || [1, 1, 1];
            const color = p.color || hatEditColor.value;

            if (p.type === 'box') {
                geo = new THREE.BoxGeometry(1, 0.5, 1);
            } else if (p.type === 'cylinder') {
                geo = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 16);
            } else {
                geo = new THREE.BoxGeometry(1, 0.5, 1);
            }
            const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
            
            const mesh = new THREE.Mesh(geo, mat);
            if (p.pos) mesh.position.fromArray(p.pos);
            if (p.rot) mesh.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
            if (p.scale) mesh.scale.set(size[0], size[1], size[2]);
            
            group.add(mesh);
            // Also update modeler state if loading into the editor view
            hatParts.push({ mesh: mesh, type: p.type });
        });
        
        // Set color from first part if available (for the color picker display)
        if (hatData.parts[0].color && hatEditColor) {
             hatEditColor.value = hatData.parts[0].color;
        }

    } else {
        // Build a simple hat (brim + cap) matching Player.createHat style
        const size = parseFloat(hatEditSize.value || 1.5);
        const color = hatEditColor.value || '#333333';
        const brimGeo = new THREE.CylinderGeometry(size * 1.4, size * 1.4, 0.15, 24);
        const brimMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
        const brim = new THREE.Mesh(brimGeo, brimMat);
        brim.rotation.x = Math.PI / 2;
        brim.position.y = 0.05;
        group.add(brim);

        // Top (cap)
        const capGeo = new THREE.CylinderGeometry(size * 0.8, size * 0.8, size * 0.9, 24);
        const capMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.y = 0.6;
        group.add(cap);
    }

    // Position from sliders (applies regardless of whether loaded/simple)
    const off = hatData && hatData.offset ? hatData.offset : { x: parseFloat(hatOffX.value||0), y: parseFloat(hatOffY.value||0), z: parseFloat(hatOffZ.value||0) };
    const rot = hatData && hatData.rot ? hatData.rot : { x: parseFloat(hatRotX.value||0), y: parseFloat(hatRotY.value||0), z: parseFloat(hatRotZ.value||0) };
    
    group.position.set(off.x, off.y, off.z);
    group.rotation.set(
        THREE.MathUtils.degToRad(rot.x),
        THREE.MathUtils.degToRad(rot.y),
        THREE.MathUtils.degToRad(rot.z)
    );
    
    // Scale group based on size slider value if simple hat, otherwise keep default 0.6
    if (!hatData || !hatData.constructed) {
        const s = parseFloat(hatEditSize.value || 1.5);
        group.scale.set(0.6, 0.6, 0.6).multiplyScalar(s / 1.5);
    } else {
        group.scale.set(0.6, 0.6, 0.6);
    }

    hatPreview = group;

    // attach to player's head (or to scene if player.head missing)
    if (player && player.head) {
        player.head.add(hatPreview);
    } else {
        scene.add(hatPreview);
    }
    
    // If we loaded a composed hat, select the first part and refresh list
    if (hatParts.length > 0) {
        selectHatPart(hatParts[0]);
        rebuildHatPartsList();
    }
}

function updateHatPreviewTransform() {
    if (!hatPreview) return;
    hatPreview.position.set(parseFloat(hatOffX.value||0), parseFloat(hatOffY.value||0), parseFloat(hatOffZ.value||0));
    hatPreview.rotation.set(
        THREE.MathUtils.degToRad(parseFloat(hatRotX.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotY.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotZ.value||0))
    );
    const s = parseFloat(hatEditSize.value || 1.5);
    hatPreview.children.forEach(c => {
        if (c.material) c.material.color.set(hatEditColor.value || '#333333');
    });
    hatPreview.scale.set(0.6, 0.6, 0.6).multiplyScalar(s / 1.5);
}

if (btnOpenHatEditor) {
    btnOpenHatEditor.addEventListener('click', () => {
        playSwitch();
        // Initialize editor controls from current appearance or defaults
        const hat = (player && player.appearance && player.appearance.hat) ? player.appearance.hat : null;
        
        // Populate editor controls based on saved hat data
        const defaultColor = (document.getElementById('hat-color') ? document.getElementById('hat-color').value : '#333333');
        const defaultSize = (document.getElementById('hat-size') ? document.getElementById('hat-size').value : 1.5);

        // Simple Hat fields
        // If constructed, we load the part colors, otherwise we use the simple hat color
        if (hatEditColor) {
            hatEditColor.value = (hat && hat.color && !hat.constructed) ? hat.color : defaultColor;
        }
        // If constructed, we don't necessarily use hat.size, but we need to initialize the slider
        if (hatEditSize) {
            hatEditSize.value = (hat && hat.size) ? hat.size : defaultSize;
        }
        
        // Transform fields (use hat data if available, otherwise default)
        if (hatOffX) hatOffX.value = hat && hat.offset ? hat.offset.x : 0;
        if (hatOffY) hatOffY.value = hat && hat.offset ? hat.offset.y : 0.3;
        if (hatOffZ) hatOffZ.value = hat && hat.offset ? hat.offset.z : 0;
        if (hatRotX) hatRotX.value = hat && hat.rot ? hat.rot.x : 0;
        if (hatRotY) hatRotY.value = hat && hat.rot ? hat.rot.y : 0;
        if (hatRotZ) hatRotZ.value = hat && hat.rot ? hat.rot.z : 0;

        // Clear existing modeler state before loading/creating preview
        clearHatModeler();

        if (hatEditor) hatEditor.style.display = 'flex';
        createHatPreview(hat); // Pass saved hat data for loading
        rebuildHatPartsList(); // Refresh parts list in case composed hat was loaded
    });
}

if (btnCloseHatEditor) {
    btnCloseHatEditor.addEventListener('click', () => {
        playSwitch();
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
    });
}

if (hatPreviewCancel) {
    hatPreviewCancel.addEventListener('click', () => {
        playSwitch();
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
    });
}

if (hatPreviewApply) {
    hatPreviewApply.addEventListener('click', () => {
        playSwitch();
        if (!hatPreview) createHatPreview();
        updateHatPreviewTransform();
        addChatMessage('System', 'Hat preview updated.');
    });
}

if (hatPreviewSave) {
    hatPreviewSave.addEventListener('click', () => {
        playSwitch();
        if (hatParts.length > 0) {
            saveComposedHat();
        } else {
            // fallback to simple createHat behavior
            const color = hatEditColor.value || '#333333';
            const size = parseFloat(hatEditSize.value || '1.5');
            
            if (player && typeof player.createHat === 'function') {
                const hatData = {
                    color: color,
                    size: size,
                    offset: { x: parseFloat(hatOffX.value||0), y: parseFloat(hatOffY.value||0), z: parseFloat(hatOffZ.value||0) },
                    rot: { x: parseFloat(hatRotX.value||0), y: parseFloat(hatRotY.value||0), z: parseFloat(hatRotZ.value||0) }
                };
                
                player.createHat(hatData);

                // Persist appearance
                player.appearance.hat = hatData;

                try {
                    const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
                    save.hat = player.appearance.hat;
                    save.colors = player.appearance.colors || save.colors;
                    save.faceUrl = player.appearance.faceUrl || save.faceUrl;
                    save.shirtUrl = player.appearance.shirtUrl || save.shirtUrl;
                    localStorage.setItem('nblox_appearance', JSON.stringify(save));
                } catch (e) { console.warn('Failed to persist hat to storage', e); }

                addChatMessage('System', 'Simple hat saved to your avatar.');
            } else {
                addChatMessage('System', 'Failed to save hat: Player not ready.');
            }
        }

        // Close editor and cleanup preview
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
        clearHatModeler();
    });
}

/*
  Hat Modeler: allow adding box/cylinder parts, selecting parts with TransformControls,
  previewing, and saving the composed hat to the player. We dynamically inject a small
  toolbar into the Hat Editor and reuse the existing TransformControls instance.
*/
/* reuse existing hatPreview from earlier in the file */
let hatParts = []; // { mesh, type }
let hatSelectedPart = null;
let hatPartsListEl = null;
let hatToolBarEl = null;

// Create toolbar UI inside the hat editor body if not already present
(function ensureHatEditorUI() {
    if (!hatEditor) return;
    const body = hatEditor.querySelector('.xp-body');
    if (!body) return;

    // Add toolbar container
    hatToolBarEl = document.createElement('div');
    hatToolBarEl.style.display = 'flex';
    hatToolBarEl.style.gap = '8px';
    hatToolBarEl.style.width = '100%';
    hatToolBarEl.style.marginTop = '8px';
    hatToolBarEl.style.flexWrap = 'wrap';
    hatToolBarEl.style.alignItems = 'center';
    hatToolBarEl.innerHTML = `
        <button id="hat-add-box" class="menu-btn" style="padding:6px 8px;">Add Box</button>
        <button id="hat-add-cylinder" class="menu-btn" style="padding:6px 8px;">Add Cylinder</button>
        <button id="hat-remove-part" class="menu-btn" style="padding:6px 8px; background:#ffcccc;">Remove Part</button>
        <div id="hat-parts-list" style="flex:1; min-width:120px; display:flex; gap:6px; overflow-x:auto;"></div>
    `;
    body.insertBefore(hatToolBarEl, body.firstChild);
    hatPartsListEl = hatToolBarEl.querySelector('#hat-parts-list');

    // Attach handlers
    hatToolBarEl.querySelector('#hat-add-box').addEventListener('click', () => addHatPart('box'));
    hatToolBarEl.querySelector('#hat-add-cylinder').addEventListener('click', () => addHatPart('cylinder'));
    hatToolBarEl.querySelector('#hat-remove-part').addEventListener('click', () => {
        removeSelectedHatPart();
    });
})();

function rebuildHatPartsList() {
    if (!hatPartsListEl) return;
    hatPartsListEl.innerHTML = '';
    hatParts.forEach((p, idx) => {
        const btn = document.createElement('button');
        btn.className = 'menu-btn';
        btn.style.padding = '4px 8px';
        btn.style.fontSize = '12px';
        btn.textContent = `${p.type} ${idx+1}`;
        if (p === hatSelectedPart) btn.style.background = '#cfeeff';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectHatPart(p);
        });
        hatPartsListEl.appendChild(btn);
    });
}

function addHatPart(type) {
    playSwitch();
    if (!hatPreview) createHatPreview();
    
    // If hatPreview contains default simple hat meshes and we are starting modeling, clear them.
    // Check if hatParts list is empty, but hatPreview (the group) has children.
    if (hatParts.length === 0 && hatPreview.children.length > 0) {
        // Remove existing meshes (default simple hat: brim/cap)
        while (hatPreview.children.length > 0) {
            const child = hatPreview.children[0];
            hatPreview.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                 if (Array.isArray(child.material)) child.material.forEach(m => m.dispose && m.dispose());
                 else child.material.dispose && child.material.dispose();
            }
        }
    }

    // create primitive
    let geo, mat;
    const color = hatEditColor.value || '#333333';
    if (type === 'box') {
        geo = new THREE.BoxGeometry(1, 0.5, 1);
    } else if (type === 'cylinder') {
        geo = new THREE.CylinderGeometry(0.5, 0.5, 0.6, 16);
    } else {
        geo = new THREE.BoxGeometry(1, 0.5, 1);
    }
    mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color) });
    const mesh = new THREE.Mesh(geo, mat);
    // Position slightly offset from center
    mesh.position.set(0, 0.6 + (hatParts.length * 0.05), 0);
    mesh.name = `part_${hatParts.length+1}`;
    
    hatPreview.add(mesh);
    hatParts.push({ mesh: mesh, type: type });
    selectHatPart(hatParts[hatParts.length - 1]);
    rebuildHatPartsList();
}

function selectHatPart(partObj) {
    hatSelectedPart = partObj;
    rebuildHatPartsList();
    // attach TransformControls for the part
    if (partObj && transformControl) {
        transformControl.attach(partObj.mesh);
    } else if (transformControl) {
        transformControl.detach();
    }
}

function removeSelectedHatPart() {
    if (!hatSelectedPart) return;
    const idx = hatParts.indexOf(hatSelectedPart);
    if (idx === -1) return;
    // remove mesh from preview
    try {
        if (hatSelectedPart.mesh.parent) hatSelectedPart.mesh.parent.remove(hatSelectedPart.mesh);
        if (hatSelectedPart.mesh.geometry) hatSelectedPart.mesh.geometry.dispose();
        if (hatSelectedPart.mesh.material) hatSelectedPart.mesh.material.dispose();
    } catch (e) {}
    hatParts.splice(idx, 1);
    hatSelectedPart = null;
    transformControl.detach();
    rebuildHatPartsList();
}

function clearHatModeler() {
    // remove all parts and preview
    for (const p of hatParts) {
        try { if (p.mesh.parent) p.mesh.parent.remove(p.mesh); } catch(e){}
    }
    hatParts = [];
    hatSelectedPart = null;
    rebuildHatPartsList();
    if (hatPreview && hatPreview.parent) {
        try { hatPreview.parent.remove(hatPreview); } catch(e){}
    }
    hatPreview = null;
}

// Save composed hat: create group, parent to player's visible head (or GLB), and persist transforms
function saveComposedHat() {
    if (!player) return;
    // Remove any existing hat
    player.removeHat();

    const composed = new THREE.Group();
    composed.name = 'composed_hat';
    // Copy parts into a new group (clone geometry/materials to avoid sharing)
    hatParts.forEach(p => {
        const gm = p.mesh.geometry.clone();
        let mm;
        try {
            mm = p.mesh.material.clone();
        } catch (e) {
            mm = new THREE.MeshStandardMaterial({ color: p.mesh.material.color ? p.mesh.material.color.clone() : new THREE.Color('#333') });
        }
        const m = new THREE.Mesh(gm, mm);
        m.position.copy(p.mesh.position);
        m.rotation.copy(p.mesh.rotation);
        m.scale.copy(p.mesh.scale);
        composed.add(m);
    });

    // Scale and default offsets like createHat uses a base scale factor
    composed.scale.set(1,1,1);

    // Prefer attaching to GLB head clone if present
    let attachTarget = player.head;
    if (player.mesh && player.mesh.children && player.mesh.children.length > 0) {
        for (const c of player.mesh.children) {
            if (c === player.head) continue;
            if (c.isObject3D && (!player.head.visible || c.name.toLowerCase().includes('head') || c.type === 'Group' || c.isMesh)) {
                attachTarget = c;
                break;
            }
        }
    }

    // Position composed group relative to head
    composed.position.set(parseFloat(hatOffX.value||0), parseFloat(hatOffY.value||0), parseFloat(hatOffZ.value||0));
    composed.rotation.set(
        THREE.MathUtils.degToRad(parseFloat(hatRotX.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotY.value||0)),
        THREE.MathUtils.degToRad(parseFloat(hatRotZ.value||0))
    );

    // Attach to head
    attachTarget.add(composed);

    // Save to player's appearance state
    player.appearance.hat = {
        constructed: true,
        parts: hatParts.map(p => ({
            type: p.type,
            pos: p.mesh.position.toArray(),
            rot: [p.mesh.rotation.x, p.mesh.rotation.y, p.mesh.rotation.z],
            scale: p.mesh.scale.toArray(),
            color: (p.mesh.material && p.mesh.material.color) ? `#${p.mesh.material.color.getHexString()}` : hatEditColor.value
        })),
        offset: { x: parseFloat(hatOffX.value||0), y: parseFloat(hatOffY.value||0), z: parseFloat(hatOffZ.value||0) },
        rot: { x: parseFloat(hatRotX.value||0), y: parseFloat(hatRotY.value||0), z: parseFloat(hatRotZ.value||0) }
    };

    // Persist to localStorage
    try {
        const save = JSON.parse(localStorage.getItem('nblox_appearance') || '{}');
        save.hat = player.appearance.hat;
        save.colors = player.appearance.colors || save.colors;
        save.faceUrl = player.appearance.faceUrl || save.faceUrl;
        save.shirtUrl = player.appearance.shirtUrl || save.shirtUrl;
        localStorage.setItem('nblox_appearance', JSON.stringify(save));
    } catch (e) { console.warn('Failed to persist composed hat', e); }

    addChatMessage('System', 'Custom hat saved to your avatar.');
}

// Hook Save button to composed hat flow (override previous simple save when modeler has parts)
if (hatPreviewSave) {
    hatPreviewSave.addEventListener('click', () => {
        playSwitch();
        if (hatParts.length > 0) {
            saveComposedHat();
        } else {
            // fallback to simple createHat behavior
            const color = hatEditColor.value || '#333333';
            const size = parseFloat(hatEditSize.value || '1.5');
            if (player && typeof player.createHat === 'function') {
                player.createHat(color, size);
                player._hat.position.set(parseFloat(hatOffX.value||0), parseFloat(hatOffY.value||0), parseFloat(hatOffZ.value||0));
                player._hat.rotation.set(
                    THREE.MathUtils.degToRad(parseFloat(hatRotX.value||0)),
                    THREE.MathUtils.degToRad(parseFloat(hatRotY.value||0)),
                    THREE.MathUtils.degToRad(parseFloat(hatRotZ.value||0))
                );
                addChatMessage('System', 'Simple hat saved to your avatar.');
            } else {
                addChatMessage('System', 'Failed to save hat: Player not ready.');
            }
        }

        // Close editor and cleanup preview
        hatEditor.style.display = 'none';
        if (hatPreview && hatPreview.parent) {
            try { hatPreview.parent.remove(hatPreview); } catch(e){}
            hatPreview = null;
        }
        clearHatModeler();
    });
}

// Live-update preview when sliders change
[hatEditColor, hatEditSize, hatOffX, hatOffY, hatOffZ, hatRotX, hatRotY, hatRotZ].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => {
        if (!hatPreview) createHatPreview();
        updateHatPreviewTransform();
        // Also tint parts if model exists
        hatParts.forEach(p => {
            if (p.mesh && p.mesh.material && p.mesh.material.color) p.mesh.material.color.set(hatEditColor.value || '#333333');
        });
    });
});

// Ensure transforms applied live for modeler parts when transform control changes
transformControl.addEventListener('change', () => {
    if (hatSelectedPart && hatSelectedPart.mesh) {
        // update stored transforms (no-op because we're using the live mesh)
        rebuildHatPartsList();
    }
});

// Clean up hat preview on editor close (already handled in earlier close handlers), ensure parts cleared
window.addEventListener('beforeunload', () => {
    clearHatModeler();
});

// Window Close Button Logic
document.getElementById('btn-close-start').onclick = () => alert("Cannot shut down Nblox OS while kernel is running.");
document.getElementById('btn-close-play').onclick = () => document.getElementById('btn-play-back').click();
document.getElementById('btn-close-set').onclick = () => document.getElementById('btn-settings-back').click();
document.getElementById('btn-close-cust').onclick = () => document.getElementById('btn-cust-done').click();

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    // Privacy lock toggle: press 'p' to toggle privacy lock (black screen + mute)
    // Ignore when typing in inputs
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        // let typing proceed
    } else {
        if (e.key.toLowerCase() === 'p') {
            enablePrivacyLock(!__privacyLocked);
            // provide subtle feedback
            try { playSwitch(); } catch(e){}
            return;
        }
    }

    // Studio Shortcuts
    if (gameState === 'STUDIO' && document.activeElement.tagName !== 'INPUT') {
        switch(e.key) {
            case '1': setStudioTool('select'); break;
            case '2': setStudioTool('move'); break;
            case '3': setStudioTool('scale'); break;
            case '4': setStudioTool('rotate'); break;
            case 'Delete': 
            case 'Backspace':
                if (studioSelected) document.getElementById('tool-delete').click();
                break;
            case 'd':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    document.getElementById('tool-duplicate').click();
                }
                break;
        }
    }
});

/* Polyfill for CanvasRenderingContext2D.roundRect for browsers that don't implement it.
   Many bubble/name-tag drawing routines call ctx.roundRect — if it's missing the drawing
   silently fails and bubbles / name tags don't appear. Add a minimal implementation once. */
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === 'number') {
      r = {tl: r, tr: r, br: r, bl: r};
    } else {
      r = r || {tl:0,tr:0,br:0,bl:0};
    }
    this.beginPath();
    this.moveTo(x + r.tl, y);
    this.lineTo(x + w - r.tr, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r.tr);
    this.lineTo(x + w, y + h - r.br);
    this.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
    this.lineTo(x + r.bl, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r.bl);
    this.lineTo(x, y + r.tl);
    this.quadraticCurveTo(x, y, x + r.tl, y);
    this.closePath();
    return this;
  };
}

// ===== PROFILE MODAL =====
// Draws a full-body blocky character on a canvas element, using body-part color map.
function drawBlockyCharacter(canvas, colors) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Scale factor so we can work in a fixed 60x80 design space
    const sx = W / 60, sy = H / 80;
    function rect(x, y, w, h, color, shade) {
        // Main face
        ctx.fillStyle = color;
        ctx.fillRect(x * sx, y * sy, w * sx, h * sy);
        // Right-side shadow for 3D illusion
        if (shade) {
            ctx.fillStyle = shadeColor(color, -28);
            ctx.fillRect((x + w - 3) * sx, y * sy, 3 * sx, h * sy);
            // Bottom shadow
            ctx.fillStyle = shadeColor(color, -18);
            ctx.fillRect(x * sx, (y + h - 2) * sy, w * sx, 2 * sy);
            // Top highlight
            ctx.fillStyle = shadeColor(color, 22);
            ctx.fillRect(x * sx, y * sy, w * sx, 2 * sy);
        }
        // Outline
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(x * sx + 0.4, y * sy + 0.4, w * sx - 0.8, h * sy - 0.8);
    }

    function shadeColor(hex, amount) {
        try {
            let r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            r = Math.max(0,Math.min(255,r+amount));
            g = Math.max(0,Math.min(255,g+amount));
            b = Math.max(0,Math.min(255,b+amount));
            return `rgb(${r},${g},${b})`;
        } catch(e) { return hex; }
    }

    const c = {
        head:  colors.head  || '#f5cba7',
        torso: colors.torso || '#3b5998',
        larm:  colors.larm  || '#f5cba7',
        rarm:  colors.rarm  || '#f5cba7',
        lleg:  colors.lleg  || '#1a237e',
        rleg:  colors.rleg  || '#1a237e',
    };

    // Left arm (behind torso)
    rect(2, 28, 11, 22, c.larm, true);
    // Right arm (behind torso)
    rect(47, 28, 11, 22, c.rarm, true);
    // Left leg
    rect(13, 52, 13, 25, c.lleg, true);
    // Right leg
    rect(34, 52, 13, 25, c.rleg, true);
    // Torso
    rect(13, 28, 34, 24, c.torso, true);
    // Head
    rect(15, 4, 30, 26, c.head, true);
    // Neck connector
    ctx.fillStyle = shadeColor(c.head, -10);
    ctx.fillRect(24 * sx, 28 * sy, 12 * sx, 2 * sy);

    // Eyes (white sclera + dark pupils)
    // Left eye
    ctx.fillStyle = '#fff';
    ctx.fillRect(19 * sx, 12 * sy, 8 * sx, 8 * sy);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(21 * sx, 14 * sy, 5 * sx, 5 * sy);
    ctx.fillStyle = '#fff';
    ctx.fillRect(24 * sx, 14 * sy, 2 * sx, 2 * sy); // highlight
    // Right eye
    ctx.fillStyle = '#fff';
    ctx.fillRect(33 * sx, 12 * sy, 8 * sx, 8 * sy);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(35 * sx, 14 * sy, 5 * sx, 5 * sy);
    ctx.fillStyle = '#fff';
    ctx.fillRect(38 * sx, 14 * sy, 2 * sx, 2 * sy); // highlight

    // Smile
    ctx.fillStyle = shadeColor(c.head, -50);
    ctx.fillRect(21 * sx, 24 * sy, 18 * sx, 2 * sy);
    ctx.fillRect(19 * sx, 22 * sy, 2 * sx, 2 * sy);
    ctx.fillRect(39 * sx, 22 * sy, 2 * sx, 2 * sy);

    // Torso button strip
    ctx.fillStyle = shadeColor(c.torso, -40);
    ctx.fillRect(28 * sx, 30 * sy, 4 * sx, 18 * sy);
}

function openProfileModal(username, totalVisits) {
    const modal = document.getElementById('profile-modal');
    if (!modal) return;

    document.getElementById('profile-modal-title').textContent = `${username}'s Profile`;
    document.getElementById('profile-username').textContent = username;

    // Format total visits
    const vStr = totalVisits >= 1000000
        ? `${(totalVisits/1000000).toFixed(1)}M total visits`
        : totalVisits >= 1000
        ? `${Math.round(totalVisits/100)/10}K total visits`
        : `${totalVisits || 0} total visits`;

    document.getElementById('profile-stats').innerHTML = `
        <span style="background:rgba(0,180,255,0.1);padding:4px 12px;border-radius:10px;font-weight:bold;color:#8cceff;border:1px solid rgba(0,180,255,0.2);">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#00d4ff" style="vertical-align:middle;margin-right:3px;"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5z"/></svg>
            ${vStr}
        </span>
    `;
    document.getElementById('profile-bio').textContent = `Creator on Faundry.buzz`;

    // Draw avatar on canvas using stored colors
    const canvas = document.getElementById('profile-avatar-canvas');
    if (canvas) {
        let colors = { head:'#f5cba7', torso:'#3b5998', larm:'#f5cba7', rarm:'#f5cba7', lleg:'#1a237e', rleg:'#1a237e' };
        try {
            const stored = JSON.parse(localStorage.getItem(`nblox_profile_colors_${username}`) || 'null');
            if (stored) colors = { ...colors, ...stored };
        } catch(e){}
        drawBlockyCharacter(canvas, colors);
    }

    modal.style.display = 'flex';
    // Try to load from Supabase for cloud-synced avatar (non-blocking)
    (async () => {
        try {
            const profile = await loadAvatar(username);
            if (profile && profile.colors && canvas) {
                drawBlockyCharacter(canvas, profile.colors);
            }
        } catch (e) {}
    })();
}

document.getElementById('btn-close-profile').onclick = () => {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.style.display = 'none';
};
document.getElementById('btn-close-profile-ok').onclick = () => {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.style.display = 'none';
};

// ===== MARKETPLACE =====
let _marketplaceListingsCache = null;
let _myPoints = 0;

function getMyPoints() {
    try { _myPoints = parseInt(localStorage.getItem('nblox_points') || '0', 10); } catch(e){ _myPoints = 0; }
    return _myPoints;
}
function addPoints(amt) {
    _myPoints = getMyPoints() + amt;
    try { localStorage.setItem('nblox_points', String(_myPoints)); } catch(e){}
    const el = document.getElementById('points-display');
    if (el) el.textContent = _myPoints;
}
function spendPoints(amt) {
    if (getMyPoints() < amt) return false;
    _myPoints -= amt;
    try { localStorage.setItem('nblox_points', String(_myPoints)); } catch(e){}
    const el = document.getElementById('points-display');
    if (el) el.textContent = _myPoints;
    return true;
}

// Sync points display on load
(function syncPointsDisplay() {
    const el = document.getElementById('points-display');
    if (el) el.textContent = getMyPoints();
})();

function openMarketplace() {
    const modal = document.getElementById('marketplace-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    // Update points shown
    const pts = getMyPoints();
    showMarketplaceBrowse(pts);
}

function showMarketplaceBrowse(pts) {
    const content = document.getElementById('mkt-content');
    if (!content) return;
    content.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
        <div style="font-size:18px;font-weight:bold;color:#f5a623;letter-spacing:0.04em;">T-Shirts for Sale</div>
        <div style="background:rgba(245,166,35,0.1);padding:6px 16px;border-radius:12px;font-weight:bold;color:#d8e0f8;border:1px solid rgba(245,166,35,0.3);display:flex;align-items:center;gap:6px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="#f5a623"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/></svg>
            Points: <span id="mkt-pts-display" style="color:#f5a623;font-size:16px;">${pts}</span>
        </div>
    </div>
    <div id="mkt-listings-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;"></div>
    <div id="mkt-loading" style="text-align:center;color:#506080;padding:24px;font-size:14px;">Loading listings...</div>`;

    // Load listings
    (async () => {
        try {
            const listings = await fetchMarketplaceListings();
            _marketplaceListingsCache = listings;
            const grid = document.getElementById('mkt-listings-grid');
            const loading = document.getElementById('mkt-loading');
            if (loading) loading.style.display = 'none';
            if (!grid) return;
            if (!listings.length) {
                grid.innerHTML = `<div style="color:#888;font-style:italic;grid-column:1/-1;text-align:center;padding:20px;">No listings yet! Be the first to sell a T-shirt.</div>`;
                return;
            }
            listings.forEach(item => {
                const card = document.createElement('div');
                card.style.cssText = `border:1.5px solid rgba(245,166,35,0.28);border-radius:10px;overflow:hidden;background:rgba(20,15,3,0.95);box-shadow:0 4px 16px rgba(0,0,0,0.5);display:flex;flex-direction:column;transition:border-color 0.15s,box-shadow 0.15s;`;
                card.addEventListener('mouseenter', () => { card.style.borderColor = 'rgba(245,166,35,0.55)'; card.style.boxShadow = '0 6px 24px rgba(245,166,35,0.15)'; });
                card.addEventListener('mouseleave', () => { card.style.borderColor = 'rgba(245,166,35,0.28)'; card.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)'; });
                const imgEl = document.createElement('img');
                imgEl.src = item.image_url || '/DefaultThumb.png';
                imgEl.alt = item.name;
                imgEl.style.cssText = `width:100%;height:120px;object-fit:cover;`;
                imgEl.onerror = () => { imgEl.src = '/DefaultThumb.png'; };
                card.appendChild(imgEl);
                const info = document.createElement('div');
                info.style.cssText = `padding:8px;flex:1;display:flex;flex-direction:column;gap:4px;`;
                info.innerHTML = `
                    <div style="font-weight:bold;font-size:13px;color:#d8e0f8;">${item.name}</div>
                    <div style="font-size:11px;color:#5bc8ff;">By ${item.seller || 'Unknown'}</div>
                    <div style="font-size:11px;color:#7890b0;">${item.description || ''}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:6px;">
                        <span style="font-weight:bold;color:#f5a623;font-size:14px;">${item.price} pts</span>
                        <span style="font-size:10px;color:#506080;">${item.sales || 0} sold</span>
                    </div>
                `;
                const buyBtn = document.createElement('button');
                buyBtn.className = 'menu-btn';
                buyBtn.textContent = 'Buy';
                buyBtn.style.cssText = `margin:0 8px 8px 8px;background:rgba(245,166,35,0.12) !important;border-color:rgba(245,166,35,0.4) !important;color:#f5a623 !important;font-weight:bold;border-radius:6px;`;
                buyBtn.addEventListener('click', () => {
                    const currentPts = getMyPoints();
                    if (currentPts < item.price) {
                        alert(`Not enough points! You have ${currentPts} points but need ${item.price}.`);
                        return;
                    }
                    if (confirm(`Buy "${item.name}" for ${item.price} points?`)) {
                        spendPoints(item.price);
                        const ptsEl = document.getElementById('mkt-pts-display');
                        if (ptsEl) ptsEl.textContent = getMyPoints();
                        const globalPtsEl = document.getElementById('points-display');
                        if (globalPtsEl) globalPtsEl.textContent = getMyPoints();
                        // Save purchased item locally
                        try {
                            const owned = JSON.parse(localStorage.getItem('nblox_owned_tshirts') || '[]');
                            owned.push({ id: item.id, name: item.name, image_url: item.image_url, boughtAt: Date.now() });
                            localStorage.setItem('nblox_owned_tshirts', JSON.stringify(owned));
                        } catch(e){}
                        alert(`You bought "${item.name}"! It has been added to your inventory.`);
                        buyBtn.textContent = 'Owned';
                        buyBtn.disabled = true;
                        buyBtn.style.opacity = '0.5';
                    }
                });
                // Mark as owned if already purchased
                try {
                    const owned = JSON.parse(localStorage.getItem('nblox_owned_tshirts') || '[]');
                    if (owned.some(o => o.id === item.id)) {
                        buyBtn.textContent = 'Owned';
                        buyBtn.disabled = true;
                        buyBtn.style.opacity = '0.5';
                    }
                } catch(e){}
                card.appendChild(info);
                card.appendChild(buyBtn);
                grid.appendChild(card);
            });
        } catch (e) {
            const loading = document.getElementById('mkt-loading');
            if (loading) loading.textContent = 'Failed to load listings.';
        }
    })();
}

function showMarketplaceSell() {
    const content = document.getElementById('mkt-content');
    if (!content) return;
    const currentUsername = (document.getElementById('input-username') || {}).value || 'Guest';
    content.innerHTML = `
        <div style="font-size:18px;font-weight:bold;color:#f5a623;margin-bottom:16px;letter-spacing:0.04em;">List a T-Shirt for Sale</div>
        <div style="display:flex;flex-direction:column;gap:13px;max-width:420px;">
            <div>
                <label style="font-weight:bold;font-size:13px;display:block;margin-bottom:5px;color:#d8e0f8;">Item Name</label>
                <input id="mkt-sell-name" type="text" maxlength="40" placeholder="e.g. Cool Blue Tee" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid rgba(245,166,35,0.3);border-radius:7px;font-size:14px;background:rgba(20,14,2,0.8);color:#d8e0f8;">
            </div>
            <div>
                <label style="font-weight:bold;font-size:13px;display:block;margin-bottom:5px;color:#d8e0f8;">Description</label>
                <input id="mkt-sell-desc" type="text" maxlength="100" placeholder="Short description..." style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid rgba(245,166,35,0.3);border-radius:7px;font-size:14px;background:rgba(20,14,2,0.8);color:#d8e0f8;">
            </div>
            <div>
                <label style="font-weight:bold;font-size:13px;display:block;margin-bottom:5px;color:#d8e0f8;">Price (Points)</label>
                <input id="mkt-sell-price" type="number" min="1" max="9999" value="50" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid rgba(245,166,35,0.3);border-radius:7px;font-size:14px;background:rgba(20,14,2,0.8);color:#d8e0f8;">
            </div>
            <div>
                <label style="font-weight:bold;font-size:13px;display:block;margin-bottom:5px;color:#d8e0f8;">T-Shirt Image</label>
                <div id="mkt-img-preview" style="width:120px;height:120px;border:2px dashed rgba(245,166,35,0.35);border-radius:8px;background:rgba(20,14,2,0.6);display:flex;align-items:center;justify-content:center;color:#7a6030;font-size:12px;margin-bottom:8px;">No image</div>
                <input id="mkt-sell-image" type="file" accept="image/*" style="font-size:13px;color:#7890b0;">
            </div>
            <div style="display:flex;gap:10px;align-items:center;">
                <div style="font-size:13px;color:#7890b0;">Listing as: <strong style="color:#d8e0f8;">${currentUsername}</strong></div>
            </div>
            <div id="mkt-sell-status" style="display:none;padding:9px;border-radius:7px;font-weight:bold;font-size:13px;"></div>
            <button id="mkt-btn-submit" class="menu-btn" style="background:rgba(245,166,35,0.14) !important;border-color:rgba(245,166,35,0.45) !important;color:#f5a623 !important;font-weight:bold;padding:11px;font-size:15px;box-shadow:0 0 14px rgba(245,166,35,0.18) !important;">List Item (+15 pts reward)</button>
        </div>
    `;

    // Image preview
    document.getElementById('mkt-sell-image').addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const preview = document.getElementById('mkt-img-preview');
            if (preview) {
                preview.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`;
            }
        };
        reader.readAsDataURL(f);
    });

    // Submit listing
    document.getElementById('mkt-btn-submit').addEventListener('click', async () => {
        const name = (document.getElementById('mkt-sell-name').value || '').trim();
        const desc = (document.getElementById('mkt-sell-desc').value || '').trim();
        const priceRaw = parseInt(document.getElementById('mkt-sell-price').value || '50', 10);
        const imageFile = document.getElementById('mkt-sell-image').files && document.getElementById('mkt-sell-image').files[0];
        const status = document.getElementById('mkt-sell-status');

        if (!name) { alert('Please enter an item name.'); return; }
        if (priceRaw < 1 || priceRaw > 9999) { alert('Price must be between 1 and 9999 points.'); return; }

        const btn = document.getElementById('mkt-btn-submit');
        btn.disabled = true;
        btn.textContent = 'Publishing...';
        if (status) { status.style.display = 'block'; status.style.background = 'rgba(0,100,200,0.1)'; status.style.color = '#0055aa'; status.textContent = 'Uploading...'; }

        try {
            let imageUrl = '';
            if (imageFile) {
                imageUrl = await uploadTshirtImage(imageFile, currentUsername) || '';
            }
            await createMarketplaceListing({
                seller: currentUsername,
                name,
                description: desc,
                price: priceRaw,
                image_url: imageUrl
            });
            // Award seller points for listing (15 pts reward)
            addPoints(15);
            if (status) { status.style.background = 'rgba(0,180,80,0.12)'; status.style.color = '#006600'; status.textContent = 'Listed! You earned 15 points for creating a listing.'; }
            btn.textContent = 'Listed!';
            // Invalidate cache
            _marketplaceListingsCache = null;
        } catch (e) {
            if (status) { status.style.background = 'rgba(200,0,0,0.1)'; status.style.color = '#990000'; status.textContent = 'Failed to publish: ' + (e.message || String(e)); }
            btn.disabled = false;
            btn.textContent = 'List Item';
        }
    });
}

function showMarketplaceMine() {
    const content = document.getElementById('mkt-content');
    if (!content) return;
    const currentUsername = (document.getElementById('input-username') || {}).value || 'Guest';
    let owned = [];
    try { owned = JSON.parse(localStorage.getItem('nblox_owned_tshirts') || '[]'); } catch(e){}
    content.innerHTML = `<div style="font-size:18px;font-weight:bold;color:#f5a623;margin-bottom:14px;letter-spacing:0.04em;">My Inventory</div>`;
    if (!owned.length) {
        content.innerHTML += `<div style="color:#506080;font-style:italic;">You haven't purchased any T-shirts yet. Browse the marketplace!</div>`;
        return;
    }
    const grid = document.createElement('div');
    grid.style.cssText = `display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;`;
    owned.forEach(item => {
        const card = document.createElement('div');
        card.style.cssText = `border:1.5px solid rgba(245,166,35,0.28);border-radius:10px;overflow:hidden;background:rgba(20,15,3,0.95);box-shadow:0 4px 16px rgba(0,0,0,0.5);`;
        card.innerHTML = `
            <img src="${item.image_url || '/DefaultThumb.png'}" alt="${item.name}" style="width:100%;height:110px;object-fit:cover;" onerror="this.src='/DefaultThumb.png'">
            <div style="padding:9px;">
                <div style="font-weight:bold;font-size:13px;color:#d8e0f8;">${item.name}</div>
                <div style="font-size:10px;color:#5bc8ff;margin-top:3px;letter-spacing:0.05em;">OWNED</div>
            </div>
        `;
        grid.appendChild(card);
    });
    content.appendChild(grid);
}

// Wire marketplace tabs
setTimeout(() => {
    const mktBrowse = document.getElementById('mkt-tab-browse');
    const mktSell = document.getElementById('mkt-tab-sell');
    const mktMine = document.getElementById('mkt-tab-mine');
    const mktClose = document.getElementById('btn-close-marketplace');

    if (mktBrowse) mktBrowse.addEventListener('click', () => {
        [mktBrowse, mktSell, mktMine].forEach(b => { if(b) { b.style.background = 'rgba(255,255,255,0.5)'; b.style.fontWeight = 'normal'; } });
        mktBrowse.style.background = 'linear-gradient(to bottom,#fff,#ffeaa0)';
        mktBrowse.style.fontWeight = 'bold';
        showMarketplaceBrowse(getMyPoints());
    });
    if (mktSell) mktSell.addEventListener('click', () => {
        [mktBrowse, mktSell, mktMine].forEach(b => { if(b) { b.style.background = 'rgba(255,255,255,0.5)'; b.style.fontWeight = 'normal'; } });
        mktSell.style.background = 'linear-gradient(to bottom,#fff,#ffeaa0)';
        mktSell.style.fontWeight = 'bold';
        showMarketplaceSell();
    });
    if (mktMine) mktMine.addEventListener('click', () => {
        [mktBrowse, mktSell, mktMine].forEach(b => { if(b) { b.style.background = 'rgba(255,255,255,0.5)'; b.style.fontWeight = 'normal'; } });
        mktMine.style.background = 'linear-gradient(to bottom,#fff,#ffeaa0)';
        mktMine.style.fontWeight = 'bold';
        showMarketplaceMine();
    });
    if (mktClose) mktClose.addEventListener('click', () => {
        const modal = document.getElementById('marketplace-modal');
        if (modal) modal.style.display = 'none';
    });

    const mktBtn = document.getElementById('btn-marketplace');
    if (mktBtn) mktBtn.addEventListener('click', () => {
        playSwitch();
        openMarketplace();
    });
}, 200);

// Chat Logic
function addChatMessage(name, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = `[${name}]:`;
    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = text;
    el.appendChild(nameSpan);
    el.appendChild(textSpan);
    chatHistory.appendChild(el);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

/*
  Robust chat Enter handler: always reads the real chat input by id and sends regardless of focus stubs.
  This ensures messages are routed, local bubble updates, and chat history receives the message.
*/
document.addEventListener('keydown', (e) => {
    try {
        if (e.key !== 'Enter') {
            if (e.key === 'Escape') {
                const active = document.activeElement;
                if (active && active.id === 'chat-input') active.blur();
            }
            return;
        }

        // Always obtain the live DOM input element (avoid using previously-stubbed references)
        const liveInput = document.getElementById('chat-input');
        if (!liveInput) return;

        // If the input is not focused, allow Enter to still send if there's content (helps mobile / focus edge cases)
        const msg = (liveInput.value || '').trim();
        if (!msg) {
            // nothing to send; blur to dismiss keyboard if needed
            try { liveInput.blur(); } catch (e) {}
            return;
        }

        // Prevent other handlers from interfering
        e.stopPropagation();
        e.preventDefault();

        // Moderation checks
        const slurPattern = /n[i1!l]{1,2}g{1,2}e?r?/i;
        if (slurPattern.test(msg)) {
            const threeDaysMs = 1 * 60 * 1000; // test ban duration
            const until = Date.now() + threeDaysMs;
            try { localStorage.setItem('nblox_ban_until', String(until)); } catch (err) {}
            try { room.updatePresence({ banned: true, banUntil: until }); } catch (err) {}
            alert('You have been banned for violating chat rules.');
            liveInput.value = '';
            liveInput.blur();
            const bplay = document.getElementById('btn-play'); if (bplay) bplay.disabled = true;
            const bstudio = document.getElementById('btn-studio'); if (bstudio) bstudio.disabled = true;
            if (gameState === 'PLAYING' || gameState === 'TEST') { try { btnExit.click(); } catch(e){} }
            return;
        }

        const datingPatternLocal = /\b(date|dating|meet up|meetup|kissing|relationship|romantic)\b/i;
        const declaredAgeLocal = parseInt((document.getElementById('input-age') && document.getElementById('input-age').value) || '18', 10);
        if (declaredAgeLocal === 13 && datingPatternLocal.test(msg)) {
            const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
            const until = Date.now() + fiveDaysMs;
            try { localStorage.setItem('nblox_ban_until', String(until)); } catch (err) {}
            try { room.updatePresence({ banned: true, banUntil: until }); } catch(e){}
            alert('You have been banned for predatory behavior for 5 days.');
            liveInput.value = '';
            liveInput.blur();
            const _btnPlay_local = document.getElementById('btn-play'); if (_btnPlay_local) _btnPlay_local.disabled = true;
            const _btnStudio_local = document.getElementById('btn-studio'); if (_btnStudio_local) _btnStudio_local.disabled = true;
            if (gameState === 'PLAYING' || gameState === 'TEST') { try { btnExit.click(); } catch(e){} }
            return;
        }

        // Special in-game command
        if (msg.toLowerCase() === '/e dance') {
            if (window.player && typeof window.player.startDance === 'function') window.player.startDance();
            liveInput.value = '';
            liveInput.blur();
            return;
        }

        const username = document.getElementById('input-username').value || "Player";
        const declaredAge = parseInt((document.getElementById('input-age') && document.getElementById('input-age').value) || '18', 10);

        // Send chat event to room (best-effort)
        try { room.send({ type: 'chat', message: msg, username: username, age: declaredAge }); } catch (e) {}

        // Add to local chat history immediately for responsiveness
        try { addChatMessage(username, msg); } catch (e) {}

        // Update local player's bubble and logic
        try {
            if (window.player && typeof window.player.chat === 'function') {
                window.player.chat(msg);
            } else if (typeof player !== 'undefined' && player && typeof player.chat === 'function') {
                player.chat(msg);
            }
        } catch (err) {
            console.warn('Failed to update local player bubble:', err);
        }

        // Clear input and blur (dismiss mobile keyboard)
        liveInput.value = '';
        try { liveInput.blur(); } catch (e) {}
    } catch (err) {
        console.warn('Chat input handler error:', err);
    }
});

// Cursor Logic
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(1, 1); // Start off-center
const cursorEl = document.getElementById('custom-cursor');
let cursorState = 'far';

const shiftLockCursor = document.createElement('img');
shiftLockCursor.src = '/CameraZoomIn_ovr (1).png';
shiftLockCursor.style.position = 'fixed';
shiftLockCursor.style.top = '50%';
shiftLockCursor.style.left = '50%';
shiftLockCursor.style.transform = 'translate(-50%, -50%)';
shiftLockCursor.style.width = '32px';
shiftLockCursor.style.height = '32px';
shiftLockCursor.style.zIndex = '10001';
shiftLockCursor.style.pointerEvents = 'none';
shiftLockCursor.style.display = 'none';
shiftLockCursor.style.mixBlendMode = 'screen'; // Make black background transparent
document.body.appendChild(shiftLockCursor);

window.addEventListener('keydown', (e) => {
    if (e.key === '/') {
        e.preventDefault();
        chatInput.focus();
    }
});

window.addEventListener('mousemove', (event) => {
    if (input.isLocked) {
        // Keep raycasting mouse centered when locked and show the game-styled cursor at screen center
        mouse.x = 0;
        mouse.y = 0;
        if (cursorEl) {
            // place cursor at absolute center of viewport so clicks/visuals still map to center
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            cursorEl.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
            cursorEl.style.display = 'block';
        }
        return;
    }
    if (input.isRightMouseDown && gameState === 'PLAYING') return;

    mouse.x = ((event.clientX / UI_ZOOM) / window.innerWidth) * 2 - 1;
    mouse.y = -((event.clientY / UI_ZOOM) / window.innerHeight) * 2 + 1;
    if (cursorEl) {
        cursorEl.style.transform = `translate(${event.clientX / UI_ZOOM}px, ${event.clientY / UI_ZOOM}px) translate(-50%, -50%)`;
        cursorEl.style.display = 'block';
    }
});

window.addEventListener('mousemove', (e) => {
    if (gameState === 'MENU' && e.target.tagName !== 'BUTTON') {
        mouse.x = ((e.clientX / UI_ZOOM) / window.innerWidth) * 2 - 1;
        mouse.y = -((e.clientY / UI_ZOOM) / window.innerHeight) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(player.mesh.children, true);
        if (intersects.length > 0) {
            player.glitchPart(intersects[0].object);
        }
    }
});

// Loop
let lastTime = 0;
const fps = 30; // Lower FPS to reduce CPU/GPU pressure on weaker browsers
const interval = 1000 / fps;

function animate(currentTime) {
    requestAnimationFrame(animate);
    
    if (gameState === 'BLOCKED') return; // Stop updates if blocked

    const deltaTime = currentTime - lastTime;
    
    if (deltaTime >= interval) {
        const dt = Math.min(deltaTime / 1000, 0.1); // Cap dt
        lastTime = currentTime - (deltaTime % interval);

        // Update Remote Players
        Object.values(remotePlayers).forEach(rp => rp.update(dt, camera, world));

        // Game Logic based on State
        if (gameState === 'PLAYING' || gameState === 'TEST') {
            updatePlaying(dt);
        } else if (gameState === 'MENU' || gameState === 'CUSTOMIZE' || gameState === 'SETTINGS') {
            updateMenu(dt);
        } else if (gameState === 'STUDIO') {
            updateStudio(dt);
        }

        renderer.render(scene, camera);
    }
}

function updateStudio(dt) {
    // Fly Camera Logic
    // Right Click to rotate
    if (input.isRightMouseDown) {
        const look = input.getLookDelta();
        // In-game sensitivity and standard mouse-to-pitch mapping
        const sens = cameraSensitivity * 0.005;
        studioCamYaw -= look.x * sens;
        // Fix pitch inversion: mouse down should look down
        studioCamPitch -= look.y * sens; 
        studioCamPitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, studioCamPitch));
        document.body.style.cursor = 'none';
    } else {
        document.body.style.cursor = 'default';
        input.getLookDelta(); // Clear delta
    }

    const rot = new THREE.Euler(studioCamPitch, studioCamYaw, 0, 'YXZ');
    // Actual direction the camera is looking
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(rot);
    // Standard world up
    const worldUp = new THREE.Vector3(0, 1, 0);
    // Horizontal Right vector (cross of fwd and world up) ensures strafing is horizontal
    const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
    // If we're looking almost straight up/down, cross product might fail, fallback to yaw-only right
    if (right.lengthSq() < 0.001) {
        right.set(1, 0, 0).applyEuler(new THREE.Euler(0, studioCamYaw, 0, 'YXZ'));
    }

    const speed = input.keys.shift ? 80 : 30; // Slightly faster studio flight
    
    // Support both WASD and Arrow Keys in Studio
    if (input.keys.w || input.keys.arrowup) studioCamPos.addScaledVector(fwd, speed * dt);
    if (input.keys.s || input.keys.arrowdown) studioCamPos.addScaledVector(fwd, -speed * dt);
    if (input.keys.d || input.keys.arrowright) studioCamPos.addScaledVector(right, speed * dt);
    if (input.keys.a || input.keys.arrowleft) studioCamPos.addScaledVector(right, -speed * dt);
    
    // Q/E for vertical up/down remains standard for Roblox Studio users
    if (input.keys.q) studioCamPos.addScaledVector(worldUp, -speed * dt);
    if (input.keys.e) studioCamPos.addScaledVector(worldUp, speed * dt);

    camera.position.copy(studioCamPos);
    camera.rotation.copy(rot);

    if (world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);

    // Selection Logic (Click)
    // We handle click in window event, but need to check if we are hovering gizmo
    if (!input.isDraggingGizmo && input.isLocked === false && !input.isRightMouseDown) {
        // Selection is handled via event listener to avoid constant raycasting, 
        // but we need to update cursor if hovering a part
    }
}

let studioHovered = null;

// Improved Studio Selection: Hover Highlight + Click to Select
window.addEventListener('mousemove', (e) => {
    if (gameState !== 'STUDIO') {
        if (hoverHelper.visible) hoverHelper.visible = false;
        return;
    }
    if (e.target.closest('#studio-gui')) return;
    
    // Don't update hover if dragging gizmo
    if (input.isDraggingGizmo) return;
    
    // Fix: If mouse is over gizmo handles, clear hover so we don't select behind it
    if (transformControl.axis !== null && activeTool !== 'select') {
        studioHovered = null;
        hoverHelper.visible = false;
        return;
    }

    // Adjust for Zoom
    mouse.x = ((e.clientX / UI_ZOOM) / window.innerWidth) * 2 - 1;
    mouse.y = -((e.clientY / UI_ZOOM) / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(world.collidables, false);

    if (intersects.length > 0) {
        studioHovered = intersects[0].object;
        hoverHelper.setFromObject(studioHovered);
        hoverHelper.visible = true;
    } else {
        studioHovered = null;
        hoverHelper.visible = false;
    }
});

window.addEventListener('mousedown', (e) => {
    if (gameState !== 'STUDIO') return;
    if (e.target.closest('#studio-gui')) return; // Ignore if clicking UI
    if (e.button !== 0) return; // Only Left Click
    if (input.isDraggingGizmo) return;
    
    // Fix: If clicking gizmo, don't select
    if (transformControl.axis !== null && activeTool !== 'select') return;

    if (studioHovered) {
        studioSelected = studioHovered;
        updateStudioSelection();
    } else {
        // Clicked empty space -> Deselect
        studioSelected = null;
        updateStudioSelection();
    }
});


function updateMenu(dt) {
    if (world.mapGroup) world.mapGroup.visible = false;
    menuGroup.visible = true;
    player.mesh.visible = true;

    // Show/hide remote players intelligently: keep them visible when they're in the same map
    // or whenever we're not in the launcher MENU so they don't disappear unexpectedly.
    for (const id in remotePlayers) {
        try {
            const rp = remotePlayers[id];
            // If we have presence info for that peer, only show them when they're on the same map
            const pres = (room && room.presence) ? room.presence[id] : null;
            const sameMap = pres && pres.map === currentMapName;
            // Show remote player when we're playing (they're part of the world) or when their presence indicates same map
            rp.mesh.visible = (gameState !== 'MENU') || !!sameMap;
        } catch (e) {
            // Best-effort: if anything goes wrong, don't throw — leave the mesh visible
            try { remotePlayers[id].mesh.visible = true; } catch (ee) {}
        }
    }

    // Fixed Camera
    camera.position.set(0, 5, 15);
    camera.lookAt(0, 4, 0);

    if (world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);

    if (player.isDead) {
        const menuWorld = { collidables: menuGroup.children };
        player.update(dt, { x: 0, z: 0, jump: false }, menuWorld);
        return;
    }

    // Dont change. this is already fixed, no need to fix whats already working.
    const menuPos = new THREE.Vector3(3.5, 1.5, 8)
    player.velocity.set(0, 0, 0);
    player.position.copy(menuPos);
    player.onGround = true; // Force ground state for animation
    
    // Dont change. this is already fixed, no need to fix whats already working.
    player.mesh.rotation.y = -Math.PI / 4;

    // Force Animation
    player.forcedAnim = 'walk';
    
    // Animate player idly
    // We pass null world, but since we forced velocity to 0 and handle position below, gravity won't accumulate effectively
    player.update(dt, { x: 0, z: 0, jump: false }, null); 
    
    // DOUBLE CRITICAL FIX: Force position AFTER update to overwrite any gravity integration from Player.js
    player.position.copy(menuPos);
    player.mesh.position.copy(player.position);
    player.mesh.rotation.set(0, -Math.PI / 4, 0);
}

function updatePlaying(dt) {
    if (world.mapGroup) world.mapGroup.visible = true;
    menuGroup.visible = false;
    
    // POINTS: award 1 point every 10 seconds played
    playSecondsAcc += dt;
    if (playSecondsAcc >= 10.0) {
        playSecondsAcc -= 10.0;
        try {
            websimPoints = parseInt(localStorage.getItem('nblox_points') || '0', 10);
            if (isNaN(websimPoints)) websimPoints = 0;
            websimPoints += 1;
            localStorage.setItem('nblox_points', String(websimPoints));
            if (pointsDisplay) pointsDisplay.textContent = String(websimPoints);
            addChatMessage('System', 'You earned 1 point for playing!');
        } catch (e) {
            console.warn('Failed to award playtime point:', e);
        }
    }

    // Sync Presence
    room.updatePresence({
        position: player.position,
        rotation: player.mesh.rotation.y,
        animState: player.animState,
        map: currentMapName,
        isDead: player.isDead
    });

    // 1. Update Camera Rotation
    const look = input.getLookDelta();
    if (look.x !== 0 || look.y !== 0) {
        cameraYaw -= look.x * 0.005 * cameraSensitivity;
        
        const invertMult = cameraInvertY ? -1 : 1;
        cameraPitch += look.y * 0.005 * cameraSensitivity * invertMult;
        
        // Clamp pitch (0.1 to PI/2 - 0.1)
        cameraPitch = Math.max(-1.4, Math.min(1.5, cameraPitch));
        
        // Ratchet Sound
        if (Math.abs(cameraYaw - lastCamYawClick) > 0.4) {
             // Use WebAudio
             playSwitch(1.5, 0.3);
             lastCamYawClick = cameraYaw;
        }
    }

    // 2. Update Camera Position
    const focusPoint = player.position.clone().add(new THREE.Vector3(0, 4.5, 0));

    if (input.isShiftLocked) {
        // Offset focus point to the right relative to camera view
        const offsetAmt = 1.75; // Studs
        // Yaw 0 = +Z (South). Right is -X (West).
        // 3D world: Forward is -Z. Right is +X.
        // So joystick Y+ -> Forward -> -Z
        // Joystick X+ -> Right -> +X
        const rx = -Math.cos(cameraYaw);
        const rz = Math.sin(cameraYaw);
        focusPoint.x += rx * offsetAmt;
        focusPoint.z += rz * offsetAmt;
    }

    const hDist = cameraDist * Math.cos(cameraPitch);
    const vDist = cameraDist * Math.sin(cameraPitch);
    const offsetX = hDist * Math.sin(cameraYaw);
    const offsetZ = hDist * Math.cos(cameraYaw);

    const camPos = focusPoint.clone().add(new THREE.Vector3(offsetX, vDist, offsetZ));
    
    // Wall check
    const camDir = new THREE.Vector3().subVectors(camPos, focusPoint).normalize();
    const dist = camPos.distanceTo(focusPoint);
    const wallRay = new THREE.Raycaster(focusPoint, camDir, 0, dist);
    const wallHits = wallRay.intersectObjects(world.collidables);
    if (wallHits.length > 0) {
        camPos.copy(wallHits[0].point).addScaledVector(camDir, -0.5);
    }

    camera.position.copy(camPos);
    camera.lookAt(focusPoint);

    if (world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);

    // Update Cursor UI for Shift Lock
    if (input.isShiftLocked) {
        shiftLockCursor.style.display = 'block';
        if (cursorEl) cursorEl.style.display = 'none';
    } else {
        shiftLockCursor.style.display = 'none';
    }

    // 3. Movement relative to Camera
    const rawControls = input.getMovement();
    const camFwd = new THREE.Vector3().subVectors(player.position, camera.position).setY(0).normalize();
    const camRight = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).normalize();
    
    const moveVec = new THREE.Vector3()
        .addScaledVector(camFwd, -rawControls.z)
        .addScaledVector(camRight, rawControls.x);
    
    // Pass 'e' key for interaction
    const controls = { 
        x: moveVec.x, 
        z: moveVec.z, 
        jump: rawControls.jump,
        w: input.keys.w,
        s: input.keys.s,
        a: input.keys.a,
        d: input.keys.d,
        e: input.keys.e
    };

    if (input.isShiftLocked) {
        controls.lookAngle = cameraYaw + Math.PI;
    }

    player.update(dt, controls, world, camera);
    
    world.update(dt); // Update cars and animations

    // Lucky World: coin collection logic (local only)
    if (currentMapName === 'lucky_world') {
        // iterate coins in world.items (coins were added without collidables)
        for (let i = world.items.length - 1; i >= 0; i--) {
            const it = world.items[i];
            if (it && it.userData && it.userData.serial && it.userData.serial.type === 'coin') {
                // Simple proximity check to player's position
                const distSq = it.position.distanceToSquared(player.position);
                if (distSq < 4.5) { // within ~2.1 units
                    // collect
                    try {
                        if (it.geometry) it.geometry.dispose();
                        if (Array.isArray(it.material)) it.material.forEach(m => m.dispose && m.dispose());
                        else if (it.material) it.material.dispose && it.material.dispose();
                    } catch (e) {}
                    if (it.parent) it.parent.remove(it);
                    world.items.splice(i, 1);
                    playerCoins += 1;
                    updateCoinUI();
                }
            }
        }
    }

    // SillyVille: planting seeds & awarding points per planted seed per second
    if (currentMapName === 'sillyville') {
        // Planting: if player presses E near ground, plant a seed (limit 6)
        if (controls && controls.e) {
            // Simple cooldown: only plant if distance from last planted > 2 or if none exist
            const maxSeeds = 6;
            if (sillySeedParts.length < maxSeeds) {
                // Create a small visual seed plant at player's feet
                const pos = player.position.clone();
                pos.y = 0.6;
                // pick next type
                const type = sillySeedTypes[sillyNextSeedIndex % sillySeedTypes.length];
                sillyNextSeedIndex++;
                // Simple color mapping
                const colorMap = {
                    'Strawberry': 0xff4444,
                    'Banana': 0xffee66,
                    'Blueberry': 0x4477ff,
                    'Apple': 0xff6666,
                    'Cherry': 0xff2255,
                    'Pumpkin': 0xff8800
                };
                const col = colorMap[type] || 0xffffff;
                // Small cylinder for a sprout
                const geom = new THREE.CylinderGeometry(0.5, 0.5, 0.8, 8);
                geom.rotateX(Math.PI/2);
                const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col * 0.1 });
                const sprout = new THREE.Mesh(geom, mat);
                sprout.position.copy(pos);
                sprout.userData = { planted: true, type: type, growth: 0 };
                world.mapGroup.add(sprout);
                sillySeedParts.push(sprout);
                world.items.push(sprout);
                addChatMessage('System', `You planted a ${type}!`);
            } else {
                addChatMessage('System', 'You have planted the maximum number of seeds (6).');
            }
        }

        // Award points: each planted seed yields +1 point per second (accumulate fractional dt)
        const seededCount = sillySeedParts.length;
        if (seededCount > 0) {
            // accumulate dt * seededCount
            sillyPointsAcc += seededCount * dt;
            // For growth visuals, increment small growth value on each seed
            for (const s of sillySeedParts) {
                s.userData.growth = Math.min(1.0, (s.userData.growth || 0) + dt * 0.1);
                // simple scale up based on growth
                const g = 0.5 + s.userData.growth * 1.5;
                s.scale.set(g, g, g);
            }
        }
        // Convert accumulated fractional points into integers and persist
        if (sillyPointsAcc >= 1.0) {
            const add = Math.floor(sillyPointsAcc);
            sillyPoints += add;
            sillyPointsAcc -= add;
            // Update HUD and persist
            const disp = document.getElementById('silly-points-display');
            if (disp) disp.textContent = String(sillyPoints);
            try { localStorage.setItem('sillyville_points', String(sillyPoints)); } catch (e) {}
        }
    }

    // Chirpless Hunt: egg collection awards points (Chirps removed)
    if (currentMapName === 'chirpless_hunt') {
        for (let i = world.items.length - 1; i >= 0; i--) {
            const it = world.items[i];
            if (!it) continue;
            if (it.name && it.name.startsWith('Egg')) {
                const distSq = it.position.distanceToSquared(player.position);
                if (distSq < 4.5) {
                    // Collect egg -> award 1 point
                    try {
                        if (it.geometry) it.geometry.dispose();
                        if (Array.isArray(it.material)) it.material.forEach(m => m.dispose && m.dispose());
                        else if (it.material) it.material.dispose && it.material.dispose();
                    } catch (e) {}
                    if (it.parent) it.parent.remove(it);
                    world.items.splice(i, 1);
                    websimPoints += 1;
                    try { localStorage.setItem('chirpless_points', String(websimPoints)); } catch(e){}
                    updateNameUI();
                    addChatMessage('System', 'You found an Egg! +1 Point.');
                }
            }
        }
    }

    // Rocket Olympics: award points faster while surviving and simple visual rockets/NPCs already spawn in world.update
    if (currentMapName === 'rocket_olympics') {
        // Faster point awarding while in this map: 1 point every 3 seconds
        if (!window._rocketPointAcc) window._rocketPointAcc = 0;
        window._rocketPointAcc += dt;
        if (window._rocketPointAcc >= 3.0) {
            const gain = Math.floor(window._rocketPointAcc / 3.0);
            window._rocketPointAcc -= gain * 3.0;
            try {
                websimPoints = parseInt(localStorage.getItem('nblox_points') || '0', 10);
                if (isNaN(websimPoints)) websimPoints = 0;
                websimPoints += gain;
                localStorage.setItem('nblox_points', String(websimPoints));
                if (pointsDisplay) pointsDisplay.textContent = String(websimPoints);
                addChatMessage('System', `Rocket Olympics: +${gain} points for surviving!`);
            } catch (e) {
                console.warn('Failed to award Rocket Olympics points:', e);
            }
        }

        // Check rocket collisions (simple proximity)
        if (world._rockets && world._rockets.length > 0 && !player.isDead) {
            for (let i = world._rockets.length - 1; i >= 0; i--) {
                const r = world._rockets[i];
                if (!r) continue;
                const d2 = r.position.distanceToSquared(player.position);
                if (d2 < 2.25) { // ~1.5 units radius
                    addChatMessage('System', 'Hit by a rocket! You exploded.');
                    player.fallApart();
                    break;
                }
            }
        }
    }

    // FlowerVille: sword pickup and zombie plant mob interactions
    if (currentMapName === 'flowerville') {
        // Pickup sword
        for (let i = world.items.length - 1; i >= 0; i--) {
            const it = world.items[i];
            if (!it) continue;
            if (it.userData && it.userData.serial && it.userData.serial.type === 'sword' || (it.name && it.name === 'Sword')) {
                const distSq = it.position.distanceToSquared(player.position);
                if (distSq < 4.0) {
                    // pickup
                    try {
                        if (it.geometry) it.geometry.dispose();
                        if (Array.isArray(it.material)) it.material.forEach(m => m.dispose && m.dispose());
                        else if (it.material) it.material.dispose && it.material.dispose();
                    } catch (e) {}
                    if (it.parent) it.parent.remove(it);
                    world.items.splice(i, 1);
                    player.hasSword = true;
                    addToInventory({ id: 'sword', label: 'Sword' });
                    updateInventoryUI();
                    addChatMessage('System', 'You picked up a Sword! Use it to defeat nearby Zombie Plants.');
                }
            }
        }

        // Mobs: simple wandering; if player has sword and gets close, remove mob
        if (world._flowerMobs && world._flowerMobs.length > 0) {
            for (let i = world._flowerMobs.length - 1; i >= 0; i--) {
                const mob = world._flowerMobs[i];
                if (!mob) continue;
                // simple wander
                mob.position.x += (mob.userData.vx || 0) * dt;
                mob.position.z += (mob.userData.vz || 0) * dt;
                // small chance to change direction
                if (Math.random() < 0.01) {
                    mob.userData.vx = (Math.random() - 0.5) * 0.8;
                    mob.userData.vz = (Math.random() - 0.5) * 0.8;
                }
                // If player has sword and is near, "kill" mob
                const d = mob.position.distanceTo(player.position);
                if (player.hasSword && d < 4.0) {
                    // remove mob
                    try {
                        if (mob.geometry) mob.geometry.dispose();
                        if (Array.isArray(mob.material)) mob.material.forEach(m => m.dispose && m.dispose());
                        else if (mob.material) mob.material.dispose && mob.material.dispose();
                    } catch (e) {}
                    if (mob.parent) mob.parent.remove(mob);
                    // Remove from items array
                    const idx = world.items.indexOf(mob);
                    if (idx !== -1) world.items.splice(idx, 1);
                    world._flowerMobs.splice(i, 1);
                    addChatMessage('System', 'You defeated a Zombie Plant!');
                }
            }
        }
    }

    // Chirpless Halloween: knock on door (press E) to get candy (one-time per door)
    if (currentMapName === 'chirpless_halloween') {
        if (controls && controls.e) {
            for (let i = 0; i < world.items.length; i++) {
                const it = world.items[i];
                if (!it) continue;
                if (it.userData && it.userData.isDoor) {
                    const d = it.position.distanceTo(player.position);
                    if (d < 4) {
                        if (it.userData.candyAvailable) {
                            it.userData.candyAvailable = false;
                            candyCount += 1;
                            updateCandyUI();
                            addChatMessage('System', 'You knocked and received candy! 🍬');
                        } else {
                            addChatMessage('System', 'You knocked but no more candy is available.');
                        }
                        break; // only interact with one door per press
                    }
                }
            }
        }
    }

    // Bench auto-sit logic: if player stands close to a bench, force sit pose
    let nearBench = null;
    for (const it of world.items) {
        if (it && it.userData && it.userData.isBench) {
            const d = it.position.distanceTo(player.position);
            if (d < 2.0) {
                nearBench = it;
                break;
            }
        }
    }
    if (nearBench) {
        // Force sitting pose and lock small movement visually
        player.animState = 'idle';
        player.velocity.set(0, 0, 0);
        player.onGround = true;
        // Position player on top of bench seat (small offset)
        player.position.x = nearBench.position.x;
        player.position.z = nearBench.position.z + 0.25; // sit slightly offset
        player.position.y = nearBench.position.y + 0.6;
        player.mesh.position.copy(player.position);
        // Sitting limb pose
        try {
            player.leftArm.rotation.x = -0.6;
            player.rightArm.rotation.x = -0.6;
            player.leftLeg.rotation.x = -1.5;
            player.rightLeg.rotation.x = -1.5;
        } catch (e) {}
    } else {
        // Make pets follow player normally
        for (const p of playerPets) {
            if (!p.mesh) continue;
            // simple spring-follow
            const target = player.mesh.position.clone().add(new THREE.Vector3( Math.sin(Date.now()*0.001 + playerPets.indexOf(p))*1.2, 1.2, Math.cos(Date.now()*0.001 + playerPets.indexOf(p))*1.2 ));
            p.mesh.position.lerp(target, Math.min(1, dt * 4));
        }
    }

    // Easter 2026 NPC Interaction & Obby progression
    if (currentMapName === 'easter_2026') {
        // Find NPC
        const npc = world._easterNPC;
        if (npc) {
            const dist = npc.position.distanceTo(player.position);
            // Show a simple "Press E" HUD near center if close
            if (dist < 4) {
                // Show prompt using chat UI for simplicity
                addChatMessage('System', 'Press E to interact: Oh No! easter bunny was just captured...');
                // If player presses E, trigger dialog/obby start
                if (controls && controls.e && !npc.userData.obbyStarted) {
                    npc.userData.obbyStarted = true;
                    addChatMessage('EasterNPC', 'Oh No! easter bunny was just captured... beat this obby to get him back! :D');
                    // Mark that the player has started the obby; the finish triggers later
                    npc.userData.obbyProgress = 0;
                }
            }
        }

        // Check finish triggers (finish blocks were saved on world as _easterFinish1/_easterFinish2)
        if (world._easterFinish1) {
            const f1 = world._easterFinish1;
            if (f1 && f1.parent) {
                const b = new THREE.Box3().setFromObject(f1);
                const pBox = new THREE.Box3().setFromObject(player.mesh);
                if (pBox.intersectsBox(b) && world._easterNPC && world._easterNPC.userData.obbyStarted && world._easterNPC.userData.obbyProgress < 1) {
                    world._easterNPC.userData.obbyProgress = 1;
                    addChatMessage('System', 'You completed level 1! Proceed to level 2.');
                }
            }
        }
        if (world._easterFinish2) {
            const f2 = world._easterFinish2;
            if (f2 && f2.parent) {
                const b2 = new THREE.Box3().setFromObject(f2);
                const pBox2 = new THREE.Box3().setFromObject(player.mesh);
                if (pBox2.intersectsBox(b2) && world._easterNPC && world._easterNPC.userData.obbyStarted && world._easterNPC.userData.obbyProgress === 1) {
                    world._easterNPC.userData.obbyProgress = 2;
                    // Reward: unlock build tool (simple flag on player)
                    player.appearance.buildToolUnlocked = true;
                    addChatMessage('System', 'You rescued the Easter Bunny and unlocked the Build Tool! Check Studio to use it.');
                }
            }
        }
    }

    // Cursor Raycast - still show the custom cursor when pointer-locked; center ray when locked
    if (!input.isShiftLocked) {
        // If locked, mouse is centered (mouse.x/mouse.y already zeroed), keep cursor visible at center
        if (input.isLocked) {
            if (cursorEl) {
                cursorEl.style.display = 'block';
                cursorEl.src = '/ArrowCursor.png'; // assume active/near while locked
            }
            raycaster.setFromCamera(mouse, camera);
        } else {
            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObjects(scene.children, true);
            const hovering = intersects.length > 0;
            if (cursorEl) {
                cursorEl.style.display = 'block';
                const targetState = hovering ? 'near' : 'far';
                if (cursorState !== targetState) {
                    cursorState = targetState;
                    cursorEl.src = hovering ? '/ArrowCursor.png' : '/ArrowFarCursor.png';
                }
            }
        }
    } else {
        // Shift-lock (aim) still shows special centered indicator but hide mouse pointer image
        if (cursorEl) cursorEl.style.display = 'none';
    }
} // End updatePlaying

function handleResize() {
    // Use full viewport size so the GL canvas isn't confined to a small offscreen buffer
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // Respect device pixel ratio for sharper rendering when available
    // Limit device pixel ratio to reduce GPU load on high-DPR displays
    // Allow higher DPR up to 2 on modern devices to reduce softness on mobile landscape while avoiding excessive GPU load
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);

    // Ensure the canvas fills the layout
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    // Keep skybox synced
    if (world && world.skyboxMesh) world.skyboxMesh.position.copy(camera.position);
}

window.addEventListener('resize', handleResize);
handleResize();

requestAnimationFrame(animate);
