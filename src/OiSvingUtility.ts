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

OiSving.Utility = function(element: unknown) {
    if ( element instanceof String ) {}

    return new OiSving.Utility.Element(element);
};

OiSving.Utility.Element = function (this: { element: unknown }, element: unknown) {
    this.element = element
}

OiSving.Utility.round = function (number: number, digitsAfterComa: number) {
    return Math.round(number * Math.pow(10, digitsAfterComa)) / Math.pow(10, digitsAfterComa)
}

OiSving.Utility.addClass = function (className: string, elementId: string) {
    const element = document.getElementById(elementId)
    if (element === null) return false
    element.classList.add(className)
    return undefined
}

OiSving.Utility.removeClass = function (className: string, elementId: string) {
    const element = document.getElementById(elementId)
    if (element === null) return false
    element.classList.remove(className)
    return undefined
}

OiSving.Utility.setClassName = function (className: string, elementId: string) {
    const element = document.getElementById(elementId)
    if (element === null) return false
    element.className = className
    return undefined
}

OiSving.Utility.hasClass = function (className: string, elementId: string) {
    const element = document.getElementById(elementId)
    if (element === null) return false
    return element.classList.contains(className)
}

OiSving.Utility.interpolateTwoPoints = function (fromPointX: number, fromPointY: number, toPointX: number, toPointY: number) {
    const interpolatedPoints: Record<number, Record<number, boolean>> = {}
    const dX = toPointX - fromPointX
    const dY = toPointY - fromPointY
    const maxD = Math.max(Math.abs(dX), Math.abs(dY), 1)
    const stepX = dX / maxD
    const stepY = dY / maxD

    for (let i = 0; i < maxD; i++) {
        const posX = fromPointX + i * stepX
        const posY = fromPointY + i * stepY
        u.addPointToMap(interpolatedPoints, posX, posY)
    }

    return interpolatedPoints
}

OiSving.Utility.addPointToMap = function (array: Record<number, Record<number, boolean>>, pointX: number, pointY: number) {
    const pointX0 = u.round(pointX, 0)
    if (array[pointX0] === undefined) array[pointX0] = {}
    array[pointX0][u.round(pointY, 0)] = true
}

OiSving.Utility.stringToHex = function (s: string) {
    return parseInt(s.substring(1), 16)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
OiSving.Utility.merge = function (...args: any[]) {
    const base = args[0]
    for (let i = 1; i < args.length; i++) {
        for (const j in args[i]) {
            base[j] = args[i][j]
        }
    }
    return base
}

OiSving.Utility.isSafari = function () {
    return !!navigator.userAgent.match(/Version\/[\d\.]+.*Safari/)
}

OiSving.Utility.isIE = function () {
    const userAgent = window.navigator.userAgent
    return userAgent.indexOf('MSIE ') > 0 || userAgent.indexOf('Trident/') > 0
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
OiSving.Utility.debounce = function (debouncedFunction: (...args: any[]) => void, timeout: number) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (this: unknown, ...args: any[]) {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        timeoutId = setTimeout(() => {
            debouncedFunction.apply(this, args)
        }, timeout)
    }
}

export const u = OiSving.Utility
// Mirror legacy `window.u` global so any code path not yet migrated to ESM
// imports still resolves.
window.u = OiSving.Utility
