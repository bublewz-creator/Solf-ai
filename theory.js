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

    const MAJOR_FORMULA = [0, 2, 4, 5, 7, 9, 11];
    const MINOR_FORMULA = [0, 2, 3, 5, 7, 8, 10];

    /** 7 ступеней натуральной гаммы в октаве 4 (ascending), верное написание. */
    function buildScale(tonic, mode) {
        const formula = mode === 'major' ? MAJOR_FORMULA : MINOR_FORMULA;
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

    function chord(lo, hi, barAfter, label) {
        const c = { keys: [noteKey(lo), noteKey(hi)], duration: 'h' };
        if (barAfter) c.barAfter = true;
        if (label) c.label = label;
        return c;
    }

    // Качественное имя интервала по ступеневой величине + количеству полутонов.
    // Используется для автоматических подписей (ув.4, ум.5, м.6, б.3 и т.п.).
    const INTERVAL_QUALITY = {
        1: { 0: 'ч1', 1: 'ув1' },
        2: { 0: 'ум2', 1: 'м2', 2: 'б2', 3: 'ув2' },
        3: { 2: 'ум3', 3: 'м3', 4: 'б3', 5: 'ув3' },
        4: { 4: 'ум4', 5: 'ч4', 6: 'ув4' },
        5: { 6: 'ум5', 7: 'ч5', 8: 'ув5' },
        6: { 7: 'ум6', 8: 'м6', 9: 'б6', 10: 'ув6' },
        7: { 9: 'ум7', 10: 'м7', 11: 'б7', 12: 'ув7' },
        8: { 11: 'ум8', 12: 'ч8', 13: 'ув8' }
    };
    function intervalLabel(lo, hi) {
        const deg = intervalDegree(lo, hi);
        const sem = intervalSemis(lo, hi);
        return (INTERVAL_QUALITY[deg] && INTERVAL_QUALITY[deg][sem]) || '';
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
    const TRIAD_QUALITY = { '4,7': 'Б', '3,7': 'М', '3,6': 'Ум', '4,8': 'Ув' };
    function classifyTriad(tones, bass) {
        for (const root of tones) {
            const ti = (letterIdx(root.letter) + 2) % 7;
            const fi = (letterIdx(root.letter) + 4) % 7;
            const third = tones.find(n => letterIdx(n.letter) === ti);
            const fifth = tones.find(n => letterIdx(n.letter) === fi);
            if (!third || !fifth) continue;
            const q = TRIAD_QUALITY[`${semiUp(root, third)},${semiUp(root, fifth)}`];
            if (!q) continue;
            const fig = samePc(bass, root) ? '53' : samePc(bass, third) ? '6' : '64';
            return q + fig;
        }
        return '';
    }

    // Тип септаккорда по полутонам от примы до терции/квинты/септимы.
    // D = малый мажорный (доминантовый), Ум = уменьшённый, Б/М — большие/малые.
    const SEVENTH_TYPE = { '4,7,10': 'D', '3,6,9': 'Ум', '3,6,10': 'Ум', '4,7,11': 'Б', '3,7,10': 'М' };
    function classifySeventh(tones, bass) {
        for (const root of tones) {
            const ti = (letterIdx(root.letter) + 2) % 7;
            const fi = (letterIdx(root.letter) + 4) % 7;
            const si = (letterIdx(root.letter) + 6) % 7;
            const third = tones.find(n => letterIdx(n.letter) === ti);
            const fifth = tones.find(n => letterIdx(n.letter) === fi);
            const seventh = tones.find(n => letterIdx(n.letter) === si);
            if (!third || !fifth || !seventh) continue;
            const sig = `${semiUp(root, third)},${semiUp(root, fifth)},${semiUp(root, seventh)}`;
            const q = SEVENTH_TYPE[sig];
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
            notes.push(chord(uv4lo, uv4hi, false, 'ув4'));
            notes.push(chord(r1[0], r1[1], true, intervalLabel(r1[0], r1[1])));

            // ум.5: lb -> квинта вверх
            const um5lo = { letter: p.lb.letter, acc: p.lb.acc, octave: 4 };
            const um5hi = buildIntervalUp(um5lo, 5, 6);
            if (!checkInterval(um5lo, um5hi, 5, 6)) return;
            const r2 = resolveInterval(um5lo, um5hi, 'dim', triad);
            notes.push(chord(um5lo, um5hi, false, 'ум5'));
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
    const SCALE_FORMULAS = {
        major: [0, 2, 4, 5, 7, 9, 11],
        minor: [0, 2, 3, 5, 7, 8, 10],
        harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
        melodicMinor: [0, 2, 3, 5, 7, 9, 11],
        harmonicMajor: [0, 2, 4, 5, 7, 8, 11],
        naturalMajor: [0, 2, 4, 5, 7, 9, 11]
    };

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
        let key;
        if (mode === 'minor') {
            key = form === 'harmonic' ? 'harmonicMinor' : form === 'melodic' ? 'melodicMinor' : 'minor';
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

    /** Все виды гаммы: натуральная, гармоническая, мелодическая — каждая отдельным блоком. */
    function buildAllScaleForms(tonic, mode, isRu) {
        const L = isRu
            ? { nat: 'Натуральная:', harm: 'Гармоническая:', mel: 'Мелодическая (вверх и вниз):' }
            : { nat: 'Natural:', harm: 'Harmonic:', mel: 'Melodic (ascending & descending):' };
        if (mode === 'minor') {
            return [
                { label: L.nat,  data: buildScaleData(tonic, 'minor', 'minor') },
                { label: L.harm, data: buildScaleData(tonic, 'minor', 'harmonicMinor') },
                { label: L.mel,  data: buildMelodicMinorBothWays(tonic) }
            ];
        }
        return [
            { label: L.nat,  data: buildScaleData(tonic, 'major', 'major') },
            { label: L.harm, data: buildScaleData(tonic, 'major', 'harmonicMajor') },
            { label: L.mel,  data: buildScaleData(tonic, 'major', 'major') }
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

        const notes = [];
        notes.push({ keys: [noteKey(I), noteKey(III), noteKey(V)], duration: 'w', label: 'T53' });
        if (withInversions) {
            notes.push({ keys: [noteKey(III), noteKey(V), noteKey(I8)], duration: 'w', label: 'T6' });
            notes.push({ keys: [noteKey(V), noteKey(I8), noteKey(III8)], duration: 'w', label: 'T64' });
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
        const defs = [
            [4, 7, 'Б53'],   // мажорное (Большое)
            [3, 7, 'М53'],   // минорное (Малое)
            [4, 8, 'Ув53'],  // увеличенное
            [3, 6, 'Ум53']   // уменьшенное
        ];
        const notes = defs.map(([t, f, label]) => ({
            keys: [noteKey(r), noteKey(buildIntervalUp(r, 3, t)), noteKey(buildIntervalUp(r, 5, f))],
            duration: 'w',
            label
        }));
        return { clef: 'treble', keySignature: 'C', timeSignature: '', barlines: 'none', notes };
    }

    // ---------- Доминантсептаккорд D7 + обращения (+ разрешения в тонику) ----------
    function buildDominantSeventh(tonic, mode, withInversions, withResolutions) {
        const scale = buildScale(tonic, mode);
        const V = { ...scale[4], octave: 4 }; // доминанта
        const third = buildIntervalUp(V, 3, 4);   // большая терция (вводный тон)
        const fifth = buildIntervalUp(V, 5, 7);
        const seventh = buildIntervalUp(V, 7, 10); // малая септима
        const V8 = buildIntervalUp(V, 8, 12);
        const third8 = buildIntervalUp(V8, 3, 4);
        const fifth8 = buildIntervalUp(V8, 5, 7);

        // Тоника для разрешений: I (тоника), III (терция лада), V (квинта) в разных октавах.
        const T1 = { ...tonic, octave: 4 };
        const thirdSemis = mode === 'major' ? 4 : 3;
        const t1 = T1;                                 // I
        const t1up = buildIntervalUp(T1, 8, 12);       // I октавой выше
        const t1up2 = buildIntervalUp(t1up, 8, 12);    // I двумя октавами выше
        const med = buildIntervalUp(T1, 3, thirdSemis);      // III
        const medUp = buildIntervalUp(t1up, 3, thirdSemis);  // III октавой выше
        const dom = buildIntervalUp(T1, 5, 7);         // V
        const domUp = buildIntervalUp(t1up, 5, 7);     // V октавой выше

        const dur = withResolutions ? 'h' : 'w';
        const notes = [];
        const push = (keys, label, barAfter) => {
            const c = { keys, duration: dur, label };
            if (barAfter) c.barAfter = true;
            notes.push(c);
        };

        // D7 → T (неполное трезвучие: основной тон утроен, без квинты)
        push([noteKey(V), noteKey(third), noteKey(fifth), noteKey(seventh)], 'D7', false);
        if (withResolutions) push([noteKey(t1), noteKey(t1up), noteKey(medUp)], 'T53', true);

        if (withInversions) {
            // D65 → T53 (полное трезвучие)
            push([noteKey(third), noteKey(fifth), noteKey(seventh), noteKey(V8)], 'D65', false);
            if (withResolutions) push([noteKey(t1up), noteKey(medUp), noteKey(domUp)], 'T53', true);

            // D43 → T53 (с удвоенным основным тоном)
            push([noteKey(fifth), noteKey(seventh), noteKey(V8), noteKey(third8)], 'D43', false);
            if (withResolutions) push([noteKey(t1up), noteKey(medUp), noteKey(domUp), noteKey(t1up2)], 'T53', true);

            // D2 → T6 (тоника в первом обращении)
            push([noteKey(seventh), noteKey(V8), noteKey(third8), noteKey(fifth8)], 'D2', false);
            if (withResolutions) push([noteKey(med), noteKey(dom), noteKey(t1up)], 'T6', true);
        }

        // Хвостовую тактовую черту убираем.
        if (withResolutions && notes.length) delete notes[notes.length - 1].barAfter;

        return {
            clef: 'treble',
            keySignature: keySigFor(tonic, mode),
            timeSignature: '',
            barlines: withResolutions ? 'manual' : 'none',
            notes
        };
    }

    // ---------- Ключевые знаки для VexFlow ----------
    const VEX_MAJOR = new Set(['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']);
    const VEX_MINOR = new Set(['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']);

    function keySigFor(tonic, mode) {
        // ВАЖНО: возвращаем 'C' (без ключевых знаков) НАМЕРЕННО.
        // Рендерер (buildStaveNote) рисует диезы/бемоли явно, но НЕ ставит бекары
        // для отмены ключевых знаков. Если бы мы выдавали реальный ключ (напр. Dm = си-бемоль),
        // то нота «си-бекар» в мелодическом миноре отрисовалась бы как си-бемоль — неверно.
        // Без ключевых знаков каждая альтерация показывается явно, а чистые ступени — без знаков,
        // что гарантирует визуально КОРРЕКТНЫЕ ноты для любого лада.
        // (имя/режим оставлены в сигнатуре для совместимости и возможного будущего использования)
        void tonic; void mode;
        return 'C';
    }

    // ---------- Парсер запроса ----------
    const RU_NOTES = [
        ['до-диез', { letter: 'c', acc: 1 }], ['до диез', { letter: 'c', acc: 1 }],
        ['ре-бемоль', { letter: 'd', acc: -1 }], ['ре бемоль', { letter: 'd', acc: -1 }],
        ['ре-диез', { letter: 'd', acc: 1 }], ['ре диез', { letter: 'd', acc: 1 }],
        ['ми-бемоль', { letter: 'e', acc: -1 }], ['ми бемоль', { letter: 'e', acc: -1 }],
        ['фа-диез', { letter: 'f', acc: 1 }], ['фа диез', { letter: 'f', acc: 1 }],
        ['соль-бемоль', { letter: 'g', acc: -1 }], ['соль бемоль', { letter: 'g', acc: -1 }],
        ['соль-диез', { letter: 'g', acc: 1 }], ['соль диез', { letter: 'g', acc: 1 }],
        ['ля-бемоль', { letter: 'a', acc: -1 }], ['ля бемоль', { letter: 'a', acc: -1 }],
        ['ля-диез', { letter: 'a', acc: 1 }], ['ля диез', { letter: 'a', acc: 1 }],
        ['си-бемоль', { letter: 'b', acc: -1 }], ['си бемоль', { letter: 'b', acc: -1 }],
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

        if (!tonic || mode === null) return null;
        return { tonic: { ...tonic, octave: 4 }, mode };
    }

    function parseExercise(t) {
        if (/тритон|tritone/.test(t)) return 'tritone';
        if (/характерн\w*\s*интервал|характерные\b|characteristic\s*interval|\bх\.\s*и\./.test(t)) return 'characteristic';
        if (/доминантсепт|доминантов\w*\s*септ|\bd7\b|dominant\s*seventh/.test(t)) return 'dominant7';
        if (/(все\s*)?виды\s*трезвучи\w*\s*от|types?\s*of\s*triads?\s*from/.test(t)) return 'allTriadsFromNote';
        if (/гамм|звукоряд\b|\bscale\b/.test(t)) return 'scale';
        if (/трезвучи|triad/.test(t)) return 'triad';
        return null;
    }

    function wantsInversions(t) {
        // «appeal» — частый машинный перевод слова «обращения» (Google Translate и т.п.).
        return /обращени|inversion|appeal/.test(t);
    }

    /** «все виды / все гаммы / три вида / all types of scales» → строим сразу несколько форм. */
    function wantsAllForms(t) {
        return /все\s*вид|все\s*гамм|три\s*вид|виды\s*гамм|all\s*(the\s*)?(types?|kinds?|forms?)|all\s*scales?/.test(t);
    }

    function wantsResolution(t) {
        // «permission» — частый машинный перевод слова «разрешения».
        return /разрешени|resolution|resolv|permission/.test(t);
    }

    // ---------- Сборка блока по запросу ----------
    function buildNotationForQuery(rawQuery) {
        if (!rawQuery || typeof rawQuery !== 'string') return null;
        const t = rawQuery.toLowerCase().replace(/ё/g, 'е');

        const exercise = parseExercise(t);
        if (!exercise) return null;

        // "Все виды трезвучий от ноты N" — тональность не нужна, нужна только нота.
        if (exercise === 'allTriadsFromNote') {
            const note = parseSingleNote(t);
            if (!note) return null;
            return finalize(buildAllTriadsFromNote(note));
        }

        // Тональность не указана (например «build me a D7» без ключа) → по умолчанию C-dur.
        // Так движок всегда построит корректный пример, а не отдаёт null (из-за чего раньше
        // при включённом режиме нотации могло ничего не нарисоваться).
        const key = parseKey(t) || { tonic: { letter: 'c', acc: 0, octave: 4 }, mode: 'major' };
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
                // «все виды гамм» → несколько блоков (натуральная/гармоническая/мелодическая)
                if (wantsAllForms(t) && !form) {
                    const isRu = /[а-яё]/.test(t);
                    return finalizeMulti(buildAllScaleForms(key.tonic, key.mode, isRu));
                }
                data = buildScaleExercise(key.tonic, key.mode, form);
                break;
            case 'triad':
                data = buildTonicTriadExercise(key.tonic, key.mode, wantsInversions(t));
                break;
            case 'dominant7':
                data = buildDominantSeventh(key.tonic, key.mode, wantsInversions(t), wantsResolution(t));
                break;
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

    function finalize(data) {
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
            const label = it.label ? `${it.label}\n` : '';
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

    window.SolfTheory = {
        buildNotationForQuery,
        applyBlock,
        autoLabelNotation,
        describeKeys,
        // экспонируем для отладки/тестов
        _internal: { buildScale, buildIntervalUp, noteKey, buildTritones, buildCharacteristic, parseKey, parseExercise, classifyTriad, classifySeventh }
    };
})();
