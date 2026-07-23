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
    function sanitizeNotationData(data) {
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
        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: 'none',
            notes: connectChainVoices(notes)
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
        if (/цепочка\s*2\b|2[\s-]*(?:ю|я|й|e|nd)\s*цепоч|chain\s*2\b|втор\w*\s*цепоч/i.test(t)) return 2;
        if (/цепочка\s*1\b|1[\s-]*(?:ю|я|й|st)\s*цепоч|chain\s*1\b|перв\w*\s*цепоч/i.test(t)) return 1;
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

    /** Мгновенный текстовый ответ без нотации (ключ, знаки…). */
    function buildTheoryQuickAnswer(rawQuery) {
        if (!rawQuery || typeof rawQuery !== 'string') return null;
        const t = rawQuery.toLowerCase().replace(/ё/g, 'е');
        if (isKeySignatureQuery(t)) {
            const key = parseKey(t);
            if (!key) return null;
            const ru = labelLocale === 'ru' || /[а-яё]/i.test(rawQuery);
            return { text: formatKeySignatureAnswer(key, ru) };
        }
        return null;
    }

    function parseExercise(t) {
        if (/цепочк|chain/.test(t)) return 'chain';
        if (/тритон|tritone/.test(t)) return 'tritone';
        if (/характерн\w*\s*интервал|характерные\b|characteristic\s*interval|\bх\.\s*и\./.test(t)) return 'characteristic';
        if (/доминантсепт|доминантов\w*\s*септ|\bd\s*7\b|dominant\s*seventh|dominant\s*7|\bd7\b|(^|[^а-яё])д\s*7(?![0-9])/.test(t)) return 'dominant7';
        if (/(все\s*)?виды\s*трезвучи\w*\s*от|types?\s*of\s*triads?\s*from/.test(t)) return 'allTriadsFromNote';
        if (/главн\w*\s*трезвуч|main\s*triads?|tonic.*subdominant.*dominant|T[\s,]+S[\s,]+D/i.test(t)) return 'mainTriads';
        if (/гамм|звукоряд\b|\bscale\b/.test(t)) return 'scale';
        if (/трезвучи|triad/.test(t)) return 'triad';
        return null;
    }

    function isD7Query(t) {
        return /доминантсепт|доминантов\w*\s*септ|\bd\s*7\b|dominant\s*seventh|dominant\s*7|\bd7\b|(^|[^а-яё])д\s*7(?![0-9])/i.test(t);
    }

    function wantsInversions(t) {
        if (/без\s*обращ|without\s*inversion|only\s*root|только\s*(d7|д7)\b/i.test(t)) return false;
        if (/обращени|inversion/.test(t)) return true;
        return isD7Query(t);
    }

    /** «все виды / во всех видах / 3 вида гаммы» → строим сразу несколько форм. */
    function wantsAllForms(t) {
        return /(?:во?\s+)?(?:все|всех)\w*\s*(?:вид|форм)|(?:три|3|трёх|трех)\s*(?:вид|форм)|виды\s*гамм|all\s*(?:the\s*)?(?:types?|kinds?|forms?)|all\s*scales?|in\s*all\s*forms?/.test(t);
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

        if (/гамм|scale|звукоряд/.test(t) && !(/тритон|tritone|d7|д7|цепоч|t53/i.test(t) && !/мелодическ|melodic/.test(t))) {
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

        if (/характерн\w*\s*интервал|характерные\b|х\.\s*и\.|characteristic\s*interval/i.test(t)) {
            const data = buildCharacteristic(key.tonic, key.mode);
            if (data) items.push({ label: ru ? 'Характерные интервалы' : 'Characteristic intervals', data });
        }

        if (/главн\w*\s*трезвуч|main\s*triads?|tonic.*subdominant.*dominant/i.test(t)) {
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
        if (/(?:все\s*)?виды\s*трезвучи\w*\s*от|types?\s*of\s*triads?\s*from/.test(t)) {
            const note = parseSingleNote(t);
            if (!note) return null;
            return finalize(buildAllTriadsFromNote(note));
        }

        const key = parseKey(t);
        if (!key) return null;

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
            || /правил\w*\s*построен\w*\s*тритон/i.test(t);
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

    function getSystemPrompt() {
        return EXERCISE_OUTPUT_RULES + HARMONY_RULEBOOK;
    }

    window.SolfTheory = {
        buildNotationForQuery,
        buildTheoryQuickAnswer,
        getSystemPrompt,
        getTheoryProse,
        applyBlock,
        autoLabelNotation,
        setLabelLocale,
        normalizeNotationOctaves,
        sanitizeNotationData
    };
})();
