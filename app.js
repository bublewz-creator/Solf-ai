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
    const ctrl = new AbortController();
    const merged = { ...options, signal: ctrl.signal };
    const timer = setTimeout(() => {
        try { ctrl.abort(); } catch (_) {}
    }, timeoutMs);
    try {
        return await fetch(url, merged);
    } finally {
        clearTimeout(timer);
    }
}

async function syncUserWithDB(user) {
    try {
        const res = await fetchWithTimeout(`${WORKER_URL}/save-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: user.id,
                email: user.email,
                name: user.name,
                picture: user.picture
            })
        }, 12000);

        if (!res.ok) {
            console.error('Ошибка синхронизации пользователя с БД');
        } else {
            console.log('Пользователь успешно синхронизирован с БД');
        }
    } catch (error) {
        console.error('Сетевая ошибка при синхронизации пользователя:', error);
    }
}

async function syncAppData() {
    if (!currentUser?.id) return;

    try {
        // 12 сек — потолок для GET-запроса к БД. Если бэк за это время не ответил,
        // значит сеть/Cloudflare режут, и зависать дальше бессмысленно. Юзер останется
        // с локально-кэшированными данными (имя/план/счётчик), и UI будет работать.
        const res = await fetchWithTimeout(`${WORKER_URL}/get-user?id=${currentUser.id}`, {}, 12000);
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
            quiz_count: quizCount
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
        console.error('Ошибка синхронизации данных приложения:', error);
    }
}

const PLAN_LIMITS = {
    free:      { requests: 3, images: 0 },
    basic:     { requests: 10, images: 0 },
    pro:       { requests: 50, images: 5 },
    unlimited: { requests: Infinity, images: Infinity }
};

const GOOGLE_CLIENT_ID = '691304539168-iaouqdnkd73iprkcs6cou2i93t11qiak.apps.googleusercontent.com';

// #region agent log
const __agentDebug = {
    runId: 'pre-fix',
    send(payload) {
        try {
            const isLocalhost =
                location.hostname === 'localhost' ||
                location.hostname === '127.0.0.1' ||
                location.hostname === '[::1]';
            if (!isLocalhost) return;

            fetch('http://127.0.0.1:7506/ingest/9a7aba86-9003-45f5-81ab-51ebecfce514', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'd42321' }, body: JSON.stringify({ sessionId: 'd42321', ...payload, timestamp: Date.now() }) }).catch(() => { });
        } catch (_) { }
    }
};

window.addEventListener('error', (e) => {
    __agentDebug.send({
        hypothesisId: 'E',
        location: 'app.js:global',
        message: 'window.error',
        data: {
            message: e?.message,
            filename: e?.filename,
            lineno: e?.lineno,
            colno: e?.colno
        }
    });
});

window.addEventListener('unhandledrejection', (e) => {
    __agentDebug.send({
        hypothesisId: 'E',
        location: 'app.js:global',
        message: 'unhandledrejection',
        data: { reason: String(e?.reason?.message || e?.reason) }
    });
});
// #endregion

// ===== СТРОГИЙ ПРОМПТ =====
const SYSTEM_PROMPT = `You are Solf.ai, an AI assistant for music theory and solfeggio.
Your tasks: explain music theory in simple terms, analyze images with musical notes.
CRITICAL INSTRUCTION: DO NOT mention the built-in site tools (Piano, Metronome, Quiz) in your regular answers! Only mention them IF the user explicitly asks how to practice or train their ear. Answer directly and concisely.
IMPORTANT: ALWAYS answer in the SAME language the user is speaking.`;

const TYPING_SPEED = 20;

// Элементы
const chatPage = document.getElementById('chatPage');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');

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
    document.querySelectorAll('#toolsAccordion, #settingsAccordion').forEach(el => el.classList.remove('open'));
    document.querySelectorAll('.sidebar-header-btn').forEach(btn => btn.classList.remove('open'));
    document.querySelectorAll('#langDropdown, #colorDropdown').forEach(el => el?.classList.remove('active'));
    const langArrow = document.getElementById('langArrow');
    if (langArrow) langArrow.style.transform = 'rotate(0deg)';
    const colorArrow = document.getElementById('colorArrow');
    if (colorArrow) colorArrow.style.transform = 'rotate(0deg)';
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
const loginModal = document.getElementById('loginModal');
const limitModal = document.getElementById('limitModal');
const sidebarUser = document.getElementById('sidebarUser');
const chatFileInput = document.getElementById('chatFileInput');
const chatAttachedFiles = document.getElementById('chatAttachedFiles');

let isGenerating = false;
let shouldAutoScroll = true;
let currentAbortController = null;
let lastUserQuery = '';
let currentChatId = null;
let chats = []; 
let attachedFiles = [];
let currentUser = JSON.parse(localStorage.getItem('solfai_user') || 'null');
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
            if (typeof updateInterfaceTranslations === 'function') {
                updateInterfaceTranslations();
            } else if (typeof updateTexts === 'function') {
                updateTexts();
            }
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
- "keySignature": "C","G","D","A","E","B","F#","C#","F","Bb","Eb","Ab","Db","Gb","Cb","Am","Em","Bm","F#m","C#m","G#m","D#m","A#m","Dm","Gm","Cm","Fm","Bbm","Ebm","Abm".
- "timeSignature": "4/4","3/4","2/4","6/8","12/8", etc. Можно "" (пустая строка) или "none", чтобы НЕ показывать размер. В barlines:"none"/"manual" размер всё равно не рисуется.
- "barlines": (необязательно) "auto" | "none" | "manual". Без поля = "auto".
- "notes": non-empty array of {"keys":[...], "duration":"...", "barAfter": true (необязательно), "label": "…" (необязательно)}.
  - "keys" pitches "letter[#|b]/octave" e.g. "c/4","f#/4","bb/3". Multiple keys in one entry = a stacked chord.
  - "duration": "w","h","q","8","16". Append "r" for rests ("qr","hr"…).
  - "barAfter": true — ставится ТОЛЬКО при barlines:"manual" и означает «после этой ноты — тактовая черта». В других режимах флаг игнорируется.
  - "label": КОРОТКАЯ подпись над созвучием на русском (рисуется над нотой). Подписывай КАЖДЫЙ интервал/аккорд:
    • интервалы — качество+ступеневая величина: "ув.4","ум.5","б.3","м.6","ч.5" и т.п.;
    • трезвучия по функции: "Т5/3","Т6","Т6/4","S5/3","D5/3" (или по структуре "Б5/3","М5/3","Ув5/3","Ум5/3");
    • доминантсептаккорд и обращения: "Д7","Д6/5","Д4/3","Д2";
    • ступени гаммы — римские цифры "I"…"VIII".
    Если не уверен в функции — давай структурную подпись. Подпись — это ТЕКСТ внутри JSON, не отдельная нота.
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

CORRECT EXAMPLE (user: "построй тоническое трезвучие в до мажоре"):
Тоническое трезвучие T5/3 в до мажоре строится из I, III и V ступеней — нот до, ми и соль:
[[NOTATION:{"clef":"treble","keySignature":"C","barlines":"none","notes":[{"keys":["c/4","e/4","g/4"],"duration":"w"}]}]]

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

REMEMBER:
- Easy / normal questions → 1–3 short sentences + ONE small notation block. Stop.
- Hard tasks → up to 5–8 sentences (or short numbered steps) + 1 long block (or a few blocks). Still no fluff.
- The very last line is always a valid [[NOTATION:{...}]] block. Never send prose with no notation.
- Гамма / одиночный интервал / одиночный аккорд → barlines:"none", без timeSignature.
- Тритоны и характерные интервалы с разрешениями → barlines:"manual" с "barAfter":true после каждой пары.
- Метрическая музыка (диктант, гармонизация, кадансы) → barlines:"auto" с реальным timeSignature.
- «Тритоны» = ВСЕГДА обе пары (ув.4+разр., ум.5+разр.). «Характерные» = ВСЕГДА все 4 пары. Никогда не урезай комплект до одного примера.`;

function getSystemInstruction() {
    let prompt = SYSTEM_PROMPT;
    if (currentAiMode === 'berserk' && !notationModeEnabled) {
        // Без оскорблений/брани: максимально прямолинейный, “жесткий” стиль с фокусом на полезность
        prompt += `\n\nStyle: Be максимально прямолинейным и резким по тону, но без мата, унижений и личных оскорблений. Коротко, по делу, с сарказмом допускается, но всегда давай корректный и полезный ответ.`;
    }
    if (notationModeEnabled) {
        prompt += NOTATION_PROMPT_INSTRUCTION;
    }
    return prompt;
}

/**
 * Невидимый для пользователя постфикс к КАЖДОМУ запросу при включённом режиме нотации.
 * Дублирует ключевое требование на уровне user-сообщения — модели легко "забывают"
 * системный промпт после нескольких ходов, а вот свежее user-сообщение всегда соблюдают.
 */
const NOTATION_USER_REMINDER =
    '\n\n[NOTATION MODE — silent reminder, never quote this text]\n' +
    'KEEP TEXT VERY SHORT: 1–2 sentences (≤30 words) for normal questions, up to 4–6 short sentences only for genuinely hard tasks (harmonization, voice leading, modulation, dictation, counterpoint). No headings, no recap, no fluff. ' +
    'End the message with a valid [[NOTATION:{...}]] block as the FINAL line. Default = ONE small block (1–2 measures). Use multiple blocks only for hard tasks. Never wrap blocks in code fences. ' +
    'JSON PRIORITY: полный закрытый JSON-блок важнее длинного текста — если кажется, что ответ длинный, сокращай ТЕКСТ, не обрывай JSON. Блок обязан заканчиваться на ]}]]. ' +
    'EXERCISE COMPLETENESS: «тритоны лада X» (без слова «натуральные») = ГАРМОНИЧЕСКАЯ форма = 2 пары = 8 созвучий (натуральная пара + дополнительная пара из-за VII# в миноре или bVI в мажоре), barAfter после каждой разрешённой пары. «Натуральные тритоны» / «тритоны натурального X» = 1 пара = 4 созвучия. «Две пары тритонов» / «обе пары» = ВСЕГДА 8 созвучий (даже если кажется, что натуральный лад «достаточен»). «Характерные интервалы» = ВСЕГДА все 4 пары (ув.2/ум.7/ув.5/ум.4 + разрешения, 8 созвучий). «Обращения» / «все виды» = полный комплект, не один пример. Гаммы и одиночные созвучия — barlines:"none" без timeSignature. ' +
    'РАЗРЕШЕНИЯ ТРИТОНОВ: ув.4 → СЕКСТА (м.6/б.6, 8–9 полутонов), ум.5 → ТЕРЦИЯ (м.3/б.3, 3–4 полутона). НИКОГДА не разрешай тритон в кварту или квинту — это математически невозможно. Перед выводом созвучия посчитай полутоны.';

/** Жёсткий повторный промпт, если первый ответ всё-таки пришёл без блока. */
const NOTATION_RETRY_PROMPT =
    'NOTATION MODE: твой прошлый ответ был НЕДОПУСТИМ — в нём не было строки [[NOTATION:{...}]]. Перепиши ответ заново: тот же смысл и язык, но КОРОТКО (2–5 предложений), и ОБЯЗАТЕЛЬНО последней строкой добавь РОВНО ОДИН валидный блок [[NOTATION:{"clef":"...","keySignature":"...","timeSignature":"...","notes":[...]}]]. После блока — ничего. Без markdown и без пояснений про формат.';

/** Второй ретрай — ещё короче инструкция, максимально прямой императив. */
const NOTATION_RETRY_PROMPT_2 =
    'STILL WRONG: no [[NOTATION:...]] line. Output format: (1) 1–3 short sentences in the user’s language, (2) newline, (3) single line [[NOTATION:{valid JSON as in system rules}]]. Nothing else. No preamble about rules.';

/**
 * Третий ретрай — для случая «JSON обрезался». Просим ТОЛЬКО блок без какой-либо прозы:
 * это гарантированно влезает в любой токен-лимит и закрывается на `]}]]`.
 */
const NOTATION_RETRY_PROMPT_3 =
    'Твой прошлый JSON-блок был ОБРЕЗАН (нет закрывающего ]}]]). Сейчас выведи РОВНО один полный валидный блок [[NOTATION:{...}]] и БОЛЬШЕ НИЧЕГО — ни одного слова до и после, никакого markdown, никаких пояснений. Закрой блок последовательностью ]}]] на той же строке.';

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
    const lang = localStorage.getItem('solfai_lang') || 'en';
    showToast(lang === 'ru' ? 'У вас 0 запросов' : 'You have 0 requests', 'error', { dedupeKey: 'no-requests', dismissOnClick: true });
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
            const arrow = document.getElementById('langArrow');
            if(arrow && dropdown.id === 'langDropdown') arrow.style.transform = 'rotate(0deg)';
        });
    });

    const langSubmenuPage = document.getElementById('langSubmenu');
    const langMenuBtnPage = document.getElementById('langMenuBtn');
    if (langSubmenuPage?.classList.contains('active')) {
        const keep =
            exceptElement &&
            (langSubmenuPage.contains(exceptElement) || langMenuBtnPage?.contains(exceptElement));
        if (!keep) {
            langSubmenuPage.classList.remove('active');
            langMenuBtnPage?.classList.remove('active');
        }
    }

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

function openModal(modalId) {
    closeAllOverlays();
    document.querySelectorAll('.login-modal, .limit-modal, .name-modal, .tool-modal, .quiz-modal').forEach(m => m.classList.remove('active'));
    document.getElementById(modalId)?.classList.add('active');
}

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
            fetch(`${WORKER_URL}/delete-chat`, {
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
    const msg = localStorage.getItem('solfai_lang') === 'ru' ? 'Удалить этот чат?' : 'Are you sure you want to delete this chat?';
    if(confirm(msg)) {
        chats = chats.filter(c => c.id !== id);
        saveChatToStorage();
        
        // НОВОЕ: Отправляем запрос на удаление из БД
        if (currentUser) {
            fetch(`${WORKER_URL}/delete-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, user_id: currentUser.id })
            }).catch(err => console.error("Ошибка удаления чата из БД:", err));
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
        
        const olderLabel = (typeof solfaiGetText === 'function' ? solfaiGetText('olderChatsGroup') : '').replace(/\{n\}/g, String(olderChats.length)) || `💬 Older chats (${olderChats.length})`;
        html += `
        <div class="chats-group-header ${groupOpen ? 'open' : ''}" onclick="toggleChatGroup(event)" style="display:flex; justify-content:space-between; align-items:center; cursor:pointer; padding: 14px 10px; color: var(--text-secondary); font-size: 13px; font-weight: 600; border-radius: 8px; margin-top: 5px; transition: background 0.2s;">
            <span>${olderLabel}</span>
            <span class="group-arrow" style="transition: transform 0.3s; font-size: 10px; ${groupOpen ? 'transform: rotate(180deg);' : ''}">▼</span>
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

    const colorBtn = document.getElementById('colorBtn');
    const colorDropdown = document.getElementById('colorDropdown');
    const colorArrow = document.getElementById('colorArrow');
    if (colorBtn && colorDropdown) {
        colorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isActive = colorDropdown.classList.contains('active');
            closeAllOverlays(colorBtn);
            if (isActive) {
                colorDropdown.classList.remove('active');
                if (colorArrow) colorArrow.style.transform = 'rotate(0deg)';
            } else {
                colorDropdown.classList.add('active');
                if (colorArrow) colorArrow.style.transform = 'rotate(180deg)';
            }
        });
    }

    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setColor(btn.dataset.color);
        });
    });

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
    currentPlan = getStoredPlan();
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
    if (!data.timestamp || (Date.now() - data.timestamp) > 12 * 60 * 60 * 1000) return { timestamp: Date.now(), count: 0 };
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
    document.querySelectorAll('#chatRequestsCount').forEach(el => el.textContent = (limit === Infinity) ? '∞' : remaining);
    document.querySelectorAll('#chatRequestsCounter').forEach(c => {
        c.classList.remove('warning', 'exhausted');
        if (limit !== Infinity) { if (remaining === 0) c.classList.add('exhausted'); else if (remaining === 1) c.classList.add('warning'); }
    });
    // Новый компактный бейдж в шапке сайдбара: "молния X/Y" (запросы / картинки).
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
                try { ensureGoogleSignInLoaded?.(); openModal?.('loginModal'); } catch (_) {}
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
        titleParts.push(`Requests: ${(reqLimit === Infinity) ? '∞' : `${reqRemain}/${reqLimit}`}`);
        if (imgLimit > 0) titleParts.push(`Images: ${(imgLimit === Infinity) ? '∞' : `${imgRemain}/${imgLimit}`}`);
        badge.title = titleParts.join(' · ');
    } else {
        badge.removeAttribute('href');
        badge.setAttribute('tabindex', '-1');
        badge.title = 'Войдите в аккаунт, чтобы изменить тариф';
    }
}

function getImageUsageKey() { return `solfai_img_${currentUser?.id || 'guest'}`; }
function getImageUsageData() {
    const data = JSON.parse(localStorage.getItem(getImageUsageKey()) || '{}');
    if (!data.timestamp || (Date.now() - data.timestamp) > 24 * 60 * 60 * 1000) return { timestamp: Date.now(), count: 0 };
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

function updateLimitTimer() {
    const timerEl = document.getElementById('limitTimer');
    if (!timerEl) return;
    const data = JSON.parse(localStorage.getItem(getUsageKey()) || '{}');
    if (data.timestamp) {
        const remaining = (12 * 60 * 60 * 1000) - (Date.now() - data.timestamp);
        timerEl.textContent = remaining > 0 ? `Reset in: ${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m` : `Reset in: 0h`;
    } else timerEl.textContent = `Reset in: 12h`;
}
function updateImageLimitTimer() {
    const timerEl = document.getElementById('imageLimitTimer');
    if (!timerEl) return;
    const data = JSON.parse(localStorage.getItem(getImageUsageKey()) || '{}');
    if (data.timestamp) {
        const remaining = (24 * 60 * 60 * 1000) - (Date.now() - data.timestamp);
        timerEl.textContent = remaining > 0 ? `Reset in: ${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m` : `Reset in: 0h`;
    } else timerEl.textContent = `Reset in: 24h`;
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
            fetch(`${WORKER_URL}/save-chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chatToSave)
            }).catch(err => console.error("Ошибка сохранения чата в БД:", err));
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
    chat.messages.forEach(msg => addMessageToUI(msg.role, msg.content, msg.attachments, false, msg.id));
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
        html = html.replace(/(?:<br>\s*)*\u0001SOLF_NOT_TRUNC\u0001(?:\s*<br>)*/g,
            '<div class="notation-error">⚠️ Нотный пример не догрузился (ответ оборвался). Попробуйте переспросить.</div>');
    }

    return html;
}

/** Render every `.solf-notation[data-notation]` inside `root` using VexFlow. */
function renderAllNotations(root) {
    if (!root || !root.querySelectorAll) return;
    const containers = root.querySelectorAll('.solf-notation[data-notation]:not([data-rendered])');
    console.log('[Solf.ai/render] containers found=', containers.length, 'VexFlow=', !!getVexFlowNamespace());
    if (!containers.length) return;

    // Если VexFlow ещё не догрузился — пробуем чуть позже (CDN, deferred script)
    if (!getVexFlowNamespace()) {
        if (renderAllNotations._retries == null) renderAllNotations._retries = 0;
        if (renderAllNotations._retries < 25) {
            renderAllNotations._retries++;
            setTimeout(() => renderAllNotations(root), 150);
        } else {
            containers.forEach(c => {
                c.innerHTML = '<div class="notation-error">⚠️ Music engine failed to load</div>';
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
            container.innerHTML = '<div class="notation-error">⚠️ Invalid notation data</div>';
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

function buildStaveNote(VF, clef, n) {
    const duration = String(n.duration || 'q').toLowerCase();
    const isRest = duration.includes('r');
    const keys = Array.isArray(n.keys) && n.keys.length ? n.keys : ['c/4'];
    const note = new VF.StaveNote({
        clef,
        keys: isRest ? [clef === 'bass' ? 'd/3' : 'b/4'] : keys,
        duration
    });
    if (!isRest) {
        keys.forEach((k, i) => {
            const m = String(k).match(/^[a-g]([#b]{1,2})\//i);
            if (!m || !m[1] || !VF.Accidental) return;
            const acc = new VF.Accidental(m[1]);
            // VexFlow 4+: addModifier(modifier, index). VexFlow 3.x: addAccidental(index, acc).
            // Иногда один из методов молча падает (try/catch ниже глотает ошибку), поэтому
            // пробуем оба варианта по очереди — какой-нибудь точно сработает.
            let ok = false;
            try { note.addModifier(acc, i); ok = true; } catch (_) {}
            if (!ok) {
                try { note.addModifier(acc); ok = true; } catch (_) {}
            }
            if (!ok && typeof note.addAccidental === 'function') {
                try { note.addAccidental(i, acc); } catch (_) {}
            }
        });
    }

    // Подпись над нотой/аккордом (например "T5/3", "D7", "D6/5"). Безопасно: если
    // VF.Annotation недоступна или API упал — нота просто отрисуется без подписи.
    // Чтобы откатить эту фичу — удалить ВЕСЬ блок ниже до `return note;`.
    if (n && typeof n.label === 'string' && n.label && VF.Annotation) {
        try {
            const ann = new VF.Annotation(n.label);
            if (typeof ann.setFont === 'function') {
                try { ann.setFont('Arial', 11, 'normal'); } catch (_) {
                    try { ann.setFont('Arial', 11); } catch (__) {}
                }
            }
            // Поставить аннотацию НАД нотным станом (если API доступен).
            const VJ = VF.Annotation && VF.Annotation.VerticalJustify;
            const VJ2 = VF.AnnotationVerticalJustify;
            const top = (VJ && VJ.TOP) ?? (VJ2 && VJ2.TOP) ?? 1;
            if (typeof ann.setVerticalJustification === 'function') {
                try { ann.setVerticalJustification(top); } catch (_) {}
            }
            let ok = false;
            try { note.addModifier(ann, 0); ok = true; } catch (_) {}
            if (!ok) {
                try { note.addModifier(ann); ok = true; } catch (_) {}
            }
            if (!ok && typeof note.addAnnotation === 'function') {
                try { note.addAnnotation(0, ann); } catch (_) {}
            }
        } catch (_) { /* swallow — рендеринг ноты важнее подписи */ }
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
        container.innerHTML = '<div class="notation-error">⚠️ Music engine not loaded</div>';
        return;
    }
    container.innerHTML = '';

    try {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        const noteColor = isLight ? '#1a1a2e' : '#e6e6f0';

        // Авто-подписи: проставляем label каждому интервалу/аккорду, у которого его ещё нет
        // (например, блок сгенерировала сама модель). Готовые подписи не трогаем.
        if (window.SolfTheory && typeof window.SolfTheory.autoLabelNotation === 'function') {
            try { window.SolfTheory.autoLabelNotation(data); } catch (_) {}
        }

        const clef = (data.clef === 'bass') ? 'bass' : 'treble';
        const keySig = typeof data.keySignature === 'string' ? data.keySignature : 'C';
        const rawTimeSig = typeof data.timeSignature === 'string' ? data.timeSignature.trim() : '4/4';
        const rawNotes = Array.isArray(data.notes) ? data.notes : [];

        const barlinesMode = (['none', 'manual', 'auto'].includes(data.barlines)) ? data.barlines : 'auto';
        const timeSigHidden = !rawTimeSig || rawTimeSig === 'none' || barlinesMode !== 'auto';
        const timeSig = timeSigHidden ? '4/4' : rawTimeSig;

        const tsParts = timeSig.split('/');
        const numBeats = Math.max(parseInt(tsParts[0], 10) || 4, 1);
        const beatValue = Math.max(parseInt(tsParts[1], 10) || 4, 1);

        const measures = groupNotesIntoSegments(rawNotes, barlinesMode, numBeats, beatValue);
        const barlineNone = getBarlineNoneType(VF);

        const containerW = container.clientWidth || container.parentElement?.clientWidth || 600;
        const maxW = Math.min(Math.max(containerW - 16, 280), 760);

        const FIRST_OVERHEAD = 100;
        const NEXT_OVERHEAD = 14;
        const PER_NOTE = 32;
        const MIN_MEASURE = 96;
        const measureBaseW = m => Math.max(MIN_MEASURE, m.length * PER_NOTE + 26);

        // Раскладка тактов по строкам с переносом
        const rows = [];
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

        const ROW_HEIGHT = 110;
        const TOP_PAD = 28; // увеличен с 14: оставляем место для подписей-аннотаций (T5/3, D7 и т.п.) над нотой
        const totalHeight = rows.length * ROW_HEIGHT + TOP_PAD + 14;
        const totalWidth = maxW + 16;

        const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
        renderer.resize(totalWidth, totalHeight);
        const ctx = renderer.getContext();
        if (typeof ctx.setFillStyle === 'function') ctx.setFillStyle(noteColor);
        if (typeof ctx.setStrokeStyle === 'function') ctx.setStrokeStyle(noteColor);

        rows.forEach((r, rowIdx) => {
            let x = 8;
            const y = TOP_PAD + rowIdx * ROW_HEIGHT;
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
                    const staveNotes = mm.notes.map(n => buildStaveNote(VF, clef, n));
                    const voiceBeats = barlinesMode === 'auto'
                        ? numBeats
                        : Math.max(
                            mm.notes.reduce((s, n) => s + noteDurationBeats(n.duration, beatValue), 0),
                            1e-3
                        );
                    const voice = new VF.Voice({ num_beats: voiceBeats, beat_value: beatValue });
                    if (typeof voice.setStrict === 'function') voice.setStrict(false);
                    voice.addTickables(staveNotes);
                    const overhead = mm.isFirstOfRow ? FIRST_OVERHEAD : 30;
                    const formatWidth = Math.max(mm.width - overhead, 50);
                    new VF.Formatter().joinVoices([voice]).format([voice], formatWidth);
                    voice.draw(ctx, stave);
                }

                x += mm.width;
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
        container.innerHTML = `<div class="notation-error">⚠️ Could not render notation: ${err.message || err}</div>`;
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
        showToast('Copy failed', 'error');
    }
};

function showTypingIndicator() {
    const div = document.createElement('div'); div.className = 'message message-ai'; div.id = 'typingIndicator';
    div.innerHTML = `<div class="message-avatar"><svg class="svg-icon" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div><div class="message-content"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`;
    chatMessages.appendChild(div); scrollToBottom(true);
}

async function generateResponse(query, imageData = null) {
    // #region agent log
    __agentDebug.send({
        hypothesisId: 'C',
        location: 'app.js:generateResponse:start',
        message: 'generateResponse called',
        data: {
            hasQuery: Boolean(query && String(query).trim()),
            hasImage: Boolean(imageData),
            remainingRequests: getRemainingRequests(),
            remainingImages: getRemainingImages(),
            isGenerating
        }
    });
    // #endregion
    if (getRemainingRequests() <= 0) { showNoRequestsToast(); refreshSendButtonState(); return; }
    if (imageData && getRemainingImages() <= 0) { 
        refreshImageAttachVisibility();
        showImageLimitModal(); 
        attachedFiles = []; 
        if (typeof chatAttachedFiles !== 'undefined') chatAttachedFiles.innerHTML = ''; 
        return; 
    }
    if (isGenerating) return; 

    isGenerating = true; currentAbortController = new AbortController(); 
    chatSendBtn.disabled = false; chatSendBtn.classList.add('stop-btn');
    chatSendBtn.innerHTML = `<svg class="svg-icon" style="color:white;" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg>`;
    
    showTypingIndicator(); useRequest(); if(imageData) useImage();
    
    try {
        const messages = [{ role: 'system', content: getSystemInstruction() }];
        const chat = chats.find(c => c.id === currentChatId);
        
        if (chat) {
            // ИСКЛЮЧАЕМ самое последнее сообщение из истории (оно уже добавлено в UI, но мы передадим его ниже)
            // Это решает проблему ошибки API при первом сообщении
            const history = chat.messages.slice(-11, -1);
            history.forEach(msg => {
                // Если режим нотации сейчас ВЫКЛЮЧЕН — вырезаем [[NOTATION:...]]-блоки
                // из истории, чтобы модель не «зеркалила» формат и не вставляла ноты
                // в новый ответ. На сами сохранённые сообщения это не влияет.
                const content = notationModeEnabled
                    ? (msg.content || '')
                    : stripNotationBlocks(msg.content || '');
                messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content });
            });
        }
        
        // Базовое содержимое user-сообщения. При включённом режиме нотации — добавляем
        // невидимый ремайндер, который сильно повышает шанс, что модель не забудет блок.
        const baseUserContent = query || 'Analyze image';
        const apiUserContent = notationModeEnabled
            ? `${baseUserContent}${NOTATION_USER_REMINDER}`
            : baseUserContent;
        messages.push({ role: 'user', content: apiUserContent });

        const tokenBudget = notationModeEnabled ? 2048 : 1024;
        const payload = {
            messages,
            temperature: notationModeEnabled ? 0.45 : 0.7,
            max_tokens: tokenBudget,
            maxOutputTokens: tokenBudget,
            image: imageData ? {
                mime_type: imageData.match(/data:(.*?);/)?.[1] || 'image/jpeg',
                data: imageData.includes(',') ? imageData.split(',')[1] : imageData
            } : null
        };

        const res = await fetch(`${WORKER_URL}/generate`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload), 
            signal: currentAbortController.signal 
        });

        // #region agent log
        __agentDebug.send({
            hypothesisId: 'C',
            location: 'app.js:generateResponse:fetch',
            message: 'WORKER fetch resolved',
            data: { ok: res.ok, status: res.status, contentType: res.headers?.get?.('content-type') }
        });
        // #endregion

        const data = await res.json();
        if (!res.ok || data.error) {
            console.error("ПОЛНАЯ ОШИБКА ОТ СЕРВЕРА:", data);
            const detailedError = data.message || data.error?.message || JSON.stringify(data.gemini_error) || data.error || 'API Error';
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
        if (notationModeEnabled && typeof window !== 'undefined' && window.SolfTheory) {
            try {
                const det = window.SolfTheory.buildNotationForQuery(baseUserContent);
                console.log('[Solf.ai/theory] query=', JSON.stringify(baseUserContent),
                            'engine_result=', det ? 'OK' : 'NULL',
                            det && det.blockString ? '\nblock=' + det.blockString.slice(0, 220) + '...' : '');
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
                    const retryRes = await fetch(`${WORKER_URL}/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            messages: retryMessages,
                            temperature: notationRetryTemps[ri] ?? 0.15,
                            max_tokens: retryBudget,
                            maxOutputTokens: retryBudget,
                            image: null
                        }),
                        signal: currentAbortController.signal
                    });
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

        // Подставляем корректный нотный блок: заменяем блок модели на вычисленный нами
        // (или добавляем последней строкой, если модель блок не вывела вовсе).
        // Текст-объяснение модели при этом сохраняется — меняется только сам нотный блок.
        if (deterministicBlock) {
            try {
                const before = aiText.slice(-200);
                aiText = window.SolfTheory.applyBlock(aiText, deterministicBlock);
                console.log('[Solf.ai/apply] tail BEFORE=', before, '\ntail AFTER=', aiText.slice(-300));
            } catch (applyErr) {
                console.warn('[Solf.ai] Theory block apply skipped:', applyErr);
            }
        }

        document.getElementById('typingIndicator')?.remove();
        if (currentUser?.id) {
            try {
                const usageType = imageData ? 'image' : 'text';
                const usageRes = await fetchWithTimeout(`${WORKER_URL}/increment-usage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: currentUser.id, type: usageType })
                }, 12000);
                const usageData = await usageRes.json().catch(() => ({}));
                if (!usageRes.ok || usageData.error) {
                    throw new Error(usageData.error || 'Failed to increment usage');
                }

                // Источник истины — БД. localStorage `solfai_usage_*` / `solfai_img_*` для
                // залогиненных больше НЕ пишем (он только путал — см. migrateRemoveStaleUsageKeysOnce).
                if (Number.isFinite(Number(usageData.requests_count))) {
                    currentUser.requests_count = Number(usageData.requests_count);
                } else {
                    // Бэк не вернул значение (старая версия API?) — оставляем оптимистичный
                    // инкремент, который уже сделал useRequest(). Не делаем повторный +1.
                }

                if (imageData) {
                    if (Number.isFinite(Number(usageData.images_count))) {
                        currentUser.images_count = Number(usageData.images_count);
                    }
                    // ТОТ ЖЕ принцип: оптимистичный инкремент уже сделал useImage(),
                    // повторно не дублируем.
                }

                // Кэш `solfai_user` обновляем — он используется для восстановления при следующей
                // загрузке (чтобы UI не ждал syncAppData чтобы показать имя/аватарку).
                localStorage.setItem('solfai_user', JSON.stringify(currentUser));
                updateRequestsCounter();
                refreshImageAttachVisibility();
            } catch (usageError) {
                console.error('Ошибка обновления usage в БД:', usageError);
            }
        }
        chat.messages.push({ role: 'ai', content: aiText, time: new Date().toISOString(), id: Date.now().toString() }); 
        saveChatToStorage();
        await addMessageToUI('ai', aiText, [], true);
        
    } catch (e) {
        document.getElementById('typingIndicator')?.remove();
        // #region agent log
        __agentDebug.send({
            hypothesisId: 'C',
            location: 'app.js:generateResponse:catch',
            message: 'generateResponse error',
            data: { name: e?.name, message: e?.message }
        });
        // #endregion
        if (e.name === 'AbortError') {
            addMessageToUI('ai', '🛑 Stopped.', [], false); 
        } else {
            addMessageToUI('ai', '❌ Error: ' + e.message, [], false); 
        }
    } finally {
        isGenerating = false; currentAbortController = null;
        chatSendBtn.classList.remove('stop-btn');
        chatSendBtn.innerHTML = `<svg class="svg-icon" style="color: white;" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
        refreshSendButtonState();
    }
}
function showLoginPrompt() { document.getElementById('loginPromptModal').classList.add('active'); }
function hideLoginPrompt() { document.getElementById('loginPromptModal').classList.remove('active'); pendingQuery = null; }

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
    chatAttachedFiles.innerHTML = ''; chatInput.value = ''; chatInput.style.height = 'auto';
    const chat = chats.find(c => c.id === currentChatId);
    chat.messages.push({ role: 'user', content: query || 'Analyze', attachments: imageData ? [{ type: 'image/png', data: imageData }] : [], time: new Date().toISOString(), id: Date.now().toString() });
    saveChatToStorage();
    addMessageToUI('user', query || 'Analyze image', imageData ? [{ type: 'image/png', data: imageData }] : []);
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

// Ленивый загрузчик Google Sign-In скрипта.
//
// Раньше скрипт `accounts.google.com/gsi/client` стоял в <head> с async/defer и грузился
// при каждом открытии страницы. У пользователей без VPN запрос к accounts.google.com мог
// подвисать на 3-10 секунд (домен периодически режут провайдеры), и за счёт async это не
// блокировало парсинг, НО initGoogleAuth дёргал setTimeout каждые 500 мс пока скрипт не
// придёт — это держало event loop busy и тормозило UI.
//
// Теперь скрипт грузится только когда юзер реально открывает окно входа.
// Откат: вернуть `<script src="https://accounts.google.com/gsi/client" async defer>` в head
// и удалить функцию ниже + её вызовы в обработчиках login-кнопок.
function ensureGoogleSignInLoaded() {
    if (typeof google !== 'undefined' && google.accounts) return; // уже загружен
    if (window.__solfGsiLoading) return; // уже грузится
    window.__solfGsiLoading = true;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => { try { initGoogleAuth(); } catch (_) {} };
    s.onerror = () => {
        window.__solfGsiLoading = false;
        console.warn('[Solf.ai] Google Sign-In заблокирован — вход через Google недоступен, но остальной интерфейс работает.');
    };
    document.head.appendChild(s);
}

function initGoogleAuth() {
    // #region agent log
    __agentDebug.send({
        hypothesisId: 'B',
        location: 'app.js:initGoogleAuth',
        message: 'initGoogleAuth tick',
        data: { hasGoogle: typeof google !== 'undefined', hasAccounts: Boolean(globalThis?.google?.accounts) }
    });
    // #endregion
    if (typeof google === 'undefined' || !google.accounts) {
        // Скрипт gsi/client теперь грузится ЛЕНИВО (см. ensureGoogleSignInLoaded). Если его
        // ещё нет в DOM (никто не открывал login-модалку), просто ждём — НЕ дёргаем повторно
        // setTimeout бесконечно. Если скрипт не загружен И не подгружается — выходим тихо.
        if (!window.__solfGsiLoading) return;
        setTimeout(initGoogleAuth, 500);
        return;
    }
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: r => {
        // #region agent log
        __agentDebug.send({
            hypothesisId: 'B',
            location: 'app.js:initGoogleAuth:callback',
            message: 'google callback received',
            data: { hasCredential: Boolean(r?.credential), credParts: Array.isArray(r?.credential?.split?.('.')) ? r.credential.split('.').length : null }
        });
        // #endregion
        const payload = JSON.parse(atob(r.credential.split('.')[1]));
        currentUser = { id: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };

        localStorage.setItem('solfai_user', JSON.stringify(currentUser));
        syncUserWithDB(currentUser);

        loginModal.classList.remove('active');
        document.getElementById('loginPromptModal').classList.remove('active');
        updateUIForUser();

        if(pendingQuery){ proceedWithQuery(pendingQuery.query, pendingQuery.imageData); pendingQuery = null; }
    }});
    document.querySelectorAll('#googleSignInButton, #googleSignInButtonPrompt').forEach(b => google.accounts.id.renderButton(b, { theme: 'filled_blue', size: 'large', shape: 'pill' }));
}

function updateUIForUser() {
    // #region agent log
    const __requiredIds = ['profileMenuChat', 'profileImgChat', 'profileNameChat', 'profileFullNameChat', 'profileEmailChat', 'userAvatarSidebar', 'userNameSidebar'];
    __agentDebug.send({
        hypothesisId: 'A',
        location: 'app.js:updateUIForUser:entry',
        message: 'updateUIForUser called',
        data: {
            hasUser: Boolean(currentUser),
            missingRequired: __requiredIds.filter(id => !document.getElementById(id))
        }
    });
    // #endregion
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
        fetchWithTimeout(`${WORKER_URL}/get-chats?user_id=${currentUser.id}`, {}, 15000)
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
    currentUser = null;
    localStorage.removeItem('solfai_user');
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
        showToast('Пожалуйста, выберите изображение', 'error');
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
    document.getElementById('metronomePlayBtn').innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> <span>Stop</span>';
    playMetronomeTick(); metronomeInterval = setInterval(playMetronomeTick, 60000 / metronomeBpm);
}
function stopMetronome() {
    isMetronomePlaying = false; clearInterval(metronomeInterval);
    document.getElementById('metronomePlayBtn').innerHTML = '<svg class="svg-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> <span>Start</span>';
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
async function initApp() {
    // #region agent log
    __agentDebug.send({
        hypothesisId: 'A',
        location: 'app.js:initApp',
        message: 'initApp start',
        data: {
            readyState: document.readyState,
            hasChatInput: Boolean(chatInput),
            hasChatSendBtn: Boolean(chatSendBtn),
            hasChatMessages: Boolean(chatMessages),
            hasSidebar: Boolean(sidebar)
        }
    });
    // #endregion
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

    const landingAttachBtns = document.querySelectorAll('#landingAttachBtn');
    landingAttachBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (getRemainingImages() <= 0) {
                showImageLimitModal();
            } else {
                const lfi = document.getElementById('landingFileInput');
                if (lfi) lfi.click();
            }
        });
    });

    // Обработка скрытых инпутов
    if (chatFileInput) {
        chatFileInput.addEventListener('change', e => { 
            handleFileSelect(e.target.files, chatAttachedFiles); 
            // Задержка нужна, чтобы FileReader успел загрузить файл в память
            setTimeout(() => { e.target.value = ''; }, 100);
        });
    }

    const landingFileInput = document.getElementById('landingFileInput');
    if (landingFileInput) {
        landingFileInput.addEventListener('change', e => { 
            handleFileSelect(e.target.files, document.getElementById('landingAttachedFiles')); 
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
    
    if (chatInput) {
        chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'; refreshSendButtonState(); });
        chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isGenerating) sendChatMessage(); } });
    }
    
    if (chatSendBtn) chatSendBtn.addEventListener('click', () => { if (isGenerating) { abortGeneration(); } else sendChatMessage(); });
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
    
    document.getElementById('loginCloseBtn')?.addEventListener('click', () => loginModal.classList.remove('active'));
    document.getElementById('limitCloseBtn')?.addEventListener('click', () => limitModal.classList.remove('active'));
    document.getElementById('subscribeBtn')?.addEventListener('click', () => {
        window.location.href = 'pricing.html';
    });
    document.getElementById('imageLimitCloseBtn')?.addEventListener('click', () => document.getElementById('imageLimitModal').classList.remove('active'));
    document.getElementById('skipLoginBtn')?.addEventListener('click', hideLoginPrompt);
    document.getElementById('openLoginBtn')?.addEventListener('click', () => { ensureGoogleSignInLoaded(); openModal('loginModal'); });
    document.getElementById('sidebarLoginBtn')?.addEventListener('click', () => { ensureGoogleSignInLoaded(); openModal('loginModal'); });
    // Прямая ссылка на login-кнопку в шапке чата (chatHeaderLoginBtn) и в empty state —
    // они дёргают openModal('loginModal') через inline onclick. Подцепим там же.
    document.getElementById('chatHeaderLoginBtn')?.addEventListener('click', ensureGoogleSignInLoaded);
    
    document.getElementById('profileBtnChat')?.addEventListener('click', e => { 
        e.stopPropagation(); 
        const dropdown = document.getElementById('profileDropdownChat');
        const isActive = dropdown.classList.contains('active');
        closeAllOverlays();
        if (!isActive) dropdown.classList.add('active'); 
    });
    
    if (document.readyState === 'complete') initGoogleAuth(); else window.addEventListener('load', initGoogleAuth);
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
    
    const modals = document.querySelectorAll('.login-modal, .limit-modal, .name-modal, .quiz-modal, .tool-modal, .exit-modal-overlay');
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

// ===== COOKIE BANNER LOGIC =====
window.acceptCookies = function() {
    localStorage.setItem('solfai_cookies_accepted', 'true');
    const banner = document.getElementById('cookieBanner');
    if(banner) banner.style.display = 'none';
};

window.declineCookies = function() {
    localStorage.setItem('solfai_cookies_accepted', 'false');
    const banner = document.getElementById('cookieBanner');
    if(banner) banner.style.display = 'none';
};

// Проверка при загрузке
document.addEventListener('DOMContentLoaded', () => {
    const banner = document.getElementById('cookieBanner');
    
    if (!localStorage.getItem('solfai_cookies_accepted')) {
        if(banner) banner.style.display = 'flex';
    }
    
    document.getElementById('cookieAcceptBtn')?.addEventListener('click', window.acceptCookies);
    document.getElementById('cookieDeclineBtn')?.addEventListener('click', window.declineCookies);
});
// Закрытие сразу после выбора самого языка
document.querySelectorAll('.lang-option').forEach(option => {
    option.addEventListener('click', () => {
        document.getElementById('langSubmenu')?.classList.remove('active');
        document.getElementById('langMenuBtn')?.classList.remove('active');
    });
});

function abortGeneration() {
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