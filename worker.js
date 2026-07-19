// ============================================================================
// Solf.ai — Cloudflare Worker (API + NeonDB Gateway)
// ============================================================================
// ВАЖНОЕ ИЗМЕНЕНИЕ vs старая версия:
//   /generate теперь УВАЖАЕТ maxOutputTokens, который присылает фронтенд
//   (app.js). Раньше здесь было жёстко зашито maxOutputTokens: 2000, из-за чего
//   большие задачи (цепочки аккордов на 15+ строк, гармонизации, диктанты)
//   ФИЗИЧЕСКИ обрезались на середине. Теперь лимит = min(запрошенный, 8192).
//
//   Разверни этот файл в Cloudflare (вставь как код воркера) — иначе большие
//   задачи по-прежнему будут обрезаться, даже если фронтенд просит больше.
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ status: "Solf.ai API & NeonDB Gateway is running" }), { headers: corsHeaders });
    }

    async function neonQuery(query, params = []) {
      if (!env.DATABASE_URL) throw new Error("DATABASE_URL is missing in environment variables");

      const dbUrl = new URL(env.DATABASE_URL);
      const host = dbUrl.hostname;

      const response = await fetch(`https://${host}/sql`, {
        method: "POST",
        headers: {
          "Neon-Connection-String": env.DATABASE_URL,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, params }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("Neon DB Error:", errText);
        throw new Error("Database query failed");
      }

      return response.json();
    }

    // ========== USAGE LIMITS (sliding windows) ==========
    const PLAN_LIMITS = {
      free: { requests: 3, images: 0, quizzes: 3 },
      basic: { requests: 10, images: 0, quizzes: 10 },
      pro: { requests: 50, images: 5, quizzes: Infinity },
      unlimited: { requests: Infinity, images: Infinity, quizzes: Infinity },
    };

    const USAGE_WINDOWS_MS = {
      request: 24 * 60 * 60 * 1000,
      image: 24 * 60 * 60 * 1000,
      quiz: 12 * 60 * 60 * 1000,
    };

    function planLimits(planType) {
      return PLAN_LIMITS[planType] || PLAN_LIMITS.free;
    }

    function usageFields(type) {
      if (type === "image") return { count: "images_count", start: "images_window_start", window: USAGE_WINDOWS_MS.image };
      if (type === "quiz") return { count: "quiz_count", start: "quiz_window_start", window: USAGE_WINDOWS_MS.quiz };
      return { count: "requests_count", start: "requests_window_start", window: USAGE_WINDOWS_MS.request };
    }

    function shouldResetWindow(startMs, windowMs) {
      const start = Number(startMs) || 0;
      if (!start) return true;
      return Date.now() - start >= windowMs;
    }

    function applyUsageWindows(user) {
      const now = Date.now();
      const next = { ...user };
      for (const type of ["request", "image", "quiz"]) {
        const { count, start, window } = usageFields(type);
        if (shouldResetWindow(user[start], window)) {
          next[count] = 0;
          next[start] = now;
        } else {
          next[count] = Number(user[count]) || 0;
          next[start] = Number(user[start]) || now;
        }
      }
      return next;
    }

    async function fetchUserById(userId) {
      const data = await neonQuery("SELECT * FROM users WHERE id = $1", [userId]);
      return data.rows[0] || null;
    }

    async function persistUsageWindows(user) {
      const now = Date.now();
      try {
        const data = await neonQuery(
          `UPDATE users SET
             requests_count = $2,
             requests_window_start = $3,
             images_count = $4,
             images_window_start = $5,
             quiz_count = $6,
             quiz_window_start = $7
           WHERE id = $1
           RETURNING *`,
          [
            user.id,
            Number(user.requests_count) || 0,
            Number(user.requests_window_start) || now,
            Number(user.images_count) || 0,
            Number(user.images_window_start) || now,
            Number(user.quiz_count) || 0,
            Number(user.quiz_window_start) || now,
          ]
        );
        return data.rows[0] || user;
      } catch (err) {
        console.warn("[usage] window columns missing? run db/schema.sql", err);
        return user;
      }
    }

    async function getUserWithFreshUsage(userId) {
      const row = await fetchUserById(userId);
      if (!row) return null;
      const normalized = applyUsageWindows(row);
      const changed =
        normalized.requests_count !== row.requests_count ||
        normalized.images_count !== row.images_count ||
        normalized.quiz_count !== row.quiz_count ||
        normalized.requests_window_start !== row.requests_window_start ||
        normalized.images_window_start !== row.images_window_start ||
        normalized.quiz_window_start !== row.quiz_window_start;
      return changed ? persistUsageWindows(normalized) : normalized;
    }

    function remainingUsage(user, type) {
      const limits = planLimits(user.plan_type || "free");
      const { count } = usageFields(type);
      const limit = type === "image" ? limits.images : type === "quiz" ? limits.quizzes : limits.requests;
      if (limit === Infinity) return Infinity;
      return Math.max(0, limit - (Number(user[count]) || 0));
    }

    function canUse(user, type) {
      return remainingUsage(user, type) > 0;
    }

    async function incrementUsageForUser(userId, type, { withRequest = false } = {}) {
      let user = await getUserWithFreshUsage(userId);
      if (!user) return { error: "User not found", status: 404 };

      const limits = planLimits(user.plan_type || "free");

      if (type === "image") {
        if (limits.images === 0) return { error: "Images not available on your plan", status: 403, code: "LIMIT_IMAGES" };
        if (!canUse(user, "image")) return { error: "Image limit reached", status: 429, code: "LIMIT_IMAGES" };
        if (limits.requests !== Infinity && !canUse(user, "request")) {
          return { error: "Request limit reached", status: 429, code: "LIMIT_REQUESTS" };
        }
      } else if (type === "quiz") {
        if (limits.quizzes !== Infinity && !canUse(user, "quiz")) {
          return { error: "Quiz limit reached", status: 429, code: "LIMIT_QUIZ" };
        }
      } else if (!canUse(user, "request")) {
        return { error: "Request limit reached", status: 429, code: "LIMIT_REQUESTS" };
      }

      const now = Date.now();
      if (type === "image") {
        user.images_count = (Number(user.images_count) || 0) + 1;
        if (!user.images_window_start) user.images_window_start = now;
        user.requests_count = (Number(user.requests_count) || 0) + 1;
        if (!user.requests_window_start) user.requests_window_start = now;
      } else if (type === "quiz") {
        user.quiz_count = (Number(user.quiz_count) || 0) + 1;
        if (!user.quiz_window_start) user.quiz_window_start = now;
      } else {
        user.requests_count = (Number(user.requests_count) || 0) + 1;
        if (!user.requests_window_start) user.requests_window_start = now;
      }

      if (withRequest && type !== "image" && type !== "request") {
        user.requests_count = (Number(user.requests_count) || 0) + 1;
        if (!user.requests_window_start) user.requests_window_start = now;
      }

      const saved = await persistUsageWindows(user);
      return { user: saved };
    }

    // ========== SESSION AUTH ==========
    const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

    function sessionStore(env) {
      return env.OTP_KV || env.SESSION_KV || null;
    }

    async function createSession(env, userId) {
      const kv = sessionStore(env);
      if (!kv) throw new Error("SESSION_KV or OTP_KV binding is required for auth");
      const token = crypto.randomUUID();
      await kv.put(
        "sess:" + token,
        JSON.stringify({ userId, createdAt: Date.now() }),
        { expirationTtl: SESSION_TTL_SEC }
      );
      return token;
    }

    async function getSessionUserId(request, env) {
      const kv = sessionStore(env);
      if (!kv) return null;
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return null;
      const token = auth.slice(7).trim();
      if (!token) return null;
      const raw = await kv.get("sess:" + token);
      if (!raw) return null;
      try {
        return JSON.parse(raw).userId || null;
      } catch (_) {
        return null;
      }
    }

    async function requireAuth(request, env) {
      const userId = await getSessionUserId(request, env);
      if (!userId) {
        return { error: new Response(JSON.stringify({ error: "Unauthorized", code: "AUTH_REQUIRED" }), { status: 401, headers: corsHeaders }) };
      }
      return { userId };
    }

    function forbidSelfOnly(sessionUserId, targetUserId) {
      if (!targetUserId || sessionUserId !== targetUserId) {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: corsHeaders });
      }
      return null;
    }

    async function upsertOAuthUser(user) {
      await neonQuery(
        `INSERT INTO users (id, email, name, picture, plan_type)
         VALUES ($1, $2, $3, $4, 'free')
         ON CONFLICT (id) DO UPDATE
         SET email = COALESCE($2, users.email),
             name = COALESCE($3, users.name),
             picture = COALESCE($4, users.picture)
         RETURNING *;`,
        [user.id, user.email || "", user.name || "", user.picture || ""]
      );
      return getUserWithFreshUsage(user.id);
    }

    async function handleGoogleAuth(request) {
      if (!sessionStore(env)) {
        return new Response(JSON.stringify({ error: "Session storage not configured (OTP_KV)" }), { status: 503, headers: corsHeaders });
      }
      const body = await request.json().catch(() => null);
      const credential = body?.credential;
      if (!credential) {
        return new Response(JSON.stringify({ error: "Missing Google credential" }), { status: 400, headers: corsHeaders });
      }
      const clientId = env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return new Response(JSON.stringify({ error: "GOOGLE_CLIENT_ID not configured on server" }), { status: 500, headers: corsHeaders });
      }

      const verifyRes = await fetch(
        "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
      );
      const payload = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || payload.error) {
        return new Response(JSON.stringify({ error: "Invalid Google token" }), { status: 401, headers: corsHeaders });
      }
      if (payload.aud !== clientId) {
        return new Response(JSON.stringify({ error: "Google token audience mismatch" }), { status: 401, headers: corsHeaders });
      }
      if (payload.exp && Number(payload.exp) * 1000 < Date.now()) {
        return new Response(JSON.stringify({ error: "Google token expired" }), { status: 401, headers: corsHeaders });
      }

      const profile = {
        id: payload.sub,
        email: payload.email || "",
        name: payload.name || payload.email || "User",
        picture: payload.picture || "",
      };
      const dbUser = await upsertOAuthUser(profile);
      const sessionToken = await createSession(env, profile.id);
      return new Response(JSON.stringify({ user: dbUser || profile, sessionToken }), { headers: corsHeaders });
    }

    async function handleVkAuth(request) {
      if (!sessionStore(env)) {
        return new Response(JSON.stringify({ error: "Session storage not configured (OTP_KV)" }), { status: 503, headers: corsHeaders });
      }
      const body = await request.json().catch(() => null);
      const clientId = String(env.VK_APP_ID || body?.client_id || "54641545");
      let vkUserId = null;
      let name = "";
      let email = "";
      let picture = "";

      if (body?.id_token) {
        const res = await fetch("https://id.vk.com/oauth2/public_info", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ id_token: body.id_token, client_id: clientId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return new Response(JSON.stringify({ error: "Invalid VK token", details: data }), { status: 401, headers: corsHeaders });
        }
        const u = data.user || data;
        vkUserId = u.user_id || u.userId || data.user_id;
        name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        email = u.email || "";
        picture = u.avatar || u.photo_200 || "";
      } else if (body?.access_token) {
        const res = await fetch("https://id.vk.com/oauth2/user_info", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ access_token: body.access_token, client_id: clientId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return new Response(JSON.stringify({ error: "Invalid VK access token", details: data }), { status: 401, headers: corsHeaders });
        }
        const u = data.user || data;
        vkUserId = u.user_id || u.userId || data.user_id;
        name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
        email = u.email || "";
        picture = u.avatar || u.photo_200 || "";
      } else {
        return new Response(JSON.stringify({ error: "Missing VK id_token or access_token" }), { status: 400, headers: corsHeaders });
      }

      if (!vkUserId) {
        return new Response(JSON.stringify({ error: "Could not resolve VK user id" }), { status: 401, headers: corsHeaders });
      }

      const profile = {
        id: "vk_" + vkUserId,
        email,
        name: name || "VK User",
        picture,
      };
      const dbUser = await upsertOAuthUser(profile);
      const sessionToken = await createSession(env, profile.id);
      return new Response(JSON.stringify({ user: dbUser || profile, sessionToken }), { headers: corsHeaders });
    }

    async function handleLogout(request) {
      const kv = sessionStore(env);
      const auth = request.headers.get("Authorization") || "";
      if (kv && auth.startsWith("Bearer ")) {
        const token = auth.slice(7).trim();
        if (token) await kv.delete("sess:" + token);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    // ========== OTP AUTH (email / phone) ==========
    const OTP_TTL_SEC = 600;
    const SEND_COOLDOWN_SEC = 60;
    const MAX_VERIFY_ATTEMPTS = 5;

    function parseContact(raw) {
      const value = String(raw || "").trim();
      if (!value) return { error: "Enter your email or phone number" };

      if (value.includes("@")) {
        const email = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return { error: "Invalid email address" };
        }
        return { type: "email", normalized: email, display: email };
      }

      let digits = value.replace(/\D/g, "");
      if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
      if (digits.length === 10) digits = "7" + digits;
      if (digits.length < 10 || digits.length > 15) {
        return { error: "Invalid phone number" };
      }
      return { type: "phone", normalized: digits, display: "+" + digits };
    }

    function otpKey(contact) {
      return "otp:" + contact.type + ":" + contact.normalized;
    }

    function rateKey(kind, value) {
      return "rl:" + kind + ":" + value;
    }

    function generateCode() {
      const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
      return String(n).padStart(6, "0");
    }

    function userFromContact(contact) {
      const id = contact.type === "email"
        ? "email_" + contact.normalized.replace("@", "_at_")
        : "phone_" + contact.normalized;
      const name = contact.type === "email"
        ? contact.normalized.split("@")[0]
        : contact.display;
      return {
        id,
        email: contact.type === "email" ? contact.normalized : "",
        name,
        picture: "",
      };
    }

    async function checkRateLimit(kv, key, windowSec, max) {
      const raw = await kv.get(key);
      const now = Date.now();
      let entry = raw ? JSON.parse(raw) : { count: 0, reset: now + windowSec * 1000 };
      if (now > entry.reset) entry = { count: 0, reset: now + windowSec * 1000 };
      entry.count += 1;
      await kv.put(key, JSON.stringify(entry), { expirationTtl: windowSec + 60 });
      return entry.count <= max;
    }

    async function sendOtpEmail(to, code) {
      if (!env.RESEND_API_KEY || !env.OTP_FROM_EMAIL) {
        throw new Error("Email delivery is not configured (RESEND_API_KEY, OTP_FROM_EMAIL)");
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.OTP_FROM_EMAIL,
          to: [to],
          subject: "Your Solf.ai sign-in code",
          html: `<p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes.</p>`,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error("Failed to send email: " + err.slice(0, 200));
      }
    }

    async function sendOtpSms(phoneDigits, code) {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
        throw new Error("SMS delivery is not configured (Twilio secrets)");
      }
      const auth = btoa(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: "Basic " + auth,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: "+" + phoneDigits,
            From: env.TWILIO_FROM_NUMBER,
            Body: `Your Solf.ai code: ${code}. Valid for 10 minutes.`,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.text();
        throw new Error("Failed to send SMS: " + err.slice(0, 200));
      }
    }

    async function handleSendCode(request) {
      const kv = env.OTP_KV;
      if (!kv) {
        return new Response(JSON.stringify({ error: "OTP_KV binding is missing. Add KV namespace in Worker settings." }), { status: 503, headers: corsHeaders });
      }

      const body = await request.json().catch(() => null);
      const contact = parseContact(body?.contact);
      if (contact.error) {
        return new Response(JSON.stringify({ error: contact.error }), { status: 400, headers: corsHeaders });
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await checkRateLimit(kv, rateKey("ip", ip), 3600, 10))) {
        return new Response(JSON.stringify({ error: "Too many requests. Try again later." }), { status: 429, headers: corsHeaders });
      }
      if (!(await checkRateLimit(kv, rateKey("send", contact.normalized), 3600, 5))) {
        return new Response(JSON.stringify({ error: "Too many codes sent. Try again later." }), { status: 429, headers: corsHeaders });
      }

      const cooldown = await kv.get(rateKey("cooldown", contact.normalized));
      if (cooldown) {
        const wait = Math.max(1, Math.ceil((Number(cooldown) - Date.now()) / 1000));
        return new Response(JSON.stringify({ error: `Wait ${wait}s before requesting a new code`, retryAfter: wait }), { status: 429, headers: corsHeaders });
      }

      const code = generateCode();
      const payload = { code, attempts: 0, type: contact.type, normalized: contact.normalized, created: Date.now() };

      try {
        if (contact.type === "email") {
          await sendOtpEmail(contact.normalized, code);
        } else {
          await sendOtpSms(contact.normalized, code);
        }
      } catch (err) {
        console.error("[auth-otp]", err);
        return new Response(JSON.stringify({ error: err.message || "Could not send verification code" }), { status: 503, headers: corsHeaders });
      }

      await kv.put(otpKey(contact), JSON.stringify(payload), { expirationTtl: OTP_TTL_SEC });
      await kv.put(rateKey("cooldown", contact.normalized), String(Date.now() + SEND_COOLDOWN_SEC * 1000), { expirationTtl: SEND_COOLDOWN_SEC + 10 });

      return new Response(JSON.stringify({
        ok: true,
        channel: contact.type,
        masked: contact.type === "email"
          ? contact.normalized.replace(/(.{2}).+(@.+)/, "$1***$2")
          : "+" + contact.normalized.slice(0, 1) + " *** *** " + contact.normalized.slice(-2),
        expiresIn: OTP_TTL_SEC,
        resendIn: SEND_COOLDOWN_SEC,
      }), { headers: corsHeaders });
    }

    async function handleVerifyCode(request) {
      const kv = env.OTP_KV;
      if (!kv) {
        return new Response(JSON.stringify({ error: "OTP_KV binding is missing" }), { status: 503, headers: corsHeaders });
      }

      const body = await request.json().catch(() => null);
      const contact = parseContact(body?.contact);
      if (contact.error) {
        return new Response(JSON.stringify({ error: contact.error }), { status: 400, headers: corsHeaders });
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await checkRateLimit(kv, rateKey("verify-ip", ip), 3600, 30))) {
        return new Response(JSON.stringify({ error: "Too many attempts. Try again later." }), { status: 429, headers: corsHeaders });
      }

      const code = String(body?.code || "").trim().replace(/\D/g, "");
      if (code.length !== 6) {
        return new Response(JSON.stringify({ error: "Enter the 6-digit code" }), { status: 400, headers: corsHeaders });
      }

      const storedRaw = await kv.get(otpKey(contact));
      if (!storedRaw) {
        return new Response(JSON.stringify({ error: "Code expired or not found. Request a new one." }), { status: 400, headers: corsHeaders });
      }

      const stored = JSON.parse(storedRaw);
      if (stored.normalized !== contact.normalized) {
        return new Response(JSON.stringify({ error: "Code expired or not found. Request a new one." }), { status: 400, headers: corsHeaders });
      }

      stored.attempts = (stored.attempts || 0) + 1;
      if (stored.attempts > MAX_VERIFY_ATTEMPTS) {
        await kv.delete(otpKey(contact));
        return new Response(JSON.stringify({ error: "Too many attempts. Request a new code." }), { status: 400, headers: corsHeaders });
      }
      await kv.put(otpKey(contact), JSON.stringify(stored), { expirationTtl: OTP_TTL_SEC });

      if (stored.code !== code) {
        return new Response(JSON.stringify({ error: "Incorrect code", attemptsLeft: MAX_VERIFY_ATTEMPTS - stored.attempts }), { status: 400, headers: corsHeaders });
      }

      await kv.delete(otpKey(contact));
      const user = userFromContact(contact);

      // Сохраняем пользователя в Neon (как Google/VK)
      await neonQuery(
        `INSERT INTO users (id, email, name, picture, plan_type)
         VALUES ($1, $2, $3, $4, 'free')
         ON CONFLICT (id) DO UPDATE
         SET email = COALESCE($2, users.email),
             name = COALESCE($3, users.name),
             picture = COALESCE($4, users.picture)
         RETURNING *;`,
        [user.id, user.email, user.name, user.picture]
      );

      const sessionToken = await createSession(env, user.id);
      const dbUser = await getUserWithFreshUsage(user.id);

      return new Response(JSON.stringify({ ok: true, user: dbUser || user, sessionToken }), { headers: corsHeaders });
    }

    try {
      // OTP routes
      if (url.pathname === "/auth/send-code" && request.method === "POST") {
        return await handleSendCode(request);
      }
      if (url.pathname === "/auth/verify-code" && request.method === "POST") {
        return await handleVerifyCode(request);
      }

      if (url.pathname === "/auth/google" && request.method === "POST") {
        return await handleGoogleAuth(request);
      }
      if (url.pathname === "/auth/vk" && request.method === "POST") {
        return await handleVkAuth(request);
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        return await handleLogout(request);
      }

      if (url.pathname === "/get-user" && request.method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const userId = url.searchParams.get("id");
        if (!userId) return new Response(JSON.stringify({ error: "No ID" }), { status: 400, headers: corsHeaders });
        const forbid = forbidSelfOnly(auth.userId, userId);
        if (forbid) return forbid;

        const user = await getUserWithFreshUsage(userId);
        if (!user) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: corsHeaders });

        return new Response(JSON.stringify(user), { headers: corsHeaders });
      }

      if (url.pathname === "/save-user" && request.method === "POST") {
        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const user = await request.json();
        if (!user.id) return new Response(JSON.stringify({ error: "User ID is required" }), { status: 400, headers: corsHeaders });
        const forbid = forbidSelfOnly(auth.userId, user.id);
        if (forbid) return forbid;

        const query = `
          INSERT INTO users (id, email, name, picture, plan_type)
          VALUES ($1, $2, $3, $4, 'free')
          ON CONFLICT (id) DO UPDATE
          SET email = COALESCE($2, users.email),
              name = COALESCE($3, users.name),
              picture = COALESCE($4, users.picture)
          RETURNING *;
        `;
        const data = await neonQuery(query, [user.id, user.email, user.name, user.picture]);
        const fresh = await getUserWithFreshUsage(user.id);
        return new Response(JSON.stringify(fresh || data.rows[0]), { headers: corsHeaders });
      }

      if (url.pathname === "/increment-usage" && request.method === "POST") {
        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const { id, type } = await request.json();
        if (!id) return new Response(JSON.stringify({ error: "User ID is required" }), { status: 400, headers: corsHeaders });
        const forbid = forbidSelfOnly(auth.userId, id);
        if (forbid) return forbid;

        const usageType = type === "image" ? "image" : type === "quiz" ? "quiz" : "request";
        const result = await incrementUsageForUser(id, usageType);
        if (result.error) {
          return new Response(JSON.stringify({ error: result.error, code: result.code }), { status: result.status || 400, headers: corsHeaders });
        }
        return new Response(JSON.stringify(result.user), { headers: corsHeaders });
      }

      if (url.pathname === "/generate" && request.method === "POST") {
        if (!env.GEMINI_API_KEY) return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500, headers: corsHeaders });

        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const body = await request.json();
        const messages = body.messages || [];
        const image = body.image;
        const userId = body.userId || body.user_id || auth.userId;

        const forbid = forbidSelfOnly(auth.userId, userId);
        if (forbid) return forbid;

        const user = await getUserWithFreshUsage(userId);
        if (!user) {
          return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: corsHeaders });
        }

        const skipUsageCharge = Boolean(body.usageAlreadyCounted);
        const limits = planLimits(user.plan_type || "free");

        if (!skipUsageCharge) {
          if (image && limits.images === 0) {
            return new Response(JSON.stringify({ error: "Images not available on your plan", code: "LIMIT_IMAGES" }), { status: 403, headers: corsHeaders });
          }
          if (image && limits.images !== Infinity && !canUse(user, "image")) {
            return new Response(JSON.stringify({ error: "Image limit reached", code: "LIMIT_IMAGES" }), { status: 429, headers: corsHeaders });
          }
          if (limits.requests !== Infinity && !canUse(user, "request")) {
            return new Response(JSON.stringify({ error: "Request limit reached", code: "LIMIT_REQUESTS" }), { status: 429, headers: corsHeaders });
          }
        }

        // === ЛИМИТ ТОКЕНОВ: уважаем то, что просит фронтенд (app.js) ===
        // Большие задачи (цепочки аккордов, гармонизации, диктанты) требуют много
        // выходных токенов. Берём maxOutputTokens/max_tokens из запроса, ограничиваем
        // разумным потолком 8192 (Gemini 2.5 Flash поддерживает больше, но 8192 хватает
        // на очень длинную цепочку и защищает от «улетевшей» генерации).
        const requestedTokens = Number(body.maxOutputTokens ?? body.max_tokens ?? 2048);
        const maxOutputTokens = Math.max(256, Math.min(Number.isFinite(requestedTokens) ? requestedTokens : 2048, 8192));

        let systemPrompt = "";
        const contents = [];

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];

          if (msg.role === "system") {
            systemPrompt += msg.content + "\n\n";
            continue;
          }

          const parts = [];
          const textContent = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text || "");
          parts.push({ text: systemPrompt + textContent });
          systemPrompt = "";

          const isLastMessage = (i === messages.length - 1);
          const isUserMessage = (msg.role !== "assistant");

          if (image && isLastMessage && isUserMessage) {
            parts.push({
              inlineData: {
                mimeType: image.mime_type || image.mimeType || "image/jpeg",
                data: image.data,
              },
            });
          }

          const role = msg.role === "assistant" ? "model" : "user";
          contents.push({ role: role, parts: parts });
        }

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: contents,
              generationConfig: { temperature: body.temperature ?? 0.7, maxOutputTokens },
            }),
          }
        );

        const data = await response.json();
        if (!response.ok || data.error) {
          return new Response(JSON.stringify({ gemini_error: data.error || data, message: data.error?.message || "API error" }), { status: response.status, headers: corsHeaders });
        }

        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "Empty response from the model";

        let usagePayload = null;
        if (!skipUsageCharge) {
          const usageResult = await incrementUsageForUser(userId, image ? "image" : "request");
          if (usageResult.user) usagePayload = usageResult.user;
        } else {
          usagePayload = user;
        }

        return new Response(JSON.stringify({
          text,
          usage: usagePayload ? {
            requests_count: usagePayload.requests_count,
            images_count: usagePayload.images_count,
            quiz_count: usagePayload.quiz_count,
            requests_window_start: usagePayload.requests_window_start,
            images_window_start: usagePayload.images_window_start,
            quiz_window_start: usagePayload.quiz_window_start,
          } : undefined,
        }), { headers: corsHeaders });
      }

      if (url.pathname === "/save-chat" && request.method === "POST") {
        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const chat = await request.json();
        if (!chat.id || !chat.user_id) return new Response(JSON.stringify({ error: "Missing id or user_id" }), { status: 400, headers: corsHeaders });
        const forbid = forbidSelfOnly(auth.userId, chat.user_id);
        if (forbid) return forbid;

        const query = `
          INSERT INTO chats (id, user_id, title, messages)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE
          SET title = $3, messages = $4, updated_at = CURRENT_TIMESTAMP;
        `;
        await neonQuery(query, [chat.id, chat.user_id, chat.title || "New Chat", JSON.stringify(chat)]);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      if (url.pathname === "/get-chats" && request.method === "GET") {
        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const userId = url.searchParams.get("user_id");
        if (!userId) return new Response(JSON.stringify({ error: "Missing user_id" }), { status: 400, headers: corsHeaders });
        const forbid = forbidSelfOnly(auth.userId, userId);
        if (forbid) return forbid;

        const query = `SELECT messages FROM chats WHERE user_id = $1 ORDER BY updated_at DESC;`;
        const data = await neonQuery(query, [userId]);

        const chats = data.rows.map((row) => typeof row.messages === "string" ? JSON.parse(row.messages) : row.messages);
        return new Response(JSON.stringify({ chats }), { headers: corsHeaders });
      }

      if (url.pathname === "/delete-chat" && request.method === "POST") {
        const auth = await requireAuth(request, env);
        if (auth.error) return auth.error;

        const body = await request.json();
        const forbid = forbidSelfOnly(auth.userId, body.user_id);
        if (forbid) return forbid;

        await neonQuery(`DELETE FROM chats WHERE id = $1 AND user_id = $2`, [body.id, body.user_id]);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: "Route not found" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error("Worker Error:", err);
      return new Response(JSON.stringify({ error: err.message || "Internal error" }), { status: 500, headers: corsHeaders });
    }
  },
};
