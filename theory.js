// ===== SOLF.AI — ДЕТЕРМИНИРОВАННЫЙ ТЕОРЕТИЧЕСКИЙ ДВИЖОК =====
// Строит МУЗЫКАЛЬНО ПРАВИЛЬНЫЕ ноты для заданий по сольфеджио/гармонии
// (тритоны, характерные интервалы, гаммы, трезвучия + обращения, D7).
//
// Зачем: нейросеть ненадёжно считает полутоны и буквенные написания.
// Здесь всё считается формулами, поэтому ноты ВСЕГДА корректны, а нотный
// блок [[NOTATION:...]] гарантированно присутствует в ответе.
//
// Экспортирует window.SolfTheory.buildNotationForQuery(query) -> { blockString } | null
//   и SolfTheory.applyBlock(aiText, blockString) -> aiText с подставленным блоком.

(function () {
    'use strict';

    // ---------- Базовая модель ноты ----------
    const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
    const LETTER_SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

    function letterIdx(L) { return LETTERS.indexOf(L); }
    function noteAbs(n) { return n.octave * 12 + LETTER_SEMI[n.letter] + n.acc; }
    function pc(n) { return ((noteAbs(n) % 12) + 12) % 12; }

    function accStr(acc) {
        if (acc === 0) return '';
        return acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc);
    }
    function noteKey(n) { return `${n.letter}${accStr(n.acc)}/${n.octave}`; }

    // ---------- Защита от «ненотируемых» звуков ----------
    // В нотной записи (и в VexFlow) у ноты максимум два знака. Третий знак —
    // признак того, что построение ушло в теоретическую тональность (fis### в
    // ля-диез мажоре) или требует энгармонической замены. Такие блоки не отдаём.
    const WRITABLE_KEY_RE = /^[a-g](##|#|bb|b)?\/-?\d+$/;

    function isWritableKey(k) { return WRITABLE_KEY_RE.test(String(k)); }

    function notesWritable(notes) {
        return Array.isArray(notes) && notes.every(n =>
            Array.isArray(n.keys) && n.keys.length && n.keys.every(isWritableKey)
        );
    }

    // Энгармонически равное написание того же звука с минимумом знаков
    // (си-дубль-бемоль -> ля). Направление знака сохраняем: диезы -> диезы.
    const SHARP_SPELLING = [['c', 0], ['c', 1], ['d', 0], ['d', 1], ['e', 0], ['f', 0], ['f', 1], ['g', 0], ['g', 1], ['a', 0], ['a', 1], ['b', 0]];
    const FLAT_SPELLING = [['c', 0], ['d', -1], ['d', 0], ['e', -1], ['e', 0], ['f', 0], ['g', -1], ['g', 0], ['a', -1], ['a', 0], ['b', -1], ['b', 0]];

    function spellFrom(table, n) {
        const abs = noteAbs(n);
        const [letter, acc] = table[((abs % 12) + 12) % 12];
        return { letter, acc, octave: Math.floor((abs - acc - LETTER_SEMI[letter]) / 12) };
    }

    function simplifyEnharmonic(n) {
        return spellFrom(n.acc < 0 ? FLAT_SPELLING : SHARP_SPELLING, n);
    }

    /**
     * Построение «от звука». Если написание требует третьего знака (ум7 от до-бемоль
     * дала бы си-четырежды-бемоль), повторяем построение от энгармонически равного
     * звука — звучание то же, а запись читаемая.
     */
    // ---------- Чистка нотных блоков, пришедших от нейросети ----------
    // Модель иногда пишет «h/4» (немецкое H), «C♯4» без слэша, тройные знаки или
    // дважды один и тот же звук в аккорде — VexFlow на этом либо падает, либо
    // рисует ноты друг на друге. Здесь всё это приводится к рабочему виду.
    const KEY_PARSE_RE = /^([a-g])\s*(#{1,4}|b{1,4}|n)?\s*\/?\s*(-?\d+)?$/;

    function repairKey(raw, defaultOctave) {
        let s = String(raw == null ? '' : raw).trim().toLowerCase()
            .replace(/[♯＃]/g, '#')
            .replace(/[♭]/g, 'b')
            .replace(/[♮]/g, 'n')
            .replace(/\s+/g, '')
            .replace(/^h/, 'b')       // немецкое H = си
            .replace(/^([a-g])x/, '$1##'); // x = дубль-диез
        const m = s.match(KEY_PARSE_RE);
        if (!m) return null;
        const letter = m[1];
        const accStr2 = m[2] || '';
        const acc = accStr2 === 'n' || accStr2 === '' ? 0
            : accStr2[0] === '#' ? accStr2.length : -accStr2.length;
        const octave = m[3] != null ? parseInt(m[3], 10) : (defaultOctave == null ? 4 : defaultOctave);
        if (!Number.isFinite(octave) || octave < 0 || octave > 9) return null;
        const note = { letter, acc, octave };
        return noteKey(Math.abs(acc) > 2 ? simplifyEnharmonic(note) : note);
    }

    function sanitizeNoteEntry(entry) {
        if (!entry || typeof entry !== 'object') return null;
        const duration = String(entry.duration || 'q').toLowerCase();
        const out = { ...entry, duration };
        if (out.label != null && typeof out.label !== 'string') out.label = String(out.label);

        // Пауза: ноты у неё всё равно не рисуются, портить блок из-за keys не будем.
        if (duration.includes('r')) {
            out.keys = ['b/4'];
            return out;
        }

        const seen = new Set();
        const keys = [];
        const raw = Array.isArray(entry.keys) ? entry.keys : [entry.keys];
        for (const k of raw) {
            const fixed = repairKey(k);
            if (!fixed || seen.has(fixed)) continue; // дубль звука = наслоение нотных головок
            seen.add(fixed);
            keys.push(fixed);
        }
        if (!keys.length) return null;
        keys.sort((a, b) => noteAbs(parseVexKey(a)) - noteAbs(parseVexKey(b)));
        out.keys = keys;
        return out;
    }

    /**
     * Единая точка чистки блока нотации перед рендером: написание нот, дубли звуков
     * в аккорде, ошибки альтерации (ув.2). Возвращает null, если после чистки рисовать
     * нечего — интерфейс тогда покажет ответ без нотного примера, а не сломанную картинку.
     */
    function sanitizeNotationData(data) {
        if (!data || typeof data !== 'object') return data;

        if (data.layout === 'satb' && Array.isArray(data.chords)) {
            const chords = data.chords.map(c => {
                if (!c || typeof c !== 'object') return null;
                const out = { ...c };
                let any = false;
                for (const voice of ['soprano', 'alto', 'tenor', 'bass']) {
                    if (out[voice] == null) continue;
                    const fixed = repairKey(out[voice], voice === 'tenor' || voice === 'bass' ? 3 : 4);
                    if (fixed) { out[voice] = fixed; any = true; } else { delete out[voice]; }
                }
                return any ? out : null;
            }).filter(Boolean);
            if (!chords.length) return null;
            data.chords = chords;
            return data;
        }

        if (!Array.isArray(data.notes)) return null;
        const notes = data.notes.map(sanitizeNoteEntry).filter(Boolean);
        if (!notes.length) return null;
        return fixAugmentedSeconds({ ...data, notes });
    }

    function fromNoteWithFallback(note, build) {
        const direct = build(note);
        if (direct) return direct;
        const base = { ...note, octave: note.octave || 4 };
        const first = simplifyEnharmonic(base);
        const second = spellFrom(first.acc < 0 ? SHARP_SPELLING : FLAT_SPELLING, base);
        for (const alt of [first, second]) {
            if (alt.letter === note.letter && alt.acc === note.acc) continue;
            const built = build(alt);
            if (built) return built;
        }
        return null;
    }

    /**
     * Строит ноту на `degree` ступеней (1=прима … 8=октава) и `semitones` полутонов
     * ВВЕРХ от base, СОХРАНЯЯ буквенный «скелет» (не подменяя f# на gb и т.п.).
     */
    function buildIntervalUp(base, degree, semitones) {
        const steps = degree - 1;
        const rawIdx = letterIdx(base.letter) + steps;
        const octave = base.octave + Math.floor(rawIdx / 7);
        const letter = LETTERS[((rawIdx % 7) + 7) % 7];
        const naturalAbs = octave * 12 + LETTER_SEMI[letter];
        const acc = (noteAbs(base) + semitones) - naturalAbs;
        return { letter, acc, octave };
    }

    const SCALE_FORMULAS = {
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10],
        harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
        melodicMinor: [0, 2, 3, 5, 7, 9, 11],
        harmonicMajor: [0, 2, 4, 5, 7, 8, 11]
    };

    /** 7 ступеней натуральной гаммы в октаве 4 (ascending), верное написание. */
    function buildScale(tonic, mode) {
        const formula = mode === 'major' ? SCALE_FORMULAS.major : SCALE_FORMULAS.minor;
        const out = [];
        for (let i = 0; i < 7; i++) out.push(buildIntervalUp(tonic, i + 1, formula[i]));
        return out;
    }

    /** Тоническое трезвучие (для определения устоев I/III/V). */
    function tonicTriad(tonic, mode) {
        return [
            { ...tonic },
            buildIntervalUp(tonic, 3, mode === 'major' ? 4 : 3),
            buildIntervalUp(tonic, 5, 7)
        ];
    }

    function isStable(note, triad) {
        const p = pc(note);
        return triad.some(t => pc(t) === p);
    }

    /**
     * Разрешение одной ноты интервала: устой остаётся на месте, неустой движется
     * на ШАГ в направлении dir (+1 вверх / -1 вниз) к ближайшему устою (I/III/V).
     */
    function resolveNote(note, dir, triad) {
        if (isStable(note, triad)) return { ...note };
        const nIdx = ((letterIdx(note.letter) + dir) % 7 + 7) % 7;
        const member = triad.find(t => letterIdx(t.letter) === nIdx);
        if (!member) return { ...note };
        const target = { letter: member.letter, acc: member.acc, octave: note.octave };
        if (dir > 0) { while (noteAbs(target) <= noteAbs(note)) target.octave++; }
        else { while (noteAbs(target) >= noteAbs(note)) target.octave--; }
        return target;
    }

    /**
     * Разрешение двузвучия. quality: 'aug' (увеличенный → РАСХОДИТСЯ наружу),
     * 'dim' (уменьшенный → СХОДИТСЯ внутрь).
     */
    function resolveInterval(lower, upper, quality, triad) {
        const loDir = quality === 'aug' ? -1 : 1;
        const upDir = quality === 'aug' ? 1 : -1;
        return [resolveNote(lower, loDir, triad), resolveNote(upper, upDir, triad)];
    }

    // ---------- Валидация (страховка от собственных ошибок) ----------
    function intervalDegree(lo, hi) {
        return (letterIdx(hi.letter) + 7 * hi.octave) - (letterIdx(lo.letter) + 7 * lo.octave) + 1;
    }
    function intervalSemis(lo, hi) { return noteAbs(hi) - noteAbs(lo); }
    function checkInterval(lo, hi, degree, semis) {
        return intervalDegree(lo, hi) === degree && intervalSemis(lo, hi) === semis;
    }

    function isAug2Label(label) {
        return /ув\.?\s*2|aug\.?\s*2|\bA2\b|bVI[\s\-–—]*VII/i.test(String(label || ''));
    }

    /** Исправляет частую ошибку модели: D♭–E♭ (б2) вместо D♭–E (ув.2) в гарм. мажоре. */
    function tryFixAugmentedSecond(lo, hi) {
        if (intervalDegree(lo, hi) !== 2) return null;
        if (intervalSemis(lo, hi) === 3) return [lo, hi];
        if (intervalSemis(lo, hi) !== 2) return null;
        const variants = [
            [lo, { ...hi, acc: hi.acc + 1 }],
            [{ ...lo, acc: lo.acc - 1 }, hi],
        ];
        for (const [a, b] of variants) {
            if (intervalSemis(a, b) === 3) return [a, b];
        }
        return null;
    }

    /** Подчищает типичные ошибки альтераций в AI-блоках перед рендером. */
    function fixAugmentedSeconds(data) {
        if (!data || !Array.isArray(data.notes)) return data;
        const notes = data.notes.map(n => {
            if (!Array.isArray(n.keys) || n.keys.length !== 2) return n;
            const lo = parseVexKey(n.keys[0]);
            const hi = parseVexKey(n.keys[1]);
            if (!lo || !hi) return n;
            const shouldFix = isAug2Label(n.label)
                || (intervalDegree(lo, hi) === 2 && intervalSemis(lo, hi) === 2 && lo.acc < 0 && hi.acc < 0);
            if (!shouldFix) return n;
            const fixed = tryFixAugmentedSecond(lo, hi);
            if (!fixed) return n;
            return { ...n, keys: [noteKey(fixed[0]), noteKey(fixed[1])] };
        });
        return { ...data, notes };
    }

    function chord(lo, hi, barAfter, label) {
        const c = { keys: [noteKey(lo), noteKey(hi)], duration: 'h' };
        if (barAfter) c.barAfter = true;
        if (label) c.label = label;
        return c;
    }

    // Качественное имя интервала по ступеневой величине + количеству полутонов.
    const INTERVAL_QUALITY_RU = {
        1: { 0: 'ч1', 1: 'Ув1' },
        2: { 0: 'Ум2', 1: 'м2', 2: 'б2', 3: 'Ув2' },
        3: { 2: 'Ум3', 3: 'м3', 4: 'б3', 5: 'Ув3' },
        4: { 4: 'Ум4', 5: 'ч4', 6: 'Ув4' },
        5: { 6: 'Ум5', 7: 'ч5', 8: 'Ув5' },
        6: { 7: 'Ум6', 8: 'м6', 9: 'б6', 10: 'Ув6' },
        7: { 9: 'Ум7', 10: 'м7', 11: 'б7', 12: 'Ув7' },
        8: { 11: 'Ум8', 12: 'ч8', 13: 'Ув8' }
    };
    const INTERVAL_QUALITY_EN = {
        1: { 0: 'P1', 1: 'A1' },
        2: { 0: 'd2', 1: 'm2', 2: 'M2', 3: 'A2' },
        3: { 2: 'd3', 3: 'm3', 4: 'M3', 5: 'A3' },
        4: { 4: 'd4', 5: 'P4', 6: 'A4' },
        5: { 6: 'd5', 7: 'P5', 8: 'A5' },
        6: { 7: 'd6', 8: 'm6', 9: 'M6', 10: 'A6' },
        7: { 9: 'd7', 10: 'm7', 11: 'M7', 12: 'A7' },
        8: { 11: 'd8', 12: 'P8', 13: 'A8' }
    };
    let labelLocale = 'en';
    function setLabelLocale(lang) {
        labelLocale = lang === 'ru' ? 'ru' : 'en';
    }
    function intervalQualityTable() {
        return labelLocale === 'ru' ? INTERVAL_QUALITY_RU : INTERVAL_QUALITY_EN;
    }
    function intervalLabel(lo, hi) {
        const deg = intervalDegree(lo, hi);
        const sem = intervalSemis(lo, hi);
        const table = intervalQualityTable();
        return (table[deg] && table[deg][sem]) || '';
    }

    // ---------- Авто-подписи ЛЮБОГО созвучия (интервал / трезвучие / септаккорд) ----------
    // Используется для блоков, которые пришли от нейросети (движок их не строил), чтобы
    // на каждой ноте всё равно была подпись. Готовые подписи (от движка/модели) не трогаем.

    function parseVexKey(k) {
        const m = String(k).trim().match(/^([a-gA-G])(##|#|bb|b|n)?\/(-?\d+)$/);
        if (!m) return null;
        const letter = m[1].toLowerCase();
        let acc = 0;
        const a = m[2];
        if (a === '#') acc = 1; else if (a === '##') acc = 2;
        else if (a === 'b') acc = -1; else if (a === 'bb') acc = -2;
        return { letter, acc, octave: parseInt(m[3], 10) };
    }

    function samePc(a, b) { return pc(a) === pc(b); }
    function semiUp(root, n) { return (((pc(n) - pc(root)) % 12) + 12) % 12; }

    // Только chord-тоны (по одному на букву), чтобы октавные удвоения не мешали.
    function distinctByLetter(notes) {
        const seen = new Map();
        for (const n of notes) if (!seen.has(n.letter)) seen.set(n.letter, n);
        return [...seen.values()];
    }

    // Качество трезвучия по полутонам от примы до терции/квинты.
    const TRIAD_QUALITY_RU = { '4,7': 'Б', '3,7': 'М', '3,6': 'Ум', '4,8': 'Ув' };
    const TRIAD_QUALITY_EN = { '4,7': 'M', '3,7': 'm', '3,6': 'd', '4,8': 'A' };
    function classifyTriad(tones, bass) {
        const qualityMap = labelLocale === 'ru' ? TRIAD_QUALITY_RU : TRIAD_QUALITY_EN;
        for (const root of tones) {
            const ti = (letterIdx(root.letter) + 2) % 7;
            const fi = (letterIdx(root.letter) + 4) % 7;
            const third = tones.find(n => letterIdx(n.letter) === ti);
            const fifth = tones.find(n => letterIdx(n.letter) === fi);
            if (!third || !fifth) continue;
            const q = qualityMap[`${semiUp(root, third)},${semiUp(root, fifth)}`];
            if (!q) continue;
            const fig = samePc(bass, root) ? '53' : samePc(bass, third) ? '6' : '64';
            return q + fig;
        }
        return '';
    }

    const SEVENTH_TYPE_RU = { '4,7,10': 'D', '3,6,9': 'Ум', '3,6,10': 'Ум', '4,7,11': 'Б', '3,7,10': 'М' };
    const SEVENTH_TYPE_EN = { '4,7,10': 'D', '3,6,9': 'd', '3,6,10': 'd', '4,7,11': 'M', '3,7,10': 'm' };
    function classifySeventh(tones, bass) {
        const typeMap = labelLocale === 'ru' ? SEVENTH_TYPE_RU : SEVENTH_TYPE_EN;
        for (const root of tones) {
            const ti = (letterIdx(root.letter) + 2) % 7;
            const fi = (letterIdx(root.letter) + 4) % 7;
            const si = (letterIdx(root.letter) + 6) % 7;
            const third = tones.find(n => letterIdx(n.letter) === ti);
            const fifth = tones.find(n => letterIdx(n.letter) === fi);
            const seventh = tones.find(n => letterIdx(n.letter) === si);
            if (!third || !fifth || !seventh) continue;
            const sig = `${semiUp(root, third)},${semiUp(root, fifth)},${semiUp(root, seventh)}`;
            const q = typeMap[sig];
            if (!q) continue;
            const fig = samePc(bass, root) ? '7' : samePc(bass, third) ? '65' : samePc(bass, fifth) ? '43' : '2';
            return q + fig;
        }
        return '';
    }

    function describeKeys(keys) {
        const notes = (Array.isArray(keys) ? keys : []).map(parseVexKey).filter(Boolean);
        if (notes.length < 2) return '';
        notes.sort((a, b) => noteAbs(a) - noteAbs(b));
        const bass = notes[0];
        if (notes.length === 2) return intervalLabel(notes[0], notes[1]);
        const tones = distinctByLetter(notes);
        if (tones.length === 3) return classifyTriad(tones, bass);
        if (tones.length >= 4) return classifySeventh(tones, bass);
        return '';
    }

    /**
     * Проставляет подпись (label) каждой ноте/созвучию, у которой её ещё нет.
     * Мутирует и возвращает тот же объект data. Паузы и одиночные ноты пропускаем.
     */
    function autoLabelNotation(data) {
        if (!data || !Array.isArray(data.notes)) return data;
        for (const n of data.notes) {
            if (!n || typeof n !== 'object') continue;
            if (typeof n.label === 'string' && n.label) continue; // уже подписано — не трогаем
            if (String(n.duration || '').toLowerCase().includes('r')) continue; // паузы
            const lbl = describeKeys(n.keys);
            if (lbl) n.label = lbl;
        }
        return data;
    }

    // ---------- Тритоны (ув.4 + ум.5) ----------
    /** Находит пары «кварта-тритон» (буквы на расстоянии 4-й ступени, 6 полутонов). */
    function findTritonePairs(scaleNotes) {
        const pairs = [];
        const seen = new Set();
        for (const lo of scaleNotes) {
            const upper = buildIntervalUp({ ...lo, octave: 4 }, 4, 6); // ув.4
            const match = scaleNotes.find(n => n.letter === upper.letter && n.acc === upper.acc);
            if (match) {
                const key = `${lo.letter}${lo.acc}-${upper.letter}${upper.acc}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    pairs.push({ la: { letter: lo.letter, acc: lo.acc }, lb: { letter: upper.letter, acc: upper.acc } });
                }
            }
        }
        return pairs;
    }

    function buildTritones(tonic, mode, form) {
        // form: 'natural' | 'harmonic'. default уже разрешён вызывающим кодом.
        const natural = buildScale(tonic, mode);
        let scaleForSearch = natural;
        if (form === 'harmonic') {
            scaleForSearch = natural.map(n => ({ ...n }));
            if (mode === 'minor') scaleForSearch[6].acc += 1;   // VII#
            else scaleForSearch[5].acc -= 1;                    // bVI
        }
        const pairs = findTritonePairs(scaleForSearch);
        if (!pairs.length) return null;

        const triad = tonicTriad(tonic, mode);
        const notes = [];
        pairs.forEach(p => {
            // ув.4: la -> кварта вверх
            const uv4lo = { letter: p.la.letter, acc: p.la.acc, octave: 4 };
            const uv4hi = buildIntervalUp(uv4lo, 4, 6);
            if (!checkInterval(uv4lo, uv4hi, 4, 6)) return;
            const r1 = resolveInterval(uv4lo, uv4hi, 'aug', triad);
            notes.push(chord(uv4lo, uv4hi, false, labelLocale === 'ru' ? 'Ув4' : 'A4'));
            notes.push(chord(r1[0], r1[1], true, intervalLabel(r1[0], r1[1])));

            // ум.5: lb -> квинта вверх
            const um5lo = { letter: p.lb.letter, acc: p.lb.acc, octave: 4 };
            const um5hi = buildIntervalUp(um5lo, 5, 6);
            if (!checkInterval(um5lo, um5hi, 5, 6)) return;
            const r2 = resolveInterval(um5lo, um5hi, 'dim', triad);
            notes.push(chord(um5lo, um5hi, false, labelLocale === 'ru' ? 'Ум5' : 'd5'));
            notes.push(chord(r2[0], r2[1], true, intervalLabel(r2[0], r2[1])));
        });
        if (notes.length < 4) return null;
        // последний barAfter не нужен (хвостовая черта)
        if (notes.length) delete notes[notes.length - 1].barAfter;

        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            barlines: 'manual',
            notes
        };
    }

    // ---------- Характерные интервалы (ув.2, ум.7, ув.5, ум.4) ----------
    function buildCharacteristic(tonic, mode) {
        const natural = buildScale(tonic, mode);
        const III = { ...natural[2] };
        const triad = tonicTriad(tonic, mode);
        const notes = [];

        const add = (lo, hi, quality, degree, semis) => {
            if (!checkInterval(lo, hi, degree, semis)) return false;
            const r = resolveInterval(lo, hi, quality, triad);
            notes.push(chord(lo, hi, false, intervalLabel(lo, hi)));
            notes.push(chord(r[0], r[1], true, intervalLabel(r[0], r[1])));
            return true;
        };

        if (mode === 'minor') {
            const VI = { ...natural[5], octave: 4 };
            const altVII = { ...natural[6], acc: natural[6].acc + 1, octave: 4 };
            // ув.2: VI -> VII#  (3 полутона, секунда)
            add(VI, buildIntervalUp(VI, 2, 3), 'aug', 2, 3);
            // ум.7: VII# -> VI(окт.)  (9 полутонов, септима)
            add({ ...altVII }, buildIntervalUp(altVII, 7, 9), 'dim', 7, 9);
            // ув.5: III -> VII#  (8 полутонов, квинта)
            add({ ...III, octave: 4 }, buildIntervalUp({ ...III, octave: 4 }, 5, 8), 'aug', 5, 8);
            // ум.4: VII# -> III(окт.)  (4 полутона, кварта)
            add({ ...altVII }, buildIntervalUp(altVII, 4, 4), 'dim', 4, 4);
        } else {
            const altVI = { ...natural[5], acc: natural[5].acc - 1, octave: 4 };
            const VII = { ...natural[6], octave: 4 };
            // ув.2: bVI -> VII
            add({ ...altVI }, buildIntervalUp(altVI, 2, 3), 'aug', 2, 3);
            // ум.7: VII -> bVI(окт.)
            add({ ...VII }, buildIntervalUp(VII, 7, 9), 'dim', 7, 9);
            // ув.5: bVI -> III(окт.)
            add({ ...altVI }, buildIntervalUp(altVI, 5, 8), 'aug', 5, 8);
            // ум.4: III -> bVI
            add({ ...III, octave: 4 }, buildIntervalUp({ ...III, octave: 4 }, 4, 4), 'dim', 4, 4);
        }

        if (notes.length < 8) return null; // должно быть 4 пары = 8 созвучий
        if (notes.length) delete notes[notes.length - 1].barAfter;

        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            barlines: 'manual',
            notes
        };
    }

    // ---------- Задания «как в учебнике / Калинина» ----------
    // Один характерный интервал, интервал на ступени, трезвuchие на ступени,
    // определение интервала/аккорда, обращение интервала с нотацией.

    const CHAR_KIND_DEFS = {
        aug2: { degree: 2, semis: 3, quality: 'aug', ru: 'ув.2', en: 'A2' },
        dim7: { degree: 7, semis: 9, quality: 'dim', ru: 'ум.7', en: 'd7' },
        aug5: { degree: 5, semis: 8, quality: 'aug', ru: 'ув.5', en: 'A5' },
        dim4: { degree: 4, semis: 4, quality: 'dim', ru: 'ум.4', en: 'd4' }
    };

    function wrapScaleDegree(d) { return ((d - 1) % 7) + 1; }

    function degreeRomanLabel(deg, altered) {
        const base = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][deg - 1] || String(deg);
        if (altered === -1) return '♭' + base;
        if (altered === 1) return '♯' + base;
        return base;
    }

    function noteDisplayRu(note, keySig) {
        const name = RU_NOTE_NAMES[note.letter] || note.letter;
        const accSuffix = note.acc === 1 ? '-диез' : note.acc === -1 ? '-бемоль'
            : note.acc > 1 ? '-диез'.repeat(note.acc) : note.acc < -1 ? '-бемоль'.repeat(-note.acc) : '';
        // В тональности с бемолями «ми» без знака может требовать бекар в тексте.
        if (note.acc === 0 && keySig) {
            const sig = normalizeKeySigName(keySig);
            const flats = KEY_FLAT_COUNT[sig] ?? 0;
            const sharps = KEY_SHARP_COUNT[sig] ?? 0;
            const flatLetters = FLAT_ORDER_EN.slice(0, flats);
            const sharpLetters = SHARP_ORDER_EN.slice(0, sharps);
            if (flats && flatLetters.includes(note.letter) && !accSuffix) return `${name} бекар`;
            if (sharps && sharpLetters.includes(note.letter) && !accSuffix) return `${name} бекар`;
        }
        return name + accSuffix;
    }

    function normalizeKeySigName(sig) {
        return String(sig || 'C').replace(/m$/i, '');
    }

    /** ув2 / ум7 / … — один интервал; «все характерные» — null (строим комплект). */
    function parseCharacteristicKind(t) {
        if (/все\s*характерн|all\s*characteristic|х\.?\s*и\.(?![а-яё])|характерные\s*интервал/i.test(t)) return null;
        if (/увеличенн[а-яё]*\s*секунд|ув\.?\s*2|aug\.?\s*2|\ba2\b/i.test(t)) return 'aug2';
        if (/уменьшенн[а-яё]*\s*септим|ум\.?\s*7|dim\.?\s*7|\bdim7\b/i.test(t)) return 'dim7';
        if (/увеличенн[а-яё]*\s*квинт|ув\.?\s*5|aug\.?\s*5|\ba5\b/i.test(t)) return 'aug5';
        if (/уменьшенн[а-яё]*\s*кварт|ум\.?\s*4|dim\.?\s*4|\bd4\b/i.test(t)) return 'dim4';
        return null;
    }

    /** Пара звуков характерного интервала в гармоническом ладу + подписи ступеней. */
    function characteristicPair(tonic, mode, kind) {
        const def = CHAR_KIND_DEFS[kind];
        if (!def) return null;
        const natural = buildScale(tonic, mode);
        const triad = tonicTriad(tonic, mode);
        let lo, hi, loLab, hiLab;

        if (mode === 'minor') {
            const VI = { ...natural[5], octave: 4 };
            const altVII = { ...natural[6], acc: natural[6].acc + 1, octave: 4 };
            const III = { ...natural[2], octave: 4 };
            if (kind === 'aug2') {
                lo = { ...VI }; hi = buildIntervalUp(VI, 2, 3); loLab = 'VI'; hiLab = 'VII♯';
            } else if (kind === 'dim7') {
                lo = { ...altVII }; hi = buildIntervalUp(altVII, 7, 9); loLab = 'VII♯'; hiLab = 'VI';
            } else if (kind === 'aug5') {
                lo = { ...III }; hi = buildIntervalUp(III, 5, 8); loLab = 'III'; hiLab = 'VII♯';
            } else if (kind === 'dim4') {
                lo = { ...altVII }; hi = buildIntervalUp(altVII, 4, 4); loLab = 'VII♯'; hiLab = 'III';
            }
        } else {
            const altVI = { ...natural[5], acc: natural[5].acc - 1, octave: 4 };
            const VII = { ...natural[6], octave: 4 };
            const III = { ...natural[2], octave: 4 };
            if (kind === 'aug2') {
                lo = { ...altVI }; hi = buildIntervalUp(altVI, 2, 3); loLab = '♭VI'; hiLab = 'VII';
            } else if (kind === 'dim7') {
                lo = { ...VII }; hi = buildIntervalUp(VII, 7, 9); loLab = 'VII'; hiLab = '♭VI';
            } else if (kind === 'aug5') {
                lo = { ...altVI }; hi = buildIntervalUp(altVI, 5, 8); loLab = '♭VI'; hiLab = 'III';
            } else if (kind === 'dim4') {
                lo = { ...III }; hi = buildIntervalUp(III, 4, 4); loLab = 'III'; hiLab = '♭VI';
            }
        }
        if (!lo || !hi || !checkInterval(lo, hi, def.degree, def.semis)) return null;
        return { lo, hi, quality: def.quality, def, loLab, hiLab, triad };
    }

    function buildSingleCharacteristic(tonic, mode, kind, withResolution) {
        const pair = characteristicPair(tonic, mode, kind);
        if (!pair) return null;
        const notes = [chord(pair.lo, pair.hi, false, intervalLabel(pair.lo, pair.hi))];
        if (withResolution !== false) {
            const r = resolveInterval(pair.lo, pair.hi, pair.quality, pair.triad);
            notes.push(chord(r[0], r[1], true, intervalLabel(r[0], r[1])));
        }
        if (notes.length) delete notes[notes.length - 1].barAfter;
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            barlines: withResolution !== false ? 'manual' : 'none',
            notes,
            _charPair: pair
        };
    }

    function characteristicProse(tonic, mode, kind, ru) {
        const pair = characteristicPair(tonic, mode, kind);
        if (!pair) return '';
        const keyName = tonalityDisplayName(tonic, mode, ru);
        const sig = keySigFor(tonic, mode);
        const loName = noteDisplayRu(pair.lo, sig);
        const hiName = noteDisplayRu(pair.hi, sig);
        const intName = intervalNameFor(pair.def.degree, pair.def.semis, ru);
        if (ru) {
            let resolution = '';
            if (pair.quality === 'aug') {
                resolution = pair.def.degree === 2
                    ? 'Она разрешается **расширением** в устойчивый интервал (часто в чистую кварту).'
                    : 'Он разрешается **расширением** наружу в устойчивый интервал лада.';
            } else {
                resolution = 'Он разрешается **сужением** в устойчивый интервал тонического трезвучия.';
            }
            return `В **${keyName}** ${intName} (${pair.def.ru}) строится на **${pair.loLab}** (${loName}) — **${pair.hiLab}** (${hiName}). ${resolution}`;
        }
        return `In **${keyName}**, ${pair.def.en} is built on **${pair.loLab}** (${loName}) to **${pair.hiLab}** (${hiName}). It resolves according to the tendency of ${pair.quality === 'aug' ? 'augmented' : 'diminished'} intervals in the mode.`;
    }

    function parseScaleDegree(t) {
        let m = t.match(/(?:на\s+)?([1-7])\s*(?:-?(?:й|ю|ей|ой|ую|я|e|nd|rd|th|st))\s*ступен/i);
        if (m) return parseInt(m[1], 10);
        m = t.match(/(?:на\s+)?(vii|vi|iv|iii|ii|i|v)\s*ступен/i);
        if (m) {
            const map = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
            return map[m[1]] || null;
        }
        m = t.match(/(?:^|[^a-zа-яё])(i{1,3}|iv|vi{0,2}|vii|v)(?![a-zа-яё])\s*ступен/i);
        if (m) {
            const map = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
            return map[m[1].toLowerCase()] || null;
        }
        return null;
    }

    function scaleFormForKey(key, t) {
        const form = detectForm(t);
        if (form === 'harmonic') return key.mode === 'minor' ? 'harmonicMinor' : 'harmonicMajor';
        if (form === 'natural') return key.mode === 'minor' ? 'minor' : 'major';
        if (form === 'melodic') return key.mode === 'minor' ? 'melodicMinor' : 'major';
        // Для интервалов/аккордов на ступени в миноре школа обычно берёт гармонический лад.
        return key.mode === 'minor' ? 'harmonicMinor' : 'major';
    }

    function buildIntervalOnDegree(tonic, mode, scaleDeg, spec, t, withResolution) {
        const form = mode === 'minor' ? 'harmonicMinor' : 'major';
        const base = scaleDegree(tonic, scaleDeg, form);
        if (!base) return null;
        const lo = { ...base, octave: 4 };
        const hi = buildIntervalUp(lo, spec.degree, spec.semis);
        if (!checkInterval(lo, hi, spec.degree, spec.semis)) return null;
        const quality = spec.semis === 3 && spec.degree === 2 ? 'aug'
            : spec.semis === 9 && spec.degree === 7 ? 'dim'
            : spec.semis === 8 && spec.degree === 5 ? 'aug'
            : spec.semis === 4 && spec.degree === 4 ? 'dim'
            : spec.semis <= 6 ? 'dim' : 'aug';
        const triad = tonicTriad(tonic, mode);
        const notes = [chord(lo, hi, false, intervalLabel(lo, hi))];
        const doRes = withResolution !== false && (wantsResolution(t) || /разреш|resolve/i.test(t));
        if (doRes) {
            const r = resolveInterval(lo, hi, quality, triad);
            notes.push(chord(r[0], r[1], true, intervalLabel(r[0], r[1])));
        }
        return plainBlock(notes, keySigFor(tonic, mode), notes.length > 1 ? 'manual' : 'none');
    }

    function parseTriadInversion(t) {
        if (/квартсекст|64|6\/4|\b64\b/.test(t)) return '64';
        if (/секстаккорд|секста|6\/3|\b6\b(?![4])/.test(t) && !/септ/.test(t)) return '6';
        return '53';
    }

    function diatonicTriadSemis(tonic, mode, deg, form) {
        const r = scaleDegree(tonic, deg, form);
        const t = scaleDegree(tonic, wrapScaleDegree(deg + 2), form);
        const f = scaleDegree(tonic, wrapScaleDegree(deg + 4), form);
        if (!r || !t || !f) return null;
        return { root: r, thirdSemi: intervalSemis(r, t), fifthSemi: intervalSemis(r, f) };
    }

    function buildTriadOnDegree(tonic, mode, scaleDeg, t, triadKindOverride) {
        const form = scaleFormForKey({ tonic, mode }, t);
        let thirdSemi, fifthSemi, prefix, root;
        const kind = triadKindOverride || parseTriadKind(t);
        if (kind && TRIAD_KIND_DEFS[kind]) {
            const def = TRIAD_KIND_DEFS[kind];
            root = scaleDegree(tonic, scaleDeg, form);
            thirdSemi = def.third;
            fifthSemi = def.fifth;
            prefix = labelLocale === 'ru' ? def.ru : def.en;
        } else {
            const dia = diatonicTriadSemis(tonic, mode, scaleDeg, form);
            if (!dia) return null;
            root = dia.root;
            thirdSemi = dia.thirdSemi;
            fifthSemi = dia.fifthSemi;
            const qKey = `${thirdSemi},${fifthSemi}`;
            prefix = labelLocale === 'ru'
                ? ({ '4,7': 'Б', '3,7': 'М', '3,6': 'Ум', '4,8': 'Ув' }[qKey] || '')
                : ({ '4,7': 'M', '3,7': 'm', '3,6': 'd', '4,8': 'A' }[qKey] || '');
        }
        if (!root) return null;
        const inv = parseTriadInversion(t);
        const v = triadVoicings({ ...root, octave: 4 }, thirdSemi, fifthSemi);
        const fig = inv === '64' ? '64' : inv === '6' ? '6' : '53';
        return plainBlock([{ keys: v[fig], duration: 'w', label: prefix + fig }], keySigFor(tonic, mode), 'none');
    }

    /** «Определите интервал: до ми» / «до — ми» */
    function parseTwoNotes(t) {
        const cleaned = t.replace(/определи[а-яё]*\s*интервал|определи[а-яё]*\s*аккорд|identify\s*(?:the\s*)?interval|identify\s*(?:the\s*)?chord/gi, ' ');
        const sep = cleaned.split(/[:\-–—,]|(?:\s+и\s+)|(?:\s+to\s+)/i);
        if (sep.length >= 2) {
            const a = parseSingleNote(sep[0]);
            const b = parseSingleNote(sep.slice(1).join(' '));
            if (a && b) return [a, b];
        }
        const notes = [];
        let s = cleaned;
        for (let i = 0; i < 4; i++) {
            const n = parseSingleNote(s) || findRuNote(s);
            if (!n) break;
            notes.push({ ...n, octave: 4 });
            s = s.replace(new RegExp(findRuNoteWord(s) || ''), '');
        }
        return notes.length >= 2 ? notes.slice(0, 2) : null;
    }

    function findRuNoteWord(s) {
        for (const [word] of RU_NOTES) {
            if (s.includes(word)) return word;
        }
        return null;
    }

    function parseChordNotes(t) {
        const cleaned = t.replace(/определи[а-яё]*\s*аккорд|identify\s*(?:the\s*)?chord/gi, ' ');
        const parts = cleaned.split(/[:\-–—,\s]+/).filter(Boolean);
        const notes = [];
        for (const p of parts) {
            const n = parseSingleNote(p) || findRuNote(p);
            if (n) notes.push({ ...n, octave: 4 });
            if (notes.length >= 4) break;
        }
        if (notes.length >= 3) return notes;
        // «соль си ре фа» подряд в строке
        let s = cleaned;
        while (notes.length < 4) {
            const n = findRuNote(s);
            if (!n) break;
            notes.push({ ...n, octave: 4 });
            const w = findRuNoteWord(s);
            s = s.replace(w, '');
        }
        return notes.length >= 3 ? notes : null;
    }

    function answerIdentifyInterval(t, rawQuery, ru) {
        if (!/определи[а-яё]*\s*интервал|identify\s*(?:the\s*)?interval|какой\s*интервал|what\s*interval/i.test(t)) return null;
        const pair = parseTwoNotes(t);
        if (!pair) return null;
        const [a, b] = pair;
        const lo = noteAbs(a) <= noteAbs(b) ? a : b;
        const hi = noteAbs(a) <= noteAbs(b) ? b : a;
        const deg = intervalDegree(lo, hi);
        const sem = intervalSemis(lo, hi);
        const name = intervalNameFor(deg, sem, ru);
        if (!name) return null;
        return {
            text: ru
                ? `Между **${noteDisplayRu(lo, 'C')}** и **${noteDisplayRu(hi, 'C')}** — **${name}** (${deg}-я ступень, ${sem} ${ruPlural(sem, 'полутон', 'полутона', 'полутонов')}).`
                : `From **${noteKey(lo)}** to **${noteKey(hi)}**: **${name}** (size ${deg}, ${sem} semitones).`
        };
    }

    function answerIdentifyChord(t, rawQuery, ru) {
        if (!/определи[а-яё]*\s*аккорд|identify\s*(?:the\s*)?chord|какой\s*аккорд|what\s*chord/i.test(t)) return null;
        const notes = parseChordNotes(t);
        if (!notes || notes.length < 3) return null;
        const parsed = notes.map(n => parseVexKey(noteKey(n))).filter(Boolean);
        const label = describeKeys(parsed.map(n => noteKey(n)));
        if (!label) return null;
        return {
            text: ru
                ? `Аккорд **${parsed.map(n => noteDisplayRu(n, 'C')).join(' — ')}** — **${label}**.`
                : `The chord **${parsed.map(n => noteKey(n)).join(' — ')}** is **${label}**.`
        };
    }

    function answerCharacteristicDegrees(t, key, ru) {
        if (!/какие\s*ступен|на\s*каких\s*ступен|образуют|which\s*degree|what\s*degree/i.test(t)) return null;
        const kind = parseCharacteristicKind(t);
        if (!kind || !key) return null;
        const pair = characteristicPair(key.tonic, key.mode, kind);
        if (!pair) return null;
        const keyName = tonalityDisplayName(key.tonic, key.mode, ru);
        const intName = intervalNameFor(pair.def.degree, pair.def.semis, ru);
        return {
            text: ru
                ? `В **${keyName}** **${intName}** (${pair.def.ru}) образуют ступени **${pair.loLab}** и **${pair.hiLab}**.`
                : `In **${keyName}**, **${pair.def.en}** is formed by degrees **${pair.loLab}** and **${pair.hiLab}**.`
        };
    }

    function buildIntervalInversionExercise(spec) {
        const base = { letter: 'c', acc: 0, octave: 4 };
        const hi = buildIntervalUp(base, spec.degree, spec.semis);
        const invDeg = 9 - spec.degree;
        const invSemis = 12 - spec.semis;
        const top = buildIntervalUp(hi, invDeg, invSemis);
        if (!checkInterval(base, hi, spec.degree, spec.semis)) return null;
        if (!checkInterval(hi, top, invDeg, invSemis)) return null;
        const notes = [
            sonority([base, hi], intervalLabel(base, hi), 'w', true),
            sonority([hi, top], intervalLabel(hi, top), 'w')
        ];
        return plainBlock(notes, 'C', 'manual');
    }

    function buildThreeMinorsExercise(tonic) {
        const items = [
            { label: labelLocale === 'ru' ? 'Натуральный минор' : 'Natural minor', data: buildScaleData(tonic, 'minor', 'minor') },
            { label: labelLocale === 'ru' ? 'Гармонический минор' : 'Harmonic minor', data: buildScaleData(tonic, 'minor', 'harmonicMinor') },
            { label: labelLocale === 'ru' ? 'Мелодический минор (вверх)' : 'Melodic minor (ascending)', data: buildScaleData(tonic, 'minor', 'melodicMinor') }
        ];
        return items;
    }

    /** Сборка «учебникового» задания в тональности (до общего parseExercise). */
    function buildTextbookInKey(rawQuery, t, key) {
        const withRes = wantsResolution(t) || /разреш/i.test(t);

        // Один характерный интервал (ув.2 в фа мажоре …)
        const charKind = parseCharacteristicKind(t);
        if (charKind && /интервал|секунд|септим|квинт|кварт|построй|постро|build|draw|напиш|сделай/i.test(t)) {
            const built = buildSingleCharacteristic(key.tonic, key.mode, charKind, withRes);
            if (!built) return null;
            const { _charPair, ...data } = built;
            return finalize(data);
        }

        const scaleDeg = parseScaleDegree(t);

        const seventhKind = parseSeventhKind(t);
        if (seventhKind !== null && !isViiSeventhQuery(t) && !isSecondSeventhQuery(t) && !isD7Query(t)) {
            const data = scaleDeg
                ? buildSeventhOnDegree(key.tonic, key.mode, scaleDeg, seventhKind, t)
                : buildSeventhByKind(key.tonic, seventhKind, keySigFor(key.tonic, key.mode));
            if (data) return finalize(data);
        }

        const intSpec = parseIntervalSpec(rawQuery);
        if (scaleDeg && intSpec && /интервал|секунд|терци|кварт|квинт|септим|построй|build/i.test(t)) {
            return finalize(buildIntervalOnDegree(key.tonic, key.mode, scaleDeg, intSpec, t, withRes));
        }

        // «большую септиму в ми минор» — интервал от тоники, без «на N ступени».
        if (!scaleDeg && intSpec && !CHORD_WORDS_RE.test(t)
            && /интервал|секунд|терци|кварт|квинт|секст|септим|октав|построй|постро|build|draw|напиш|сделай/i.test(t)) {
            return finalize(buildIntervalOnDegree(key.tonic, key.mode, 1, intSpec, t, withRes));
        }

        if (scaleDeg && (/трезвуч|аккорд|секстаккорд|квартсекст|ум53|ув53|б53|м53|triad|chord/i.test(t))) {
            return finalize(buildTriadOnDegree(key.tonic, key.mode, scaleDeg, t));
        }

        if (/три\s*вида\s*минор|three\s*(?:forms?\s*of\s*)?minor|все\s*виды\s*минор/i.test(t)) {
            return finalizeMulti(buildThreeMinorsExercise(key.tonic));
        }

        return null;
    }

    // ---------- Гаммы ----------
    // Римские цифры ступеней — для подписи нот гаммы (I … VIII).
    const ROMAN_DEGREES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

    /** Строит данные одной гаммы по конкретной формуле (scaleKey из SCALE_FORMULAS). */
    function buildScaleData(tonic, mode, scaleKey) {
        const formula = SCALE_FORMULAS[scaleKey] || SCALE_FORMULAS.major;
        const notes = [];
        for (let i = 0; i < 7; i++) {
            const n = buildIntervalUp(tonic, i + 1, formula[i]);
            notes.push({ keys: [noteKey(n)], duration: 'q', label: ROMAN_DEGREES[i] });
        }
        notes.push({ keys: [noteKey(buildIntervalUp(tonic, 8, 12))], duration: 'q', label: ROMAN_DEGREES[7] });
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    function buildScaleExercise(tonic, mode, form) {
        if (form === 'melodic') {
            return mode === 'minor'
                ? buildMelodicMinorBothWays(tonic)
                : buildMelodicMajorBothWays(tonic);
        }
        let key;
        if (mode === 'minor') {
            key = form === 'harmonic' ? 'harmonicMinor' : 'minor';
        } else {
            key = form === 'harmonic' ? 'harmonicMajor' : 'major';
        }
        return buildScaleData(tonic, mode, key);
    }

    /**
     * Мелодический минор: ВВЕРХ с повышенными VI и VII, ВНИЗ — как натуральный минор.
     * Возвращает один блок из 15 нот (8 вверх + 7 вниз без повтора верхней).
     */
    function buildMelodicMinorBothWays(tonic) {
        const ascFormula  = [0, 2, 3, 5, 7, 9, 11, 12]; // d e f g a b c# d
        const descFormula = [10, 8, 7, 5, 3, 2, 0];     // c bb a g f e d  (от верхней d вниз)
        const notes = [];
        ascFormula.forEach((s, idx) => {
            const deg = idx + 1;
            notes.push({ keys: [noteKey(buildIntervalUp(tonic, deg, s))], duration: 'q', label: ROMAN_DEGREES[deg - 1] });
        });
        // нисходящая часть: верхняя «до октавой выше тоники» УЖЕ есть в ascending,
        // дальше идём от VII вниз к I. degree считаем относительно НИЖНЕЙ тоники.
        const descDegs = [7, 6, 5, 4, 3, 2, 1];
        descDegs.forEach((deg, idx) => {
            notes.push({ keys: [noteKey(buildIntervalUp(tonic, deg, descFormula[idx]))], duration: 'q', label: ROMAN_DEGREES[deg - 1] });
        });
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, 'minor'),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    /**
     * Мелодический мажор: ВВЕРХ — натуральный мажор, ВНИЗ — с пониженными VI и VII.
     * Возвращает один блок из 15 нот (8 вверх + 7 вниз без повтора верхней).
     */
    function buildMelodicMajorBothWays(tonic) {
        const ascFormula  = [0, 2, 4, 5, 7, 9, 11, 12]; // e f# g# a b c# d# e
        const descFormula = [10, 8, 7, 5, 4, 2, 0];     // d  c  b a g# f# e  (от верхней e вниз)
        const notes = [];
        ascFormula.forEach((s, idx) => {
            const deg = idx + 1;
            notes.push({ keys: [noteKey(buildIntervalUp(tonic, deg, s))], duration: 'q', label: ROMAN_DEGREES[deg - 1] });
        });
        const descDegs = [7, 6, 5, 4, 3, 2, 1];
        descDegs.forEach((deg, idx) => {
            notes.push({ keys: [noteKey(buildIntervalUp(tonic, deg, descFormula[idx]))], duration: 'q', label: ROMAN_DEGREES[deg - 1] });
        });
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, 'major'),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    /**
     * Мелодический мажор: восходящая часть (натуральный мажор вверх).
     */
    function buildMelodicMajorAsc(tonic) {
        const ascFormula = [0, 2, 4, 5, 7, 9, 11, 12];
        const notes = ascFormula.map((s, idx) => ({
            keys: [noteKey(buildIntervalUp(tonic, idx + 1, s))],
            duration: 'q',
            label: ROMAN_DEGREES[idx]
        }));
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, 'major'),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    function buildMelodicMajorDesc(tonic) {
        const steps = [
            { deg: 8, semi: 12 },
            { deg: 7, semi: 10 },
            { deg: 6, semi: 8 },
            { deg: 5, semi: 7 },
            { deg: 4, semi: 5 },
            { deg: 3, semi: 4 },
            { deg: 2, semi: 2 },
            { deg: 1, semi: 0 }
        ];
        const notes = steps.map(({ deg, semi }) => ({
            keys: [noteKey(buildIntervalUp(tonic, deg, semi))],
            duration: 'q',
            label: ROMAN_DEGREES[deg - 1]
        }));
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, 'major'),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    function buildMelodicMinorAsc(tonic) {
        const ascFormula = [0, 2, 3, 5, 7, 9, 11, 12];
        const notes = ascFormula.map((s, idx) => ({
            keys: [noteKey(buildIntervalUp(tonic, idx + 1, s))],
            duration: 'q',
            label: ROMAN_DEGREES[idx]
        }));
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, 'minor'),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    function buildMelodicMinorDesc(tonic) {
        const steps = [
            { deg: 8, semi: 12 },
            { deg: 7, semi: 10 },
            { deg: 6, semi: 8 },
            { deg: 5, semi: 7 },
            { deg: 4, semi: 5 },
            { deg: 3, semi: 3 },
            { deg: 2, semi: 2 },
            { deg: 1, semi: 0 }
        ];
        const notes = steps.map(({ deg, semi }) => ({
            keys: [noteKey(buildIntervalUp(tonic, deg, semi))],
            duration: 'q',
            label: ROMAN_DEGREES[deg - 1]
        }));
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, 'minor'),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    /** «Мелодическая гамма вверх и вниз» — один блок из 15 нот. */
    function wantsMelodicBothWays(t) {
        return /вверх\s*и\s*вниз|вниз\s*и\s*вверх|up\s*and\s*down|both\s*way|ascending\s*and\s*descending|в\s*обе\s*сторон/i.test(t);
    }

    /** Все виды гаммы: натуральная, гармоническая, мелодическая — отдельными блоками. */
    function buildAllScaleForms(tonic, mode, isRu, queryText) {
        const t = String(queryText || '').toLowerCase();
        const melBoth = wantsMelodicBothWays(t) || /мелодическ|melodic/i.test(t);
        const L = isRu
            ? {
                nat: 'Натуральная',
                harm: 'Гармоническая',
                melUp: 'Мелодическая (вверх)',
                melDown: 'Мелодическая (вниз)',
                melBoth: 'Мелодическая (вверх и вниз)'
            }
            : {
                nat: 'Natural',
                harm: 'Harmonic',
                melUp: 'Melodic (ascending)',
                melDown: 'Melodic (descending)',
                melBoth: 'Melodic (ascending & descending)'
            };
        if (mode === 'minor') {
            const melBlock = melBoth
                ? { label: L.melBoth, data: buildMelodicMinorBothWays(tonic) }
                : [
                    { label: L.melUp, data: buildMelodicMinorAsc(tonic) },
                    { label: L.melDown, data: buildMelodicMinorDesc(tonic) }
                ];
            return [
                { label: L.nat, data: buildScaleData(tonic, 'minor', 'minor') },
                { label: L.harm, data: buildScaleData(tonic, 'minor', 'harmonicMinor') },
                ...(Array.isArray(melBlock) ? melBlock : [melBlock])
            ];
        }
        const melBlock = melBoth
            ? { label: L.melBoth, data: buildMelodicMajorBothWays(tonic) }
            : [
                { label: L.melUp, data: buildMelodicMajorAsc(tonic) },
                { label: L.melDown, data: buildMelodicMajorDesc(tonic) }
            ];
        return [
            { label: L.nat, data: buildScaleData(tonic, 'major', 'major') },
            { label: L.harm, data: buildScaleData(tonic, 'major', 'harmonicMajor') },
            ...(Array.isArray(melBlock) ? melBlock : [melBlock])
        ];
    }

    // ---------- Трезвучия и обращения ----------
    function buildTonicTriadExercise(tonic, mode, withInversions) {
        const triad = tonicTriad(tonic, mode); // [I, III, V] в окт.4
        const I = { ...triad[0], octave: 4 };
        const III = buildIntervalUp(I, 3, mode === 'major' ? 4 : 3);
        const V = buildIntervalUp(I, 5, 7);
        const I8 = buildIntervalUp(I, 8, 12);
        const III8 = buildIntervalUp(I8, 3, mode === 'major' ? 4 : 3);

        const tonicLabels = labelLocale === 'ru'
            ? ['Т53', 'Т6', 'Т64']
            : ['T53', 'T6', 'T64'];
        const notes = [];
        notes.push({ keys: [noteKey(I), noteKey(III), noteKey(V)], duration: 'w', label: tonicLabels[0] });
        if (withInversions) {
            notes.push({ keys: [noteKey(III), noteKey(V), noteKey(I8)], duration: 'w', label: tonicLabels[1] });
            notes.push({ keys: [noteKey(V), noteKey(I8), noteKey(III8)], duration: 'w', label: tonicLabels[2] });
        }
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    /** Все четыре вида трезвучий от ноты: маж., мин., ув., ум. */
    function buildAllTriadsFromNote(root) {
        const r = { ...root, octave: 4 };
        const defs = labelLocale === 'ru'
            ? [[4, 7, 'Б53'], [3, 7, 'М53'], [4, 8, 'Ув53'], [3, 6, 'Ум53']]
            : [[4, 7, 'M53'], [3, 7, 'm53'], [4, 8, 'A53'], [3, 6, 'd53']];
        const notes = defs.map(([t, f, label]) => ({
            keys: [noteKey(r), noteKey(buildIntervalUp(r, 3, t)), noteKey(buildIntervalUp(r, 5, f))],
            duration: 'w',
            label
        }));
        return { clef: 'treble', keySignature: 'C', timeSignature: '', barlines: 'none', notes };
    }

    /** Три обращения трезвучия от root с заданными терцией/квинтой (в полутонах). */
    function triadVoicings(root, thirdSemi, fifthSemi) {
        const r = { ...root, octave: 4 };
        const III = buildIntervalUp(r, 3, thirdSemi);
        const V = buildIntervalUp(r, 5, fifthSemi);
        const r8 = buildIntervalUp(r, 8, 12);
        const III8 = buildIntervalUp(r8, 3, thirdSemi);
        return {
            '53': [noteKey(r), noteKey(III), noteKey(V)],
            '6': [noteKey(III), noteKey(V), noteKey(r8)],
            '64': [noteKey(V), noteKey(r8), noteKey(III8)]
        };
    }

    /** Главные трезвучия T, S, D (+ обращения) в заданной тональности. */
    function buildMainTriads(tonic, mode, withInversions, form) {
        const harm = form === 'harmonic';
        const maj = mode === 'major';
        const defs = maj
            ? [
                { L: 'T', root: scaleDegree(tonic, 1, 'major'), t: 4, f: 7 },
                { L: harm ? 's' : 'S', root: scaleDegree(tonic, 4, harm ? 'harmonic' : 'major'), t: harm ? 3 : 4, f: 7 },
                { L: 'D', root: scaleDegree(tonic, 5, 'major'), t: 4, f: 7 }
            ]
            : [
                { L: 't', root: scaleDegree(tonic, 1, 'major'), t: 3, f: 7 },
                { L: 's', root: scaleDegree(tonic, 4, 'major'), t: 3, f: 7 },
                { L: harm ? 'D' : 'd', root: scaleDegree(tonic, 5, harm ? 'harmonic' : 'major'), t: harm ? 4 : 3, f: 7 }
            ];
        const notes = [];
        defs.forEach(({ L, root, t, f }) => {
            const v = triadVoicings(root, t, f);
            notes.push({ keys: v['53'], duration: 'w', label: L + '53' });
            if (withInversions) {
                notes.push({ keys: v['6'], duration: 'w', label: L + '6' });
                notes.push({ keys: v['64'], duration: 'w', label: L + '64' });
            }
        });
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: 'none',
            notes
        };
    }

    // ---------- Цепочки аккордов (школьные схемы) ----------
    function scaleDegree(tonic, degree, form) {
        let formula;
        if (form === 'minor' || form === 'natural') {
            formula = SCALE_FORMULAS.minor;
        } else if (form === 'harmonicMinor') {
            formula = SCALE_FORMULAS.harmonicMinor;
        } else if (form === 'harmonic' || form === 'harmonicMajor') {
            formula = SCALE_FORMULAS.harmonicMajor;
        } else {
            formula = SCALE_FORMULAS.major;
        }
        const semi = formula[degree - 1];
        if (semi == null) return null;
        return buildIntervalUp({ ...tonic, octave: 4 }, degree, semi);
    }

    /** Трезвучие в близкой позиции: bassDeg — ступень в басу (53/6/64). */
    function triadCloseBass(tonic, bassDeg, midDeg, topDeg, form, bassOct) {
        const bass = scaleDegree(tonic, bassDeg, form);
        const mid = scaleDegree(tonic, midDeg, form);
        const top = scaleDegree(tonic, topDeg, form);
        bass.octave = bassOct;
        mid.octave = bassOct;
        top.octave = bassOct;
        while (noteAbs(mid) <= noteAbs(bass)) mid.octave++;
        while (noteAbs(top) <= noteAbs(mid)) top.octave++;
        return [noteKey(bass), noteKey(mid), noteKey(top)];
    }

    /** Септаккорд в близкой позиции: bassDeg — ступень в басу (7/65/43/2). */
    function seventhCloseBass(tonic, degs, forms, bassOct) {
        const notes = degs.map((d, i) => {
            const n = scaleDegree(tonic, d, forms[i]);
            n.octave = bassOct;
            return n;
        });
        for (let i = 1; i < notes.length; i++) {
            while (noteAbs(notes[i]) <= noteAbs(notes[i - 1])) notes[i].octave++;
        }
        return notes.map(noteKey);
    }

    /** D7 / D65 / D43 / D2 — индексы 0 / 2 / 4 / 6 в пресете (между ними разрешения). */
    function d7PresetForm(preset, formIndex) {
        if (!preset) return null;
        const idx = formIndex * 2;
        return presetKeys(preset, idx);
    }

    /** Голосоведение цепочки: каждый аккорд ближе к предыдущему (общие тоны, плавный бас). */
    function connectChainVoices(notes) {
        if (!Array.isArray(notes) || notes.length < 2) return notes;
        let prevKeys = null;
        return notes.map(n => {
            const keys = voiceLeadChord(prevKeys, n.keys || []);
            prevKeys = keys;
            return { ...n, keys };
        });
    }

    function voiceLeadChord(prevKeys, nextKeys) {
        if (!prevKeys?.length || !nextKeys?.length) return nextKeys;
        const prevSorted = prevKeys.map(k => noteAbs(parseVexKey(k))).sort((a, b) => a - b);
        return nextKeys.map((k, i) => {
            const p = parseVexKey(k);
            if (!p) return k;
            const target = prevSorted[Math.min(i, prevSorted.length - 1)] ?? prevSorted[0];
            let best = k;
            let bestDist = Infinity;
            for (let shift = -2; shift <= 2; shift++) {
                const cand = { ...p, octave: Math.max(1, Math.min(8, p.octave + shift)) };
                const dist = Math.abs(noteAbs(cand) - target);
                if (dist < bestDist) {
                    bestDist = dist;
                    best = noteKey(cand);
                }
            }
            return best;
        });
    }

    function wrapChain(notes, tonic, mode) {
        const voices = connectChainVoices(notes);
        if (!notesWritable(voices)) return null;
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: 'none',
            notes: voices
        };
    }

    /**
     * Цепочка 1 (мажор): T53 S64 VII7 D65 T53 S6 K64 D7 T53
     * Трезвучия = 3 ноты. D7 и D65 = септаккорды (4 ноты — это норма для 65).
     */
    function buildChain1(tonic) {
        const t53 = () => triadCloseBass(tonic, 1, 3, 5, 'major', 4);
        const preset = D7_PRESETS[d7KeyId(tonic, 'major')];
        const d7Keys = preset ? d7PresetForm(preset, 0) : seventhCloseBass(tonic, [5, 7, 2, 4], ['major', 'harmonic', 'major', 'major'], 4);
        const d65Keys = preset ? d7PresetForm(preset, 1) : seventhCloseBass(tonic, [7, 2, 4, 5], ['harmonic', 'major', 'major', 'major'], 4);

        const notes = [
            { keys: t53(), duration: 'w', label: 'T53' },
            { keys: triadCloseBass(tonic, 1, 4, 6, 'harmonic', 4), duration: 'w', label: 'S64' },
            { keys: seventhCloseBass(tonic, [7, 2, 4, 6], ['harmonic', 'major', 'major', 'harmonic'], 3), duration: 'w', label: 'VII7' },
            { keys: d65Keys, duration: 'w', label: 'D65' },
            { keys: t53(), duration: 'w', label: 'T53' },
            { keys: triadCloseBass(tonic, 6, 1, 4, 'major', 4), duration: 'w', label: 'S6' },
            { keys: triadCloseBass(tonic, 5, 1, 3, 'major', 4), duration: 'w', label: 'K64' },
            { keys: d7Keys, duration: 'w', label: 'D7' },
            { keys: t53(), duration: 'w', label: 'T53' }
        ];
        return wrapChain(notes, tonic, 'major');
    }

    /**
     * Цепочка 2 (минор): t53 – d6 – s6 – D53 – D2 – t6 – II7 – D43 – t53 – s64 – t53
     */
    function buildChain2(tonic) {
        const t53 = () => triadCloseBass(tonic, 1, 3, 5, 'minor', 4);
        const preset = D7_PRESETS[d7KeyId(tonic, 'minor')];
        const d43Keys = preset ? d7PresetForm(preset, 2) : seventhCloseBass(tonic, [2, 4, 5, 7], ['minor', 'minor', 'harmonic', 'harmonic'], 4);
        const d2Keys = preset ? d7PresetForm(preset, 3) : seventhCloseBass(tonic, [4, 5, 7, 2], ['minor', 'harmonic', 'harmonic', 'minor'], 4);
        const ii7Keys = seventhCloseBass(tonic, [2, 4, 6, 1], ['minor', 'minor', 'minor', 'minor'], 4);

        const notes = [
            { keys: t53(), duration: 'w', label: 't53' },
            { keys: triadCloseBass(tonic, 7, 2, 5, 'harmonicMinor', 4), duration: 'w', label: 'd6' },
            { keys: triadCloseBass(tonic, 6, 1, 4, 'minor', 4), duration: 'w', label: 's6' },
            { keys: triadCloseBass(tonic, 5, 7, 2, 'harmonicMinor', 4), duration: 'w', label: 'D53' },
            { keys: d2Keys, duration: 'w', label: 'D2' },
            { keys: triadCloseBass(tonic, 3, 5, 1, 'minor', 4), duration: 'w', label: 't6' },
            { keys: ii7Keys, duration: 'w', label: 'II7' },
            { keys: d43Keys, duration: 'w', label: 'D43' },
            { keys: t53(), duration: 'w', label: 't53' },
            { keys: triadCloseBass(tonic, 1, 4, 6, 'minor', 4), duration: 'w', label: 's64' },
            { keys: t53(), duration: 'w', label: 't53' }
        ];
        return wrapChain(notes, tonic, 'minor');
    }

    function parseChainNumber(t) {
        // «цепочка 2» / «chain 2» — явно вторая схема. Не используем \w после «цепочк»:
        // в JS \w без флага u не матчит кириллицу, и «цепочка 2» не распознаётся.
        if (/цепочка\s*2(?![0-9])|2[\s-]*(?:ю|я|й|e|nd)\s*цепоч|chain\s*2\b|втор[а-яё]*\s*цепоч/i.test(t)) return 2;
        if (/цепочка\s*1(?![0-9])|1[\s-]*(?:ю|я|й|st)\s*цепоч|chain\s*1\b|перв[а-яё]*\s*цепоч/i.test(t)) return 1;
        return null;
    }

    // ---------- Доминантсептаккорд D7 — готовые аппликатуры solfeggio-online.ru ----------
    // 30 тональностей × 8 аккордов (D7/D65/D43/D2 + разрешения). По запросу — только lookup по ключу.
    const D7_FORM_LABELS = [
        ['D7', 'T3'], ['D6/5', 'T53'], ['D4/3', 'T53'], ['D2', 'T6']
    ];
    const D7_PRESETS = {"c-major":[["g/4","b/4","d/5","f/5"],["c/5","c/5","c/5","e/5"],["b/4","d/5","f/5","g/5"],["c/5","c/5","e/5","g/5"],["d/5","f/5","g/5","b/5"],["c/5","e/5","g/5","c/6"],["f/5","g/5","b/5","d/6"],["e/5","g/5","c/6","c/6"]],"g-major":[["d/4","f#/4","a/4","c/5"],["g/4","g/4","g/4","b/4"],["f#/4","a/4","c/5","d/5"],["g/4","g/4","b/4","d/5"],["a/4","c/5","d/5","f#/5"],["g/4","b/4","d/5","g/5"],["c/5","d/5","f#/5","a/5"],["b/4","d/5","g/5","g/5"]],"d-major":[["a/4","c#/5","e/5","g/5"],["d/5","d/5","d/5","f#/5"],["c#/5","e/5","g/5","a/5"],["d/5","d/5","f#/5","a/5"],["e/5","g/5","a/5","c#/6"],["d/5","f#/5","a/5","d/6"],["g/5","a/5","c#/6","e/6"],["f#/5","a/5","d/6","d/6"]],"a-major":[["e/4","g#/4","b/4","d/5"],["a/4","a/4","a/4","c#/5"],["g#/4","b/4","d/5","e/5"],["a/4","a/4","c#/5","e/5"],["b/4","d/5","e/5","g#/5"],["a/4","c#/5","e/5","a/5"],["d/5","e/5","g#/5","b/5"],["c#/5","e/5","a/5","a/5"]],"e-major":[["b/4","d#/5","f#/5","a/5"],["e/5","e/5","e/5","g#/5"],["d#/5","f#/5","a/5","b/5"],["e/5","e/5","g#/5","b/5"],["f#/5","a/5","b/5","d#/6"],["e/5","g#/5","b/5","e/6"],["a/5","b/5","d#/6","f#/6"],["g#/5","b/5","e/6","e/6"]],"b-major":[["f#/4","a#/4","c#/5","e/5"],["b/4","b/4","b/4","d#/5"],["a#/4","c#/5","e/5","f#/5"],["b/4","b/4","d#/5","f#/5"],["c#/5","e/5","f#/5","a#/5"],["b/4","d#/5","f#/5","b/5"],["e/5","f#/5","a#/5","c#/6"],["d#/5","f#/5","b/5","b/5"]],"f#-major":[["c#/4","e#/4","g#/4","b/4"],["f#/4","f#/4","f#/4","a#/4"],["e#/4","g#/4","b/4","c#/5"],["f#/4","f#/4","a#/4","c#/5"],["g#/4","b/4","c#/5","e#/5"],["f#/4","a#/4","c#/5","f#/5"],["b/4","c#/5","e#/5","g#/5"],["a#/4","c#/5","f#/5","f#/5"]],"c#-major":[["g#/4","b#/4","d#/5","f#/5"],["c#/5","c#/5","c#/5","e#/5"],["b#/4","d#/5","f#/5","g#/5"],["c#/5","c#/5","e#/5","g#/5"],["d#/5","f#/5","g#/5","b#/5"],["c#/5","e#/5","g#/5","c#/6"],["f#/5","g#/5","b#/5","d#/6"],["e#/5","g#/5","c#/6","c#/6"]],"g#-major":[["d#/4","f##/4","a#/4","c#/5"],["g#/4","g#/4","g#/4","b#/4"],["f##/4","a#/4","c#/5","d#/5"],["g#/4","g#/4","b#/4","d#/5"],["a#/4","c#/5","d#/5","f##/5"],["g#/4","b#/4","d#/5","g#/5"],["c#/5","d#/5","f##/5","a#/5"],["b#/4","d#/5","g#/5","g#/5"]],"d#-major":[["a#/4","c##/5","e#/5","g#/5"],["d#/5","d#/5","d#/5","f##/5"],["c##/5","e#/5","g#/5","a#/5"],["d#/5","d#/5","f##/5","a#/5"],["e#/5","g#/5","a#/5","c##/6"],["d#/5","f##/5","a#/5","d#/6"],["g#/5","a#/5","c##/6","e#/6"],["f##/5","a#/5","d#/6","d#/6"]],"a#-major":[["e#/4","g##/4","b#/4","d#/5"],["a#/4","a#/4","a#/4","c##/5"],["g##/4","b#/4","d#/5","e#/5"],["a#/4","a#/4","c##/5","e#/5"],["b#/4","d#/5","e#/5","g##/5"],["a#/4","c##/5","e#/5","a#/5"],["d#/5","e#/5","g##/5","b#/5"],["c##/5","e#/5","a#/5","a#/5"]],"f-major":[["c/4","e/4","g/4","bb/4"],["f/4","f/4","f/4","a/4"],["e/4","g/4","bb/4","c/5"],["f/4","f/4","a/4","c/5"],["g/4","bb/4","c/5","e/5"],["f/4","a/4","c/5","f/5"],["bb/4","c/5","e/5","g/5"],["a/4","c/5","f/5","f/5"]],"bb-major":[["f/4","a/4","c/5","eb/5"],["bb/4","bb/4","bb/4","d/5"],["a/4","c/5","eb/5","f/5"],["bb/4","bb/4","d/5","f/5"],["c/5","eb/5","f/5","a/5"],["bb/4","d/5","f/5","bb/5"],["eb/5","f/5","a/5","c/6"],["d/5","f/5","bb/5","bb/5"]],"eb-major":[["bb/4","d/5","f/5","ab/5"],["eb/5","eb/5","eb/5","g/5"],["d/5","f/5","ab/5","bb/5"],["eb/5","eb/5","g/5","bb/5"],["f/5","ab/5","bb/5","d/6"],["eb/5","g/5","bb/5","eb/6"],["ab/5","bb/5","d/6","f/6"],["g/5","bb/5","eb/6","eb/6"]],"ab-major":[["eb/4","g/4","bb/4","db/5"],["ab/4","ab/4","ab/4","c/5"],["g/4","bb/4","db/5","eb/5"],["ab/4","ab/4","c/5","eb/5"],["bb/4","db/5","eb/5","g/5"],["ab/4","c/5","eb/5","ab/5"],["db/5","eb/5","g/5","bb/5"],["c/5","eb/5","ab/5","ab/5"]],"a-minor":[["e/4","g#/4","b/4","d/5"],["a/4","a/4","a/4","c/5"],["g#/4","b/4","d/5","e/5"],["a/4","a/4","c/5","e/5"],["b/4","d/5","e/5","g#/5"],["a/4","c/5","e/5","a/5"],["d/5","e/5","g#/5","b/5"],["c/5","e/5","a/5","a/5"]],"e-minor":[["b/4","d#/5","f#/5","a/5"],["e/5","e/5","e/5","g/5"],["d#/5","f#/5","a/5","b/5"],["e/5","e/5","g/5","b/5"],["f#/5","a/5","b/5","d#/6"],["e/5","g/5","b/5","e/6"],["a/5","b/5","d#/6","f#/6"],["g/5","b/5","e/6","e/6"]],"b-minor":[["f#/4","a#/4","c#/5","e/5"],["b/4","b/4","b/4","d/5"],["a#/4","c#/5","e/5","f#/5"],["b/4","b/4","d/5","f#/5"],["c#/5","e/5","f#/5","a#/5"],["b/4","d/5","f#/5","b/5"],["e/5","f#/5","a#/5","c#/6"],["d/5","f#/5","b/5","b/5"]],"f#-minor":[["c#/4","e#/4","g#/4","b/4"],["f#/4","f#/4","f#/4","a/4"],["e#/4","g#/4","b/4","c#/5"],["f#/4","f#/4","a/4","c#/5"],["g#/4","b/4","c#/5","e#/5"],["f#/4","a/4","c#/5","f#/5"],["b/4","c#/5","e#/5","g#/5"],["a/4","c#/5","f#/5","f#/5"]],"c#-minor":[["g#/4","b#/4","d#/5","f#/5"],["c#/5","c#/5","c#/5","e/5"],["b#/4","d#/5","f#/5","g#/5"],["c#/5","c#/5","e/5","g#/5"],["d#/5","f#/5","g#/5","b#/5"],["c#/5","e/5","g#/5","c#/6"],["f#/5","g#/5","b#/5","d#/6"],["e/5","g#/5","c#/6","c#/6"]],"g#-minor":[["d#/4","f##/4","a#/4","c#/5"],["g#/4","g#/4","g#/4","b/4"],["f##/4","a#/4","c#/5","d#/5"],["g#/4","g#/4","b/4","d#/5"],["a#/4","c#/5","d#/5","f##/5"],["g#/4","b/4","d#/5","g#/5"],["c#/5","d#/5","f##/5","a#/5"],["b/4","d#/5","g#/5","g#/5"]],"d#-minor":[["a#/4","c##/5","e#/5","g#/5"],["d#/5","d#/5","d#/5","f#/5"],["c##/5","e#/5","g#/5","a#/5"],["d#/5","d#/5","f#/5","a#/5"],["e#/5","g#/5","a#/5","c##/6"],["d#/5","f#/5","a#/5","d#/6"],["g#/5","a#/5","c##/6","e#/6"],["f#/5","a#/5","d#/6","d#/6"]],"a#-minor":[["e#/4","g##/4","b#/4","d#/5"],["a#/4","a#/4","a#/4","c#/5"],["g##/4","b#/4","d#/5","e#/5"],["a#/4","a#/4","c#/5","e#/5"],["b#/4","d#/5","e#/5","g##/5"],["a#/4","c#/5","e#/5","a#/5"],["d#/5","e#/5","g##/5","b#/5"],["c#/5","e#/5","a#/5","a#/5"]],"d-minor":[["a/4","c#/5","e/5","g/5"],["d/5","d/5","d/5","f/5"],["c#/5","e/5","g/5","a/5"],["d/5","d/5","f/5","a/5"],["e/5","g/5","a/5","c#/6"],["d/5","f/5","a/5","d/6"],["g/5","a/5","c#/6","e/6"],["f/5","a/5","d/6","d/6"]],"g-minor":[["d/4","f#/4","a/4","c/5"],["g/4","g/4","g/4","bb/4"],["f#/4","a/4","c/5","d/5"],["g/4","g/4","bb/4","d/5"],["a/4","c/5","d/5","f#/5"],["g/4","bb/4","d/5","g/5"],["c/5","d/5","f#/5","a/5"],["bb/4","d/5","g/5","g/5"]],"c-minor":[["g/4","b/4","d/5","f/5"],["c/5","c/5","c/5","eb/5"],["b/4","d/5","f/5","g/5"],["c/5","c/5","eb/5","g/5"],["d/5","f/5","g/5","b/5"],["c/5","eb/5","g/5","c/6"],["f/5","g/5","b/5","d/6"],["eb/5","g/5","c/6","c/6"]],"f-minor":[["c/4","e/4","g/4","bb/4"],["f/4","f/4","f/4","ab/4"],["e/4","g/4","bb/4","c/5"],["f/4","f/4","ab/4","c/5"],["g/4","bb/4","c/5","e/5"],["f/4","ab/4","c/5","f/5"],["bb/4","c/5","e/5","g/5"],["ab/4","c/5","f/5","f/5"]],"bb-minor":[["f/4","a/4","c/5","eb/5"],["bb/4","bb/4","bb/4","db/5"],["a/4","c/5","eb/5","f/5"],["bb/4","bb/4","db/5","f/5"],["c/5","eb/5","f/5","a/5"],["bb/4","db/5","f/5","bb/5"],["eb/5","f/5","a/5","c/6"],["db/5","f/5","bb/5","bb/5"]],"eb-minor":[["bb/4","d/5","f/5","ab/5"],["eb/5","eb/5","eb/5","gb/5"],["d/5","f/5","ab/5","bb/5"],["eb/5","eb/5","gb/5","bb/5"],["f/5","ab/5","bb/5","d/6"],["eb/5","gb/5","bb/5","eb/6"],["ab/5","bb/5","d/6","f/6"],["gb/5","bb/5","eb/6","eb/6"]],"ab-minor":[["eb/4","g/4","bb/4","db/5"],["ab/4","ab/4","ab/4","cb/5"],["g/4","bb/4","db/5","eb/5"],["ab/4","ab/4","cb/5","eb/5"],["bb/4","db/5","eb/5","g/5"],["ab/4","cb/5","eb/5","ab/5"],["db/5","eb/5","g/5","bb/5"],["cb/5","eb/5","ab/5","ab/5"]]};

    function d7KeyId(tonic, mode) {
        const a = tonic.acc;
        const acc = a === 0 ? '' : a > 0 ? '#'.repeat(a) : 'b'.repeat(-a);
        return `${tonic.letter}${acc}-${mode}`;
    }

    function buildDominantSeventh(tonic, mode, withInversions, withResolutions) {
        const preset = D7_PRESETS[d7KeyId(tonic, mode)];
        if (!preset) return null;
        const forms = withInversions ? 4 : 1;
        const Tl = labelLocale === 'ru'
            ? (mode === 'minor' ? 'т' : 'Т')
            : (mode === 'minor' ? 't' : 'T');
        const tonicSuffix = ['3', '53', '53', '6'];
        const notes = [];
        for (let i = 0; i < forms; i++) {
            const d7Keys = presetKeys(preset, i * 2);
            const resKeys = presetKeys(preset, i * 2 + 1);
            if (!d7Keys) continue;
            notes.push({ keys: d7Keys, duration: 'w', label: D7_FORM_LABELS[i][0] });
            if (withResolutions && resKeys) {
                notes.push({
                    keys: resKeys,
                    duration: 'w',
                    label: Tl + tonicSuffix[i],
                    barAfter: i < forms - 1
                });
            }
        }
        if (withResolutions && notes.length) delete notes[notes.length - 1].barAfter;
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: withResolutions ? 'manual' : 'none',
            notes
        };
    }

    // ---------- Ключевые знаки для VexFlow (минор → relative major, как на solfeggio-online) ----------
    function tonicId(tonic) {
        const a = tonic.acc;
        const acc = a === 0 ? '' : a > 0 ? '#'.repeat(a) : 'b'.repeat(-a);
        return `${tonic.letter}${acc}`;
    }

    const MAJOR_KEY_SIG = {
        c: 'C', g: 'G', d: 'D', a: 'A', e: 'E', b: 'B', 'f#': 'F#', 'c#': 'C#',
        'g#': 'G#', 'd#': 'D#', 'a#': 'A#',
        f: 'F', bb: 'Bb', eb: 'Eb', ab: 'Ab', db: 'Db', gb: 'Gb', cb: 'Cb'
    };

    /** Relative major для минора: c-moll → Eb, g-moll → Bb, f-moll → Ab … */
    const MINOR_RELATIVE_MAJOR = {
        a: 'C', e: 'G', b: 'D', 'f#': 'A', 'c#': 'E', 'g#': 'B', 'd#': 'F#', 'a#': 'C#',
        d: 'F', g: 'Bb', c: 'Eb', f: 'Ab', bb: 'Db', eb: 'Gb', ab: 'Cb'
    };

    function keySigFor(tonic, mode) {
        const id = tonicId(tonic);
        if (mode === 'minor') return MINOR_RELATIVE_MAJOR[id] || MAJOR_KEY_SIG[id] || 'C';
        return MAJOR_KEY_SIG[id] || 'C';
    }

    // =====================================================================
    // ПРОГРАММА 1–8 КЛАССА: построения, которых раньше не было в движке.
    // Интервалы от звука и их обращения, все виды септаккордов, вводный
    // септаккорд VII7 и септаккорд II ступени с разрешением, хроматическая
    // гамма, лады народной музыки и пентатоника, разрешение неустойчивых
    // ступеней и опевание устоев.
    // Всё считается формулами — модель эти ноты уже не выдумывает.
    // =====================================================================

    /** Интервал ВНИЗ от base с сохранением буквенного скелета (зеркало buildIntervalUp). */
    function buildIntervalDown(base, degree, semitones) {
        const steps = degree - 1;
        const rawIdx = letterIdx(base.letter) - steps;
        const octave = base.octave + Math.floor(rawIdx / 7);
        const letter = LETTERS[((rawIdx % 7) + 7) % 7];
        const naturalAbs = octave * 12 + LETTER_SEMI[letter];
        const acc = (noteAbs(base) - semitones) - naturalAbs;
        return { letter, acc, octave };
    }

    function sonority(noteList, label, duration, barAfter) {
        const item = { keys: noteList.map(noteKey), duration: duration || 'w' };
        if (label) item.label = label;
        if (barAfter) item.barAfter = true;
        return item;
    }

    function plainBlock(notes, keySignature, barlines) {
        if (!notes || !notes.length) return null;
        if (!notesWritable(notes)) return null;
        return {
            clef: 'treble',
            keySignature: keySignature || 'C',
            timeSignature: '',
            barlines: barlines || 'none',
            notes
        };
    }

    /**
     * Нота ступени лада с выходом за пределы октавы: deg может быть 0 (VII снизу),
     * 8 (октава), 9 и т.д. Возвращает ноту в правильной октаве.
     */
    function degreeNoteExt(tonic, mode, deg) {
        let d = deg;
        let octShift = 0;
        while (d < 1) { d += 7; octShift -= 1; }
        while (d > 7) { d -= 7; octShift += 1; }
        const formula = mode === 'minor' ? SCALE_FORMULAS.minor : SCALE_FORMULAS.major;
        const n = buildIntervalUp({ ...tonic, octave: 4 }, d, formula[d - 1]);
        n.octave += octShift;
        return n;
    }

    function romanFor(deg) {
        let d = deg;
        while (d < 1) d += 7;
        while (d > 7) d -= 7;
        return ROMAN_DEGREES[d - 1];
    }

    // ---------- Интервал от звука ----------
    const PERFECT_DEG_SEMIS = { 1: 0, 4: 5, 5: 7, 8: 12 };
    const MAJOR_DEG_SEMIS = { 2: 2, 3: 4, 6: 9, 7: 11 };

    /** Полутоны интервала по качеству + ступеневой величине. null, если сочетание невозможно. */
    function intervalSemisFor(quality, degree) {
        if (PERFECT_DEG_SEMIS[degree] != null) {
            const p = PERFECT_DEG_SEMIS[degree];
            if (quality === 'perfect' || quality === 'major' || quality === 'minor') return p;
            if (quality === 'aug') return p + 1;
            if (quality === 'dim') return p - 1;
            return null;
        }
        const M = MAJOR_DEG_SEMIS[degree];
        if (M == null) return null;
        if (quality === 'major' || quality === 'perfect') return M;
        if (quality === 'minor') return M - 1;
        if (quality === 'aug') return M + 1;
        if (quality === 'dim') return M - 2;
        return null;
    }

    const RU_DEGREE_WORDS = [
        ['прим', 1], ['секунд', 2], ['терци', 3], ['кварт', 4],
        ['квинт', 5], ['секст', 6], ['септим', 7], ['октав', 8]
    ];

    /** Ступень интервала по русскому слову — с границами слова и от длинных к коротким. */
    function matchRuIntervalDegree(t) {
        const sorted = [...RU_DEGREE_WORDS].sort((a, b) => b[0].length - a[0].length);
        for (const [stem, degree] of sorted) {
            const re = new RegExp(`(?:^|[^а-яё])${stem}[а-яё]*(?=[^а-яё]|$)`, 'i');
            if (re.test(t)) return degree;
        }
        return null;
    }
    const EN_DEGREE_WORDS = [
        ['unison', 1], ['second', 2], ['2nd', 2], ['third', 3], ['3rd', 3],
        ['fourth', 4], ['4th', 4], ['fifth', 5], ['5th', 5], ['sixth', 6], ['6th', 6],
        ['seventh', 7], ['7th', 7], ['octave', 8], ['8th', 8]
    ];

    /**
     * Разбирает название интервала: «б3», «ув.4», «малую сексту», «M3», «A4»,
     * «perfect fifth». Возвращает { degree, semis } либо null.
     * rawQuery нужен из-за регистра: в английской записи M3 (большая) и m3 (малая)
     * различаются ТОЛЬКО регистром, а lowercase-версия запроса это стирает.
     */
    function parseIntervalSpec(rawQuery) {
        const raw = String(rawQuery || '');
        const t = raw.toLowerCase().replace(/ё/g, 'е');

        // Русская краткая запись: б3, м6, ч5, ув4, ум5. Цифра одиночная —
        // «б53»/«ум53» это трезвучия, их сюда пускать нельзя.
        let m = t.match(/(?:^|[^а-я])(ув|ум|ч|б|м)\.?\s*([1-8])(?![0-9/])/);
        if (m) {
            const qmap = { 'ув': 'aug', 'ум': 'dim', 'ч': 'perfect', 'б': 'major', 'м': 'minor' };
            const degree = parseInt(m[2], 10);
            const semis = intervalSemisFor(qmap[m[1]], degree);
            if (semis != null) return { degree, semis };
        }

        // Русская словесная запись: «большая терция», «уменьшённая квинта».
        const ruQual = t.match(/(чист|мал|больш|увелич|уменьш)[а-я]*/);
        const ruDegree = matchRuIntervalDegree(t);
        if (ruDegree != null) {
            const qmap = { 'чист': 'perfect', 'мал': 'minor', 'больш': 'major', 'увелич': 'aug', 'уменьш': 'dim' };
            const quality = ruQual ? qmap[ruQual[1]] : (PERFECT_DEG_SEMIS[ruDegree] != null ? 'perfect' : 'major');
            const semis = intervalSemisFor(quality, ruDegree);
            if (semis != null) return { degree: ruDegree, semis };
        }

        // Английская краткая запись: P5, M3, m6, A4, d5 (регистр значим).
        m = raw.match(/(?:^|[^A-Za-z])(P|M|m|A|d)\s*([1-8])(?![0-9/])/);
        if (m) {
            const qmap = { 'P': 'perfect', 'M': 'major', 'm': 'minor', 'A': 'aug', 'd': 'dim' };
            const degree = parseInt(m[2], 10);
            const semis = intervalSemisFor(qmap[m[1]], degree);
            if (semis != null) return { degree, semis };
        }

        // Английская словесная запись.
        const enQual = t.match(/\b(perfect|major|minor|augmented|diminished|aug|dim)\b/);
        for (const [word, degree] of EN_DEGREE_WORDS) {
            if (!t.includes(word)) continue;
            const qmap = {
                perfect: 'perfect', major: 'major', minor: 'minor',
                augmented: 'aug', aug: 'aug', diminished: 'dim', dim: 'dim'
            };
            const quality = enQual ? qmap[enQual[1]] : (PERFECT_DEG_SEMIS[degree] != null ? 'perfect' : 'major');
            const semis = intervalSemisFor(quality, degree);
            if (semis != null) return { degree, semis };
        }

        return null;
    }

    /** Нота после «от» / «from» — чтобы не поймать случайную букву из слова. */
    function parseNoteAfterFrom(t) {
        const m = /(?:^|[^а-яa-z])(?:от|from)\s+(?:нот[а-я]*\s+|note\s+|the\s+note\s+)?([\s\S]{0,20})/.exec(t);
        if (!m) return null;
        return parseSingleNote(m[1]);
    }

    function wantsIntervalInversion(t) {
        return /обращен|обрати|invert|inversion/i.test(t);
    }

    function intervalDirection(t) {
        return /вниз|нисход|down|descend/i.test(t) ? 'down' : 'up';
    }

    /** Один интервал от звука (+ его обращение по запросу). */
    function buildIntervalFromNote(note, degree, semis, dir, withInversion) {
        return fromNoteWithFallback(note, (root) => {
            const base = { ...root, octave: 4 };
            const lo = dir === 'down' ? buildIntervalDown(base, degree, semis) : base;
            const hi = dir === 'down' ? base : buildIntervalUp(base, degree, semis);
            if (!checkInterval(lo, hi, degree, semis)) return null;
            const notes = [sonority([lo, hi], intervalLabel(lo, hi), 'w', !!withInversion)];
            if (withInversion) {
                const invDeg = 9 - degree;
                const invSemis = 12 - semis;
                const top = buildIntervalUp(hi, invDeg, invSemis);
                if (!checkInterval(hi, top, invDeg, invSemis)) return null;
                notes.push(sonority([hi, top], intervalLabel(hi, top), 'w'));
            }
            return plainBlock(notes, 'C', withInversion ? 'manual' : 'none');
        });
    }

    /** Все простые интервалы от звука вверх: ч1 м2 б2 м3 б3 ч4 ч5 м6 б6 м7 б7 ч8. */
    const ALL_INTERVALS_ORDER = [
        [1, 0], [2, 1], [2, 2], [3, 3], [3, 4], [4, 5],
        [5, 7], [6, 8], [6, 9], [7, 10], [7, 11], [8, 12]
    ];
    function buildAllIntervalsFromNote(note) {
        return fromNoteWithFallback(note, (root) => {
            const base = { ...root, octave: 4 };
            const notes = [];
            for (const [degree, semis] of ALL_INTERVALS_ORDER) {
                const hi = buildIntervalUp(base, degree, semis);
                if (!checkInterval(base, hi, degree, semis)) return null;
                notes.push(sonority([base, hi], intervalLabel(base, hi), 'w'));
            }
            return plainBlock(notes, 'C', 'none');
        });
    }

    // ---------- Трезвучия от звука с обращениями ----------
    const TRIAD_KIND_DEFS = {
        major: { third: 4, fifth: 7, ru: 'Б', en: 'M' },
        minor: { third: 3, fifth: 7, ru: 'М', en: 'm' },
        aug: { third: 4, fifth: 8, ru: 'Ув', en: 'A' },
        dim: { third: 3, fifth: 6, ru: 'Ум', en: 'd' }
    };

    function parseTriadKind(t) {
        if (/увелич|ув\.?\s*53|\baug/i.test(t)) return 'aug';
        if (/уменьш|ум\.?\s*53|\bdim/i.test(t)) return 'dim';
        if (/минорн|мал[а-яё]*\s*трезвуч|(?:^|[^а-яё])м\.?\s*53|\bminor\b/i.test(t)) return 'minor';
        if (/мажорн|больш[а-яё]*\s*трезвуч|(?:^|[^а-яё])б\.?\s*53|\bmajor\b/i.test(t)) return 'major';
        return null;
    }

    /** Трезвучие заданного вида от звука: основной вид (+ обращения по запросу). */
    function buildTriadFromNote(note, kind, withInversions) {
        const def = TRIAD_KIND_DEFS[kind];
        if (!def) return null;
        const prefix = labelLocale === 'ru' ? def.ru : def.en;
        return fromNoteWithFallback(note, (root) => {
            const v = triadVoicings({ ...root, octave: 4 }, def.third, def.fifth);
            const notes = [{ keys: v['53'], duration: 'w', label: prefix + '53' }];
            if (withInversions) {
                notes.push({ keys: v['6'], duration: 'w', label: prefix + '6' });
                notes.push({ keys: v['64'], duration: 'w', label: prefix + '64' });
            }
            return plainBlock(notes, 'C', 'none');
        });
    }

    // ---------- Все виды септаккордов от звука ----------
    // Семь школьных видов: строение задано полутонами от примы до терции/квинты/септимы.
    const SEVENTH_KIND_DEFS = [
        { semis: [4, 7, 11], ru: 'Б.маж7', en: 'maj7' },
        { semis: [4, 7, 10], ru: 'М.маж7', en: '7' },
        { semis: [3, 7, 11], ru: 'Б.мин7', en: 'mMaj7' },
        { semis: [3, 7, 10], ru: 'М.мин7', en: 'm7' },
        { semis: [4, 8, 11], ru: 'Б.ув7', en: 'maj7#5' },
        { semis: [3, 6, 10], ru: 'М.ум7', en: 'm7b5' },
        { semis: [3, 6, 9], ru: 'Ум7', en: 'dim7' }
    ];

    /**
     * Вид септаккорда по школьным названиям → индекс в SEVENTH_KIND_DEFS.
     * «Малый мажорный» = доминантсепт (4+7+10), «большой мажорный» = maj7 (4+7+11) и т.д.
     */
    function parseSeventhKind(t) {
        if (/уменьшенн[а-яё]*\s*септ|(?:^|[^а-яё])ум\.?\s*7(?![0-9])|\bdim7\b|(?:^|[^а-яё])ум7\b/i.test(t)) return 6;
        if (/полууменьш|(?:^|[^а-яё])м\.?\s*ум|m7b5|ø7|half[\s-]?dim/i.test(t)) return 5;
        if (/увеличенн[а-яё]*\s*септ|(?:^|[^а-яё])ув\.?\s*7|\baug7\b/i.test(t)) return 4;
        if (/больш[а-яё]*\s*минорн|(?:^|[^а-яё])б\.?\s*мин\.?\s*7|mm7|m\s*maj7/i.test(t)) return 2;
        if (/малы[а-яё]*\s*минорн|(?:^|[^а-яё])м\.?\s*мин\.?\s*7|\bm7\b(?![b5/])|минорн[а-яё]*\s*септ/i.test(t)) return 3;
        if (/больш[а-яё]*\s*мажорн|(?:^|[^а-яё])б\.?\s*маж\.?\s*7|\bmaj7\b/i.test(t)) return 0;
        if (/малы[а-яё]*\s*мажорн|(?:^|[^а-яё])м\.?\s*маж\.?\s*7|доминант[а-яё]*\s*септ|\bd7\b|dominant\s*7/i.test(t)) return 1;
        if (/септаккорд|seventh\s*chord|\b7th\b/i.test(t)) return 1;
        return null;
    }

    function buildSeventhByKind(note, kindIdx, keySig) {
        const def = SEVENTH_KIND_DEFS[kindIdx];
        if (!def || !note) return null;
        return fromNoteWithFallback(note, (root) => {
            const base = { ...root, octave: 4 };
            const third = buildIntervalUp(base, 3, def.semis[0]);
            const fifth = buildIntervalUp(base, 5, def.semis[1]);
            const seventh = buildIntervalUp(base, 7, def.semis[2]);
            const label = labelLocale === 'ru' ? def.ru : def.en;
            return plainBlock(
                [sonority([base, third, fifth, seventh], label, 'w')],
                keySig || 'C',
                'none'
            );
        });
    }

    function buildSeventhOnDegree(tonic, mode, scaleDeg, kindIdx, t) {
        const form = scaleFormForKey({ tonic, mode }, t);
        const root = scaleDegree(tonic, scaleDeg, form);
        if (!root) return null;
        return buildSeventhByKind({ ...root, octave: 4 }, kindIdx, keySigFor(tonic, mode));
    }

    function buildAllSeventhsFromNote(note) {
        return fromNoteWithFallback(note, (root) => {
            const base = { ...root, octave: 4 };
            const notes = [];
            for (const def of SEVENTH_KIND_DEFS) {
                const third = buildIntervalUp(base, 3, def.semis[0]);
                const fifth = buildIntervalUp(base, 5, def.semis[1]);
                const seventh = buildIntervalUp(base, 7, def.semis[2]);
                notes.push(sonority([base, third, fifth, seventh], labelLocale === 'ru' ? def.ru : def.en, 'w'));
            }
            return plainBlock(notes, 'C', 'none');
        });
    }

    // ---------- VII7 и II7 в тональности с разрешением ----------
    // Строятся из проверенных аппликатур D7_PRESETS, поэтому октавы и
    // голосоведение гарантированно совпадают с эталоном.
    function stepUpKey(vexKey, semis) {
        const p = parseVexKey(vexKey);
        if (!p) return null;
        return noteKey(buildIntervalUp(p, 2, semis));
    }

    function keyHasPc(vexKey, note) {
        const p = parseVexKey(vexKey);
        return !!p && pc(p) === pc(note);
    }

    /**
     * Вводный септаккорд VII7 (VII-II-IV-VI) с разрешением через D65 в тонику.
     * В натуральном мажоре — малый (полууменьшённый), в миноре и гармоническом
     * мажоре — уменьшённый.
     */
    function buildViiSeventhInKey(tonic, mode, harmonicMajor) {
        const preset = D7_PRESETS[d7KeyId(tonic, mode)];
        if (!preset) return null;
        const d65 = presetKeys(preset, 2);
        const resolution = presetKeys(preset, 3);
        if (!d65 || !resolution || d65.length !== 4) return null;

        const fifthDegree = scaleDegree(tonic, 5, 'major');
        if (!keyHasPc(d65[3], fifthDegree)) return null; // страховка: V должна быть верхним голосом

        // V -> VI: в мажоре целый тон, в миноре и в гармоническом мажоре (bVI) — полутон.
        const stepToSixth = (mode === 'major' && !harmonicMajor) ? 2 : 1;
        const sixth = stepUpKey(d65[3], stepToSixth);
        if (!sixth) return null;

        const vii7 = d65.slice(0, 3).concat([sixth]);
        const tonicLabel = labelLocale === 'ru'
            ? (mode === 'minor' ? 'т53' : 'Т53')
            : (mode === 'minor' ? 't53' : 'T53');
        const notes = [
            { keys: vii7, duration: 'w', label: 'VII7' },
            { keys: d65, duration: 'w', label: 'D65' },
            { keys: resolution, duration: 'w', label: tonicLabel }
        ];
        return plainBlock(notes, keySigFor(tonic, mode), 'none');
    }

    /**
     * Септаккорд II ступени (II-IV-VI-I) с разрешением через D43 в тонику.
     * В мажоре малый минорный, в миноре — полууменьшённый.
     */
    function buildSecondSeventhInKey(tonic, mode, harmonicMajor) {
        const preset = D7_PRESETS[d7KeyId(tonic, mode)];
        if (!preset) return null;
        const d43 = presetKeys(preset, 4);
        const resolution = presetKeys(preset, 5);
        if (!d43 || !resolution || d43.length !== 4) return null;

        const fifthDegree = scaleDegree(tonic, 5, 'major');
        if (!keyHasPc(d43[2], fifthDegree)) return null;       // V — третий голос
        if (!keyHasPc(d43[3], { ...tonic, octave: 4 })) {
            // Верхний голос D43 — вводный тон (VII), на полутон ниже тоники.
            const p = parseVexKey(d43[3]);
            const tonicPc = pc({ ...tonic, octave: 4 });
            if (!p || ((tonicPc - pc(p) + 12) % 12) !== 1) return null;
        }

        const stepToSixth = (mode === 'major' && !harmonicMajor) ? 2 : 1;
        const sixth = stepUpKey(d43[2], stepToSixth);
        const toTonic = stepUpKey(d43[3], 1);
        if (!sixth || !toTonic) return null;

        const ii7 = [d43[0], d43[1], sixth, toTonic];
        const tonicLabel = labelLocale === 'ru'
            ? (mode === 'minor' ? 'т53' : 'Т53')
            : (mode === 'minor' ? 't53' : 'T53');
        const notes = [
            { keys: ii7, duration: 'w', label: 'II7' },
            { keys: d43, duration: 'w', label: 'D43' },
            { keys: resolution, duration: 'w', label: tonicLabel }
        ];
        return plainBlock(notes, keySigFor(tonic, mode), 'none');
    }

    // ---------- Хроматическая гамма ----------
    /**
     * Правописание (школьное правило):
     *  • вверх — проходящий звук = ПОВЫШЕНИЕ нижней ступени;
     *    исключение: в мажоре между V и VI пишется пониженная VI,
     *                в миноре между I и II пишется пониженная II;
     *  • вниз — проходящий звук = ПОНИЖЕНИЕ верхней ступени;
     *    исключение: между V и IV пишется повышенная IV (и в мажоре, и в миноре).
     */
    function chromaticDegreeChain(tonic, mode) {
        const chain = [];
        for (let deg = 1; deg <= 8; deg++) {
            chain.push({ deg, note: degreeNoteExt(tonic, mode, deg) });
        }
        return chain;
    }

    function buildChromaticScale(tonic, mode, dir) {
        const chain = chromaticDegreeChain(tonic, mode);
        const out = [];
        if (dir === 'down') {
            for (let i = chain.length - 1; i > 0; i--) {
                const cur = chain[i];
                const prev = chain[i - 1];
                out.push(cur.note);
                if (noteAbs(cur.note) - noteAbs(prev.note) !== 2) continue;
                const prevDeg = ((prev.deg - 1) % 7) + 1;
                if (prevDeg === 4) out.push({ ...prev.note, acc: prev.note.acc + 1 });
                else out.push({ ...cur.note, acc: cur.note.acc - 1 });
            }
            out.push(chain[0].note);
        } else {
            for (let i = 0; i < chain.length - 1; i++) {
                const cur = chain[i];
                const next = chain[i + 1];
                out.push(cur.note);
                if (noteAbs(next.note) - noteAbs(cur.note) !== 2) continue;
                const curDeg = ((cur.deg - 1) % 7) + 1;
                const exception = mode === 'major' ? curDeg === 5 : curDeg === 1;
                if (exception) out.push({ ...next.note, acc: next.note.acc - 1 });
                else out.push({ ...cur.note, acc: cur.note.acc + 1 });
            }
            out.push(chain[chain.length - 1].note);
        }
        const notes = out.map(n => ({ keys: [noteKey(n)], duration: 'q' }));
        return plainBlock(notes, keySigFor(tonic, mode), 'none');
    }

    // ---------- Лады народной музыки и пентатоника ----------
    const MODE_DEFS = {
        ionian: { semis: [0, 2, 4, 5, 7, 9, 11], ru: 'Ионийский', en: 'Ionian' },
        dorian: { semis: [0, 2, 3, 5, 7, 9, 10], ru: 'Дорийский', en: 'Dorian' },
        phrygian: { semis: [0, 1, 3, 5, 7, 8, 10], ru: 'Фригийский', en: 'Phrygian' },
        lydian: { semis: [0, 2, 4, 6, 7, 9, 11], ru: 'Лидийский', en: 'Lydian' },
        mixolydian: { semis: [0, 2, 4, 5, 7, 9, 10], ru: 'Миксолидийский', en: 'Mixolydian' },
        aeolian: { semis: [0, 2, 3, 5, 7, 8, 10], ru: 'Эолийский', en: 'Aeolian' },
        locrian: { semis: [0, 1, 3, 5, 6, 8, 10], ru: 'Локрийский', en: 'Locrian' },
        // В пентатонике две ступени пропущены, поэтому буквы берём по РЕАЛЬНЫМ
        // ступеням (иначе 4-й звук мажорной пентатоники пришлось бы писать как fis###).
        pentatonicMajor: { semis: [0, 2, 4, 7, 9], degrees: [1, 2, 3, 5, 6], ru: 'Мажорная пентатоника', en: 'Major pentatonic' },
        pentatonicMinor: { semis: [0, 3, 5, 7, 10], degrees: [1, 3, 4, 5, 7], ru: 'Минорная пентатоника', en: 'Minor pentatonic' },
        doubleHarmonicMajor: { semis: [0, 1, 4, 5, 7, 8, 11], ru: 'Дважды гармонический мажор', en: 'Double harmonic major' },
        wholeTone: { semis: [0, 2, 4, 6, 8, 10], ru: 'Целотоновый лад', en: 'Whole-tone scale' }
    };

    function parseModeName(t) {
        if (/пентатоник|pentatonic/.test(t)) {
            return /минорн|minor|мал/.test(t) ? 'pentatonicMinor' : 'pentatonicMajor';
        }
        if (/дорийск|dorian/.test(t)) return 'dorian';
        if (/фригийск|phrygian/.test(t)) return 'phrygian';
        if (/лидийск|lydian/.test(t)) return 'lydian';
        if (/миксолидийск|mixolydian/.test(t)) return 'mixolydian';
        if (/локрийск|locrian/.test(t)) return 'locrian';
        if (/эолийск|aeolian/.test(t)) return 'aeolian';
        if (/ионийск|ionian/.test(t)) return 'ionian';
        if (/дважды\s*гармоническ|double\s*harmonic/.test(t)) return 'doubleHarmonicMajor';
        if (/целотон|whole[\s-]?tone/.test(t)) return 'wholeTone';
        return null;
    }

    function buildModeScale(tonic, modeName) {
        const def = MODE_DEFS[modeName];
        if (!def) return null;
        return fromNoteWithFallback(tonic, (root) => {
            const base = { ...root, octave: 4 };
            const degreeOf = (idx) => (def.degrees ? def.degrees[idx] : idx + 1);
            const notes = def.semis.map((s, idx) => ({
                keys: [noteKey(buildIntervalUp(base, degreeOf(idx), s))],
                duration: 'q',
                label: ROMAN_DEGREES[degreeOf(idx) - 1]
            }));
            // Замыкающая тоника октавой выше: всегда 8-я ступень (в пентатонике
            // ступеней пять, но октава остаётся октавой — та же буква выше).
            notes.push({ keys: [noteKey(buildIntervalUp(base, 8, 12))], duration: 'q', label: 'I' });
            return plainBlock(notes, 'C', 'none');
        });
    }

    function modeLabel(modeName) {
        const def = MODE_DEFS[modeName];
        if (!def) return '';
        return labelLocale === 'ru' ? def.ru : def.en;
    }

    // ---------- Разрешение неустойчивых ступеней и опевание ----------
    const UNSTABLE_RESOLUTIONS = [[2, 1], [4, 3], [6, 5], [7, 8]];

    function buildUnstableResolutions(tonic, mode) {
        const notes = [];
        UNSTABLE_RESOLUTIONS.forEach(([from, to], idx) => {
            notes.push({
                keys: [noteKey(degreeNoteExt(tonic, mode, from))],
                duration: 'h',
                label: romanFor(from)
            });
            notes.push({
                keys: [noteKey(degreeNoteExt(tonic, mode, to))],
                duration: 'h',
                label: to === 8 ? ROMAN_DEGREES[7] : romanFor(to),
                barAfter: idx < UNSTABLE_RESOLUTIONS.length - 1
            });
        });
        return plainBlock(notes, keySigFor(tonic, mode), 'manual');
    }

    function buildOpevanie(tonic, mode) {
        const notes = [];
        [1, 3, 5].forEach((stable, idx) => {
            [stable + 1, stable - 1, stable].forEach((deg, k) => {
                notes.push({
                    keys: [noteKey(degreeNoteExt(tonic, mode, deg))],
                    duration: 'q',
                    label: romanFor(deg),
                    barAfter: k === 2 && idx < 2
                });
            });
        });
        return plainBlock(notes, keySigFor(tonic, mode), 'manual');
    }

    // ---------- Парсер запроса ----------
    const RU_NOTES = [
        ['до-диез', { letter: 'c', acc: 1 }], ['до диез', { letter: 'c', acc: 1 }], ['до д', { letter: 'c', acc: 1 }],
        ['ре-бемоль', { letter: 'd', acc: -1 }], ['ре бемоль', { letter: 'd', acc: -1 }], ['ре б', { letter: 'd', acc: -1 }],
        ['ре-диез', { letter: 'd', acc: 1 }], ['ре диез', { letter: 'd', acc: 1 }], ['ре д', { letter: 'd', acc: 1 }],
        ['ми-бемоль', { letter: 'e', acc: -1 }], ['ми бемоль', { letter: 'e', acc: -1 }], ['ми бе', { letter: 'e', acc: -1 }], ['ми-бе', { letter: 'e', acc: -1 }], ['ми б', { letter: 'e', acc: -1 }],
        ['фа-диез', { letter: 'f', acc: 1 }], ['фа диез', { letter: 'f', acc: 1 }], ['фа д', { letter: 'f', acc: 1 }],
        ['соль-бемоль', { letter: 'g', acc: -1 }], ['соль бемоль', { letter: 'g', acc: -1 }], ['соль б', { letter: 'g', acc: -1 }],
        ['соль-диез', { letter: 'g', acc: 1 }], ['соль диез', { letter: 'g', acc: 1 }], ['соль д', { letter: 'g', acc: 1 }],
        ['ля-бемоль', { letter: 'a', acc: -1 }], ['ля бемоль', { letter: 'a', acc: -1 }], ['ля б', { letter: 'a', acc: -1 }],
        ['ля-диез', { letter: 'a', acc: 1 }], ['ля диез', { letter: 'a', acc: 1 }], ['ля д', { letter: 'a', acc: 1 }],
        ['си-бемоль', { letter: 'b', acc: -1 }], ['си бемоль', { letter: 'b', acc: -1 }], ['си бе', { letter: 'b', acc: -1 }], ['си-бе', { letter: 'b', acc: -1 }], ['си б', { letter: 'b', acc: -1 }],
        ['до', { letter: 'c', acc: 0 }], ['ре', { letter: 'd', acc: 0 }], ['ми', { letter: 'e', acc: 0 }],
        ['фа', { letter: 'f', acc: 0 }], ['соль', { letter: 'g', acc: 0 }], ['ля', { letter: 'a', acc: 0 }],
        ['си', { letter: 'b', acc: 0 }]
    ];

    // Немецкие/латинские названия для форм "g-moll", "fis-moll", "es-dur" и т.п.
    const GER_NOTES = {
        'cis': { letter: 'c', acc: 1 }, 'dis': { letter: 'd', acc: 1 }, 'eis': { letter: 'e', acc: 1 },
        'fis': { letter: 'f', acc: 1 }, 'gis': { letter: 'g', acc: 1 }, 'ais': { letter: 'a', acc: 1 },
        'des': { letter: 'd', acc: -1 }, 'es': { letter: 'e', acc: -1 }, 'ges': { letter: 'g', acc: -1 },
        'as': { letter: 'a', acc: -1 }, 'ces': { letter: 'c', acc: -1 }, 'bes': { letter: 'b', acc: -1 },
        'h': { letter: 'b', acc: 0 }, 'b': { letter: 'b', acc: -1 }
    };

    function isCyr(ch) { return !!ch && /[а-яё]/i.test(ch); }

    /**
     * Находит ПЕРВОЕ отдельно стоящее русское слоговое название ноты.
     * Проверка границ слова обязательна, иначе «до» ловится внутри «доминанта»,
     * а «ля» — внутри «для» и т.п. (\b в JS не работает с кириллицей).
     */
    function findRuNote(t) {
        for (let i = 0; i < t.length; i++) {
            if (isCyr(t[i - 1])) continue; // начало должно быть на границе слова
            for (const [word, note] of RU_NOTES) {
                if (t.startsWith(word, i) && !isCyr(t[i + word.length])) {
                    return { ...note };
                }
            }
        }
        return null;
    }

    function parseAccSuffix(s) {
        // латинские суффиксы '#', 'b', 'is', 'es'
        if (/##|x/.test(s)) return 2;
        if (/#|is/.test(s)) return 1;
        if (/bb|eses/.test(s)) return -2;
        if (/b|es/.test(s)) return -1;
        return 0;
    }

    function detectForm(t) {
        if (/гармоническ|harmonic|гарм\.?\b/.test(t)) return 'harmonic';
        if (/мелодическ|melodic|мелод\.?\b/.test(t)) return 'melodic';
        if (/натуральн|natural|натур\.?\b/.test(t)) return 'natural';
        return null;
    }

    function parseKey(t) {
        // 1) Русские слоговые названия + мажор/минор
        let tonic = findRuNote(t);
        let mode = null;
        if (/мажор|major|dur\b/.test(t)) mode = 'major';
        else if (/минор|minor|moll\b|mol\b/.test(t)) mode = 'minor';

        // 2) Формы "g-moll", "c-dur", "fis-moll", "es-dur", "b-dur"
        if (!tonic || mode === null) {
            const m = t.match(/\b([a-h](?:is|es|s|#|b|bb|##)?)\s*[-\s]?\s*(dur|moll|mol)\b/);
            if (m) {
                const raw = m[1];
                const md = m[2].startsWith('m') ? 'minor' : 'major';
                let note = null;
                if (GER_NOTES[raw]) note = { ...GER_NOTES[raw] };
                else {
                    const L = raw[0] === 'h' ? 'b' : raw[0];
                    if (LETTERS.includes(L)) note = { letter: L, acc: parseAccSuffix(raw.slice(1)) };
                }
                if (note) { tonic = tonic || note; if (mode === null) mode = md; }
            }
        }

        // 3) Английское "C major", "a minor", "Bb minor", "f# major"
        if (!tonic) {
            const m = t.match(/\b([a-g])\s*(#|b|sharp|flat)?\s*(major|minor|maj|min)\b/);
            if (m) {
                const L = m[1];
                let acc = 0;
                if (m[2]) acc = /#|sharp/.test(m[2]) ? 1 : -1;
                tonic = { letter: L, acc };
                if (mode === null) mode = /min/.test(m[3]) ? 'minor' : 'major';
            }
        }

        // «ми бе», «в до» без «минор» — по умолчанию мажор
        if (tonic && mode === null && !/минор|minor|moll\b|mol\b/.test(t)) mode = 'major';

        if (!tonic || mode === null) return null;
        return { tonic: { ...tonic, octave: 4 }, mode };
    }

    const KEY_SHARP_COUNT = {
        C: 0, F: 0, Bb: 0, Eb: 0, Ab: 0, Db: 0, Gb: 0, Cb: 0,
        G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, 'G#': 8, 'D#': 9, 'A#': 10
    };
    const KEY_FLAT_COUNT = {
        C: 0, G: 0, D: 0, A: 0, E: 0, B: 0, 'F#': 0, 'C#': 0, 'G#': 0, 'D#': 0, 'A#': 0,
        F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7
    };
    const SHARP_ORDER_EN = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
    const FLAT_ORDER_EN = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
    const SHARP_ORDER_RU = ['фа', 'до', 'соль', 'ре', 'ля', 'ми', 'си'];
    const FLAT_ORDER_RU = ['си', 'ми', 'ля', 'ре', 'соль', 'до', 'фа'];
    const RU_NOTE_NAMES = { c: 'до', d: 'ре', e: 'ми', f: 'фа', g: 'соль', a: 'ля', b: 'си' };

    function tonalityDisplayName(tonic, mode, ru) {
        const accRu = tonic.acc === 1 ? '-диез' : tonic.acc === -1 ? '-бемоль' : tonic.acc < 0 ? '-бемоль'.repeat(-tonic.acc) : tonic.acc > 1 ? '-диез'.repeat(tonic.acc) : '';
        if (ru) {
            const n = (RU_NOTE_NAMES[tonic.letter] || tonic.letter) + accRu;
            return mode === 'minor' ? `${n} минор` : `${n} мажор`;
        }
        const accEn = tonic.acc === 0 ? '' : tonic.acc > 0 ? '#'.repeat(tonic.acc) : 'b'.repeat(-tonic.acc);
        const n = `${tonic.letter.toUpperCase()}${accEn}`;
        return mode === 'minor' ? `${n} minor` : `${n} major`;
    }

    function isKeySignatureQuery(t) {
        if (/построй|постро|build|draw|сделай|напиши|цепоч|тритон|d7|д7|гамм|scale|характерн|х\.\s*и/i.test(t)) return false;
        if (!parseKey(t)) return false;
        return /(?:сколько|как\s*много|how\s*many)\s*(?:знаков?|бемол|диез|бекар|sharps?|flats?)/i.test(t)
            || /(?:какой|какие)\s*(?:ключ|знаки)/i.test(t)
            || /key\s*signature/i.test(t)
            || /знаков?\s*(?:при\s*ключе|в\s*тональност)/i.test(t);
    }

    function formatKeySignatureAnswer(key, ru) {
        const name = tonalityDisplayName(key.tonic, key.mode, ru);
        const sig = keySigFor(key.tonic, key.mode);
        const sharps = KEY_SHARP_COUNT[sig] ?? 0;
        const flats = KEY_FLAT_COUNT[sig] ?? 0;
        const sharpList = SHARP_ORDER_EN.slice(0, sharps).map(s => s + '#').join(', ');
        const flatList = FLAT_ORDER_EN.slice(0, flats).map(s => s + 'b').join(', ');
        const sharpRu = SHARP_ORDER_RU.slice(0, sharps).map(n => `${n}-диез`).join(', ');
        const flatRu = FLAT_ORDER_RU.slice(0, flats).map(n => `${n}-бемоль`).join(', ');

        if (ru) {
            if (sharps === 0 && flats === 0) {
                return `В **${name}** знаков при ключе нет.`;
            }
            const relHint = key.mode === 'minor'
                ? ` (для минора — ключ относительного мажора, ${sig})`
                : '';
            if (sharps > 0) {
                return `В **${name}** **${sharps} ${sharps === 1 ? 'диез' : 'диеза'}** при ключе: ${sharpRu}.${relHint}`;
            }
            return `В **${name}** **${flats} ${flats === 1 ? 'бемоль' : 'бемоля'}** при ключе: ${flatRu}.${relHint}`;
        }

        if (sharps === 0 && flats === 0) {
            return `**${name}** has no key signature.`;
        }
        if (sharps > 0) {
            return `**${name}** has **${sharps} sharp${sharps > 1 ? 's' : ''}**: ${sharpList}.`;
        }
        return `**${name}** has **${flats} flat${flats > 1 ? 's' : ''}**: ${flatList}.`;
    }

    // ---------- Мгновенные точные ответы о тональностях и интервалах ----------
    // Такие вопросы («параллельная тональность», «сколько знаков», «обращение б3»)
    // считаются формулами, поэтому модель к ним не подключается вообще.

    function intervalNameFor(degree, semis, ru) {
        const table = ru ? INTERVAL_QUALITY_RU : INTERVAL_QUALITY_EN;
        return (table[degree] && table[degree][semis]) || '';
    }

    function relativeKeyOf(key) {
        const base = { ...key.tonic, octave: 4 };
        return key.mode === 'major'
            ? { tonic: buildIntervalDown(base, 3, 3), mode: 'minor' }
            : { tonic: buildIntervalUp(base, 3, 3), mode: 'major' };
    }

    function sameNameKeyOf(key) {
        return { tonic: { ...key.tonic }, mode: key.mode === 'major' ? 'minor' : 'major' };
    }

    /** Энгармоническая замена тоники: до-диез -> ре-бемоль (минимум знаков). */
    function enharmonicTonic(tonic) {
        const target = pc({ ...tonic, octave: 4 });
        let best = null;
        for (const L of LETTERS) {
            if (L === tonic.letter) continue;
            for (let acc = -2; acc <= 2; acc++) {
                const cand = { letter: L, acc, octave: 4 };
                if (pc(cand) !== target) continue;
                if (!best || Math.abs(acc) < Math.abs(best.acc)) best = cand;
            }
        }
        return best;
    }

    function knownKeyId(tonic, mode) {
        const id = tonicId(tonic);
        return mode === 'minor' ? !!MINOR_RELATIVE_MAJOR[id] : !!MAJOR_KEY_SIG[id];
    }

    const KEYS_BY_SHARPS = [
        ['c', 'a'], ['g', 'e'], ['d', 'b'], ['a', 'f#'],
        ['e', 'c#'], ['b', 'g#'], ['f#', 'd#'], ['c#', 'a#']
    ];
    const KEYS_BY_FLATS = [
        ['c', 'a'], ['f', 'd'], ['bb', 'g'], ['eb', 'c'],
        ['ab', 'f'], ['db', 'bb'], ['gb', 'eb'], ['cb', 'ab']
    ];

    function tonicFromId(id) {
        const m = String(id).match(/^([a-g])(#{1,2}|b{1,2})?$/);
        if (!m) return null;
        return { letter: m[1], acc: m[2] ? parseAccSuffix(m[2]) : 0, octave: 4 };
    }

    function ruPlural(n, one, few, many) {
        const mod100 = n % 100;
        const mod10 = n % 10;
        if (mod100 >= 11 && mod100 <= 14) return many;
        if (mod10 === 1) return one;
        if (mod10 >= 2 && mod10 <= 4) return few;
        return many;
    }

    /** «Какая тональность с 3 диезами?» */
    function answerKeyByAccidentals(t, ru) {
        const words = {
            'ноль': 0, 'один': 1, 'одна': 1, 'одним': 1, 'одну': 1,
            'два': 2, 'две': 2, 'двум': 2, 'двух': 2,
            'три': 3, 'трем': 3, 'трех': 3,
            'четыре': 4, 'четырем': 4, 'четырех': 4,
            'пять': 5, 'пяти': 5, 'пяти': 5,
            'шесть': 6, 'шести': 6,
            'семь': 7, 'семи': 7
        };
        let m = t.match(/(?:по|с)\s*(\d+|один|одна|одним|одну|два|две|двум|двух|три|трем|трех|четыре|четырем|четырех|пять|пяти|шесть|шести|семь|семи|ноль)\s*(?:знаков?\s*)?(диез(?:а|ов|ам|ами)?|бемол(?:я|ей|ам|ами)?|sharps?|flats?)/);
        if (!m) m = t.match(/(\d+|один|одна|одним|одну|два|две|двум|двух|три|трем|трех|четыре|четырем|четырех|пять|пяти|шесть|шести|семь|семи|ноль)\s*(?:знаков?\s*)?(диез(?:а|ов|ам|ами)?|бемол(?:я|ей|ам|ами)?|sharps?|flats?)/);
        if (!m) return null;
        const count = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (words[m[1]] != null ? words[m[1]] : null);
        if (count == null || count < 0 || count > 7) return null;
        const isSharp = /диез|sharp/i.test(m[2]);
        const pair = (isSharp ? KEYS_BY_SHARPS : KEYS_BY_FLATS)[count];
        if (!pair) return null;
        const majTonic = tonicFromId(pair[0]);
        const minTonic = tonicFromId(pair[1]);
        if (!majTonic || !minTonic) return null;
        const majName = tonalityDisplayName(majTonic, 'major', ru);
        const minName = tonalityDisplayName(minTonic, 'minor', ru);
        const order = isSharp
            ? (ru ? SHARP_ORDER_RU : SHARP_ORDER_EN).slice(0, count)
            : (ru ? FLAT_ORDER_RU : FLAT_ORDER_EN).slice(0, count);
        const suffix = ru ? (isSharp ? '-диез' : '-бемоль') : (isSharp ? '#' : 'b');
        const list = order.map(n => n + suffix).join(', ');

        if (ru) {
            if (count === 0) return { text: `Без ключевых знаков — **до мажор** и **ля минор** (параллельные тональности).` };
            const word = isSharp
                ? ruPlural(count, 'диез', 'диеза', 'диезов')
                : ruPlural(count, 'бемоль', 'бемоля', 'бемолей');
            return { text: `**${count} ${word}** при ключе — это **${majName}** и **${minName}** (параллельные тональности). Знаки по порядку: ${list}.` };
        }
        if (count === 0) return { text: `No key signature — **C major** and **A minor** (relative keys).` };
        return { text: `**${count} ${isSharp ? 'sharp' : 'flat'}${count > 1 ? 's' : ''}** means **${majName}** and **${minName}** (relative keys). Order: ${list}.` };
    }

    /** «Параллельная / одноимённая / энгармонически равная тональность для X» */
    function answerRelatedKey(t, rawQuery, ru) {
        const key = parseKey(t);
        if (!key) return null;
        const wantsRelative = ru
            ? /параллельн[а-яё]*\s*(?:тональност|мажор|минор|гамм)/.test(t)
            : /relative\s*(?:key|major|minor|tonality)/.test(t);
        const wantsSameName = ru
            ? /одноимен|одноимён/.test(t)
            : /parallel\s*(?:key|major|minor)|same[\s-]?name\s*key/.test(t);
        const wantsEnharmonic = /энгармонич[а-яё]*\s*(?:равн|тональност)|enharmonic\w*\s*(?:equal\s*)?(?:key|tonality)/.test(t);

        const srcName = tonalityDisplayName(key.tonic, key.mode, ru);

        if (wantsRelative) {
            const rel = relativeKeyOf(key);
            if (!knownKeyId(rel.tonic, rel.mode)) return null;
            const relName = tonalityDisplayName(rel.tonic, rel.mode, ru);
            const sig = keySigFor(key.tonic, key.mode);
            const sharps = KEY_SHARP_COUNT[sig] ?? 0;
            const flats = KEY_FLAT_COUNT[sig] ?? 0;
            const signs = ru
                ? (sharps ? `${sharps} ${ruPlural(sharps, 'диез', 'диеза', 'диезов')}` : flats ? `${flats} ${ruPlural(flats, 'бемоль', 'бемоля', 'бемолей')}` : 'без знаков')
                : (sharps ? `${sharps} sharp${sharps > 1 ? 's' : ''}` : flats ? `${flats} flat${flats > 1 ? 's' : ''}` : 'no accidentals');
            return {
                text: ru
                    ? `Параллельная тональность для **${srcName}** — **${relName}**. У них одинаковые ключевые знаки (${signs}), а тоники отстоят на малую терцию.`
                    : `The relative key of **${srcName}** is **${relName}**. Same key signature (${signs}); the tonics are a minor third apart.`
            };
        }

        if (wantsSameName) {
            const same = sameNameKeyOf(key);
            if (!knownKeyId(same.tonic, same.mode)) return null;
            return {
                text: ru
                    ? `Одноимённая тональность для **${srcName}** — **${tonalityDisplayName(same.tonic, same.mode, ru)}**: та же тоника, другой лад. Ключевые знаки отличаются на три знака.`
                    : `The parallel (same-tonic) key of **${srcName}** is **${tonalityDisplayName(same.tonic, same.mode, ru)}**: same tonic, opposite mode. The signatures differ by three accidentals.`
            };
        }

        if (wantsEnharmonic) {
            const sig = keySigFor(key.tonic, key.mode);
            const total = Math.max(KEY_SHARP_COUNT[sig] ?? 0, KEY_FLAT_COUNT[sig] ?? 0);
            if (total < 5) {
                return {
                    text: ru
                        ? `У **${srcName}** нет практической энгармонической замены: энгармонически равные тональности появляются начиная с пяти ключевых знаков (например до-диез мажор = ре-бемоль мажор).`
                        : `**${srcName}** has no practical enharmonic equivalent: enharmonic keys start at five accidentals (for example C# major = Db major).`
                };
            }
            const alt = enharmonicTonic(key.tonic);
            if (!alt || !knownKeyId(alt, key.mode)) return null;
            return {
                text: ru
                    ? `Энгармонически равная тональность для **${srcName}** — **${tonalityDisplayName(alt, key.mode, ru)}**: звучат одинаково, пишутся по-разному.`
                    : `The enharmonic equivalent of **${srcName}** is **${tonalityDisplayName(alt, key.mode, ru)}**: identical in sound, different in notation.`
            };
        }
        return null;
    }

    /** «Обращение большой терции» / «inversion of M3» */
    function answerIntervalInversion(t, rawQuery, ru) {
        if (!/обращен|inversion|invert/.test(t)) return null;
        if (CHORD_WORDS_RE.test(t)) return null;
        if (/от\s|from\s/.test(t)) return null; // это построение, а не вопрос
        const spec = parseIntervalSpec(rawQuery);
        if (!spec) return null;
        const invDeg = 9 - spec.degree;
        const invSemis = 12 - spec.semis;
        const src = intervalNameFor(spec.degree, spec.semis, ru);
        const dst = intervalNameFor(invDeg, invSemis, ru);
        if (!src || !dst) return null;
        return {
            text: ru
                ? `Обращение **${src}** (${spec.semis} ${ruPlural(spec.semis, 'полутон', 'полутона', 'полутонов')}) — это **${dst}** (${invSemis} ${ruPlural(invSemis, 'полутон', 'полутона', 'полутонов')}). Правило: ступеневая величина = 9 − ${spec.degree}, качество меняется на противоположное, сумма полутонов = 12.`
                : `The inversion of **${src}** (${spec.semis} semitones) is **${dst}** (${invSemis} semitones). Rule: new size = 9 − ${spec.degree}, quality flips, and the semitone totals add up to 12.`
        };
    }

    /** Мгновенный текстовый ответ без нотации (ключевые знаки, родство тональностей, обращение интервала). */
    function buildTheoryQuickAnswer(rawQuery) {
        if (!rawQuery || typeof rawQuery !== 'string') return null;
        const t = rawQuery.toLowerCase().replace(/ё/g, 'е');
        const ru = labelLocale === 'ru' || /[а-яё]/i.test(rawQuery);

        // Просьбы что-то ПОСТРОИТЬ обслуживает нотный движок, а не текстовый ответ.
        const isBuildRequest = /построй|постро|сделай|напиши|выведи|нарисуй|покажи|build|draw|write|construct|show/i.test(t);

        if (isKeySignatureQuery(t)) {
            const key = parseKey(t);
            if (!key) return null;
            return { text: formatKeySignatureAnswer(key, ru) };
        }
        if (!isBuildRequest) {
            const identInt = answerIdentifyInterval(t, rawQuery, ru);
            if (identInt) return identInt;
            const identChord = answerIdentifyChord(t, rawQuery, ru);
            if (identChord) return identChord;
            const keyForDeg = parseKey(t);
            if (keyForDeg) {
                const charDeg = answerCharacteristicDegrees(t, keyForDeg, ru);
                if (charDeg) return charDeg;
            }
            const related = answerRelatedKey(t, rawQuery, ru);
            if (related) return related;
            const byAcc = answerKeyByAccidentals(t, ru);
            if (byAcc) return byAcc;
            const inv = answerIntervalInversion(t, rawQuery, ru);
            if (inv) return inv;
        }
        return null;
    }

    /** Слова, из-за которых «терцию/сексту» нельзя понимать как интервал (это аккорд). */
    const CHORD_WORDS_RE = /трезвуч|секстаккорд|квартсекст|терцкварт|квинтсекст|секундаккорд|септаккорд|аккорд|triad|chord|seventh/i;

    function isChromaticScaleQuery(t) {
        return /хроматическ[а-яё]*\s*(?:гамм|звукоряд|последовательн|вверх|вниз)|chromatic\s*scale/i.test(t);
    }

    function isViiSeventhQuery(t) {
        return /вводн[а-яё]*\s*септ|\bvii\s*7|\bvii7|уменьшенн[а-яё]*\s*вводн|уменьшённ[а-яё]*\s*вводн|leading[\s-]?tone\s*seventh|diminished\s*seventh\s*chord\s*(?:in|на)/i.test(t);
    }

    function isSecondSeventhQuery(t) {
        return /септаккорд[а-яё]*\s*(?:втор[а-яё]*|ii|2)\s*ступен|\bii\s*7\b|\bii7\b|supertonic\s*seventh|second[\s-]?degree\s*seventh/i.test(t);
    }

    function isUnstableResolutionQuery(t) {
        return /разрешени[а-яё]*\s*неустойчив|неустойчив[а-яё]*\s*ступен[а-яё]*\s*(?:в|с)?\s*разрешен|разреши[а-яё]*\s*неустойчив|resolve\s*(?:the\s*)?unstable/i.test(t);
    }

    function isOpevanieQuery(t) {
        return /опеван|опой|surround\w*\s*tone|encircl/i.test(t);
    }

    /**
     * Задания «от звука» — тональность не нужна: интервалы, трезвучия и септаккорды
     * от заданной ноты, лады народной музыки и пентатоника.
     */
    function buildFromNoteTask(rawQuery, t) {
        const noteAfterFrom = parseNoteAfterFrom(t);

        // Лады народной музыки / пентатоника — тоника берётся после «от» или из тональности.
        const modeName = parseModeName(t);
        if (modeName) {
            const tonic = noteAfterFrom || parseKey(t)?.tonic || parseSingleNote(t);
            if (!tonic) return null;
            const data = buildModeScale({ ...tonic, octave: 4 }, modeName);
            const single = finalize(data);
            if (!single) return null;
            return finalizeMulti([{ label: modeLabel(modeName), data }]) || single;
        }

        if (!noteAfterFrom) return null;

        // Все виды септаккордов от звука.
        if (/септаккорд|seventh/i.test(t) && /все|any|all/i.test(t)) {
            return finalize(buildAllSeventhsFromNote(noteAfterFrom));
        }

        // Трезвучие конкретного вида от звука (+ обращения).
        if (/трезвуч|triad/i.test(t)) {
            const kind = parseTriadKind(t);
            if (kind) return finalize(buildTriadFromNote(noteAfterFrom, kind, wantsIntervalInversion(t)));
            return null;
        }

        // Все простые интервалы от звука.
        if (/все\s*(?:простые\s*)?интервал|all\s*(?:simple\s*)?intervals/i.test(t)) {
            return finalize(buildAllIntervalsFromNote(noteAfterFrom));
        }

        // Один интервал от звука (+ обращение). Аккордовые задания сюда не пускаем.
        if (CHORD_WORDS_RE.test(t) || isD7Query(t)) return null;
        const spec = parseIntervalSpec(rawQuery);
        if (!spec) return null;
        return finalize(buildIntervalFromNote(
            noteAfterFrom, spec.degree, spec.semis, intervalDirection(t), wantsIntervalInversion(t)
        ));
    }

    function parseExercise(t) {
        if (/цепочк|chain/.test(t)) return 'chain';
        if (/тритон|tritone/.test(t)) return 'tritone';
        if (/характерн[а-яё]*\s*интервал|характерные(?![а-яё])|characteristic\s*interval|(?:^|[^а-яё])х\.\s*и\./.test(t)) return 'characteristic';
        if (/доминантсепт|доминантов[а-яё]*\s*септ|\bd\s*7\b|dominant\s*seventh|dominant\s*7|\bd7\b|(^|[^а-яё])д\s*7(?![0-9])/.test(t)) return 'dominant7';
        if (/(все\s*)?виды\s*трезвучи[а-яё]*\s*от|types?\s*of\s*triads?\s*from/.test(t)) return 'allTriadsFromNote';
        if (/главн[а-яё]*\s*трезвуч|main\s*triads?|tonic.*subdominant.*dominant|T[\s,]+S[\s,]+D/i.test(t)) return 'mainTriads';
        if (/гамм|звукоряд|\bscale\b/.test(t)) return 'scale';
        if (/трезвучи|triad/.test(t)) return 'triad';
        return null;
    }

    function isD7Query(t) {
        return /доминантсепт|доминантов[а-яё]*\s*септ|\bd\s*7\b|dominant\s*seventh|dominant\s*7|\bd7\b|(^|[^а-яё])д\s*7(?![0-9])/i.test(t);
    }

    function wantsInversions(t) {
        if (/без\s*обращ|without\s*inversion|only\s*root|только\s*(d7|д7)\b/i.test(t)) return false;
        if (/обращени|inversion/.test(t)) return true;
        return isD7Query(t);
    }

    /** «все виды / во всех видах / 3 вида гаммы» → строим сразу несколько форм. */
    function wantsAllForms(t) {
        return /(?:во?\s+)?(?:все|всех)[а-яё]*\s*(?:вид|форм)|(?:три|3|трёх|трех)\s*(?:вид|форм)|виды\s*гамм|all\s*(?:the\s*)?(?:types?|kinds?|forms?)|all\s*scales?|in\s*all\s*forms?/.test(t);
    }

    function wantsResolution(t) {
        if (/без\s*разреш|without\s*resolv/i.test(t)) return false;
        if (/разрешени|resolution|resolv/.test(t)) return true;
        return isD7Query(t);
    }

    function wantsBothTritoneForms(t) {
        return /нат(?:уральн[а-яё]*)?\s*(?:и|,|\+)\s*гарм(?:оническ[а-яё]*)?|натуральн[а-яё]*\s*(?:и|,|\+)\s*гармоническ|гармоническ[а-яё]*\s*(?:и|,|\+)\s*нат(?:уральн[а-яё]*)?|natural\s+and\s+harmonic/i.test(t);
    }

    function parseChainLabelsFromText(t) {
        const tok = '(?:t53|T53|d53|D53|d43|D43|s64|S64|D65|VII7|II7|ii7|D7|D2|d2|d6|D6|s6|S6|t6|T6|K64)';
        const re = new RegExp(tok + '(?:\\s*[-–—,]\\s*' + tok + ')+', 'i');
        const m = t.match(re);
        if (!m) return null;
        return m[0].split(/\s*[-–—,]\s*/).map(s => s.trim()).filter(Boolean);
    }

    function chainChordForLabel(tonic, mode, label) {
        const L = String(label || '').trim();
        if (!L) return null;
        const isMajor = mode === 'major';
        const t53Keys = () => triadCloseBass(tonic, 1, 3, 5, isMajor ? 'major' : 'minor', 4);
        const preset = D7_PRESETS[d7KeyId(tonic, mode)];
        const d7Keys = preset ? d7PresetForm(preset, 0) : null;
        const d65Keys = preset ? d7PresetForm(preset, 1) : null;
        const d43Keys = preset ? d7PresetForm(preset, 2) : null;
        const d2Keys = preset ? d7PresetForm(preset, 3) : null;
        const ii7Keys = seventhCloseBass(tonic, [2, 4, 6, 1], ['minor', 'minor', 'minor', 'minor'], 4);
        const builders = {
            t53: () => ({ keys: t53Keys(), label: 't53' }),
            T53: () => ({ keys: t53Keys(), label: 'T53' }),
            d6: () => ({ keys: triadCloseBass(tonic, 7, 2, 5, 'harmonicMinor', 4), label: 'd6' }),
            D6: () => ({ keys: triadCloseBass(tonic, 7, 2, 5, 'harmonicMinor', 4), label: 'D6' }),
            s6: () => ({ keys: triadCloseBass(tonic, 6, 1, 4, 'minor', 4), label: 's6' }),
            S6: () => ({ keys: triadCloseBass(tonic, 6, 1, 4, 'major', 4), label: 'S6' }),
            d53: () => ({ keys: triadCloseBass(tonic, 5, 7, 2, 'minor', 4), label: 'd53' }),
            D53: () => ({ keys: triadCloseBass(tonic, 5, 7, 2, 'harmonicMinor', 4), label: 'D53' }),
            D2: () => d2Keys ? ({ keys: d2Keys, label: 'D2' }) : null,
            d2: () => d2Keys ? ({ keys: d2Keys, label: 'D2' }) : null,
            t6: () => ({ keys: triadCloseBass(tonic, 3, 5, 1, 'minor', 4), label: 't6' }),
            T6: () => ({ keys: triadCloseBass(tonic, 3, 5, 1, 'major', 4), label: 'T6' }),
            II7: () => ({ keys: ii7Keys, label: 'II7' }),
            ii7: () => ({ keys: ii7Keys, label: 'II7' }),
            D43: () => d43Keys ? ({ keys: d43Keys, label: 'D43' }) : null,
            d43: () => d43Keys ? ({ keys: d43Keys, label: 'D43' }) : null,
            D65: () => d65Keys ? ({ keys: d65Keys, label: 'D65' }) : null,
            D7: () => d7Keys ? ({ keys: d7Keys, label: 'D7' }) : null,
            s64: () => ({ keys: triadCloseBass(tonic, 1, 4, 6, 'minor', 4), label: 's64' }),
            S64: () => ({ keys: triadCloseBass(tonic, 1, 4, 6, 'harmonic', 4), label: 'S64' }),
            K64: () => ({ keys: triadCloseBass(tonic, 5, 1, 3, 'major', 4), label: 'K64' }),
            VII7: () => ({ keys: seventhCloseBass(tonic, [7, 2, 4, 6], ['harmonic', 'major', 'major', 'harmonic'], 3), label: 'VII7' })
        };
        const fn = builders[L];
        if (!fn) return null;
        const r = fn();
        if (!r) return null;
        return { keys: r.keys, duration: 'w', label: r.label };
    }

    function buildChainFromLabels(tonic, mode, labels) {
        const notes = [];
        for (const lbl of labels) {
            const n = chainChordForLabel(tonic, mode, lbl);
            if (!n) return null;
            notes.push(n);
        }
        return wrapChain(notes, tonic, mode);
    }

    /** Билет / несколько пунктов — собираем все распознанные упражнения. */
    function collectExerciseItems(t, key) {
        const ru = labelLocale === 'ru';
        const items = [];
        const form = detectForm(t);
        const chromatic = isChromaticScaleQuery(t);
        const modeName = parseModeName(t);
        const charKind = parseCharacteristicKind(t);

        // Хроматическая гамма — отдельное правописание, обычная гамма здесь не строится.
        if (chromatic) {
            const bothWays = /вверх\s*и\s*вниз|вниз\s*и\s*вверх|up\s*and\s*down|в\s*обе\s*сторон|ascending\s*and\s*descending/i.test(t);
            const onlyDown = !bothWays && /вниз|нисход|down|descend/i.test(t);
            if (bothWays) {
                items.push({
                    label: ru ? 'Хроматическая гамма (вверх)' : 'Chromatic scale (ascending)',
                    data: buildChromaticScale(key.tonic, key.mode, 'up')
                });
                items.push({
                    label: ru ? 'Хроматическая гамма (вниз)' : 'Chromatic scale (descending)',
                    data: buildChromaticScale(key.tonic, key.mode, 'down')
                });
            } else {
                items.push({
                    label: ru
                        ? (onlyDown ? 'Хроматическая гамма (вниз)' : 'Хроматическая гамма (вверх)')
                        : (onlyDown ? 'Chromatic scale (descending)' : 'Chromatic scale (ascending)'),
                    data: buildChromaticScale(key.tonic, key.mode, onlyDown ? 'down' : 'up')
                });
            }
        }

        // Лад народной музыки от тоники тональности («дорийский лад в ре»).
        if (!chromatic && modeName) {
            items.push({ label: modeLabel(modeName), data: buildModeScale(key.tonic, modeName) });
        }

        if (!chromatic && !modeName
            && /гамм|scale|звукоряд/.test(t)
            && !(/тритон|tritone|d7|д7|цепоч|t53/i.test(t) && !/мелодическ|melodic/.test(t))) {
            if (/мелодическ|melodic/.test(t)) {
                const data = key.mode === 'minor'
                    ? buildMelodicMinorBothWays(key.tonic)
                    : buildMelodicMajorBothWays(key.tonic);
                if (data) items.push({ label: ru ? 'Мелодическая гамма' : 'Melodic scale', data });
            } else if (wantsAllForms(t) || (!form && /построй|build|сделай|напиши|выведи|draw|show|write/.test(t))) {
                items.push(...buildAllScaleForms(key.tonic, key.mode, ru, t));
            } else if (form !== null) {
                const data = buildScaleExercise(key.tonic, key.mode, form);
                if (data) items.push({ label: ru ? 'Гамма' : 'Scale', data });
            }
        }

        if (charKind) {
            const built = buildSingleCharacteristic(key.tonic, key.mode, charKind, wantsResolution(t));
            if (built) {
                const { _charPair, ...data } = built;
                items.push({
                    label: ru ? `Характерный интервал ${CHAR_KIND_DEFS[charKind].ru}` : `Characteristic ${CHAR_KIND_DEFS[charKind].en}`,
                    data
                });
            }
        } else if (/характерн[а-яё]*\s*интервал|характерные(?![а-яё])|(?:^|[^а-яё])х\.\s*и\.|characteristic\s*interval/i.test(t)) {
            const data = buildCharacteristic(key.tonic, key.mode);
            if (data) items.push({ label: ru ? 'Характерные интервалы' : 'Characteristic intervals', data });
        }

        if (/главн[а-яё]*\s*трезвуч|main\s*triads?|tonic.*subdominant.*dominant/i.test(t)) {
            const data = buildMainTriads(key.tonic, key.mode, wantsInversions(t), form || (key.mode === 'minor' ? 'harmonic' : null));
            if (data) items.push({ label: ru ? 'Главные трезвучия' : 'Main triads', data });
        }

        if (/тритон|tritone/.test(t)) {
            if (wantsBothTritoneForms(t)) {
                const nat = buildTritones(key.tonic, key.mode, 'natural');
                const harm = buildTritones(key.tonic, key.mode, 'harmonic');
                if (nat) items.push({ label: ru ? 'Натуральные тритоны' : 'Natural tritones', data: nat });
                if (harm) items.push({ label: ru ? 'Гармонические тритоны' : 'Harmonic tritones', data: harm });
            } else {
                const twoPairs = /две\s*пары|обе\s*пары|2\s*пары|both\s*pairs/.test(t);
                let f;
                if (form === 'natural' && !twoPairs) f = 'natural';
                else if (form === 'harmonic' || twoPairs) f = 'harmonic';
                else f = (key.mode === 'minor') ? 'harmonic' : 'natural';
                const data = buildTritones(key.tonic, key.mode, f);
                if (data) items.push({ label: ru ? 'Тритоны' : 'Tritones', data });
            }
        }

        if (isD7Query(t)) {
            const data = buildDominantSeventh(key.tonic, key.mode, wantsInversions(t), wantsResolution(t));
            if (data) items.push({ label: 'D7', data });
        }

        if (isViiSeventhQuery(t)) {
            const harmonicMajor = key.mode === 'major' && (form === 'harmonic' || /уменьшенн|уменьшённ|dimin/i.test(t));
            const data = buildViiSeventhInKey(key.tonic, key.mode, harmonicMajor);
            if (data) items.push({ label: ru ? 'Вводный септаккорд VII7 с разрешением' : 'Leading-tone seventh VII7 with resolution', data });
        }

        if (isSecondSeventhQuery(t)) {
            const harmonicMajor = key.mode === 'major' && form === 'harmonic';
            const data = buildSecondSeventhInKey(key.tonic, key.mode, harmonicMajor);
            if (data) items.push({ label: ru ? 'Септаккорд II ступени с разрешением' : 'Supertonic seventh II7 with resolution', data });
        }

        if (isUnstableResolutionQuery(t)) {
            const data = buildUnstableResolutions(key.tonic, key.mode);
            if (data) items.push({ label: ru ? 'Разрешение неустойчивых ступеней' : 'Resolution of unstable degrees', data });
        }

        if (isOpevanieQuery(t)) {
            const data = buildOpevanie(key.tonic, key.mode);
            if (data) items.push({ label: ru ? 'Опевание устойчивых ступеней' : 'Surrounding the stable degrees', data });
        }

        const chainLabels = parseChainLabelsFromText(t);
        if (chainLabels && chainLabels.length >= 3) {
            const data = buildChainFromLabels(key.tonic, key.mode, chainLabels);
            if (data) items.push({ label: ru ? 'Цепочка' : 'Chain', data });
        } else if (/цепочк|chain/.test(t)) {
            const num = parseChainNumber(t);
            const data = (num === 2 || (num !== 1 && key.mode === 'minor'))
                ? buildChain2(key.tonic) : buildChain1(key.tonic);
            if (data) items.push({ label: ru ? 'Цепочка' : 'Chain', data });
        }

        return items.filter(it => it && it.data);
    }

    // ---------- Сборка блока по запросу ----------
    function buildNotationForQuery(rawQuery) {
        if (!rawQuery || typeof rawQuery !== 'string') return null;
        const t = rawQuery.toLowerCase().replace(/ё/g, 'е');

        // "Все виды трезвучий от ноты N" — тональность не нужна.
        if (/(?:все\s*)?виды\s*трезвучи[а-яё]*\s*от|types?\s*of\s*triads?\s*from/.test(t)) {
            const note = parseSingleNote(t);
            if (!note) return null;
            return finalize(buildAllTriadsFromNote(note));
        }

        // Задания «от звука» (интервалы, трезвучия/септаккорды от ноты, лады) —
        // тональность для них тоже не нужна, поэтому проверяем до parseKey.
        const fromNote = buildFromNoteTask(rawQuery, t);
        if (fromNote) return fromNote;

        if (/обратите|обрати|invert/i.test(t) && !CHORD_WORDS_RE.test(t)) {
            const invSpec = parseIntervalSpec(rawQuery);
            if (invSpec) return finalize(buildIntervalInversionExercise(invSpec));
        }

        const key = parseKey(t);
        if (!key) return null;

        const textbook = buildTextbookInKey(rawQuery, t, key);
        if (textbook) return textbook;

        const composite = collectExerciseItems(t, key);
        if (composite.length >= 1) return finalizeMulti(composite);

        const exercise = parseExercise(t);
        if (!exercise) return null;

        const form = detectForm(t);

        let data = null;
        switch (exercise) {
            case 'tritone': {
                // Выбор формы:
                //  • явное «натуральные» → natural (1 пара);
                //  • явное «гармонические» / «две пары» / «обе пары» → harmonic (2 пары);
                //  • по умолчанию: минор → harmonic (рабочая форма), мажор → natural
                //    (соответствует общепринятой школьной практике и эталонным примерам).
                const twoPairs = /две\s*пары|обе\s*пары|2\s*пары|both\s*pairs/.test(t);
                let f;
                if (form === 'natural' && !twoPairs) f = 'natural';
                else if (form === 'harmonic' || twoPairs) f = 'harmonic';
                else f = (key.mode === 'minor') ? 'harmonic' : 'natural';
                data = buildTritones(key.tonic, key.mode, f);
                break;
            }
            case 'characteristic':
                data = buildCharacteristic(key.tonic, key.mode);
                break;
            case 'scale':
                if (wantsAllForms(t) && !form) {
                    return finalizeMulti(buildAllScaleForms(key.tonic, key.mode, labelLocale === 'ru', t));
                }
                // «построй гамму X» без уточнения формы — по умолчанию все виды (школьная практика)
                if (!form && /построй|постро|build|show|draw|сделай|напиши/.test(t)) {
                    return finalizeMulti(buildAllScaleForms(key.tonic, key.mode, labelLocale === 'ru', t));
                }
                data = buildScaleExercise(key.tonic, key.mode, form);
                break;
            case 'triad':
                data = buildTonicTriadExercise(key.tonic, key.mode, wantsInversions(t));
                break;
            case 'mainTriads':
                data = buildMainTriads(key.tonic, key.mode, wantsInversions(t), detectForm(t) || (key.mode === 'minor' ? 'harmonic' : null));
                break;
            case 'dominant7':
                data = buildDominantSeventh(
                    key.tonic, key.mode, wantsInversions(t), wantsResolution(t)
                );
                break;
            case 'chain': {
                const num = parseChainNumber(t);
                if (num === 2 || (num !== 1 && key.mode === 'minor')) data = buildChain2(key.tonic);
                else data = buildChain1(key.tonic);
                break;
            }
        }
        return finalize(data);
    }

    function parseSingleNote(t) {
        const ru = findRuNote(t);
        if (ru) return { ...ru, octave: 4 };
        const m = t.match(/\b([a-g])\s*(#|b|sharp|flat)?\b/);
        if (m) {
            let acc = 0;
            if (m[2]) acc = /#|sharp/.test(m[2]) ? 1 : -1;
            return { letter: m[1], acc, octave: 4 };
        }
        return null;
    }

    function shiftVexKeyOctave(k, delta) {
        const p = parseVexKey(k);
        if (!p) return k;
        const oct = Math.max(1, Math.min(8, p.octave + delta));
        return noteKey({ letter: p.letter, acc: p.acc, octave: oct });
    }

    /** Скрипичный ключ: удобный диапазон ~E4–G5 (не ниже/additional ledger lines). */
    const OCTAVE_LIMITS = {
        treble: { top: 72, bottom: 47 },
        bass: { top: 55, bottom: 36 }
    };
    const COMFORT_CENTER = { treble: 60, bass: 43 }; // ~C5 / G3

    function chordAbsRange(keys) {
        let minA = Infinity;
        let maxA = -Infinity;
        (keys || []).forEach(k => {
            const p = parseVexKey(k);
            if (!p) return;
            const a = noteAbs(p);
            minA = Math.min(minA, a);
            maxA = Math.max(maxA, a);
        });
        if (!Number.isFinite(minA)) return null;
        return { minA, maxA, center: (minA + maxA) / 2 };
    }

    /** Одноголосные линии (гаммы, мелодии): один общий сдвиг октавы, порядок высот сохраняется. */
    function normalizeSingleLineOctaves(notes, clef) {
        const isBass = clef === 'bass';
        const hard = OCTAVE_LIMITS[isBass ? 'bass' : 'treble'];
        const ideal = COMFORT_CENTER[isBass ? 'bass' : 'treble'];
        let minA = Infinity;
        let maxA = -Infinity;
        for (const n of notes) {
            const keys = n.keys || [];
            if (keys.length !== 1) return null;
            const p = parseVexKey(keys[0]);
            if (!p) return null;
            const a = noteAbs(p);
            minA = Math.min(minA, a);
            maxA = Math.max(maxA, a);
        }
        if (!Number.isFinite(minA)) return notes;

        let bestShift = 0;
        let bestScore = Infinity;
        for (let shift = -3; shift <= 3; shift++) {
            const smin = minA + shift * 12;
            const smax = maxA + shift * 12;
            if (smax > hard.top || smin < hard.bottom) continue;
            const score = Math.abs((smin + smax) / 2 - ideal);
            if (score < bestScore) {
                bestScore = score;
                bestShift = shift;
            }
        }
        if (!bestShift) return notes;
        return notes.map(n => ({
            ...n,
            keys: (n.keys || []).map(k => shiftVexKeyOctave(k, bestShift))
        }));
    }

    /** Каждый аккорд/интервал — в удобном диапазоне; соседние созвучия без скачков > октавы. */
    function normalizeNotationOctaves(notes, clef) {
        if (!Array.isArray(notes) || !notes.length) return notes;
        const singleLine = normalizeSingleLineOctaves(notes, clef);
        if (singleLine) return singleLine;

        const isBass = clef === 'bass';
        const hard = OCTAVE_LIMITS[isBass ? 'bass' : 'treble'];
        const comfortBottom = isBass ? 38 : 52;
        const comfortTop = isBass ? 53 : 68;
        const ideal = COMFORT_CENTER[isBass ? 'bass' : 'treble'];
        let prevCenter = null;

        return notes.map(n => {
            const keys = n.keys || [];
            const range = chordAbsRange(keys);
            if (!range) return n;
            let bestShift = 0;
            let bestScore = Infinity;

            for (let shift = -3; shift <= 3; shift++) {
                const smin = range.minA + shift * 12;
                const smax = range.maxA + shift * 12;
                const scenter = range.center + shift * 12;
                if (smax > hard.top || smin < hard.bottom) continue;

                let score = Math.abs(scenter - ideal) * 1.5;
                if (smin < comfortBottom) score += (comfortBottom - smin) * 3;
                if (smax > comfortTop) score += (smax - comfortTop) * 3;
                if (prevCenter != null) score += Math.abs(scenter - prevCenter) * 0.6;

                if (score < bestScore) {
                    bestScore = score;
                    bestShift = shift;
                }
            }

            prevCenter = range.center + bestShift * 12;
            if (!bestShift) return n;
            return {
                ...n,
                keys: keys.map(k => shiftVexKeyOctave(k, bestShift))
            };
        });
    }

    function presetKeys(preset, idx) {
        if (!preset || !Array.isArray(preset[idx])) return null;
        return preset[idx].slice();
    }

    function finalize(data) {
        if (!data || !Array.isArray(data.notes) || !data.notes.length) return null;
        const clef = data.clef === 'bass' ? 'bass' : 'treble';
        data = sanitizeNotationData({ ...data, notes: normalizeNotationOctaves(data.notes, clef) });
        if (!data || !Array.isArray(data.notes) || !data.notes.length) return null;
        // финальная страховка: каждый key валиден
        for (const n of data.notes) {
            if (!Array.isArray(n.keys) || !n.keys.length) return null;
            for (const k of n.keys) {
                if (!/^[a-g](#|##|b|bb)?\/\d$/.test(k)) return null;
            }
        }
        const blockString = `[[NOTATION:${JSON.stringify(data)}]]`;
        return { data, blockString };
    }

    /**
     * Несколько нотных блоков с подписями (например, «все виды гамм»).
     * items: [{ label, data }]. Возвращает один blockString со всеми блоками подряд.
     */
    function finalizeMulti(items) {
        const parts = [];
        for (const it of items) {
            const single = finalize(it.data);
            if (!single) return null;
            const label = it.label ? `**${it.label}**\n` : '';
            parts.push(`${label}${single.blockString}`);
        }
        if (!parts.length) return null;
        return { blockString: parts.join('\n\n') };
    }

    // ---------- Подстановка блока в ответ нейросети ----------
    const BLOCK_RE = /\[\[NOTATION:\s*\{[\s\S]*?\}\s*\]\]/g;

    function applyBlock(aiText, blockString) {
        let text = String(aiText || '');
        const hasBlock = BLOCK_RE.test(text);
        BLOCK_RE.lastIndex = 0;
        if (hasBlock) {
            // Заменяем ВСЕ блоки модели на один корректный (вычисленный нами).
            let replaced = false;
            const out = text.replace(BLOCK_RE, () => {
                if (replaced) return '';
                replaced = true;
                return blockString;
            }).replace(/\n{3,}/g, '\n\n').trim();
            return out;
        }
        // Закрытого блока в тексте нет, но мог остаться ОБРЕЗАННЫЙ хвост `[[NOTATION:{...`
        // без `]]` (если модель не успела дописать). Если просто склеить с нашим
        // блоком — парсер захватит обе метки `[[NOTATION:` подряд как один битый
        // JSON и упадёт. Поэтому срезаем оборванный хвост ПЕРЕД склейкой.
        text = text.replace(/\[\[NOTATION:[\s\S]*$/, '').trimEnd();
        const prose = text.trim();
        return prose ? `${prose}\n${blockString}` : blockString;
    }

    // ---------- Промпт для модели (все правила) ----------
    const EXERCISE_OUTPUT_RULES = `=== ВЫВОД УПРАЖНЕНИЙ (кратко) ===
При «построй / сделай / напиши / билет» — ПОЛНЫЙ комплект нот в [[NOTATION:...]]. Текст 1–2 предложения.
«Мелодическая гамма» → только мелодическая (вверх+вниз, 15 нот). Без «мелодическая» при «построй гамму» → нат.+гарм.+мел.
«Натуральные и гармонические тритоны» / «нат и гарм» → ОБА набора (4+4 созвучия), barlines:"manual".
D7 + разрешение → clef:"treble" ONLY, формы D7 с разрешениями. Никогда layout:"satb" для D7/II7/цепочек.
Цепочка по списку labels (t53-d6-d53-...) → ВСЕ аккорды из списка подряд.
Билет с несколькими пунктами → несколько [[NOTATION:...]] блоков (система подставит эталон).
Если theory.js распознал запрос — не выдумывай свои ноты.

=== ЧТО СТРОИТ ДВИЖОК САМ (эталон подставляется автоматически) ===
Гаммы всех видов; тритоны; характерные интервалы; трезвучия T с обращениями; главные трезвучия;
все виды трезвучий и септаккордов от звука; интервал от звука и его обращение; все простые интервалы от звука;
D7 с обращениями и разрешениями; VII7 и II7 с разрешением; цепочки 1 и 2; хроматическая гамма;
лады народной музыки и пентатоника; разрешение неустойчивых ступеней; опевание устоев.
Для этих запросов твоя задача — только короткий текст: ноты подставит движок.

=== ЦЕПОЧКИ (шпаргалка) ===
Цепочка 1 (мажор, 9): T53 S64 VII7 D65 T53 S6 K64 D7 T53
Цепочка 2 (минор, 11): t53 d6 s6 D53 D2 t6 II7 D43 t53 s64 t53
Явный список labels в задании → строй ИМЕННО его, не сокращай.

=== SATB (гармонизация) ===
"layout":"satb" — скрипичный (S+A) + басовый (T+B). Полная гармонизация всех тактов.`;

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
Система автоматически подставляет правильные ноты для: тритонов, характерных интервалов, гамм (все формы), D7+обращения+разрешения, цепочки 1 и 2, трезвучия T с обращениями, «все виды трезвучий от ноты». Если запрос распознан — используй готовый блок, не выдумывай свои ноты.

=== БОЛЬШИЕ ЗАДАЧИ (важно!) ===
- Ты МОЖЕШЬ и ДОЛЖЕН выполнять большие задания целиком: цепочки на 15+ аккордов, гармонизации мелодии/баса, длинные секвенции, модуляции. НЕ сокращай количество аккордов, если пользователь просит длинную цепочку — выводи столько, сколько попросили.
- Один [[NOTATION:...]] блок может содержать много аккордов — рендерер сам переносит на несколько строк. Не дроби цепочку на куски искусственно.
- Приоритет: полностью закрытый валидный JSON важнее прозы. Текст — 1–2 предложения, вся «мясистость» — в нотах.
- Каждый аккорд подписывай функцией (T, S, D, D7, K6/4 / для англоязычных — I, IV, V, V7, cad.6/4) над нотой в поле "label".

=== ЗОЛОТОЕ ПРАВИЛО ТОЧНОСТИ ===
- Перед выводом КАЖДОГО аккорда/интервала мысленно проверь: (1) буквенный скелет, (2) число полутонов, (3) удвоение по правилам выше, (4) разрешение тяготеющих тонов, (5) отсутствие параллельных квинт/октав. Если что-то не сходится — перестрой ДО вывода. Лучше правильно, чем быстро.`;

    function wantsTritoneRules(t) {
        return (/правил|rules?|как\s*(?:стро|постро)|объясни|расскаж|напомни|опиш/i.test(t) && /тритон|tritone/i.test(t))
            || /правил[а-яё]*\s*построен[а-яё]*\s*тритон/i.test(t);
    }

    function wantsCharacteristicRules(t) {
        return (/правил|rules?|как\s*(?:стро|постро)|объясни|расскаж|напомни/i.test(t)
            && /характерн|х\.\s*и|characteristic/i.test(t));
    }

    function getTheoryProse(rawQuery) {
        const t = String(rawQuery || '').toLowerCase().replace(/ё/g, 'е');
        const ru = labelLocale === 'ru' || /[а-яё]/i.test(rawQuery);
        const parts = [];

        if (wantsTritoneRules(t)) {
            parts.push(ru
                ? `Тритоны — неустойчивые интервалы: они строятся на неустойчивых ступенях лада, поэтому обязательно требуют разрешения — неустойчивые ступени тяготеют к устойчивым.

Принцип разрешения прост. **Увеличенная кварта** (ув.4) — двустороннее «расширение»: разрешается в **малую сексту** (м.6). **Уменьшённая квинта** (ум.5) — двустороннее «сужение»: разрешается в **большую терцию** (б.3).

В **натуральной** форме звукоряда — одна пара тритонов (ув.4 + ум.5), в **гармонической** — две пары.`
                : `Tritones are unstable intervals built on unstable scale degrees, so they must resolve — unstable tones move toward stable ones.

Resolution is straightforward: an **augmented 4th** (A4) expands outward and resolves to a **minor 6th** (m6). A **diminished 5th** (d5) contracts inward and resolves to a **major 3rd** (M3).

In the **natural** form there is one tritone pair (A4 + d5); in the **harmonic** form there are two pairs.`);
        }

        if (wantsCharacteristicRules(t)) {
            parts.push(ru
                ? `Характерные интервалы — ув.2, ум.7, ув.5 и ум.4 — тоже неустойчивы и разрешаются по тому же принципу тяготения: каждый «схлопывается» в устойчивый интервал (к секунде, сексте, терции или кварте тонического трезвучия).`
                : `Characteristic intervals — A2, d7, A5, and d4 — are unstable and resolve by the same tendency: each collapses into a stable interval of the tonic triad.`);
        }

        return parts.join('\n\n');
    }

    /**
     * Короткая подводка к готовому построению. Используется ТОЛЬКО когда другого
     * текста нет (мгновенный ответ движка без обращения к модели), чтобы на экране
     * не оказался «голый» нотный стан.
     */
    function getExerciseIntro(rawQuery) {
        const t = String(rawQuery || '').toLowerCase().replace(/ё/g, 'е');
        const ru = labelLocale === 'ru' || /[а-яе]/i.test(rawQuery);
        const pick = (r, e) => (ru ? r : e);

        if (isChromaticScaleQuery(t)) return pick('Хроматическая гамма по правилам правописания:', 'Chromatic scale with standard spelling:');
        const charKind = parseCharacteristicKind(t);
        if (charKind) {
            const key = parseKey(t);
            if (key) {
                const prose = characteristicProse(key.tonic, key.mode, charKind, ru);
                if (prose) return prose;
            }
        }
        const modeName = parseModeName(t);
        if (modeName) return pick(`${modeLabel(modeName)} лад:`, `${modeLabel(modeName)}:`);
        if (isViiSeventhQuery(t)) return pick('Вводный септаккорд с разрешением через D6/5 в тонику:', 'Leading-tone seventh resolving through D6/5 to the tonic:');
        if (isSecondSeventhQuery(t)) return pick('Септаккорд II ступени с разрешением через D4/3 в тонику:', 'Supertonic seventh resolving through D4/3 to the tonic:');
        if (isUnstableResolutionQuery(t)) return pick('Разрешение неустойчивых ступеней: II→I, IV→III, VI→V, VII→I.', 'Unstable degrees resolve: II→I, IV→III, VI→V, VII→I.');
        if (isOpevanieQuery(t)) return pick('Опевание устойчивых ступеней — соседняя сверху, соседняя снизу, устой:', 'Surrounding each stable degree — upper neighbour, lower neighbour, the degree itself:');
        if (/все\s*(?:простые\s*)?интервал|all\s*(?:simple\s*)?intervals/i.test(t)) return pick('Все простые интервалы от заданного звука:', 'All simple intervals from the given note:');
        if (/септаккорд|seventh/i.test(t) && /все|all/i.test(t)) return pick('Все виды септаккордов от заданного звука:', 'All seventh-chord types from the given note:');
        if (/трезвуч|triad/i.test(t)) return pick('Готовое построение:', 'Here is the chord:');
        if (parseSeventhKind(t)) {
            const key = parseKey(t);
            if (key) {
                const def = SEVENTH_KIND_DEFS[parseSeventhKind(t)];
                const kindName = def ? (ru ? def.ru : def.en) : '';
                const keyName = tonalityDisplayName(key.tonic, key.mode, ru);
                return pick(
                    `${kindName || 'Септаккорд'} в ${keyName} (основной вид от тоники):`,
                    `${kindName || 'Seventh chord'} in ${keyName} (root position from tonic):`
                );
            }
        }
        const keyForInt = parseKey(t);
        const intSpecIntro = parseIntervalSpec(rawQuery);
        if (keyForInt && intSpecIntro && !parseScaleDegree(t) && !CHORD_WORDS_RE.test(t)) {
            const name = intervalNameFor(intSpecIntro.degree, intSpecIntro.semis, ru);
            const keyName = tonalityDisplayName(keyForInt.tonic, keyForInt.mode, ru);
            return pick(
                `${name} от тоники (${keyName}):`,
                `${name} from the tonic of ${keyName}:`
            );
        }
        if (intSpecIntro) {
            return wantsIntervalInversion(t)
                ? pick('Интервал и его обращение:', 'The interval and its inversion:')
                : pick('Интервал от заданного звука:', 'The interval from the given note:');
        }
        return '';
    }

    /**
     * Справочная часть системного промпта. Ядро правил + релевантные запросу темы
     * из базы знаний (theory-kb.js). Тема не может попасть в промпт дважды —
     * подбор идёт по уникальным id, поэтому правила не «наслаиваются».
     */
    function knowledgeFor(query) {
        if (typeof window === 'undefined' || !window.SolfKB || typeof window.SolfKB.getPrompt !== 'function') return '';
        try {
            return window.SolfKB.getPrompt(query) || '';
        } catch (err) {
            console.warn('[Solf.ai] Knowledge base unavailable:', err);
            return '';
        }
    }

    function getSystemPrompt(query) {
        // Если база знаний не загрузилась — старый свод правил как страховка.
        return EXERCISE_OUTPUT_RULES + (knowledgeFor(query) || HARMONY_RULEBOOK);
    }

    /**
     * Правила теории для ОБЫЧНОГО чата (режим нотации выключен). Подключаются только
     * если в запросе есть теоретическая тема: «привет» не должен тащить за собой
     * всю базу правил, а «что такое синкопа» — должен.
     */
    function getTheoryRules(query) {
        if (typeof window === 'undefined' || !window.SolfKB || typeof window.SolfKB.selectTopicIds !== 'function') return '';
        try {
            if (!window.SolfKB.selectTopicIds(query).length) return '';
        } catch (_) {
            return '';
        }
        return knowledgeFor(query);
    }

    window.SolfTheory = {
        buildNotationForQuery,
        buildTheoryQuickAnswer,
        getSystemPrompt,
        getTheoryRules,
        getTheoryProse,
        getExerciseIntro,
        applyBlock,
        autoLabelNotation,
        setLabelLocale,
        normalizeNotationOctaves,
        sanitizeNotationData,
        // Внутренности — только для страницы самопроверки selftest.html.
        _internals: {
            parseKey,
            parseSingleNote,
            parseIntervalSpec,
            parseVexKey,
            noteKey,
            noteAbs,
            pc,
            intervalDegree,
            intervalSemis,
            intervalLabel,
            buildIntervalUp,
            buildIntervalDown,
            buildScale,
            buildChromaticScale,
            buildModeScale,
            buildViiSeventhInKey,
            buildSecondSeventhInKey,
            buildAllIntervalsFromNote,
            buildAllSeventhsFromNote,
            buildTriadFromNote,
            buildIntervalFromNote,
            buildUnstableResolutions,
            buildOpevanie,
            degreeNoteExt,
            keySigFor,
            repairKey,
            sanitizeNoteEntry,
            parseModeName,
            parseNoteAfterFrom,
            parseTriadKind,
            parseSeventhKind,
            buildSeventhByKind,
            buildFromNoteTask,
            simplifyEnharmonic,
            D7_PRESETS,
            MODE_DEFS,
            SEVENTH_KIND_DEFS
        }
    };
})();
