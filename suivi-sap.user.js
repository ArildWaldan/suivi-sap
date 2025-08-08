// ==UserScript==
// @name         Suivi SAP Avancé (KFPLC) — Header Capture + Overlay + Auth Validate Fallback
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Suivi des commandes en attente de numéro SAP avec notifications, overlay, capture auto des en-têtes, et fallback d'auth (oauth2 validate) avant retry.
// @author       You
// @match        https://dc.kfplc.com/*
// @connect      prod-agent.castorama.fr
// @connect      dc.dps.kd.kfplc.com
// @connect      https://login.microsoftonline.*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // -----------------------------
    // CONFIG
    // -----------------------------
    const STORAGE_KEY = 'trackedSapOrders_kfplc';
    const CHECK_INTERVAL_MS = 5 * 60 * 1000;
    const RECHECK_THRESHOLD_MS = 10 * 60 * 1000;
    const WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
    const BULLETIN_DE_VENTE_LI_SELECTOR = 'li:has(a[data-auto="menu-dropdown-core.menu.titles.orders-core.menu.titles.basket"])';

    let trackedOrders = [];
    let mainPopup = null;
    let popupOverlay = null;
    let ordersTableBody = null;
    let orderInput = null;

    // -----------------------------
    // AUTH CAPTURE (COMPUTER-AGNOSTIC) — BOTH DOMAINS
    // -----------------------------
    const AGENT_HOST_RE = /prod-agent\.castorama\.fr/i;
    const KD_HOST_RE    = /dc\.dps\.kd\.kfplc\.com/i;

    // Load persisted captures
    let agentAuth = loadJson('sap_agent_auth', { headers: {}, cookie: '' });
    let kdAuth    = loadJson('sap_kd_auth',    { headers: {}, cookie: '' });

    function loadJson(key, fallback) {
        try {
            const v = GM_getValue(key, null);
            return v ? JSON.parse(v) : fallback;
        } catch { return fallback; }
    }
    function saveJson(key, obj) { try { GM_setValue(key, JSON.stringify(obj)); } catch {} }

    // Hook native XHR once; capture headers for BOTH domains
    (function hookNativeXHR() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._sap_url = url;
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(h, v) {
            if (!this._sap_headers) this._sap_headers = {};
            this._sap_headers[h] = v;
            return origSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
            const url = this._sap_url || '';
            if (url && (AGENT_HOST_RE.test(url) || KD_HOST_RE.test(url))) {
                this.addEventListener('load', () => {
                    if (this.status >= 200 && this.status < 300) {
                        const snap = {
                            headers: Object.assign({}, this._sap_headers || {}),
                            cookie: (() => { try { return document.cookie || ''; } catch { return ''; } })()
                        };
                        if (AGENT_HOST_RE.test(url)) {
                            agentAuth.headers = Object.assign({}, agentAuth.headers, snap.headers);
                            if (snap.cookie) agentAuth.cookie = snap.cookie;
                            saveJson('sap_agent_auth', agentAuth);
                            console.log('[SAP] ✅ Captured prod-agent headers.');
                        }
                        if (KD_HOST_RE.test(url)) {
                            kdAuth.headers = Object.assign({}, kdAuth.headers, snap.headers);
                            if (snap.cookie) kdAuth.cookie = snap.cookie;
                            saveJson('sap_kd_auth', kdAuth);
                            console.log('[SAP] ✅ Captured KD headers.');
                        }
                    }
                }, { once: true });
            }
            return origSend.apply(this, arguments);
        };
    })();

    const hasAgentHeaders = () => agentAuth && Object.keys(agentAuth.headers || {}).length > 0;
    const hasKdHeaders    = () => kdAuth && Object.keys(kdAuth.headers || {}).length > 0;

    // -----------------------------
    // REQUEST HELPERS
    // -----------------------------
    function stripAndBuild(baseHeaders, defaults, extra = {}) {
        const forbidden = new Set([
            'host','content-length','connection','accept-encoding',
            'sec-fetch-site','sec-fetch-mode','sec-fetch-dest',
            'sec-ch-ua','sec-ch-ua-platform','sec-ch-ua-mobile','cookie'
        ]);
        const out = {};
        for (const [k, v] of Object.entries(baseHeaders || {})) {
            if (!forbidden.has(k.toLowerCase())) out[k] = v;
        }
        Object.entries(defaults || {}).forEach(([k,v]) => { if (!out[k]) out[k] = v; });
        Object.assign(out, extra);
        return out;
    }

    function agentRequest({ method, url, data = null, headers = {}, timeout = 30000 }) {
        const finalHeaders = stripAndBuild(
            agentAuth.headers,
            {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://prod-agent.castorama.fr',
                'Referer': 'https://prod-agent.castorama.fr/agent-front/jsp/agent/main.jsp'
            },
            headers
        );
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method, url, data, headers: finalHeaders,
                cookie: agentAuth.cookie || undefined,
                timeout,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }

    function kdRequest({ method, url, data = null, headers = {}, timeout = 15000 }) {
        const finalHeaders = stripAndBuild(
            kdAuth.headers,
            { 'Accept': 'application/json' },
            headers
        );
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method, url, data, headers: finalHeaders,
                cookie: kdAuth.cookie || undefined,
                timeout,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('Timeout')),
            });
        });
    }

    // Fallback: validate oauth2 on KD, then retry the original request once
    async function tryWithAuthValidate(doRequest) {
        try {
            const r1 = await doRequest();
            if (r1 && r1.status >= 200 && r1.status < 300) return r1;
            // Non-2xx → attempt validation then retry
            await validateKfplcAuth();
            const r2 = await doRequest();
            return r2;
        } catch (e) {
            // Network/timeout → attempt validation then retry
            await validateKfplcAuth();
            return doRequest();
        }
    }

    async function validateKfplcAuth() {
        const url = 'https://dc.dps.kd.kfplc.com/auth/validate/oauth2';
        if (!hasKdHeaders()) {
            console.warn('[SAP] No KD headers yet; will still attempt oauth2 validate with bare Accept.');
        }
        try {
            const r = await kdRequest({ method: 'GET', url, headers: { 'Accept': 'application/json' } });
            console.log('[SAP] KD oauth2 validate status:', r.status);
            return r.status >= 200 && r.status < 300;
        } catch (e) {
            console.warn('[SAP] KD oauth2 validate request failed.', e);
            return false;
        }
    }

    // -----------------------------
    // STYLES
    // -----------------------------
    GM_addStyle(`
        #sap-tracker-popup, .sap-notification-popup, #sap-tracker-overlay {
            font-family: "Roboto", sans-serif;
            -moz-osx-font-smoothing: grayscale;
            -webkit-font-smoothing: antialiased;
            box-sizing: border-box;
        }
        #sap-tracker-popup *, .sap-notification-popup *, #sap-tracker-overlay * { box-sizing: border-box; }

        #sap-tracker-overlay { position: fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,.65); z-index:10000; display:none; }

        #sap-tracker-popup {
            position: fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            background:#0B1924; color:#e7f6fe; border:1px solid #21455F; box-shadow:0 5px 25px rgba(0,0,0,.5);
            z-index:10001; padding:20px; width:700px; max-width:90vw; max-height:85vh; display:flex; flex-direction:column; border-radius:6px;
        }
        #sap-tracker-popup h3 { margin:0 0 15px; color:#fff; text-align:center; border-bottom:1px solid #21455F; padding-bottom:15px; font-size:1.25rem; font-weight:500; }
        #sap-tracker-popup .input-area { display:flex; margin-bottom:20px; }
        #sap-tracker-popup .input-area input[type="text"] { flex:1; padding:10px 12px; background:#102332; color:#e7f6fe; border:1px solid #21455F; border-radius:4px; font-size:.95rem; }
        #sap-tracker-popup .input-area input[type="text"]:focus { outline:none; border-color:#007bff; box-shadow:0 0 0 2px rgba(0,123,255,.25); }
        #sap-tracker-popup .input-area button, #sap-tracker-popup > button {
            padding:10px 15px; margin-left:10px; background:#007bff; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:500; font-size:.95rem; transition:background-color .2s;
        }
        #sap-tracker-popup .input-area button:hover, #sap-tracker-popup > button:hover { background:#0056b3; }
        #sap-tracker-popup > button#sap-close-popup-btn { background:#4a4c52; margin-left:0; margin-top:20px; }
        #sap-tracker-popup > button#sap-close-popup-btn:hover { background:#3a3c42; }

        #sap-tracker-popup .orders-table-container { flex:1; overflow-y:auto; border:1px solid #21455F; border-radius:4px; background:#102332; }
        #sap-tracker-popup table { width:100%; border-collapse:collapse; }
        #sap-tracker-popup th, #sap-tracker-popup td { border:1px solid #21455F; padding:10px 12px; text-align:left; font-size:.9rem; vertical-align:middle; }
        #sap-tracker-popup th { background:#1a3245; color:#fff; font-weight:500; position:sticky; top:0; z-index:1; }

        #sap-tracker-popup .status-en-attente { color:#ffc107; }
        #sap-tracker-popup .status-sap-trouve { color:#28a745; font-weight:bold; }
        #sap-tracker-popup .status-erreur-api { color:#dc3545; }
        #sap-tracker-popup .status-verification { color:#6c757d; font-style:italic; }

        #sap-tracker-popup .delete-order-btn { cursor:pointer; color:#ff4d4f; font-weight:bold; padding:2px 5px; font-size:1.1em; transition:color .2s; }
        #sap-tracker-popup .delete-order-btn:hover { color:#d9363e; }

        .sap-notification-popup { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); box-shadow:0 5px 25px rgba(0,0,0,.5); z-index:10002; padding:25px 30px; text-align:center; border-radius:6px; min-width:380px; font-size:1rem; }
        .sap-notification-popup.success { background:#0B1924; color:#e7f6fe; border:2px solid #28a745; }
        .sap-notification-popup.warning { background:#0B1924; color:#e7f6fe; border:2px solid #ffc107; }
        .sap-notification-popup h4 { margin:0 0 15px; font-size:1.3rem; font-weight:500; color:#fff; }
        .sap-notification-popup p { margin-bottom:10px; line-height:1.6; }
        .sap-notification-popup button { padding:10px 20px; margin-top:20px; cursor:pointer; border-radius:4px; font-weight:500; transition:background-color .2s, border-color .2s; font-size:.95rem; }
        .sap-notification-popup .copy-btn { background:#007bff; color:#fff; border:1px solid #007bff; margin-left:10px; }
        .sap-notification-popup .copy-btn:hover { background:#0056b3; border-color:#0056b3; }
        .sap-notification-popup .close-notif-btn { background:#4a4c52; color:#fff; border:1px solid #4a4c52; }
        .sap-notification-popup .close-notif-btn:hover { background:#3a3c42; border-color:#3a3c42; }

        #attente-sap-menu-item a { padding:.875rem 1rem .875rem .75rem; display:block; font-weight:500; color:#fff; text-decoration:none; font-size:1rem; line-height:1.5; }
        #attente-sap-menu-item a:hover { background:#1a3245; }
    `);

    // -----------------------------
    // UI RENDERING
    // -----------------------------
    function createMainPopup() {
        if (!document.getElementById('sap-tracker-overlay')) {
            popupOverlay = document.createElement('div');
            popupOverlay.id = 'sap-tracker-overlay';
            document.body.appendChild(popupOverlay);
            popupOverlay.addEventListener('click', toggleMainPopup);
        } else popupOverlay = document.getElementById('sap-tracker-overlay');

        if (!document.getElementById('sap-tracker-popup')) {
            mainPopup = document.createElement('div');
            mainPopup.id = 'sap-tracker-popup';
            mainPopup.style.display = 'none';
            mainPopup.innerHTML = `
                <h3>Suivi des commandes en attente de SAP</h3>
                <div class="input-area">
                    <input type="text" id="sap-order-input" placeholder="Entrer numéro de commande...">
                    <button id="sap-add-order-btn">Ajouter</button>
                </div>
                <div class="orders-table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>N° Commande</th>
                                <th>N° SAP</th>
                                <th>Statut</th>
                                <th>Ajouté le</th>
                                <th>Dernier check</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody id="sap-orders-table-body"></tbody>
                    </table>
                </div>
                <button id="sap-close-popup-btn">Fermer</button>
            `;
            document.body.appendChild(mainPopup);

            ordersTableBody = document.getElementById('sap-orders-table-body');
            orderInput = document.getElementById('sap-order-input');

            document.getElementById('sap-add-order-btn').addEventListener('click', () => {
                addOrderToTrack(orderInput.value);
                orderInput.value = '';
            });
            document.getElementById('sap-close-popup-btn').addEventListener('click', toggleMainPopup);
        } else mainPopup = document.getElementById('sap-tracker-popup');
    }

    function renderOrdersTable() {
        if (!ordersTableBody) return;
        ordersTableBody.innerHTML = '';

        trackedOrders.forEach(order => {
            const row = ordersTableBody.insertRow();
            row.insertCell().textContent = order.orderNumber;
            row.insertCell().textContent = order.sapNumber || '-';

            const statusCell = row.insertCell();
            const normalized = order.status.toLowerCase();
            statusCell.textContent = order.status;
            statusCell.className =
                normalized.includes('vérification') || normalized.includes('verification') ? 'status-verification' :
                normalized.includes('sap') ? 'status-sap-trouve' :
                normalized.includes('erreur') ? 'status-erreur-api' :
                'status-en-attente';

            row.insertCell().textContent = formatTimestamp(order.addedTimestamp);
            row.insertCell().textContent = formatTimestamp(order.lastCheckedTimestamp);

            const deleteBtn = document.createElement('span');
            deleteBtn.className = 'delete-order-btn';
            deleteBtn.textContent = 'X';
            deleteBtn.title = 'Supprimer cette commande du suivi';
            deleteBtn.addEventListener('click', () => deleteOrder(order.orderNumber));
            row.insertCell().appendChild(deleteBtn);
        });
    }

    function toggleMainPopup() {
        if (!mainPopup || !popupOverlay) createMainPopup();
        const isVisible = mainPopup.style.display === 'block';
        mainPopup.style.display = isVisible ? 'none' : 'block';
        popupOverlay.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) { loadOrders(); renderOrdersTable(); }
    }

    // -----------------------------
    // NOTIFICATIONS
    // -----------------------------
    function showNotification(type, orderNumber, sapNumber = null) {
        const existingNotif = document.getElementById('sap-dynamic-notification');
        if (existingNotif) existingNotif.remove();

        const notifPopup = document.createElement('div');
        notifPopup.id = 'sap-dynamic-notification';
        notifPopup.className = `sap-notification-popup ${type}`;

        let messageHtml = '';
        if (type === 'success') {
            messageHtml = `
                <h4>🎉 SAP Trouvé ! 🎉</h4>
                <p>Un numéro SAP a été généré pour la commande <strong>${orderNumber}</strong>.</p>
                <p>N° SAP: <strong style="font-size: 1.2em;">${sapNumber}</strong></p>
                <button class="copy-btn">Copier SAP</button>
            `;
        } else if (type === 'warning') {
            messageHtml = `
                <h4>⚠️ Attention ⚠️</h4>
                <p>La commande <strong>${orderNumber}</strong> n'a toujours pas de numéro SAP après plus de 24 heures.</p>
                <p>Une investigation est peut-être nécessaire.</p>
            `;
        }

        notifPopup.innerHTML = messageHtml + '<button class="close-notif-btn">OK</button>';
        document.body.appendChild(notifPopup);

        notifPopup.querySelector('.close-notif-btn').addEventListener('click', () => notifPopup.remove());
        if (type === 'success') {
            notifPopup.querySelector('.copy-btn').addEventListener('click', () => copyToClipboard(sapNumber));
        }
    }

    // -----------------------------
    // DATA MGMT
    // -----------------------------
    function formatTimestamp(ts) { return ts ? new Date(ts).toLocaleString('fr-FR') : 'N/A'; }
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => alert('Numéro SAP copié dans le presse-papiers !'))
            .catch(err => { console.error('Erreur de copie:', err); alert('Erreur lors de la copie.'); });
    }
    function loadOrders() {
        const stored = GM_getValue(STORAGE_KEY, '[]');
        try { trackedOrders = JSON.parse(stored); } catch { trackedOrders = []; }
    }
    function saveOrders() { GM_setValue(STORAGE_KEY, JSON.stringify(trackedOrders)); }
    function addOrderToTrack(orderNumberStr) {
        const orderNumber = orderNumberStr.trim();
        if (!orderNumber || !/^\d+$/.test(orderNumber)) { alert("Veuillez entrer un numéro de commande valide (chiffres uniquement)."); return; }
        if (trackedOrders.some(o => o.orderNumber === orderNumber)) { alert("Cette commande est déjà suivie."); return; }

        const newOrder = { orderNumber, sapNumber: null, status: "en attente", addedTimestamp: Date.now(), lastCheckedTimestamp: 0, notified24h: false };
        trackedOrders.push(newOrder);
        saveOrders();
        renderOrdersTable();
        checkOrder(newOrder);
    }
    function deleteOrder(orderNumber) { trackedOrders = trackedOrders.filter(o => o.orderNumber !== orderNumber); saveOrders(); renderOrdersTable(); }
    function updateOrder(orderNumber, updates) {
        const idx = trackedOrders.findIndex(o => o.orderNumber === orderNumber);
        if (idx > -1) { trackedOrders[idx] = { ...trackedOrders[idx], ...updates }; saveOrders(); renderOrdersTable(); }
    }

    // -----------------------------
    // API WORKFLOW (WITH AUTH-VALIDATE FALLBACK)
    // -----------------------------
    function fetchAtgOrderId(orderNumber) {
        const url = `https://prod-agent.castorama.fr/agent-front/jsp/storeStart/responseOrderStatusFindJson.jsp?orderNumber=${orderNumber}`;
        if (!hasAgentHeaders()) console.warn('[SAP] Waiting for prod-agent headers; interact with Agent if needed.');
        return tryWithAuthValidate(() => agentRequest({ method: "GET", url }))
            .then((response) => {
                if (response.status < 200 || response.status >= 300) {
                    throw new Error(`Erreur API (étape 1) status ${response.status}`);
                }
                let data; try { data = JSON.parse(response.responseText); }
                catch (e) { throw new Error("Erreur parsing JSON (étape 1): " + e.message); }

                const m = data.vieworderurl && data.vieworderurl.match(/orderId=([^&]+)/);
                if (m && m[1]) return m[1];
                throw new Error("Impossible d'extraire orderId (ATG) de vieworderurl.");
            });
    }

    function fetchSapDocumentNumber(atgOrderId) {
        const url = `https://prod-agent.castorama.fr/agent-front/jsp/customer/order.jsp?orderId=${atgOrderId}`;
        return tryWithAuthValidate(() => agentRequest({
            method: "POST",
            url,
            data: "",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
        })).then((response) => {
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`Erreur API (étape 2) status ${response.status}`);
            }
            const html = response.responseText;
            const docRegex = /N° document\.[\s\S]*?<\/th>[\s\S]*?<tbody>[\s\S]*?<tr>\s*<td>(\d{6,})<\/td>/s;
            const match = html.match(docRegex);
            return (match && match[1] && match[1].startsWith('6')) ? match[1] : null;
        });
    }

    async function checkOrder(order) {
        console.log(`Vérification SAP pour commande: ${order.orderNumber}`);
        updateOrder(order.orderNumber, { status: "vérification...", lastCheckedTimestamp: Date.now() });

        try {
            const atgOrderId = await fetchAtgOrderId(order.orderNumber);
            const sapDocNumber = await fetchSapDocumentNumber(atgOrderId);

            if (sapDocNumber) {
                updateOrder(order.orderNumber, { sapNumber: sapDocNumber, status: "SAP Trouvé", lastCheckedTimestamp: Date.now() });
                showNotification('success', order.orderNumber, sapDocNumber);
            } else {
                updateOrder(order.orderNumber, { status: "en attente", lastCheckedTimestamp: Date.now() });
            }
        } catch (error) {
            console.error(`Erreur lors de la vérification de la commande ${order.orderNumber}:`, error);
            updateOrder(order.orderNumber, { status: "erreur API", lastCheckedTimestamp: Date.now() });
        }
    }

    function periodicCheck() {
        const now = Date.now();
        loadOrders();

        trackedOrders.forEach(order => {
            if (!order.sapNumber || order.status === "erreur API") {
                if (now - order.lastCheckedTimestamp > RECHECK_THRESHOLD_MS) {
                    checkOrder(order);
                }
            }
            if (!order.sapNumber && !order.notified24h && (now - order.addedTimestamp > WARNING_THRESHOLD_MS)) {
                showNotification('warning', order.orderNumber);
                updateOrder(order.orderNumber, { notified24h: true });
            }
        });
    }

    // -----------------------------
    // MENU INJECTION
    // -----------------------------
    function injectAttenteSapMenuItem() {
        if (document.getElementById('attente-sap-menu-item')) return;
        const referenceLi = document.querySelector(BULLETIN_DE_VENTE_LI_SELECTOR);
        if (referenceLi) {
            const newLi = document.createElement('li');
            newLi.id = 'attente-sap-menu-item';
            const newLink = document.createElement('a');
            newLink.href = "#";
            newLink.textContent = "Attente de SAP";
            newLink.tabIndex = 0;
            newLink.addEventListener('click', (e) => { e.preventDefault(); toggleMainPopup(); });
            newLi.appendChild(newLink);
            referenceLi.parentNode.insertBefore(newLi, referenceLi.nextSibling);
        } else {
            console.warn('Point d\'injection "Bulletin de vente" non trouvé.');
        }
    }

    let observerAttached = false;
    const menuObserver = new MutationObserver((mutList, obs) => {
        const targetNode = document.querySelector(BULLETIN_DE_VENTE_LI_SELECTOR);
        if (targetNode && !document.getElementById('attente-sap-menu-item')) {
            injectAttenteSapMenuItem(); obs.disconnect(); observerAttached = false;
        } else if (document.getElementById('attente-sap-menu-item')) { obs.disconnect(); observerAttached = false; }
    });

    function attemptAttachMenuObserver() {
        const menuContainer = document.getElementById('menu');
        if (menuContainer) {
            menuObserver.observe(menuContainer, { childList: true, subtree: true });
            observerAttached = true;
            setTimeout(() => {
                if (observerAttached && !document.getElementById('attente-sap-menu-item')) {
                    injectAttenteSapMenuItem(); if (observerAttached) { menuObserver.disconnect(); observerAttached = false; }
                } else if (observerAttached) { menuObserver.disconnect(); observerAttached = false; }
            }, 5000);
        } else {
            setTimeout(attemptAttachMenuObserver, 1000);
        }
    }

    // -----------------------------
    // INIT
    // -----------------------------
    function init() {
        loadOrders();
        createMainPopup();

        const now = Date.now();
        trackedOrders.forEach(order => {
            if ((!order.sapNumber || order.status === "erreur API") && (now - order.lastCheckedTimestamp > RECHECK_THRESHOLD_MS)) {
                setTimeout(() => checkOrder(order), Math.random() * 5000 + 1000);
            }
        });

        setInterval(periodicCheck, CHECK_INTERVAL_MS);
        console.log("Suivi SAP Avancé (v1.5) initialisé.");
        attemptAttachMenuObserver();

        if (!hasAgentHeaders()) console.warn('[SAP] En attente de capture prod-agent. Interagissez avec l’Agent si nécessaire.');
        if (!hasKdHeaders())    console.warn('[SAP] En attente de capture KD. Naviguez un peu sur dc.kfplc.com si nécessaire.');
    }

    if (document.readyState === "complete" || document.readyState === "interactive") init();
    else window.addEventListener('DOMContentLoaded', init);

})();
