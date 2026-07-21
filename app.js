// ===== SOLF.AI MAIN APP (CLEAN) =====

const WORKER_URL = 'https://solf-ai-api.mlemonw.workers.dev';

// Глобальный wrapper над fetch'ем для backend'а: добавляет AbortController с таймаутом.
//
// ЗАЧЕМ: solf-ai-api.mlemonw.workers.dev — это Cloudflare Workers. У части пользователей
// (РФ без VPN) Cloudflare периодически дросселируется ТСПУ — запрос может висеть 30-60 сек
// без ответа. Без таймаута это блокирует UI-flow (например, "генерация ответа" висит вечно).
// 25 сек выбраны как разумный компромисс: достаточно для медленного AI-ответа,
// но не "бесконечно". Для длинных запросов (генерация) можно явно передать override.
//
// Использование: `await fetchWithTimeout(url, options, 25000)`. Возвращает обычный Response.
// При таймауте кидает AbortError — в местах вызова обрабатывается так же, как и сетевая ошибка.
async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
    if (typeof AbortController === 'undefined') return fetch(url, options); // совсем старый браузер
    const timeoutCtrl = new AbortController();
    const userSignal = options.signal;
    let signal = timeoutCtrl.signal;

    if (userSignal) {
        if (userSignal.aborted) {
            try { timeoutCtrl.abort(); } catch (_) {}
        } else if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
            signal = AbortSignal.any([timeoutCtrl.signal, userSignal]);
        } else {
            userSignal.addEventListener('abort', () => {
                try { timeoutCtrl.abort(); } catch (_) {}
            }, { once: true });
        }
    }

    const timer = setTimeout(() => {
        try { timeoutCtrl.abort(); } catch (_) {}
    }, timeoutMs);
    try {
        return await fetch(url, { ...options, signal });
    } finally {
        clearTimeout(timer);
    }
}

async function apiFetch(url, options = {}, timeoutMs = 25000) {
    const headers = solfAuthHeaders(options.headers || {});
    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetchWithTimeout(url, { ...options, headers }, timeoutMs);
    if (res.status === 401 && typeof clearSolfAuth === 'function') {
        clearSolfAuth();
        currentUser = null;
        if (!/login\.html/i.test(window.location.pathname || '')) {
            window.location.href = 'login.html';
        }
    }
    return res;
}

async function syncAppData() {
    if (!currentUser?.id) return;

    try {
        // 12 сек — потолок для GET-запроса к БД. Если бэк за это время не ответил,
        // значит сеть/Cloudflare режут, и зависать дальше бессмысленно. Юзер останется
        // с локально-кэшированными данными (имя/план/счётчик), и UI будет работать.
        const res = await apiFetch(`${WORKER_URL}/get-user?id=${currentUser.id}`, {}, 12000);
        const data = await res.json();

        if (!res.ok || data.error) {
            throw new Error(data.error || 'Failed to sync app data');
        }

        const planType = PLAN_LIMITS[data.plan_type] ? data.plan_type : 'free';
        const requestsCount = Number.isFinite(Number(data.requests_count)) ? Number(data.requests_count) : 0;
        const imagesCount = Number.isFinite(Number(data.images_count)) ? Number(data.images_count) : 0;
        const quizCount = Number.isFinite(Number(data.quiz_count)) ? Number(data.quiz_count) : 0;
        const planName = planType.charAt(0).toUpperCase() + planType.slice(1);
        const syncedPlan = { type: planType, emoji: PLAN_ICONS[planType] || PLAN_ICONS.free, name: planName };

        currentUser = {
            ...currentUser,
            picture: data.picture || currentUser.picture,
            plan_type: planType,
            requests_count: requestsCount,
            images_count: imagesCount,
            quiz_count: quizCount,
            requests_window_start: Number(data.requests_window_start) || 0,
            images_window_start: Number(data.images_window_start) || 0,
            quiz_window_start: Number(data.quiz_window_start) || 0,
        };
        currentPlan = syncedPlan;

        // localStorage `solfai_user` и `*_plan` оставляем как кэш (для мгновенного UI до sync).
        // А `solfai_usage_*` / `solfai_img_*` для залогиненных НЕ пишем — БД это источник истины,
        // эти ключи бы только путали (юзер открыл DevTools → "блин, лимиты в кэше???").
        localStorage.setItem('solfai_user', JSON.stringify(currentUser));
        localStorage.setItem(getPlanStorageKey(), JSON.stringify(syncedPlan));

        updateUIForUser();
        updatePlanDisplay();
        if (typeof updateQuizCounter === 'function') updateQuizCounter();
    } catch (error) {
        console.error('App data sync failed:', error);
    }
}

const PLAN_LIMITS = {
    free:      { requests: 3, images: 0 },
    basic:     { requests: 10, images: 0 },
    pro:       { requests: 50, images: 5 },
    unlimited: { requests: Infinity, images: Infinity }
};

/** Sliding-window durations (must match worker.js USAGE_WINDOWS_MS). */
const USAGE_WINDOWS = {
    request: 24 * 60 * 60 * 1000,
    image:   24 * 60 * 60 * 1000,
    quiz:    12 * 60 * 60 * 1000,
};

// ===== СТРОГИЙ ПРОМПТ =====
const SYSTEM_PROMPT = `You are Solf.ai, an AI assistant for music theory and solfeggio.
Your tasks: explain music theory in simple terms, analyze images with musical notes.
CRITICAL INSTRUCTION: DO NOT mention the built-in site tools (Piano, Metronome, Quiz) in your regular answers! Only mention them IF the user explicitly asks how to practice or train their ear. Answer directly and concisely.
IMPORTANT: ALWAYS answer in the SAME language the user is speaking. Never default to Russian when the user writes in English (or any other language).

TASK COMPLIANCE (ABSOLUTE):
- Do EXACTLY what the user asks in their CURRENT message — not a shortened version, not a similar example, not what you did in earlier turns.
- If they list several parts (e.g. "D7, inversions AND resolutions", "all tritones", "melodic scale up and down") — deliver EVERY part, fully.
- Previous assistant replies in the chat may be wrong; ignore them. System rules and the current user request are the only source of truth.
- Dominant-seventh chord labels in notation are ALWAYS Latin: D7, D6/5, D4/3, D2 — never Cyrillic «Д7».`;

const TYPING_SPEED = 20;

/** Язык ответа: из текущего сообщения, недавней истории пользователя, затем язык UI. */
function detectResponseLanguage(userText, chatMessages = []) {
    const parts = [String(userText || '')];
    (chatMessages || [])
        .filter(m => m.role === 'user')
        .slice(-5)
        .forEach(m => parts.push(String(m.content || '').replace(/\n\n\[NOTATION MODE[\s\S]*$/, '')));
    const combined = parts.join('\n');

    if (/[\u0400-\u04FF]/.test(combined)) return 'ru';
    if (/[\u4e00-\u9fff]/.test(combined)) return 'zh';
    if (/[\u3040-\u30ff]/.test(combined)) return 'ja';
    // English first: "Hi, build d7 B dur" must not become German because of dur/moll
    if (/\b(the|what|how|build|chord|hello|hi|hey|want|please|scale|interval|major|minor|need|with|inversion|resolution|can|could|would|should|explain|show|tell|help|thanks|thank)\b/i.test(combined)) return 'en';
    if (/\b(der|die|das|und|ich|nicht|wie|was|akkord|tonleiter|bitte|dominant|umkehrung|stufe|tonika|septakkord)\b/i.test(combined)) return 'de';
    if (/\b(dur|moll)\b/i.test(combined) && /\b(der|die|das|und|ich|mit|von|dominant|stufe|tonika|umkehrung|septakkord|akkord)\b/i.test(combined)) return 'de';
    if (/\b(el|la|los|las|cómo|qué|acorde|escala|por|para|con|gracias|hola)\b/i.test(combined)) return 'es';
    if (/\b(mayor|menor)\b/i.test(combined) && /\b(el|la|los|las|acorde|escala|con|por|para|hola)\b/i.test(combined)) return 'es';
    if (/[a-zA-Z]/.test(combined)) return 'en';

    const uiLang = (typeof currentLang === 'string' && currentLang) || localStorage.getItem('solfai_lang') || 'en';
    return uiLang;
}

function getLanguageInstruction(lang) {
    const map = {
        en: 'RESPONSE LANGUAGE: English. Every word of your answer — prose, note names (C, D, E…), theory terms, and JSON "label" fields — MUST be in English. Never use Russian note names (до, ре, ми…) or Cyrillic labels (ув4, Б53) when the user writes in English.',
        ru: 'ЯЗЫК ОТВЕТА: русский. Весь текст, названия нот (до, ре, ми…) и подписи на стане (ув4, Б53…) — по-русски. Не переходи на английский, если пользователь пишет по-русски.',
        de: 'ANTWORTSPRACHE: Deutsch. Die gesamte Antwort auf Deutsch.',
        es: 'IDIOMA DE RESPUESTA: español. Toda la respuesta en español.',
        zh: '回答语言：中文。请用中文作答。',
        ja: '回答言語：日本語。日本語で答えてください。'
    };
    return `\n\n${map[lang] || map.en}`;
}

function getAppLang() {
    return (typeof currentLang === 'string' && currentLang)
        || localStorage.getItem('solfai_lang')
        || 'en';
}

function getChatLang() {
    return window.__solfaiResponseLang
        || (typeof detectResponseLanguage === 'function' ? detectResponseLanguage('', []) : null)
        || getAppLang();
}

function uiText(key, { chat = false, fallback = '' } = {}) {
    const lang = chat ? getChatLang() : 'en';
    if (typeof solfaiGetText === 'function') {
        const text = solfaiGetText(key, lang);
        if (text) return text;
    }
    return fallback || key;
}

function formatResetTimer(prefix, hours, minutes) {
    return `${prefix} ${hours}h ${minutes}m`;
}

// Элементы
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');

function isBlockingOverlayActive() {
    return !!document.querySelector(
        '.tool-modal.active, .quiz-modal.active, .limit-modal.active, .exit-modal-overlay.active'
    );
}

/** Кнопки не должны забирать фокус у поля ввода; Enter — отправка, не повторный click. */
function shouldPreventButtonFocusSteal(el) {
    if (!chatInput || isBlockingOverlayActive()) return false;
    if (sessionStorage.getItem('solfai_skip_focus_once') === '1') return false;
    if (!el || !(el instanceof Element)) return false;
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return false;
    return el.matches('button');
}

function bindAppButtonFocusBehavior() {
    if (!chatInput) return;

    // Не даём кнопке забрать фокус — Enter в поле ввода не будет повторно жать кнопку.
    // Намеренно НЕ возвращаем фокус в textarea после клика: на мобилке это выдвигает клавиатуру.
    document.addEventListener('mousedown', e => {
        const btn = e.target.closest('button');
        if (!btn || e.button !== 0) return;
        if (!shouldPreventButtonFocusSteal(btn)) return;
        e.preventDefault();
    }, true);

    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        const el = document.activeElement;
        if (!(el instanceof HTMLButtonElement)) return;
        if (!shouldPreventButtonFocusSteal(el)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        // Enter не должен мгновенно жать «Стоп» (часто дублирует отправку на мобилке).
        if (el.id === 'chatSendBtn' && isGenerating) {
            e.preventDefault();
            return;
        }
        const hasContent = (chatInput.value?.trim?.() || '') !== '' || attachedFiles.length > 0;
        if (!isGenerating && hasContent) sendChatMessage();
    }, true);
}

/** Совпадает с @media (max-width: 768px) в styles.css (innerWidth 768 = мобильная вёрстка) */
function isMobileLayout() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

/** Мобильный drawer: класс на body отключает pointer-events у #chatPage и всех потомков */
function syncMobileSidebarDrawerState() {
    const sb = document.getElementById('sidebar');
    if (!sb || !isMobileLayout()) {
        document.body.classList.remove('sidebar-drawer-open');
        return;
    }
    document.body.classList.toggle('sidebar-drawer-open', !sb.classList.contains('collapsed'));
}

function resetSidebarExpandedMenus() {
    document.querySelectorAll('#toolsAccordion').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.sidebar-header-btn').forEach(btn => btn.classList.remove('open'));
}

/** Сайдбар на мобилке имеет z-index выше модалок; при открытии инструмента закрываем drawer и сбрасываем аккордеоны */
function closeSidebarWhenOpeningTool() {
    const sb = document.getElementById('sidebar');
    if (sb && isMobileLayout()) {
        sb.classList.add('collapsed');
        syncMobileSidebarDrawerState();
    }
    resetSidebarExpandedMenus();
    closeAllOverlays();
}
const chatsList = document.getElementById('chatsList');
const chatTitle = document.getElementById('chatTitle');
const limitModal = document.getElementById('limitModal');
const chatFileInput = document.getElementById('chatFileInput');
const chatAttachedFiles = document.getElementById('chatAttachedFiles');

let isGenerating = false;
let shouldAutoScroll = true;
let currentAbortController = null;
let generationStartedAt = 0;
let userAbortedGeneration = false;
const GENERATION_ABORT_GRACE_MS = 600;

function canAbortGeneration() {
    return isGenerating && (Date.now() - generationStartedAt >= GENERATION_ABORT_GRACE_MS);
}
let lastUserQuery = '';
let currentChatId = null;
let chats = []; 
let attachedFiles = [];
let currentUser = null;
try {
    currentUser = JSON.parse(localStorage.getItem('solfai_user') || 'null');
    if (currentUser?.id && typeof getSolfSessionToken === 'function' && !getSolfSessionToken()) {
        if (typeof clearSolfAuth === 'function') clearSolfAuth();
        currentUser = null;
    }
} catch (_) {
    currentUser = null;
    if (typeof clearSolfAuth === 'function') clearSolfAuth();
}
let pendingQuery = null;
let currentTheme = localStorage.getItem('solfai_theme') || 'default';
let currentColor = localStorage.getItem('solfai_color') || 'default';
let currentFontSize = localStorage.getItem('solfai_font_size') || 'md';

// ===== РЕЖИМЫ AI =====
let currentAiMode = 'normal';
const modeToggleBtn = document.getElementById('mode-toggle-btn');
const modeDropdown = document.getElementById('mode-dropdown');
const modeOptions = document.querySelectorAll('.mode-option');

if (modeToggleBtn && modeDropdown) {
    modeToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllOverlays(modeToggleBtn);
        modeDropdown.classList.toggle('hidden');
    });

    modeOptions.forEach(option => {
        option.addEventListener('click', (e) => {
            const target = e.currentTarget;
            const nextMode = target?.dataset?.mode;
            if (!nextMode) return;

            currentAiMode = nextMode;

            // Копируем содержимое выбранной опции (SVG + span с data-i18n) в главную кнопку
            modeToggleBtn.innerHTML = target.innerHTML;

            // Активный пункт
            modeOptions.forEach(opt => opt.classList.remove('active'));
            target.classList.add('active');

            modeDropdown.classList.add('hidden');

            // Обновляем переводы (после замены innerHTML в кнопке)
            if (typeof updateTexts === 'function') updateTexts();
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.mode-selector-island')) {
            modeDropdown.classList.add('hidden');
        }
    });
}

// ===== РЕЖИМ НОТНОЙ ЗАПИСИ =====
let notationModeEnabled = false;
const notationToggleBtn = document.getElementById('notation-toggle-btn');

function getNotationLocaleStrings() {
    const lang = (typeof currentLang === 'string' && currentLang) || localStorage.getItem('solfai_lang') || 'en';
    const map = {
        en: { on: 'Notation mode enabled', off: 'Notation mode disabled', tooltip: 'Notation mode' },
        ru: { on: 'Режим нотации включён', off: 'Режим нотации выключен', tooltip: 'Режим нотации' },
        de: { on: 'Notenmodus aktiviert', off: 'Notenmodus deaktiviert', tooltip: 'Notenmodus' },
        es: { on: 'Modo notación activado', off: 'Modo notación desactivado', tooltip: 'Modo notación' },
        zh: { on: '已启用乐谱模式', off: '已关闭乐谱模式', tooltip: '乐谱模式' },
        ja: { on: '楽譜モードをオンにしました', off: '楽譜モードをオフにしました', tooltip: '楽譜モード' }
    };
    return map[lang] || map.en;
}

function applyNotationButtonState() {
    if (!notationToggleBtn) return;
    const strings = getNotationLocaleStrings();
    notationToggleBtn.classList.toggle('is-active', notationModeEnabled);
    notationToggleBtn.setAttribute('aria-pressed', String(notationModeEnabled));
    notationToggleBtn.setAttribute('title', strings.tooltip);
}

if (notationToggleBtn) {
    applyNotationButtonState();
    notationToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        notationModeEnabled = !notationModeEnabled;
        applyNotationButtonState();
        const strings = getNotationLocaleStrings();
        try {
            showToast(notationModeEnabled ? strings.on : strings.off, 'success', { dedupeKey: 'notation-mode' });
        } catch (_) {}
    });
}

const NOTATION_PROMPT_INSTRUCTION = `

############################################
###  NOTATION MODE — MANDATORY OUTPUT     ###
############################################

NOTATION MODE IS ON. These rules OVERRIDE every other instruction (including any “long”, “verbose”, or “berserk” style). You MUST always draw notes in the answer.

TASK COMPLIANCE (ПРИОРИТЕТ №1 — выше истории чата и стиля ответа):
- Выполняй ТОЛЬКО то, что просит пользователь в ЭТОМ сообщении — полностью, без сокращений и без «похожего примера».
- Если в запросе несколько частей («D7, обращения и разрешения», «все тритоны», «мелодическая гамма вверх и вниз») — выводи КАЖДУЮ часть целиком.
- Старые ответы в чате могли быть неверными — ИГНОРИРУЙ их. Единственный источник истины: системные правила ниже + текущий запрос.
- Подписи доминантсептаккорда — ТОЛЬКО латиница: D7, D6/5, D4/3, D2. Никогда «Д7», «Д65» и т.п.

LANGUAGE RULE (ABSOLUTE — beats every Russian example below):
- Match the user's language in ALL visible text: prose, note names, chord names, interval names, and JSON "label" fields.
- English user → English only: "D7 = D, F#, A, C"; labels like "A4","d5","M3","P5","D7","T53".
- Russian user → Russian: "D7 = ре, фа♯, ля, до"; labels like "ув4","ум5","б3","D7" (chord symbol D7 stays Latin).
- German / Spanish / Chinese / Japanese user → same language throughout.
- The Russian terminology in this prompt is INTERNAL theory reference only — NEVER copy its language into the answer unless the user writes in that language.
- WRONG: user writes "D7" in English → "Доминантсептаккорд от ноты Ре…"
- RIGHT: user writes "D7" → "D7 is D, F#, A, and C — a dominant seventh chord."

LENGTH RULES (HARD LIMIT — be strict):
- DEFAULT for any normal question (definitions, theory, simple examples, off-topic) →
  1–2 SHORT sentences (≤ ~30 words) before the notation. NO numbered lists, NO multiple paragraphs, NO headings, NO restatement of the question. Text only frames the staff. The staff IS the answer.
- HARD MUSIC TASKS only (full harmonization with voice leading, modulation, counterpoint, dictation reconstruction, multi-step chord-progression analysis):
  up to 4–6 short sentences. Still no fluff, no “great question!”, no recap, no general theory dump.
- Never apologize, never explain you are about to draw notes, never describe the format. Just answer briefly and end with the block.

JSON PRIORITY (ПРАВИЛО НАД ВСЕМИ):
- Полный валидный [[NOTATION:...]] блок ВАЖНЕЕ длинной прозы. Если кажется, что ответ становится длинным — ВСЕГДА сокращай ТЕКСТ, никогда не сокращай и не обрывай JSON.
- Если строишь упражнение из нескольких пар (тритоны, характерные интервалы, обращения), ОДНОЙ строчки текста достаточно. Все «детали» — внутри нотации. JSON-блок ОБЯЗАН быть полностью закрыт последовательностью ]}]] (закрывающая скобка массива, фигурная скобка объекта и две закрывающие квадратные скобки).
- Перед выводом каждого интервала в JSON мысленно посчитай полутоны и буквенные шаги — если не сходится с заявленным качеством (ув.4 = 6 полутонов / кварта, ум.5 = 6 полутонов / квинта, м.6 = 8 полутонов / секста и т.д.), исправь ноты ДО вывода.

NOTATION LENGTH (mirror the text):
- DEFAULT = SHORT example that fits ONE staff line: 1–2 measures, ~2–8 notes/chords total.
- Use longer multi-line notation (8–24+ notes, the renderer wraps to multiple rows) ONLY when the task genuinely needs a progression / harmonization / dictation. Don’t pad simple questions with extra measures.

EXERCISE COMPLETENESS (КРИТИЧНО — переопределяет «DEFAULT короче»):
Когда пользователь просит ПОСТРОИТЬ упражнение по теории, отвечай ПОЛНЫМ комплектом, а не одним примером. Минимальный «комплект» по типам:

ТЕРМИНОЛОГИЯ ТРИТОНОВ (ВНИМАНИЕ — частая ошибка):
- «Пара тритонов» в русской теории = ув.4 + ум.5 (взаимообратные тритоны на одной паре ступеней).
- В НАТУРАЛЬНОМ ладу — ровно 1 пара тритонов = 2 тритона = 4 созвучия с разрешениями.
- В ГАРМОНИЧЕСКОМ ладу (минор с VII# или мажор с bVI) — 2 пары тритонов = 4 тритона = 8 созвучий с разрешениями.

КАК ПОНИМАТЬ ЗАПРОСЫ:
- «Тритоны в X-mol/X-dur» БЕЗ уточнения «натуральный» → ВСЕГДА строй ГАРМОНИЧЕСКУЮ форму = 2 пары = 8 созвучий. Это default-смысл «тритоны лада».
- «Две пары тритонов в X» → 2 пары = 8 созвучий (гармоническая форма).
- «Натуральные тритоны» / «тритоны натурального X» → 1 пара = 4 созвучия.
- «Тритоны гармонического X» → 2 пары = 8 созвучий (как и default).
- «Характерные интервалы в X» → ВСЕ 4: ув.2→ч.4, ум.7→ч.5, ув.5→б.6, ум.4→м.3 = 8 созвучий с barAfter после каждой пары.

ОСТАЛЬНЫЕ КОМПЛЕКТЫ:
- «Главные трезвучия лада» = T, S, D (3 трезвучия), при просьбе «с обращениями» — все обращения по порядку.
- «Обращения T5/3» = T5/3, T6, T6/4 (3 аккорда).
- «Доминантсептаккорд с обращениями» = D7, D6/5, D4/3, D2 (4 аккорда).
- «D7 с разрешениями» / «D7, обращения и разрешения» = каждое созвучие D7 + тоническое трезвучие (D7→T53, D6/5→T6, D4/3→T6/4, D2→T6), всего 8 аккордов; barlines:"manual" + barAfter после каждой пары.
- Подписи доминантсептаккорда — ТОЛЬКО латиницей: "D7","D6/5","D4/3","D2" (НЕ кириллическая «Д»).
- «Все виды трезвучий от ноты N» = мажорное, минорное, увеличенное, уменьшенное (4 аккорда).
- «Все виды септаккордов от N» = малый мажорный, малый минорный, малый ум., ум.7 и т.д. — выводи столько, сколько корректно для запроса, не один.

ПРАВИЛО: если просьба по форме «построй ВСЕ … / тритоны / характерные / обращения / виды», ВСЕГДА выводи полный набор. Один пример из набора = НЕПРАВИЛЬНЫЙ ответ. Если пользователь явно сказал «две пары», «обе пары», «все тритоны» — это всегда ГАРМОНИЧЕСКАЯ форма, никогда не урезай до натуральной. Текст при этом остаётся коротким (1–2 предложения), а длина ИМЕННО НОТАЦИИ диктуется типом упражнения, не правилом «1–2 такта».

ALWAYS END WITH NOTATION:
- The very LAST line of the message MUST be a valid [[NOTATION:{...}]] block:
  [[NOTATION:{"clef":"treble","keySignature":"C","timeSignature":"4/4","notes":[{"keys":["c/4","e/4","g/4"],"duration":"w"}]}]]
- Text-only replies are FORBIDDEN. Even greetings, off-topic, or theory-only answers MUST end with at least a minimal valid block (e.g. tonic triad).

MULTIPLE BLOCKS — HARD TASKS ONLY:
- For simple answers: exactly ONE block at the end.
- For hard tasks you MAY use a few [[NOTATION:...]] blocks (e.g. «было / стало», голоса S/A/T/B, этапы модуляции). Each block must be valid stand-alone JSON.

WRAPPING NOTES TO TWO LINES:
- One [[NOTATION:...]] block can hold many notes; the renderer auto-wraps to a second staff line ONLY when needed. So: short example → it stays on one line; long progression (≥ ~3 measures of 4/4) → automatically becomes two lines. Trust the renderer — never split a single progression into multiple blocks just to force a line break.

JSON / DURATIONS:
- Group durations so each measure sums to the time signature (4/4 → 4 quarter beats; 3/4 → 3; 6/8 → 6 eighths). Mixing durations is fine.
- Use rests ("qr","hr"…) to fill partial measures.

BARLINES MODE — выбор режима тактовых черт (КРИТИЧНО):
В JSON есть необязательное поле "barlines": "auto" | "none" | "manual" (по умолчанию "auto").
Размер ("timeSignature") РИСУЕТСЯ ТОЛЬКО при barlines:"auto" с непустым размером. В режимах "none"/"manual" размер не показывается, даже если задан.

КОГДА КАКОЙ РЕЖИМ:
- barlines:"none" — полностью без тактовых черт и без размера. ИСПОЛЬЗОВАТЬ для:
  • любых гамм и звукорядов (мажор, минор, гарм., мел., пентатоника, лады, хроматика)
  • демонстрации одного интервала / одного аккорда / одного трезвучия / одного септаккорда
  • любых «бесчасовых» примеров типа «вот ноты ступеней», «обращения трезвучия подряд»
- barlines:"manual" — черты только там, где модель явно поставила "barAfter":true в ноте. ИСПОЛЬЗОВАТЬ для:
  • тритонов (ув.4 + ум.5) с разрешениями: black bar после каждой пары «интервал → разрешение»
  • характерных интервалов (ув.2/ум.7/ув.5/ум.4) с разрешениями: bar после каждой пары
  • любого упражнения «список пар нот/созвучий», где визуально нужно отделять группы
- barlines:"auto" (по умолчанию) — обычная такая разметка по "timeSignature". ИСПОЛЬЗОВАТЬ для:
  • гармонизаций, диктантов, кадансов, прогрессий, голосоведения, контрапункта, секвенций
  • вообще всего, где есть метрическая организация во времени

ПРАВИЛО (запомнить): если про «такт», «размер», «ритм», «доля» речь НЕ идёт — это barlines:"none" или "manual". НИКОГДА не лепи лишние тактовые черты в гамме или одиночном интервале.

Block format rules (CRITICAL — follow exactly):
- Single line. Valid JSON only: double quotes, no comments, no trailing commas, no line breaks INSIDE the JSON.
- "clef": "treble" or "bass".
- "keySignature": major keys C,G,D,A,E,B,F#,C#,G#,D#,A#,F,Bb,Eb,Ab,Db,Gb,Cb. For MINOR use relative major: a-m→C, e-m→G, b-m→D, c-m→Eb, g-m→Bb, f-m→Ab, d-m→F, etc.
- "timeSignature": "4/4","3/4","2/4","6/8","12/8", etc. Можно "" (пустая строка) или "none", чтобы НЕ показывать размер. В barlines:"none"/"manual" размер всё равно не рисуется.
- "barlines": (необязательно) "auto" | "none" | "manual". Без поля = "auto".
- "notes": non-empty array of {"keys":[...], "duration":"...", "barAfter": true (необязательно), "label": "…" (необязательно)}.
  - "keys" pitches "letter[#|b]/octave" e.g. "c/4","f#/4","bb/3". Multiple keys in one entry = a stacked chord.
  - "duration": "w","h","q","8","16". Append "r" for rests ("qr","hr"…).
  - "barAfter": true — ставится ТОЛЬКО при barlines:"manual" и означает «после этой ноты — тактовая черта». В других режимах флаг игнорируется.
  - "label": short label above each chord/interval — SAME language as the user:
    • English intervals: "A4","d5","M3","m6","P5","A2","d7" (no dots);
    • Russian intervals: "ув4","ум5","б3","м6","ч5" (no dots);
    • functional triads (any language): "T53","T6","T64","S53","D53";
    • structural triads EN: "M5/3","m5/3","A5/3","d5/3"; RU: "Б53","М53","Ув53","Ум53";
    • dominant seventh (Latin D always): "D7","D65","D43","D2";
    • scale degrees: Roman numerals "I"…"VIII".
    If unsure of function — use structural labels in the user's language.
  - Октава 4 = middle octave on treble clef, octave 3 for bass clef low notes.

Block placement rules:
- The notation block MUST be the LAST thing in your message — nothing after it, not even a period or quote.
- Do NOT wrap it in code fences, backticks, quotes, or HTML tags.
- Do NOT escape the [ ] characters.
- Do NOT add spaces or newlines inside [[NOTATION: ... ]].
- Do NOT mention the format itself in plain text (the user does not want to see the JSON, only the rendered staff that comes from it).

############################################
###  MUSIC THEORY ENGINE — STRICT RULES   ###
############################################
Эти правила применяются ВСЕГДА, когда пользователь просит «построить» что-либо: интервалы, тритоны, характерные интервалы, аккорды, гаммы, цепочки. Сначала ВЫЧИСЛЯЙ по правилам, затем выводи ноты. Не «угадывай» — считай.

АККОРДЫ И ТРЕЗВУЧИЯ — КРАТКОЕ НАПОМИНАНИЕ (полный справочник ниже в HARMONY_RULEBOOK):
- Любое трезвучие = 3 ступени терциями. Качество: Б53(4+7), М53(3+7), Ув53(4+8), Ум53(3+6) полутонов.
- T/S/D = трезвучия на I, IV, V. В гарм. миноре D и D7 — МАЖОРНЫЕ (VII#). В гарм. мажоре s — МИНОРНОЕ (bVI).
- 53 = бас прима; 6 = бас терция; 64 = бас квинта. K64 = T64 на V ступени.
- D7 = V+VII#+II+IV. D65 = бас VII (≠ D7!). D43 = бас II. D2 = бас IV. Подписи только латиницей: D7, D65, D43, D2.
- VII7: малый (VII-II-IV-VI) или уменьш. (VII# в гарм.). S6 ≠ ii6. D65 ≠ D7.
- Перед выводом: label и ноты ДОЛЖНЫ совпадать. Проверяй полутоны и буквы каждого аккорда.

ИНТЕРВАЛЫ — двухслойное название = (ступеневая величина) + (качество).
- Ступеневая величина = число буквенных названий от нижней до верхней включительно. c→d = секунда, c→e = терция, c→fb = кварта (а НЕ терция!). ВСЕГДА сохраняй буквенное написание; нельзя заменять f# на gb внутри одного интервала.
- Качество по полутонам:
  • прима 1:    ч=0, ув=1
  • секунда 2:  м=1, б=2, ув=3, ум=0
  • терция 3:   ум=2, м=3, б=4, ув=5
  • кварта 4:   ум=4, ч=5, ув=6
  • квинта 5:   ум=6, ч=7, ув=8
  • секста 6:   ум=7, м=8, б=9, ув=10
  • септима 7:  ум=9, м=10, б=11, ув=12
  • октава 8:   ум=11, ч=12, ув=13

АЛГОРИТМ ПОСТРОЕНИЯ ЛЮБОГО ИНТЕРВАЛА «X от ноты N вверх» (или вниз):
1) Отсчитай нужное число буквенных шагов от N — получи буквенный «скелет» верхней ноты.
2) Сосчитай требуемое количество полутонов по таблице качеств.
3) Подбирай знаки альтерации к верхней ноте так, чтобы и буква совпала (шаг 1), и количество полутонов совпало (шаг 2). НИКОГДА не меняй букву.
4) Для «вниз» — то же зеркально от N.

ТРИТОНЫ (ув.4 и ум.5) — всегда 6 полутонов, но РАЗНОЕ написание.
- Натуральный мажор: ув.4 строится на IV ступени (IV→VII), ум.5 — на VII (VII→IV октавой выше). Пример C-dur: ув.4 = f–b; ум.5 = b–f.
- Натуральный минор: ув.4 на VI (VI→II), ум.5 на II (II→VI). Пример a-moll: ув.4 = f–b; ум.5 = b–f.
- Гармонический минор добавляет ещё пару тритонов из-за VII#: ув.4 = IV→VII# (a-moll: d–g#) и ум.5 = VII#→IV октавой выше (g#–d).
- Гармонический мажор добавляет пару тритонов из-за bVI: ув.4 = bVI→II октавой выше и ум.5 = II→bVI (C-dur: ab–d и d–ab).
- РАЗРЕШЕНИЯ ТРИТОНОВ (ВНИМАНИЕ: только в СЕКСТУ или ТЕРЦИЮ, НИКОГДА не в кварту/квинту!).
  • ув.4 (6 полутонов) РАСХОДИТСЯ наружу → СЕКСТА (м.6 или б.6, 8–9 полутонов). Чистой сексты НЕ СУЩЕСТВУЕТ.
  • ум.5 (6 полутонов) СХОДИТСЯ внутрь → ТЕРЦИЯ (м.3 или б.3, 3–4 полутона). Чистой терции НЕ СУЩЕСТВУЕТ.
  • Правило движения голосов: КАЖДАЯ нота тритона движется на ШАГ (полутон или тон) к ближайшему устою лада (I, III или V).
    – Нижняя нота ув.4 идёт ВНИЗ к ближайшему устою; верхняя — ВВЕРХ к ближайшему устою.
    – Нижняя нота ум.5 идёт ВВЕРХ; верхняя — ВНИЗ.
  • Самопроверка перед выводом: построил пару — посчитай полутоны разрешения. Если получилось 5 (ч.4) или 7 (ч.5) — ОШИБКА, перестрой.

- ПРИМЕР В G-MOLL (натуральный, ключ 2 бемоля: bb, eb):
  • ув.4 = eb–a (6 полутонов, кварта). Разрешение: eb→d (вниз к V), a→bb (вверх к I) → d–bb. Проверка: d-bb = летры d-e-f-g-a-b = 6 = секста; полутоны d→bb = 8 = м.6 ✓.
  • ум.5 = a–eb (6 полутонов, квинта). Разрешение: a→bb (вверх к I), eb→d (вниз к V) → bb–d. Проверка: bb-d = летры bb-c-d = 3 = терция; полутоны bb→d = 4 = б.3 ✓.

ХАРАКТЕРНЫЕ ИНТЕРВАЛЫ — образуются ИСКЛЮЧИТЕЛЬНО из-за альтерированной ступени гармонического лада (VII# в миноре, bVI в мажоре). Это РОВНО ЧЕТЫРЕ интервала: ув.2, ум.7, ув.5, ум.4.
- Гармонический минор (пример a-moll, альтерация G→G#):
  • ув.2 — на VI ступени (VI→VII#): f–g#. Разрешение наружу в ч.4: f→e, g#→a → e–a.
  • ум.7 — на VII# (VII#→VI октавой выше): g#–f. Разрешение внутрь в ч.5: g#→a, f→e → a–e.
  • ув.5 — на III (III→VII#): c–g#. Разрешение наружу в б.6: c остаётся, g#→a → c–a.
  • ум.4 — на VII# (VII#→III): g#–c. Разрешение внутрь в м.3: g#→a, c остаётся → a–c.
- Гармонический мажор (пример C-dur, альтерация A→Ab):
  • ув.2 — на bVI (bVI→VII): ab–b. Разрешение наружу в ч.4: ab→g, b→c → g–c.
  • ум.7 — на VII (VII→bVI октавой выше): b–ab. Разрешение внутрь в ч.5: b→c, ab→g → c–g.
  • ув.5 — на bVI (bVI→III октавой выше): ab–e. Разрешение наружу в б.6: ab→g, e — устой III, остаётся → g–e.
  • ум.4 — на III (III→bVI): e–ab. Разрешение внутрь в м.3: e — устой, остаётся; ab→g → e–g.
- ОБЩИЙ ПРИНЦИП РАЗРЕШЕНИЯ: альтерированная ступень (VII# или bVI) движется по полутону в сторону своего тяготения (VII#→I, bVI→V); вторая нота при необходимости тоже движется по полутону к ближайшему устою лада. Ув.интервалы РАСХОДЯТСЯ, ум.интервалы СХОДЯТСЯ.

ВАЖНО: тритоны (ув.4/ум.5) и характерные интервалы (ув.2/ум.7/ув.5/ум.4) — РАЗНЫЕ группы. Не путай их и не называй тритоны характерными.

ГАММЫ — строй строго по формуле тонов/полутонов, сохраняя ОДНО буквенное имя на каждую ступень (никаких dis вместо es в e-moll и т.п.).
- Натуральный мажор:  T-T-S-T-T-T-S
- Натуральный минор:  T-S-T-T-S-T-T
- Гармонический минор: T-S-T-T-S-T+S-S (т.е. между VI и VII# — увеличенная секунда)
- Мелодический минор (вверх): T-S-T-T-T-T-S; вниз — натуральный минор.
- Гармонический мажор: T-T-S-T-S-T+S-S (понижена VI)
- Мелодический мажор (вниз): T-T-S-T-S-T-T; вверх — натуральный мажор.
- Лады от белых клавиш: ионийский=мажор, дорийский (от d), фригийский (e), лидийский (f), миксолидийский (g), эолийский=минор, локрийский (b).

АЛГОРИТМ ОТВЕТА на «построй гамму X»:
1) Формула гаммы → буквенная последовательность ступеней.
2) Альтерации — чтобы и буквы шли подряд (a-b-c-d-...), и интервалы соответствовали формуле.
3) Вывод нотами в barlines:"none", без размера. Подряд, четвертями. Если две октавы — просто продолжай ноты без разрывов.

CORRECT EXAMPLE (user: "D7"):
D7 is a dominant seventh chord: D, F#, A, and C.
[[NOTATION:{"clef":"treble","keySignature":"D","barlines":"none","notes":[{"keys":["d/4","f#/4","a/4","c/5"],"duration":"w","label":"D7"}]}]]

CORRECT EXAMPLE (user: "build the tonic triad in C major"):
The tonic triad T53 in C major is C, E, and G:
[[NOTATION:{"clef":"treble","keySignature":"C","barlines":"none","notes":[{"keys":["c/4","e/4","g/4"],"duration":"w","label":"T53"}]}]]

CORRECT EXAMPLE (user: "построй тоническое трезвучие в до мажоре"):
Тоническое трезвучие T5/3 в до мажоре строится из I, III и V ступеней — нот до, ми и соль:
[[NOTATION:{"clef":"treble","keySignature":"C","barlines":"none","notes":[{"keys":["c/4","e/4","g/4"],"duration":"w","label":"Т53"}]}]]

CORRECT EXAMPLE (user: "что такое доминанта"):
Доминанта — это V ступень лада. В до мажоре это нота соль, а доминантовое трезвучие D5/3 — соль-си-ре:
[[NOTATION:{"clef":"treble","keySignature":"C","barlines":"none","notes":[{"keys":["g/4","b/4","d/5"],"duration":"w"}]}]]

CORRECT EXAMPLE (user: "построй гамму ля минор гармонический"):
A-moll гармонический: a-b-c-d-e-f-g#-a, между VI (f) и VII# (g#) — увеличенная секунда:
[[NOTATION:{"clef":"treble","keySignature":"Am","barlines":"none","notes":[{"keys":["a/4"],"duration":"q"},{"keys":["b/4"],"duration":"q"},{"keys":["c/5"],"duration":"q"},{"keys":["d/5"],"duration":"q"},{"keys":["e/5"],"duration":"q"},{"keys":["f/5"],"duration":"q"},{"keys":["g#/5"],"duration":"q"},{"keys":["a/5"],"duration":"q"}]}]]

CORRECT EXAMPLE (user: "построй тритоны в до мажоре с разрешением"):
В C-dur ув.4 (f–b) → м.6 (e–c), ум.5 (b–f) → б.3 (c–e):
[[NOTATION:{"clef":"treble","keySignature":"C","barlines":"manual","notes":[{"keys":["f/4","b/4"],"duration":"h"},{"keys":["e/4","c/5"],"duration":"h","barAfter":true},{"keys":["b/4","f/5"],"duration":"h"},{"keys":["c/5","e/5"],"duration":"h"}]}]]

CORRECT EXAMPLE (user: "построй тритоны в соль миноре" / «две пары тритонов в g-moll»):
В g-moll гармоническом две пары: натуральная (eb–a → d–bb, a–eb → bb–d) и гармоническая с f# (c–f# → bb–g, f#–c → g–bb).
[[NOTATION:{"clef":"treble","keySignature":"Gm","barlines":"manual","notes":[{"keys":["eb/4","a/4"],"duration":"h"},{"keys":["d/4","bb/4"],"duration":"h","barAfter":true},{"keys":["a/4","eb/5"],"duration":"h"},{"keys":["bb/4","d/5"],"duration":"h","barAfter":true},{"keys":["c/4","f#/4"],"duration":"h"},{"keys":["bb/3","g/4"],"duration":"h","barAfter":true},{"keys":["f#/4","c/5"],"duration":"h"},{"keys":["g/4","bb/4"],"duration":"h"}]}]]

CORRECT EXAMPLE (user: "построй НАТУРАЛЬНЫЕ тритоны в соль миноре"):
Только натуральная пара g-moll: ув.4 (eb–a) → м.6 (d–bb), ум.5 (a–eb) → б.3 (bb–d).
[[NOTATION:{"clef":"treble","keySignature":"Gm","barlines":"manual","notes":[{"keys":["eb/4","a/4"],"duration":"h"},{"keys":["d/4","bb/4"],"duration":"h","barAfter":true},{"keys":["a/4","eb/5"],"duration":"h"},{"keys":["bb/4","d/5"],"duration":"h"}]}]]

CORRECT EXAMPLE (user: "построй характерные интервалы в ля миноре"):
В a-moll гарм. четыре характерных интервала с разрешениями: ув.2→ч.4, ум.7→ч.5, ув.5→б.6, ум.4→м.3.
[[NOTATION:{"clef":"treble","keySignature":"Am","barlines":"manual","notes":[{"keys":["f/4","g#/4"],"duration":"h"},{"keys":["e/4","a/4"],"duration":"h","barAfter":true},{"keys":["g#/4","f/5"],"duration":"h"},{"keys":["a/4","e/5"],"duration":"h","barAfter":true},{"keys":["c/4","g#/4"],"duration":"h"},{"keys":["c/4","a/4"],"duration":"h","barAfter":true},{"keys":["g#/4","c/5"],"duration":"h"},{"keys":["a/4","c/5"],"duration":"h"}]}]]

WRONG EXAMPLES (do NOT do this):
- User writes in English but you answer in Russian (or use Russian note names / Cyrillic labels).
- Replying with text only and no [[NOTATION:...]] block.
- Putting the block in the middle of the answer instead of at the end.
- Wrapping the block in \`\`\` or quotes.
- Saying "вот нотный блок" without actually outputting [[NOTATION:...]].
- Тактовые черты в гамме (это ВСЕГДА barlines:"none").
- Один тактовый блок 4/4 для пары «интервал–разрешение» (используй barlines:"manual" + barAfter).
- Подмена буквы при построении интервала (gb вместо f# или наоборот).
- Построить «тритоны» → нарисовать только одну пару (ув.4 ИЛИ ум.5) и остановиться. ВСЕГДА обе пары.
- Построить «характерные интервалы» → нарисовать 1–2 из 4 и остановиться. ВСЕГДА все 4 пары (8 созвучий).
- Построить «обращения трезвучия» → нарисовать только основной вид. ВСЕГДА все 3 (T5/3, T6, T6/4).
- Построить «D7 с разрешениями» → нарисовать только D7 без тоники. ВСЕГДА каждое обращение + разрешение (8 аккордов).
- Подписывать доминантсептаккорд кириллицей «Д7» вместо латинской "D7".

REMEMBER:
- Easy / normal questions → 1–3 short sentences + ONE small notation block. Stop.
- Hard tasks → up to 5–8 sentences (or short numbered steps) + 1 long block (or a few blocks). Still no fluff.
- The very last line is always a valid [[NOTATION:{...}]] block. Never send prose with no notation.
- Гамма / одиночный интервал / одиночный аккорд → barlines:"none", без timeSignature.
- Тритоны и характерные интервалы с разрешениями → barlines:"manual" с "barAfter":true после каждой пары.
- D7 с разрешениями → barlines:"manual" с "barAfter":true после каждой пары D7→T.
- Метрическая музыка (диктант, гармонизация, кадансы) → barlines:"auto" с реальным timeSignature.
- «Тритоны» = ВСЕГДА обе пары (ув.4+разр., ум.5+разр.). «Характерные» = ВСЕГДА все 4 пары. Никогда не урезай комплект до одного примера.`;

/**
 * СБОРНИК ПРАВИЛ ГАРМОНИИ (внутренний справочник для модели).
 * Добавляется к системному промпту в режиме нотации. Охватывает 4-голосие,
 * удвоения (в т.ч. в D7 и его обращениях), голосоведение, каденции, а также
 * американскую/английскую систему обозначений — чтобы модель строила без ошибок
 * и корректно отвечала пользователям из разных традиций.
 *
 * ВАЖНО: язык этого справочника — русский/английский термины ВНУТРИ. В ОТВЕТЕ
 * пользователю всегда используется ЕГО язык (см. LANGUAGE RULE выше). Это только
 * знание «как правильно», а не образец языка ответа.
 */
const HARMONY_RULEBOOK = `

############################################
###  СБОРНИК ПРАВИЛ ГАРМОНИИ (reference)  ###
############################################
Ты знаешь всю классическую теорию и применяешь её ТОЧНО. Всегда сначала ВЫЧИСЛЯЙ, потом выводи ноты. Ниже — свод правил; соблюдай их при любых построениях.

=== 4-ГОЛОСНОЕ ИЗЛОЖЕНИЕ (SATB) — Сопрано / Альт / Тенор / Бас ===
- Диапазоны голосов: Бас C2–C4 (do/2..do/4), Тенор C3–G4, Альт G3–D5, Сопрано C4–G5. Не выходи за них.
- Расстояние между соседними ВЕРХНИМИ голосами (S–A, A–T) не больше октавы. Между Тенором и Басом можно больше октавы.
- Голоса не перекрещиваются (сопрано выше альта, альт выше тенора, тенор выше баса) и не «наезжают» (overlapping).
- В аккорде из 3 тонов (трезвучие) один тон УДВАИВАЕТСЯ (всего 4 голоса). В септаккорде из 4 тонов удвоения обычно нет (все 4 тона по разу).

=== УДВОЕНИЯ В ТРЕЗВУЧИЯХ ===
- Мажорное/минорное трезвучие в основном виде (5/3): удваивай ОСНОВНОЙ ТОН (приму). Это правило по умолчанию.
- Трезвучие с секстой (6): чаще удваивают приму или квинту; НЕ удваивай тон в басу, если это терция аккорда (терцию баса, как правило, не удваивают).
- Квартсекстаккорд (6/4): удваивают КВИНТУ аккорда (= басовый тон).
- Уменьшённое трезвучие (напр. VII, II в миноре): удваивай ТЕРЦИЮ (не приму).
- Увеличенное трезвучие: удваивай приму.
- НИКОГДА не удваивай вводный тон (VII повышенную) и другие тяготеющие/альтерированные ступени (тритоновые тоны, ступени, требующие разрешения).

=== ДОМИНАНТСЕПТАККОРД D7 И ОБРАЩЕНИЯ — УДВОЕНИЯ И РАЗРЕШЕНИЯ ===
Строение D7 на V ступени: прима=V, терция=VII (вводный тон!), квинта=II, септима=IV.
- ПОЛНЫЙ D7 (все 4 тона: прима, терция, квинта, септима) — удвоений НЕТ.
- НЕПОЛНЫЙ D7 (в 4-голосии часто опускают КВИНТУ и удваивают ПРИМУ): тоны = прима, прима, терция, септима.
- РАЗРЕШЕНИЕ D7 → T (тоника):
  • Вводный тон (терция D7, VII#) идёт ВВЕРХ на полутон в приму тоники (I).
  • Септима D7 (IV) идёт ВНИЗ на секунду в терцию тоники (III).
  • Квинта D7 (II), если есть, идёт ВНИЗ в приму тоники (I).
  • Прима D7 (V) в басу идёт в приму тоники (I) (или остаётся как общий тон в верхнем голосе).
- РЕЗУЛЬТАТ:
  • Полный D7 → НЕПОЛНОЕ тоническое трезвучие: удвоенная (даже утроенная) ПРИМА и терция, БЕЗ квинты (I, I, I, III).
  • Неполный D7 → ПОЛНОЕ тоническое трезвучие (I, III, V) с удвоенной примой.
- Обращения и их разрешения: D6/5 → T5/3 (полное), D4/3 → T5/3 или T6, D2 → T6 (тоника с удвоенной примой; септима баса D2 разрешается вниз в терцию тоники, поэтому тоника в T6). Подписи ТОЛЬКО латиницей: D7, D6/5, D4/3, D2.

=== ГОЛОСОВЕДЕНИЕ (обязательные запреты и правила) ===
- ЗАПРЕЩЕНЫ параллельные (и прямые в крайних голосах) ЧИСТЫЕ КВИНТЫ и ЧИСТЫЕ ОКТАВЫ между любыми двумя голосами. Проверяй каждую пару голосов на каждом переходе.
- Избегай «скрытых» (прямых) квинт/октав между крайними голосами (бас+сопрано движутся в одну сторону в ч.5/ч.8).
- Тяготеющие тоны разрешай: вводный тон (VII#) → I вверх; септима любого септаккорда → вниз на секунду; альтерированные ступени → по направлению альтерации.
- Общий тон соседних аккордов ПО ВОЗМОЖНОСТИ оставляй в том же голосе; остальные голоса веди на ближайшие тоны (плавно, без скачков, кроме баса).
- Стремись к противоположному/косвенному движению баса и сопрано.
- Не удваивай тон, который должен разрешаться (иначе получатся параллельные октавы при разрешении).

=== КАДЕНЦИИ / ОБОРОТЫ ===
- Полный автентический (совершенный) каданс: ... D(7) → T, обе в основном виде, прима в сопрано тоники.
- Несовершенный автентический: тоника с терцией/квинтой в сопрано или обращения.
- Плагальный каданс: S → T (IV → I).
- Половинный каданс: остановка на D (... → D).
- Прерванный (обманный) каданс: D7 → VI (в мажоре VI мажорная удваивается терция; ход по правилам голосоведения).
- Кадансовый квартсекстаккорд: K6/4 (= T6/4 на сильной доле) → D(7) → T. Обозначение: американское V6/4 – 5/3 (или K6/4).

=== АМЕРИКАНСКАЯ / АНГЛИЙСКАЯ СИСТЕМА (для англоязычных пользователей) ===
- Названия нот буквами: C D E F G A B (никаких «H»; B = си, Bb = си-бемоль).
- Ступени по-английски: 1 Tonic, 2 Supertonic, 3 Mediant, 4 Subdominant, 5 Dominant, 6 Submediant, 7 Leading tone (в натуральном миноре 7 — Subtonic).
- Полутон/тон: "half step" (semitone) / "whole step" (tone). W-W-H-W-W-W-H = мажор.
- Римский функциональный анализ: I ii iii IV V vi vii° (заглавные=мажорные трезвучия, строчные=минорные, ° = уменьшённое). Септаккорды: V7, ii7, viiø7 (полууменьшённый), vii°7 (уменьшённый).
- Буквенные аккордовые символы (chord symbols): C, Cm, C7, Cmaj7, Cm7, Cdim, C°7, Cm7b5 (=полууменьшённый), Caug, Csus4, слэш-аккорды C/E (аккорд C с басом E).
- Цифрованный бас (figured bass) для обращений: трезвучие 5/3 (обычно опускается), 6 (=6/3, первое обращение), 6/4 (второе обращение); септаккорд 7, 6/5, 4/3, 4/2 (или 2).
- Solfège: подвижное «до» (movable do) — тоника всегда «do»; в миноре бывает la-based minor. Fixed do = C всегда «do».
- Кадансовый K6/4 по-английски пишут как cadential six-four: V6/4–5/3.
- Качества интервалов по-английски: P (perfect), M (major), m (minor), A/aug (augmented), d/dim (diminished): P1 m2 M2 m3 M3 P4 A4/d5 P5 m6 M6 m7 M7 P8.
- Отвечая англоязычному пользователю, используй ИМЕННО эту терминологию (leading tone, dominant seventh, root, third, fifth, seventh, doubling, voice leading, parallel fifths), а не русские кальки.

=== ВСЕ СЕПТАККОРДЫ: СТРОЕНИЕ, ОБРАЩЕНИЯ, УДВОЕНИЯ, РАЗРЕШЕНИЯ ===
Септаккорд = 4 разных тона (прима, терция, квинта, септима). В основном виде удвоений НЕТ.
Типы по строению (от примы: терция+квинта+септима):
- Большой мажорный (maj7, Б.Б.7): б.3+ч.5+б.7 (полутоны 4-7-11). Пример от C: c-e-g-b. На I и IV в мажоре.
- Малый мажорный = доминантсептаккорд (dominant 7, D7): б.3+ч.5+м.7 (4-7-10). На V. Пример: g-b-d-f.
- Малый минорный (m7): м.3+ч.5+м.7 (3-7-10). На II, III, VI в мажоре. Пример от d: d-f-a-c.
- Малый с уменьшённой квинтой = полууменьшённый (m7b5, ø7): м.3+ум.5+м.7 (3-6-10). На VII в мажоре, на II в миноре. Пример: b-d-f-a.
- Уменьшённый (dim7, °7): м.3+ум.5+ум.7 (3-6-9). На VII# в гарм. миноре/мажоре. Пример: g#-b-d-f.
- Большой минорный (mMaj7): м.3+ч.5+б.7 (3-7-11) — редкий, на I в гарм. миноре.
Обращения любого септаккорда и их цифровка:
- Основной вид: 7 (бас = прима).
- 1-е обращение (квинтсекстаккорд): 6/5 (бас = терция).
- 2-е обращение (терцквартаккорд): 4/3 (бас = квинта).
- 3-е обращение (секундаккорд): 2 или 4/2 (бас = септима).
Разрешение септимы: септима ЛЮБОГО септаккорда идёт ВНИЗ на секунду (приготовление желательно). Вводный тон (если есть) — вверх.

=== ВВОДНЫЕ СЕПТАККОРДЫ (VII7) ===
- Малый вводный (полууменьшённый VIIø7) — в натуральном мажоре (VII-II-IV-VI).
- Уменьшённый вводный (VII°7) — в гармоническом мажоре и гарм. миноре (VII#, содержит два тритона).
- Разрешение VII7 → T: строится в неполное тоническое трезвучие с УДВОЕННОЙ ТЕРЦИЕЙ (т.к. и прима-вводный тон идёт в I, и квинта VII7 (=II) идёт в I — образуется удвоение терции тоники, чтобы избежать параллельных квинт). Это стандартный «школьный» результат.
- Уменьшённый VII°7 энгармонически делит октаву на равные м.3 — используется для энгармонической модуляции.

=== УДВОЕНИЯ ПО ВСЕМ ОБРАЩЕНИЯМ (сводка) ===
- Трезвучие 5/3: удвой приму (основной тон).
- Секстаккорд 6: в мажорном/минорном трезвучии удвой приму или квинту, НЕ терцию (терция в басу секстаккорда не удваивается). В уменьшённом секстаккордe удваивай терцию (=бас).
- Квартсекстаккорд 6/4: удвой квинту (=бас).
- Главное: НИКОГДА не удваивай вводный тон (VII#), септиму септаккорда и любые альтерированные/тяготеющие тоны.

=== ПОБОЧНЫЕ ДОМИНАНТЫ И СУБДОМИНАНТЫ (отклонения) ===
- Побочная доминанта = D или D7 к любой ступени, кроме тоники: V/V, V7/V, V/vi, V7/IV и т.д. («доминанта к доминанте», «доминанта к субдоминанте»).
- Строится как настоящий D7 от ноты на квинту выше целевой ступени; альтерация даёт вводный тон к цели.
- Пример в C-dur: V7/V = D7 от D (d-f#-a-c) → разрешается в G (V). V/vi = E (e-g#-b) → a-moll (vi).
- Побочная субдоминанта и двойная доминанта (DD) — аналогично; DD часто в кадансе: DD → K6/4 → D7 → T.

=== АККОРДЫ ОСОБОЙ СТРУКТУРЫ ===
- Неаполитанский секстаккорд (N6, «фригийская II»): мажорное трезвучие на пониженной II ступени, обычно в 1-м обращении (bII6). В C: db-f-ab с басом f. Удвой терцию (=бас). Разрешение: N6 → D(7) (или через K6/4) → T. Bass f→g.
- Аккорды увеличенной сексты (augmented sixth), разрешают ув.6 наружу в октаву V:
  • Итальянский (It+6): bVI + I + #IV (3 тона, удваивают I). C: ab-c-f#.
  • Французский (Fr+6): bVI + I + II + #IV. C: ab-c-d-f#.
  • Немецкий (Gr+6): bVI + I + bIII + #IV (звучит как D7). C: ab-c-eb-f#. Часто → K6/4 во избежание параллельных квинт.
- Все они обычно ведут к доминанте.

=== НЕАККОРДОВЫЕ ЗВУКИ (non-chord tones) ===
- Проходящий (passing tone): между двумя аккордовыми тонами поступенно.
- Вспомогательный (neighbor tone): уход и возврат на тот же тон.
- Задержание (suspension): приготовление → задержание на сильной доле → разрешение вниз (4-3, 7-6, 9-8, в басу 2-3).
- Предъём (anticipation), проходящий/вспомогательный, апподжиатура (appoggiatura — взятый скачком, разрешён поступенно), камбиата, эшаппе (escape tone).
- Педаль (органный пункт): выдержанный бас (обычно T или D), над ним меняются гармонии.

=== СЕКВЕНЦИИ ===
- Секвенция = мотив, повторённый на другой высоте. Тональная (в пределах лада, интервалы меняют качество), реальная/хроматическая (точный перенос со своими знаками), модулирующая.
- Типовые: нисходящая по квинтам (D→G→C…), «золотая секвенция» (цепочка септаккордов по квинтам), восходящая/нисходящая по секундам, по терциям.
- Шаг секвенции (звено) обычно 1 такт или полтакта; сохраняй мелодический рисунок и голосоведение в каждом звене.

=== МОДУЛЯЦИЯ И ОТКЛОНЕНИЕ ===
- Отклонение — кратковременный уход в побочную тональность без закрепления (через побочную доминанту), возврат в основную.
- Модуляция — устойчивый переход в новую тональность с каденцией. Способы: через общий аккорд (пивот, pivot chord — трезвучие, общее для обеих тональностей, переосмысляется в функцию новой), через энгармонизм (VII°7 или D7=Gr+6), внезапная (юкстапозиция).
- Степени родства: 1-я степень = тональности, отличающиеся на один ключевой знак + параллельная/одноимённая. Ближайшие — доминантовая и субдоминантовая + их параллели.

=== ИНТЕРВАЛЫ: ОБРАЩЕНИЕ И ЭНГАРМОНИЗМ ===
- При обращении интервала: ступеневая величина = 9 минус исходная (прима↔октава, секунда↔септима, терция↔секста, кварта↔квинта). Качество меняется: ч↔ч, б↔м, ув↔ум.
- Сумма полутонов интервала и его обращения = 12.
- Энгармонически равные интервалы (ув.4=ум.5 и т.п.) звучат одинаково, но пишутся по-разному и разрешаются по-разному. Всегда сохраняй буквенное написание согласно функции.
- Составные интервалы (шире октавы): нона (9), децима (10), ундецима (11) и т.д. = октава + простой интервал.

=== ПОЛНАЯ ТАБЛИЦА СТУПЕНЕЙ И ФУНКЦИЙ (обе системы) ===
- I — тоника / Tonic (T, I); III и VI — медианты, тоже тонической функции (медианта Mediant iii, субмедианта Submediant vi).
- IV — субдоминанта / Subdominant (S, IV); II — субдоминантовой функции (Supertonic ii).
- V — доминанта / Dominant (D, V); VII — вводный / Leading tone (vii°); в натуральном миноре VII — субтоника (subtonic, bVII).
- Мажор — трезвучия по ступеням: I maj, ii min, iii min, IV maj, V maj, vi min, vii° dim.
- Натуральный минор: i min, ii° dim, bIII maj, iv min, v min, bVI maj, bVII maj. Гармонический минор: V становится мажорным (V7), vii° уменьшённым.

=== ПОЛНЫЙ СПРАВОЧНИК: КАК СТРОИТЬ ЛЮБОЕ ТРЕЗВУЧИЕ И АККОРД ===
Это ГЛАВНЫЙ алгоритм. Любое «построй аккорд X» — только так. Не угадывай по звучанию.

--- А. ЧЕТЫРЕ КАЧЕСТВА ТРЕЗВУЧИЯ (от любой ноты-основы) ---
Строй ТЕРЦИЯМИ ВВЕРХ, сохраняя буквы (c→e→g, не c→eb→g# если нужна б.3+ч.5).
  • Б53 / M (мажорное):   б.3 + ч.5  = 4 + 7 полутонов от основы.  C-dur: c–e–g.
  • М53 / m (минорное):   м.3 + ч.5  = 3 + 7 полутонов.           C-dur: d–f–a.
  • Ув53 / A (увелич.):   б.3 + ув.5 = 4 + 8 полутонов.           C-dur: c–e–g#.
  • Ум53 / d (уменьш.):   м.3 + ум.5 = 3 + 6 полутонов.           C-dur: b–d–f.

Алгоритм «трезвучие от ноты N»:
  1) N = прима (основной тон, bass в 53).
  2) Терция = буква на 2 ступени выше N + нужная альтерация для м/б.3.
  3) Квинта = буква на 2 ступени выше терции + нужная альтерация для ч/ув/ум.5.
  4) Проверка: м.3=3 полутона, б.3=4, ум.5=6, ч.5=7, ув.5=8.

--- Б. ГЛАВНЫЕ ТРЕЗВУЧИЯ ЛАДА (T, S, D) — СТУПЕНИ И КАЧЕСТВО ---
Трезвучие = три СОСЕДНИЕ ступени лада (терциями). Функция = от какой ступени построено.

НАТУРАЛЬНЫЙ МАЖОР (пример C-dur):
  • T53 — на I:  I + III + V   = до–ми–соль   (мажорное).
  • S53 — на IV: IV + VI + I   = фа–ля–до    (мажорное).
  • D53 — на V:  V + VII + II  = соль–си–ре  (мажорное).

НАТУРАЛЬНЫЙ МИНОР (пример a-moll):
  • t53 — на I:  i + iii + v   = ля–до–ми    (минорное).
  • s53 — на iv: iv + VI + i   = ре–фа–ля    (минорное).
  • d53 — на v:  v + VII + ii  = ми–соль–ре  (минорное).

ГАРМОНИЧЕСКИЙ МИНОР (a-moll гарм.):
  • t53 — как натуральный (ля–до–ми).
  • s53 — как натуральный (ре–фа–ля).
  • D53 — на V:  V + VII# + II = ми–соль♯–ре (МАЖОРНОЕ! VII# = соль♯).
  • D7  — на V:  V + VII# + II + IV = ми–соль♯–ре–фа.

ГАРМОНИЧЕСКИЙ МАЖОР (C-dur гарм., bVI):
  • T53 — как натуральный.
  • s53 — на IV: IV + bVI + I = фа–ля♭–до (МИНОРНОЕ! bVI = ля♭).
  • D53 — как натуральный.

ВАЖНО: строчные t/s/d = минорные функции в миноре; заглавные T/S/D = в мажоре.

--- В. ОБРАЩЕНИЯ ТРЕЗВУЧИЙ (53, 6, 64) — КТО В БАСУ ---
Цифра = интервалы от НИЖНЕГО (бass) звука вверх.
  • 53 (основной вид): бас = ПРИМА (основной тон).  T53: бас I.
  • 6  (секстаккорд):  бас = ТЕРЦИЯ.              T6:  бас III.
  • 64 (квартсекст.):  бас = КВИНТА.              T64: бас V.

Пример T в C-dur:
  • T53: c–e–g  (бас c = I)
  • T6:  e–g–c  (бас e = III)
  • T64: g–c–e  (бас g = V)

Пример S в C-dur (S = фа–ля–до):
  • S53: f–a–c
  • S6:  a–c–f  (бас a = VI)
  • S64: c–f–a  (бас c = I) — строится на I ступени, но это S!

Пример D в C-dur (D = соль–си–ре):
  • D53: g–b–d
  • D6:  b–d–g  (бас b = VII)
  • D64: d–g–b  (бас d = II)

K64 (кадансовый квартсекстаккорд) = T64 НА V СТУПЕНИ перед D7:
  • В C-dur: g–c–e (бас g = V, но аккорд — тоническое трезвучие do-mi-sol).

ЧАСТЫЕ ОШИБКИ (ЗАПРЕЩЕНО):
  ✗ D65 — это НЕ D7! D65 = 1-е обращение D7, бас = ТЕРЦИЯ D7 (= VII ступень).
  ✗ S6 — это НЕ ii6! S6 = секстаккорд СУБДОМИНАНТЫ (бас VI), не II ступени.
  ✗ Путать побочное трезвучие (II, III, VI, VII) с главным S или D.

--- Г. ДОМИНАНТСЕПТАККОРД D7 И ОБРАЩЕНИЯ (латиница D!) ---
D7 на V ступени = V + VII# + II + IV (в мажоре и гарм. миноре).
  C-dur: g–b–d–f  (соль–си–ре–фа). Полутоны от g: 4-7-10.

Обращения D7 (бас = какой тон D7):
  • D7  (7):   бас = V  (прима).     C-dur: g–b–d–f
  • D65 (6/5): бас = VII (терция).    C-dur: b–d–f–g  ← НЕ g–b–d–f!
  • D43 (4/3): бас = II (квинта).     C-dur: d–f–g–b
  • D2  (2):   бас = IV (септима).    C-dur: f–g–b–d

D65 строится на VII СТУПЕНИ (первая инверсия D7). В E-dur: d#–f#–a–b (ре♯–фа♯–ля–си).

Разрешения (школьные, 3-note close position для демо):
  • D7  → T53 (неполная тоника: удвоенная I + III)
  • D65 → T53 (полная тоника, удвоенная I)
  • D43 → T53 (полная, удвоенная I в октаву)
  • D2  → T6  (удвоенная I)

--- Д. ВВОДНЫЕ СЕПТАККОРДЫ VII7 ---
  • МVII7 (малый, полууменьш. ø7): VII–II–IV–VI.  C-dur: b–d–f–a (м3+ум3+м3).
  • УмVII7 (уменьш., °7): VII#–II–IV–VI(b).       C-dur гарм.: b–d–f–ab.

Разрешение VII7 → T53: через D65 (3 общих звука, верхняя септима → вниз на секунду в V) или напрямую в неполную T с удвоенной терцией.

--- Е. ПОБОЧНЫЕ ТРЕЗВУЧИЯ (на II, III, VI, VII) ---
Мажор C-dur:
  • II (d-f-a) = ii минорное = субдоминантовая функция
  • III (e-g#-b) = iii минорное
  • VI (a-c-e) = vi минорное = тоническая функция
  • VII (b-d-f) = vii° уменьшённое

Ум53: м.3+ум.5 (3+6 пол.). Ув53: только в гарм. ладу (б.3+ув.5 на bVI или III).

--- Ж. ЦЕПОЧКИ АККОРДОВ (школьные схемы) ---
Цепочка 1 (мажор): T53 – S64 – VII7 – D65 – T53 – S6 – K64 – D7 – T53
  (S64 и VII7 — гармонические: s53 с bVI; уменьш. VII7).
  E-dur: e-g#-b | e-a-c | d#-f#-a-c | d#-f#-a-b | e-g#-b | c#-e-a | b-e-g# | b-d#-f#-a | e-g#-b

Цепочка 2 (минор): t53 – d6 – s6 – D53 – D2 – t6 – II7 – D43 – t53 – s64 – t53

При построении цепочки: каждый label ОБЯЗАН совпадать с реальными нотами. Проверяй каждый аккорд отдельно по разделам Б–Г.

--- З. САМОПРОВЕРКА ПЕРЕД ВЫВОДОМ (обязательна для КАЖДОГО аккорда) ---
1) Запиши ступени: какие I/II/III/IV/V/VI/VII входят в аккорд?
2) Проверь качество каждой терции/квинты (полутоны).
3) Сверь бас с цифровкой (53→прима, 6→терция, 64→квинта, D65→терция D7).
4) Для функциональной подписи (T/S/D): это действительно трезвучие ЭТОЙ ступени?
5) Label в JSON = точная функция; ноты = точное строение. Несовпадение label и нот = КРИТИЧЕСКАЯ ОШИБКА.

--- И. ЧТО СТРОИТ ДВИЖОК theory.js (не переписывай!) ---
Система автоматически подставляет правильные ноты для: тритонов, характерных интервалов, гамм (все формы), D7+обращения+разрешения, цепочки 1, трезвучия T с обращениями, «все виды трезвучий от ноты». Если запрос распознан — используй готовый блок, не выдумывай свои ноты.

=== БОЛЬШИЕ ЗАДАЧИ (важно!) ===
- Ты МОЖЕШЬ и ДОЛЖЕН выполнять большие задания целиком: цепочки на 15+ аккордов, гармонизации мелодии/баса, длинные секвенции, модуляции. НЕ сокращай количество аккордов, если пользователь просит длинную цепочку — выводи столько, сколько попросили.
- Один [[NOTATION:...]] блок может содержать много аккордов — рендерер сам переносит на несколько строк. Не дроби цепочку на куски искусственно.
- Приоритет: полностью закрытый валидный JSON важнее прозы. Текст — 1–2 предложения, вся «мясистость» — в нотах.
- Каждый аккорд подписывай функцией (T, S, D, D7, K6/4 / для англоязычных — I, IV, V, V7, cad.6/4) над нотой в поле "label".

=== ЗОЛОТОЕ ПРАВИЛО ТОЧНОСТИ ===
- Перед выводом КАЖДОГО аккорда/интервала мысленно проверь: (1) буквенный скелет, (2) число полутонов, (3) удвоение по правилам выше, (4) разрешение тяготеющих тонов, (5) отсутствие параллельных квинт/октав. Если что-то не сходится — перестрой ДО вывода. Лучше правильно, чем быстро.`;

function getSystemInstruction(responseLang) {
    const lang = responseLang || detectResponseLanguage('', []);
    let prompt = SYSTEM_PROMPT + getLanguageInstruction(lang);
    if (currentAiMode === 'berserk' && !notationModeEnabled) {
        prompt += lang === 'ru'
            ? `\n\nStyle: Be максимально прямолинейным и резким по тону, но без мата, унижений и личных оскорблений. Коротко, по делу, с сарказмом допускается, но всегда давай корректный и полезный ответ.`
            : `\n\nStyle: Be blunt and direct, but no slurs or personal insults. Short, useful answers; light sarcasm is fine.`;
    }
    if (notationModeEnabled) {
        prompt += NOTATION_PROMPT_INSTRUCTION;
        prompt += HARMONY_RULEBOOK;
    }
    return prompt;
}

/** Убирает служебный постфикс режима нотации из текста user-сообщения. */
function stripNotationReminder(text) {
    return String(text || '').replace(/\n\n\[NOTATION MODE[\s\S]*$/, '').trim();
}

/** Подставляет готовый нотный блок из theory.js (solfeggio-online.ru), если запрос распознан. */
function patchAiWithTheory(userQuery, aiText) {
    if (!window.SolfTheory || typeof window.SolfTheory.buildNotationForQuery !== 'function') return aiText;
    const q = stripNotationReminder(userQuery);
    if (!q) return aiText;
    try {
        const det = window.SolfTheory.buildNotationForQuery(q);
        if (det && det.blockString && typeof window.SolfTheory.applyBlock === 'function') {
            const isMultiScale = /гамм|scale/i.test(q) && /(?:во?\s+)?(?:все|всех)|(?:три|3)\s*(?:вид|форм)|all\s*(?:types?|forms?)|построй.*гамм|build.*scale/i.test(q);
            const isChain = /цепочк|chain/i.test(q) && !/цепочк\w*\s*2\b|chain\s*2|2[\s-]*(?:ю|я|й|nd)\s*цепоч|втор\w*\s*цепоч/i.test(q);
            let intro = null;
            if (isMultiScale) {
                intro = (window.__solfaiResponseLang === 'ru' || /[а-яё]/i.test(q)
                    ? 'Ниже — натуральная, гармоническая и мелодическая формы (вверх и вниз):'
                    : 'Natural, harmonic, and melodic forms (ascending and descending):');
            } else if (isChain) {
                intro = (window.__solfaiResponseLang === 'ru' || /[а-яё]/i.test(q)
                    ? 'Цепочка 1 в заданной тональности:'
                    : 'Chain 1 in the requested key:');
            }
            const base = intro ? intro : aiText;
            return window.SolfTheory.applyBlock(base, det.blockString);
        }
    } catch (err) {
        console.warn('[Solf.ai] Theory patch skipped:', err);
    }
    return aiText;
}

function buildNotationUserReminder(responseLang) {
    const langName = { en: 'English', ru: 'Russian', de: 'German', es: 'Spanish', zh: 'Chinese', ja: 'Japanese' }[responseLang] || 'the user\'s language';
    return '\n\n[NOTATION MODE — silent reminder, never quote this text]\n' +
        `LANGUAGE: reply in ${langName} only — match the user, NOT the Russian theory examples in the system prompt.\n` +
        'KEEP TEXT VERY SHORT: 1–2 sentences (≤30 words) for normal questions, up to 4–6 short sentences only for genuinely hard tasks (harmonization, voice leading, modulation, dictation, counterpoint). No headings, no recap, no fluff. ' +
        'End the message with a valid [[NOTATION:{...}]] block as the FINAL line. Default = ONE small block (1–2 measures). Use multiple blocks only for hard tasks. Never wrap blocks in code fences. ' +
        'JSON PRIORITY: a complete closed JSON block matters more than long prose — shorten TEXT, never truncate JSON. Block must end with ]}]]. ' +
        'TASK COMPLIANCE: do EXACTLY what the user asked in THIS message — full set, every part. Ignore earlier chat mistakes. Dominant labels: D7, D6/5, D4/3, D2 (Latin only). ' +
        'EXERCISE COMPLETENESS: "tritones in key X" (without "natural") = HARMONIC form = 2 pairs = 8 sonorities, barAfter after each resolved pair. "Natural tritones" = 1 pair = 4 sonorities. "Both pairs" / "two pairs" = ALWAYS 8 sonorities. "Characteristic intervals" = ALL 4 pairs (8 sonorities). "Inversions" / "all types" = full set, not one example. "D7 + inversions + resolutions" = 8 chords (4 D7 forms + 4 tonic resolutions). Melodic scale = ascending AND descending when requested. Scales and single chords — barlines:"none" without timeSignature. ' +
        'TRITONE RESOLUTIONS: aug4 → SIXTH (m6/M6, 8–9 semitones), dim5 → THIRD (m3/M3, 3–4 semitones). NEVER resolve a tritone to a fourth or fifth.';
}

/** Жёсткий повторный промпт, если первый ответ всё-таки пришёл без блока. */
const NOTATION_RETRY_PROMPT =
    'NOTATION MODE: your last answer was INVALID — no [[NOTATION:{...}]] line. Rewrite: same meaning and the USER\'S language, SHORT (2–5 sentences), and end with exactly ONE valid [[NOTATION:{"clef":"...","keySignature":"...","timeSignature":"...","notes":[...]}]] block. Nothing after the block. No markdown.';

/** Второй ретрай — ещё короче инструкция, максимально прямой императив. */
const NOTATION_RETRY_PROMPT_2 =
    'STILL WRONG: no [[NOTATION:...]] line. Output format: (1) 1–3 short sentences in the user’s language, (2) newline, (3) single line [[NOTATION:{valid JSON as in system rules}]]. Nothing else. No preamble about rules.';

/**
 * Третий ретрай — для случая «JSON обрезался». Просим ТОЛЬКО блок без какой-либо прозы:
 * это гарантированно влезает в любой токен-лимит и закрывается на `]}]]`.
 */
const NOTATION_RETRY_PROMPT_3 =
    'Your JSON block was TRUNCATED (missing closing ]}]]). Output EXACTLY one complete valid [[NOTATION:{...}]] block and NOTHING else — no words before or after, no markdown. Close with ]}]] on the same line.';

function hasNotationBlock(text) {
    return /\[\[NOTATION:\s*\{[\s\S]*?\}\s*\]\]/.test(String(text || ''));
}

/**
 * Сценарий «модель начала блок [[NOTATION:..., но не успела дописать `]}]]`».
 * Так бывает при коротком max_tokens на стороне Gemini/воркера, особенно для
 * длинных упражнений (характерные интервалы, обе пары тритонов, обращения).
 * Возвращает true только если ОТКРЫЛСЯ блок, а валидного целого блока нет.
 */
function hasTruncatedNotationStart(text) {
    const s = String(text || '');
    if (hasNotationBlock(s)) return false;
    return /\[\[NOTATION:/.test(s);
}

/** Срезает «оборванный» хвост `[[NOTATION:...` (если он действительно обрезан, а не валиден). */
function stripTruncatedNotationTail(text) {
    const s = String(text || '');
    if (hasNotationBlock(s)) return s;
    return s.replace(/\[\[NOTATION:[\s\S]*$/, '').trimEnd();
}

/**
 * Распознаёт «большие» задачи, которым нужен увеличенный бюджет токенов (до 8192),
 * иначе длинный нотный блок обрежется на середине. Это цепочки аккордов, гармонизации,
 * диктанты, модуляции, секвенции, 4-голосие, а также любые просьбы с явным большим
 * числом тактов/аккордов/строк («15 аккордов», «на 8 тактов», «длинную цепочку»).
 */
/** Запрос на построение (интервалы, гаммы, аккорды, цепочки…) — для «прочистки памяти» в истории чата. */
function isBuildTask(query) {
    const t = String(query || '').toLowerCase().replace(/ё/g, 'е');
    if (!t) return false;
    const buildVerb = /построй|постро|построи|сделай|напиши|выведи|нарисуй|покажи|build|draw|show|write|construct|make\b|create\b|harmoniz/i;
    const buildNoun = /тритон|характерн\w*\s*интервал|гамм|звукоряд|трезвуч|аккорд|интервал|цепочк|cadence|scale|triad|chord|interval|tritone|inversion|resolution|dominant|sept/i;
    if (buildVerb.test(t) && buildNoun.test(t)) return true;
    if (/\bd\s*7\b|dominant\s*7|доминант\w*\s*септ|д\s*7\b/i.test(t) && buildVerb.test(t)) return true;
    if (/^d7\b|^\s*d7[\s,]/i.test(t.trim())) return true;
    return false;
}

/** Для build-задач: краткий императив «сброса памяти» — модель не должна копировать старые ошибки. */
function buildFreshTaskReminder(query, lang) {
    const q = String(query || '').trim();
    const ru = lang === 'ru';
    const parts = [];
    if (/обращени|inversion/i.test(q) && /разрешени|resolution|resolv/i.test(q)) {
        parts.push(ru
            ? 'ОБЯЗАТЕЛЬНО: все обращения И все разрешения (полный комплект пар D7→T).'
            : 'MANDATORY: ALL inversions AND ALL resolutions (full D7→T pairs).');
    } else if (/обращени|inversion/i.test(q)) {
        parts.push(ru ? 'ОБЯЗАТЕЛЬНО: все обращения, не только основной вид.' : 'MANDATORY: ALL inversions, not root position only.');
    } else if (/разрешени|resolution|resolv/i.test(q)) {
        parts.push(ru ? 'ОБЯЗАТЕЛЬНО: каждое созвучие с разрешением.' : 'MANDATORY: every sonority with its resolution.');
    }
    if (/мелодическ|melodic/i.test(q) && /вверх|вниз|up|down|both\s*way|ascending|descending/i.test(q)) {
        parts.push(ru
            ? 'ОБЯЗАТЕЛЬНО: мелодическая гамма — и вверх, и вниз в одном блоке (15 нот).'
            : 'MANDATORY: melodic scale — ascending AND descending in one block (15 notes).');
    }
    if (/все|all\b|обе\s*пары|both\s*pairs|две\s*пары|two\s*pairs/i.test(q) && /тритон|tritone/i.test(q)) {
        parts.push(ru ? 'ОБЯЗАТЕЛЬНО: обе пары тритонов с разрешениями (8 созвучий).' : 'MANDATORY: BOTH tritone pairs with resolutions (8 sonorities).');
    }
    if (/характерн|characteristic/i.test(q)) {
        parts.push(ru ? 'ОБЯЗАТЕЛЬНО: все 4 характерных интервала с разрешениями (8 созвучий).' : 'MANDATORY: ALL 4 characteristic intervals with resolutions (8 sonorities).');
    }
    const header = ru
        ? '[СВЕЖЕЕ ЗАДАНИЕ — игнорируй предыдущие ответы в чате; выполни ТОЛЬКО текущий запрос по правилам системы]'
        : '[FRESH TASK — ignore earlier chat replies; follow system rules for THIS request only]';
    return parts.length ? `\n\n${header}\n${parts.join('\n')}` : `\n\n${header}`;
}

function isBigNotationTask(query) {
    const t = String(query || '').toLowerCase();
    if (!t) return false;

    // Явные ключевые слова «больших» заданий.
    const bigKeywords = /цепочк|прогресс|последовательн|гармониз|гармонизаци|голосоведени|четырёхголос|четырехголос|4-?голос|4\s*голос|s\.?a\.?t\.?b|сопрано.*альт|диктант|модуляц|секвенц|период|каданс|кадансов|оборот|развит|соедин(и|е)ни|harmoniz|harmoni[sz]e|progression|chord\s*chain|voice[- ]?leading|four[- ]?part|four\s*voices|satb|dictation|modulat|sequence|cadence|counterpoint|контрапункт/;
    if (bigKeywords.test(t)) return true;

    // Явно указано большое количество (аккордов/тактов/строк/ступеней и т.п.).
    const numMatch = t.match(/(\d{1,3})\s*(аккорд|такт|строч|строк|ступен|созвуч|нот[аы]?|chords?|bars?|measures?|lines?|notes?)/);
    if (numMatch && parseInt(numMatch[1], 10) >= 6) return true;

    // «Длинная / большая» цепочка/пример без числа.
    if (/(длинн|больш|развёрнут|развернут|подробн|long|large|full)\w*\s+(цепочк|пример|прогресс|гармониз|задани|progression|example|harmoniz)/.test(t)) return true;

    return false;
}
const PLAN_ICONS = {
    free: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
    basic: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>',
    pro: '<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14H11L10 22L20 10H12L13 2Z"/></svg>',
    unlimited: '<svg class="svg-icon" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>'
};

let currentPlan = { type: "free", emoji: PLAN_ICONS.free, name: "Free" };

function isRequestsExhausted() {
    const limit = PLAN_LIMITS[currentPlan?.type || 'free']?.requests;
    return limit !== Infinity && getRemainingRequests() <= 0;
}

let __lastNoRequestsToastAt = 0;
function showNoRequestsToast() {
    const now = Date.now();
    if (now - __lastNoRequestsToastAt < 700) return;
    __lastNoRequestsToastAt = now;
    showToast(uiText('noRequests', { fallback: 'You have 0 requests' }), 'error', { dedupeKey: 'no-requests', dismissOnClick: true });
}

function refreshSendButtonState() {
    if (!chatSendBtn || isGenerating) return;
    const hasContent = (chatInput?.value?.trim?.() || '') !== '' || attachedFiles.length > 0;
    const exhausted = isRequestsExhausted();
    chatSendBtn.classList.toggle('is-locked', exhausted);
    if (exhausted) {
        // Keep button clickable so user sees a small message instead of modal.
        chatSendBtn.disabled = false;
        return;
    }
    chatSendBtn.disabled = !hasContent;
}

function closeAllOverlays(exceptElement = null) {
    const sidebarEl = document.getElementById('sidebar');
    const exceptInSidebar = exceptElement && sidebarEl && sidebarEl.contains(exceptElement);
    if (!exceptInSidebar) {
        resetSidebarExpandedMenus();
    }

    if (modeDropdown && (!exceptElement || !exceptElement.closest?.('.mode-selector-island'))) {
        modeDropdown.classList.add('hidden');
    }

    const dropdownSelectors = ['.lang-submenu', '.lang-dropdown', '.profile-dropdown'];
    dropdownSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(dropdown => {
            const triggerButton = dropdown.previousElementSibling || dropdown.parentElement?.querySelector('button');
            if (dropdown.contains(exceptElement) || triggerButton?.contains(exceptElement)) return;
            dropdown.classList.remove('active');
            dropdown.classList.remove('open');
        });
    });

    if (isMobileLayout() && sidebar && !sidebar.classList.contains('collapsed')) {
        const el = exceptElement;
        const isClickInDropdown = el && dropdownSelectors.some(sel => el.closest(sel));
        const insideSidebar = el && (sidebar.contains(el) || el.closest('#sidebar'));
        const onToggle =
            el &&
            toggleSidebarBtn &&
            (toggleSidebarBtn === el || toggleSidebarBtn.contains(el));
        if (!insideSidebar && !onToggle && !isClickInDropdown) {
            sidebar.classList.add('collapsed');
            syncMobileSidebarDrawerState();
        }
    }
}

/** Закрытие выпадашек + сворачивание моб. drawer при тапе вне сайдбара (click и pointerdown на телефонах) */
function handleOutsideTapDismiss(el) {
    const wasSidebarOpen = isMobileLayout() && sidebar && !sidebar.classList.contains('collapsed');
    closeAllOverlays(el);

    if (isMobileLayout() && wasSidebarOpen && sidebar.classList.contains('collapsed')) {
        resetSidebarExpandedMenus();
        return;
    }

    if (isMobileLayout() && sidebar && !sidebar.classList.contains('collapsed')) {
        const insideSidebar = el && (sidebar.contains(el) || el.closest('#sidebar'));
        const onToggle =
            el &&
            toggleSidebarBtn &&
            (toggleSidebarBtn === el || toggleSidebarBtn.contains(el));
        if (!insideSidebar && !onToggle) {
            sidebar.classList.add('collapsed');
            syncMobileSidebarDrawerState();
            resetSidebarExpandedMenus();
        }
    }
}

window.navigateToLogin = function () {
    window.location.href = 'login.html';
};

// ===== УПРАВЛЕНИЕ ЧАТАМИ И ГРУППИРОВКА =====
const TOP_VISIBLE_CHATS = 3;
const OLDER_VISIBLE_CHATS = 5;
const MAX_SAVED_CHATS = TOP_VISIBLE_CHATS + OLDER_VISIBLE_CHATS;

function getChatsStorageKey() { return `solfai_chats_${currentUser ? currentUser.id : 'guest'}`; }

function sortChatsCanonical(arr) {
    arr.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    return arr;
}

/**
 * Trim local chats to the most recent MAX_SAVED_CHATS, and request server-side
 * deletion of the rest, so the database doesn't grow indefinitely.
 * Returns true if anything was trimmed.
 */
function enforceChatLimit() {
    sortChatsCanonical(chats);
    if (chats.length <= MAX_SAVED_CHATS) return false;

    const removed = chats.slice(MAX_SAVED_CHATS);
    chats = chats.slice(0, MAX_SAVED_CHATS);

    if (currentUser && currentUser.id) {
        removed.forEach(chat => {
            if (!chat || !chat.id) return;
            apiFetch(`${WORKER_URL}/delete-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: chat.id, user_id: currentUser.id })
            }).catch(err => console.warn('[Solf.ai] Failed to delete trimmed chat:', err));
        });
    }
    return true;
}

function renderChatItemHTML(chat) {
    const isActive = (typeof currentChatId !== 'undefined' && currentChatId === chat.id) ? 'active' : '';
    let title = chat.title || 'New Chat';
    const isPinned = chat.pinned ? 'is-pinned' : '';
    const pinFill = chat.pinned ? 'currentColor' : 'none';

    return `
    <div class="chat-item ${isActive}" data-id="${chat.id}">
        <div class="chat-title-wrapper">${title}</div>
        <div class="chat-actions" style="${chat.pinned ? 'display: flex;' : ''}">
            <button class="chat-action-btn pin ${isPinned}" onclick="togglePinChat('${chat.id}', event)" title="Pin">
                <svg class="svg-icon" style="width: 14px; height: 14px; fill: ${pinFill};" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
            </button>
            <button class="chat-action-btn delete" onclick="deleteChatFromSidebar('${chat.id}', event)" title="Delete">
                <svg class="svg-icon" style="width: 14px; height: 14px;" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        </div>
        ${isActive && !chat.pinned ? '<div class="active-indicator"></div>' : ''}
    </div>`;
}

window.togglePinChat = function(id, e) {
    e.stopPropagation();
    const chat = chats.find(c => c.id === id);
    if(chat) { chat.pinned = !chat.pinned; saveChatToStorage(); renderChatsList(); }
};

window.deleteChatFromSidebar = function(id, e) {
    e.stopPropagation();
    if (confirm(uiText('deleteChatConfirm', { fallback: 'Are you sure you want to delete this chat?' }))) {
        chats = chats.filter(c => c.id !== id);
        saveChatToStorage();
        
        // НОВОЕ: Отправляем запрос на удаление из БД
        if (currentUser) {
            apiFetch(`${WORKER_URL}/delete-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, user_id: currentUser.id })
            }).catch(err => console.error('Failed to delete chat:', err));
        }

        if(currentChatId === id) startNewChat();
        else renderChatsList();
    }
};

window.toggleChatGroup = function(event) {
    if (event) event.stopPropagation(); // Остановка всплытия события, чтобы не закрывался сайдбар
    const isOpening = localStorage.getItem('solfai_group_open') !== 'true';
    localStorage.setItem('solfai_group_open', isOpening);
    renderChatsList();
};

function renderChatsList() {
    if (!chatsList) return;
    sortChatsCanonical(chats);

    const shouldGroup = chats.length > TOP_VISIBLE_CHATS;
    const groupOpen = localStorage.getItem('solfai_group_open') === 'true';
    let html = '';
    
    if (!shouldGroup) {
        html = chats.slice(0, MAX_SAVED_CHATS).map(chat => renderChatItemHTML(chat)).join('');
    } else {
        const recentChats = chats.slice(0, TOP_VISIBLE_CHATS);
        const olderChats = chats.slice(TOP_VISIBLE_CHATS, TOP_VISIBLE_CHATS + OLDER_VISIBLE_CHATS);
        html += recentChats.map(chat => renderChatItemHTML(chat)).join('');
        
        const olderLabel = (typeof solfaiGetText === 'function' ? solfaiGetText('olderChatsGroup') : '').replace(/\{n\}/g, String(olderChats.length)) || `Older chats (${olderChats.length})`;
        html += `
        <div class="chats-group-header ${groupOpen ? 'open' : ''}" onclick="toggleChatGroup(event)">
            <span class="chats-group-header-label">
                <svg class="svg-icon chats-group-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                <span>${olderLabel}</span>
            </span>
            <svg class="svg-icon group-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>`;
        
        const limitNotice = (typeof solfaiGetText === 'function' ? solfaiGetText('chatLimitNotice') : '') || `Only the last ${MAX_SAVED_CHATS} chats are saved.`;
        html += `
        <div class="chats-group-list" style="display: grid; grid-template-rows: ${groupOpen ? '1fr' : '0fr'}; transition: grid-template-rows 0.3s;">
            <div style="overflow: hidden;">
                ${olderChats.map(chat => renderChatItemHTML(chat)).join('')}
                <div class="chat-limit-notice">${limitNotice}</div>
            </div>
        </div>`;
    }

    chatsList.innerHTML = html;
    chatsList.querySelectorAll('.chat-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            loadChat(item.dataset.id);
            closeAllOverlays();
        });
    });
}

// ===== ТЕМА =====
function toggleTheme() { setTheme(currentTheme === 'default' ? 'light' : 'default'); }

function setTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('solfai_theme', theme);
    document.documentElement.setAttribute('data-theme', theme === 'default' ? '' : theme);
    
    const sunIcon = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
    const moonIcon = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
   
    document.querySelectorAll('#themeIconSvg, #headerThemeIconSvg, #mobileThemeIconSvg').forEach(el => {
    if (el) el.innerHTML = theme === 'light' ? sunIcon : moonIcon;
});
    document.querySelectorAll('#themeIconSvg, #headerThemeIconSvg').forEach(el => {
        if (el) el.innerHTML = theme === 'light' ? sunIcon : moonIcon;
    });
}
function initTheme() { setTheme(currentTheme); }

function setColor(color) {
    currentColor = color;
    localStorage.setItem('solfai_color', color);

    if (color === 'default') {
        document.documentElement.removeAttribute('data-color');
    } else {
        document.documentElement.setAttribute('data-color', color);
    }

    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.color === color);
    });
}

function initColor() {
    setColor(currentColor);
}

function setFontSize(size) {
    currentFontSize = size || 'md';
    localStorage.setItem('solfai_font_size', currentFontSize);
    document.documentElement.setAttribute('data-font-size', currentFontSize);
}

function initFontSize() {
    setFontSize(currentFontSize);
}

// ===== ТАРИФЫ И КНОПКА UPGRADE =====
function getPlanStorageKey() { return `solfai_plan_${currentUser ? currentUser.id : 'guest'}`; }
function getStoredPlan() { return JSON.parse(localStorage.getItem(getPlanStorageKey())) || { type: "free", emoji: PLAN_ICONS.free, name: "Free" }; }

function updatePlanDisplay() {
    if (isUserLoggedIn() && currentUser?.plan_type && PLAN_LIMITS[currentUser.plan_type]) {
        const planType = currentUser.plan_type;
        currentPlan = {
            type: planType,
            emoji: PLAN_ICONS[planType] || PLAN_ICONS.free,
            name: planType.charAt(0).toUpperCase() + planType.slice(1),
        };
    } else {
        currentPlan = getStoredPlan();
    }
    document.documentElement.classList.toggle('show-upgrade',
        !!currentUser && currentPlan.type !== 'pro' && currentPlan.type !== 'unlimited');
    const sidebarPlanIcon = document.getElementById('sidebarPlanIcon');
    if (sidebarPlanIcon) { sidebarPlanIcon.innerHTML = currentPlan.emoji || PLAN_ICONS.free; }
    updateRequestsCounter();
    refreshImageAttachVisibility();
}

function refreshImageAttachVisibility() {
    document.documentElement.classList.toggle('has-image-quota', getRemainingImages() > 0);
    // Картинки тоже отражаются на бейдже "X/Y" в шапке сайдбара — синхронизируем.
    if (typeof updateSidebarQuotaBadge === 'function') updateSidebarQuotaBadge();
}

// === Лимиты запросов: источники истины ===
//
// ЗАЛОГИНЕННЫЙ ЮЗЕР (есть currentUser.id):
//   Источник истины — БД (Cloudflare Workers).
//   - При логине  : `/get-user` через syncAppData() → currentUser.requests_count
//   - При запросе : `/increment-usage` → возвращает актуальное → currentUser.requests_count
//   localStorage для них НЕ используется: даже если юзер очистит кеш, лимит из БД остаётся.
//
// ГОСТЬ (не залогинен):
//   Источник истины — localStorage `solfai_usage_guest`.
//   У гостей нет аккаунта, БД не знает кто это, так что хранить негде.
//   Юзер может сбросить кеш и получить ещё 3 запроса — это by design для незалогиненных.
function isUserLoggedIn() { return Boolean(currentUser?.id); }

function getUsageKey() { return `solfai_usage_${currentUser?.id || 'guest'}`; }
function getUsageData() {
    const data = JSON.parse(localStorage.getItem(getUsageKey()) || '{}');
    if (!data.timestamp || (Date.now() - data.timestamp) > USAGE_WINDOWS.request) return { timestamp: Date.now(), count: 0 };
    return data;
}
function saveUsageData(data) { localStorage.setItem(getUsageKey(), JSON.stringify(data)); }

function getRemainingRequests() { 
    const limit = PLAN_LIMITS[currentPlan?.type || 'free'].requests;
    if (limit === Infinity) return 9999;

    if (isUserLoggedIn()) {
        // Только БД — никакого localStorage. Если syncAppData ещё не отработал
        // (currentUser.requests_count = undefined) — считаем 0 потраченных, после первого
        // sync значение перезапишется. Это безопасно: бэк всё равно проверит лимит сам.
        const dbUsage = Number(currentUser?.requests_count);
        return Math.max(0, limit - (Number.isFinite(dbUsage) ? dbUsage : 0));
    }

    return Math.max(0, limit - getUsageData().count);
}
function useRequest() {
    const limit = PLAN_LIMITS[currentPlan?.type || 'free'].requests;
    if (limit === Infinity) return true;

    if (isUserLoggedIn()) {
        // Оптимистичный инкремент в memory: UI сразу показывает "запросов на 1 меньше",
        // не дожидаясь ответа /increment-usage. БД — источник истины:
        //  - если /increment-usage придёт OK, currentUser.requests_count перезапишется им
        //    (см. блок около ~1803);
        //  - если упадёт сеть, останется наш +1 — пользователь не сможет сделать сверх лимита,
        //    а при следующем syncAppData значение поправится из БД.
        const cur = Number(currentUser.requests_count) || 0;
        if (cur >= limit) return false;
        currentUser.requests_count = cur + 1;
        updateRequestsCounter();
        return true;
    }

    const usage = getUsageData();
    if (usage.count < limit) { usage.count++; if(!usage.timestamp) usage.timestamp=Date.now(); saveUsageData(usage); updateRequestsCounter(); return true; }
    return false;
}
function updateRequestsCounter() {
    const remaining = getRemainingRequests();
    const limit = PLAN_LIMITS[currentPlan?.type || 'free'].requests;
    // Компактный бейдж в шапке сайдбара: "молния X/Y" (запросы / картинки).
    // Логика: ∞-тариф — показываем ∞; тариф без картинок — только число запросов;
    // иначе — "X/Y". Окрашиваем в warning/exhausted по тем же правилам, что и старый счётчик.
    updateSidebarQuotaBadge();
    refreshSendButtonState();
}

function updateSidebarQuotaBadge() {
    const badge = document.getElementById('sidebarQuotaBadge');
    const textEl = document.getElementById('sidebarQuotaText');
    if (!badge || !textEl) return;

    // Защита от клика ДО первичной инициализации (в HTML href зашит статически): если гость
    // успеет нажать молнию раньше, чем отработает логика ниже — блокируем переход на pricing.
    if (!badge.dataset.guardBound) {
        badge.dataset.guardBound = '1';
        badge.addEventListener('click', e => {
            if (!isUserLoggedIn()) {
                e.preventDefault();
                // Вместо перехода на pricing предлагаем сначала войти.
                try { navigateToLogin?.(); } catch (_) {}
            }
        });
    }
    const planType = currentPlan?.type || 'free';
    const reqLimit = PLAN_LIMITS[planType].requests;
    const imgLimit = PLAN_LIMITS[planType].images;
    const reqRemain = getRemainingRequests();
    const imgRemain = (typeof getRemainingImages === 'function') ? getRemainingImages() : 0;
    let label;
    if (reqLimit === Infinity && imgLimit === Infinity) {
        label = '∞';
    } else if (imgLimit === 0 || imgLimit == null) {
        // Тариф без картинок — показываем только число запросов, без "/0", чтобы не путать.
        label = (reqLimit === Infinity) ? '∞' : String(reqRemain);
    } else {
        const reqStr = (reqLimit === Infinity) ? '∞' : String(reqRemain);
        const imgStr = (imgLimit === Infinity) ? '∞' : String(imgRemain);
        label = `${reqStr}/${imgStr}`;
    }
    textEl.textContent = label;
    badge.classList.remove('warning', 'exhausted');
    if (reqLimit !== Infinity) {
        if (reqRemain === 0) badge.classList.add('exhausted');
        else if (reqRemain === 1) badge.classList.add('warning');
    }

    // Гость не может менять тариф: бейдж-молния показывает счётчик, но НЕ ведёт на pricing,
    // пока пользователь не войдёт в аккаунт. Снимаем href (ссылка перестаёт быть кликабельной),
    // помечаем .disabled + aria-disabled и подменяем title-подсказку.
    const loggedIn = isUserLoggedIn();
    badge.classList.toggle('disabled', !loggedIn);
    badge.setAttribute('aria-disabled', String(!loggedIn));
    if (loggedIn) {
        badge.setAttribute('href', 'pricing.html');
        badge.removeAttribute('tabindex');
        // Подробный title — на десктопе появится при ховере: "Запросов: 49 · Картинок: 5".
        const titleParts = [];
        titleParts.push(`${uiText('quotaRequests', { fallback: 'Requests' })}: ${(reqLimit === Infinity) ? '∞' : `${reqRemain}/${reqLimit}`}`);
        if (imgLimit > 0) titleParts.push(`${uiText('quotaImages', { fallback: 'Images' })}: ${(imgLimit === Infinity) ? '∞' : `${imgRemain}/${imgLimit}`}`);
        badge.title = titleParts.join(' · ');
    } else {
        badge.removeAttribute('href');
        badge.setAttribute('tabindex', '-1');
        badge.title = uiText('signInToChangePlan', { fallback: 'Sign in to change your plan' });
    }
}

function getImageUsageKey() { return `solfai_img_${currentUser?.id || 'guest'}`; }
function getImageUsageData() {
    const data = JSON.parse(localStorage.getItem(getImageUsageKey()) || '{}');
    if (!data.timestamp || (Date.now() - data.timestamp) > USAGE_WINDOWS.image) return { timestamp: Date.now(), count: 0 };
    return data;
}
function getRemainingImages() {
    const limit = PLAN_LIMITS[currentPlan?.type || 'free'].images;
    if (limit === Infinity) return 9999;
    if (limit === 0) return 0;

    if (isUserLoggedIn()) {
        // Та же логика, что и для requests: БД — единственный источник истины.
        const dbUsage = Number(currentUser?.images_count);
        return Math.max(0, limit - (Number.isFinite(dbUsage) ? dbUsage : 0));
    }
    return Math.max(0, limit - getImageUsageData().count);
}
function useImage() {
    const limit = PLAN_LIMITS[currentPlan?.type || 'free'].images;
    if (limit === Infinity) return true;
    if (limit === 0) return false;

    if (isUserLoggedIn()) {
        const cur = Number(currentUser.images_count) || 0;
        if (cur >= limit) return false;
        currentUser.images_count = cur + 1;
        refreshImageAttachVisibility();
        return true;
    }

    const usage = getImageUsageData();
    if (usage.count < limit) { 
        usage.count++; 
        if(!usage.timestamp) usage.timestamp=Date.now(); 
        localStorage.setItem(getImageUsageKey(), JSON.stringify(usage)); 
        refreshImageAttachVisibility();
        return true; 
    }
    return false;
}

function showLimitModal() { limitModal?.classList.add('active'); updateLimitTimer(); }
function showImageLimitModal() { 
    closeAllOverlays(); 
    document.getElementById('imageLimitModal')?.classList.add('active'); 
    updateImageLimitTimer(); 
    refreshImageAttachVisibility();
}

function rollbackRequestUsage() {
    if (isUserLoggedIn()) {
        currentUser.requests_count = Math.max(0, (Number(currentUser.requests_count) || 0) - 1);
    } else {
        const usage = getUsageData();
        usage.count = Math.max(0, (usage.count || 0) - 1);
        saveUsageData(usage);
    }
    updateRequestsCounter();
}

function rollbackImageUsage() {
    if (isUserLoggedIn()) {
        currentUser.images_count = Math.max(0, (Number(currentUser.images_count) || 0) - 1);
    } else {
        const usage = getImageUsageData();
        usage.count = Math.max(0, (usage.count || 0) - 1);
        localStorage.setItem(getImageUsageKey(), JSON.stringify(usage));
    }
    refreshImageAttachVisibility();
}

function applyUsageFromServer(usage) {
    if (!usage || !currentUser?.id) return;
    if (Number.isFinite(Number(usage.requests_count))) currentUser.requests_count = Number(usage.requests_count);
    if (Number.isFinite(Number(usage.images_count))) currentUser.images_count = Number(usage.images_count);
    if (Number.isFinite(Number(usage.quiz_count))) currentUser.quiz_count = Number(usage.quiz_count);
    if (Number.isFinite(Number(usage.requests_window_start))) currentUser.requests_window_start = Number(usage.requests_window_start);
    if (Number.isFinite(Number(usage.images_window_start))) currentUser.images_window_start = Number(usage.images_window_start);
    if (Number.isFinite(Number(usage.quiz_window_start))) currentUser.quiz_window_start = Number(usage.quiz_window_start);
    localStorage.setItem('solfai_user', JSON.stringify(currentUser));
    updateRequestsCounter();
    refreshImageAttachVisibility();
    if (typeof updateQuizCounter === 'function') updateQuizCounter();
}

function getWindowRemainingMs(startMs, windowMs) {
    const start = Number(startMs) || 0;
    if (!start) return windowMs;
    return Math.max(0, windowMs - (Date.now() - start));
}

function updateLimitTimer() {
    const timerEl = document.getElementById('limitTimer');
    if (!timerEl) return;
    const windowMs = USAGE_WINDOWS.request;
    if (isUserLoggedIn()) {
        const remaining = getWindowRemainingMs(currentUser?.requests_window_start, windowMs);
        timerEl.textContent = formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), Math.floor(remaining / 3600000), Math.floor((remaining % 3600000) / 60000));
        return;
    }
    const data = JSON.parse(localStorage.getItem(getUsageKey()) || '{}');
    if (data.timestamp) {
        const remaining = windowMs - (Date.now() - data.timestamp);
        timerEl.textContent = remaining > 0
            ? formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), Math.floor(remaining / 3600000), Math.floor((remaining % 3600000) / 60000))
            : formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), 0, 0);
    } else timerEl.textContent = formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), 24, 0);
}
function updateImageLimitTimer() {
    const timerEl = document.getElementById('imageLimitTimer');
    if (!timerEl) return;
    const windowMs = USAGE_WINDOWS.image;
    if (isUserLoggedIn()) {
        const remaining = getWindowRemainingMs(currentUser?.images_window_start, windowMs);
        timerEl.textContent = formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), Math.floor(remaining / 3600000), Math.floor((remaining % 3600000) / 60000));
        return;
    }
    const data = JSON.parse(localStorage.getItem(getImageUsageKey()) || '{}');
    if (data.timestamp) {
        const remaining = windowMs - (Date.now() - data.timestamp);
        timerEl.textContent = remaining > 0
            ? formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), Math.floor(remaining / 3600000), Math.floor((remaining % 3600000) / 60000))
            : formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), 0, 0);
    } else timerEl.textContent = formatResetTimer(uiText('resetIn', { fallback: 'Reset in:' }), 24, 0);
}

function showToast(message, type = 'success', options = {}) {
    const dedupeKey = options.dedupeKey;
    const dismissOnClick = options.dismissOnClick;
    let container = document.getElementById('toastContainer');
    if (!container) { container = document.createElement('div'); container.id = 'toastContainer'; container.className = 'toast-container'; document.body.appendChild(container); }
    if (dedupeKey) {
        container.querySelectorAll(`[data-toast-dedupe="${dedupeKey}"]`).forEach(t => t.remove());
    }
    const toast = document.createElement('div'); toast.className = `toast ${type}`;
    if (dedupeKey) toast.dataset.toastDedupe = dedupeKey;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span><span>${message}</span>`;
    container.appendChild(toast);
    if (dismissOnClick) {
        const removeToast = () => {
            if (!toast.isConnected) return;
            toast.remove();
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
        const onPointerDown = (e) => {
            if (!toast.isConnected) return;
            if (toast.contains(e.target)) return;
            removeToast();
        };
        document.addEventListener('pointerdown', onPointerDown, { capture: true });
        setTimeout(() => removeToast(), 3000);
        return toast;
    }
    setTimeout(() => toast.remove(), 3000);
    return toast;
}

// ===== ДВИЖОК ЧАТА =====
function saveChatToStorage() {
    enforceChatLimit();
    const slimChats = chats.slice(0, MAX_SAVED_CHATS).map(c => ({
        id: c.id, title: c.title, pinned: c.pinned, createdAt: c.createdAt,
        messages: c.messages.slice(-60).map(m => ({ role: m.role, id: m.id, content: m.content.slice(0, 4000), attachments: m.attachments || [] }))
    }));
    try { localStorage.setItem(getChatsStorageKey(), JSON.stringify(slimChats)); } 
    catch (e) { localStorage.setItem(getChatsStorageKey(), JSON.stringify(slimChats.map(c => ({...c, messages: c.messages.map(m => ({...m, attachments: []}))})))); }

    // Отправка текущего чата в базу данных NeonDB
    if (currentUser && currentChatId) {
        const currentChatData = chats.find(c => c.id === currentChatId);
        if (currentChatData) {
            const chatToSave = { ...currentChatData, user_id: currentUser.id };
            apiFetch(`${WORKER_URL}/save-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chatToSave)
            }).catch(err => console.error('Failed to save chat:', err));
        }
    }
}

function createNewChat(firstMessage) {
    const chat = { id: Date.now().toString(), title: firstMessage.slice(0, 30) + '...', messages: [], createdAt: new Date().toISOString() };
    chats.unshift(chat); currentChatId = chat.id; saveChatToStorage(); renderChatsList(); return chat;
}

function loadChat(chatId) {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return;
    currentChatId = chatId; chatTitle.textContent = chat.title; chatMessages.innerHTML = '';
    window.__solfaiResponseLang = detectResponseLanguage('', chat.messages);
    if (window.SolfTheory && typeof window.SolfTheory.setLabelLocale === 'function') {
        window.SolfTheory.setLabelLocale(window.__solfaiResponseLang);
    }
    chat.messages.forEach((msg, i) => {
        let content = msg.content;
        if (msg.role === 'ai' && i > 0) {
            const prev = chat.messages[i - 1];
            if (prev && prev.role === 'user') {
                content = patchAiWithTheory(prev.content, content);
            }
        }
        addMessageToUI(msg.role, content, msg.attachments, false, msg.id);
    });
    renderChatsList();
}

function scrollToBottom(force = false) {
    if (!chatMessages) return;
    if (!force && !shouldAutoScroll) return;
    requestAnimationFrame(() => {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

async function addMessageToUI(role, content, attachments = [], withTyping = false, messageId = null) {
    const div = document.createElement('div');
    div.className = `message message-${role}`;
    if (messageId) div.dataset.messageId = messageId;
    
    let attHTML = attachments.filter(a => a.type.startsWith('image/')).map(a => `<div class="message-attachment"><img src="${a.data}" alt=""></div>`).join('');
    const avatarSVG = role === 'user' ? '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>' : '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
    
    const aiCopyBtnHtml = `<button class="message-copy-btn" type="button" onclick="copyAiMessage(this)" aria-label="Copy message">
            <svg class="copy-icon icon-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><rect x="4" y="4" width="11" height="11" rx="2"></rect></svg>
            <svg class="copy-icon icon-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </button>`;
    const includeCopyBtn = role === 'ai' && !withTyping;
    const aiCopyBtn = includeCopyBtn ? aiCopyBtnHtml : '';
    div.innerHTML = `<div class="message-avatar">${avatarSVG}</div><div class="message-body"><div class="message-content ${withTyping ? 'typing' : ''}">${withTyping ? '' : formatMessage(content)}${attHTML}</div>${aiCopyBtn}</div>`;
    chatMessages.appendChild(div); 

    if (!withTyping) {
        renderAllNotations(div);
    }
    
    // Прокручиваем, если включен автоскролл или это новое сообщение от пользователя
    if (shouldAutoScroll || role === 'user') {
        scrollToBottom(true);
    }
    
    if (withTyping && role === 'ai') {
        await typeMessage(div.querySelector('.message-content'), content, attHTML);
        div.querySelector('.message-body')?.insertAdjacentHTML('beforeend', aiCopyBtnHtml);
    }
}

async function typeMessage(contentEl, text, attachmentHTML) {
    shouldAutoScroll = true; // Принудительно включаем фокус при начале нового ответа
    const formattedText = formatMessage(text);
    // Печатаем только текстовую часть БЕЗ нотных блоков, чтобы не сыпать JSON по буквам
    const typingSource = stripNotationBlocks(text);
    const tempDiv = document.createElement('div'); tempDiv.innerHTML = formatMessage(typingSource);
    const plainText = tempDiv.textContent;
    let displayedText = '';
    const cursor = document.createElement('span'); cursor.className = 'typing-cursor'; contentEl.appendChild(cursor);

    for (let i = 0; i < plainText.length; i++) {
        displayedText += plainText[i];
        contentEl.innerHTML = formatPartialText(typingSource, i + 1) + '<span class="typing-cursor"></span>';
        
        // Автопрокрутка сработает только если пользователь не листал вверх
        if (shouldAutoScroll) {
            scrollToBottom();
        }
        
        await new Promise(r => setTimeout(r, '.!?'.includes(plainText[i]) ? TYPING_SPEED*4 : TYPING_SPEED));
    }
    contentEl.classList.remove('typing'); contentEl.innerHTML = formattedText + attachmentHTML;

    // После завершения печати — рендерим все нотные блоки в этом сообщении
    renderAllNotations(contentEl.parentElement || contentEl);

    if (shouldAutoScroll) {
        scrollToBottom();
    }
}
function formatPartialText(fullText, charCount) {
    let res = '', pIdx = 0, i = 0, inBold = false;
    while (i < fullText.length && pIdx < charCount) {
        if (fullText.slice(i, i+2) === '**') { res += inBold ? '</strong>' : '<strong>'; inBold = !inBold; i+=2; } 
        else if (fullText[i] === '\n') { res += '<br>'; pIdx++; i++; } 
        else { res += fullText[i]; pIdx++; i++; }
    }
    if (inBold) res += '</strong>'; return res;
}

// ===== НОТНАЯ ЗАПИСЬ: парсинг + рендер VexFlow =====
const NOTATION_BLOCK_RE = /\[\[NOTATION:\s*(\{[\s\S]*?\})\s*\]\]/g;

function stripNotationBlocks(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(NOTATION_BLOCK_RE, '')
        // Незавершённый (обрезанный ответом модели) хвост "[[NOTATION:..." без закрывающих "]]"
        // — тоже вырезаем, чтобы он не печатался по буквам как сырой JSON.
        .replace(/\[\[NOTATION:[\s\S]*$/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Попытка восстановить ОБРЕЗАННЫЙ нотный блок (ответ модели оборвался на середине JSON,
// например из-за лимита токенов / "high demand"). Берём пришедший фрагмент, обрезаем его до
// последней ПОЛНОСТЬЮ закрытой ноты внутри "notes":[...] и достраиваем закрывающие "]}".
// Возвращает распарсенный объект нотации или null, если чинить нечего.
function repairTruncatedNotation(fragment) {
    if (typeof fragment !== 'string') return null;
    const start = fragment.indexOf('{');
    if (start === -1) return null;
    let inStr = false, esc = false;
    const stack = [];
    let lastSafe = -1;
    for (let i = start; i < fragment.length; i++) {
        const ch = fragment[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{' || ch === '[') { stack.push(ch); continue; }
        if (ch === '}' || ch === ']') {
            stack.pop();
            // Закрыли объект-ноту, находясь прямо внутри массива notes корневого объекта
            // (stack == ['{','[']). Здесь можно безопасно «обрезать» и достроить JSON.
            if (ch === '}' && stack.length === 2 && stack[0] === '{' && stack[1] === '[') {
                lastSafe = i + 1;
            }
        }
    }
    if (lastSafe === -1) return null;
    try {
        const obj = JSON.parse(fragment.slice(start, lastSafe) + ']}');
        return (obj && Array.isArray(obj.notes) && obj.notes.length) ? obj : null;
    } catch (e) {
        return null;
    }
}

function escapeNotationAttr(json) {
    return String(json)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatMessage(text) {
    if (typeof text !== 'string') return '';
    // 1) Извлекаем нотные блоки и заменяем их на placeholder-ы (один токен на блок)
    const placeholders = [];
    let working = text.replace(NOTATION_BLOCK_RE, (match, json) => {
        try {
            const data = JSON.parse(json);
            const idx = placeholders.length;
            placeholders.push(data);
            return `\u0001SOLF_NOT_${idx}\u0001`;
        } catch (e) {
            console.warn('[Solf.ai] Notation JSON parse failed:', e, json);
            return '';
        }
    });

    // 1b) Обрезанный (незакрытый) блок "[[NOTATION:..." — ответ модели оборвался на середине
    //     JSON. Не показываем сырой JSON: пробуем восстановить уже пришедшие ноты, иначе ставим
    //     спец-токен, который ниже заменим на аккуратное уведомление.
    let truncatedNotice = false;
    const truncIdx = working.indexOf('[[NOTATION:');
    if (truncIdx !== -1) {
        const before = working.slice(0, truncIdx);
        const repaired = repairTruncatedNotation(working.slice(truncIdx));
        if (repaired) {
            const idx = placeholders.length;
            placeholders.push(repaired);
            working = before + `\u0001SOLF_NOT_${idx}\u0001`;
        } else {
            truncatedNotice = true;
            working = before + '\u0001SOLF_NOT_TRUNC\u0001';
        }
    }

    // 2) Базовое форматирование текста (без нотации)
    let html = working
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');

    // 3) Заменяем placeholder-ы на контейнеры для VexFlow.
    //    Глотаем соседние <br>, чтобы не было пустых строк сверху/снизу карточки.
    html = html.replace(/(?:<br>\s*)*\u0001SOLF_NOT_(\d+)\u0001(?:\s*<br>)*/g, (m, idx) => {
        const data = placeholders[Number(idx)];
        if (!data) return '';
        const json = escapeNotationAttr(JSON.stringify(data));
        return `<div class="solf-notation" data-notation="${json}" role="img" aria-label="Music notation"><div class="notation-loading">♪</div></div>`;
    });

    // Уведомление вместо обрезанного нотного блока, который не удалось восстановить.
    if (truncatedNotice) {
        const msg = uiText('notationTruncated', {
            chat: true,
            fallback: 'The notation example did not finish loading (response was cut off). Try asking again.'
        });
        html = html.replace(/(?:<br>\s*)*\u0001SOLF_NOT_TRUNC\u0001(?:\s*<br>)*/g,
            `<div class="notation-error">⚠️ ${msg}</div>`);
    }

    return html;
}

/** Render every `.solf-notation[data-notation]` inside `root` using VexFlow. */
function renderAllNotations(root) {
    if (!root || !root.querySelectorAll) return;
    const containers = root.querySelectorAll('.solf-notation[data-notation]:not([data-rendered])');
    if (!containers.length) return;

    // Если VexFlow ещё не догрузился — пробуем чуть позже (CDN, deferred script)
    if (!getVexFlowNamespace()) {
        if (renderAllNotations._retries == null) renderAllNotations._retries = 0;
        if (renderAllNotations._retries < 25) {
            renderAllNotations._retries++;
            setTimeout(() => renderAllNotations(root), 150);
        } else {
            containers.forEach(c => {
                c.innerHTML = `<div class="notation-error">⚠️ ${uiText('notationEngineFailed', { chat: true, fallback: 'Music engine failed to load' })}</div>`;
                c.setAttribute('data-rendered', '1');
            });
        }
        return;
    }

    containers.forEach(container => {
        let data;
        try {
            data = JSON.parse(container.getAttribute('data-notation'));
        } catch (e) {
            container.innerHTML = `<div class="notation-error">⚠️ ${uiText('notationInvalidData', { chat: true, fallback: 'Invalid notation data' })}</div>`;
            container.setAttribute('data-rendered', '1');
            return;
        }
        renderNotationCard(container, data);
        container.setAttribute('data-rendered', '1');
    });
}

function getVexFlowNamespace() {
    const ns = (window.Vex && window.Vex.Flow) || window.VexFlow || null;
    if (!ns) return null;
    if (ns.Renderer && ns.Stave && ns.StaveNote) return ns;
    if (ns.Flow && ns.Flow.Renderer) return ns.Flow;
    return null;
}

const NOTATION_DURATION_FRACTION = { w: 1, h: 0.5, q: 0.25, '8': 0.125, '16': 0.0625, '32': 0.03125 };

const KEY_FLAT_COUNT = {
    C: 0, G: 0, D: 0, A: 0, E: 0, B: 0, 'F#': 0, 'C#': 0,
    F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7
};
const KEY_SHARP_COUNT = {
    C: 0, F: 0, Bb: 0, Eb: 0, Ab: 0, Db: 0, Gb: 0, Cb: 0,
    G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
    'G#': 8, 'D#': 9, 'A#': 10
};
const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];

/** AI/legacy: Cm, Gm… → Eb, Bb… (relative major). */
function normalizeKeySignature(keySig) {
    const k = String(keySig || 'C').trim();
    const MAP = {
        Am: 'C', Em: 'G', Bm: 'D', 'F#m': 'A', 'C#m': 'E', 'G#m': 'B', 'D#m': 'F#', 'A#m': 'C#',
        Dm: 'F', Gm: 'Bb', Cm: 'Eb', Fm: 'Ab', Bbm: 'Db', Ebm: 'Gb', Abm: 'Cb'
    };
    return MAP[k] || k;
}

function getKeyFlats(keySig) {
    const n = KEY_FLAT_COUNT[keySig] ?? 0;
    return FLAT_ORDER.slice(0, n);
}

function getDefaultAccForLetter(letter, keySig) {
    const sc = KEY_SHARP_COUNT[keySig] ?? 0;
    if (sc > 0) {
        return SHARP_ORDER.slice(0, sc).includes(letter) ? 1 : 0;
    }
    return getKeyFlats(keySig).includes(letter) ? -1 : 0;
}

function parseVfKey(k) {
    const m = String(k).trim().match(/^([a-g])(bb|b|##|#)?\/(-?\d+)$/i);
    if (!m) return null;
    let acc = 0;
    if (m[2] === '#') acc = 1;
    else if (m[2] === '##') acc = 2;
    else if (m[2] === 'b') acc = -1;
    else if (m[2] === 'bb') acc = -2;
    return { letter: m[1].toLowerCase(), acc, octave: parseInt(m[3], 10) };
}

function accToVfSuffix(acc) {
    if (acc === 0) return '';
    if (acc > 0) return '#'.repeat(acc);
    return 'b'.repeat(-acc);
}

const NOTATION_OCTAVE_LIMITS = {
    treble: { top: 65, bottom: 48 },
    bass: { top: 55, bottom: 36 }
};

function noteAbsFromVfKey(k) {
    const p = parseVfKey(k);
    if (!p) return null;
    const LS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    return p.octave * 12 + LS[p.letter] + p.acc;
}

function shiftVfKeyOctaveLocal(k, delta) {
    const m = String(k).trim().match(/^([a-g](?:bb|b|##|#)?)\/(-?\d+)$/i);
    if (!m) return k;
    const oct = Math.max(1, Math.min(8, parseInt(m[2], 10) + delta));
    return `${m[1].toLowerCase()}/${oct}`;
}

/** Опускает всё упражнение, если ноты выше F5 (скрипичный ключ). */
function normalizeNotationOctavesLocal(notes, clef) {
    if (!Array.isArray(notes) || !notes.length) return notes;
    const lim = NOTATION_OCTAVE_LIMITS[clef === 'bass' ? 'bass' : 'treble'];
    let maxA = -Infinity;
    let minA = Infinity;
    notes.forEach(n => {
        (n.keys || []).forEach(k => {
            const a = noteAbsFromVfKey(k);
            if (a == null) return;
            maxA = Math.max(maxA, a);
            minA = Math.min(minA, a);
        });
    });
    if (!Number.isFinite(maxA)) return notes;
    let shift = 0;
    if (maxA > lim.top) shift = -Math.ceil((maxA - lim.top) / 12);
    if (shift && minA + shift * 12 < lim.bottom) {
        while (shift < 0 && minA + shift * 12 < lim.bottom) shift += 1;
    }
    if (!shift) return notes;
    return notes.map(n => ({
        ...n,
        keys: (n.keys || []).map(k => shiftVfKeyOctaveLocal(k, shift))
    }));
}

/** Нормализует key + modifier под ключ (бекары, ♭/♯ только где нужно). */
function prepareKeyForKeySig(key, keySig) {
    const p = parseVfKey(key);
    if (!p) return { key, modifier: null };
    const ks = normalizeKeySignature(keySig);
    const def = getDefaultAccForLetter(p.letter, ks);
    const base = `${p.letter}/${p.octave}`;
    if (p.acc === def) return { key: base, modifier: null };
    if (p.acc === 0 && def !== 0) return { key: base, modifier: 'n' };
    if (def === 0 && p.acc === -1) return { key: base, modifier: 'b' };
    if (def === 0 && p.acc === -2) return { key: base, modifier: 'bb' };
    if (def === 0 && p.acc === 1) return { key: base, modifier: '#' };
    if (def === 0 && p.acc === 2) return { key: base, modifier: '##' };
    if (def === -1 && p.acc === -2) return { key: base, modifier: 'b' };
    if (def === 1 && p.acc === 0) return { key: base, modifier: 'n' };
    return { key: `${p.letter}${accToVfSuffix(p.acc)}/${p.octave}`, modifier: null };
}

function applyNoteAccidentals(note, VF) {
    const list = note._accList;
    if (!list?.length || !VF.Accidental) return;
    list.forEach(({ modifier, origIdx }) => {
        if (!modifier) return;
        let idx = origIdx;
        if (note.sortedKeyProps?.length) {
            const pos = note.sortedKeyProps.findIndex(s => s.index === origIdx);
            if (pos >= 0) idx = pos;
        }
        try { note.addModifier(new VF.Accidental(modifier), idx); } catch (_) {}
    });
    delete note._accList;
}

function noteCenterX(sn) {
    try {
        if (sn.preFormatted === false) return null;
        const x = typeof sn.getAbsoluteX === 'function' ? sn.getAbsoluteX() : null;
        if (x == null || !Number.isFinite(x)) return null;
        const w = typeof sn.getWidth === 'function' ? sn.getWidth() : 36;
        return x + w / 2;
    } catch (_) {
        return null;
    }
}

const NOTATION_LABEL_FONT = "'Inter', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, 'Roboto', 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";

/** Latin v/y from AI or bad SVG font fallback → Cyrillic у in RU interval abbreviations (ув4, ум5…). */
function normalizeIntervalLabel(lbl) {
    if (!lbl) return lbl;
    // Latin v/y or tick-like fallback glyph → Cyrillic у (ув4, ум5…)
    return String(lbl).replace(/^[\u0076\u028B\u0079\u2713\u2714](?=[вм\d.])/i, '\u0443');
}

function drawChordLabelsBelow(svg, stave, staveNotes, notesData, color) {
    if (!svg || !staveNotes || !notesData) return;
    const NS = 'http://www.w3.org/2000/svg';
    let labelY = (stave.y || 0) + 98;
    try {
        if (typeof stave.getBottomY === 'function') labelY = stave.getBottomY() + 20;
    } catch (_) {}
    staveNotes.forEach((sn, i) => {
        const lbl = notesData[i]?.label;
        if (!lbl) return;
        const x = noteCenterX(sn);
        if (x == null) return;
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', String(x));
        t.setAttribute('y', String(labelY));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dominant-baseline', 'hanging');
        t.setAttribute('font-family', NOTATION_LABEL_FONT);
        t.setAttribute('font-size', '18');
        t.setAttribute('font-weight', '600');
        t.setAttribute('fill', color);
        t.textContent = normalizeIntervalLabel(lbl);
        svg.appendChild(t);
    });
}

function vfKeyLine(VF, key, clef) {
    try {
        const p = VF.keyProperties(key, clef);
        return p ? p.line : null;
    } catch (_) {
        return null;
    }
}

/** VexFlow даёт только 2 позиции на одной линии (обычная / смещённая); 3+ унисона накладываются. */
function expandUnisonHeads(staveNotes, notesData, clef, svg, color) {
    if (!svg || !staveNotes || !notesData) return;
    const VF = getVexFlowNamespace();
    if (!VF) return;
    const SHIFT = 11;

    staveNotes.forEach((sn, idx) => {
        const rawKeys = notesData[idx]?.keys;
        if (!Array.isArray(rawKeys)) return;

        const lineWant = new Map();
        rawKeys.forEach(k => {
            const line = vfKeyLine(VF, k, clef);
            if (line == null) return;
            lineWant.set(line, (lineWant.get(line) || 0) + 1);
        });

        const heads = sn.note_heads || (typeof sn.getNoteHeads === 'function' ? sn.getNoteHeads() : null);
        if (!heads || !heads.length) return;

        const byLine = new Map();
        heads.forEach(h => {
            if (h.line == null) return;
            if (!byLine.has(h.line)) byLine.set(h.line, []);
            byLine.get(h.line).push(h);
        });

        lineWant.forEach((want, line) => {
            if (want < 3) return;
            const lineHeads = byLine.get(line) || [];
            if (!lineHeads.length) return;

            lineHeads.sort((a, b) => (a.getAbsoluteX?.() || 0) - (b.getAbsoluteX?.() || 0));
            const xs = [];
            lineHeads.forEach(h => {
                const x = Math.round(h.getAbsoluteX?.() || 0);
                if (!xs.includes(x)) xs.push(x);
            });

            let missing = want - xs.length;
            if (missing <= 0 && want >= 3 && xs.length === 2) missing = 1;
            if (missing <= 0) return;

            const leftmost = lineHeads[0];
            const svgEl = leftmost.getSVGElement?.();
            if (!svgEl || !svgEl.parentNode) return;

            for (let m = 0; m < missing; m++) {
                const dx = -SHIFT * (m + 1);
                const clone = svgEl.cloneNode(true);
                clone.setAttribute('transform', `translate(${dx}, 0)`);
                svgEl.parentNode.insertBefore(clone, svgEl);
                clone.querySelectorAll('path, rect, ellipse, polygon').forEach(el => {
                    const fill = el.getAttribute('fill');
                    if (fill && fill !== 'none') el.setAttribute('fill', color);
                    const stroke = el.getAttribute('stroke');
                    if (stroke && stroke !== 'none') el.setAttribute('stroke', color);
                });
            }
        });
    });
}

function buildStaveNote(VF, clef, n, keySig) {
    const duration = String(n.duration || 'q').toLowerCase();
    const isRest = duration.includes('r');
    const rawKeys = Array.isArray(n.keys) && n.keys.length ? n.keys : ['c/4'];
    const ks = normalizeKeySignature(keySig || 'C');
    const prepared = isRest ? rawKeys.map(k => ({ key: k, modifier: null })) : rawKeys.map(k => prepareKeyForKeySig(k, ks));
    const keys = prepared.map(p => p.key);
    const note = new VF.StaveNote({
        clef,
        keys: isRest ? [clef === 'bass' ? 'd/3' : 'b/4'] : keys,
        duration
    });
    if (!isRest) {
        note._accList = prepared.map((p, origIdx) => (p.modifier ? { modifier: p.modifier, origIdx } : null)).filter(Boolean);
    }
    return note;
}

function noteDurationBeats(durationStr, beatValue) {
    const raw = String(durationStr || 'q').toLowerCase().replace('r', '');
    const dotted = /[d.]+$/.test(raw);
    const key = raw.replace(/[d.]+$/, '');
    const base = NOTATION_DURATION_FRACTION[key] ?? 0.25;
    const fraction = dotted ? base * 1.5 : base;
    return fraction * beatValue;
}

function groupNotesIntoMeasures(rawNotes, numBeats, beatValue) {
    const measures = [];
    let cur = [];
    let acc = 0;
    rawNotes.forEach(n => {
        const beats = noteDurationBeats(n.duration, beatValue);
        // Если новая нота не помещается — закрываем текущий такт.
        if (cur.length && acc + beats > numBeats + 1e-6) {
            measures.push(cur);
            cur = [];
            acc = 0;
        }
        cur.push(n);
        acc += beats;
        if (acc + 1e-6 >= numBeats) {
            measures.push(cur);
            cur = [];
            acc = 0;
        }
    });
    if (cur.length) measures.push(cur);
    if (!measures.length) measures.push([]);
    return measures;
}

/**
 * Группирует ноты в сегменты-«такты» в зависимости от режима тактовых черт.
 * - "auto"   — по `timeSignature` (как раньше).
 * - "manual" — границы задаёт сама модель флагом `barAfter:true`/`endBar:true` на ноте.
 * - "none"   — не делим на такты совсем; для верстки длинных гамм рубим
 *              на «виртуальные» сегменты по NOTES_PER_LINE, но граничные черты
 *              у таких сегментов скрываем при отрисовке (см. renderNotationCard).
 */
function groupNotesIntoSegments(rawNotes, mode, numBeats, beatValue) {
    const NOTES_PER_LINE = 8;

    if (mode === 'manual') {
        const segments = [];
        let cur = [];
        rawNotes.forEach(n => {
            cur.push(n);
            if (n && (n.barAfter === true || n.endBar === true)) {
                segments.push(cur);
                cur = [];
            }
        });
        if (cur.length) segments.push(cur);
        if (!segments.length) segments.push([]);
        return segments;
    }

    if (mode === 'none') {
        if (!rawNotes.length) return [[]];
        const segments = [];
        for (let i = 0; i < rawNotes.length; i += NOTES_PER_LINE) {
            segments.push(rawNotes.slice(i, i + NOTES_PER_LINE));
        }
        return segments;
    }

    return groupNotesIntoMeasures(rawNotes, numBeats, beatValue);
}

function getBarlineNoneType(VF) {
    try {
        const t = VF.Barline && VF.Barline.type;
        if (t && typeof t.NONE !== 'undefined') return t.NONE;
    } catch (_) { }
    return 0;
}

function renderNotationCard(container, data) {
    const VF = getVexFlowNamespace();
    if (!VF) {
        container.innerHTML = `<div class="notation-error">⚠️ ${uiText('notationEngineNotLoaded', { chat: true, fallback: 'Music engine not loaded' })}</div>`;
        return;
    }
    container.innerHTML = '';

    try {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        const noteColor = isLight ? '#1a1a2e' : '#e6e6f0';

        // Авто-подписи: проставляем label каждому интервалу/аккорду, у которого его ещё нет
        // (например, блок сгенерировала сама модель). Готовые подписи не трогаем.
        if (window.SolfTheory && typeof window.SolfTheory.autoLabelNotation === 'function') {
            try {
                const labelLang = window.__solfaiResponseLang
                    || (typeof currentLang === 'string' && currentLang)
                    || localStorage.getItem('solfai_lang')
                    || 'en';
                if (typeof window.SolfTheory.setLabelLocale === 'function') {
                    window.SolfTheory.setLabelLocale(labelLang);
                }
                window.SolfTheory.autoLabelNotation(data);
            } catch (_) {}
        }

        const clef = (data.clef === 'bass') ? 'bass' : 'treble';
        const keySig = normalizeKeySignature(typeof data.keySignature === 'string' ? data.keySignature : 'C');
        const rawTimeSig = typeof data.timeSignature === 'string' ? data.timeSignature.trim() : '4/4';
        let rawNotes = Array.isArray(data.notes) ? data.notes : [];
        rawNotes = normalizeNotationOctavesLocal(rawNotes, clef);
        if (window.SolfTheory && typeof window.SolfTheory.normalizeNotationOctaves === 'function') {
            try { rawNotes = window.SolfTheory.normalizeNotationOctaves(rawNotes, clef); } catch (_) {}
        }

        const barlinesMode = (['none', 'manual', 'auto'].includes(data.barlines)) ? data.barlines : 'auto';
        const timeSigHidden = !rawTimeSig || rawTimeSig === 'none' || barlinesMode !== 'auto';
        const timeSig = timeSigHidden ? '4/4' : rawTimeSig;

        const tsParts = timeSig.split('/');
        const numBeats = Math.max(parseInt(tsParts[0], 10) || 4, 1);
        const beatValue = Math.max(parseInt(tsParts[1], 10) || 4, 1);

        const measures = groupNotesIntoSegments(rawNotes, barlinesMode, numBeats, beatValue);
        const barlineNone = getBarlineNoneType(VF);

        const containerW = container.clientWidth || container.parentElement?.clientWidth || 600;
        const preferSingleLine = (barlinesMode === 'manual' && measures.length <= 6)
            || (barlinesMode === 'none' && rawNotes.length <= 9);
        const maxW = preferSingleLine
            ? Math.max(containerW - 16, 520)
            : Math.min(Math.max(containerW - 16, 280), 960);

        const FIRST_OVERHEAD = 100;
        const NEXT_OVERHEAD = 14;
        const PER_NOTE = 28;
        const MIN_MEASURE = 88;
        const measureBaseW = m => Math.max(MIN_MEASURE, m.length * PER_NOTE + 22);

        // Раскладка тактов по строкам с переносом
        let rows = [];
        if (preferSingleLine && measures.length) {
            rows = [measures.map((m, i) => ({
                notes: m,
                width: (i === 0 ? FIRST_OVERHEAD : NEXT_OVERHEAD) + measureBaseW(m),
                isFirstOfRow: i === 0
            }))];
        } else {
            let row = [];
            let rowW = 0;
            measures.forEach(m => {
                const isFirstOfRow = row.length === 0;
                const overhead = isFirstOfRow ? FIRST_OVERHEAD : NEXT_OVERHEAD;
                const w = measureBaseW(m) + overhead;
                if (!isFirstOfRow && rowW + w > maxW) {
                    rows.push(row);
                    row = [{ notes: m, width: FIRST_OVERHEAD + measureBaseW(m), isFirstOfRow: true }];
                    rowW = FIRST_OVERHEAD + measureBaseW(m);
                } else {
                    row.push({ notes: m, width: w, isFirstOfRow });
                    rowW += w;
                }
            });
            if (row.length) rows.push(row);
        }

        // Растягиваем строки до всей доступной ширины
        rows.forEach(r => {
            const total = r.reduce((s, mm) => s + mm.width, 0);
            const slack = Math.max(0, maxW - total);
            if (slack > 0) {
                const totalNotes = r.reduce((s, mm) => s + Math.max(mm.notes.length, 1), 0);
                r.forEach(mm => {
                    const share = Math.round(slack * (Math.max(mm.notes.length, 1) / totalNotes));
                    mm.width += share;
                });
            }
        });

        const ROW_HEIGHT = 132;
        const TOP_PAD = 12;
        const totalHeight = rows.length * ROW_HEIGHT + TOP_PAD + 32;
        const rowPixelW = rows.reduce((mx, r) => Math.max(mx, r.reduce((s, mm) => s + mm.width, 0)), 0);
        const totalWidth = Math.max(maxW + 16, rowPixelW + 16);

        const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
        renderer.resize(totalWidth, totalHeight);
        const ctx = renderer.getContext();
        if (typeof ctx.setFillStyle === 'function') ctx.setFillStyle(noteColor);
        if (typeof ctx.setStrokeStyle === 'function') ctx.setStrokeStyle(noteColor);

        rows.forEach((r, rowIdx) => {
            let x = 8;
            const y = TOP_PAD + rowIdx * ROW_HEIGHT;
            const unisonBatch = [];
            r.forEach((mm, mIdx) => {
                const stave = new VF.Stave(x, y, mm.width);
                if (mm.isFirstOfRow) {
                    try { stave.addClef(clef); } catch (_) {}
                    try { stave.addKeySignature(keySig); } catch (_) {}
                    if (rowIdx === 0 && mIdx === 0 && !timeSigHidden) {
                        try { stave.addTimeSignature(timeSig); } catch (_) {}
                    }
                }

                if (barlinesMode === 'none') {
                    try { stave.setBegBarType(barlineNone); } catch (_) {}
                    try { stave.setEndBarType(barlineNone); } catch (_) {}
                }

                stave.setContext(ctx).draw();

                if (mm.notes.length) {
                    const staveNotes = mm.notes.map(n => buildStaveNote(VF, clef, n, keySig));
                    const voiceBeats = barlinesMode === 'auto'
                        ? numBeats
                        : Math.max(
                            mm.notes.reduce((s, n) => s + noteDurationBeats(n.duration, beatValue), 0),
                            1e-3
                        );
                    const voice = new VF.Voice({ num_beats: voiceBeats, beat_value: beatValue });
                    if (typeof voice.setStrict === 'function') voice.setStrict(false);
                    voice.addTickables(staveNotes);
                    staveNotes.forEach(sn => { try { sn.setStave(stave); } catch (_) {} });
                    const overhead = mm.isFirstOfRow ? FIRST_OVERHEAD : 30;
                    const formatWidth = Math.max(mm.width - overhead, 50);
                    const formatter = new VF.Formatter();
                    formatter.joinVoices([voice]).format([voice], formatWidth);
                    staveNotes.forEach(sn => applyNoteAccidentals(sn, VF));
                    formatter.joinVoices([voice]).format([voice], formatWidth);
                    voice.draw(ctx, stave);
                    unisonBatch.push({ staveNotes, notesData: mm.notes, stave });
                }

                x += mm.width;
            });
            const svg = container.querySelector('svg');
            unisonBatch.forEach(({ staveNotes, notesData, stave }) => {
                try { expandUnisonHeads(staveNotes, notesData, clef, svg, noteColor); } catch (_) {}
                try { drawChordLabelsBelow(svg, stave, staveNotes, notesData, noteColor); } catch (_) {}
            });
        });

        // Перекрашиваем уже отрисованный SVG в цвет темы
        const svg = container.querySelector('svg');
        if (svg) {
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            svg.querySelectorAll('path, rect, line, ellipse, polygon').forEach(el => {
                const fill = el.getAttribute('fill');
                if (fill && fill !== 'none') el.setAttribute('fill', noteColor);
                const stroke = el.getAttribute('stroke');
                if (stroke && stroke !== 'none') el.setAttribute('stroke', noteColor);
            });
            svg.querySelectorAll('text').forEach(el => el.setAttribute('fill', noteColor));
        }
    } catch (err) {
        console.error('[Solf.ai] VexFlow render error:', err);
        container.innerHTML = `<div class="notation-error">⚠️ ${uiText('notationRenderFailed', { chat: true, fallback: 'Could not render notation' })}: ${err.message || err}</div>`;
    }
}

window.copyAiMessage = async function(button) {
    const messageContent = button?.closest('.message-body')?.querySelector('.message-content');
    if (!messageContent) return;
    try {
        await navigator.clipboard.writeText(messageContent.innerText.trim());
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 1000);
    } catch (_) {
        showToast(uiText('copyFailed', { fallback: 'Copy failed' }), 'error');
    }
};

function showTypingIndicator() {
    const div = document.createElement('div'); div.className = 'message message-ai'; div.id = 'typingIndicator';
    div.innerHTML = `<div class="message-avatar"><svg class="svg-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div><div class="message-content"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`;
    chatMessages.appendChild(div); scrollToBottom(true);
}

async function generateResponse(query, imageData = null) {
    if (getRemainingRequests() <= 0) { showNoRequestsToast(); refreshSendButtonState(); return; }
    if (imageData && getRemainingImages() <= 0) { 
        refreshImageAttachVisibility();
        showImageLimitModal(); 
        attachedFiles = []; 
        if (typeof chatAttachedFiles !== 'undefined') chatAttachedFiles.innerHTML = ''; 
        return; 
    }
    if (isGenerating) return; 

    isGenerating = true;
    userAbortedGeneration = false;
    generationStartedAt = Date.now();
    currentAbortController = new AbortController();
    chatSendBtn.disabled = false; chatSendBtn.classList.add('stop-btn');
    chatSendBtn.innerHTML = `<svg class="svg-icon" style="color:white;" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg>`;
    
    showTypingIndicator(); useRequest(); if(imageData) useImage();
    
    try {
        const chat = chats.find(c => c.id === currentChatId);
        const responseLang = detectResponseLanguage(query, chat?.messages);
        window.__solfaiResponseLang = responseLang;
        if (window.SolfTheory && typeof window.SolfTheory.setLabelLocale === 'function') {
            window.SolfTheory.setLabelLocale(responseLang);
        }

        const messages = [{ role: 'system', content: getSystemInstruction(responseLang) }];
        
        const baseUserContent = query || 'Analyze image';
        const freshBuildTask = notationModeEnabled && isBuildTask(baseUserContent);

        if (chat) {
            // ИСКЛЮЧАЕМ самое последнее сообщение из истории (оно уже добавлено в UI, но мы передадим его ниже)
            // Это решает проблему ошибки API при первом сообщении.
            //
            // «Прочистка памяти» для build-задач: не передаём ответы ассистента — они часто
            // содержат урезанные/ошибочные построения, и модель начинает их копировать.
            // Оставляем только последние 2 user-сообщения (язык + контекст тональности).
            let history = chat.messages.slice(-11, -1);
            if (freshBuildTask) {
                history = history.filter(m => m.role === 'user').slice(-2);
            }
            history.forEach(msg => {
                const content = notationModeEnabled
                    ? (msg.content || '')
                    : stripNotationBlocks(msg.content || '');
                messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content });
            });
        }
        
        // Базовое содержимое user-сообщения. При включённом режиме нотации — добавляем
        // невидимый ремайндер, который сильно повышает шанс, что модель не забудет блок.
        const apiUserContent = notationModeEnabled
            ? `${baseUserContent}${buildNotationUserReminder(responseLang)}${freshBuildTask ? buildFreshTaskReminder(baseUserContent, responseLang) : ''}`
            : baseUserContent;
        messages.push({ role: 'user', content: apiUserContent });

        // Бюджет токенов. Большие задачи (цепочки аккордов на 15+ строк, гармонизации,
        // диктанты, модуляции) требуют много выходных токенов — иначе ответ обрежется.
        // isBigNotationTask() распознаёт такие запросы и поднимает лимит до 8192.
        // ВАЖНО: воркер тоже должен уважать этот лимит (см. worker.js /generate).
        const bigTask = notationModeEnabled && isBigNotationTask(baseUserContent);
        const tokenBudget = notationModeEnabled ? (bigTask ? 8192 : 2048) : 1024;
        const payload = {
            userId: currentUser?.id,
            messages,
            temperature: notationModeEnabled ? (freshBuildTask ? 0.35 : 0.45) : 0.7,
            max_tokens: tokenBudget,
            maxOutputTokens: tokenBudget,
            image: imageData ? {
                mime_type: imageData.match(/data:(.*?);/)?.[1] || 'image/jpeg',
                data: imageData.includes(',') ? imageData.split(',')[1] : imageData
            } : null
        };

        const requestTimeoutMs = imageData ? 90000 : 60000;
        const res = await apiFetch(`${WORKER_URL}/generate`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload), 
            signal: currentAbortController.signal 
        }, requestTimeoutMs);

        const data = await res.json();
        if (!res.ok || data.error) {
            console.error('Server error:', data);
            if (res.status === 429 || data.code === 'LIMIT_REQUESTS') {
                rollbackRequestUsage();
                if (imageData) rollbackImageUsage();
                showNoRequestsToast();
                return;
            }
            if (res.status === 429 && data.code === 'LIMIT_IMAGES') {
                rollbackRequestUsage();
                rollbackImageUsage();
                showImageLimitModal();
                return;
            }
            const detailedError = data.message || data.error?.message || data.error || 'API Error';
            throw new Error(detailedError);
        }

        let aiText = data.text || data.choices?.[0]?.message?.content || 'Empty response';

        // === Защита от записи нот при ВЫКЛЮЧЕННОЙ кнопке ===
        // Если модель по инерции выдала [[NOTATION:...]] (например, из-за длинной истории),
        // удаляем блок ДО сохранения в chat.messages — чтобы он не оседал в БД и не
        // всплывал при перезаходе в чат. Старые сохранённые блоки это не трогает.
        if (!notationModeEnabled && hasNotationBlock(aiText)) {
            aiText = stripNotationBlocks(aiText).trim();
        }

        // === Детерминированная нотация: считаем ВЕРНЫЕ ноты для распознанных заданий ===
        // Движок theory.js строит ноты формулами (тритоны, характерные интервалы, гаммы,
        // трезвучия+обращения, D7). Если задание распознано — мы получим гарантированно
        // корректный блок, поэтому можем пропустить дорогие авто-ретраи к модели.
        let deterministicBlock = null;
        if (typeof window !== 'undefined' && window.SolfTheory) {
            try {
                const det = window.SolfTheory.buildNotationForQuery(baseUserContent);
                if (det && det.blockString) deterministicBlock = det.blockString;
            } catch (theoryErr) {
                console.warn('[Solf.ai] Theory engine skipped:', theoryErr);
            }
        } else if (notationModeEnabled) {
            console.warn('[Solf.ai] window.SolfTheory MISSING — theory.js не загрузился');
        }

        // === Silent auto-retry, если режим нотации включён, а модель "забыла" блок ===
        // Покрываем 2 случая: (1) блок отсутствует целиком; (2) блок начался, но обрезан
        // (нет закрывающего `]}]]`). Во втором случае срезаем «хвост» и просим
        // догенерировать ТОЛЬКО блок (без прозы), что гарантированно влезает в любой лимит.
        // Ретраи НЕ нужны, если у нас уже есть детерминированный блок — он всё равно перекроет ответ.
        // Тайпинг-индикатор намеренно НЕ убираем — пользователь видит обычное ожидание.
        if (notationModeEnabled && !deterministicBlock && !hasNotationBlock(aiText)) {
            const truncated = hasTruncatedNotationStart(aiText);
            const cleanedAiText = truncated ? stripTruncatedNotationTail(aiText) : aiText;
            // Если блок был обрезан — стартуем сразу с "только-JSON" промпта,
            // чтобы не дёргать модель лишний раз тяжелыми инструкциями.
            const notationRetryPrompts = truncated
                ? [NOTATION_RETRY_PROMPT_3, NOTATION_RETRY_PROMPT_3, NOTATION_RETRY_PROMPT_2]
                : [NOTATION_RETRY_PROMPT, NOTATION_RETRY_PROMPT_2, NOTATION_RETRY_PROMPT_3];
            const notationRetryTemps = truncated ? [0.1, 0.05, 0.15] : [0.25, 0.12, 0.05];
            const notationRetryBudgets = [2048, 3072, 4096];
            try {
                for (let ri = 0; ri < notationRetryPrompts.length && !hasNotationBlock(aiText); ri++) {
                    const retryMessages = messages.concat([
                        { role: 'assistant', content: cleanedAiText || ' ' },
                        { role: 'user', content: notationRetryPrompts[ri] }
                    ]);
                    const retryBudget = notationRetryBudgets[ri] ?? 2048;
                    const retryRes = await apiFetch(`${WORKER_URL}/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId: currentUser?.id,
                            usageAlreadyCounted: true,
                            messages: retryMessages,
                            temperature: notationRetryTemps[ri] ?? 0.15,
                            max_tokens: retryBudget,
                            maxOutputTokens: retryBudget,
                            image: null
                        }),
                        signal: currentAbortController.signal
                    }, requestTimeoutMs);
                    const retryData = await retryRes.json().catch(() => ({}));
                    if (retryRes.ok && !retryData.error) {
                        const retryText = retryData.text || retryData.choices?.[0]?.message?.content || '';
                        if (hasNotationBlock(retryText)) {
                            // Если был обрезанный случай — сшиваем «чистый» исходный текст
                            // с пришедшим блоком, чтобы пользователь увидел нормальное объяснение
                            // плюс рендер. В остальных случаях просто берём ответ ретрая целиком.
                            if (truncated && cleanedAiText) {
                                const blockMatch = retryText.match(NOTATION_BLOCK_RE);
                                aiText = blockMatch
                                    ? `${cleanedAiText}\n${blockMatch[0]}`.trim()
                                    : retryText;
                            } else {
                                aiText = retryText;
                            }
                            break;
                        }
                    }
                }
            } catch (retryErr) {
                if (retryErr?.name !== 'AbortError') {
                    console.warn('[Solf.ai] Notation auto-retry failed:', retryErr);
                }
            }
        }

        // Подставляем готовый нотный блок из theory.js (перекрывает блок модели).
        aiText = patchAiWithTheory(baseUserContent, aiText);

        document.getElementById('typingIndicator')?.remove();
        if (data.usage) {
            applyUsageFromServer(data.usage);
        }
        chat.messages.push({ role: 'ai', content: aiText, time: new Date().toISOString(), id: Date.now().toString() }); 
        saveChatToStorage();
        await addMessageToUI('ai', aiText, [], true);
        
    } catch (e) {
        document.getElementById('typingIndicator')?.remove();
        if (e.name !== 'AbortError') {
            rollbackRequestUsage();
            if (imageData) rollbackImageUsage();
        }
        if (e.name === 'AbortError') {
            if (userAbortedGeneration) {
                addMessageToUI('ai', `🛑 ${uiText('chatStopped', { chat: true, fallback: 'Stopped.' })}`, [], false);
            } else {
                addMessageToUI('ai', `❌ ${uiText('chatTimeout', { chat: true, fallback: 'Request timed out. Try again.' })}`, [], false);
            }
        } else {
            addMessageToUI('ai', `❌ ${uiText('chatError', { chat: true, fallback: 'Error' })}: ${e.message}`, [], false);
        }
    } finally {
        isGenerating = false;
        userAbortedGeneration = false;
        currentAbortController = null;
        chatSendBtn.classList.remove('stop-btn');
        chatSendBtn.innerHTML = `<svg class="svg-icon" style="color: white;" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
        refreshSendButtonState();
    }
}
function showLoginPrompt() {
    if (pendingQuery) {
        try {
            sessionStorage.setItem('solfai_pending_query', JSON.stringify(pendingQuery));
        } catch (_) {}
    }
    navigateToLogin();
}

function restorePendingQueryAfterLogin() {
    if (!currentUser) return;
    try {
        const raw = sessionStorage.getItem('solfai_pending_query');
        if (!raw) return;
        const pq = JSON.parse(raw);
        sessionStorage.removeItem('solfai_pending_query');
        if (pq?.query) proceedWithQuery(pq.query, pq.imageData);
    } catch (_) {}
}

function startNewChat() {
    closeAllOverlays();
    saveChatToStorage(); currentChatId = null; chatMessages.innerHTML = '';
    chatTitle.textContent = (typeof solfaiGetText === 'function' ? solfaiGetText('newChat') : '') || 'New Chat';
    chatInput.value = '';
    const skipAutoFocus = sessionStorage.getItem('solfai_skip_focus_once') === '1';
    if (skipAutoFocus) {
        document.activeElement?.blur?.();
        chatInput?.blur?.();
    } else {
        chatInput.focus();
    }
    attachedFiles = []; chatAttachedFiles.innerHTML = ''; renderChatsList();
    refreshSendButtonState();
    if (isMobileLayout()) {
        sidebar.classList.add('collapsed');
        syncMobileSidebarDrawerState();
    }
}

/** После возврата со страницы настроек: не поднимать клавиатуру (особенно iOS). */
function scheduleSkipChatInputFocusCleanup() {
    if (sessionStorage.getItem('solfai_skip_focus_once') !== '1') return;
    let readonlyArmed = false;
    const stealFocusWithSink = () => {
        const sink = document.createElement('button');
        sink.type = 'button';
        sink.setAttribute('tabindex', '-1');
        sink.setAttribute('aria-hidden', 'true');
        Object.assign(sink.style, {
            position: 'fixed',
            width: '1px',
            height: '1px',
            padding: '0',
            margin: '0',
            opacity: '0',
            pointerEvents: 'none',
            border: 'none',
            left: '0',
            bottom: '0',
        });
        document.body.appendChild(sink);
        try {
            sink.focus({ preventScroll: true });
        } catch (_) {
            sink.focus();
        }
        sink.blur();
        sink.remove();
    };
    const run = () => {
        const input = document.getElementById('chatInput');
        if (!input) return;
        input.blur();
        document.activeElement?.blur?.();
        stealFocusWithSink();
        if (readonlyArmed) return;
        if (sessionStorage.getItem('solfai_skip_focus_once') !== '1') return;
        readonlyArmed = true;
        sessionStorage.removeItem('solfai_skip_focus_once');
        const prevInputmode = input.getAttribute('inputmode');
        input.setAttribute('readonly', 'readonly');
        input.setAttribute('inputmode', 'none');
        const disarm = () => {
            input.removeAttribute('readonly');
            if (prevInputmode == null || prevInputmode === '') input.removeAttribute('inputmode');
            else input.setAttribute('inputmode', prevInputmode);
        };
        input.addEventListener('pointerdown', disarm, { once: true, capture: true });
        input.addEventListener('touchstart', disarm, { once: true, passive: true, capture: true });
        setTimeout(disarm, 8000);
    };
    run();
    requestAnimationFrame(run);
    setTimeout(run, 0);
    setTimeout(run, 120);
    setTimeout(run, 350);
    setTimeout(run, 600);
}

function proceedWithQuery(query, imageData) {
    if (!currentChatId) { createNewChat(query || 'Image'); chatTitle.textContent = (query || 'Image').slice(0, 30); }
    const chat = chats.find(c => c.id === currentChatId);
    window.__solfaiResponseLang = detectResponseLanguage(query, chat?.messages);
    chatAttachedFiles.innerHTML = ''; chatInput.value = ''; chatInput.style.height = 'auto';
    chat.messages.push({ role: 'user', content: query || 'Analyze', attachments: imageData ? [{ type: 'image/png', data: imageData }] : [], time: new Date().toISOString(), id: Date.now().toString() });
    saveChatToStorage();
    addMessageToUI('user', query || uiText('analyzeImage', { chat: true, fallback: 'Analyze image' }), imageData ? [{ type: 'image/png', data: imageData }] : []);
    generateResponse(query, imageData); attachedFiles = [];
}

function sendChatMessage() {
    const query = chatInput.value.trim(); const imageData = attachedFiles[0]?.data || null;
    if (getRemainingRequests() <= 0) { showNoRequestsToast(); refreshSendButtonState(); return; }
    if ((!query && !imageData) || isGenerating) return;
    lastUserQuery = query;
    if (!currentUser) { pendingQuery = { query, imageData }; showLoginPrompt(); return; }
    proceedWithQuery(query, imageData);
}

function updateUIForUser() {
    if (currentUser) {
        document.documentElement.classList.add('is-logged-in');

        // Аватарка с lh3.googleusercontent.com может не загрузиться без VPN — на этот
        // случай навешиваем onerror, который при сбое подменяет картинку на инициал имени.
        // Так юзер не увидит "сломанный" `<img>`-плейсхолдер браузера.
        const initial = (currentUser.name || currentUser.email || '?').trim().charAt(0).toUpperCase();
        const picture = currentUser.picture || '';
        const imgChat = document.getElementById('profileImgChat');
        if (imgChat) {
            imgChat.alt = initial;
            imgChat.src = picture;
            imgChat.onerror = () => { imgChat.removeAttribute('src'); imgChat.style.display = 'none'; };
        }
        document.getElementById('profileNameChat').textContent = (currentUser.name || '').split(' ')[0];
        document.getElementById('profileFullNameChat').textContent = currentUser.name || '';
        document.getElementById('profileEmailChat').textContent = currentUser.email || '';
        // Sidebar avatar: если picture пустая или сломалась — показываем инициал поверх фона.
        const sidebarAvatar = document.getElementById('userAvatarSidebar');
        if (sidebarAvatar) {
            if (picture) {
                sidebarAvatar.innerHTML = `<img src="${picture}" alt="${initial}" onerror="this.parentElement.innerHTML='<span class=\\'avatar-initial\\'>${initial}</span>';" style="width:100%;height:100%;object-fit:cover; border-radius:50%;">`;
            } else {
                sidebarAvatar.innerHTML = `<span class="avatar-initial">${initial}</span>`;
            }
        }
        document.getElementById('userNameSidebar').textContent = currentUser.name || '';
    } else {
        document.documentElement.classList.remove('is-logged-in');
        document.documentElement.classList.remove('show-upgrade');
    }
    
    // Сначала грузим кэш, чтобы интерфейс не дергался
    chats = JSON.parse(localStorage.getItem(getChatsStorageKey()) || '[]');
    updatePlanDisplay(); renderChatsList();
    if (!currentChatId) startNewChat();

    // НОВОЕ: Асинхронно грузим чаты из БД и обновляем UI.
    // 15 сек хватит даже на медленную мобильную связь; если бэк не отвечает (без VPN),
    // юзер останется со списком из localStorage и сможет продолжать работу.
    if (currentUser) {
        apiFetch(`${WORKER_URL}/get-chats?user_id=${currentUser.id}`, {}, 15000)
            .then(res => res.json())
            .then(data => {
                if (data.chats && data.chats.length > 0) {
                    chats = data.chats;
                    // Срезаем «лишние» чаты сверх MAX_SAVED_CHATS и удаляем их с сервера,
                    // чтобы БД не раздувалась.
                    enforceChatLimit();
                    localStorage.setItem(getChatsStorageKey(), JSON.stringify(chats.slice(0, MAX_SAVED_CHATS)));
                    renderChatsList();
                }
            })
            .catch(err => console.error("Ошибка загрузки истории чатов из БД:", err));
    }
}

function logout() {
    if (typeof getSolfSessionToken === 'function' && getSolfSessionToken()) {
        fetch(`${WORKER_URL}/auth/logout`, {
            method: 'POST',
            headers: solfAuthHeaders(),
        }).catch(() => {});
    }
    if (typeof clearSolfAuth === 'function') clearSolfAuth();
    currentUser = null;
    localStorage.setItem('solfai_plan_guest', JSON.stringify({ type: "free", emoji: PLAN_ICONS.free, name: "Free" }));
    updateUIForUser();
    updatePlanDisplay();
    document.querySelectorAll('.profile-dropdown').forEach(d => d.classList.remove('active'));
    // Полная перезагрузка страницы для чистого сброса состояния (чаты, кэш, UI)
    setTimeout(() => { window.location.reload(); }, 60);
}

// === ОБРАБОТКА И ВЫВОД КАРТИНОК ===
function handleFileSelect(files, container) {
    const file = files[0];
    
    // Мягкая проверка: либо тип начинается на image/, либо расширение файла подходящее
    if (!file || (!file.type.startsWith('image/') && !file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i))) {
        showToast(uiText('imageOnly', { fallback: 'Please select an image file' }), 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = e => {
        // Если тип пустой, ставим заглушку
        attachedFiles = [{ name: file.name, type: file.type || 'image/jpeg', data: e.target.result }];
        
        if (container) {
            container.innerHTML = `<div class="attached-file">
                <img src="${e.target.result}" alt="">
                <span>${file.name.slice(0, 15)}</span>
                <button class="remove-file" onclick="attachedFiles=[]; this.parentElement.remove(); if (typeof refreshSendButtonState === 'function') refreshSendButtonState();">✕</button>
            </div>`;
        }
        
        refreshSendButtonState();
    };
    reader.readAsDataURL(file);
}

// ===== УДАЛЕНИЕ ЧАТА ПРИ 0 СООБЩЕНИЙ =====
// ===== МЕТРОНОМ И ПИАНИНО =====
let metronomeInterval = null; let metronomeAudioContext = null; let metronomeBpm = 120; let metronomeBeats = 4; let currentBeat = 0; let isMetronomePlaying = false;
function initMetronome() {
    const modal = document.getElementById('metronomeModal'); const openBtn = document.getElementById('openMetronomeBtn');
    if(!modal) return;
    openBtn?.addEventListener('click', () => { closeSidebarWhenOpeningTool(); modal.classList.add('active'); updateBeatIndicators(); });
    document.getElementById('metronomeCloseBtn')?.addEventListener('click', () => { stopMetronome(); modal.classList.remove('active'); });
    document.getElementById('bpmSlider')?.addEventListener('input', e => {
        metronomeBpm = parseInt(e.target.value, 10);
        document.getElementById('bpmValue').textContent = metronomeBpm;
        updateTempoPresets();
        updateMetronomeIntervalOnly();
    });
    document.getElementById('metronomePlayBtn')?.addEventListener('click', () => { isMetronomePlaying ? stopMetronome() : startMetronome(); });
    
    document.querySelectorAll('.tempo-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            metronomeBpm = parseInt(btn.dataset.bpm);
            document.getElementById('bpmSlider').value = metronomeBpm;
            document.getElementById('bpmValue').textContent = metronomeBpm;
            updateTempoPresets();
            updateMetronomeIntervalOnly();
        });
    });
    
    document.querySelectorAll('.time-sig-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.time-sig-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active'); metronomeBeats = parseInt(btn.dataset.beats);
            updateBeatIndicators(); if (isMetronomePlaying) { stopMetronome(); startMetronome(); }
        });
    });
}
function updateTempoPresets() { document.querySelectorAll('.tempo-preset').forEach(btn => { btn.classList.toggle('active', Math.abs(parseInt(btn.dataset.bpm) - metronomeBpm) < 15); }); }

/** Меняет только период тиков без немедленного удара (иначе при drag слайдера слышен «шум» из десятков кликов подряд). */
function updateMetronomeIntervalOnly() {
    if (!isMetronomePlaying) return;
    clearInterval(metronomeInterval);
    metronomeInterval = setInterval(playMetronomeTick, 60000 / metronomeBpm);
}

function updateBeatIndicators() {
    const container = document.querySelector('.metronome-beat-indicators'); if (!container) return;
    container.innerHTML = ''; for (let i = 0; i < metronomeBeats; i++) { const dot = document.createElement('span'); dot.className = 'beat-dot'; dot.dataset.beat = i + 1; container.appendChild(dot); }
}
function startMetronome() {
    if (!metronomeAudioContext) metronomeAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (metronomeAudioContext.state === 'suspended') metronomeAudioContext.resume();
    isMetronomePlaying = true; currentBeat = 0;
    document.getElementById('metronomePlayBtn').innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> <span>${uiText('metronomeStop', { fallback: 'Stop' })}</span>`;
    playMetronomeTick(); metronomeInterval = setInterval(playMetronomeTick, 60000 / metronomeBpm);
}
function stopMetronome() {
    isMetronomePlaying = false; clearInterval(metronomeInterval);
    document.getElementById('metronomePlayBtn').innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> <span>${uiText('metronomeStart', { fallback: 'Start' })}</span>`;
}
function playMetronomeTick() {
    const isAccent = currentBeat === 0; const frequency = isAccent ? 1000 : 800; const duration = 0.05;
    const oscillator = metronomeAudioContext.createOscillator(); const gainNode = metronomeAudioContext.createGain();
    oscillator.connect(gainNode); gainNode.connect(metronomeAudioContext.destination);
    oscillator.frequency.value = frequency; oscillator.type = 'square';
    gainNode.gain.setValueAtTime(0.3, metronomeAudioContext.currentTime); gainNode.gain.exponentialRampToValueAtTime(0.01, metronomeAudioContext.currentTime + duration);
    oscillator.start(metronomeAudioContext.currentTime); oscillator.stop(metronomeAudioContext.currentTime + duration);
    
    document.querySelectorAll('.beat-dot').forEach((dot, i) => {
        dot.classList.remove('active', 'accent');
        if (i === currentBeat) { dot.classList.add('active'); if (isAccent) dot.classList.add('accent'); }
    });
    
    const pendulum = document.getElementById('metronomePendulum');
    if (pendulum) { pendulum.classList.remove('tick'); void pendulum.offsetWidth; pendulum.classList.add('tick'); }
    currentBeat = (currentBeat + 1) % metronomeBeats;
}

let pianoAudioContext = null;
let pianoOctave = 4;
const pianoNoteFreqs = { 'C': 261.63, 'C#': 277.18, 'D': 293.66, 'D#': 311.13, 'E': 329.63, 'F': 349.23, 'F#': 369.99, 'G': 392.00, 'G#': 415.30, 'A': 440.00, 'A#': 466.16, 'B': 493.88 };
const pianoChords = { 'C': ['C', 'E', 'G'], 'D': ['D', 'F#', 'A'], 'E': ['E', 'G#', 'B'], 'F': ['F', 'A', 'C'], 'G': ['G', 'B', 'D'], 'A': ['A', 'C#', 'E'], 'B': ['B', 'D#', 'F#'], 'Cm': ['C', 'D#', 'G'], 'Dm': ['D', 'F', 'A'], 'Em': ['E', 'G', 'B'], 'Fm': ['F', 'G#', 'C'], 'Gm': ['G', 'A#', 'D'], 'Am': ['A', 'C', 'E'], 'Bm': ['B', 'D', 'F#'], 'C7': ['C', 'E', 'G', 'A#'], 'D7': ['D', 'F#', 'A', 'C'], 'E7': ['E', 'G#', 'B', 'D'], 'F7': ['F', 'A', 'C', 'D#'], 'G7': ['G', 'B', 'D', 'F'], 'A7': ['A', 'C#', 'E', 'G'], 'B7': ['B', 'D#', 'F#', 'A'] };
let currentChordsPage = 0;
const totalChordsPages = 3;

function initPiano() {
    const modal = document.getElementById('pianoModal'); const openBtn = document.getElementById('openPianoBtn');
    if(!modal) return;
    openBtn?.addEventListener('click', () => { closeSidebarWhenOpeningTool(); modal.classList.add('active'); });
    document.getElementById('pianoCloseBtn')?.addEventListener('click', () => modal.classList.remove('active'));
    modal?.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
    
    document.getElementById('octaveDown')?.addEventListener('click', () => { if (pianoOctave > 1) { pianoOctave--; document.getElementById('currentOctave').textContent = pianoOctave; } });
    document.getElementById('octaveUp')?.addEventListener('click', () => { if (pianoOctave < 7) { pianoOctave++; document.getElementById('currentOctave').textContent = pianoOctave; } });
    
    document.querySelectorAll('.white-key, .black-key').forEach(key => {
        const playNote = () => { const note = key.dataset.note; playPianoNote(note); key.classList.add('active'); document.getElementById('pianoNoteName').textContent = note + pianoOctave; document.getElementById('pianoNoteFreq').textContent = Math.round(getPianoFrequency(note)) + ' Hz'; };
        const stopNote = () => key.classList.remove('active');
        key.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            playNote();
        });
        key.addEventListener('pointerup', stopNote);
        key.addEventListener('pointercancel', stopNote);
        key.addEventListener('pointerleave', stopNote);
    });
    
    document.querySelectorAll('.chord-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const chordName = btn.dataset.chord; const notes = pianoChords[chordName];
            if (notes) { playPianoChord(notes); btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 500); document.getElementById('pianoNoteName').textContent = chordName; document.getElementById('pianoNoteFreq').textContent = notes.join(' - '); }
        });
    });
    
    document.getElementById('chordsLeft')?.addEventListener('click', () => { currentChordsPage = (currentChordsPage - 1 + totalChordsPages) % totalChordsPages; updateChordsPage(); });
    document.getElementById('chordsRight')?.addEventListener('click', () => { currentChordsPage = (currentChordsPage + 1) % totalChordsPages; updateChordsPage(); });
    
    const keyMap = { 'a': 'C', 'w': 'C#', 's': 'D', 'e': 'D#', 'd': 'E', 'f': 'F', 't': 'F#', 'g': 'G', 'y': 'G#', 'h': 'A', 'u': 'A#', 'j': 'B' };
    document.addEventListener('keydown', e => {
        if (!modal.classList.contains('active') || e.repeat) return;
        if (e.key === 'ArrowLeft' && pianoOctave > 1) { pianoOctave--; document.getElementById('currentOctave').textContent = pianoOctave; return; }
        if (e.key === 'ArrowRight' && pianoOctave < 7) { pianoOctave++; document.getElementById('currentOctave').textContent = pianoOctave; return; }
        const note = keyMap[e.key.toLowerCase()];
        if (note) { playPianoNote(note); const keyEl = document.querySelector(`[data-note="${note}"]`); if (keyEl) keyEl.classList.add('active'); }
    });
    document.addEventListener('keyup', e => { const note = keyMap[e.key.toLowerCase()]; if (note) { const keyEl = document.querySelector(`[data-note="${note}"]`); if (keyEl) keyEl.classList.remove('active'); } });
}
function getPianoFrequency(note) { return pianoNoteFreqs[note] * Math.pow(2, pianoOctave - 4); }
function playPianoNote(note) {
    if (!pianoAudioContext) pianoAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (pianoAudioContext.state === 'suspended') pianoAudioContext.resume();
    const osc = pianoAudioContext.createOscillator(); const gain = pianoAudioContext.createGain();
    osc.connect(gain); gain.connect(pianoAudioContext.destination);
    osc.type = 'triangle'; osc.frequency.value = getPianoFrequency(note);
    const now = pianoAudioContext.currentTime;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.5, now + 0.02); gain.gain.exponentialRampToValueAtTime(0.01, now + 1);
    osc.start(now); osc.stop(now + 1);
}
function playPianoChord(notes) { 
    notes.forEach((n, i) => {
        setTimeout(() => {
            playPianoNote(n);
            const keyEl = document.querySelector(`[data-note="${n}"]`);
            if (keyEl) {
                keyEl.classList.add('active');
                setTimeout(() => keyEl.classList.remove('active'), 500);
            }
        }, i * 20); 
    }); 
}
function updateChordsPage() {
    document.querySelectorAll('.chords-page').forEach((p, i) => p.classList.toggle('active', i === currentChordsPage));
    document.querySelectorAll('.chord-dot').forEach((d, i) => d.classList.toggle('active', i === currentChordsPage));
}

// Одноразовая миграция: для залогиненных пользователей лимиты теперь живут только в БД,
// поэтому старые ключи `solfai_usage_<userId>` и `solfai_img_<userId>` в localStorage
// больше не нужны — они вводили в заблуждение ("блин, лимиты у меня в кэше???").
// Чистим их один раз при первом запуске новой версии. Ключи гостя (`*_guest`) не трогаем.
function migrateRemoveStaleUsageKeysOnce() {
    try {
        const FLAG = 'solfai_migrated_usage_v1';
        if (localStorage.getItem(FLAG) === '1') return;
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if ((k.startsWith('solfai_usage_') || k.startsWith('solfai_img_')) && !k.endsWith('_guest')) {
                toRemove.push(k);
            }
        }
        toRemove.forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
        localStorage.setItem(FLAG, '1');
    } catch (_) { /* localStorage может быть запрещён в incognito — не падаем */ }
}

// ===== ИНИЦИАЛИЗАЦИЯ И СЛУШАТЕЛИ =====
function redirectVkOAuthToLogin() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (!params.get('code') || !params.get('device_id')) return;
        if (/login\.html/i.test(window.location.pathname || '')) return;
        window.location.replace('login.html' + window.location.search);
    } catch (_) {}
}

async function initApp() {
    redirectVkOAuthToLogin();
    migrateRemoveStaleUsageKeysOnce();
    // КРИТИЧНО: НЕ ждём `await syncAppData()`. Раньше тут было `await`, и если Cloudflare
    // Workers не отвечал (юзер без VPN — workers.dev часто режется ТСПУ), весь initApp
    // висел до таймаута, а значит ВСЕ обработчики кнопок ниже не успевали навеситься.
    // На странице кнопки физически были, но клики игнорировались — "ничего не работает".
    // Теперь sync запускается параллельно: UI сразу инициализируется с данными из
    // localStorage-кэша (logged-in, имя, тариф уже там), а БД догонит в фоне и обновит.
    syncAppData().catch((err) => console.warn('[Solf.ai] syncAppData (background) failed:', err));
    initTheme();
    initColor();
    initFontSize();

    if (typeof setLanguage === 'function' && typeof currentLang !== 'undefined') {
        setLanguage(currentLang); 
    }
    
    // ВСЕГДА вызываем updateUIForUser, не только для гостей. Раньше тут было
    // `if (!currentUser) updateUIForUser()` — и если юзер залогинен, аватарка/имя/email
    // ставились ТОЛЬКО внутри syncAppData() после ответа БД. А если БД не отвечает
    // (Cloudflare без VPN) — профиль так и оставался пустым ("есть buttn 'M' и всё").
    // Теперь рисуем профиль СРАЗУ из localStorage-кэша, БД лишь освежит позже.
    updateUIForUser();
    restorePendingQueryAfterLogin();
    
    // --- ПРАВИЛЬНАЯ РАБОТА ВИЗУАЛЬНЫХ КНОПОК ПРИКРЕПЛЕНИЯ ---
    const attachBtns = document.querySelectorAll('#chatAttachBtn, .attach-btn');
    attachBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            // Если лимит 0 - кидаем табличку. Если больше - открываем проводник
            if (getRemainingImages() <= 0) {
                showImageLimitModal();
            } else {
                if (chatFileInput) chatFileInput.click();
            }
        });
    });

    if (chatFileInput) {
        chatFileInput.addEventListener('change', e => { 
            handleFileSelect(e.target.files, chatAttachedFiles); 
            // Задержка нужна, чтобы FileReader успел загрузить файл в память
            setTimeout(() => { e.target.value = ''; }, 100);
        });
    }
    if (chatMessages) {
        chatMessages.addEventListener('scroll', () => {
            // Если скролл находится почти в самом низу (погрешность 20px)
            const isAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 20;
            shouldAutoScroll = isAtBottom;
        });
    }
    
    bindAppButtonFocusBehavior();

    if (chatInput) {
        chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'; refreshSendButtonState(); });
        chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isGenerating) sendChatMessage(); } });
    }
    
    if (chatSendBtn) chatSendBtn.addEventListener('click', () => {
        if (isGenerating) {
            if (canAbortGeneration()) abortGeneration();
            return;
        }
        sendChatMessage();
    });
    if (newChatBtn) newChatBtn.addEventListener('click', startNewChat);
    
    if (toggleSidebarBtn) toggleSidebarBtn.addEventListener('click', e => {
        e.stopPropagation();
        const willCollapse = !sidebar.classList.contains('collapsed');
        sidebar.classList.toggle('collapsed');
        syncMobileSidebarDrawerState();
        if (willCollapse) {
            resetSidebarExpandedMenus();
            closeAllOverlays();
        }
    });

    if (sidebar) {
        const onMobileSidebarInteraction = e => {
            if (!isMobileLayout()) return;
            closeAllOverlays(e.target);
            e.stopPropagation();
        };
        sidebar.addEventListener('click', onMobileSidebarInteraction, false);
        sidebar.addEventListener('pointerdown', onMobileSidebarInteraction, { passive: true });
    }

    // Гарантированный сброс, если сайдбар закрылся любым способом
    if (sidebar) {
        const sidebarObserver = new MutationObserver(() => {
            syncMobileSidebarDrawerState();
            if (sidebar.classList.contains('collapsed')) {
                resetSidebarExpandedMenus();
                closeAllOverlays();
            }
        });
        sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('resize', syncMobileSidebarDrawerState);
    document.addEventListener('click', e => handleOutsideTapDismiss(e.target));
    document.addEventListener(
        'pointerdown',
        e => {
            if (!isMobileLayout()) return;
            if (e.button != null && e.button !== 0) return;
            handleOutsideTapDismiss(e.target);
        },
        true
    );
    
    document.getElementById('limitCloseBtn')?.addEventListener('click', () => limitModal.classList.remove('active'));
    document.getElementById('subscribeBtn')?.addEventListener('click', () => {
        window.location.href = 'pricing.html';
    });
    document.getElementById('imageLimitCloseBtn')?.addEventListener('click', () => document.getElementById('imageLimitModal').classList.remove('active'));
    document.getElementById('sidebarLoginBtn')?.addEventListener('click', navigateToLogin);
    
    document.getElementById('profileBtnChat')?.addEventListener('click', e => { 
        e.stopPropagation(); 
        const dropdown = document.getElementById('profileDropdownChat');
        const isActive = dropdown.classList.contains('active');
        closeAllOverlays();
        if (!isActive) dropdown.classList.add('active'); 
    });
    
    setInterval(() => { 
        updateLimitTimer(); 
        updateImageLimitTimer(); 
        refreshImageAttachVisibility(); 
    }, 60000);
    refreshSendButtonState();
}

let appInitPromise = null;

function revealApp() {
    document.body.classList.remove('no-transition');
    document.body.classList.remove('preload');
    document.body.classList.add('app-ready');
}

document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.getElementById('sidebar');
    const isMobile = isMobileLayout();

    document.body.classList.add('preload');
    document.body.classList.add('no-transition');

    if (sidebar) {
        if (isMobile) {
            sidebar.classList.add('collapsed');
        } else {
            sidebar.classList.remove('collapsed');
        }
        syncMobileSidebarDrawerState();
    }

    // Safety: если fetch завис или сеть медленная — показываем UI через 3 секунды
    const safetyTimer = setTimeout(revealApp, 3000);

    appInitPromise = (async () => {
        await initApp();
        scheduleSkipChatInputFocusCleanup();
        
        if (typeof initMetronome === 'function') initMetronome();
        if (typeof initPiano === 'function') initPiano();
        if (typeof initQuiz === 'function') initQuiz();
    })();
    
    if (window.visualViewport) {
        const syncViewportCssVar = () => {
            if (window.innerWidth >= 768) {
                document.documentElement.style.setProperty('--vh', `${window.visualViewport.height * 0.01}px`);
            } else {
                document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
            }
        };
        window.visualViewport.addEventListener('resize', () => {
            syncViewportCssVar();
            if (document.activeElement === chatInput) return;
            setTimeout(() => scrollToBottom(true), 50);
        });
        syncViewportCssVar();
    }
    
    const modals = document.querySelectorAll('.limit-modal, .quiz-modal, .tool-modal, .exit-modal-overlay');
    const obs = new MutationObserver(() => { document.body.style.overflow = Array.from(modals).some(m => m.classList.contains('active')) ? 'hidden' : ''; });
    modals.forEach(m => obs.observe(m, { attributes: true, attributeFilter: ['class'] }));

    appInitPromise.finally(() => {
        clearTimeout(safetyTimer);
        requestAnimationFrame(revealApp);
    });
});

window.addEventListener('load', () => {
    if (appInitPromise && typeof appInitPromise.finally === 'function') {
        appInitPromise.finally(() => {
            requestAnimationFrame(revealApp);
        });
    } else {
        requestAnimationFrame(revealApp);
    }
    scheduleSkipChatInputFocusCleanup();
});

window.addEventListener('pageshow', () => {
    scheduleSkipChatInputFocusCleanup();
});

function abortGeneration() {
    if (!canAbortGeneration()) return;
    userAbortedGeneration = true;
    currentAbortController?.abort();
    if (lastUserQuery && chatInput) {
        chatInput.value = lastUserQuery;
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        chatInput.focus();
    }
}

// Service Worker — режим "kill-switch".
//
// У ряда пользователей в браузере залип старый SW от прошлого деплоя; он пытался кешировать
// внешние CDN и без VPN падал с `Cache.put() encountered a network error`, а ещё отдавал 404
// на favicon из мёртвого кеша. Поэтому:
//   1. Если старый SW ещё не заменился — регистрируем sw.js, который сам снесёт все caches
//      и сделает unregister (см. sw.js).
//   2. Если SW уже умер (registrations пуст) — НИЧЕГО не регистрируем заново. Никаких новых SW.
//
// Откат: заменить sw.js на нормальный, развернуть его регистрацию обратно.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            const regs = await navigator.serviceWorker.getRegistrations();
            if (regs && regs.length > 0) {
                // Есть старые регистрации — подменяем их kill-switch'ом.
                navigator.serviceWorker.register('./sw.js').catch(() => {});
            }
        } catch (_) { /* SW недоступен — и не надо */ }
    });
}