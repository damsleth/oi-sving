// @ts-nocheck -- legacy strict-parity migration; tighten types per file
/**
 *
 * Program:     OiSving
 * Author:      Markus Mächler, marmaechler@gmail.com
 * License:     http://www.gnu.org/licenses/gpl.txt
 * Link:        http://achtungkurve.com
 *
 * Copyright © 2014, 2015 Markus Mächler
 *
 * OiSving is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * OiSving is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with OiSving.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

import { OiSving } from './namespace'
import { u } from './OiSvingUtility'

OiSving.Menu = {

    boundOnKeyDown: null,
    audioPlayer: null,
    scrollKeys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Spacebar', ' '],
    // Player ids the remote peer (host or joiner, depending on which side
    // we are) has already activated. Locked here so the local user cannot
    // pick the same color and end up with a collapsed roster after the
    // dedupe in buildGameCurves. Populated/cleared by Net 'player-joined'
    // and 'player-left' events.
    remoteTakenIds: {},

    init: function() {
        this.initPlayerMenu();
        this.addWindowListeners();
        this.addMouseListeners();
        this.initMenuMusic();

        if (OiSving.Net && OiSving.Net.on) {
            OiSving.Net.on('player-joined', function(entry) {
                if (entry.isLocal) {
                    OiSving.Menu.syncLocalActivation(entry.playerId, true);
                } else {
                    OiSving.Menu.lockRemoteColor(entry.playerId);
                }
                OiSving.Menu.refreshStartGameButton();
            });
            OiSving.Net.on('player-left', function(entry) {
                if (entry.isLocal) {
                    OiSving.Menu.syncLocalActivation(entry.playerId, false);
                } else {
                    OiSving.Menu.unlockRemoteColor(entry.playerId);
                }
                OiSving.Menu.refreshStartGameButton();
            });
            OiSving.Net.on('roster-update', function() {
                OiSving.Menu.refreshStartGameButton();
            });
            OiSving.Net.on('connection-state', function() {
                OiSving.Menu.refreshStartGameButton();
            });
        }

        // Poll the LAN signaling server for active rooms so single-tab
        // discovery works without typing a code. Hidden while we're in a
        // round (handled in renderRoomsList).
        OiSving.Menu.refreshAvailableRooms();
        OiSving.Menu._roomsPollHandle = setInterval(function() {
            OiSving.Menu.refreshAvailableRooms();
        }, 5000);

        OiSving.Menu.refreshStartGameButton();
    },

    // Host-truth activation: mirror Net's authoritative localPlayerIds
    // into Player.isActive + DOM classes, without re-broadcasting.
    syncLocalActivation: function(playerId, active) {
        var p = OiSving.getPlayer(playerId);
        if (!p) return;
        if (active) {
            if (!p.isActive()) p.setIsActive(true);
            u.removeClass('inactive', playerId);
            u.addClass('active', playerId);
        } else {
            if (p.isActive()) p.setIsActive(false);
            u.removeClass('active', playerId);
            u.addClass('inactive', playerId);
        }
    },

    refreshStartGameButton: function() {
        var btn = document.getElementById('start-game');
        if (!btn) return;
        var enabled = false;
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive()) {
            // Only the host can start in net mode, and only when ≥2
            // players are claimed across the roster.
            enabled = !!(OiSving.Net.isHost && OiSving.Net.isHost() && OiSving.Net.canStartRound && OiSving.Net.canStartRound());
        } else {
            // Single-player + split-keyboard: ≥2 locally-active players.
            var active = OiSving.players.filter(function(p) { return p.isActive(); }).length;
            enabled = active >= 2;
        }
        if (enabled) btn.classList.remove('disabled');
        else btn.classList.add('disabled');
    },

    refreshAvailableRooms: function() {
        if (!OiSving.Net || !OiSving.Net.listRooms) return;
        // Hide the available-games block while we're already connected to
        // a room — no need to advertise other lobbies in that state.
        var container = document.getElementById('net-rooms');
        if (OiSving.Net.isActive && OiSving.Net.isActive()) {
            if (container) container.style.display = 'none';
            return;
        }
        if (container) container.style.display = '';
        OiSving.Net.listRooms().then(function(rooms) {
            OiSving.Menu.renderRoomsList(rooms || []);
        }).catch(function() {
            OiSving.Menu.renderRoomsList([]);
        });
    },

    renderRoomsList: function(rooms) {
        var list = document.getElementById('net-rooms-list');
        if (!list) return;
        if (!rooms.length) {
            list.innerHTML = '<div style="text-align:center;font-size:12px;opacity:0.4;padding:6px 0;">no games yet</div>';
            return;
        }
        var html = '';
        rooms.forEach(function(r) {
            var taken = (r.hostPlayerIds || []).join(', ') || '(host-only)';
            html += '<div class="net-room-row button" onclick="OiSving.Menu.joinRoomCode(\'' + r.code + '\')">'
                + '<span class="net-room-code">' + r.code + '</span>'
                + '<span class="net-room-meta">' + taken + ' · ' + (r.joinerCount || 0) + ' joined</span>'
                + '</div>';
        });
        list.innerHTML = html;
    },

    joinRoomCode: function(code) {
        if (!OiSving.Net || !OiSving.Net.join) return;
        OiSving.Net.join(String(code).toUpperCase()).then(function() {
            document.getElementById('net-status').innerText = 'Joined ' + code;
            OiSving.Net.showWaitingForHost && OiSving.Net.showWaitingForHost();
            OiSving.Menu.refreshStartGameButton();
        }).catch(function(err) {
            document.getElementById('net-status').innerText = 'Join failed: ' + err.message;
        });
    },

    onHostGameClicked: function() {
        if (!OiSving.Net || !OiSving.Net.host) return;
        OiSving.Net.host().then(function(c) {
            document.getElementById('net-status').innerText = 'Room: ' + c;
            OiSving.Menu.refreshStartGameButton();
            OiSving.Menu.refreshAvailableRooms();
        }).catch(function(err) {
            document.getElementById('net-status').innerText = 'Host failed: ' + err.message;
        });
    },

    onJoinGameClicked: function() {
        var c = prompt('Room code');
        if (!c) return;
        OiSving.Menu.joinRoomCode(c);
    },

    onStartGameClicked: function() {
        var btn = document.getElementById('start-game');
        if (btn && btn.classList.contains('disabled')) return;
        OiSving.Menu.onSpaceDown();
    },

    lockRemoteColor: function(playerId) {
        OiSving.Menu.remoteTakenIds[playerId] = true;
        // Force-deactivate locally if the local user already had it picked,
        // since the host's roster wins.
        if (OiSving.getPlayer(playerId) && OiSving.getPlayer(playerId).isActive && OiSving.getPlayer(playerId).isActive()) {
            OiSving.Menu.deactivatePlayer(playerId);
        }
        u.addClass('remote-taken', playerId);
    },

    unlockRemoteColor: function(playerId) {
        delete OiSving.Menu.remoteTakenIds[playerId];
        u.removeClass('remote-taken', playerId);
    },

    isRemoteTaken: function(playerId) {
        return OiSving.Menu.remoteTakenIds[playerId] === true;
    },
        
    initPlayerMenu: function() {
        var playerHTML = '';
        
        OiSving.players.forEach(function(player) {
            playerHTML += player.renderMenuItem();
        });
        
        document.getElementById('menu-players-list').innerHTML += playerHTML;
    },
    
    addWindowListeners: function() {
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        window.addEventListener('keydown', this.boundOnKeyDown, false);
    },

    addMouseListeners: function() {
        var playerItems = document.getElementById('menu-players-list').children;

        for (var i=0; i < playerItems.length; i++) {
            playerItems[i].addEventListener('click', this.onPlayerItemClicked, false);
        }
    },

    initMenuMusic: function() {
        this.audioPlayer = OiSving.Sound.getAudioPlayer();
        this.audioPlayer.play('menu-music', {loop: true, background: true, fade: 2000, volume: 1});
    },
    
    removeWindowListeners: function() {
        window.removeEventListener('keydown', this.boundOnKeyDown, false);  
    },

    onPlayerItemClicked: function(event) {
        OiSving.Menu.audioPlayer.play('menu-navigate');
        OiSving.Menu.togglePlayerActivation(this.id);
    },
    
    onKeyDown: function(event) {
        if (event.metaKey) {
            return; //Command or Ctrl pressed
        }

        if (OiSving.Menu.scrollKeys.indexOf(event.key) >= 0) {
            event.preventDefault(); //prevent page scrolling
        }

        if (event.keyCode === 32) {
            OiSving.Menu.onSpaceDown();
        }

        OiSving.players.forEach(function(player) {
            if ( player.isKeyLeft(event.keyCode) ) {
                OiSving.Menu.activatePlayer(player.getId());
                OiSving.Menu.audioPlayer.play('menu-navigate');
            } else if ( player.isKeyRight(event.keyCode) ) {
                OiSving.Menu.deactivatePlayer(player.getId());
                OiSving.Menu.audioPlayer.play('menu-navigate');
            } else if ( player.isKeySuperpower(event.keyCode) ) {
                OiSving.Menu.nextSuperpower(player.getId());
                OiSving.Menu.audioPlayer.play('menu-navigate');
            }
        });
    },
    
    buildGameCurves: function() {
        OiSving.Game.curves = [];

        var localPlayerIds = [];
        var remotePlayerIds = [];
        var playerIds = [];

        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive()) {
            localPlayerIds = OiSving.Net.getLocalPlayerIds ? OiSving.Net.getLocalPlayerIds() : [];
            remotePlayerIds = OiSving.Net.getRemotePlayerIds ? OiSving.Net.getRemotePlayerIds() : [];
            playerIds = localPlayerIds.concat(remotePlayerIds).filter(function(id, index, arr) {
                return arr.indexOf(id) === index;
            });
            // Lockstep determinism: every peer must iterate curves in the
            // same order so global RNG draws (spawn x/y, initial angle,
            // hole interval randomness, RANDOM superpower picker) happen
            // in the same sequence on host and joiner. Local-vs-remote
            // ordering would put host's local players first on host but
            // last on joiner — sort lexically by playerId instead.
            playerIds.sort();
        } else {
            OiSving.players.forEach(function(player) {
                if ( player.isActive() ) playerIds.push(player.getId());
            });
        }

        playerIds.forEach(function(playerId) {
            var player = OiSving.getPlayer(playerId);
            if (!player) return;
            player.isLocal = remotePlayerIds.indexOf(playerId) < 0 || localPlayerIds.indexOf(playerId) >= 0;
            OiSving.Game.curves.push(
                new OiSving.Curve(player, OiSving.Game, OiSving.Field, OiSving.Config.Curve, OiSving.Sound.getAudioPlayer())
            );
        });

        return OiSving.Game.curves.length;
    },

    showNotEnoughPlayersError: function() {
        OiSving.Game.curves = [];
        OiSving.Menu.audioPlayer.play('menu-error', {reset: true});

        u.addClass('shake', 'menu');

        setTimeout(function() {
            u.removeClass('shake', 'menu');
        }, 450); //see Sass shake animation in _mixins.scss
    },

    startGameFromMenu: function() {
        OiSving.Field.init();
        OiSving.Menu.audioPlayer.pause('menu-music', {fade: 1000});
        OiSving.Game.startGame();

        u.addClass('hidden', 'layer-menu');
        u.removeClass('hidden', 'layer-game');
    },

    startNetworkGameFromRoster: function() {
        if (OiSving.Game.curves.length === 0) {
            this.buildGameCurves();
        }
        if (OiSving.Game.curves.length <= 1) {
            return false;
        }
        this.startGameFromMenu();
        return true;
    },

    onSpaceDown: function() {
        // In a joined multiplayer session only the host transitions menu ->
        // game. The joiner enters the game screen via the round-start
        // listener wired in OiSving.Game.init, never via its own keyboard.
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && !OiSving.Net.isHost()) {
            return;
        }

        this.buildGameCurves();

        if (OiSving.Game.curves.length <= 1) {
            this.showNotEnoughPlayersError();
            return; //not enough players are ready
        }

        this.startGameFromMenu();
    },

    onNextSuperPowerClicked: function(event, playerId) {
        event.stopPropagation();
        OiSving.Menu.audioPlayer.play('menu-navigate');
        OiSving.Menu.nextSuperpower(playerId);
    },

    onPreviousSuperPowerClicked: function(event, playerId) {
        event.stopPropagation();
        OiSving.Menu.audioPlayer.play('menu-navigate');
        OiSving.Menu.previousSuperpower(playerId);
    },

    nextSuperpower: function(playerId) {
        var player = OiSving.getPlayer(playerId);
        var count = 0;
        var superpowerType = '';

        for (var i in OiSving.Superpowerconfig.types) {
            count++;
            if ( !(OiSving.Superpowerconfig.types[i] === player.getSuperpower().getType() ) ) continue;

            if ( Object.keys(OiSving.Superpowerconfig.types).length === count) {
                superpowerType = Object.keys(OiSving.Superpowerconfig.types)[0];
            } else {
                superpowerType = Object.keys(OiSving.Superpowerconfig.types)[count];
            }

            break;
        }

        player.setSuperpower( OiSving.Factory.getSuperpower(superpowerType) );
    },

    previousSuperpower: function(playerId) {
        var player = OiSving.getPlayer(playerId);
        var count = 0;
        var superpowerType = '';

        for (var i in OiSving.Superpowerconfig.types) {
            count++;
            if ( !(OiSving.Superpowerconfig.types[i] === player.getSuperpower().getType() ) ) continue;

            if ( 1 === count) {
                superpowerType = Object.keys(OiSving.Superpowerconfig.types)[Object.keys(OiSving.Superpowerconfig.types).length - 1];
            } else {
                superpowerType = Object.keys(OiSving.Superpowerconfig.types)[count - 2];
            }

            break;
        }

        player.setSuperpower( OiSving.Factory.getSuperpower(superpowerType) );
    },

    activatePlayer: function(playerId) {
        if ( OiSving.Menu.isRemoteTaken(playerId) ) return;
        if ( OiSving.getPlayer(playerId).isActive() ) return;

        // Net mode: send the claim through the host. Optimistic local
        // update — if the host rejects (already taken, not allowed) the
        // next roster broadcast revokes the activation via syncLocalActivation.
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive()) {
            OiSving.Net.claimPlayer(playerId);
        }

        OiSving.getPlayer(playerId).setIsActive(true);

        u.removeClass('inactive', playerId);
        u.addClass('active', playerId);
        OiSving.Menu.refreshStartGameButton();
    },

    deactivatePlayer: function(playerId) {
        if ( !OiSving.getPlayer(playerId).isActive() ) return;

        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive()) {
            OiSving.Net.releasePlayer(playerId);
        }

        OiSving.getPlayer(playerId).setIsActive(false);

        u.removeClass('active', playerId);
        u.addClass('inactive', playerId);
        OiSving.Menu.refreshStartGameButton();
    },

    togglePlayerActivation: function(playerId) {
        if ( OiSving.Menu.isRemoteTaken(playerId) ) return;
        if ( OiSving.getPlayer(playerId).isActive() ) {
            OiSving.Menu.deactivatePlayer(playerId);
        } else {
            OiSving.Menu.activatePlayer(playerId);
        }
    },

    requestFullScreen: function() {
        document.body.webkitRequestFullScreen();
    },
};
