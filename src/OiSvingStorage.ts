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

type StorageArea = 'localStorage' | 'sessionStorage'

function area(name: StorageArea | undefined, fallback: StorageArea): Storage {
    return window[name ?? fallback]
}

OiSving.Storage = {
    defaultStorage: 'localStorage' as StorageArea,

    get(itemId: string, storage?: StorageArea) {
        const raw = area(storage, this.defaultStorage).getItem(itemId)
        return raw === null ? null : JSON.parse(raw)
    },

    set(itemId: string, item: unknown, storage?: StorageArea) {
        area(storage, this.defaultStorage).setItem(itemId, JSON.stringify(item))
    },

    remove(itemId: string, storage?: StorageArea) {
        area(storage, this.defaultStorage).removeItem(itemId)
    },

    has(itemId: string, storage?: StorageArea) {
        return area(storage, this.defaultStorage).getItem(itemId) !== null
    },

    clear(storage?: StorageArea) {
        area(storage, this.defaultStorage).clear()
    },

    // One-shot read with legacy-key fallback. If the new key is missing but the
    // legacy key exists in the same storage area, copy it forward and remove the
    // old key. Existing users keep their settings across the rebrand.
    getWithMigration(newKey: string, oldKey: string, storage?: StorageArea) {
        if (this.has(newKey, storage)) {
            return this.get(newKey, storage)
        }
        if (this.has(oldKey, storage)) {
            const legacy = this.get(oldKey, storage)
            this.set(newKey, legacy, storage)
            this.remove(oldKey, storage)
            return legacy
        }
        return null
    },
}
