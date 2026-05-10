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

OiSving.Theming = {
    currentTheme: 'dark',

    init: function() {
        var migrated = OiSving.Storage.getWithMigration('oisving.theme', 'kurve.theme');
        if (migrated !== null) {
            this.currentTheme = migrated;
        } else {
            OiSving.Storage.set('oisving.theme', this.currentTheme);
        }

        OiSving.Theming.renderToggleLabel();

        u.addClass(this.currentTheme + '-theme', 'app');
    },

    // Glyph reflects the action the button performs - moon when the
    // current theme is light (tap to go dark), sun when dark (tap to
    // go light). Plain unicode so no icon-font dependency.
    renderToggleLabel: function() {
        var el = document.getElementById('change-theme');
        if (!el) return;
        el.textContent = this.currentTheme === 'default' ? '☾' : '☀';
        el.setAttribute('title', this.currentTheme === 'default' ? 'Switch to dark theme' : 'Switch to light theme');
        el.setAttribute('aria-label', el.getAttribute('title') || '');
    },

    getThemedValue: function(section, value) {
        if (OiSving.Config['Theming'][this.currentTheme] !== undefined) {
            return OiSving.Config['Theming'][this.currentTheme][section][value];
        }
    },

    changeTheme: function(theme) {
        u.removeClass(this.currentTheme + '-theme', 'app');
        u.addClass(theme + '-theme', 'app');

        this.currentTheme = theme;
        OiSving.Storage.set('oisving.theme', this.currentTheme);
    },

    toggleTheme: function() {
        this.changeTheme(this.currentTheme === 'default' ? 'dark' : 'default');
        this.renderToggleLabel();
    },
};
