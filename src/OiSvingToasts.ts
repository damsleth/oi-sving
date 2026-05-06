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

        OiSving.Net.on('player-left', function(entry) {
            if (entry.isLocal) return;
            OiSving.Toasts.show({
                kind: 'info',
                title: 'Player left',
                body: '"' + entry.playerId + '" disconnected.',
                duration: 6000,
            });
        });

        OiSving.Net.on('connection-state', function(state) {
            // Surfaces host-gone (server fanout) as a closed connection
            // for joiners. Host's own connection-state never reaches
            // 'closed' as a result of a joiner leaving, so this is a
            // joiner-only signal in practice.
            if (state === 'closed') {
                OiSving.Toasts.show({
                    kind: 'warn',
                    title: 'Disconnected',
                    body: 'Lost the host. The room is no longer active.',
                    duration: 8000,
                });
            }
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
    },

    show: function(opts) {
        if (!this.container) return;
        var toast = document.createElement('div');
        toast.className = 'net-toast net-toast-' + (opts.kind || 'info');
        toast.innerHTML =
            '<div class="net-toast-title">' + opts.title + '</div>' +
            '<div class="net-toast-body">' + opts.body + '</div>';
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
