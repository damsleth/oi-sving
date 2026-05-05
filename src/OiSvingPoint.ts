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

OiSving.Point = function(posX, posY) {

    this.getPosX = function(precision) {
        if ( precision === undefined ) return posX;
        return u.round(posX, precision); 
    };
    
    this.getPosY = function(precision) {
        if ( precision === undefined ) return posY;
        return u.round(posY, precision); 
    };

};

OiSving.Point.prototype.equals = function(point) {
    return point.getPosX(0) === this.getPosX(0) && point.getPosY(0) === this.getPosY(0);
};

OiSving.Point.prototype.clone = function() {
    return new OiSving.Point(this.getPosX(), this.getPosY());
};
