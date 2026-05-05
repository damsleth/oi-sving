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

OiSving.Factory = {

    getSuperpower: function(type) {
        if ( !OiSving.Superpowerconfig.hasOwnProperty(type) ) throw 'Superpower type ' + type + ' is not yet registered.';
        
        var hooks = OiSving.Superpowerconfig[type].hooks;
        var act = OiSving.Superpowerconfig[type].act;
        var init = OiSving.Superpowerconfig[type].init;
        var close = OiSving.Superpowerconfig[type].close;
        var helpers = {};
        var audioPlayer = OiSving.Sound.getAudioPlayer();

        for (var attribute in OiSving.Superpowerconfig[type].helpers) {
            if (OiSving.Superpowerconfig[type].helpers.hasOwnProperty(attribute)) {
                helpers[attribute] = OiSving.Superpowerconfig[type].helpers[attribute];
            }
        }

        return new OiSving.Superpower(hooks, act, helpers, type, init, close, audioPlayer);
    }

};