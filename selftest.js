// ===== SOLF.AI — САМОПРОВЕРКА ТЕОРЕТИЧЕСКОГО ДВИЖКА =====
// Открой selftest.html в браузере. Страница прогоняет все построения по всем
// тональностям и проверяет их арифметикой (полутоны, ступеневые величины,
// валидность нотных блоков). В приложение этот файл НЕ подключается.

(function () {
    'use strict';

    const T = window.SolfTheory;
    const I = T && T._internals;
    const results = [];
    let passCount = 0;
    let failCount = 0;

    function check(name, fn) {
        let ok = false;
        let detail = '';
        try {
            const r = fn();
            if (r === true || r === undefined) ok = true;
            else if (typeof r === 'string') { ok = false; detail = r; }
            else ok = !!r;
        } catch (err) {
            detail = 'exception: ' + (err && err.message ? err.message : String(err));
        }
        if (ok) passCount++; else failCount++;
        results.push({ name, ok, detail });
    }

    // ---------- утилиты ----------
    const KEY_RE = /^[a-g](#|##|b|bb)?\/\d$/;
    const BLOCK_RE = /\[\[NOTATION:([\s\S]*?)\]\]/g;

    function extractBlocks(blockString) {
        const out = [];
        let m;
        BLOCK_RE.lastIndex = 0;
        while ((m = BLOCK_RE.exec(String(blockString || '')))) {
            out.push(JSON.parse(m[1]));
        }
        return out;
    }

    /** Общая валидация: JSON разбирается, ключи корректны, подписи строковые. */
    function validateBlockString(blockString, label) {
        const blocks = extractBlocks(blockString);
        if (!blocks.length) return label + ': нет ни одного блока';
        for (const b of blocks) {
            if (!Array.isArray(b.notes) || !b.notes.length) return label + ': пустой notes';
            for (const n of b.notes) {
                if (!Array.isArray(n.keys) || !n.keys.length) return label + ': нота без keys';
                for (const k of n.keys) {
                    if (!KEY_RE.test(k)) return label + ': некорректный key "' + k + '"';
                }
                if (n.label != null && typeof n.label !== 'string') return label + ': label не строка';
                if (!n.duration) return label + ': нота без duration';
            }
            if (b.barlines && !['auto', 'none', 'manual'].includes(b.barlines)) {
                return label + ': неизвестный barlines ' + b.barlines;
            }
        }
        return true;
    }

    function noteAbsOf(key) {
        const p = I.parseVexKey(key);
        return p ? I.noteAbs(p) : null;
    }

    /** Полутоновая «подпись» аккорда от нижнего звука. */
    function chordSignature(keys) {
        const abs = keys.map(noteAbsOf).filter(v => v != null).sort((a, b) => a - b);
        const root = abs[0];
        return abs.slice(1).map(a => (a - root) % 12).join(',');
    }

    // Все 30 тональностей, для которых есть эталонные аппликатуры D7.
    const PRESET_KEYS = Object.keys(I ? I.D7_PRESETS : {}).map(id => {
        const m = id.match(/^([a-g])(#|b)?-(major|minor)$/);
        return m ? { letter: m[1], acc: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, mode: m[3], id } : null;
    }).filter(Boolean);

    function enQuery(k, text) {
        const acc = k.acc === 1 ? '#' : k.acc === -1 ? 'b' : '';
        return text.replace('%KEY%', k.letter + acc + ' ' + k.mode);
    }

    // =====================================================================
    // 1. Разбор названий интервалов
    // =====================================================================
    const SPEC_CASES = [
        ['построй б3 от ре', 3, 4],
        ['построй м3 от ре', 3, 3],
        ['построй ув4 от фа', 4, 6],
        ['построй ум5 от си', 5, 6],
        ['построй ч5 от ре', 5, 7],
        ['построй ув2 от ля', 2, 3],
        ['построй ум7 от соль', 7, 9],
        ['построй большую сексту от ми', 6, 9],
        ['построй малую септиму от до', 7, 10],
        ['построй большую септиму в ми минор', 7, 11],
        ['большую септиму', 7, 11],
        ['построй уменьшенную квинту от си', 5, 6],
        ['построй чистую кварту от ля', 4, 5],
        ['build M3 from C', 3, 4],
        ['build m3 from C', 3, 3],
        ['build A4 from F', 4, 6],
        ['build d5 from B', 5, 6],
        ['build P5 from D', 5, 7],
        ['build a major sixth from E', 6, 9],
        ['build a diminished fifth from B', 5, 6]
    ];
    SPEC_CASES.forEach(([q, degree, semis]) => {
        check('разбор интервала: "' + q + '"', () => {
            const spec = I.parseIntervalSpec(q);
            if (!spec) return 'не распознан';
            if (spec.degree !== degree || spec.semis !== semis) {
                return 'получено ' + spec.degree + '/' + spec.semis + ', ожидалось ' + degree + '/' + semis;
            }
            return true;
        });
    });

    check('«б53» не путается с интервалом', () => I.parseIntervalSpec('построй б53 от ре') === null || 'б53 распознан как интервал');
    check('«ум53» не путается с интервалом', () => I.parseIntervalSpec('построй ум53 от ре') === null || 'ум53 распознан как интервал');

    // =====================================================================
    // 2. Интервалы от звука: арифметика по всем нотам
    // =====================================================================
    const ALL_NOTES = [];
    ['c', 'd', 'e', 'f', 'g', 'a', 'b'].forEach(letter => {
        [-1, 0, 1].forEach(acc => ALL_NOTES.push({ letter, acc, octave: 4 }));
    });

    check('интервалы вверх от всех 21 нот: ступень и полутоны совпадают', () => {
        const specs = [[1, 0], [2, 1], [2, 2], [3, 3], [3, 4], [4, 5], [4, 6], [5, 6], [5, 7], [6, 8], [6, 9], [7, 9], [7, 10], [7, 11], [8, 12]];
        for (const note of ALL_NOTES) {
            for (const [degree, semis] of specs) {
                const hi = I.buildIntervalUp(note, degree, semis);
                if (I.intervalDegree(note, hi) !== degree) return 'ступень: ' + I.noteKey(note) + ' ' + degree + '/' + semis;
                if (I.intervalSemis(note, hi) !== semis) return 'полутоны: ' + I.noteKey(note) + ' ' + degree + '/' + semis;
            }
        }
        return true;
    });

    check('интервалы вниз от всех 21 нот: ступень и полутоны совпадают', () => {
        const specs = [[2, 1], [2, 2], [3, 3], [3, 4], [4, 5], [5, 7], [6, 8], [6, 9], [7, 10], [7, 11], [8, 12]];
        for (const note of ALL_NOTES) {
            for (const [degree, semis] of specs) {
                const lo = I.buildIntervalDown(note, degree, semis);
                if (I.intervalDegree(lo, note) !== degree) return 'ступень: ' + I.noteKey(note) + ' -' + degree + '/' + semis;
                if (I.intervalSemis(lo, note) !== semis) return 'полутоны: ' + I.noteKey(note) + ' -' + degree + '/' + semis;
            }
        }
        return true;
    });

    check('обращение интервала: сумма полутонов = 12, ступень = 9 − исходной', () => {
        for (const note of ALL_NOTES) {
            for (const [degree, semis] of [[2, 1], [2, 2], [3, 3], [3, 4], [4, 5], [4, 6], [5, 6], [5, 7], [6, 8], [6, 9], [7, 10], [7, 11]]) {
                const data = I.buildIntervalFromNote(note, degree, semis, 'up', true);
                if (!data) return 'не построено: ' + I.noteKey(note) + ' ' + degree + '/' + semis;
                if (data.notes.length !== 2) return 'нет обращения: ' + I.noteKey(note);
                const a = data.notes[0].keys.map(noteAbsOf);
                const b = data.notes[1].keys.map(noteAbsOf);
                const sum = (a[1] - a[0]) + (b[1] - b[0]);
                if (sum !== 12) return 'сумма полутонов ' + sum + ' у ' + I.noteKey(note) + ' ' + degree + '/' + semis;
            }
        }
        return true;
    });

    check('все простые интервалы от звука: 12 созвучий с корректными подписями', () => {
        for (const note of ALL_NOTES) {
            const data = I.buildAllIntervalsFromNote(note);
            if (!data) return 'не построено от ' + I.noteKey(note);
            if (data.notes.length !== 12) return 'созвучий ' + data.notes.length + ' вместо 12';
            for (const n of data.notes) {
                if (!n.label) return 'нет подписи у интервала от ' + I.noteKey(note);
            }
        }
        return true;
    });

    // =====================================================================
    // 3. Трезвучия и септаккорды от звука
    // =====================================================================
    check('трезвучия всех видов от звука: строение и обращения', () => {
        const kinds = { major: '4,7', minor: '3,7', aug: '4,8', dim: '3,6' };
        for (const note of ALL_NOTES) {
            for (const kind of Object.keys(kinds)) {
                const data = I.buildTriadFromNote(note, kind, true);
                if (!data) return 'не построено ' + kind + ' от ' + I.noteKey(note);
                if (data.notes.length !== 3) return 'нет трёх обращений ' + kind;
                for (const n of data.notes) {
                    if (n.keys.length !== 3) return kind + ': не три звука';
                    const pcs = new Set(n.keys.map(k => I.pc(I.parseVexKey(k))));
                    if (pcs.size !== 3) return kind + ': повтор звука в обращении от ' + I.noteKey(note);
                }
            }
        }
        return true;
    });

    check('все виды септаккордов от звука: 7 аккордов с верным строением', () => {
        for (const note of ALL_NOTES) {
            const data = I.buildAllSeventhsFromNote(note);
            if (!data) return 'не построено от ' + I.noteKey(note);
            if (data.notes.length !== I.SEVENTH_KIND_DEFS.length) return 'аккордов ' + data.notes.length;
            data.notes.forEach((n, idx) => {
                const def = I.SEVENTH_KIND_DEFS[idx];
                const abs = n.keys.map(noteAbsOf);
                const sig = [abs[1] - abs[0], abs[2] - abs[0], abs[3] - abs[0]].join(',');
                if (sig !== def.semis.join(',')) {
                    throw new Error('строение ' + def.ru + ' от ' + I.noteKey(note) + ': ' + sig + ' вместо ' + def.semis.join(','));
                }
            });
        }
        return true;
    });

    // =====================================================================
    // 4. Хроматическая гамма
    // =====================================================================
    function chromaticKeys(letter, acc, mode, dir) {
        const data = I.buildChromaticScale({ letter, acc, octave: 4 }, mode, dir);
        return data ? data.notes.map(n => n.keys[0]) : null;
    }

    check('хроматическая гамма до мажор вверх — эталонное правописание', () => {
        const got = chromaticKeys('c', 0, 'major', 'up').join(' ');
        const want = 'c/4 c#/4 d/4 d#/4 e/4 f/4 f#/4 g/4 ab/4 a/4 a#/4 b/4 c/5';
        return got === want || 'получено: ' + got;
    });
    check('хроматическая гамма до мажор вниз — эталонное правописание', () => {
        const got = chromaticKeys('c', 0, 'major', 'down').join(' ');
        const want = 'c/5 b/4 bb/4 a/4 ab/4 g/4 f#/4 f/4 e/4 eb/4 d/4 db/4 c/4';
        return got === want || 'получено: ' + got;
    });
    check('хроматическая гамма ля минор вверх — эталонное правописание', () => {
        const got = chromaticKeys('a', 0, 'minor', 'up').join(' ');
        const want = 'a/4 bb/4 b/4 c/5 c#/5 d/5 d#/5 e/5 f/5 f#/5 g/5 g#/5 a/5';
        return got === want || 'получено: ' + got;
    });
    check('хроматическая гамма ля минор вниз — эталонное правописание', () => {
        const got = chromaticKeys('a', 0, 'minor', 'down').join(' ');
        const want = 'a/5 ab/5 g/5 gb/5 f/5 e/5 d#/5 d/5 db/5 c/5 b/4 bb/4 a/4';
        return got === want || 'получено: ' + got;
    });

    // Теоретические тональности (8–10 диезов): хроматическая гамма в них требует
    // третьего знака, записать её нельзя — движок обязан вернуть null, а не мусор.
    const THEORETICAL_KEYS = new Set(['g#-major', 'd#-major', 'a#-major']);

    check('хроматическая гамма во всех 30 тональностях: 13 звуков по полутону', () => {
        for (const k of PRESET_KEYS) {
            for (const dir of ['up', 'down']) {
                const keys = chromaticKeys(k.letter, k.acc, k.mode, dir);
                // В теоретических тональностях отказ (null) — правильное поведение.
                if (!keys && THEORETICAL_KEYS.has(k.id)) continue;
                if (!keys) return 'не построена: ' + k.id + ' ' + dir;
                if (keys.length !== 13) return k.id + ' ' + dir + ': звуков ' + keys.length;
                for (let i = 1; i < keys.length; i++) {
                    const step = noteAbsOf(keys[i]) - noteAbsOf(keys[i - 1]);
                    if (Math.abs(step) !== 1) return k.id + ' ' + dir + ': шаг ' + step + ' между ' + keys[i - 1] + ' и ' + keys[i];
                }
                const first = I.pc(I.parseVexKey(keys[0]));
                const last = I.pc(I.parseVexKey(keys[12]));
                if (first !== last) return k.id + ': начало и конец не тоника';
                for (const key of keys) {
                    if (!KEY_RE.test(key)) return k.id + ': некорректный key ' + key;
                }
            }
        }
        return true;
    });

    // =====================================================================
    // 5. Лады народной музыки
    // =====================================================================
    check('лады и пентатоника: интервальное строение от любой тоники', () => {
        for (const modeName of Object.keys(I.MODE_DEFS)) {
            const def = I.MODE_DEFS[modeName];
            for (const note of ALL_NOTES) {
                const data = I.buildModeScale(note, modeName);
                if (!data) return 'не построен ' + modeName + ' от ' + I.noteKey(note);
                if (data.notes.length !== def.semis.length + 1) return modeName + ': звуков ' + data.notes.length;
                const abs = data.notes.map(n => noteAbsOf(n.keys[0]));
                for (let i = 0; i < def.semis.length; i++) {
                    if (abs[i] - abs[0] !== def.semis[i]) {
                        return modeName + ' от ' + I.noteKey(note) + ': ступень ' + (i + 1) + ' = ' + (abs[i] - abs[0]) + ' вместо ' + def.semis[i];
                    }
                }
                if (abs[def.semis.length] - abs[0] !== 12) return modeName + ': нет замыкающей октавы';
            }
        }
        return true;
    });

    // =====================================================================
    // 6. VII7 и II7 с разрешением
    // =====================================================================
    check('VII7 во всех тональностях: строение, разрешение, подписи', () => {
        for (const k of PRESET_KEYS) {
            const tonic = { letter: k.letter, acc: k.acc, octave: 4 };
            const data = I.buildViiSeventhInKey(tonic, k.mode, false);
            if (!data) return 'не построен: ' + k.id;
            if (data.notes.length !== 3) return k.id + ': аккордов ' + data.notes.length;
            if (data.notes[0].label !== 'VII7' || data.notes[1].label !== 'D65') return k.id + ': неверные подписи';
            const sig = chordSignature(data.notes[0].keys);
            const want = k.mode === 'major' ? '3,6,10' : '3,6,9';
            if (sig !== want) return k.id + ': строение VII7 ' + sig + ' вместо ' + want;
            // Уменьшённый вводный в гармоническом мажоре.
            if (k.mode === 'major') {
                const harm = I.buildViiSeventhInKey(tonic, 'major', true);
                if (!harm) return k.id + ': нет гармонического варианта';
                if (chordSignature(harm.notes[0].keys) !== '3,6,9') {
                    return k.id + ': гарм. мажор VII7 = ' + chordSignature(harm.notes[0].keys);
                }
            }
        }
        return true;
    });

    check('II7 во всех тональностях: строение, разрешение, подписи', () => {
        for (const k of PRESET_KEYS) {
            const tonic = { letter: k.letter, acc: k.acc, octave: 4 };
            const data = I.buildSecondSeventhInKey(tonic, k.mode, false);
            if (!data) return 'не построен: ' + k.id;
            if (data.notes.length !== 3) return k.id + ': аккордов ' + data.notes.length;
            if (data.notes[0].label !== 'II7' || data.notes[1].label !== 'D43') return k.id + ': неверные подписи';
            const sig = chordSignature(data.notes[0].keys);
            const want = k.mode === 'major' ? '3,7,10' : '3,6,10';
            if (sig !== want) return k.id + ': строение II7 ' + sig + ' вместо ' + want;
        }
        return true;
    });

    check('VII7 и II7: разрешение ведёт в тонику', () => {
        for (const k of PRESET_KEYS) {
            const tonic = { letter: k.letter, acc: k.acc, octave: 4 };
            const tonicPc = I.pc(tonic);
            for (const build of [I.buildViiSeventhInKey, I.buildSecondSeventhInKey]) {
                const data = build(tonic, k.mode, false);
                if (!data) return 'нет построения для ' + k.id;
                const last = data.notes[data.notes.length - 1];
                const bassPc = I.pc(I.parseVexKey(last.keys.slice().sort((a, b) => noteAbsOf(a) - noteAbsOf(b))[0]));
                if (bassPc !== tonicPc) return k.id + ': разрешение не в тонику (бас ' + last.keys[0] + ')';
            }
        }
        return true;
    });

    // =====================================================================
    // 7. Ступени: разрешение и опевание
    // =====================================================================
    check('разрешение неустойчивых ступеней: 4 пары, движение на шаг', () => {
        for (const k of PRESET_KEYS) {
            const tonic = { letter: k.letter, acc: k.acc, octave: 4 };
            const data = I.buildUnstableResolutions(tonic, k.mode);
            if (!data) return 'не построено: ' + k.id;
            if (data.notes.length !== 8) return k.id + ': нот ' + data.notes.length;
            for (let i = 0; i < 8; i += 2) {
                const step = Math.abs(noteAbsOf(data.notes[i + 1].keys[0]) - noteAbsOf(data.notes[i].keys[0]));
                if (step < 1 || step > 2) return k.id + ': разрешение скачком на ' + step + ' полутона';
            }
        }
        return true;
    });

    check('опевание устоев: 3 группы по 3 звука вокруг I, III, V', () => {
        for (const k of PRESET_KEYS) {
            const tonic = { letter: k.letter, acc: k.acc, octave: 4 };
            const data = I.buildOpevanie(tonic, k.mode);
            if (!data) return 'не построено: ' + k.id;
            if (data.notes.length !== 9) return k.id + ': нот ' + data.notes.length;
            for (let g = 0; g < 3; g++) {
                const up = noteAbsOf(data.notes[g * 3].keys[0]);
                const down = noteAbsOf(data.notes[g * 3 + 1].keys[0]);
                const stable = noteAbsOf(data.notes[g * 3 + 2].keys[0]);
                if (!(up > stable && down < stable)) return k.id + ': группа ' + (g + 1) + ' не опевает устой';
            }
        }
        return true;
    });

    // =====================================================================
    // 8. Сквозная проверка маршрутизации запросов по всем тональностям
    // =====================================================================
    const ROUTED = [
        ['build the scale in %KEY%', null],
        ['build tritones in %KEY%', null],
        ['build characteristic intervals in %KEY%', null],
        ['build d7 with inversions and resolutions in %KEY%', 8],
        ['build the chain in %KEY%', null],
        ['build the leading-tone seventh VII7 with resolution in %KEY%', 3],
        ['build the supertonic seventh II7 with resolution in %KEY%', 3],
        ['build the chromatic scale in %KEY% up and down', null],
        ['resolve the unstable degrees in %KEY%', 8],
        ['build the main triads in %KEY%', null]
    ];

    const routingMisses = [];
    check('маршрутизация запросов: все блоки валидны во всех 30 тональностях', () => {
        for (const k of PRESET_KEYS) {
            for (const [tpl, expectedNotes] of ROUTED) {
                const q = enQuery(k, tpl);
                const res = T.buildNotationForQuery(q);
                if (!res || !res.blockString) { routingMisses.push(q); continue; }
                const v = validateBlockString(res.blockString, q);
                if (v !== true) return v;
                if (expectedNotes != null) {
                    const blocks = extractBlocks(res.blockString);
                    const total = blocks.reduce((s, b) => s + b.notes.length, 0);
                    if (total !== expectedNotes) return q + ': нот ' + total + ' вместо ' + expectedNotes;
                }
            }
        }
        return true;
    });

    const RU_ROUTED = [
        'построй гамму в ре минор',
        'построй тритоны в соль миноре',
        'построй характерные интервалы в фа мажоре',
        'построй d7 с обращениями и разрешениями в ля мажоре',
        'построй цепочку 2 в до миноре',
        'построй вводный септаккорд с разрешением в ре мажоре',
        'построй септаккорд второй ступени с разрешением в ля миноре',
        'построй хроматическую гамму в ми мажоре вверх и вниз',
        'разрешение неустойчивых ступеней в си-бемоль мажоре',
        'опевание устойчивых ступеней в ми миноре',
        'построй б3 от ре',
        'построй м6 вниз от соль',
        'построй ув4 от фа с обращением',
        'построй все интервалы от ноты до',
        'построй все виды септаккордов от ноты ре',
        'построй мажорное трезвучие от фа с обращениями',
        'построй дорийский лад от ре',
        'построй минорную пентатонику от ля',
        'построй главные трезвучия в до мажоре с обращениями'
    ];
    RU_ROUTED.forEach(q => {
        check('русский запрос: "' + q + '"', () => {
            const res = T.buildNotationForQuery(q);
            if (!res || !res.blockString) return 'запрос не распознан движком';
            return validateBlockString(res.blockString, q);
        });
    });

    check('хроматическая гамма «вверх и вниз» = два блока по 13 звуков', () => {
        const res = T.buildNotationForQuery('построй хроматическую гамму в до мажоре вверх и вниз');
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        if (blocks.length !== 2) return 'блоков ' + blocks.length;
        if (blocks[0].notes.length !== 13 || blocks[1].notes.length !== 13) return 'нот не по 13';
        return true;
    });

    check('«гамму хроматическую от фа» — хроматика, не нат/гарм/мел', () => {
        T.setLabelLocale('ru');
        const q = 'Привет, построй мне гамму хроматическую от фа';
        const res = T.buildNotationForQuery(q);
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        if (blocks.length !== 1) return 'ожидался 1 блок хроматики, получено ' + blocks.length;
        if (blocks[0].notes.length !== 13) return 'ожидалось 13 звуков, получено ' + blocks[0].notes.length;
        const first = blocks[0].notes[0].keys[0];
        if (!/^f\/\d$/.test(first)) return 'должна начинаться с фа, а не ' + first;
        if (/натуральн|гармоническ|мелодическ/i.test(res.blockString)) return 'попали обычные формы гаммы';
        return true;
    });

    check('«хроматическую гамму от ре» тоже хроматика', () => {
        const res = T.buildNotationForQuery('построй хроматическую гамму от ре');
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        return (blocks.length === 1 && blocks[0].notes.length === 13)
            || 'блоков ' + blocks.length + ', нот ' + (blocks[0] && blocks[0].notes.length);
    });

    check('«построй гамму» не подменяется хроматической', () => {
        const res = T.buildNotationForQuery('построй гамму до мажор');
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        if (blocks.length < 3) return 'ожидались натуральная, гармоническая и мелодическая формы, блоков ' + blocks.length;
        return true;
    });

    check('D7-запрос не понимается как интервал ум7', () => {
        const res = T.buildNotationForQuery('построй d7 с обращениями и разрешениями в до мажоре');
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        const total = blocks.reduce((s, b) => s + b.notes.length, 0);
        return total === 8 || 'аккордов ' + total;
    });

    check('D7 в фа минор: т3 — не одна нота (утроение примы видно)', () => {
        T.setLabelLocale('ru');
        const res = T.buildNotationForQuery('построй д7 в фа минор');
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        if (!blocks.length) return 'блоков нет';
        const notes = blocks[0].notes;
        // D7, т3, D6/5, т53, ...
        const t3 = notes.find(n => /т3|t3/i.test(n.label || ''));
        if (!t3) return 'нет аккорда т3, labels: ' + notes.map(n => n.label).join(',');
        if (t3.keys.length < 3) {
            return 'т3 должно быть ≥3 нот (утроенная прима + терция), получено '
                + t3.keys.length + ': ' + t3.keys.join(',');
        }
        const roots = t3.keys.filter(k => /^f\//i.test(k));
        if (roots.length < 2) return 'мало удвоений фа: ' + t3.keys.join(',');
        return true;
    });

    check('м7 от си — малая септима (интервал), не септаккорд', () => {
        T.setLabelLocale('ru');
        const res = T.buildNotationForQuery('построй м7 от си');
        if (!res) return 'не распознано';
        const blocks = extractBlocks(res.blockString);
        if (!blocks.length) return 'блоков нет';
        const note = blocks[0].notes[0];
        if (note.keys.length !== 2) return 'ожидались 2 ноты интервала, получено ' + note.keys.length + ': ' + note.keys.join(',');
        const keys = note.keys.slice().sort().join(',');
        const expected = ['a/5', 'b/4'].sort().join(',');
        return keys === expected || 'ноты ' + keys + ', ожидалось ' + expected;
    });

    check('голое m7/м7 не парсится как септаккорд', () => {
        const kind = T._internals.parseSeventhKind('построй м7 от ре');
        return kind === null || 'kind=' + kind + ' (ожидался null — это интервал)';
    });

    check('все простые интервалы от до — быстрый ответ движка', () => {
        T.setLabelLocale('ru');
        const specs = ['ч1', 'м2', 'б2', 'м3', 'б3', 'ч4', 'ч5', 'м6', 'б6', 'м7', 'б7', 'ч8'];
        for (const spec of specs) {
            const q = 'построй ' + spec + ' от до';
            const res = T.buildNotationForQuery(q);
            if (!res) return spec + ': не распознано';
            const blocks = extractBlocks(res.blockString);
            if (!blocks.length || !blocks[0].notes?.[0]?.keys) return spec + ': нет нот';
            if (blocks[0].notes[0].keys.length !== 2) return spec + ': ожидались 2 ноты, ' + blocks[0].notes[0].keys.length;
            const desc = T.getBuildDescription(q);
            if (!desc) return spec + ': нет текстового описания';
        }
        return true;
    });

    check('интервалы от разных нот (ре/ми/фа/соль/ля/си)', () => {
        T.setLabelLocale('ru');
        const notes = ['ре', 'ми', 'фа', 'соль', 'ля', 'си'];
        const specs = ['б3', 'ч5', 'м7'];
        for (const note of notes) {
            for (const spec of specs) {
                const q = 'построй ' + spec + ' от ' + note;
                const res = T.buildNotationForQuery(q);
                if (!res) return q + ': не распознано';
                if (extractBlocks(res.blockString)[0].notes[0].keys.length !== 2) return q + ': не интервал';
            }
        }
        return true;
    });

    check('описание м7 от си — малая септима си–ля', () => {
        T.setLabelLocale('ru');
        const desc = T.getBuildDescription('построй м7 от си');
        if (!/мал/i.test(desc) || !/септим/i.test(desc)) return 'нет «малая септима»: ' + desc;
        if (!desc.includes('си') || !desc.includes('ля')) return 'нет си–ля: ' + desc;
        if (desc.includes('фа-диез') || desc.includes('септаккорд')) return 'это не аккорд: ' + desc;
        return true;
    });

    check('запрос без ноты после «от» не ломает движок', () => {
        const res = T.buildNotationForQuery('построй б3');
        return res === null || (res.blockString ? validateBlockString(res.blockString, 'б3') : true);
    });

    check('мусорный ввод не вызывает исключений', () => {
        ['', '   ', '?????', 'привет', 'построй', '[[NOTATION:{broken', 'от от от', '12345'].forEach(q => {
            T.buildNotationForQuery(q);
            T.buildTheoryQuickAnswer(q);
            T.getExerciseIntro(q);
        });
        return true;
    });

    // =====================================================================
    // 9. Мгновенные текстовые ответы
    // =====================================================================
    const QUICK_CASES = [
        ['сколько знаков в ре мажоре', ['2', 'диеза']],
        ['параллельная тональность до мажора', ['ля минор']],
        ['одноимённая тональность до мажора', ['до минор']],
        ['какая тональность с 3 диезами', ['ля мажор', 'фа-диез минор']],
        ['какая тональность с 4 бемолями', ['ля-бемоль мажор', 'фа минор']],
        ['обращение большой терции', ['м6']],
        ['энгармонически равная тональность до-диез мажора', ['ре-бемоль мажор']]
    ];
    QUICK_CASES.forEach(([q, needles]) => {
        check('мгновенный ответ: "' + q + '"', () => {
            T.setLabelLocale('ru');
            const res = T.buildTheoryQuickAnswer(q);
            if (!res || !res.text) return 'ответа нет';
            for (const needle of needles) {
                if (!res.text.includes(needle)) return 'в ответе нет "' + needle + '": ' + res.text;
            }
            return true;
        });
    });

    check('«построй ...» не перехватывается текстовым ответом', () => {
        T.setLabelLocale('ru');
        const res = T.buildTheoryQuickAnswer('построй б3 от ре');
        return res === null || 'текстовый ответ перехватил построение';
    });

    // =====================================================================
    // 10. База знаний
    // =====================================================================
    check('база знаний загружена', () => !!(window.SolfKB && window.SolfKB.getPrompt) || 'window.SolfKB отсутствует');

    check('темы не дублируются и подбираются по смыслу', () => {
        const cases = {
            'построй гамму до мажор': 'scales',
            'что такое синкопа': 'rhythm',
            'как записать хроматическую гамму': 'chromatic',
            'что такое дорийский лад': 'modes',
            'гармонизуй мелодию': 'harmony',
            'что такое период в музыке': 'form',
            'как транспонировать на б2 вверх': 'transposition',
            'какая тональность параллельная для до мажора': 'keys'
        };
        for (const q of Object.keys(cases)) {
            const ids = window.SolfKB.selectTopicIds(q);
            if (new Set(ids).size !== ids.length) return 'дубликаты тем в "' + q + '"';
            if (!ids.includes(cases[q])) return '"' + q + '": ожидалась тема ' + cases[q] + ', получено [' + ids.join(',') + ']';
        }
        return true;
    });

    check('промпт не разрастается: ядро + не более 5 тем', () => {
        const long = 'построй гамму, тритоны, характерные интервалы, хроматическую гамму, дорийский лад, септаккорды, гармонизацию, период, транспозицию, модуляцию и диктант';
        const ids = window.SolfKB.selectTopicIds(long);
        if (ids.length > 5) return 'тем ' + ids.length;
        const size = window.SolfKB.getPrompt(long).length;
        if (size > 30000) return 'размер промпта ' + size;
        return true;
    });

    check('системный промпт движка содержит ядро правил', () => {
        const p = T.getSystemPrompt('построй б3 от ре');
        if (!p.includes('ЯДРО ТЕОРИИ')) return 'нет ядра правил';
        if (!p.includes('ВЫВОД УПРАЖНЕНИЙ')) return 'нет правил вывода упражнений';
        return true;
    });

    check('пустой запрос: промпт остаётся валидным', () => {
        const p = T.getSystemPrompt('');
        return p.length > 500 || 'промпт слишком короткий';
    });

    check('учебник: ув.2 в фа мажоре с разрешением (как на скрине)', () => {
        T.setLabelLocale('ru');
        const q = 'Постройте увеличенную секунду (ув.2) в тональности фа мажор, разрешите её по правилам лада и укажите, на каких ступенях она строится';
        const res = T.buildNotationForQuery(q);
        if (!res?.blockString) return 'не построено';
        const blocks = extractBlocks(res.blockString);
        if (blocks.length !== 1 || blocks[0].notes.length !== 2) return 'ожидалось 2 созвучия';
        const n0 = blocks[0].notes[0].keys.sort().join('+');
        const n1 = blocks[0].notes[1].keys.sort().join('+');
        if (n0 !== 'db/4+e/4' && !(n0.includes('db/') && n0.includes('e/') && I.pc(I.parseVexKey(n0.split('+')[0])) === I.pc({ letter: 'd', acc: -1, octave: 4 }))) return 'ув.2: ' + n0;
        if (n1 !== 'c/4+f/4' && !(n1.includes('c/') && n1.includes('f/'))) return 'разрешение: ' + n1;
        const intro = T.getExerciseIntro(q);
        if (!intro || !/VI/i.test(intro) || !/VII/i.test(intro)) return 'нет указания ступеней: ' + intro;
        return true;
    });

    check('учебник: определите интервал до-ми', () => {
        T.setLabelLocale('ru');
        const res = T.buildTheoryQuickAnswer('Определите интервал: до ми');
        if (!res?.text) return 'нет ответа';
        return res.text.includes('б.3') || res.text.includes('Б.3') || res.text.includes('б3') ? true : res.text;
    });

    check('учебник: тональность по двум бемолям', () => {
        T.setLabelLocale('ru');
        const res = T.buildTheoryQuickAnswer('Определите тональность по двум бемолям');
        if (!res?.text) return 'нет ответа';
        return (res.text.includes('си-бемоль') || res.text.includes('Bb')) && res.text.includes('минор') ? true : res.text;
    });

    check('учебник: обратите большую терцию — нотация', () => {
        const res = T.buildNotationForQuery('Обратите большую терцию');
        if (!res?.blockString) return 'не построено';
        const blocks = extractBlocks(res.blockString);
        return blocks[0]?.notes?.length === 2 ? true : 'созвучий ' + (blocks[0]?.notes?.length || 0);
    });

    check('учебник: большая септима в ми минор — не терция', () => {
        T.setLabelLocale('ru');
        const q = 'построй большую септиму в ми минор';
        const spec = I.parseIntervalSpec(q);
        if (!spec || spec.degree !== 7 || spec.semis !== 11) {
            return 'разбор: ' + (spec ? spec.degree + '/' + spec.semis : 'null');
        }
        const res = T.buildNotationForQuery(q);
        if (!res?.blockString) return 'не построено';
        const blocks = extractBlocks(res.blockString);
        if (!blocks[0] || blocks[0].notes.length !== 1) return 'ожидалось 1 созвучие';
        const label = blocks[0].notes[0].label || '';
        if (label !== 'б7') return 'подпись ' + label + ', ожидалось б7';
        const keys = blocks[0].notes[0].keys.sort().join('+');
        if (keys !== 'd#/4+e/4') return 'ноты ' + keys;
        return true;
    });

    check('учебник: малый мажорный септаккорд в ре мажор — 4 звука', () => {
        T.setLabelLocale('ru');
        const res = T.buildNotationForQuery('построй малый мажорный септаккорд в ре мажор');
        if (!res?.blockString) return 'не построено';
        const blocks = extractBlocks(res.blockString);
        const n = blocks[0]?.notes?.[0];
        if (!n || n.keys.length !== 4) return 'звуков ' + (n?.keys?.length || 0);
        if (n.label !== 'М.маж7') return 'подпись ' + n.label;
        return n.keys.slice().sort().join('+') === 'a/4+c/4+d/4+f#/4' ? true : n.keys.join('+');
    });

    check('«септим» не путается с «терци»', () => {
        const spec = I.parseIntervalSpec('большую септиму');
        return spec && spec.degree === 7 && spec.semis === 11 ? true : 'получено ' + JSON.stringify(spec);
    });

    check('билет: б3 от ми + D7 от ре + хроматика от до', () => {
        T.setLabelLocale('ru');
        const q = 'Твои задачи: Большая терция (б.3) вверх от ноты Ми первой октавы. '
            + 'Малый мажорный септаккорд (Доминантсептаккорд / D7) в основном виде от ноты Ре первой октавы. '
            + 'Хроматическая гамма вверх от ноты До первой октавы до ноты До второй октавы.';
        const res = T.buildNotationForQuery(q);
        if (!res?.blockString) return 'не построено';
        const blocks = extractBlocks(res.blockString);
        if (blocks.length !== 3) return 'блоков ' + blocks.length + ', ожидалось 3';
        const b0 = blocks[0].notes[0];
        if (b0.keys.length !== 2) return 'интервал: ' + b0.keys.length + ' звуков';
        if (b0.label !== 'б3') return 'интервал: ' + b0.label;
        const b1 = blocks[1].notes[0];
        if (b1.keys.length !== 4) return 'аккорд: ' + b1.keys.length + ' звуков';
        if (b1.label !== 'D7') return 'аккорд: ' + b1.label;
        if (blocks[2].notes.length < 12) return 'хроматика: ' + blocks[2].notes.length + ' нот';
        return true;
    });

    check('учебник: три вида минора от ля', () => {
        T.setLabelLocale('ru');
        const res = T.buildNotationForQuery('Напишите три вида минора от ля');
        if (!res?.blockString) return 'не построено';
        return (res.blockString.match(/\[\[NOTATION:/g) || []).length >= 3 ? true : 'мало блоков';
    });

    check('обычный чат: теория подключается по теме, а не всегда', () => {
        if (T.getTheoryRules('привет, как дела')) return 'болтовня тянет за собой базу правил';
        const p = T.getTheoryRules('что такое синкопа');
        if (!p || !p.includes('ЯДРО ТЕОРИИ')) return 'на теоретический вопрос правил нет';
        if (!p.includes('РИТМ')) return 'нет темы про ритм';
        return true;
    });

    // =====================================================================
    // 11. Чистка блоков, пришедших от нейросети (защита от наслоений)
    // =====================================================================
    check('чистка блока: дубли звуков, немецкое H, тройные знаки, юникод-знаки', () => {
        const data = T.sanitizeNotationData({
            clef: 'treble', keySignature: 'C', notes: [
                { keys: ['c/4', 'c/4', 'e/4'], duration: 'w' },   // дубль = наслоение головок
                { keys: ['h/4'], duration: 'q' },                  // немецкое H = си
                { keys: ['f###/5'], duration: 'q' },               // тройной диез -> энгармония
                { keys: ['C\u266F4'], duration: 'q' },             // юникод-диез без слэша
                { keys: ['g/5', 'e/5'], duration: 'q' },           // порядок снизу вверх
                { keys: [], duration: 'q' }                        // мусор -> выбрасывается
            ]
        });
        if (!data) return 'блок вычищен полностью';
        const got = data.notes.map(n => n.keys.join('+')).join(' ');
        const want = 'c/4+e/4 b/4 g#/5 c#/4 e/5+g/5';
        return got === want || 'получено: ' + got;
    });

    check('чистка блока: полный мусор даёт null, а не битые ноты', () => {
        const res = T.sanitizeNotationData({ notes: [{ keys: ['x/9'], duration: 'q' }, { keys: ['???'], duration: 'q' }] });
        return res === null || 'мусор не отфильтрован';
    });

    check('чистка блока: паузы не выбрасываются', () => {
        const res = T.sanitizeNotationData({ notes: [{ keys: [], duration: 'qr' }, { keys: ['c/4'], duration: 'q' }] });
        if (!res) return 'блок потерян';
        return res.notes.length === 2 || 'нот ' + res.notes.length;
    });

    check('чистка блока: SATB-гармонизация сохраняет голоса', () => {
        const res = T.sanitizeNotationData({
            layout: 'satb',
            chords: [{ soprano: 'C♯5', alto: 'a/4', tenor: 'e4', bass: 'a/3', duration: 'q', label: 'T53' }]
        });
        if (!res || !res.chords || !res.chords.length) return 'аккорды потеряны';
        const c = res.chords[0];
        const got = [c.soprano, c.alto, c.tenor, c.bass].join(' ');
        return got === 'c#/5 a/4 e/4 a/3' || 'получено: ' + got;
    });

    check('все нотные блоки движка проходят чистку без изменений', () => {
        for (const k of PRESET_KEYS) {
            const res = T.buildNotationForQuery(enQuery(k, 'build all scales, tritones and D7 with resolution in %KEY%'));
            if (!res) continue;
            for (const block of extractBlocks(res.blockString)) {
                const before = JSON.stringify(block.notes);
                const after = T.sanitizeNotationData(JSON.parse(JSON.stringify(block)));
                if (!after) return k.id + ': блок движка вычищен в null';
                if (JSON.stringify(after.notes) !== before) return k.id + ': чистка изменила блок движка';
            }
        }
        return true;
    });

    // =====================================================================
    // Вывод
    // =====================================================================
    window.__solfSelfTest = { passCount, failCount, results, routingMisses };

    const root = document.getElementById('results');
    const summary = document.getElementById('summary');
    if (summary) {
        summary.textContent = passCount + ' passed, ' + failCount + ' failed';
        summary.className = failCount ? 'summary fail' : 'summary pass';
    }
    if (root) {
        root.innerHTML = results.map(r =>
            '<div class="row ' + (r.ok ? 'ok' : 'bad') + '">' +
            '<span class="mark">' + (r.ok ? 'PASS' : 'FAIL') + '</span>' +
            '<span class="name">' + r.name + '</span>' +
            (r.detail ? '<span class="detail">' + r.detail + '</span>' : '') +
            '</div>'
        ).join('');
        if (routingMisses.length) {
            root.innerHTML += '<div class="row info"><span class="mark">INFO</span><span class="name">' +
                'Запросы, которые движок не строит (их отдаёт модели): ' + routingMisses.length +
                '</span><span class="detail">' + routingMisses.slice(0, 12).join(' | ') + '</span></div>';
        }
    }
    console.log('[selftest]', passCount + ' passed, ' + failCount + ' failed');
    results.filter(r => !r.ok).forEach(r => console.error('[selftest FAIL]', r.name, '—', r.detail));
})();
