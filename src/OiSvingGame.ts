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
import {
    INPUT_LEFT,
    INPUT_RIGHT,
    INPUT_SUPERPOWER,
    getInputProvider,
    installKeyboardProvider,
} from './input-provider'

OiSving.Game = {    
    
    runIntervalId:          null,
    fps:                    null,
    intervalTimeOut:        null,
    maxPoints:              null,
        
    keysDown:               {},
    isRunning:              false,
    curves:                 [],
    runningCurves:          {},
    players:                [],
    deathMatch:             false,
    isPaused:               false,
    isRoundStarted:         false,
    lastHostStateFrame:     0,
    playerScoresElement:    null,
    isGameOver:             false,
    CURRENT_FRAME_ID:       0,
    
    init: function() {
        this.fps = OiSving.Config.Game.fps;
        this.intervalTimeOut = Math.round(1000 / this.fps);
        this.playerScoresElement = document.getElementById('player-scores');

        // Single-player + split-keyboard keep their snappy "no input delay"
        // feel because the keyboard provider polls keysDown directly. When
        // OiSving.Net.startRound() runs, that swaps in the network provider
        // and applies INPUT_DELAY_FRAMES to local AND remote players for
        // lockstep symmetry.
        installKeyboardProvider(this);

        if (OiSving.Net && OiSving.Net.on) {
            OiSving.Net.on('round-start', function() {
                if (OiSving.Net.isHost && OiSving.Net.isHost()) return;
                if (OiSving.Game.isRoundStarted || OiSving.Game.isRunning) return;

                // Host kicked the round off — joiner can drop the
                // "waiting for host" overlay and follow into the game.
                OiSving.Net.hideWaitingForHost && OiSving.Net.hideWaitingForHost();

                if (OiSving.Game.curves.length === 0) {
                    var didStartGame = OiSving.Menu.startNetworkGameFromRoster && OiSving.Menu.startNetworkGameFromRoster();
                    if (!didStartGame) return;
                }

                OiSving.Game.startNewRound();
            });

            // Joiner mirrors host pause/unpause. Host never receives these
            // events because broadcastPause/Unpause skip the local emit;
            // host transitions are driven directly by togglePause.
            OiSving.Net.on('pause', function() {
                if (OiSving.Net.isHost && OiSving.Net.isHost()) return;
                OiSving.Game.doPause();
            });
            OiSving.Net.on('unpause', function() {
                if (OiSving.Net.isHost && OiSving.Net.isHost()) return;
                OiSving.Game.endPause();
            });

            // Joiner-only: react to the explicit 'host-gone' signal
            // (server fanout when the host's WS actually closes), not
            // to any 'connection-state' = 'closed'. The signaling
            // server idle-GCs rooms after 60s of no signaling traffic,
            // so a long round that's already past the WebRTC handshake
            // would receive an idle close mid-game — we'd kill the
            // round prematurely. host-gone is the host-actually-left
            // signal.
            OiSving.Net.on('host-gone', function() {
                if (OiSving.Net.isHost && OiSving.Net.isHost()) return;
                if (!OiSving.Game.isRoundStarted && !OiSving.Game.isRunning) return;

                OiSving.Game.stopRun();
                OiSving.Game.isRoundStarted = false;
                OiSving.Lightbox.show(
                    '<h2>Host disconnected</h2>' +
                    '<p style="opacity:0.75;margin:8px 0 16px;">The host left or lost connection. The round cannot continue.</p>' +
                    '<a href="#" onclick="OiSving.reload(); return false;" class="button">Back to menu</a>'
                );
            });
        }

        this.Audio.init();
    },

    run: function() {
        requestAnimationFrame(this.drawFrame.bind(this));
    },

    // Sample the local keyboard for every running curve whose player is
    // local, build the bit field, and submit it through the active input
    // provider. KeyboardInputProvider.submit is a no-op (keysDown is the
    // source of truth in single-player). NetInputProvider.submit schedules
    // the bits at frameId + inputDelayFrames AND broadcasts to peers.
    sampleAndSubmitLocalInputs: function(frameId) {
        var provider = getInputProvider();
        for (var pid in this.runningCurves) {
            var list = this.runningCurves[pid];
            if (!list || list.length === 0) continue;
            var curve = list[0];
            var player = curve.getPlayer();
            // A player without an explicit isLocal flag is treated as local
            // — that covers single-player, split-keyboard, and the host's
            // own players in network rounds.
            if (player.isLocal === false) continue;
            var bits = 0;
            if (this.isKeyDown(player.getKeyLeft())) bits |= INPUT_LEFT;
            if (this.isKeyDown(player.getKeyRight())) bits |= INPUT_RIGHT;
            if (this.isKeyDown(player.getKeySuperpower())) bits |= INPUT_SUPERPOWER;
            provider.submit(frameId, player.getId(), bits);
        }
    },

    // Periodic state hash gossip. Runs every Config.Net.stateHashIntervalFrames
    // (default 60). Hashes arena dims plus each curve's (x, y, angle,
    // holeCountDown, running/dead) tuple so divergence between peers is
    // visible within a second. Local-only games still compute the hash so
    // the cost is honest, but no broadcast happens because OiSving.Net
    // is not active.
    maybeGossipStateHash: function(frameId) {
        var cfg = OiSving.Config && OiSving.Config.Net;
        var intervalFrames = (cfg && cfg.stateHashIntervalFrames) || 60;
        if (frameId === 0 || frameId % intervalFrames !== 0) return;
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && !OiSving.Net.isHost()) return;
        var hash = this.computeStateHash();
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive()) {
            OiSving.Net.reportStateHash(frameId, hash);
        }
    },

    collectHostStateSnapshot: function(frameId) {
        var curves = this.curves.map(function(curve) {
            var playerId = curve.getPlayer().getId();
            var list = OiSving.Game.runningCurves[playerId] || [];
            return {
                playerId: playerId,
                alive: list.indexOf(curve) >= 0,
                x: curve.getPositionX(),
                y: curve.getPositionY(),
                nextX: curve.getNextPositionX(),
                nextY: curve.getNextPositionY(),
                angle: curve.getOptions().angle,
                holeCountDown: curve.getOptions().holeCountDown,
                invisible: curve.isInvisible()
            };
        });
        var players = this.players.map(function(player) {
            return {
                playerId: player.getId(),
                points: player.getPoints(),
                superpowerCount: player.getSuperpower().getCount()
            };
        });
        return {
            frameId: frameId,
            isRoundStarted: this.isRoundStarted,
            isRunning: this.isRunning,
            curves: curves,
            players: players
        };
    },

    applyHostStateSnapshot: function(snapshot) {
        if (!snapshot || snapshot.frameId <= this.lastHostStateFrame) return;
        this.lastHostStateFrame = snapshot.frameId;
        this.CURRENT_FRAME_ID = snapshot.frameId;

        if (Array.isArray(snapshot.players)) {
            // Track whether anything visible actually changed - if not we
            // skip the renderPlayerScores rebuild, which is the dominant
            // mobile cost (innerHTML reflow on every host frame turned
            // a 60fps round into a sub-30fps stutter on iOS Safari).
            var scoresChanged = false;
            snapshot.players.forEach(function(pState) {
                var player = OiSving.getPlayer(pState.playerId);
                if (!player) return;
                var pts = pState.points || 0;
                var sp = pState.superpowerCount || 0;
                if (player.getPoints && player.getPoints() !== pts) scoresChanged = true;
                var sup = player.getSuperpower && player.getSuperpower();
                if (sup && sup.getCount && sup.getCount() !== sp) scoresChanged = true;
                if (player.setPoints) player.setPoints(pts);
                if (sup && sup.setCount) sup.setCount(sp);
            });
            if (scoresChanged) this.scheduleRenderPlayerScores();
        }

        if (Array.isArray(snapshot.curves)) {
            snapshot.curves.forEach(function(cState) {
                var curve = null;
                for (var i = 0; i < OiSving.Game.curves.length; i++) {
                    if (OiSving.Game.curves[i].getPlayer().getId() === cState.playerId) {
                        curve = OiSving.Game.curves[i];
                        break;
                    }
                }
                if (!curve) return;

                if (cState.alive) {
                    if (!OiSving.Game.runningCurves[cState.playerId]) {
                        OiSving.Game.runningCurves[cState.playerId] = [curve];
                    }
                    var drawLine = OiSving.Game.isRoundStarted && snapshot.isRoundStarted;
                    curve.setPositionX(cState.x);
                    curve.setPositionY(cState.y);
                    curve.setNextPositionX(cState.nextX);
                    curve.setNextPositionY(cState.nextY);
                    curve.setAngle(cState.angle);
                    curve.getOptions().holeCountDown = cState.holeCountDown;
                    curve.setIsInvisible(!!cState.invisible);
                    if (drawLine) {
                        if (cState.invisible) {
                            OiSving.Field.drawLine('powerUp', cState.x, cState.y, cState.nextX, cState.nextY, '', curve);
                        } else {
                            OiSving.Field.drawLine('curve', cState.x, cState.y, cState.nextX, cState.nextY, curve.getPlayer().getColor(), curve);
                        }
                    }
                } else {
                    delete OiSving.Game.runningCurves[cState.playerId];
                }
            });
        }

        this.isRoundStarted = !!snapshot.isRoundStarted;
        if (!snapshot.isRunning && this.isRunning) {
            this.stopRun();
        }
    },

    // 32-bit FNV-1a over the canonical arena dims and each curve's
    // (round(x*100), round(y*100), round(angle*1e6), holeCountDown, running)
    // tuple. Integer-only quantization so floats don't drift across peers.
    computeStateHash: function() {
        var hash = 0x811c9dc5 >>> 0;
        function mix(n) {
            hash ^= (n >>> 0);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        var arena = OiSving.Field.getArenaSize ? OiSving.Field.getArenaSize() : { width: 0, height: 0 };
        mix(arena.width | 0);
        mix(arena.height | 0);
        // Stable iteration order across peers: lexical sort by playerId.
        var ids = Object.keys(this.runningCurves).sort();
        for (var k = 0; k < ids.length; k++) {
            var id = ids[k];
            var list = this.runningCurves[id];
            if (!list) continue;
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                mix(Math.round(c.getPositionX() * 100));
                mix(Math.round(c.getPositionY() * 100));
                mix(Math.round(c.getOptions().angle * 1e6));
                mix(c.getOptions().holeCountDown | 0);
                mix(1);
            }
        }
        return hash >>> 0;
    },

    drawFrame: function() {
        this.CURRENT_FRAME_ID++;

        // Lockstep step 1: collect this peer's local input for the frame
        // BEFORE the simulation reads inputs. With INPUT_DELAY_FRAMES > 0
        // the network provider schedules these bits to take effect later;
        // the keyboard provider treats submit as a no-op.
        this.sampleAndSubmitLocalInputs(this.CURRENT_FRAME_ID);

        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && !OiSving.Net.isHost()) {
            if (OiSving.Net.pruneInputs) {
                OiSving.Net.pruneInputs(this.CURRENT_FRAME_ID - this.fps);
            }
            return;
        }

        // Iterate in stable lexical order. drawNextFrame draws from the
        // global seeded RNG (hole interval reset, superpower hooks), so
        // every peer must visit curves in the same order to stay in
        // lockstep — `for (var i in obj)` is insertion-order, and
        // insertion order differs between host and joiner.
        var ids = Object.keys(this.runningCurves).sort();
        for (var k = 0; k < ids.length; k++) {
            var i = ids[k];
            for (var j = 0; this.runningCurves[i] && j < this.runningCurves[i].length; ++j) {
                this.runningCurves[i][j].drawNextFrame();
            }
        }

        // Lockstep step 2: drift detection + bounded buffer pruning.
        this.maybeGossipStateHash(this.CURRENT_FRAME_ID);
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && OiSving.Net.isHost() && OiSving.Net.broadcastHostState) {
            OiSving.Net.broadcastHostState(this.collectHostStateSnapshot(this.CURRENT_FRAME_ID));
        }
        if (OiSving.Net && OiSving.Net.pruneInputs) {
            // Keep one second of input history. Past that the deterministic
            // "last-known bits" fallback in the buffer is enough.
            OiSving.Net.pruneInputs(this.CURRENT_FRAME_ID - this.fps);
        }
    },
    
    addWindowListeners: function() {
        OiSving.Menu.removeWindowListeners();
        
        window.addEventListener('keydown', this.onKeyDown.bind(this));
        window.addEventListener('keyup', this.onKeyUp.bind(this));  
    },
    
    onKeyDown: function(event) {
        if (OiSving.Menu.scrollKeys.indexOf(event.key) >= 0) {
            event.preventDefault(); //prevent page scrolling
        }

        if ( event.keyCode === 32 ) {
            this.onSpaceDown();
        }

        this.keysDown[event.keyCode] = true;
    },
    
    onKeyUp: function(event) {
        delete this.keysDown[event.keyCode];
    },
    
    isKeyDown: function(keyCode) {
        return this.keysDown[keyCode] === true;
    },
    
    onSpaceDown: function() {
        // In a joined multiplayer session only the host can start, pause,
        // or unpause. Joiner space presses on the game screen are no-ops;
        // round-start, pause, and unpause arrive via OiSving.Net events.
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && !OiSving.Net.isHost()) {
            return;
        }

        if ( this.isGameOver ) return location.reload();
        if ( this.isRunning || this.isPaused ) return this.togglePause();
        if ( !this.isRoundStarted && !this.deathMatch) return this.startNewRound();
        if ( !this.isRoundStarted && this.deathMatch) return this.startDeathMatch();
    },

    onMenuButtonClicked: function() {
        // Mobile: the only way back to the room picker. Always honor the
        // tap; reload tears down the WS + WebRTC and the host's roster
        // converges on the next peer-left.
        if (typeof OiSving.isMobile === 'function' && OiSving.isMobile()) {
            OiSving.reload();
            return;
        }
        // Desktop joiners stay locked in to avoid an accidental leave -
        // host can always reload to end their own room.
        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && !OiSving.Net.isHost()) {
            return;
        }
        OiSving.reload();
    },

    togglePause: function() {
        if ( this.isPaused ) {
            this.endPause();
            // Host fans out unpause to every joiner so all peers resume in
            // the same tick. Joiner-side endPause runs through the
            // 'unpause' event listener in init, not here.
            if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && OiSving.Net.isHost()) {
                OiSving.Net.broadcastUnpause && OiSving.Net.broadcastUnpause();
            }
        } else {
            this.doPause();
            if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && OiSving.Net.isHost()) {
                OiSving.Net.broadcastPause && OiSving.Net.broadcastPause();
            }
        }
    },

    doPause: function() {
        if ( this.isPaused ) return;

        this.isPaused = true;
        this.Audio.pauseIn();
        this.stopRun();
        OiSving.Lightbox.show('<h2>Game is paused</h2>');
    },

    endPause: function() {
        if ( !this.isPaused ) return;

        this.isPaused = false;
        this.Audio.pauseOut();
        OiSving.Lightbox.hide();
        this.startRun();
    },
    
    randomSeed: function() {
        var cryptoObj = window.crypto || window.msCrypto;
        if (cryptoObj && cryptoObj.getRandomValues) {
            var values = new Uint32Array(1);
            cryptoObj.getRandomValues(values);
            return values[0] >>> 0;
        }
        return Math.floor(Math.random() * 0x100000000) >>> 0;
    },

    startGame: function() {
        this.maxPoints = (this.curves.length - 1) * 10;

        this.addPlayers();
        this.addWindowListeners();
        this.renderPlayerScores();

        // Joiners cannot eject from the round, so visually disable the
        // back-to-menu button. Host keeps it as a force-quit affordance.
        var menuBtn = document.getElementById('button-menu');
        if (menuBtn) {
            if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && !OiSving.Net.isHost()) {
                menuBtn.classList.add('disabled');
                menuBtn.setAttribute('title', 'Joiners cannot leave a live game');
            } else {
                menuBtn.classList.remove('disabled');
                menuBtn.setAttribute('title', 'Go back to the menu');
            }
        }

        this.startNewRound.bind(this);
    },
    
    renderPlayerScores: function() {
        var playerHTML  = '';

        this.players.sort(this.playerSorting);
        this.players.forEach(function(player) { playerHTML += player.renderScoreItem() });

        this.playerScoresElement.innerHTML = playerHTML;
    },

    // Coalesce multiple snapshot-driven score updates into one rAF-aligned
    // DOM rebuild. Multiple snapshots arriving within a single repaint
    // (network bursts, mobile main-thread coalescing) all share one paint.
    _scoresRenderPending: false,
    scheduleRenderPlayerScores: function() {
        if (this._scoresRenderPending) return;
        this._scoresRenderPending = true;
        var self = this;
        var raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
            ? window.requestAnimationFrame.bind(window)
            : function(cb) { return setTimeout(cb, 16); };
        raf(function() {
            self._scoresRenderPending = false;
            self.renderPlayerScores();
        });
    },
    
    playerSorting: function(playerA, playerB) {
        return playerB.getPoints() - playerA.getPoints();
    },
    
    addPlayers: function() {
        OiSving.Game.curves.forEach(function(curve) {
            for (var i=0; i<OiSving.Config.Game.initialSuperpowerCount; i++) {
                curve.getPlayer().getSuperpower().incrementCount();
            }

            OiSving.Game.players.push( curve.getPlayer() );
        });
    },
    
    notifyDeath: function(curve) {
        var playerId = curve.getPlayer().getId();
        // Drop this curve.
        if ( this.runningCurves[playerId] === undefined ) return;

        this.runningCurves[playerId].splice(this.runningCurves[playerId].indexOf(curve), 1);

        if ( this.runningCurves[playerId].length === 0 ) {
            // Drop this player.
            delete this.runningCurves[curve.getPlayer().getId()];
            for (var i in this.runningCurves) {
                this.runningCurves[i][0].getPlayer().incrementPoints();
            }
        
            this.renderPlayerScores();

            if ( Object.keys(this.runningCurves).length === 2 ) {
                this.Audio.tension();
            }
        
            if ( Object.keys(this.runningCurves).length === 1 ) this.terminateRound();
        }
    },
    
    startNewRound: function() {
        this.isRoundStarted = true;
        this.CURRENT_FRAME_ID = 0;
        this.lastHostStateFrame = 0;

        if (OiSving.Net && OiSving.Net.isActive && OiSving.Net.isActive() && OiSving.Net.isHost && OiSving.Net.isHost()) {
            OiSving.Net.startRound(
                this.randomSeed(),
                OiSving.Config.Net.arenaWidth,
                OiSving.Config.Net.arenaHeight,
                this.CURRENT_FRAME_ID
            );
        }

        OiSving.Field.clearFieldContent();
        this.initRun();
        this.renderPlayerScores();

        setTimeout(this.startRun.bind(this), OiSving.Config.Game.startDelay);
        this.Audio.startNewRound();
    },
    
    startRun: function() {
        this.isRunning = true;
        this.runIntervalId = setInterval(this.run.bind(this), this.intervalTimeOut);
    },
    
    stopRun: function() {
        this.isRunning = false;
        clearInterval(this.runIntervalId);
    },
    
    initRun: function() {
        // Iterate curves in stable lexical order so every peer draws RNG
        // values for spawn/angle/hole-countdown in the same sequence.
        // setSimRng has already been applied (host: Net.startRound;
        // joiner: MSG_START dispatch) by the time this runs.
        var sorted = this.curves.slice().sort(function(a, b) {
            return a.getPlayer().getId() < b.getPlayer().getId() ? -1 : 1;
        });
        sorted.forEach(function(curve) {
            OiSving.Game.runningCurves[curve.getPlayer().getId()] = [curve];

            curve.setPosition(OiSving.Field.getRandomPosition().getPosX(), OiSving.Field.getRandomPosition().getPosY());
            curve.setRandomAngle();
            // resetHoleCountDown moved out of Curve constructor so the
            // first hole is randomized from the round seed, not from
            // whatever pre-seed rand state buildGameCurves caught.
            curve.resetHoleCountDown();
            curve.getPlayer().getSuperpower().init(curve);
            curve.drawCurrentPosition(OiSving.Field);
        });
    },
    
    terminateRound: function() {
        this.curves.forEach(function(curve) {
            curve.getPlayer().getSuperpower().close(curve);
        });

        if ( this.deathMatch ) {
            var curve = this.runningCurves[Object.keys(this.runningCurves)[0]][0];
            this.gameOver(curve.getPlayer());
        }

        this.isRoundStarted = false;
        this.stopRun();
        this.runningCurves  = {};
        this.incrementSuperpowers();
        this.Audio.terminateRound();
        OiSving.Field.resize();
        this.checkForWinner();
    },

    incrementSuperpowers: function() {
        var numberOfPlayers = this.players.length;

        if (numberOfPlayers === 2) {
            this.players[0].getSuperpower().incrementCount();
            this.players[1].getSuperpower().incrementCount();
        } else {
            for (var i in this.players) {
                if (parseInt(i) === 0) continue; // skip the leader

                this.players[i].getSuperpower().incrementCount();
            }

            // extra superpower for the loser
            this.players[numberOfPlayers - 1].getSuperpower().incrementCount();
        }
    },
    
    checkForWinner: function() {
        if ( this.deathMatch ) return;

        var winners = [];
        
        this.players.forEach(function(player) {
            if (player.getPoints() >= OiSving.Game.maxPoints) winners.push(player);
        });
        
        if (winners.length === 0) return;
        if (winners.length === 1) this.gameOver(winners[0]);
        if (winners.length  >  1) this.initDeathMatch(winners);
    },

    initDeathMatch: function(winners) {
        this.deathMatch = true;
        this.Audio.initDeathMatch();
        OiSving.Lightbox.show('<div class="deathmatch"><h1>DEATHMATCH!</h1></div>');

        var winnerCurves = [];
        this.curves.forEach(function(curve) {
            winners.forEach(function(player){
                if (curve.getPlayer() === player) {
                    winnerCurves.push(curve);
                    player.setColor(OiSving.Theming.getThemedValue('field', 'deathMatchColor'));
                }
            });
        });

        this.curves = winnerCurves;
    },
    
    startDeathMatch: function(winners) {
        OiSving.Lightbox.hide();
        this.startNewRound();
    },

    gameOver: function(winner) {
        this.isGameOver = true;

        this.Audio.gameOver();

        OiSving.Lightbox.show(
            '<h1 class="active ' + winner.getId() + '">' + winner.getId() + ' wins!</h1>' +
            '<a href="#" onclick="OiSving.reload(); return false;" title="Go back to the menu"  class="button">Start new game</a>'
        );
    },

    Audio: {
        stemLevel: 1,
        audioPlayer: null,
        defaultFadeTime: 1000,

        init: function() {
            this.audioPlayer = OiSving.Sound.getAudioPlayer();
        },

        startNewRound: function() {
            var startIn1Delay = OiSving.Config.Game.startDelay / 3;
            var startIn2Delay = 2 * startIn1Delay;
            var startOutDelay = 3 * startIn1Delay;

            setTimeout(this.audioPlayer.play.bind(this.audioPlayer, 'game-start-in', {reset: true}), startIn1Delay);
            setTimeout(this.audioPlayer.play.bind(this.audioPlayer, 'game-start-in', {reset: true}), startIn2Delay);
            setTimeout(function() {
                this.audioPlayer.play('game-start-out', {reset: true});
                this.setAllCurvesMuted('all', false);

                if ( OiSving.Game.deathMatch ) {
                    this.stemLevel = 3;
                    this.audioPlayer.play('game-music-stem-1', {fade: this.defaultFadeTime, volume: 1, background: true, loop: true, reset: true});
                    this.audioPlayer.play('game-music-stem-4', {fade: this.defaultFadeTime, volume: 1, background: true, loop: true, reset: true});
                } else {
                    this.stemLevel = 1;
                    this.audioPlayer.play('game-music-stem-1', {fade: this.defaultFadeTime, volume: 1, background: true, loop: true, reset: true});
                    this.audioPlayer.play('game-music-stem-2', {fade: this.defaultFadeTime, volume: 0, background: true, loop: true, reset: true});
                    this.audioPlayer.play('game-music-stem-3', {fade: this.defaultFadeTime, volume: 0, background: true, loop: true, reset: true});
                }
            }.bind(this), startOutDelay);
        },

        terminateRound: function() {
            this.pauseAllCurves('all', {reset: true});
            this.audioPlayer.pause('game-music-stem-1', {fade: this.defaultFadeTime, reset: true});
            this.audioPlayer.pause('game-music-stem-2', {fade: this.defaultFadeTime, reset: true});
            this.audioPlayer.pause('game-music-stem-3', {fade: this.defaultFadeTime, reset: true});
            this.audioPlayer.pause('game-music-stem-4', {fade: this.defaultFadeTime, reset: true});
            this.audioPlayer.play('game-end');
        },

        pauseIn: function() {
            this.audioPlayer.play('game-pause-in');
            this.setAllCurvesMuted('all', true);
            this.audioPlayer.setVolume('game-music-stem-1', {volume: 0.25, fade: this.defaultFadeTime});

            if (this.stemLevel > 1) {
                this.audioPlayer.setVolume('game-music-stem-2', {volume: 0, fade: this.defaultFadeTime});
            }

            if (this.stemLevel > 2) {
                this.audioPlayer.setVolume('game-music-stem-3', {volume: 0, fade: this.defaultFadeTime});
            }

            if (OiSving.Game.deathMatch) {
                this.audioPlayer.setVolume('game-music-stem-4', {volume: 0, fade: this.defaultFadeTime});
            }
        },

        pauseOut: function() {
            this.audioPlayer.play('game-pause-out');
            this.setAllCurvesMuted('all', false);
            this.audioPlayer.setVolume('game-music-stem-1', {volume: 1, fade: this.defaultFadeTime});

            if (this.stemLevel > 1) {
                this.audioPlayer.setVolume('game-music-stem-2', {volume: 0.5, fade: this.defaultFadeTime});
            }

            if (this.stemLevel > 2) {
                this.audioPlayer.setVolume('game-music-stem-3', {volume: 0.3, fade: this.defaultFadeTime});
            }

            if (OiSving.Game.deathMatch) {
                this.audioPlayer.setVolume('game-music-stem-4', {volume: 1, fade: this.defaultFadeTime});
            }
        },

        tension: function() {
            if (OiSving.Game.deathMatch) {
                return;
            }

            this.stemLevel = 3;
            this.audioPlayer.setVolume('game-music-stem-2', {volume: 0.5, fade: this.defaultFadeTime});
            this.audioPlayer.setVolume('game-music-stem-3', {volume: 0.3, fade: this.defaultFadeTime});
        },

        initDeathMatch: function() {
            this.audioPlayer.play('game-deathmatch');
        },

        gameOver: function() {
            this.audioPlayer.pause('all');
            this.audioPlayer.play('game-victory');
        },

        setAllCurvesMuted: function(soundKey, muted) {
            OiSving.Game.curves.forEach(function(curve) {
                curve.setMuted(soundKey, muted);
            });
        },

        pauseAllCurves: function(soundKey, options) {
            OiSving.Game.curves.forEach(function(curve) {
                curve.pause(soundKey, options);
            });
        }
    }
};
