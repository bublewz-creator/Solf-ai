// Shared session helpers for Solf.ai API (Cloudflare Worker Bearer tokens)
const SOLF_SESSION_KEY = 'solfai_session';

function getSolfSessionToken() {
    try {
        return localStorage.getItem(SOLF_SESSION_KEY) || '';
    } catch (_) {
        return '';
    }
}

function setSolfSessionToken(token) {
    try {
        if (token) localStorage.setItem(SOLF_SESSION_KEY, token);
        else localStorage.removeItem(SOLF_SESSION_KEY);
    } catch (_) {}
}

function solfAuthHeaders(extra = {}) {
    const headers = { ...extra };
    const token = getSolfSessionToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
}

function clearSolfAuth() {
    setSolfSessionToken('');
    try { localStorage.removeItem('solfai_user'); } catch (_) {}
}

function storeSolfAuth(user, sessionToken) {
    if (sessionToken) setSolfSessionToken(sessionToken);
    if (user) {
        try { localStorage.setItem('solfai_user', JSON.stringify(user)); } catch (_) {}
    }
}

/** После /update-plan или /get-user — синхронизировать тариф и счётчики в localStorage. */
function applyServerUserPlan(user) {
    if (!user?.id) return;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('solfai_user') || 'null'); } catch (_) {}
    const planType = user.plan_type || cached?.plan_type || 'free';
    const merged = {
        ...(cached || {}),
        id: user.id,
        email: user.email ?? cached?.email ?? '',
        name: user.name ?? cached?.name ?? '',
        picture: user.picture ?? cached?.picture ?? '',
        plan_type: planType,
        requests_count: Number.isFinite(Number(user.requests_count)) ? Number(user.requests_count) : 0,
        images_count: Number.isFinite(Number(user.images_count)) ? Number(user.images_count) : 0,
        quiz_count: Number.isFinite(Number(user.quiz_count)) ? Number(user.quiz_count) : 0,
        requests_window_start: Number(user.requests_window_start) || 0,
        images_window_start: Number(user.images_window_start) || 0,
        quiz_window_start: Number(user.quiz_window_start) || 0,
    };
    try {
        localStorage.setItem('solfai_user', JSON.stringify(merged));
        localStorage.setItem(`solfai_last_synced_plan_${user.id}`, planType);
    } catch (_) {}
}
