// ===== SOLF.AI LOGIN PAGE =====

const WORKER_URL = 'https://solf-ai-api.mlemonw.workers.dev';
const GOOGLE_CLIENT_ID = '691304539168-iaouqdnkd73iprkcs6cou2i93t11qiak.apps.googleusercontent.com';
const VK_APP_ID = 54641545;
const VK_REDIRECT_URL = 'https://bublewz-creator.github.io/Solf-ai/';
const VKID_SDK_URL = 'https://unpkg.com/@vkid/sdk@2.5.2/dist-sdk/umd/index.js';

let termsAccepted = false;
let providersLoaded = false;
let vkConfigReady = false;
let vkButtonBound = false;

(function redirectIfAlreadyLoggedIn() {
    try {
        const user = JSON.parse(localStorage.getItem('solfai_user') || 'null');
        if (user?.id && typeof getSolfSessionToken === 'function' && getSolfSessionToken()) {
            location.replace(getReturnUrl());
        }
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

function getReturnUrl() {
    const ret = new URLSearchParams(location.search).get('return');
    if (!ret || ret.includes('://') || ret.startsWith('//')) return 'index.html';
    return ret;
}

function onAuthSuccess(user, sessionToken) {
    storeSolfAuth(user, sessionToken);
    location.href = getReturnUrl();
}

async function exchangeGoogleCredential(credential) {
    const res = await fetchWithTimeout(`${WORKER_URL}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.sessionToken) {
        const detail = data.error || `HTTP ${res.status}`;
        throw new Error(detail);
    }
    onAuthSuccess(data.user, data.sessionToken);
}

async function exchangeVkTokens(payload) {
    const res = await fetchWithTimeout(`${WORKER_URL}/auth/vk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id_token: payload.id_token,
            access_token: payload.access_token,
            client_id: VK_APP_ID,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.sessionToken) {
        const detail = data.error || `HTTP ${res.status}`;
        throw new Error(detail);
    }
    onAuthSuccess(data.user, data.sessionToken);
}

function updateAuthGate() {
    const providers = document.getElementById('authProviders');
    const hint = document.getElementById('termsHint');
    if (providers) providers.classList.toggle('auth-disabled', !termsAccepted);
    if (hint) hint.hidden = termsAccepted;
    if (termsAccepted && !providersLoaded) {
        providersLoaded = true;
        ensureLoginProvidersLoaded();
    }
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
            exchangeGoogleCredential(r.credential).catch((err) => {
                console.warn('[Solf.ai] Google auth error:', err);
                alert('Sign-in failed: ' + (err.message || 'Unknown error'));
            });
        }
    });
    mountGoogleBridge();
}

function ensureVkIdLoaded() {
    if (window.VKIDSDK) {
        initVkIdAuth();
        return Promise.resolve(window.VKIDSDK);
    }
    if (window.__solfVkIdLoading) {
        return new Promise((resolve) => {
            const wait = setInterval(() => {
                if (window.VKIDSDK) {
                    clearInterval(wait);
                    initVkIdAuth();
                    resolve(window.VKIDSDK);
                }
            }, 200);
            setTimeout(() => { clearInterval(wait); resolve(null); }, 15000);
        });
    }
    window.__solfVkIdLoading = true;
    return new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = VKID_SDK_URL;
        s.async = true;
        s.onload = () => {
            try { initVkIdAuth(); } catch (e) { console.warn('[Solf.ai] VK init error:', e); }
            resolve(window.VKIDSDK || null);
        };
        s.onerror = () => {
            window.__solfVkIdLoading = false;
            console.warn('[Solf.ai] VK ID SDK unavailable.');
            resolve(null);
        };
        document.head.appendChild(s);
    });
}

function getVkIdScheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

async function handleVkIdAuthSuccess(data) {
    try {
        await exchangeVkTokens({
            id_token: data.id_token,
            access_token: data.access_token,
        });
    } catch (err) {
        console.warn('[Solf.ai] VK auth error:', err);
        alert('Sign-in failed: ' + (err.message || 'Unknown error'));
    }
}

function exchangeVkCode(payload) {
    const VKID = window.VKIDSDK;
    if (!VKID || !payload?.code) {
        throw new Error('VK authorization code missing');
    }
    return VKID.Auth.exchangeCode(payload.code, payload.device_id)
        .then(handleVkIdAuthSuccess);
}

async function startVkLogin(e) {
    e?.preventDefault?.();
    if (!termsAccepted) {
        alert('Please accept the terms first.');
        return;
    }
    const VKID = window.VKIDSDK || await ensureVkIdLoaded();
    if (!VKID) {
        alert('VK sign-in could not load. Check your connection or try Google sign-in.');
        return;
    }
    if (!vkConfigReady) initVkIdAuth();
    try {
        const result = await VKID.Auth.login({
            lang: VKID.Languages?.ENG || 'en',
            scheme: getVkIdScheme(),
        });
        await exchangeVkCode(result);
    } catch (err) {
        console.warn('[Solf.ai] VK auth error:', err);
        alert('VK sign-in failed: ' + (err?.message || err || 'Unknown error'));
    }
}

function bindAuthCircleClicks() {
    if (vkButtonBound) return;
    const btn = document.getElementById('authVk');
    if (!btn) return;
    vkButtonBound = true;
    btn.addEventListener('click', startVkLogin);
}

function initVkIdAuth() {
    if (!window.VKIDSDK) {
        if (window.__solfVkIdLoading) setTimeout(initVkIdAuth, 300);
        return;
    }
    const VKID = window.VKIDSDK;
    if (vkConfigReady) {
        bindAuthCircleClicks();
        return;
    }
    try {
        VKID.Config.init({
            app: VK_APP_ID,
            redirectUrl: VK_REDIRECT_URL,
            responseMode: VKID.ConfigResponseMode.Callback,
            source: VKID.ConfigSource.LOWCODE,
            scope: '',
            scheme: getVkIdScheme(),
        });
        vkConfigReady = true;
    } catch (e) {
        console.warn('[Solf.ai] VK ID init failed:', e);
    }
    bindAuthCircleClicks();
}

async function completeVkRedirectIfNeeded() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const deviceId = params.get('device_id');
    if (!code || !deviceId) return;

    window.history.replaceState({}, '', window.location.pathname + window.location.hash);

    try {
        await ensureVkIdLoaded();
        if (!window.VKIDSDK) throw new Error('VK SDK failed to load');
        initVkIdAuth();
        await exchangeVkCode({ code, device_id: deviceId });
    } catch (err) {
        console.warn('[Solf.ai] VK redirect auth error:', err);
        alert('VK sign-in failed: ' + (err?.message || err));
    }
}

function ensureLoginProvidersLoaded() {
    ensureGoogleSignInLoaded();
    ensureVkIdLoaded();
}

document.getElementById('termsAccept')?.addEventListener('change', (e) => {
    termsAccepted = Boolean(e.target.checked);
    updateAuthGate();
});

document.getElementById('loginBackBtn')?.addEventListener('click', () => {
    window.location.href = getReturnUrl() === 'index.html' ? 'index.html' : getReturnUrl();
});

completeVkRedirectIfNeeded();
updateAuthGate();
