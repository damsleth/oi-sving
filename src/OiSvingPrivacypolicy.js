/**
 *
 * Program:     OiSving (forked from Kurve by Markus Mächler)
 * Author:      Markus Mächler, marmaechler@gmail.com
 * License:     http://www.gnu.org/licenses/gpl.txt
 * Link:        http://achtungkurve.com (upstream)
 *
 * Copyright © 2014, 2015, 2018 Markus Mächler
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

OiSving.Privacypolicy = {
    init: function() {
        var accepted = OiSving.Storage.getWithMigration(
            'oisving.privacy-policy-accepted',
            'kurve.privacy-policy-accepted'
        );

        if (accepted === 'yes') {
            this.enableTracking();
            return;
        }

        this.showAcceptPrivacyPolicy();
    },

    showAcceptPrivacyPolicy: function() {
        OiSving.Lightbox.show(document.getElementById('privacy-policy-accept').innerHTML);
    },

    showPrivacyPolicy: function() {
        OiSving.Lightbox.show(document.getElementById('privacy-policy').innerHTML);

        setTimeout(function() {
            document.body.addEventListener('click', OiSving.Privacypolicy.onPrivacyPolicyClose, false);
        }, 500);

        var matomoOptOutIframe = document.getElementById('lightbox-content').querySelector('#privacy-policy-matomo-opt-out');

        if (matomoOptOutIframe && matomoOptOutIframe.dataset.src) {
            matomoOptOutIframe.src = matomoOptOutIframe.dataset.src;
        }
    },

    onPrivacyPolicyClose: function() {
        OiSving.Lightbox.hide();

        if (!OiSving.Storage.has('oisving.privacy-policy-accepted')) {
            OiSving.Privacypolicy.showAcceptPrivacyPolicy();
        }

        document.body.removeEventListener('click', OiSving.Privacypolicy.onPrivacyPolicyClose);
    },

    onPrivacyPolicyAccepted: function() {
        OiSving.Storage.set('oisving.privacy-policy-accepted', 'yes');
        OiSving.Lightbox.hide();

        this.enableTracking();
    },

    enableTracking: function() {
        var analytics = OiSving.Config && OiSving.Config.Analytics;
        if (!analytics || !analytics.enabled || !analytics.trackerUrl || !analytics.siteId) {
            return;
        }

        window._paq = window._paq || [];
        window._paq.push(['setDocumentTitle', 'Home']);
        window._paq.push(['trackPageView']);

        (function() {
            var u = analytics.trackerUrl.replace(/\/?$/, '/');
            window._paq.push(['setTrackerUrl', u + 'piwik.php']);
            window._paq.push(['setSiteId', analytics.siteId]);
            var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0];
            g.type = 'text/javascript';
            g.defer = true; g.async = true; g.src = u + 'piwik.js';
            s.parentNode.insertBefore(g, s);
        })();
    }
};
