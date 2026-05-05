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

'use strict';

OiSving.Storage = {
    defaultStorage: 'localStorage',
    
    get: function(itemId, storage) {
        if (storage === undefined) {
            storage = this.defaultStorage;
        }

        return JSON.parse(window[storage].getItem(itemId));
    },

    set: function(itemId, item, storage) {
        if (storage === undefined) {
            storage = this.defaultStorage;
        }

        window[storage].setItem(itemId, JSON.stringify(item));
    },

    remove: function(itemId, storage) {
        if (storage === undefined) {
            storage = this.defaultStorage;
        }

        window[storage].removeItem(itemId);
    },

    has: function(itemId, storage) {
        if (storage === undefined) {
            storage = this.defaultStorage;
        }

        return window[storage].getItem(itemId) !== null;
    },

    clear: function(storage) {
        if (storage === undefined) {
            storage = this.defaultStorage;
        }

        window[storage].clear();
    },

    // One-shot read with legacy-key fallback. If the new key is missing but the
    // legacy key exists in the same storage area, copy it forward and remove the
    // old key. Existing users keep their settings across the rebrand.
    getWithMigration: function(newKey, oldKey, storage) {
        if (storage === undefined) {
            storage = this.defaultStorage;
        }

        if (this.has(newKey, storage)) {
            return this.get(newKey, storage);
        }

        if (this.has(oldKey, storage)) {
            var legacy = this.get(oldKey, storage);
            this.set(newKey, legacy, storage);
            this.remove(oldKey, storage);
            return legacy;
        }

        return null;
    }
};
