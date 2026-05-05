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

function paq(): unknown[] | null {
    return Array.isArray(window._paq) ? (window._paq as unknown[]) : null
}

OiSving.Piwik = {

    isEnabled() {
        return !!(OiSving.Config
            && OiSving.Config.Analytics
            && OiSving.Config.Analytics.enabled
            && paq() !== null)
    },

    trackPageVariable(index: number, name: string, value: string) {
        if (!OiSving.Piwik.isEnabled()) return
        const q = paq(); if (!q) return
        q.push(['setCustomVariable', index, name, value, 'page'])
    },

    trackPageView(title?: string) {
        if (!OiSving.Piwik.isEnabled()) return
        const q = paq(); if (!q) return
        q.push(['setDocumentTitle', title])
        q.push(['trackPageView'])
    },
}