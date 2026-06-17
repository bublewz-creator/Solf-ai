/**
 * OTP auth routes for Solf.ai Cloudflare Worker.
 * Add to your existing worker fetch handler:
 *
 *   import { handleAuthOtpRequest } from './auth-otp.js';
 *   const authResp = await handleAuthOtpRequest(request, env);
 *   if (authResp) return authResp;
 *
 * Bindings (wrangler.toml):
 *   [[kv_namespaces]]
 *   binding = "OTP_KV"
 *   id = "..."
 *
 * Secrets:
 *   RESEND_API_KEY, OTP_FROM_EMAIL  — email delivery
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER — SMS (optional)
 */

const OTP_TTL_SEC = 600;
const SEND_COOLDOWN_SEC = 60;
const MAX_VERIFY_ATTEMPTS = 5;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS },
    });
}

function parseContact(raw) {
    const value = String(raw || '').trim();
    if (!value) return { error: 'Enter your email or phone number' };

    if (value.includes('@')) {
        const email = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return { error: 'Invalid email address' };
        }
        return { type: 'email', normalized: email, display: email };
    }

    let digits = value.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) digits = '7' + digits.slice(1);
    if (digits.length === 10) digits = '7' + digits;
    if (digits.length < 10 || digits.length > 15) {
        return { error: 'Invalid phone number' };
    }
    return { type: 'phone', normalized: digits, display: '+' + digits };
}

function otpKey(contact) {
    return 'otp:' + contact.type + ':' + contact.normalized;
}

function rateKey(kind, value) {
    return 'rl:' + kind + ':' + value;
}

function generateCode() {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    return String(n).padStart(6, '0');
}

function userFromContact(contact) {
    const id = contact.type === 'email'
        ? 'email_' + contact.normalized.replace('@', '_at_')
        : 'phone_' + contact.normalized;
    const name = contact.type === 'email'
        ? contact.normalized.split('@')[0]
        : contact.display;
    return {
        id,
        email: contact.type === 'email' ? contact.normalized : '',
        name,
        picture: '',
        phone: contact.type === 'phone' ? contact.normalized : '',
    };
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
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

async function sendEmail(env, to, code) {
    if (!env.RESEND_API_KEY || !env.OTP_FROM_EMAIL) {
        throw new Error('Email delivery is not configured');
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: env.OTP_FROM_EMAIL,
            to: [to],
            subject: 'Your Solf.ai sign-in code',
            html: `<p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>This code expires in 10 minutes.</p>`,
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error('Failed to send email: ' + err.slice(0, 120));
    }
}

async function sendSms(env, phoneDigits, code) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
        throw new Error('SMS delivery is not configured');
    }
    const to = '+' + phoneDigits;
    const body = new URLSearchParams({
        To: to,
        From: env.TWILIO_FROM_NUMBER,
        Body: `Your Solf.ai code: ${code}. Valid for 10 minutes.`,
    });
    const auth = btoa(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN);
    const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
            method: 'POST',
            headers: {
                Authorization: 'Basic ' + auth,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        }
    );
    if (!res.ok) {
        const err = await res.text();
        throw new Error('Failed to send SMS: ' + err.slice(0, 120));
    }
}

async function handleSendCode(request, env) {
    const kv = env.OTP_KV;
    if (!kv) return json({ error: 'OTP storage is not configured' }, 503);

    const body = await readJson(request);
    const contact = parseContact(body?.contact);
    if (contact.error) return json({ error: contact.error }, 400);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const okIp = await checkRateLimit(kv, rateKey('ip', ip), 3600, 10);
    if (!okIp) return json({ error: 'Too many requests. Try again later.' }, 429);

    const okContact = await checkRateLimit(kv, rateKey('send', contact.normalized), 3600, 5);
    if (!okContact) return json({ error: 'Too many codes sent. Try again later.' }, 429);

    const cooldown = await kv.get(rateKey('cooldown', contact.normalized));
    if (cooldown) {
        const wait = Math.max(1, Math.ceil((Number(cooldown) - Date.now()) / 1000));
        return json({ error: `Wait ${wait}s before requesting a new code`, retryAfter: wait }, 429);
    }

    const code = generateCode();
    const payload = {
        code,
        attempts: 0,
        type: contact.type,
        normalized: contact.normalized,
        created: Date.now(),
    };

    try {
        if (contact.type === 'email') {
            await sendEmail(env, contact.normalized, code);
        } else {
            await sendSms(env, contact.normalized, code);
        }
    } catch (err) {
        console.error('[auth-otp] delivery failed:', err);
        return json({ error: err.message || 'Could not send verification code' }, 503);
    }

    await kv.put(otpKey(contact), JSON.stringify(payload), { expirationTtl: OTP_TTL_SEC });
    await kv.put(
        rateKey('cooldown', contact.normalized),
        String(Date.now() + SEND_COOLDOWN_SEC * 1000),
        { expirationTtl: SEND_COOLDOWN_SEC + 10 }
    );

    return json({
        ok: true,
        channel: contact.type,
        masked: contact.type === 'email'
            ? contact.normalized.replace(/(.{2}).+(@.+)/, '$1***$2')
            : '+' + contact.normalized.slice(0, 1) + ' *** *** ' + contact.normalized.slice(-2),
        expiresIn: OTP_TTL_SEC,
        resendIn: SEND_COOLDOWN_SEC,
    });
}

async function handleVerifyCode(request, env) {
    const kv = env.OTP_KV;
    if (!kv) return json({ error: 'OTP storage is not configured' }, 503);

    const body = await readJson(request);
    const contact = parseContact(body?.contact);
    if (contact.error) return json({ error: contact.error }, 400);

    const code = String(body?.code || '').trim().replace(/\D/g, '');
    if (code.length !== 6) return json({ error: 'Enter the 6-digit code' }, 400);

    const storedRaw = await kv.get(otpKey(contact));
    if (!storedRaw) return json({ error: 'Code expired or not found. Request a new one.' }, 400);

    const stored = JSON.parse(storedRaw);
    if (stored.normalized !== contact.normalized) {
        return json({ error: 'Code expired or not found. Request a new one.' }, 400);
    }

    stored.attempts = (stored.attempts || 0) + 1;
    if (stored.attempts > MAX_VERIFY_ATTEMPTS) {
        await kv.delete(otpKey(contact));
        return json({ error: 'Too many attempts. Request a new code.' }, 400);
    }
    await kv.put(otpKey(contact), JSON.stringify(stored), { expirationTtl: OTP_TTL_SEC });

    if (stored.code !== code) {
        return json({ error: 'Incorrect code', attemptsLeft: MAX_VERIFY_ATTEMPTS - stored.attempts }, 400);
    }

    await kv.delete(otpKey(contact));
    const user = userFromContact(contact);
    return json({ ok: true, user });
}

export async function handleAuthOtpRequest(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/auth/')) {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') return null;

    if (url.pathname === '/auth/send-code') {
        return handleSendCode(request, env);
    }
    if (url.pathname === '/auth/verify-code') {
        return handleVerifyCode(request, env);
    }

    return null;
}
