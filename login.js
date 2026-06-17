// ===== SOLF.AI LOGIN PAGE =====

const WORKER_URL = 'https://solf-ai-api.mlemonw.workers.dev';
const GOOGLE_CLIENT_ID = '691304539168-iaouqdnkd73iprkcs6cou2i93t11qiak.apps.googleusercontent.com';
const VK_APP_ID = 54641545;
const VK_REDIRECT_URL = 'https://bublewz-creator.github.io/Solf-ai/';
const VKID_SDK_URL = 'https://unpkg.com/@vkid/sdk@<3.0.0/dist-sdk/umd/index.js';

let termsAccepted = false;
let providersLoaded = false;
let otpSentContact = '';
let otpResendTimer = null;
let otpResendSeconds = 0;

(function redirectIfAlreadyLoggedIn() {
    try {
        const user = JSON.parse(localStorage.getItem('solfai_user') || 'null');
        if (user?.id) location.replace(getReturnUrl());
    } catch (_) {}
})();

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    if (typeof AbortController === 'undefined') return fetch(url, options);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeoutMs);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function syncUserWithDB(user) {
    try {
        await fetchWithTimeout(`${WORKER_URL}/save-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: user.id,
                email: user.email,
                name: user.name,
                picture: user.picture
            })
        });
    } catch (error) {
        console.warn('[Solf.ai] Failed to sync user:', error);
    }
}

function getReturnUrl() {
    const ret = new URLSearchParams(location.search).get('return');
    if (!ret || ret.includes('://') || ret.startsWith('//')) return 'index.html';
    return ret;
}

function onAuthSuccess(user) {
    localStorage.setItem('solfai_user', JSON.stringify(user));
    syncUserWithDB(user);
    location.href = getReturnUrl();
}

function updateAuthGate() {
    const providers = document.getElementById('authProviders');
    const hint = document.getElementById('termsHint');
    if (providers) providers.classList.toggle('auth-disabled', !termsAccepted);
    if (hint) hint.hidden = termsAccepted;
    setOtpControlsDisabled(!termsAccepted);
    if (termsAccepted && !providersLoaded) {
        providersLoaded = true;
        ensureLoginProvidersLoaded();
    }
}

function setOtpControlsDisabled(disabled) {
    ['otpContact', 'otpCode', 'otpSendBtn', 'otpVerifyBtn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled || el.dataset.busy === '1';
    });
    const resend = document.getElementById('otpResendBtn');
    if (resend && otpResendSeconds <= 0) {
        resend.disabled = disabled || resend.dataset.busy === '1';
    }
}

function setOtpMessage(text, type = '') {
    const el = document.getElementById('otpMessage');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'otp-message' + (type ? ` otp-message--${type}` : '');
}

function setOtpBusy(busy) {
    ['otpSendBtn', 'otpVerifyBtn', 'otpResendBtn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.dataset.busy = busy ? '1' : '0';
    });
    setOtpControlsDisabled(!termsAccepted);
}

function startOtpResendCountdown(seconds) {
    otpResendSeconds = seconds;
    const btn = document.getElementById('otpResendBtn');
    if (!btn) return;
    btn.disabled = true;
    if (otpResendTimer) clearInterval(otpResendTimer);
    const tick = () => {
        if (otpResendSeconds <= 0) {
            clearInterval(otpResendTimer);
            otpResendTimer = null;
            btn.disabled = !termsAccepted;
            btn.textContent = 'Resend code';
            return;
        }
        btn.textContent = `Resend code in ${otpResendSeconds}s`;
        otpResendSeconds -= 1;
    };
    tick();
    otpResendTimer = setInterval(tick, 1000);
}

async function sendOtpCode() {
    if (!termsAccepted) return;
    const contactInput = document.getElementById('otpContact');
    const contact = contactInput?.value?.trim();
    if (!contact) {
        setOtpMessage('Enter your email or phone number', 'error');
        contactInput?.focus();
        return;
    }

    setOtpBusy(true);
    setOtpMessage('Sending code…');

    try {
        const res = await fetchWithTimeout(`${WORKER_URL}/auth/send-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact })
        }, 15000);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            if (data.retryAfter) startOtpResendCountdown(Number(data.retryAfter));
            throw new Error(data.error || 'Could not send code');
        }

        otpSentContact = contact;
        document.getElementById('otpVerifySection')?.removeAttribute('hidden');
        document.getElementById('otpSentHint').textContent =
            `Code sent to ${data.masked || contact}. Enter it below.`;
        setOtpMessage('Check your inbox or messages', 'success');
        startOtpResendCountdown(Number(data.resendIn) || 60);
        document.getElementById('otpCode')?.focus();
    } catch (err) {
        setOtpMessage(err.message || 'Could not send code', 'error');
    } finally {
        setOtpBusy(false);
    }
}

async function verifyOtpCode() {
    if (!termsAccepted) return;
    const contact = otpSentContact || document.getElementById('otpContact')?.value?.trim();
    const code = document.getElementById('otpCode')?.value?.trim().replace(/\D/g, '');

    if (!contact) {
        setOtpMessage('Enter your email or phone first', 'error');
        return;
    }
    if (code.length !== 6) {
        setOtpMessage('Enter the 6-digit code', 'error');
        document.getElementById('otpCode')?.focus();
        return;
    }

    setOtpBusy(true);
    setOtpMessage('Verifying…');

    try {
        const res = await fetchWithTimeout(`${WORKER_URL}/auth/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact, code })
        }, 15000);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(data.error || 'Verification failed');
        }

        if (!data.user?.id) {
            throw new Error('Invalid server response');
        }

        onAuthSuccess(data.user);
    } catch (err) {
        setOtpMessage(err.message || 'Verification failed', 'error');
    } finally {
        setOtpBusy(false);
    }
}

function bindOtpAuth() {
    document.getElementById('otpSendBtn')?.addEventListener('click', sendOtpCode);
    document.getElementById('otpVerifyBtn')?.addEventListener('click', verifyOtpCode);
    document.getElementById('otpResendBtn')?.addEventListener('click', sendOtpCode);

    document.getElementById('otpContact')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (document.getElementById('otpVerifySection')?.hidden) sendOtpCode();
            else verifyOtpCode();
        }
    });

    document.getElementById('otpCode')?.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
        if (e.target.value.length === 6) verifyOtpCode();
    });

    document.getElementById('otpCode')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            verifyOtpCode();
        }
    });
}

function ensureGoogleSignInLoaded() {
    if (typeof google !== 'undefined' && google.accounts) {
        initGoogleAuth();
        return;
    }
    if (window.__solfGsiLoading) return;
    window.__solfGsiLoading = true;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => { try { initGoogleAuth(); } catch (_) {} };
    s.onerror = () => {
        window.__solfGsiLoading = false;
        console.warn('[Solf.ai] Google Sign-In unavailable.');
    };
    document.head.appendChild(s);
}

function mountGoogleBridge() {
    const container = document.getElementById('googleBridge');
    if (!container || container.dataset.rendered === '1') return;
    if (typeof google === 'undefined' || !google.accounts?.id?.renderButton) return;

    container.dataset.rendered = '1';
    google.accounts.id.renderButton(container, {
        type: 'icon',
        shape: 'circle',
        size: 'large',
        theme: 'outline',
        locale: 'en'
    });
}

function initGoogleAuth() {
    if (typeof google === 'undefined' || !google.accounts) {
        if (!window.__solfGsiLoading) return;
        setTimeout(initGoogleAuth, 500);
        return;
    }
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        locale: 'en',
        callback: (r) => {
            const payload = JSON.parse(atob(r.credential.split('.')[1]));
            onAuthSuccess({
                id: payload.sub,
                email: payload.email,
                name: payload.name,
                picture: payload.picture
            });
        }
    });
    mountGoogleBridge();
}

function ensureVkIdLoaded() {
    if (window.VKIDSDK) { initVkIdAuth(); return; }
    if (window.__solfVkIdLoading) return;
    window.__solfVkIdLoading = true;
    const s = document.createElement('script');
    s.src = VKID_SDK_URL;
    s.async = true;
    s.onload = () => { try { initVkIdAuth(); } catch (_) {} };
    s.onerror = () => {
        window.__solfVkIdLoading = false;
        console.warn('[Solf.ai] VK ID SDK unavailable.');
    };
    document.head.appendChild(s);
}

function getVkIdScheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

async function handleVkIdAuthSuccess(data) {
    const VKID = window.VKIDSDK;
    let user = null;
    try {
        if (data.id_token) {
            const info = await VKID.Auth.publicInfo(data.id_token);
            user = info.user || info;
        } else if (data.access_token) {
            const info = await VKID.Auth.userInfo(data.access_token);
            user = info.user || info;
        }
    } catch (e) {
        console.warn('[Solf.ai] VK user info fetch failed:', e);
    }
    const userId = user?.user_id || data.user_id;
    if (!userId) return;
    const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ').trim() : '';
    onAuthSuccess({
        id: 'vk_' + userId,
        email: user?.email || '',
        name: name || 'VK User',
        picture: user?.avatar || ''
    });
}

function exchangeVkCode(payload) {
    const VKID = window.VKIDSDK;
    if (!VKID || !payload?.code) return;
    VKID.Auth.exchangeCode(payload.code, payload.device_id)
        .then(handleVkIdAuthSuccess)
        .catch((err) => console.warn('[Solf.ai] VK ID auth error:', err));
}

function startVkLogin() {
    if (!termsAccepted) return;
    const VKID = window.VKIDSDK;
    if (!VKID) return;
    VKID.Auth.login({
        lang: VKID.Languages.ENG,
        scheme: getVkIdScheme()
    })
        .then(exchangeVkCode)
        .catch((err) => console.warn('[Solf.ai] VK auth error:', err));
}

function bindAuthCircleClicks() {
    document.getElementById('authVk')?.addEventListener('click', startVkLogin);
}

function initVkIdAuth() {
    if (!window.VKIDSDK) {
        if (!window.__solfVkIdLoading) return;
        setTimeout(initVkIdAuth, 500);
        return;
    }
    const VKID = window.VKIDSDK;
    if (!window.__solfVkIdConfigured) {
        VKID.Config.init({
            app: VK_APP_ID,
            redirectUrl: VK_REDIRECT_URL,
            responseMode: VKID.ConfigResponseMode.Callback,
            mode: VKID.ConfigAuthMode.InNewTab,
            source: VKID.ConfigSource.LOWCODE,
            scope: ''
        });
        window.__solfVkIdConfigured = true;
    }
}

function ensureLoginProvidersLoaded() {
    ensureGoogleSignInLoaded();
    ensureVkIdLoaded();
}

document.addEventListener('DOMContentLoaded', () => {
    bindAuthCircleClicks();
    bindOtpAuth();

    document.getElementById('loginBackBtn')?.addEventListener('click', () => {
        if (history.length > 1) history.back();
        else location.href = 'index.html';
    });

    const laterBtn = document.getElementById('loginLaterBtn');
    if (laterBtn) laterBtn.href = getReturnUrl();

    const termsCheckbox = document.getElementById('termsAccept');
    termsCheckbox?.addEventListener('change', () => {
        termsAccepted = termsCheckbox.checked;
        updateAuthGate();
    });

    updateAuthGate();
});
