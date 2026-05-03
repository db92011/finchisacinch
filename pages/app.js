/* app.js — Finch app logic (UI -> API -> output)
   - Calls Finch API
   - Updates output + char counter
   - Calls FinchPaywall.markUse() ONLY after real output is shown
   - Handles Copy + Clear
   - Stores user name only if they type it (no defaults)
   - Avoids newer JS syntax that breaks older Android WebViews
*/

(() => {
  if (window.__FINCH_APP_LOADED__ === true) return;
  window.__FINCH_APP_LOADED__ = true;

  console.log("APPJS RUNNING v77785 — " + new Date().toISOString());

  const NAME_KEY = "finch_owner_name";

  const $ = (id) => document.getElementById(id);

  const elName    = $("ownerName");
  const elTone    = $("tone");
  const elMode    = $("mode");
  const elOutlang = $("outlang");
  const elPaste   = $("paste");
  const elContext = $("context");

  const elAction  = $("actionBtn");
  const elClear   = $("clearBtn");
  const elCopy    = $("copyBtn");
  const elShare   = $("shareBtn");
  const elSaveProof = $("saveProofBtn");
  const elAttribution = $("includeAttribution");

  const elResult  = $("result");
  const elCount   = $("charCount");
  const elStatus  = $("status");

  const safeTrim = (s) => String(s || "").trim();

  function stripTrailingSlashes(v) {
    return String(v || "").replace(/\/+$/, "");
  }

  function getConfiguredApiBase() {
    const globalBase = safeTrim(window.__FINCH_API_BASE__);
    if (globalBase) return stripTrailingSlashes(globalBase);

    const meta = document.querySelector('meta[name="finch-api-base"]');
    const metaBase = safeTrim(meta && meta.getAttribute("content"));
    if (metaBase) return stripTrailingSlashes(metaBase);

    return stripTrailingSlashes(window.location.origin || "");
  }

  const API_URL = `${getConfiguredApiBase()}/api/finch`;

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg || "";
  }

  function setCount() {
    if (elCount && elResult) {
      elCount.textContent = String((elResult.value || "").length);
    }
  }

  function setWorking(isWorking) {
    if (!elAction) return;
    elAction.disabled = !!isWorking;
    elAction.textContent = isWorking ? "Working…" : "Let’s do this";
  }

  function saveNameIfUserTyped() {
    if (!elName) return;
    const v = safeTrim(elName.value);
    if (v) localStorage.setItem(NAME_KEY, v);
    else localStorage.removeItem(NAME_KEY);
  }

  function loadNameIfExists() {
    if (!elName) return;
    const saved = safeTrim(localStorage.getItem(NAME_KEY));
    if (saved) elName.value = saved;
  }

  function extractOutput(data) {
    if (!data) return "";
    if (typeof data === "string") return data.trim();

    const candidates = [
      data.output,
      data.result,
      data.text,
      data.response,
      data.message,
      data.data && data.data.output,
    ];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return "";
  }

  async function callFinch(payload) {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // If server didn’t return JSON, we still want a useful error object.
    if (!ct.includes("application/json")) {
      let text = "";
      try { text = await resp.text(); } catch (e) {}
      return { ok: resp.ok, status: resp.status, data: null, text };
    }

    let json = null;
    try { json = await resp.json(); } catch (e) {}
    return { ok: resp.ok, status: resp.status, data: json, text: "" };
  }

  function buildReplyContext(mode, rawContext) {
    const context = safeTrim(rawContext);
    if (mode !== "reply") return context;

    const guard = [
      "Reply mode speaker guard:",
      "- The pasted message is the incoming message to answer. Treat it as the other person's words and facts.",
      "- The optional context below is the user's reply intent, facts, and personal situation.",
      "- Write from the user's point of view only.",
      "- Do not claim facts from the incoming message as if they belong to the user.",
      "- If the optional context conflicts with the pasted message, trust the optional context for the user's facts."
    ].join("\n");

    if (!context) return guard;
    return [guard, "", "User reply intent/facts:", context].join("\n");
  }

  function buildApiInput(mode, pastedText, rawContext) {
    const input = safeTrim(pastedText);
    const context = safeTrim(rawContext);
    if (mode !== "reply") return input;

    return [
      "TASK: Write a natural reply from MY point of view. Do not write as the sender of the incoming message.",
      "",
      "INCOMING MESSAGE FROM THE OTHER PERSON:",
      input,
      "",
      "MY REPLY INTENT AND FACTS:",
      context || "Not provided. Infer a brief reply to the incoming message, but do not invent personal facts.",
      "",
      "Write only the ready-to-send reply."
    ].join("\n");
  }

  // Canonical copy source (prevents iOS mailto encoding bleed)
  let lastOutputText = "";
  let lastInputText = "";
  let lastProofMeta = {};

  function getProductLedSessionId() {
    const key = "finch_product_led_session";
    try {
      let existing = localStorage.getItem(key);
      if (existing) return existing;
      existing = (crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `finch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(key, existing);
      return existing;
    } catch (e) {
      return `finch_${Date.now()}`;
    }
  }

  function trackProductLedEvent(eventType, event = {}) {
    const payload = {
      session_id: getProductLedSessionId(),
      event_type: eventType,
      site_key: "circlethepeople",
      product_key: "finch",
      page_slug: "finch-app",
      event: {
        surface: "product_led_output",
        ...event,
      },
    };

    try {
      fetch("https://help.circlethepeople.com/api/tracking/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: payload.session_id,
          site_key: payload.site_key,
          first_page_slug: payload.page_slug,
          referrer: document.referrer || null,
        }),
        keepalive: true,
      }).catch(() => {});

      fetch("https://help.circlethepeople.com/api/tracking/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }

  function captureProductLedProof(proof) {
    try {
      fetch("https://help.circlethepeople.com/api/product-led/proof", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_slug: "finch",
          source: "finch_app",
          surface: "product_led_output",
          before_text: proof.before,
          after_text: proof.after,
          attribution_enabled: proof.attribution,
          context: {
            tone: proof.tone || null,
            mode: proof.mode || null,
            app_context: proof.context || null,
            surface: "finch_app",
            attribution: proof.attribution,
          },
        }),
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }

  function buildShareCard() {
    const before = safeTrim(lastInputText);
    const after = safeTrim(lastOutputText);
    const includeAttribution = !!(elAttribution && elAttribution.checked);
    const lines = [
      "Before:",
      before,
      "",
      "After:",
      after,
    ];

    if (includeAttribution) {
      lines.push("", "Made easier with Finch: https://circlethepeople.com/finch");
    }

    return lines.join("\n");
  }

  function saveProofDraft() {
    if (!lastOutputText || !lastInputText) return null;
    const proof = {
      id: `finch_proof_${Date.now()}`,
      product: "finch",
      created_at: new Date().toISOString(),
      before: lastInputText,
      after: lastOutputText,
      tone: lastProofMeta.tone || "",
      mode: lastProofMeta.mode || "",
      context: lastProofMeta.context || "",
      attribution: !!(elAttribution && elAttribution.checked),
    };

    try {
      const key = "finch_proof_drafts";
      const existing = JSON.parse(localStorage.getItem(key) || "[]");
      existing.unshift(proof);
      localStorage.setItem(key, JSON.stringify(existing.slice(0, 50)));
    } catch (e) {}

    return proof;
  }

  async function onRun() {
    const paste = safeTrim(elPaste && elPaste.value);
    if (!paste) {
      setStatus("Add a message first.");
      return;
    }

    setWorking(true);
    setStatus("");

    try {
      const toneVal = elTone ? elTone.value : "friendly";
      const modeVal = elMode ? elMode.value : "reply";
      const outlangVal = elOutlang ? elOutlang.value : "auto";
      const contextVal = safeTrim(elContext && elContext.value);
      const normalizedMode = modeVal || "reply";

      const payload = {
        input: buildApiInput(normalizedMode, paste, contextVal),
        raw_input: paste,
        context: buildReplyContext(normalizedMode, contextVal),
        user_context: contextVal,
        input_role: normalizedMode === "reply" ? "incoming_message_to_answer" : "user_draft",
        context_role: normalizedMode === "reply" ? "user_reply_intent_and_facts" : "style_or_situation_context",
        speaker_guard: {
          preserve_user_point_of_view: true,
          pasted_text_role: normalizedMode === "reply" ? "other_person_message" : "user_text",
          context_role: normalizedMode === "reply" ? "user_reply_intent_and_facts" : "style_or_situation_context",
          trust_context_for_user_facts: normalizedMode === "reply",
        },
        tone: toneVal || "friendly",
        mode: normalizedMode,
        outlang: outlangVal || "auto",
        signature: safeTrim(elName && elName.value),
      };

      const res = await callFinch(payload);
      const ok = !!res.ok;
      const status = res.status;
      const data = res.data;

      // IMPORTANT:
      // paywall.js returns a local 429 JSON when cap is hit.
      // worker can also return 429 when cap is hit server-side.
      if (!ok) {
        const serverMsg =
          (data && (data.message || data.error || data.detail)) ||
          (res.text || "");

        if (status === 429) {
          setStatus(serverMsg || "Daily limit reached. You’re out of uses for today.");
          return;
        }

        if (status === 403) {
          setStatus(serverMsg || "Access blocked.");
          return;
        }

        setStatus(serverMsg || ("Something went wrong. (Status " + (status || "?") + ")"));
        return;
      }

      if (!data) {
        setStatus("Something went wrong.");
        return;
      }

      const out = extractOutput(data);
      if (!out) {
        setStatus("This reply needs info. Add it to the Context box to finish.");
        if (elContext) elContext.focus();
        return;
      }

      lastOutputText = out;
      lastInputText = paste;
      lastProofMeta = {
        tone: toneVal || "friendly",
        mode: modeVal || "reply",
        context: safeTrim(elContext && elContext.value),
      };
      if (elResult) elResult.value = out;
      setCount();
      setStatus("Done.");
      trackProductLedEvent("output_generated", {
        tone: lastProofMeta.tone,
        mode: lastProofMeta.mode,
        input_length: paste.length,
        output_length: out.length,
      });

      if (window.FinchPaywall && typeof window.FinchPaywall.markUse === "function") {
        window.FinchPaywall.markUse();
      }

      saveNameIfUserTyped();
    } catch (e) {
      setStatus("Network error.");
    } finally {
      setWorking(false);
    }
  }

  async function onCopy() {
    if (!lastOutputText) return;

    const btn = document.getElementById("copyBtn");

    function animate() {
      if (!btn) return;
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 700);
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(lastOutputText);
      } else {
        throw new Error("clipboard-unavailable");
      }
      setStatus("Copied.");
      animate();
      trackProductLedEvent("output_copied", {
        tone: lastProofMeta.tone || null,
        mode: lastProofMeta.mode || null,
      });
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = lastOutputText;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setStatus("Copied.");
      animate();
      trackProductLedEvent("output_copied", {
        tone: lastProofMeta.tone || null,
        mode: lastProofMeta.mode || null,
        fallback: true,
      });
    }
  }

  async function onShareCard() {
    if (!lastOutputText || !lastInputText) {
      setStatus("Run Finch first, then share the card.");
      return;
    }

    const text = buildShareCard();
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Finch before and after",
          text,
        });
        setStatus("Shared.");
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        setStatus("Share card copied.");
      } else {
        throw new Error("share-unavailable");
      }
      trackProductLedEvent("output_shared", {
        tone: lastProofMeta.tone || null,
        mode: lastProofMeta.mode || null,
        attribution: !!(elAttribution && elAttribution.checked),
      });
    } catch (e) {
      if (String(e && e.name) === "AbortError") return;
      setStatus("Could not share. Copy still works.");
    }
  }

  function onSaveProof() {
    const proof = saveProofDraft();
    if (!proof) {
      setStatus("Run Finch first, then save the proof.");
      return;
    }
    setStatus("Proof saved on this device.");
    captureProductLedProof(proof);
    trackProductLedEvent("proof_saved", {
      tone: proof.tone || null,
      mode: proof.mode || null,
      attribution: proof.attribution,
    });
  }

  function onClear() {
    if (elPaste) elPaste.value = "";
    if (elContext) elContext.value = "";
    if (elResult) elResult.value = "";
    lastOutputText = "";
    lastInputText = "";
    lastProofMeta = {};
    setCount();
    setStatus("");
  }

  function init() {
    loadNameIfExists();
    setCount();

    if (elAction) elAction.addEventListener("click", onRun);
    if (elCopy) elCopy.addEventListener("click", onCopy);
    if (elShare) elShare.addEventListener("click", onShareCard);
    if (elSaveProof) elSaveProof.addEventListener("click", onSaveProof);
    if (elClear) elClear.addEventListener("click", onClear);
    if (elResult) elResult.addEventListener("input", setCount);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
