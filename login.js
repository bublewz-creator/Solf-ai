// ===== SOLF.AI LOGIN PAGE =====

const WORKER_URL = 'https://solf-ai-api.mlemonw.workers.dev';
const GOOGLE_CLIENT_ID = '691304539168-iaouqdnkd73iprkcs6cou2i93t11qiak.apps.googleusercontent.com';
const VK_APP_ID = 54641545;
const VK_REDIRECT_URL = 'https://bublewz-creator.github.io/Solf-ai/';
const VKID_SDK_URL = 'https://unpkg.com/@vkid/sdk@<3.0.0/dist-sdk/umd/index.js';

let termsAccepted = false;
let providersLoaded = false;

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
    if (termsAccepted && !providersLoaded) {
        providersLoaded = true;
        ensureLoginProvidersLoaded();
    }
}

function ensureGoogleSignInLoaded() {
    if (typeof google !== 'undefined' && google.accounts) return;
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
    const btn = document.getElementById('googleSignInButton');
    if (btn && !btn.dataset.rendered) {
        btn.dataset.rendered = '1';
        google.accounts.id.renderButton(btn, {
            theme: 'filled_blue',
            size: 'large',
            shape: 'pill',
            text: 'signin_with',
            locale: 'en',
            width: 320
        });
    }
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

function renderVkIdOneTap(container) {
    if (!container || container.dataset.vkRendered === '1') return;
    const VKID = window.VKIDSDK;
    if (!VKID) return;
    container.dataset.vkRendered = '1';
    const width = Math.min(container.clientWidth || 320, 320);
    const oneTap = new VKID.OneTap();
    oneTap.render({
        container,
        scheme: getVkIdScheme(),
        lang: VKID.Languages.ENG,
        fastAuthEnabled: false,
        showAlternativeLogin: true,
        styles: {
            borderRadius: 13,
            width,
            height: 50
        },
        oauthList: ['ok_ru', 'mail_ru']
    })
    .on(VKID.WidgetEvents.ERROR, (err) => console.warn('[Solf.ai] VK ID auth error:', err))
    .on(VKID.OneTapInternalEvents.LOGIN_SUCCESS, function (payload) {
        VKID.Auth.exchangeCode(payload.code, payload.device_id)
            .then(handleVkIdAuthSuccess)
            .catch((err) => console.warn('[Solf.ai] VK ID auth error:', err));
    });
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
            source: VKID.ConfigSource.LOWCODE,
            scope: ''
        });
        window.__solfVkIdConfigured = true;
    }
    renderVkIdOneTap(document.getElementById('vkSignInButton'));
}

function ensureLoginProvidersLoaded() {
    ensureGoogleSignInLoaded();
    ensureVkIdLoaded();
}

document.addEventListener('DOMContentLoaded', () => {
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
