export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ============================================================
    // CORS + JSON helper
    // ============================================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-finch-email, x-finch-device, Authorization",
      "Access-Control-Expose-Headers": "x-finch-device",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (obj, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
          ...extraHeaders,
        },
      });

    // ============================================================
    // GUARDS
    // ============================================================
    if (!env.FINCH_KV) {
      if (path === "/api/health") {
        return json({
          ok: true,
          has_openai_key: !!env.OPENAI_API_KEY,
          has_kv: false,
        });
      }
      return json({ error: "KV not configured (FINCH_KV)" }, 500);
    }

    // ============================================================
    // CONSTANTS
    // ============================================================
    const FREE_DAILY_CAP = 3;
    const PLUS_DAILY_CAP = 200;
    const MAX_DEVICES_PER_EMAIL = 2;
    const FREE_ACCOUNT_EMAILS = new Set(["danbrooking@gmail.com"]);

    const subscribeUrl = "https://buy.stripe.com/3cIdR90dd5Fd4CR1CX4ow01?prefilled_email=danbrooking%40gmail.com";

    // ============================================================
    // HELPERS
    // ============================================================
    const safeLower = (v) => String(v || "").trim().toLowerCase();
    const utcDay = () => new Date().toISOString().slice(0, 10);
    const nowSec = () => Math.floor(Date.now() / 1000);

    const asInt = (v) => (typeof v === "number" ? v : parseInt(v || "0", 10) || 0);

    function getCookie(req, name) {
      const cookie = req.headers.get("Cookie") || "";
      return (
        cookie
          .split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith(name + "="))
          ?.split("=")[1] || ""
      );
    }

    function getOrCreateFinchId(req) {
      const existing = getCookie(req, "finch_id");
      if (existing) return { id: existing, setCookie: "" };

      const id = crypto.randomUUID();
      return {
        id,
        setCookie: `finch_id=${id}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
      };
    }

    async function readJsonSafe(req) {
      try {
        const ct = (req.headers.get("Content-Type") || "").toLowerCase();
        if (!ct.includes("application/json")) return null;
        return await req.json();
      } catch {
        return null;
      }
    }

    const freeUsageKey = (id) => `usage:free:${id}:${utcDay()}`;
    const plusUsageKey = (email) => `usage:plus:${email}:${utcDay()}`;

    const readUsed = async (key) => Number(await env.FINCH_KV.get(key)) || 0;
    const writeUsed = async (key, used) =>
      env.FINCH_KV.put(key, String(used), { expirationTtl: 60 * 60 * 36 });

    // ---- Stripe signature helpers (Cloudflare-safe)
    const hexToBytes = (hex) => {
      const clean = (hex || "").trim();
      if (!clean || clean.length % 2 !== 0) return null;
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < clean.length; i += 2) {
        const byte = parseInt(clean.slice(i, i + 2), 16);
        if (Number.isNaN(byte)) return null;
        out[i / 2] = byte;
      }
      return out;
    };

    const constantTimeEqual = (aBytes, bBytes) => {
      if (!aBytes || !bBytes) return false;
      const aLen = aBytes.length;
      const bLen = bBytes.length;
      const len = Math.max(aLen, bLen);
      let diff = aLen ^ bLen;
      for (let i = 0; i < len; i++) {
        const a = i < aLen ? aBytes[i] : 0;
        const b = i < bLen ? bBytes[i] : 0;
        diff |= a ^ b;
      }
      return diff === 0;
    };

    // ---- Device id fallback (seat enforcement)
    function base64UrlEncode(bytes) {
      let str = "";
      for (const b of bytes) str += String.fromCharCode(b);
      return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    async function sha256Base64Url(input) {
      const data = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return base64UrlEncode(new Uint8Array(digest));
    }

    async function getDeviceId(req, bodyObj) {
      const hdr = (req.headers.get("x-finch-device") || "").trim();
      const body =
        bodyObj && (bodyObj.device_id || bodyObj.deviceId)
          ? String(bodyObj.device_id || bodyObj.deviceId).trim()
          : "";

      if (hdr) return hdr;
      if (body) return body;

      const finchId = getCookie(req, "finch_id") || "no_finch_id";
      const ua = req.headers.get("User-Agent") || "no_ua";
      const lang = req.headers.get("Accept-Language") || "no_lang";
      const raw = `finch:${finchId}|ua:${ua}|lang:${lang}`;
      const hash = await sha256Base64Url(raw);
      return `dev_${hash.slice(0, 22)}`;
    }

    // ---- Seats enforcement (WRITES seats when allowed)
    async function enforceSeats(emailRaw, deviceId) {
      const email = safeLower(emailRaw);
      if (!email) return { allowed: false, reason: "MISSING_EMAIL", seatsUsed: 0, seatsMax: MAX_DEVICES_PER_EMAIL };
      if (!deviceId) return { allowed: false, reason: "MISSING_DEVICE_ID", seatsUsed: 0, seatsMax: MAX_DEVICES_PER_EMAIL };

      const key = `devices:${email}`;
      const now = nowSec();

      let record = await env.FINCH_KV.get(key, { type: "json" }).catch(() => null);
      if (!record || typeof record !== "object") record = { max: MAX_DEVICES_PER_EMAIL, devices: [] };
      if (!Array.isArray(record.devices)) record.devices = [];
      record.max = MAX_DEVICES_PER_EMAIL;

      record.devices = record.devices
        .filter((d) => d && typeof d.id === "string")
        .map((d) => ({
          id: d.id,
          firstSeen: Number(d.firstSeen) || now,
          lastSeen: Number(d.lastSeen) || now,
        }));

      const existing = record.devices.find((d) => d.id === deviceId);
      if (existing) {
        existing.lastSeen = now;
        await env.FINCH_KV.put(key, JSON.stringify(record));
        return { allowed: true, reason: null, seatsUsed: record.devices.length, seatsMax: record.max };
      }

      if (record.devices.length < record.max) {
        record.devices.push({ id: deviceId, firstSeen: now, lastSeen: now });
        await env.FINCH_KV.put(key, JSON.stringify(record));
        return { allowed: true, reason: null, seatsUsed: record.devices.length, seatsMax: record.max };
      }

      return { allowed: false, reason: "DEVICE_LIMIT_REACHED", seatsUsed: record.devices.length, seatsMax: record.max };
    }

    // ---- Seats READ ONLY (no side effects)
    async function readSeats(emailLower) {
      const key = `devices:${emailLower}`;
      const rec = await env.FINCH_KV.get(key, { type: "json" }).catch(() => null);

      const max = MAX_DEVICES_PER_EMAIL;
      const devices = Array.isArray(rec?.devices)
        ? rec.devices
            .filter((d) => d && typeof d.id === "string")
            .map((d) => ({
              id: d.id,
              firstSeen: Number(d.firstSeen) || 0,
              lastSeen: Number(d.lastSeen) || 0,
            }))
        : [];

      return { max, devices };
    }

    async function removeOldestDeviceForEmail(emailLower) {
      const key = `devices:${emailLower}`;
      const rec = await env.FINCH_KV.get(key, { type: "json" }).catch(() => null);

      if (!rec || !Array.isArray(rec.devices) || rec.devices.length === 0) {
        return { ok: true, removed: null, remaining: 0 };
      }

      const devices = rec.devices
        .filter((d) => d && typeof d.id === "string")
        .map((d) => ({
          id: d.id,
          firstSeen: Number(d.firstSeen) || 0,
          lastSeen: Number(d.lastSeen) || 0,
        }))
        .sort((a, b) => a.firstSeen - b.firstSeen);

      const removed = devices.shift() || null;
      await env.FINCH_KV.put(key, JSON.stringify({ max: MAX_DEVICES_PER_EMAIL, devices }));
      return { ok: true, removed: removed?.id || null, remaining: devices.length };
    }

    async function rateLimit(key, limit, ttlSeconds) {
      const current = Number(await env.FINCH_KV.get(key)) || 0;
      if (current >= limit) return false;
      await env.FINCH_KV.put(key, String(current + 1), { expirationTtl: ttlSeconds });
      return true;
    }

    // ---- Plan lookup (from KV)
    async function getPlanForEmail(email) {
      if (!email) return { plan: "free", status: "none", access_until: 0 };
      if (FREE_ACCOUNT_EMAILS.has(safeLower(email))) {
        return { plan: "plus", status: "free_access", access_until: Number.MAX_SAFE_INTEGER };
      }

      const raw = await env.FINCH_KV.get(`plus:${safeLower(email)}`);
      const rec = raw ? JSON.parse(raw) : null;

      const now = Date.now();
      const accessUntil = Number(rec?.access_until) || 0;

      const isPlus =
        rec?.status === "active" ||
        (rec?.status === "canceling" && accessUntil > now);

      return { plan: isPlus ? "plus" : "free", status: rec?.status || "none", access_until: accessUntil || 0 };
    }

    // ============================================================
    // Tone normalization
    // ============================================================
    const normalizeTone = (toneRaw, messageText, contextText = "") => {
      const t = safeLower(toneRaw);
      const msg = safeLower(messageText);
      const ctx = safeLower(contextText);

      const unfilteredAliases = [
        "unfiltered","uncensored","raw","edgy","spicy","spicey",
        "savage","roast","roasty","no filter","nofilter",
        "mean","make it mean","make it harsh","brutal",
        "salty","cutting","ruthless","no chill",
        "cuss","cuss word","cuss words","add cuss","add cuss words",
        "swear","swears","swear word","swear words","add swear","add swear words",
        "profanity","profane","add profanity","drop f bombs","drop f-bombs",
        "f bomb","f-bomb","fuck","fucking","bullshit"
      ];
      const snarkAliases = ["snarky","snark","sassy","sarcastic","dry","witty","smartass","smart-ass"];
      const funnyAliases = ["funny","comedy","joke","rofl","lol","lmao"];
      const businessAliases = ["business","professional","formal","corporate"];
      const casualAliases = ["casual","chill","friendly","normal"];

      const genzSignals = [
        "rizz","riz","drip","slay","ate","no cap","cap","based",
        "mid","bet","lowkey","highkey","fr","ong","bruh","bro",
        "stan","fire","bussin","sus","ratio","iykyk","periodt",
        "zesty","gagged","yap","yapping"
      ];
      const alphaSignals = [
        "skibidi","toilet","gyat","gyatt","sigma","sigma grindset",
        "fanum","fanum tax","ohio","rizzler","npc","aura","mewing",
        "looksmax","mog","mogged","glaze","glazing"
      ];

      const hasAny = (arr) => arr.some((x) => t === x || t.includes(x));
      const msgHasAny = (arr) => arr.some((x) => msg.includes(x));
      const ctxHasAny = (arr) => arr.some((x) => ctx.includes(x));

      if (ctxHasAny(unfilteredAliases)) return "unfiltered";
      if (ctxHasAny(snarkAliases)) return "snarky";
      if (ctxHasAny(funnyAliases)) return "funny";
      if (ctxHasAny(businessAliases)) return "business";
      if (ctxHasAny(casualAliases)) return "casual";
      if (hasAny(unfilteredAliases)) return "unfiltered";
      if (hasAny(snarkAliases)) return "snarky";
      if (hasAny(funnyAliases)) return "funny";
      if (hasAny(businessAliases)) return "business";
      if (hasAny(casualAliases)) return "casual";

      if (msgHasAny(alphaSignals)) return "alpha";
      if (msgHasAny(genzSignals)) return "genz";

      return t || "friendly";
    };

      function isSensitiveMoment(text) {
        const value = safeLower(text);
        return [
          "death",
          "died",
          "funeral",
          "grief",
          "cancer",
          "hospital",
          "suicide",
          "self harm",
          "self-harm",
          "abuse",
          "violence",
          "threat",
          "lawyer",
          "legal",
          "termination",
          "layoff",
          "fired",
        ].some((word) => value.includes(word));
      }

    // ============================================================
    // HEALTH
    // ============================================================
    if (path === "/api/health") {
      return json({
        ok: true,
        endpoints: ["/api/finch", "/api/plan", "/api/entitlements", "/api/devices/remove-oldest", "/api/stripe/webhook"],
        caps: { free: FREE_DAILY_CAP, plus: PLUS_DAILY_CAP, seats: MAX_DEVICES_PER_EMAIL },
        has_openai_key: !!env.OPENAI_API_KEY,
        has_kv: !!env.FINCH_KV,
        has_stripe_webhook_secret: !!env.STRIPE_WEBHOOK_SECRET,
      });
    }

    // ============================================================
    // STRIPE WEBHOOK
    // ============================================================
    if (path === "/api/stripe/webhook" && request.method === "POST") {
      const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });

      const sigHeader = request.headers.get("stripe-signature");
      if (!sigHeader) return new Response("Missing Stripe signature", { status: 400 });

      const rawBody = await request.text();

      let timestamp = null;
      const v1Sigs = [];
      for (const part of sigHeader.split(",")) {
        const [kRaw, vRaw] = part.split("=");
        const k = (kRaw || "").trim();
        const v = (vRaw || "").trim();
        if (k === "t") timestamp = v;
        if (k === "v1") v1Sigs.push(v);
      }
      if (!timestamp || v1Sigs.length === 0) return new Response("Invalid Stripe signature header", { status: 400 });

      const encoder = new TextEncoder();
      const payload = `${timestamp}.${rawBody}`;

      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
      const expectedHex = Array.from(new Uint8Array(signed)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const expectedBytes = hexToBytes(expectedHex);

      let ok = false;
      for (const sigHex of v1Sigs) {
        const sigBytes = hexToBytes(sigHex);
        if (constantTimeEqual(expectedBytes, sigBytes)) { ok = true; break; }
      }
      if (!ok) return new Response("Webhook signature verification failed", { status: 400 });

      let event = null;
      try { event = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }

      const data = event?.data?.object || {};
      const email =
        data?.customer_details?.email ||
        data?.customer_email ||
        data?.billing_details?.email;

      if (!email) return new Response("ok", { status: 200 });

      const emailLower = safeLower(email);
      const kvKey = `plus:${emailLower}`;
      const nowMs = Date.now();

      const periodEndSec =
        asInt(data?.current_period_end) ||
        asInt(data?.lines?.data?.[0]?.period?.end) ||
        0;

      const accessUntilMs = periodEndSec ? periodEndSec * 1000 : nowMs;
      const cancelAtPeriodEnd = !!data?.cancel_at_period_end;

      if (event.type === "customer.subscription.deleted") {
        await env.FINCH_KV.put(kvKey, JSON.stringify({
          status: "ended",
          access_until: nowMs,
          cancel_at_period_end: false,
          updated: nowMs,
          source: event.type,
        }));
      } else if (
        event.type === "checkout.session.completed" ||
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated"
      ) {
        const status = cancelAtPeriodEnd ? "canceling" : "active";
        await env.FINCH_KV.put(kvKey, JSON.stringify({
          status,
          access_until: accessUntilMs,
          cancel_at_period_end: cancelAtPeriodEnd,
          updated: nowMs,
          source: event.type,
        }));
      }

      return new Response("ok", { status: 200 });
    }

    // ============================================================
    // PLAN CHECK (enforces seats for Plus)
    // ============================================================
    if (path === "/api/plan" && request.method === "POST") {
      const { setCookie } = getOrCreateFinchId(request);

      const bodyObj = (await readJsonSafe(request)) || {};
      const email = safeLower(bodyObj?.email || request.headers.get("x-finch-email") || "");
      if (!email) return json({ error: "Missing email" }, 400, setCookie ? { "Set-Cookie": setCookie } : {});

      const rec = await getPlanForEmail(email);

      if (rec.plan === "plus") {
        const deviceId = await getDeviceId(request, bodyObj);
        const seat = await enforceSeats(email, deviceId);

        if (!seat.allowed) {
          return json({
            plan: "plus",
            status: rec.status,
            allowed: false,
            reason: seat.reason,
            seatsUsed: seat.seatsUsed,
            seatsMax: seat.seatsMax,
            message: `You’ve already used Finch Plus on ${seat.seatsMax} devices.`,
          }, 403, setCookie ? { "Set-Cookie": setCookie } : {});
        }

        return json({
          plan: "plus",
          status: rec.status,
          allowed: true,
          seatsUsed: seat.seatsUsed,
          seatsMax: seat.seatsMax,
        }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      return json({ plan: "free", status: rec.status }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
    }

    // ============================================================
    // DEVICE MGMT (remove oldest)
    // ============================================================
    if (path === "/api/devices/remove-oldest" && request.method === "POST") {
      const { setCookie } = getOrCreateFinchId(request);

      const bodyObj = (await readJsonSafe(request)) || {};
      const email = safeLower(bodyObj?.email || request.headers.get("x-finch-email") || "");
      if (!email) return json({ ok: false, error: "missing_email" }, 400, setCookie ? { "Set-Cookie": setCookie } : {});

      const planRec = await getPlanForEmail(email);
      if (planRec.plan !== "plus") {
        return json({ ok: false, error: "not_plus", message: "That email isn’t Finch Plus." }, 403, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const rlOk = await rateLimit(`rl:remove-oldest:${email}:${utcDay()}:${Math.floor(Date.now() / 3600000)}`, 5, 60 * 60);
      if (!rlOk) {
        return json({ ok: false, error: "rate_limited", message: "Too many requests. Try again in a bit." }, 429, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const deviceId = await getDeviceId(request, bodyObj);
      const seats = await readSeats(email);
      const isKnown = seats.devices.some((d) => d.id === deviceId);
      const isBlocked = seats.devices.length >= seats.max && !isKnown;

      if (!isKnown && !isBlocked) {
        return json({ ok: false, error: "not_allowed", message: "This device isn’t eligible to manage seats for that email." }, 403, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const removed = await removeOldestDeviceForEmail(email);
      return json({
        ok: true,
        removed_device_id: removed.removed,
        remaining_devices: removed.remaining,
        message: "Oldest device removed. Tap Continue again to unlock this device.",
      }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
    }

    // ============================================================
    // ENTITLEMENTS
    // ============================================================
    if (path === "/api/entitlements") {
      const { id, setCookie } = getOrCreateFinchId(request);

      const email = safeLower(url.searchParams.get("email") || "");
      const rec = email ? await getPlanForEmail(email) : { plan: "free", status: "none" };

      if (rec.plan === "plus") {
        const used = await readUsed(plusUsageKey(email));
        return json({
          plan: "plus",
          status: rec.status,
          cap: PLUS_DAILY_CAP,
          used_today: used,
          remaining_today: Math.max(0, PLUS_DAILY_CAP - used),
          subscribe_url: subscribeUrl,
        }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const used = await readUsed(freeUsageKey(id));
      return json({
        plan: "free",
        status: rec.status,
        cap: FREE_DAILY_CAP,
        used_today: used,
        remaining_today: Math.max(0, FREE_DAILY_CAP - used),
        subscribe_url: subscribeUrl,
      }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
    }

    // ============================================================
    // FINCH CORE
    // ============================================================
    if ((path === "/api/finch" || path === "/api") && request.method === "POST") {
      const { id, setCookie } = getOrCreateFinchId(request);

      let body = null;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const message = String(body?.message || body?.input || "").trim();
      const rawInput = String(body?.raw_input || body?.rawInput || message).trim();
      if (!message) {
        return json({ output: "Paste a message first." }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const emailFromBody = safeLower(body?.email);
      const emailFromHeader = safeLower(request.headers.get("x-finch-email") || "");
      const email = emailFromBody || emailFromHeader;

      const planRec = email ? await getPlanForEmail(email) : { plan: "free", status: "none" };
      const isPlus = planRec.plan === "plus";

      // Seat enforcement (READ ONLY) for Plus requests (prevents bypassing /api/plan)
      if (isPlus) {
        const deviceId = await getDeviceId(request, body);
        const seats = await readSeats(email);
        const isKnown = seats.devices.some((d) => d.id === deviceId);
        const isBlocked = seats.devices.length >= seats.max && !isKnown;

        if (isBlocked) {
          return json({
            allowed: false,
            plan: "plus",
            reason: "DEVICE_LIMIT_REACHED",
            seatsUsed: seats.devices.length,
            seatsMax: seats.max,
            message: `You’ve already used Finch Plus on ${seats.max} devices.`,
          }, 403, setCookie ? { "Set-Cookie": setCookie } : {});
        }
      }

      // Cap checks BEFORE OpenAI
      if (isPlus) {
        const usedPlus = await readUsed(plusUsageKey(email));
        if (usedPlus >= PLUS_DAILY_CAP) {
          return json({
            allowed: false,
            reason: "plus_limit_reached",
            plan: "plus",
            cap: PLUS_DAILY_CAP,
            used_today: usedPlus,
            remaining_today: 0,
            message: `Daily limit reached. You’ve used all ${PLUS_DAILY_CAP} runs for today.`,
          }, 429, setCookie ? { "Set-Cookie": setCookie } : {});
        }
      } else {
        const usedFree = await readUsed(freeUsageKey(id));
        if (usedFree >= FREE_DAILY_CAP) {
          return json({
            allowed: false,
            reason: "free_limit_reached",
            subscribe_url: subscribeUrl,
            plan: "free",
            cap: FREE_DAILY_CAP,
            used_today: usedFree,
            remaining_today: 0,
          }, 429, setCookie ? { "Set-Cookie": setCookie } : {});
        }
      }

      const mode = safeLower(body?.mode || "reply");
      const outlang = safeLower(body?.outlang || "auto");

      const context = String(body?.context || "").trim();
      const userContext = String(body?.user_context || body?.userContext || "").trim();
      const rawTone = body?.tone || "friendly";
      const tone = normalizeTone(rawTone, message, `${context}\n${userContext}`);
      const signature = String(body?.signature || body?.ownerName || "").trim();

      // Strong context weighting (separate system message)
      const contextBlock = context
        ? `BINDING CONTEXT (must be followed exactly; do not ignore):
${context}

Hard rules:
- Treat this as facts + constraints.
- If it changes tone/goal/relationship, obey it.
- Do not invent anything not in the user message or this context.`
        : `BINDING CONTEXT: (none)`;

      const languageLine =
        outlang && outlang !== "auto"
          ? `Output language: ${outlang}.`
          : `Output language: match the user's language unless they asked otherwise.`;

      const toneLine = (() => {
        if (tone === "unfiltered") {
          return `Tone: UNFILTERED.
This mode is allowed to swear. Do not sanitize it into polite business copy.
Requirements:
- Include 2-4 natural profanity words when the situation is not sensitive. Examples allowed: damn, hell, bullshit, fucking.
- If the user explicitly asks for cuss words, satisfy that request.
- Make it sharper, more candid, and more emotionally honest than Friendly or Casual.
- Snark is allowed; cruelty is not.
- Do not use slurs, hate, threats, harassment, sexual degradation, or degrading protected traits.
- Do not attack a person's identity; if you jab, jab the situation, behavior, or inconvenience.
- Keep it readable and sendable, not try-hard.`;
        }
        if (tone === "snarky") {
          return `Tone: snarky, dry, and witty.
- One or two sharp lines max.
- No cruelty, insults, or personal attacks.
- Aim for clever, not aggressive.`;
        }
        if (tone === "genz") {
          return `Tone: Gen Z-coded, modern, punchy.
- Use slang lightly (1–3 terms max) so it sounds natural, not forced.
- Keep it readable and not chaotic.
- No hate, no threats, no cruelty.`;
        }
        if (tone === "alpha") {
          return `Tone: Gen Alpha / internet-brainrot-adjacent, but still usable.
- Sprinkle 1–2 playful terms only if it fits (don’t spam).
- Keep clarity first, meme second.
- No hate, no threats, no cruelty.`;
        }
        if (tone === "funny") {
          return `Tone: FUNNY.
This mode must be actually funny, not merely cheerful or lighthearted.
Performance rules:
- Commit to a real joke, turn, or punchline.
- Use one specific image, one exaggeration, or one unexpected analogy.
- Add one quick self-aware jab at the sender or situation, not at the recipient.
- Prefer plain spoken comedy over corporate cuteness.
- Avoid soft filler like "hope you're well", "just checking in", "touching base", and therapy-office phrasing.
- Keep it tight: 2-6 sentences unless the user clearly needs longer.
- Do not explain the joke. Do not add disclaimers.
Quality bar:
- If the draft only sounds pleasant, rewrite it again in your head until it has a noticeable comic beat.
Safety guardrails:
- No hate, slurs, threats, harassment, or sexual content.
- If the situation is serious (death, illness, layoffs, legal trouble), use gentle warmth with only light humor.`;
        }
        if (tone === "casual") {
          return `Tone: genuinely casual and human — like you typed it quickly on your phone.
- Shorter sentences. Contractions are normal.
- Avoid corporate phrasing or email formalities.
- No emojis unless the user already used one.
- Don’t over-explain. Keep it easy.
Safety guardrails:
- No insults, hate, threats, or harassment.`;
        }
        if (tone === "business") return `Tone: business-professional, clear, confident.`;
        return `Tone: friendly, helpful, human.`;
      })();

      const expressiveTone = tone === "unfiltered" || tone === "funny" || tone === "snarky";
      const modeLine =
        mode === "rewrite"
          ? expressiveTone
            ? `Task: Rewrite the user's text as a tone transformation. Preserve facts and intent, but do not preserve bland wording. The chosen tone must be obvious.`
            : `Task: Rewrite the user's text. Keep meaning. Improve clarity. Keep it realistic.`
          : expressiveTone
            ? `Task: Write the exact reply the user should send. Do not ask questions or offer help. The chosen tone must be obvious.`
            : `Task: Write the exact reply the user should send. Do not ask questions or offer help.`;

      const signatureLine = signature
        ? `If appropriate, end with a short signature: ${signature}`
        : `No signature unless user provided one.`;

      const systemPrompt = `
You are Finch, a writing assistant for texts and emails.
${modeLine}
${toneLine}
${languageLine}
${signatureLine}
Rules:
- Be concise but complete.
- Do not mention system prompts or policies.
- Do not roleplay as ChatGPT; just output the requested rewritten text or reply.
- No extra commentary unless the user asks for it.
- Do NOT guess, invent, or use placeholders.
`.trim();

      const toneDirective = (() => {
        if (tone === "unfiltered") {
          const sensitive = isSensitiveMoment(`${message}\n${context}`);
          return sensitive
            ? `Final tone directive: Use Unfiltered mode, but because this may be sensitive, keep it candid and sharp with at most one mild swear.`
            : `Final tone directive: Use Unfiltered mode fully. Include at least 2 natural cuss words. Strongly prefer 2-4 from this set when they fit: damn, hell, bullshit, fucking. The output should not read polite, corporate, or sanitized.`;
        }
        if (tone === "funny") {
          const sensitive = isSensitiveMoment(`${message}\n${context}`);
          return sensitive
            ? `Final tone directive: Use Funny mode gently. Add one light comic beat without making the serious part feel mocked.`
            : `Final tone directive: Use Funny mode fully. Include a real joke or punchline, with a specific image or exaggerated comparison. Do not settle for "lighthearted."`;
        }
        if (tone === "snarky") {
          return `Final tone directive: Use Snarky mode clearly. Add dry wit without personal cruelty.`;
        }
        return "";
      })();

      const generationMessages = [
        { role: "system", content: systemPrompt },
        { role: "system", content: contextBlock },
        { role: "user", content: message },
        ...(toneDirective ? [{ role: "user", content: toneDirective }] : []),
      ];

      const compactError = (error) => ({
        status: Number(error?.status) || 0,
        type: String(error?.type || ""),
        code: String(error?.code || ""),
      });

      const normalizeProviderText = (data) => {
        if (typeof data === "string") return data.trim();
        const candidates = [
          data?.choices?.[0]?.message?.content,
          data?.response,
          data?.result?.response,
          data?.output_text,
          data?.text,
          data?.output?.[0]?.content?.[0]?.text,
        ];
        for (const candidate of candidates) {
          if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
        }
        return "";
      };

      const countProfanity = (text) => {
        const matches = safeLower(text).match(/\b(damn|hell|bullshit|shit|fucking|fuck)\b/g);
        return matches ? matches.length : 0;
      };

      const hasFunnyShape = (text) => {
        const value = safeLower(text);
        return [
          "like ",
          "as if",
          "as though",
          "greased",
          "toddler",
          "circus",
          "jazz hands",
          "dumpster",
          "clown",
          "wearing pants",
          "sugar high",
          "county fair",
          "tiny ",
          "absurd",
        ].some((signal) => value.includes(signal));
      };

      const needsExpressiveRetry = (draft) => {
        if (tone === "unfiltered" && !isSensitiveMoment(`${message}\n${context}`)) {
          return countProfanity(draft) < 2;
        }
        if (tone === "funny" && !isSensitiveMoment(`${message}\n${context}`)) {
          return !hasFunnyShape(draft);
        }
        return false;
      };

      const expressiveRetryDirective = (draft) => {
        if (tone === "unfiltered") {
          return `Your previous draft was too restrained:\n${draft}\n\nRewrite it again. Include at least 2 natural cuss words. Keep the facts, but make the Unfiltered tone obvious.`;
        }
        if (tone === "funny") {
          return `Your previous draft was not funny enough:\n${draft}\n\nRewrite it again with one clear comic beat, one unexpected analogy or exaggerated image, and no bland corporate phrasing.`;
        }
        return "";
      };

      async function runOpenAiGeneration(extraMessages = []) {
        if (!env.OPENAI_API_KEY) {
          const missing = new Error("Missing OPENAI_API_KEY");
          missing.status = 0;
          missing.type = "missing_key";
          missing.code = "missing_key";
          throw missing;
        }

        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.55,
            messages: [...generationMessages, ...extraMessages],
          }),
        });

        const openaiJson = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          const upstream = new Error(openaiJson?.error?.message || "OpenAI request failed.");
          upstream.status = resp.status;
          upstream.type = openaiJson?.error?.type || "";
          upstream.code = openaiJson?.error?.code || "";
          throw upstream;
        }

        const output = normalizeProviderText(openaiJson);
        if (!output) {
          const empty = new Error("OpenAI returned empty output.");
          empty.status = 502;
          empty.type = "empty_output";
          empty.code = "empty_output";
          throw empty;
        }

        return { output, provider: "openai", fallback: false };
      }

      async function runWorkersAiGeneration(openAiError, extraMessages = []) {
        if (!env.AI) {
          const missing = new Error("Workers AI binding missing.");
          missing.status = 0;
          missing.type = "missing_ai_binding";
          missing.code = "missing_ai_binding";
          throw missing;
        }

        const result = await env.AI.run("@cf/openai/gpt-oss-20b", {
          messages: [...generationMessages, ...extraMessages],
          temperature: 0.45,
          max_tokens: 520,
        });

        const output = normalizeProviderText(result);
        if (!output) {
          const empty = new Error("Workers AI returned empty output.");
          empty.status = 502;
          empty.type = "empty_output";
          empty.code = "empty_output";
          throw empty;
        }

        return {
          output,
          provider: "workers_ai",
          fallback: true,
          fallback_reason: "openai_unavailable",
          openai_error: compactError(openAiError),
        };
      }

      function localFallbackDraft() {
        const source = rawInput || message;
        const cleaned = source
          .replace(/\s+/g, " ")
          .replace(/^TASK:.*?Write only the ready-to-send reply\./s, "")
          .trim();

        const signOff = signature ? `\n\n${signature}` : "";

        if (mode === "reply") {
          const intentMatch = message.match(/MY REPLY INTENT AND FACTS:\s*([\s\S]*?)\s*Write only the ready-to-send reply\./i);
          const intent = (intentMatch?.[1] || "").replace(/Not provided\..*/i, "").trim();
          if (intent) return `${intent}${signOff}`;
          if (tone === "business") return `Thanks for the message. I’ll take a look and follow up as soon as I can.${signOff}`;
          if (tone === "unfiltered") return `Thanks for the heads up. I’ll deal with this damn thing and get back to you soon.${signOff}`;
          if (tone === "funny") return `Thanks for the heads up. I’ll take a look and report back once my inbox stops doing jazz hands.${signOff}`;
          return `Thanks for letting me know. I’ll take a look and get back to you soon.${signOff}`;
        }

        if (tone === "business") return `${cleaned}${signOff}`;
        if (tone === "funny") return `${cleaned} Tiny wording rescue mission complete; the sentence is now wearing pants.${signOff}`;
        if (tone === "unfiltered") return `${cleaned} That is the cleaner version, with the extra bullshit scraped off.${signOff}`;
        if (tone === "snarky") return `${cleaned} There, now it sounds like a person wrote it on purpose.${signOff}`;
        return `${cleaned}${signOff}`;
      }

      async function generateWithProviders(extraMessages = []) {
        try {
          return await runOpenAiGeneration(extraMessages);
        } catch (openAiError) {
          try {
            return await runWorkersAiGeneration(openAiError, extraMessages);
          } catch (workersAiError) {
            return {
              output: localFallbackDraft(),
              provider: "local_fallback",
              fallback: true,
              fallback_reason: "all_ai_unavailable",
              openai_error: compactError(openAiError),
              workers_ai_error: compactError(workersAiError),
            };
          }
        }
      }

      let generation = await generateWithProviders();
      if (needsExpressiveRetry(generation.output)) {
        const retryPrompt = expressiveRetryDirective(generation.output);
        if (retryPrompt) {
          const retry = await generateWithProviders([{ role: "user", content: retryPrompt }]);
          if (!needsExpressiveRetry(retry.output)) {
            generation = {
              ...retry,
              expressive_retry: true,
            };
          }
        }
      }

      const out = generation.output;

      // Increment usage only after success
      if (isPlus) {
        const usedPlus = await readUsed(plusUsageKey(email));
        await writeUsed(plusUsageKey(email), usedPlus + 1);
        return json({
          output: out,
          ai_provider: generation.provider,
          fallback: generation.fallback,
          fallback_reason: generation.fallback_reason,
          expressive_retry: generation.expressive_retry,
          plan: "plus",
          cap: PLUS_DAILY_CAP,
          used_today: usedPlus + 1,
          remaining_today: Math.max(0, PLUS_DAILY_CAP - usedPlus - 1),
        }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
      }

      const usedFree = await readUsed(freeUsageKey(id));
      await writeUsed(freeUsageKey(id), usedFree + 1);
      return json({
        output: out,
        ai_provider: generation.provider,
        fallback: generation.fallback,
        fallback_reason: generation.fallback_reason,
        expressive_retry: generation.expressive_retry,
        plan: "free",
        cap: FREE_DAILY_CAP,
        used_today: usedFree + 1,
        remaining_today: Math.max(0, FREE_DAILY_CAP - usedFree - 1),
        subscribe_url: subscribeUrl,
      }, 200, setCookie ? { "Set-Cookie": setCookie } : {});
    }

    // ============================================================
    // FALLTHROUGH
    // ============================================================
    return json({ error: "Not found" }, 404);
  },
};
