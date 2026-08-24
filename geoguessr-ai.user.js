// ==UserScript==
// @name         GeoGuessr AI Clue Analyzer
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Analysiert die letzte Location per KI auf Plonk It & Meta Clues
// @match        https://www.geoguessr.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @updateURL   https://raw.githubusercontent.com/dein-username/repo-name/main/geoguessr-ai.user.js
// @downloadURL https://raw.githubusercontent.com/dein-username/repo-name/main/geoguessr-ai.user.js
// ==UserScript==

(function () {
    'use strict';

    // --- EINSTELLUNGEN SPEICHERN ---
    // Einstellungen im Tampermonkey-Menü konfigurieren
    GM_registerMenuCommand("API Key festlegen", () => {
        const key = prompt("Gib deinen OpenAI API Key ein:", GM_getValue("openai_key", ""));
        if (key !== null) GM_setValue("openai_key", key);
    });

    GM_registerMenuCommand("Modus umschalten (PlonkIt / General)", () => {
        const current = GM_getValue("mode", "plonkit");
        const next = current === "plonkit" ? "general" : "plonkit";
        GM_setValue("mode", next);
        alert(`Modus geändert auf: ${next === "plonkit" ? "Nur Plonk It" : "Ganzes Wissen"}`);
    });

    let lastLocation = null;

    // --- 1. KOORDINATEN AUS API ABFANGEN ---
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        if (typeof args[0] === 'string' && args[0].includes('/api/v3/games/')) {
            const clone = response.clone();
            clone.json().then(data => {
                if (data && data.rounds && data.rounds.length > 0) {
                    // Letzte gespielte Runde holen
                    const currentRoundIdx = data.round - 1;
                    const roundData = data.rounds[currentRoundIdx];
                    if (roundData) {
                        lastLocation = {
                            lat: roundData.lat,
                            lng: roundData.lng,
                            countryCode: roundData.countryCode
                        };
                    }
                }
            });
        }
        return response;
    };

    // --- 2. ERGEBNIS-BILDSCHIRM ERKENNEN & BUTTON EINFÜGEN ---
    const observer = new MutationObserver(() => {
        // Prüfen, ob wir auf dem Ergebnis-Bildschirm sind und der Button noch nicht existiert
        const resultScreen = document.querySelector('[class*="result-layout_root"]') || document.querySelector('[class*="game-summary"]');
        
        if (resultScreen && !document.getElementById('ai-analyze-btn')) {
            injectButton(resultScreen);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    function injectButton(parent) {
        const btn = document.createElement('button');
        btn.id = 'ai-analyze-btn';
        btn.innerText = '🔍 KI Clues scannen';
        btn.style.cssText = `
            margin: 10px;
            padding: 10px 15px;
            background: #6b46c1;
            color: white;
            border: none;
            border-radius: 5px;
            font-weight: bold;
            cursor: pointer;
            z-index: 9999;
        `;

        btn.onclick = () => runAiAnalysis(btn);
        parent.appendChild(btn);
    }

    // --- 3. KI-ANFRAGE SENDEN ---
    function runAiAnalysis(btn) {
        const apiKey = GM_getValue("openai_key", "");
        const mode = GM_getValue("mode", "plonkit");

        if (!apiKey) {
            alert("Bitte zuerst deinen OpenAI API-Key über das Tampermonkey-Menü eingeben!");
            return;
        }

        if (!lastLocation) {
            alert("Keine Standortdaten für diese Runde gefunden.");
            return;
        }

        btn.innerText = "⏳ Scanne Clues...";
        btn.disabled = true;

        const systemPrompt = mode === "plonkit"
            ? "Du bist ein GeoGuessr-Experte. Nutze AUSSCHLIESSLICH verifizierte Plonk It Guides & Meta-Wissen (Bollards, Pfähle, Kamera-Gens, Kennzeichen, Schilderrückseiten, Strommasten). Antworte stichpunktartig und extrem präzise auf Deutsch."
            : "Du bist ein GeoGuessr- und Geografie-Experte. Nutze dein gesamtes Wissen über Geografie, Plonk It Meta, Sprache, Landschaft, Infrastruktur und Kultur. Antworte strukturiert und stichpunktartig auf Deutsch.";

        const userPrompt = `Analysiere folgenden Standort für GeoGuessr:
Landkreis/Code: ${lastLocation.countryCode}
Koordinaten: Lat ${lastLocation.lat}, Lng ${lastLocation.lng}

Welche spezifischen Meta-Clues, Plonk-It-Tipps oder Merkmale sind für diese genaue Region/Land typisch?`;

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            data: JSON.stringify({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ]
            }),
            onload: function (response) {
                btn.disabled = false;
                btn.innerText = '🔍 KI Clues scannen';
                
                if (response.status === 200) {
                    const resData = JSON.parse(response.responseText);
                    const answer = resData.choices[0].message.content;
                    showResultModal(answer);
                } else {
                    alert("Fehler bei der KI-Anfrage: " + response.responseText);
                }
            }
        });
    }

    // --- 4. OVERLAY FÜR DIE ERGEBNISSE ---
    function showResultModal(text) {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #1a1a2e;
            color: white;
            padding: 20px;
            border-radius: 10px;
            max-width: 500px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 0 20px rgba(0,0,0,0.8);
            z-index: 10000;
            font-family: sans-serif;
            line-height: 1.5;
        `;

        modal.innerHTML = `
            <h3 style="margin-top:0; color:#8b5cf6;">KI Meta Analyse</h3>
            <div style="white-space: pre-wrap;">${text}</div>
            <button id="close-modal-btn" style="margin-top: 15px; padding: 8px 12px; background: #333; color: white; border: none; border-radius: 4px; cursor: pointer;">Schließen</button>
        `;

        document.body.appendChild(modal);
        document.getElementById('close-modal-btn').onclick = () => modal.remove();
    }
})();
