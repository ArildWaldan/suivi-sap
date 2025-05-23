// ==UserScript==
// @name         Suivi SAP Avancé (KFPLC)
// @namespace    http://tampermonkey.net/
// @version      1.3 // Increment version
// @description  Suivi des commandes en attente de numéro SAP avec notifications et overlay.
// @author       You
// @match        https://dc.kfplc.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      prod-agent.castorama.fr
// ==/UserScript==

(function() {
    'use strict';

    // ... (all your existing constants and JS variables like STORAGE_KEY, trackedOrders, etc.)
    const STORAGE_KEY = 'trackedSapOrders_kfplc';
    const CHECK_INTERVAL_MS = 5 * 60 * 1000;
    const RECHECK_THRESHOLD_MS = 10 * 60 * 1000;
    const WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

    const BULLETIN_DE_VENTE_LI_SELECTOR = 'li:has(a[data-auto="menu-dropdown-core.menu.titles.orders-core.menu.titles.basket"])';

    let trackedOrders = [];
    let mainPopup = null;
    let popupOverlay = null; // <<<< NEW: Variable for the overlay
    let ordersTableBody = null;
    let orderInput = null;


    // --- STYLES (MODIFIED SECTION) ---
    GM_addStyle(`
        /* Base font and smoothing for our elements */
        #sap-tracker-popup, .sap-notification-popup, #sap-tracker-overlay { /* Added overlay */
            font-family: "Roboto", sans-serif;
            -moz-osx-font-smoothing: grayscale;
            -webkit-font-smoothing: antialiased;
            box-sizing: border-box;
        }
        #sap-tracker-popup *, .sap-notification-popup *, #sap-tracker-overlay * { /* Added overlay */
            box-sizing: border-box;
        }

        /* Styles for the overlay */
        #sap-tracker-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(0, 0, 0, 0.65); /* Dark semi-transparent overlay */
            z-index: 10000; /* Below main popup, above page content */
            display: none; /* Hidden by default */
        }

        /* Main Popup (#sap-tracker-popup) */
        #sap-tracker-popup {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background-color: #0B1924;
            color: #e7f6fe;
            border: 1px solid #21455F;
            box-shadow: 0 5px 25px rgba(0,0,0,0.5);
            z-index: 10001; /* Higher than overlay */
            padding: 20px;
            width: 700px;
            max-width: 90vw;
            max-height: 85vh;
            display: flex; /* Keep this for the popup itself if it's 'none' by default */
            flex-direction: column;
            border-radius: 6px;
            /* display: none; /* This will be controlled by JS */
        }
        /* ... (rest of your existing #sap-tracker-popup styles from version 1.2) ... */
        #sap-tracker-popup h3 {
            margin-top: 0;
            color: #ffffff; /* Bright white for headers */
            text-align: center;
            border-bottom: 1px solid #21455F;
            padding-bottom: 15px;
            margin-bottom: 15px;
            font-size: 1.25rem;
            font-weight: 500;
        }
        #sap-tracker-popup .input-area {
            display: flex;
            margin-bottom: 20px;
        }
        #sap-tracker-popup .input-area input[type="text"] {
            flex-grow: 1;
            padding: 10px 12px;
            background-color: #102332; /* Darker input bg */
            color: #e7f6fe;
            border: 1px solid #21455F;
            border-radius: 4px;
            font-size: 0.95rem;
        }
        #sap-tracker-popup .input-area input[type="text"]:focus {
            outline: none;
            border-color: #007bff; /* Blue accent on focus */
            box-shadow: 0 0 0 2px rgba(0,123,255,.25);
        }
        #sap-tracker-popup .input-area button,
        #sap-tracker-popup > button { /* For the close button at the bottom */
            padding: 10px 15px;
            margin-left: 10px;
            background-color: #007bff; /* Primary blue for buttons */
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            font-size: 0.95rem;
            transition: background-color 0.2s ease;
        }
        #sap-tracker-popup .input-area button:hover,
        #sap-tracker-popup > button:hover {
            background-color: #0056b3; /* Darker blue on hover */
        }
        #sap-tracker-popup > button#sap-close-popup-btn { /* Specific styling for the main close button */
            background-color: #4a4c52; /* A more neutral dark gray */
            margin-left: 0; /* No left margin if it's full width */
            margin-top: 20px;
        }
        #sap-tracker-popup > button#sap-close-popup-btn:hover {
            background-color: #3a3c42;
        }

        #sap-tracker-popup .orders-table-container {
            flex-grow: 1;
            overflow-y: auto;
            border: 1px solid #21455F;
            border-radius: 4px;
            background-color: #102332; /* Table container background */
        }
        #sap-tracker-popup table {
            width: 100%;
            border-collapse: collapse;
        }
        #sap-tracker-popup th, #sap-tracker-popup td {
            border: 1px solid #21455F; /* Match container border */
            padding: 10px 12px;
            text-align: left;
            font-size: 0.9rem;
            vertical-align: middle;
        }
        #sap-tracker-popup th {
            background-color: #1a3245; /* Slightly different shade for header */
            color: #ffffff;
            font-weight: 500;
            position: sticky;
            top: 0;
            z-index: 1; /* Ensure header stays above scrolling content */
        }

        #sap-tracker-popup .status-en-attente { color: #ffc107; }
        #sap-tracker-popup .status-sap-trouve { color: #28a745; font-weight: bold; }
        #sap-tracker-popup .status-erreur-api { color: #dc3545; }
        #sap-tracker-popup .status-v-rification- { color: #6c757d; font-style: italic; }


        #sap-tracker-popup .delete-order-btn {
            cursor: pointer;
            color: #ff4d4f;
            font-weight: bold;
            padding: 2px 5px;
            font-size: 1.1em;
            transition: color 0.2s ease;
        }
        #sap-tracker-popup .delete-order-btn:hover {
            color: #d9363e;
        }

        /* Notification Popups (.sap-notification-popup) */
        .sap-notification-popup {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            box-shadow: 0 5px 25px rgba(0,0,0,0.5);
            z-index: 10002; /* Higher than main popup and overlay */
            padding: 25px 30px;
            text-align: center;
            border-radius: 6px;
            min-width: 380px;
            font-size: 1rem;
        }
        .sap-notification-popup.success {
            background-color: #0B1924;
            color: #e7f6fe;
            border: 2px solid #28a745;
        }
        .sap-notification-popup.warning {
            background-color: #0B1924;
            color: #e7f6fe;
            border: 2px solid #ffc107;
        }
        .sap-notification-popup h4 {
            margin-top: 0;
            margin-bottom: 15px;
            font-size: 1.3rem;
            font-weight: 500;
            color: #ffffff;
        }
        .sap-notification-popup p {
            margin-bottom: 10px;
            line-height: 1.6;
        }
        .sap-notification-popup strong {
            font-weight: 600;
        }
        .sap-notification-popup p strong {
            color: #00b0ff;
        }
        .sap-notification-popup button {
            padding: 10px 20px;
            margin-top: 20px;
            cursor: pointer;
            border-radius: 4px;
            font-weight: 500;
            transition: background-color 0.2s ease, border-color 0.2s ease;
            font-size: 0.95rem;
        }
        .sap-notification-popup .copy-btn {
             background-color: #007bff;
             color: white;
             border: 1px solid #007bff;
             margin-left: 10px;
        }
        .sap-notification-popup .copy-btn:hover {
            background-color: #0056b3;
            border-color: #0056b3;
        }
        .sap-notification-popup .close-notif-btn {
            background-color: #4a4c52;
            color: white;
            border: 1px solid #4a4c52;
        }
        .sap-notification-popup .close-notif-btn:hover {
            background-color: #3a3c42;
            border-color: #3a3c42;
        }

        /* Style for the injected menu item */
        #attente-sap-menu-item a {
            padding-left: .75rem;
            padding-right: 1rem;
            padding-bottom: .875rem;
            padding-top: .875rem;
            align-items: center;
            display: block;
            font-weight: 500;
            position: relative;
            color: #ffffff;
            text-decoration: none;
            font-size: 1rem;
            line-height: 1.5;
        }
         #attente-sap-menu-item a:hover {
            background-color: #1a3245;
        }
    `);

    // --- UTILITY FUNCTIONS (Keep as is) ---
    // ... (formatTimestamp, copyToClipboard)

    // --- DATA MANAGEMENT (Keep as is) ---
    // ... (loadOrders, saveOrders, addOrderToTrack, deleteOrder, updateOrder)

    // --- UI RENDERING (createMainPopup and toggleMainPopup are MODIFIED) ---
    function createMainPopup() {
        // Create Overlay if it doesn't exist
        if (!document.getElementById('sap-tracker-overlay')) {
            popupOverlay = document.createElement('div');
            popupOverlay.id = 'sap-tracker-overlay';
            document.body.appendChild(popupOverlay);
            // Optional: close popup if overlay is clicked
            popupOverlay.addEventListener('click', toggleMainPopup);
        } else {
            popupOverlay = document.getElementById('sap-tracker-overlay');
        }

        // Create Main Popup if it doesn't exist
        if (!document.getElementById('sap-tracker-popup')) {
            mainPopup = document.createElement('div');
            mainPopup.id = 'sap-tracker-popup';
            mainPopup.style.display = 'none'; // Initially hidden

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
                        <tbody id="sap-orders-table-body">
                        </tbody>
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
        } else {
            mainPopup = document.getElementById('sap-tracker-popup');
        }
    }

    function renderOrdersTable() { // Keep as is from v1.2
        if (!ordersTableBody) return;
        ordersTableBody.innerHTML = '';

        trackedOrders.forEach(order => {
            const row = ordersTableBody.insertRow();
            row.insertCell().textContent = order.orderNumber;
            row.insertCell().textContent = order.sapNumber || '-';
            const statusCell = row.insertCell();
            statusCell.textContent = order.status;
            statusCell.className = `status-${order.status.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')}`;


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
        // Ensure elements are created first
        if (!mainPopup || !popupOverlay) {
            createMainPopup(); // This will create both if they don't exist
        }

        const isVisible = mainPopup.style.display === 'block';
        mainPopup.style.display = isVisible ? 'none' : 'block';
        popupOverlay.style.display = isVisible ? 'none' : 'block'; // Toggle overlay with popup

        if (!isVisible) { // Means popup is now being shown
            loadOrders();
            renderOrdersTable();
        }
    }

    // ... (Rest of your JavaScript: NOTIFICATION POPUPS, API WORKFLOW, PERIODIC CHECKING, MENU INJECTION, INIT - keep them as is from v1.2)
    // Make sure all functions like formatTimestamp, copyToClipboard, loadOrders etc. are included

    function formatTimestamp(timestamp) {
        if (!timestamp) return 'N/A';
        return new Date(timestamp).toLocaleString('fr-FR');
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            alert('Numéro SAP copié dans le presse-papiers !');
        }).catch(err => {
            console.error('Erreur de copie:', err);
            alert('Erreur lors de la copie.');
        });
    }

    function loadOrders() {
        const stored = GM_getValue(STORAGE_KEY, '[]');
        try {
            trackedOrders = JSON.parse(stored);
        } catch (e) {
            console.error("Erreur de chargement des commandes:", e);
            trackedOrders = [];
        }
    }

    function saveOrders() {
        GM_setValue(STORAGE_KEY, JSON.stringify(trackedOrders));
    }

    function addOrderToTrack(orderNumberStr) {
        const orderNumber = orderNumberStr.trim();
        if (!orderNumber || !/^\d+$/.test(orderNumber)) {
            alert("Veuillez entrer un numéro de commande valide (chiffres uniquement).");
            return;
        }
        if (trackedOrders.some(o => o.orderNumber === orderNumber)) {
            alert("Cette commande est déjà suivie.");
            return;
        }

        const newOrder = {
            orderNumber: orderNumber,
            sapNumber: null,
            status: "en attente",
            addedTimestamp: Date.now(),
            lastCheckedTimestamp: 0,
            notified24h: false
        };
        trackedOrders.push(newOrder);
        saveOrders();
        renderOrdersTable();
        checkOrder(newOrder);
    }

    function deleteOrder(orderNumber) {
        trackedOrders = trackedOrders.filter(o => o.orderNumber !== orderNumber);
        saveOrders();
        renderOrdersTable();
    }

    function updateOrder(orderNumber, updates) {
        const orderIndex = trackedOrders.findIndex(o => o.orderNumber === orderNumber);
        if (orderIndex > -1) {
            trackedOrders[orderIndex] = { ...trackedOrders[orderIndex], ...updates };
            saveOrders();
            renderOrdersTable();
        }
    }
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

    async function checkOrder(order) {
        console.log(`Vérification SAP pour commande: ${order.orderNumber}`);
        updateOrder(order.orderNumber, { status: "vérification...", lastCheckedTimestamp: Date.now() });

        try {
            const atgOrderId = await fetchAtgOrderId(order.orderNumber);
            const sapDocNumber = await fetchSapDocumentNumber(atgOrderId);

            if (sapDocNumber) {
                updateOrder(order.orderNumber, {
                    sapNumber: sapDocNumber,
                    status: "SAP Trouvé",
                    lastCheckedTimestamp: Date.now()
                });
                showNotification('success', order.orderNumber, sapDocNumber);
            } else {
                updateOrder(order.orderNumber, { status: "en attente", lastCheckedTimestamp: Date.now() });
            }
        } catch (error) {
            console.error(`Erreur lors de la vérification de la commande ${order.orderNumber}:`, error);
            updateOrder(order.orderNumber, { status: "erreur API", lastCheckedTimestamp: Date.now() });
        }
    }

    function fetchAtgOrderId(orderNumber) {
        return new Promise((resolve, reject) => {
            const url = `https://prod-agent.castorama.fr/agent-front/jsp/storeStart/responseOrderStatusFindJson.jsp?orderNumber=${orderNumber}`;
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: { "Accept": "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.vieworderurl) {
                                const match = data.vieworderurl.match(/orderId=([^&]+)/);
                                if (match && match[1]) {
                                    resolve(match[1]);
                                } else { reject("Impossible d'extraire orderId (ATG) de vieworderurl."); }
                            } else { reject("vieworderurl non trouvé dans la réponse API (étape 1)."); }
                        } catch (e) { reject("Erreur parsing JSON (étape 1): " + e.message); }
                    } else { reject(`Erreur API (étape 1) status ${response.status}`); }
                },
                onerror: (error) => reject("Erreur réseau (étape 1): " + JSON.stringify(error)),
                ontimeout: () => reject("Timeout API (étape 1)")
            });
        });
    }

    function fetchSapDocumentNumber(atgOrderId) {
        return new Promise((resolve, reject) => {
            const url = `https://prod-agent.castorama.fr/agent-front/jsp/customer/order.jsp?orderId=${atgOrderId}`;
            GM_xmlhttpRequest({
                method: "POST",
                url: url,
                headers: {
                    "Accept": "*/*", "X-Requested-With": "XMLHttpRequest",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Origin": "https://prod-agent.castorama.fr",
                    "Referer": "https://prod-agent.castorama.fr/agent-front/jsp/agent/main.jsp"
                },
                data: "",
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        const htmlResponse = response.responseText;
                        const docRegex = /N° document\.[\s\S]*?<\/th>[\s\S]*?<tbody>[\s\S]*?<tr>\s*<td>(\d{6,})<\/td>/s;
                        const match = htmlResponse.match(docRegex);
                        if (match && match[1] && match[1].startsWith('6')) {
                            resolve(match[1]);
                        } else {
                            resolve(null);
                        }
                    } else { reject(`Erreur API (étape 2) status ${response.status}`); }
                },
                onerror: (error) => reject("Erreur réseau (étape 2): " + JSON.stringify(error)),
                ontimeout: () => reject("Timeout API (étape 2)")
            });
        });
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

    function injectAttenteSapMenuItem() {
        if (document.getElementById('attente-sap-menu-item')) {
            console.log('Menu item "Attente de SAP" already exists.');
            return;
        }
        const referenceLi = document.querySelector(BULLETIN_DE_VENTE_LI_SELECTOR);
        if (referenceLi) {
            const newLi = document.createElement('li');
            newLi.id = 'attente-sap-menu-item';
            const newLink = document.createElement('a');
            newLink.href = "#";
            newLink.textContent = "Attente de SAP";
            newLink.tabIndex = 0;
            newLink.addEventListener('click', (e) => {
                e.preventDefault();
                toggleMainPopup();
            });
            newLi.appendChild(newLink);
            referenceLi.parentNode.insertBefore(newLi, referenceLi.nextSibling);
            console.log('Menu item "Attente de SAP" added successfully.');
        } else {
            console.warn('Point d\'injection "Bulletin de vente" (LI) non trouvé pour "Attente de SAP".');
        }
    }

    let observerAttached = false;
    const menuObserver = new MutationObserver((mutationsList, obs) => {
        const targetNode = document.querySelector(BULLETIN_DE_VENTE_LI_SELECTOR);
        if (targetNode && !document.getElementById('attente-sap-menu-item')) {
            console.log("Menu target node (Bulletin de vente LI) found, adding custom item.");
            injectAttenteSapMenuItem();
            obs.disconnect();
            observerAttached = false;
        } else if (document.getElementById('attente-sap-menu-item')) {
            obs.disconnect();
            observerAttached = false;
        }
    });

    function attemptAttachMenuObserver() {
        const menuContainer = document.getElementById('menu');
        if (menuContainer) {
            console.log("Observer starting on #menu container for 'Attente de SAP' button.");
            menuObserver.observe(menuContainer, { childList: true, subtree: true });
            observerAttached = true;
            setTimeout(() => {
                if (observerAttached && !document.getElementById('attente-sap-menu-item')) {
                    console.warn("MutationObserver didn't add 'Attente de SAP' menu item after 5s, trying fallback insertion.");
                    injectAttenteSapMenuItem();
                    if (observerAttached) {
                        menuObserver.disconnect();
                        observerAttached = false;
                    }
                } else if (observerAttached) {
                    menuObserver.disconnect();
                    observerAttached = false;
                }
            }, 5000);
        } else {
            console.warn("#menu container not found yet for 'Attente de SAP', retrying observer attachment in 1s.");
            setTimeout(attemptAttachMenuObserver, 1000);
        }
    }

    function init() {
        loadOrders();
        createMainPopup(); // This will also create the overlay structure
        const now = Date.now();
        trackedOrders.forEach(order => {
             if ((!order.sapNumber || order.status === "erreur API") && (now - order.lastCheckedTimestamp > RECHECK_THRESHOLD_MS)) {
                setTimeout(() => checkOrder(order), Math.random() * 5000 + 1000);
            }
        });
        setInterval(periodicCheck, CHECK_INTERVAL_MS);
        console.log("Suivi SAP Avancé (v1.3) initialisé.");
        attemptAttachMenuObserver();
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }

})();
