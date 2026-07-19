const SETTINGS_TEXT = {
    en: { title: 'Settings', app: 'Application', language: 'Language', theme: 'Theme', dark: 'Dark', light: 'Light', font: 'Font size', fontSm: 'Small', fontMd: 'Medium', fontLg: 'Large', accent: 'Accent color', about: 'About', pricing: 'Pricing', privacy: 'Privacy Policy', terms: 'Terms of Use', help: 'Help & Feedback', logout: 'Sign Out', guest: 'Guest' },
    ru: { title: 'Настройки', app: 'Приложение', language: 'Язык', theme: 'Внешний вид', dark: 'Тёмная', light: 'Светлая', font: 'Размер шрифта', fontSm: 'Маленький', fontMd: 'Средний', fontLg: 'Большой', accent: 'Цвет акцента', about: 'О программе', pricing: 'Тарифы', privacy: 'Политика конфиденциальности', terms: 'Условия пользования', help: 'Помощь и обратная связь', logout: 'Выйти', guest: 'Гость' },
    de: { title: 'Einstellungen', app: 'Anwendung', language: 'Sprache', theme: 'Design', dark: 'Dunkel', light: 'Hell', font: 'Schriftgröße', fontSm: 'Klein', fontMd: 'Mittel', fontLg: 'Groß', accent: 'Akzentfarbe', about: 'Über', pricing: 'Preise', privacy: 'Datenschutz', terms: 'Nutzungsbedingungen', help: 'Hilfe & Feedback', logout: 'Abmelden', guest: 'Gast' },
    es: { title: 'Ajustes', app: 'Aplicación', language: 'Idioma', theme: 'Tema', dark: 'Oscuro', light: 'Claro', font: 'Tamaño de fuente', fontSm: 'Pequeño', fontMd: 'Mediano', fontLg: 'Grande', accent: 'Color de acento', about: 'Acerca de', pricing: 'Precios', privacy: 'Política de Privacidad', terms: 'Términos de Uso', help: 'Ayuda y Soporte', logout: 'Cerrar Sesión', guest: 'Invitado' },
    zh: { title: '设置', app: '应用', language: '语言', theme: '主题', dark: '深色', light: '浅色', font: '字体大小', fontSm: '小', fontMd: '中', fontLg: '大', accent: '强调色', about: '关于', pricing: '定价', privacy: '隐私政策', terms: '使用条款', help: '帮助与反馈', logout: '退出登录', guest: '访客' },
    ja: { title: '設定', app: 'アプリ', language: '言語', theme: 'テーマ', dark: 'ダーク', light: 'ライト', font: '文字サイズ', fontSm: '小', fontMd: '中', fontLg: '大', accent: 'アクセントカラー', about: 'このアプリについて', pricing: '料金', privacy: 'プライバシーポリシー', terms: '利用規約', help: 'ヘルプとフィードバック', logout: 'サインアウト', guest: 'ゲスト' }
};

const LANG_LABELS = { en: 'EN English', ru: 'RU Русский', de: 'DE Deutsch', es: 'ES Español', zh: 'ZH 中文', ja: 'JA 日本語' };

let activePickerSetting = null;
let activePickerTrigger = null;

function getUiLang() { return localStorage.getItem('solfai_lang') || 'en'; }
function getUiTheme() { return localStorage.getItem('solfai_theme') || 'default'; }
function getUiFont() { return localStorage.getItem('solfai_font_size') || 'md'; }
function getTextPack() { return SETTINGS_TEXT[getUiLang()] || SETTINGS_TEXT.en; }

function applyTheme(theme) {
    localStorage.setItem('solfai_theme', theme);
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
}

function applyColor(color) {
    localStorage.setItem('solfai_color', color);
    if (color === 'default') document.documentElement.removeAttribute('data-color');
    else document.documentElement.setAttribute('data-color', color);
    document.querySelectorAll('.color-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.color === color));
}

function applyFontSize(size) {
    localStorage.setItem('solfai_font_size', size);
    document.documentElement.setAttribute('data-font-size', size || 'md');
}

function renderTexts() {
    const t = getTextPack();
    document.getElementById('settingsTitle').textContent = t.title;
    document.getElementById('settingsAppTitle').textContent = t.app;
    document.getElementById('languageLabel').textContent = t.language;
    document.getElementById('themeLabel').textContent = t.theme;
    document.getElementById('fontSizeLabel').textContent = t.font;
    document.getElementById('accentLabel').textContent = t.accent;
    document.getElementById('settingsAboutTitle').textContent = t.about;
    document.getElementById('pricingLabel') && (document.getElementById('pricingLabel').textContent = t.pricing);
    document.getElementById('privacyLabel').textContent = t.privacy;
    document.getElementById('termsLabel').textContent = t.terms;
    document.getElementById('helpLabel').textContent = t.help;
    document.getElementById('logoutLabel').textContent = t.logout;
}

function renderValueBadges() {
    const t = getTextPack();
    document.getElementById('settingsLanguageValue').textContent = LANG_LABELS[getUiLang()] || LANG_LABELS.en;
    document.getElementById('settingsThemeValue').textContent = getUiTheme() === 'light' ? t.light : t.dark;
    const fontValue = getUiFont();
    document.getElementById('settingsFontValue').textContent = fontValue === 'sm' ? t.fontSm : (fontValue === 'lg' ? t.fontLg : t.fontMd);
}

function getPickerOptions(setting) {
    const t = getTextPack();
    if (setting === 'lang') {
        return [
            { value: 'en', label: 'EN English' },
            { value: 'ru', label: 'RU Русский' },
            { value: 'de', label: 'DE Deutsch' },
            { value: 'es', label: 'ES Español' },
            { value: 'zh', label: 'ZH 中文' },
            { value: 'ja', label: 'JA 日本語' }
        ];
    }
    if (setting === 'theme') {
        return [
            { value: 'default', label: t.dark },
            { value: 'light', label: t.light }
        ];
    }
    return [
        { value: 'sm', label: t.fontSm },
        { value: 'md', label: t.fontMd },
        { value: 'lg', label: t.fontLg }
    ];
}

function getCurrentSettingValue(setting) {
    if (setting === 'lang') return getUiLang();
    if (setting === 'theme') return getUiTheme();
    return getUiFont();
}

function applySettingValue(setting, value) {
    if (setting === 'lang') localStorage.setItem('solfai_lang', value);
    if (setting === 'theme') applyTheme(value);
    if (setting === 'font') applyFontSize(value);
    renderTexts();
    renderValueBadges();
    renderUser();
}

function closePicker() {
    document.getElementById('settingsPickerOverlay').classList.remove('active');
    document.getElementById('settingsPicker').classList.remove('active');
    document.querySelectorAll('.settings-picker-trigger').forEach((btn) => btn.classList.remove('open'));
    activePickerSetting = null;
    activePickerTrigger = null;
}

function positionPicker(trigger) {
    const picker = document.getElementById('settingsPicker');
    const isMobile = window.innerWidth <= 768;
    if (isMobile) return;

    const rect = trigger.getBoundingClientRect();
    const pickerWidth = Math.min(340, window.innerWidth - 20);
    let left = rect.left;
    if (left + pickerWidth > window.innerWidth - 10) left = window.innerWidth - pickerWidth - 10;
    if (left < 10) left = 10;

    picker.style.left = `${left}px`;
    picker.style.top = `${rect.bottom + 8}px`;
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';
}

function openPicker(setting, trigger) {
    const picker = document.getElementById('settingsPicker');
    const optionsWrap = document.getElementById('settingsPickerOptions');
    const title = document.getElementById('settingsPickerTitle');
    const t = getTextPack();
    const titleMap = { lang: t.language, theme: t.theme, font: t.font };

    activePickerSetting = setting;
    activePickerTrigger = trigger;
    title.textContent = titleMap[setting] || t.title;
    const currentValue = getCurrentSettingValue(setting);
    const options = getPickerOptions(setting);

    optionsWrap.innerHTML = options.map((opt) => `
        <button class="settings-picker-option ${opt.value === currentValue ? 'active' : ''}" data-setting="${setting}" data-value="${opt.value}">
            <span>${opt.label}</span>
            <span class="settings-picker-check">✓</span>
        </button>
    `).join('');

    document.querySelectorAll('.settings-picker-trigger').forEach((btn) => btn.classList.remove('open'));
    trigger.classList.add('open');
    positionPicker(trigger);
    document.getElementById('settingsPickerOverlay').classList.add('active');
    picker.classList.add('active');
}

function renderUser() {
    const user = JSON.parse(localStorage.getItem('solfai_user') || 'null');
    const t = getTextPack();
    const avatar = document.getElementById('settingsAvatar');
    const userName = document.getElementById('settingsUserName');
    const logoutBtn = document.getElementById('settingsLogoutBtn');
    const planIconContainer = document.getElementById('settingsUserPlanIcon');

    if (user) {
        userName.textContent = user.name || t.guest;
        if (user.picture) {
            avatar.classList.remove('has-mark');
            avatar.innerHTML = `<img src="${user.picture}" alt="">`;
        } else {
            avatar.classList.add('has-mark');
            avatar.innerHTML = '<img class="settings-logo-mark" src="assets/logo-mark-128.png?v=8" srcset="assets/logo-mark-256.png?v=8 2x" alt="">';
        }
        logoutBtn.style.display = 'flex';

        const storageKey = `solfai_plan_${user.id}`;
        const planData = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (planData && planData.emoji) {
            planIconContainer.innerHTML = planData.emoji;
            planIconContainer.style.display = 'flex';
        } else {
            planIconContainer.innerHTML = '';
        }
    } else {
        userName.textContent = t.guest;
        avatar.classList.add('has-mark');
        avatar.innerHTML = '<img class="settings-logo-mark" src="assets/logo-mark-128.png?v=8" srcset="assets/logo-mark-256.png?v=8 2x" alt="">';
        logoutBtn.style.display = 'none';
        if(planIconContainer) planIconContainer.innerHTML = '';
    }
}

function bindSettingsPicker() {
    document.querySelectorAll('.settings-picker-trigger').forEach((trigger) => {
        trigger.addEventListener('click', () => {
            const setting = trigger.dataset.setting;
            if (activePickerSetting === setting) {
                closePicker();
                return;
            }
            openPicker(setting, trigger);
        });
    });

    document.getElementById('settingsPickerOptions').addEventListener('click', (e) => {
        const button = e.target.closest('.settings-picker-option');
        if (!button) return;
        applySettingValue(button.dataset.setting, button.dataset.value);
        closePicker();
    });

    document.getElementById('settingsPickerOverlay').addEventListener('click', closePicker);
    window.addEventListener('resize', () => {
        if (activePickerTrigger) positionPicker(activePickerTrigger);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closePicker();
    });
}

function initSettingsPage() {
    applyTheme(getUiTheme());
    applyColor(localStorage.getItem('solfai_color') || 'default');
    applyFontSize(getUiFont());
    renderTexts();
    renderValueBadges();
    renderUser();
    bindSettingsPicker();

    document.querySelectorAll('.color-btn').forEach((btn) => {
        btn.addEventListener('click', () => applyColor(btn.dataset.color));
    });

    document.getElementById('settingsBackBtn').addEventListener('click', () => {
        document.activeElement?.blur?.();
        sessionStorage.setItem('solfai_skip_focus_once', '1');
        window.location.href = 'index.html';
    });
    document.getElementById('settingsLogoutBtn').addEventListener('click', () => {
        if (typeof getSolfSessionToken === 'function' && getSolfSessionToken()) {
            fetch('https://solf-ai-api.mlemonw.workers.dev/auth/logout', {
                method: 'POST',
                headers: typeof solfAuthHeaders === 'function' ? solfAuthHeaders() : {},
            }).catch(() => {});
        }
        if (typeof clearSolfAuth === 'function') clearSolfAuth();
        localStorage.setItem('solfai_plan_guest', JSON.stringify({
            type: 'free',
            emoji: '<svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
            name: 'Free'
        }));
        document.activeElement?.blur?.();
        sessionStorage.setItem('solfai_skip_focus_once', '1');
        window.location.href = 'index.html';
    });
}

document.addEventListener('DOMContentLoaded', initSettingsPage);
