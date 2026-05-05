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
    
    init: function() {
        this.initPlayerMenu();
        this.addWindowListeners();
        this.addMouseListeners();
        this.initMenuMusic();
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
        if ( OiSving.getPlayer(playerId).isActive() ) return;

        OiSving.getPlayer(playerId).setIsActive(true);

        u.removeClass('inactive', playerId);
        u.addClass('active', playerId);
    },

    deactivatePlayer: function(playerId) {
        if ( !OiSving.getPlayer(playerId).isActive() ) return;

        OiSving.getPlayer(playerId).setIsActive(false);

        u.removeClass('active', playerId);
        u.addClass('inactive', playerId);
    },

    togglePlayerActivation: function(playerId) {
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
