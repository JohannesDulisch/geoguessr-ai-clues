// ==UserScript==
// @name         GeoGuessr AI Plonk It Coach Pro (Gemini Pro Edition)
// @namespace    http://tampermonkey.net/
// @version      8.2
// @description  Nutzt Google Gemini 1.5 Pro (Stabile Version) für exzellente Vision-Analysen.
// @match        https://www.geoguessr.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // Fallback, falls der Dev Loader den Key nicht gesetzt hat
    const DEFAULT_API_KEY = "";

    let lastLocation = null;
    let liveCanvasBackup = null;

    GM_registerMenuCommand("Gemini API Key festlegen", () => {
        const key = prompt("Gib deinen Google Gemini API Key ein:", GM_getValue("gemini_key", DEFAULT_API_KEY));
        if (key !== null) GM_setValue("gemini_key", key);
    });

    // --- REVERSE GEOCODING ---
    function fetchLocationDetailsFromCoords(lat, lng) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
                headers: { "User-Agent": "GeoGuessr AI Mod / 1.0" },
                onload: function (res) {
                    if (res.status === 200) {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (data && data.address) {
                                resolve({
                                    countryCode: data.address.country_code ? data.address.country_code.toUpperCase() : "Unbekannt",
                                    countryName: data.address.country || "Unbekannt"
                                });
                                return;
                            }
                        } catch (e) {}
                    }
                    resolve({ countryCode: "Unbekannt", countryName: "Unbekannt" });
                },
                onerror: () => resolve({ countryCode: "Unbekannt", countryName: "Unbekannt" })
            });
        });
    }

    function getPlonkItSlug(countryName) {
        if (!countryName || countryName === "Unbekannt") return "";
        return countryName.toLowerCase()
            .replace(/ö/g, 'o').replace(/ä/g, 'a').replace(/ü/g, 'u').replace(/ß/g, 'ss')
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-');
    }

    // --- PANO-ID DEKODIERUNG ---
    function formatPanoId(rawPanoId) {
        if (!rawPanoId || typeof rawPanoId !== 'string') return rawPanoId;
        if (/^[0-9a-fA-F]{44}$/.test(rawPanoId)) {
            let decoded = '';
            for (let i = 0; i < rawPanoId.length; i += 2) {
                decoded += String.fromCharCode(parseInt(rawPanoId.substr(i, 2), 16));
            }
            return decoded;
        }
        return rawPanoId;
    }

    function findPanoId(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.panoId) return obj.panoId;
        if (obj.panoid) return obj.panoid;
        if (obj.streetViewPanoId) return obj.streetViewPanoId;
        for (let key in obj) {
            if (typeof obj[key] === 'object') {
                let found = findPanoId(obj[key]);
                if (found) return found;
            }
        }
        return null;
    }

    // --- LIVE CANVAS PRE-CAPTURE ---
    function captureActiveCanvas() {
        const canvasElements = document.querySelectorAll('canvas');
        for (let canvas of canvasElements) {
            if (canvas.width > 200 && canvas.height > 200) {
                try {
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                    if (dataUrl && dataUrl.length > 5000) liveCanvasBackup = dataUrl;
                } catch (e) {}
            }
        }
    }

    document.addEventListener('click', () => captureActiveCanvas(), true);

    const originalFetch = win.fetch;
    win.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const input = args[0];
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (url.includes('/api/v3/games/') || url.includes('/api/v3/duels/') || url.includes('/api/v3/multiverse/')) {
                captureActiveCanvas();
                const clone = response.clone();
                clone.json().then(data => extractLocation(data));
            }
        } catch (e) {}
        return response;
    };

    function extractLocation(data) {
        if (!data) return;
        let r = null;
        let roundNum = 1;

        if (data.rounds && data.rounds.length > 0) {
            r = data.rounds[data.rounds.length - 1];
            roundNum = data.rounds.length;
        } else if (data.currentRound) {
            r = data.currentRound;
            roundNum = data.currentRoundNumber || 1;
        }

        if (r && r.lat) {
            const rawPanoId = r.panoId || r.panoid || findPanoId(r) || findPanoId(data);
            lastLocation = {
                roundNum: roundNum,
                lat: r.lat,
                lng: r.lng,
                panoId: formatPanoId(rawPanoId),
                countryCode: r.countryCode || r.code || null,
                countryName: null
            };
        }
    }

    // --- 360° STITCHER ---
    function fetchImageBase64Safe(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                responseType: "arraybuffer",
                onload: res => {
                    if (res.status === 200) {
                        try {
                            const blob = new Blob([res.response], { type: 'image/jpeg' });
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        } catch (e) { reject(e); }
                    } else { reject(res.status); }
                },
                onerror: err => reject(err)
            });
        });
    }

    async function generate360PanoramaBase64(panoId) {
        if (!panoId) return null;
        const tileUrls = [0, 1, 2, 3].map(x => `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile&panoid=${panoId}&x=${x}&y=0&zoom=1`);
        try {
            const base64Images = await Promise.all(tileUrls.map(url => fetchImageBase64Safe(url)));
            return new Promise((resolve) => {
                const images = [new Image(), new Image(), new Image(), new Image()];
                let loaded = 0;
                let failed = false;

                images.forEach((img, index) => {
                    img.onload = () => {
                        loaded++;
                        if (loaded === 4 && !failed) {
                            const canvas = document.createElement('canvas');
                            canvas.width = 2048;
                            canvas.height = 512;
                            const ctx = canvas.getContext('2d');
                            images.forEach((loadedImg, i) => ctx.drawImage(loadedImg, i * 512, 0, 512, 512));
                            resolve(canvas.toDataURL('image/jpeg', 0.8));
                        }
                    };
                    img.onerror = () => { failed = true; resolve(null); };
                    img.crossOrigin = "Anonymous";
                    img.src = base64Images[index];
                });
            });
        } catch (err) { return null; }
    }

    // --- UI BUTTONS ---
    const observer = new MutationObserver(() => {
        const resultScreen = document.querySelector('[class*="result-layout_root"]') || document.querySelector('[class*="game-summary"]') || document.querySelector('[class*="styles_endGameContainer"]');
        if (resultScreen && !document.getElementById('ai-btn-container')) {
            injectButtons(resultScreen);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function injectButtons(parent) {
        const container = document.createElement('div');
        container.id = 'ai-btn-container';
        container.style.cssText = 'display: flex; gap: 10px; margin: 10px; z-index: 9999;';

        const btnVision = document.createElement('button');
        btnVision.innerHTML = '✨ <span style="margin-left:5px;">Gemini Meta Check</span>';
        btnVision.style.cssText = `
            padding: 10px 20px; background: linear-gradient(135deg, #1d4ed8, #2563eb);
            color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;
            box-shadow: 0 4px 15px rgba(29, 78, 216, 0.4); transition: transform 0.2s;
        `;
        btnVision.onmouseover = () => btnVision.style.transform = 'scale(1.05)';
        btnVision.onmouseout = () => btnVision.style.transform = 'scale(1)';
        btnVision.onclick = () => runAiAnalysis(btnVision);

        const btnFacts = document.createElement('button');
        btnFacts.innerHTML = '📜 <span style="margin-left:5px;">Fun Facts</span>';
        btnFacts.style.cssText = `
            padding: 10px 20px; background: linear-gradient(135deg, #0ea5e9, #0284c7);
            color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;
            box-shadow: 0 4px 15px rgba(14, 165, 233, 0.4); transition: transform 0.2s;
        `;
        btnFacts.onmouseover = () => btnFacts.style.transform = 'scale(1.05)';
        btnFacts.onmouseout = () => btnFacts.style.transform = 'scale(1)';
        btnFacts.onclick = () => runFunFacts(btnFacts);

        container.appendChild(btnVision);
        container.appendChild(btnFacts);
        parent.appendChild(container);
    }

    // --- FUN FACTS ANFRAGE (GEMINI API) ---
    async function runFunFacts(btn) {
        btn.innerHTML = '⏳ <span style="margin-left:5px;">Lade Fakten...</span>';
        btn.disabled = true;

        if (!lastLocation) {
            alert("Fehler: Keine Standortdaten gefunden.");
            btn.disabled = false;
            btn.innerHTML = '📜 <span style="margin-left:5px;">Fun Facts</span>';
            return;
        }

        if (!lastLocation.countryName || lastLocation.countryName === "Unbekannt") {
            const details = await fetchLocationDetailsFromCoords(lastLocation.lat, lastLocation.lng);
            lastLocation.countryCode = details.countryCode;
            lastLocation.countryName = details.countryName;
        }

        const apiKey = GM_getValue("gemini_key", DEFAULT_API_KEY);
        if(!apiKey || apiKey === "") {
            alert("Fehler: Kein Gemini API Key gefunden. Hast du ihn im Dev Loader eingetragen?");
            btn.disabled = false;
            btn.innerHTML = '📜 <span style="margin-left:5px;">Fun Facts</span>';
            return;
        }

        const promptText = `Du bist ein cooler, begeisterter Geografie-Nerd. Wir befinden uns in ${lastLocation.countryName} bei den Koordinaten ${lastLocation.lat}, ${lastLocation.lng}. 
Nenne mir 3 spannende, überraschende Fun Facts zu dieser exakten Gegend oder Kultur. 
Format: Kurze, knackige Bulletpoints auf Deutsch. Keine roboterhaften Einleitungen!`;

        const requestData = {
            contents: [{
                parts: [{ text: promptText }]
            }],
            generationConfig: {
                temperature: 0.7
            }
        };

        // FIXED: gemini-1.5-pro
        GM_xmlhttpRequest({
            method: "POST",
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(requestData),
            onload: function (response) {
                btn.disabled = false;
                btn.innerHTML = '📜 <span style="margin-left:5px;">Fun Facts</span>';
                if (response.status === 200) {
                    try {
                        const resData = JSON.parse(response.responseText);
                        const aiResponse = resData.candidates[0].content.parts[0].text;
                        showSimpleModal(aiResponse, "📜 Fun Facts", lastLocation.roundNum);
                    } catch (e) { alert("Parsing-Fehler bei Gemini Antwort."); }
                } else {
                    alert("Fehler bei Gemini-Anfrage: " + response.responseText);
                }
            }
        });
    }

    // --- VISION ANFRAGE (GEMINI API) ---
    async function runAiAnalysis(btn) {
        btn.innerHTML = '⏳ <span style="margin-left:5px;">Analysiere Meta...</span>';
        btn.disabled = true;

        if (!lastLocation) {
            alert("Fehler: Keine Standortdaten gefunden.");
            btn.disabled = false;
            btn.innerHTML = '✨ <span style="margin-left:5px;">Gemini Meta Check</span>';
            return;
        }

        if (!lastLocation.countryName || lastLocation.countryName === "Unbekannt") {
            const details = await fetchLocationDetailsFromCoords(lastLocation.lat, lastLocation.lng);
            lastLocation.countryCode = details.countryCode;
            lastLocation.countryName = details.countryName;
        }

        let imageToSend = await generate360PanoramaBase64(lastLocation.panoId);
        if (!imageToSend && liveCanvasBackup) imageToSend = liveCanvasBackup;

        if (!imageToSend) {
            alert("Fehler: Konnte kein Panorama-Bild erstellen.");
            btn.disabled = false;
            btn.innerHTML = '✨ <span style="margin-left:5px;">Gemini Meta Check</span>';
            return;
        }

        const apiKey = GM_getValue("gemini_key", DEFAULT_API_KEY);
        if(!apiKey || apiKey === "") {
            alert("Fehler: Kein Gemini API Key gefunden. Hast du ihn im Dev Loader eingetragen?");
            btn.disabled = false;
            btn.innerHTML = '✨ <span style="margin-left:5px;">Gemini Meta Check</span>';
            return;
        }

        const countryName = lastLocation.countryName || "Unbekannt";
        const slug = getPlonkItSlug(countryName);
        const plonkitGuideUrl = slug ? `https://www.plonkit.net/${slug}` : 'https://www.plonkit.net/guide';

        // Base64 Prefix entfernen für Gemini API
        const base64Data = imageToSend.replace(/^data:image\/(png|jpeg);base64,/, "");

        const promptText = `Du bist mein persönlicher GeoGuessr-Coach und absoluter Plonk-It-Experte.
Schau dir dieses 360°-Panorama an. Wir sind in: ${countryName}.

Gehe die offizielle Plonk-It-Checkliste durch und berichte mir in einem natürlichen, fast schon gesprächigen Tonfall, was dir auffällt. 
Nutze Markdown für Übersichtlichkeit. Formatiere deine Antwort in diesen Kategorien:

🚗 **Kamera & Auto:** (Was sehen wir vom Google Auto? Dachträger? Antennen? Gen?)
⚡ **Infrastruktur:** (Poller, Linien, spezifische Masten-Typen für dieses Land?)
🌲 **Vibe & Landschaft:** (Passt die Vegetation typisch in den Norden/Süden des Landes?)

Regel: Erwähne NUR Dinge, die du im Bild ganz klar siehst. Sei präzise wie ein Profi-Spieler, aber schreibe wie ein echter Coach, nicht wie ein Roboter!`;

        const requestData = {
            contents: [{
                parts: [
                    { text: promptText },
                    {
                        inline_data: {
                            mime_type: "image/jpeg",
                            data: base64Data
                        }
                    }
                ]
            }],
            generationConfig: {
                temperature: 0.2 // Eher niedrig für analytische Genauigkeit
            }
        };

        GM_xmlhttpRequest({
            method: "POST",
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(requestData),
            onload: function (response) {
                btn.disabled = false;
                btn.innerHTML = '✨ <span style="margin-left:5px;">Gemini Meta Check</span>';
                if (response.status === 200) {
                    try {
                        const resData = JSON.parse(response.responseText);
                        const aiResponse = resData.candidates[0].content.parts[0].text;
                        showVisionModal(aiResponse, plonkitGuideUrl, countryName, imageToSend, lastLocation.roundNum);
                    } catch(e) { alert("Parsing Fehler bei Gemini Vision Response"); }
                } else {
                    alert("Fehler bei Gemini-Anfrage: " + response.responseText);
                }
            }
        });
    }

    // --- OVERLAYS ---
    function showSimpleModal(rawText, title, roundNum) {
        const formatHtml = (text) => text.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#38bdf8;">$1</strong>').replace(/\n/g, '<br>');

        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #18181b; color: #e4e4e7; padding: 0; border-radius: 12px;
            max-width: 550px; width: 90%; max-height: 80vh; display: flex; flex-direction: column;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8); z-index: 10000;
            font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; line-height: 1.6;
            border: 1px solid #3f3f46; overflow: hidden;
        `;

        modal.innerHTML = `
            <div style="background: #27272a; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #3f3f46;">
                <h3 style="margin:0; color:#fff; font-size:16px; font-weight:bold;">${title} (Runde ${roundNum})</h3>
                <button id="close-modal-btn" style="background:transparent; border:none; color:#a1a1aa; font-size:20px; cursor:pointer; padding:0; line-height:1;">✕</button>
            </div>
            <div style="padding: 20px; overflow-y: auto; flex-grow: 1;">
                <div style="background: #27272a; border-radius: 8px; padding: 15px; border: 1px solid #3f3f46;">
                    ${formatHtml(rawText)}
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.getElementById('close-modal-btn').onclick = () => modal.remove();
    }

    function showVisionModal(rawText, guideUrl, country, imgBase64, roundNum) {
        const formatHtml = (text) => text.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#c084fc;">$1</strong>').replace(/\n/g, '<br>');

        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: #18181b; color: #e4e4e7; padding: 0; border-radius: 12px;
            max-width: 600px; width: 90%; max-height: 85vh; display: flex; flex-direction: column;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8); z-index: 10000;
            font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; line-height: 1.6;
            border: 1px solid #3f3f46; overflow: hidden;
        `;

        modal.innerHTML = `
            <div style="background: #27272a; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #3f3f46;">
                <h3 style="margin:0; color:#fff; font-size:16px; font-weight:bold;">✨ Gemini Meta Check (Runde ${roundNum})</h3>
                <button id="close-vision-modal-btn" style="background:transparent; border:none; color:#a1a1aa; font-size:20px; cursor:pointer; padding:0; line-height:1;">✕</button>
            </div>
            <div style="padding: 20px; overflow-y: auto; flex-grow: 1;">
                <img src="${imgBase64}" style="width:100%; border-radius:8px; border:1px solid #3f3f46; margin-bottom: 15px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3);" />
                <div style="background: #27272a; border-radius: 8px; padding: 15px; border: 1px solid #3f3f46;">
                    ${formatHtml(rawText)}
                </div>
            </div>
            <div style="padding: 15px 20px; background: #27272a; border-top: 1px solid #3f3f46; display: flex; justify-content: space-between; align-items: center;">
                <span style="color:#a1a1aa; font-size: 12px;">Erkanntes Land: <strong>${country}</strong></span>
                <a href="${guideUrl}" target="_blank" style="color:#a78bfa; font-size: 13px; text-decoration:none; font-weight:bold; background:#3f3f46; padding:6px 12px; border-radius:6px;">📚 Plonk It Guide öffnen ↗</a>
            </div>
        `;

        document.body.appendChild(modal);
        document.getElementById('close-vision-modal-btn').onclick = () => modal.remove();
    }
})();