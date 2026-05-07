// @ts-nocheck -- legacy strict-parity migration; tighten types per file
// Lightweight toast surface for multiplayer events. Listens on the
// OiSving.Net event bus and renders short-lived notifications into
// #net-toasts so players can see things the protocol layer is already
// firing (joiner left, host gone, state-hash drift) instead of having
// to crack open DevTools.

import { OiSving } from './namespace'

OiSving.Toasts = {
    container: null,

    init: function() {
        this.container = document.getElementById('net-toasts');

        if (!OiSving.Net || !OiSving.Net.on) return;

        OiSving.Net.on('player-joined', function(entry) {
            if (entry.isLocal) return;
            OiSving.Toasts.show({
                kind: 'info',
                title: entry.playerId + ' connected',
                body: 'Joined the room.',
                duration: 4000,
            });
        });

        OiSving.Net.on('player-left', function(entry) {
            if (entry.isLocal) return;
            OiSving.Toasts.show({
                kind: 'info',
                title: entry.playerId + ' disconnected',
                body: 'Left the room.',
                duration: 6000,
            });
        });

        OiSving.Net.on('host-gone', function() {
            // Server explicitly told us the host left. Distinct from
            // 'connection-state' = 'closed', which the server also
            // emits when a long-running room idles out the signaling
            // socket post-handshake — we don't want to bother players
            // with a "lost host" toast just because the WS GC'd.
            OiSving.Toasts.show({
                kind: 'warn',
                title: 'Disconnected',
                body: 'Lost the host. The room is no longer active.',
                duration: 8000,
            });
        });

        OiSving.Net.on('state-hash-mismatch', function(frameId) {
            // Throttle: drift mismatches can fire repeatedly while the
            // simulation is divergent. Showing a stack of duplicate
            // toasts is unhelpful — coalesce into one rolling banner.
            OiSving.Toasts.coalesce('drift', {
                kind: 'warn',
                title: 'Simulation drift detected',
                body: 'State diverged from host at frame ' + frameId + '. The round may abort.',
                duration: 4000,
            });
        });

        OiSving.Net.on('host-state-stalled', function() {
            // Joiner watchdog tripped — host snapshots have stopped
            // landing. Coalesce so a single bad network burst doesn't
            // produce a stack of toasts.
            OiSving.Toasts.coalesce('host-state-stalled', {
                kind: 'warn',
                title: 'Reconnecting to host...',
                body: 'Host updates have stopped. Trying to recover.',
                duration: 3000,
            });
        });

        OiSving.Net.on('peer-desync', function() {
            // Three stalls in 5 seconds — the joiner has been desynced
            // long enough to give up. The 'host-gone' event fires
            // alongside this one, so we don't need a separate toast
            // for the route-to-menu UI; this one names what happened.
            OiSving.Toasts.coalesce('peer-desync', {
                kind: 'warn',
                title: 'Lost sync with host',
                body: 'Returning to the menu.',
                duration: 6000,
            });
        });
    },

    show: function(opts) {
        if (!this.container) return;
        var toast = document.createElement('div');
        toast.className = 'net-toast net-toast-' + (opts.kind || 'info');
        // Use textContent rather than innerHTML — toast bodies include
        // playerId / address values that originate from peer-supplied
        // data via the signaling channel. The server now whitelists
        // player ids on ingest, but the toast surface is the last
        // place we'd want a script-injection regression to land.
        var title = document.createElement('div');
        title.className = 'net-toast-title';
        title.textContent = String(opts.title || '');
        var body = document.createElement('div');
        body.className = 'net-toast-body';
        body.textContent = String(opts.body || '');
        toast.appendChild(title);
        toast.appendChild(body);
        this.container.appendChild(toast);

        // Trigger CSS transition by toggling the class on next frame.
        requestAnimationFrame(function() { toast.classList.add('is-visible'); });

        var dur = typeof opts.duration === 'number' ? opts.duration : 5000;
        setTimeout(function() {
            toast.classList.remove('is-visible');
            setTimeout(function() {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 250);
        }, dur);

        return toast;
    },

    // Coalescing key. If a toast with the same key is already on screen
    // we just refresh its content + restart its timer instead of
    // stacking duplicates. Used for state-hash drift, which can fire on
    // every gossip interval until the round aborts.
    _coalesced: {},
    coalesce: function(key, opts) {
        var existing = OiSving.Toasts._coalesced[key];
        if (existing && existing.parentNode) {
            existing.querySelector('.net-toast-title').innerText = opts.title;
            existing.querySelector('.net-toast-body').innerText = opts.body;
            // Restart the timer by removing + re-adding the visible class.
            return;
        }
        var toast = OiSving.Toasts.show(opts);
        OiSving.Toasts._coalesced[key] = toast;
        var dur = typeof opts.duration === 'number' ? opts.duration : 5000;
        setTimeout(function() {
            delete OiSving.Toasts._coalesced[key];
        }, dur + 250);
    },
};
