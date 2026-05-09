// @ts-nocheck -- legacy strict-parity migration; tighten types per file
/**
 *
 * Program:     OiSving (forked from Kurve by Markus Mächler)
 * Author:      Markus Mächler, marmaechler@gmail.com
 * License:     http://www.gnu.org/licenses/gpl.txt
 * Link:        http://achtungkurve.com (upstream)
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
import { isMobile } from './mobile-detect'

OiSving.isMobile = isMobile

OiSving.init = function () {
  if (u.isSafari()) u.addClass('is-safari', 'app')
  if (u.isIE()) u.addClass('is-ie', 'app')
  if (isMobile()) u.addClass('is-mobile', 'app')

  OiSving.Theming.init()
  OiSving.Sound.init()
  OiSving.initPlayers()
  OiSving.Menu.init()
  OiSving.Game.init()
  OiSving.Lightbox.init()
  if (OiSving.Toasts && OiSving.Toasts.init) OiSving.Toasts.init()
  if (OiSving.FocusIndicator && OiSving.FocusIndicator.init) OiSving.FocusIndicator.init()
  if (OiSving.TouchControls && OiSving.TouchControls.init) OiSving.TouchControls.init()

  u.removeClass('hidden', 'app')
}

OiSving.initPlayers = function () {
  OiSving.Config.Players.forEach(function (playerConfig: { id: string; keyLeft: number; keyRight: number; keySuperpower: number }) {
    const player = new OiSving.Player(playerConfig.id, playerConfig.keyLeft, playerConfig.keyRight, playerConfig.keySuperpower)
    OiSving.players.push(player)
    OiSving.playersById[player.getId()] = player
  })
}

OiSving.getPlayer = function (playerId: string) {
  return OiSving.playersById[playerId]
}

OiSving.reload = function () {
  location.reload()
}

OiSving.onUnload = function () {}
