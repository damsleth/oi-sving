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

OiSving.Player = function(id, keyLeft, keyRight, keySuperpower) {

    var points = 0;
    var superpower = OiSving.Factory.getSuperpower(OiSving.Superpowerconfig.types.NO_SUPERPOWER);
    var superPowerElement = null;
    var isActive = false;
    var color = null;

    // Multiplayer flags. Defaults match single-player and split-keyboard:
    // every player on this peer is local and owns its own keyboard inputs.
    // Remote players (driven by network input bits only) get isLocal=false
    // and a peerId pointing at their owning peer.
    this.isLocal = true;
    this.peerId = null;
    
    this.incrementPoints = function() {
        points++;
    };

    this.setSuperpower = function(newSuperpower) {
        superpower = newSuperpower;

        if ( superPowerElement === null ) {
            superPowerElement = document.getElementById(this.getId() + '-superpower');
        }

        superPowerElement.innerHTML = this.getSuperpower().getLabel();
    };

    this.setColor = function(newColor) { color = newColor; };
    this.setIsActive = function(newIsActive) { isActive = newIsActive; };
    
    this.getPoints = function() { return points; };
    this.getId = function() { return id; };
    this.getColor = function() { return color === null ? OiSving.Theming.getThemedValue('players', id) : color };
    this.getSuperpower = function() { return superpower; };
    this.getKeyLeft = function() { return keyLeft; };
    this.getKeyRight = function() { return keyRight; };
    this.getKeySuperpower = function() { return keySuperpower; };
    this.isActive = function() { return isActive; };

};

OiSving.Player.prototype.renderMenuItem = function() {
    return  '<div id="' + this.getId() + '" class="player inactive ' + this.getId() +'">' +
                '<div class="title light"><h2>' + this.getId() + '</h2></div>' +
                '<div class="key left light"><div>' + this.getKeyLeftChar() + '</div></div>' +
                '<div class="key right light"><div>' + this.getKeyRightChar() + '</div></div>' +
                '<div class="superpower">' +
                    '<div class="key light">' + this.getKeySuperpowerChar() + '</div>' +
                    '<div class="superpowerType light">' +
                        '<div class="left" onclick="OiSving.Menu.onPreviousSuperPowerClicked(event, \'' + this.getId() + '\')"><i class="arrow arrow-left"></i></div>' +
                        '<div class="superpowers">' +
                            '<div id="' + this.getId() + '-superpower">' + this.getSuperpower().getLabel() + '</div>' +
                        '</div> ' +
                        '<div class="right" onclick="OiSving.Menu.onNextSuperPowerClicked(event, \'' + this.getId() + '\')"><i class="arrow arrow-right"></i></div>' +
                    '</div> ' +
                '</div>' +
                '<div class="clear"></div>' +
            '</div>';
};

OiSving.Player.prototype.renderScoreItem = function() {
    return  '<div class="active ' + this.getId() + '">' +
                '<div class="title"><h2>' + this.getId() + '</h2></div>' +
                '<div class="points">' + this.getPoints() + '</div>' +
                '<div class="clear"></div>' +
                '<div class="superpowers">' +
                    this.renderNumberOfSuperPowers() +
                    '<span class="superpower-label">' + this.getSuperpower().getLabel() + '</span>' +
                '</div>' +
            '</div>';
};

OiSving.Player.prototype.renderNumberOfSuperPowers = function() {
    var superpowers = '';

    for (var i=0; i < OiSving.Config.Superpower.maxSuperpowers; i++ ) {
        superpowers += '<div class="superpowerCircle' + (i < this.getSuperpower().getCount() ? ' ' + this.getId() : '') + '"></div>';
    }

    return superpowers;
};

OiSving.Player.prototype.isKeyRight = function(keyCode) {
    return this.getKeyRight() === keyCode;
};
    
OiSving.Player.prototype.isKeyLeft = function(keyCode) {
    return this.getKeyLeft() === keyCode;
};

OiSving.Player.prototype.isKeySuperpower = function(keyCode) {
    return this.getKeySuperpower() === keyCode;
};

OiSving.Player.prototype.getKeyLeftChar = function() {
    if ( this.isArrowKey(this.getKeyLeft()) ) return this.arrowKeyChar(this.getKeyLeft());

    return String.fromCharCode(this.getKeyLeft());
};

OiSving.Player.prototype.getKeyRightChar = function() {
    if ( this.isArrowKey(this.getKeyRight()) ) return this.arrowKeyChar(this.getKeyRight());

    return String.fromCharCode(this.getKeyRight());
};

OiSving.Player.prototype.getKeySuperpowerChar = function() {
    if ( this.isArrowKey(this.getKeySuperpower()) ) return this.arrowKeyChar(this.getKeySuperpower());

    return String.fromCharCode(this.getKeySuperpower());
};

OiSving.Player.prototype.isArrowKey = function(keyCode) {
    return keyCode === 37 || keyCode === 39 || keyCode === 40;
};

OiSving.Player.prototype.arrowKeyChar = function(keyCode) {
    switch (keyCode) {
        case 37:
            return '<span class="arrow arrow-left"></span>';
            break;
        case 39:
            return '<span class="arrow arrow-right"></span>';
            break;
        case 40:
            return '<span class="arrow arrow-down"></span>';
            break;
        default:
            return '';
    }
};
