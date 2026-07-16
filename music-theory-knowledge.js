// ===== SOLF.AI — СБОРНИК ПРАВИЛ МУЗЫКАЛЬНОЙ ТЕОРИИ =====
// Структурированная база знаний для точной генерации ответов ИИ.
// Не заменяет theory.js (детерминированный движок), а ДОПОЛНЯЕТ промпт
// релевантными правилами по типу запроса — без перегрузки каждого сообщения.
//
// Экспорт: window.SolfKnowledge.getRulesForQuery(query, lang) -> string | null

(function () {
    'use strict';

    // ---------- Системы обозначений ----------
    const NOTATION_SYSTEMS = `
NOTATION SYSTEMS (match user's language — never mix):
• Russian/European solfège: до ре ми фа соль ля си; functional labels Т53, С6, D7, D6/5, D4/3, D2; intervals ув4, ум5, б3, м6.
• American/English: C D E F G A B; Roman numerals I–VII; chord qualities M/m/d/A; figured bass V7, V6/5, V4/3, V2; interval names P5, M3, A4, d5.
• German: c-dur, g-moll, fis, es, h (= B natural), b (= Bb).
• SAME chord, different names: Russian "D7" (dominant seventh) = American "V7" in key context; Russian "доминантсептаккорд" = "dominant seventh chord".
• Figured bass mapping: D7↔V7, D6/5↔V6/5, D4/3↔V4/3, D2↔V2, T53↔I, T6↔I6, T6/4↔I6/4.
• English user → NEVER use до/ре/ми or Cyrillic labels. Russian user → use Russian note names and Cyrillic interval labels.`;

    // ---------- Интервалы (справочник) ----------
    const INTERVALS = `
INTERVAL CONSTRUCTION (letter + semitones — NEVER swap enharmonic letters inside one interval):
Degree × quality semitones:
  1: P=0 A=1 | 2: d=0 m=1 M=2 A=3 | 3: d=2 m=3 M=4 A=5 | 4: d=4 P=5 A=6
  5: d=6 P=7 A=8 | 6: d=7 m=8 M=9 A=10 | 7: d=9 m=10 M=11 A=12 | 8: d=11 P=12 A=13
Algorithm: (1) count letter steps → upper letter skeleton; (2) alter upper note to match semitones; (3) never change the letter.`;

    // ---------- Удвоения в аккордах (ключевой запрос пользователя) ----------
    const CHORD_DOUBLING = `
CHORD DOUBLING RULES (4-part SATB / 3-part / close position):

GENERAL:
• Prefer chord tones over non-chord tones. Avoid doubling tendency tones (leading tone, chord 7th, altered scale degrees).
• In strict harmony: double the most stable tone — usually root or fifth. In tonic triads: double root or fifth; avoid doubling leading tone (scale degree 7 in major, 2 in minor approaching tonic).
• Never double the leading tone (VII in major, II in natural minor as approach to I) unless in special cases (passing, etc.).

TRIADS (3-part, one note omitted):
• Root position: omit 5th, double root OR omit 3rd, double root (most common for T).
• First inversion (6): double bass (3rd) OR double soprano; omit 5th common.
• Second inversion (6/4): double bass (5th); never double 3rd in bass position.

DOMINANT SEVENTH D7 / V7 (4 voices — complete chord preferred):
• BEST: root + 3rd + 5th + 7th — each once, NO doubling (standard SATB D7).
• If only 3 voices: omit 5th, keep root + 3rd + 7th; OR omit 3rd, double root + 5th + 7th (less common).
• NEVER double the 7th (chord seventh — must resolve down by step).
• NEVER double the leading tone (3rd of V7 = leading tone in major key).
• If doubling needed in 4-part: double ROOT or FIFTH only; avoid doubling 3rd.
• Example C major D7 (G-B-D-F): voices g/4 b/4 d/5 f/5 — one of each; resolution g→c, b→c, f→e, d stays or resolves per context.

D7 DOUBLING BY INVERSION:
• D7 (root): double root or 5th if 4-part with repeated tone; complete spacing preferred.
• D6/5 (3rd in bass): do not double 7th; 3rd in bass may be doubled carefully; leading tone in inner voice.
• D4/3 (5th in bass): often double 5th (bass); 7th resolves down, 3rd up (tritone resolution).
• D2 (7th in bass): 7th in bass MUST NOT be doubled; resolves down; avoid parallel 5ths/octaves with resolution.

SEVENTH CHORDS (general):
• Major 7th (M7): avoid doubling 7th; double root or 3rd.
• Minor 7th (m7): double root or 5th.
• Diminished 7th (d7): often fully stacked; doubling rare; each tone once in 4-part.

CHECK before output: count letter names in chord — if any pitch class appears twice, verify doubling rules allow it.`;

    // ---------- Голосоведение и разрешения ----------
    const VOICE_LEADING = `
VOICE LEADING (strict tonal harmony):

PARALLEL FIFTHS/OCTAVES: forbidden between outer voices in academic harmony (Russian school); avoid in inner voices too in strict exercises.

D7 → T RESOLUTION (mandatory tendencies):
• 7th of D7 (chord 7th): ALWAYS resolves DOWN by step (m2).
• 3rd of D7 (leading tone): resolves UP by step to tonic (m2) in major; in minor often raised leading tone → tonic.
• Tritone (3rd–7th of D7): contracts inward — 7th down, 3rd up (to tonic and 3rd of T).
• Root of D7: may hold or leap to tonic; in strict 4-part often stays or goes to tonic.
• 5th of D7: may hold or resolve to 3rd or 5th of T; least restrictive.

D7 INVERSION → T TARGET:
• D7 → T53 (root position tonic)
• D6/5 → T6 (first inversion tonic)
• D4/3 → T6/4 (second inversion tonic)
• D2 → T6 (first inversion tonic)

TRITONE RESOLUTION (ув.4 / ум.5):
• Augmented 4th (A4/ув.4): expands OUTWARD → m6 or M6 (NEVER to P4 or P5).
• Diminished 5th (d5/ум.5): contracts INWARD → m3 or M3 (NEVER to P4 or P5).
• Each tritone tone moves by STEP to nearest chord tone I, III, or V.

CHARACTERISTIC INTERVALS (harmonic major/minor): aug2→P4, dim7→P5, aug5→m6, dim4→m3 — altered degree (VII# or bVI) moves by semitone to resolution.`;

    // ---------- Функции и ступени ----------
    const HARMONY_FUNCTIONS = `
FUNCTIONAL HARMONY (tonal):

DEGREES in major: I T, II SII, III T(III), IV S, V D, VI T(VI), VII vii° leading.
DEGREES in minor (natural): i T, ii° SII, III T(III), iv S, v d (or V in harmonic), VI T(VI), VII s.
Harmonic minor: V and V7 become major (raised leading tone); VII becomes VII#.

MAIN TRIADS: T (I), S (IV), D (V) — build from scale degrees 1-3-5, 4-6-1, 5-7-2.
In minor: t (i), s (iv), d (v) or D (V) in harmonic/melodic context.

SEVENTH CHORDS by function:
• D7 = V7 = dominant seventh (root on V): 1–M3–P5–m7 from dominant.
• S7 = IV7 or ii7 depending on context.
• T7 = I7 rare in classical; used in jazz/pop.

INVERSION LABELS (always Latin D for dominant seventh in Russian system):
• 5/3 or 53 = root position | 6 = first inversion | 6/4 = second inversion
• Seventh: 7, 6/5, 4/3, 2 (or 65, 43, 2 without slashes in some texts)`;

    // ---------- Гаммы ----------
    const SCALES = `
SCALE FORMULAS (one letter name per degree):
• Natural major: W-W-H-W-W-W-H
• Natural minor: W-H-W-W-H-W-W
• Harmonic minor: W-H-W-W-H-A2-H (VII raised)
• Melodic minor up: W-H-W-W-W-W-H; down = natural minor
• Harmonic major: W-W-H-W-H-A2-H (VI lowered)
• Modes from white keys: Ionian=C, Dorian=D, Phrygian=E, Lydian=F, Mixolydian=G, Aeolian=A, Locrian=B
Output scales with barlines:"none", no time signature.`;

    // ---------- Тритоны и характерные ----------
    const TRITONES = `
TRITONE PAIRS (6 semitones, different spellings):
• Natural major/minor: ONE pair (aug4 + dim5) = 4 intervals with resolutions.
• Harmonic minor (VII#): TWO pairs = 8 intervals.
• Harmonic major (bVI): TWO pairs = 8 intervals.
Default request "tritones in X minor" without "natural" → HARMONIC form (2 pairs).
Use barlines:"manual" + barAfter after each resolution pair.`;

    const CHARACTERISTIC = `
CHARACTERISTIC INTERVALS (ONLY from harmonic form — exactly FOUR types):
aug2, dim7, aug5, dim4 — NOT the same as tritones (aug4/dim5).
Harmonic minor: from VII# — all four with resolutions.
Harmonic major: from bVI — all four with resolutions.
Always output ALL 4 pairs (8 sonorities total) when requested.`;

    // ---------- Кадансы ----------
    const CADENCES = `
CADENCES:
• Authentic (PAC): D→T or D7→T, both in root position, tonic in soprano.
• Half: ends on D.
• Plagal: S→T ("Amen").
• Deceptive: D→VI instead of T.
Standard progression: T–S–D–T or T–SII–D7–T.`;

    // ---------- Матчер запросов ----------
    const TOPIC_PATTERNS = [
        { id: 'doubling', re: /удвоен|doubl|satb|4[\s-]?голос|four[\s-]?part|3[\s-]?голос|three[\s-]?part|расстановк|voicing|spacing/i, rules: CHORD_DOUBLING },
        { id: 'd7', re: /\bd7\b|dominant\s*seventh|dominant\s*7|доминант\w*\s*септ|септаккорд|v7\b|65|6\/5|4\/3|\bd2\b/i, rules: CHORD_DOUBLING + '\n' + VOICE_LEADING + '\n' + HARMONY_FUNCTIONS },
        { id: 'voice', re: /голосовед|voice\s*lead|параллельн|parallel\s*(5|fifth|octave)|разрешен|resolution|cadenc|каданс|tritone\s*resolv/i, rules: VOICE_LEADING + '\n' + CADENCES },
        { id: 'tritone', re: /тритон|tritone|ув\.?\s*4|ум\.?\s*5|aug\s*4|dim\s*5|a4|d5/i, rules: TRITONES + '\n' + VOICE_LEADING },
        { id: 'characteristic', re: /характерн|characteristic|ув\.?\s*2|ум\.?\s*7|ув\.?\s*5|ум\.?\s*4|aug\s*2|dim\s*7/i, rules: CHARACTERISTIC + '\n' + VOICE_LEADING },
        { id: 'triad', re: /трезвуч|triad|обращен|inversion|т53|t53|6\/4|64\b|53\b/i, rules: CHORD_DOUBLING + '\n' + HARMONY_FUNCTIONS },
        { id: 'scale', re: /гамм|scale|звукоряд|лад|mode|тональност|key\s*sign/i, rules: SCALES },
        { id: 'interval', re: /интервал|interval|секунд|terce|third|кварт|fourth|квинт|fifth|септим|seventh|октав|octave/i, rules: INTERVALS },
        { id: 'harmony', re: /гармон|harmon|функц|function|ступен|degree|тоник|subdomin|dominant|субдомин|прогресс/i, rules: HARMONY_FUNCTIONS + '\n' + VOICE_LEADING },
        { id: 'notation', re: /американ|american|english|русск|russian|german|немец|figured|обознач|notation|label|подпис/i, rules: NOTATION_SYSTEMS },
        { id: 'cadence', re: /каданс|cadence|authentic|plagal|deceptive|полукаденс/i, rules: CADENCES + '\n' + VOICE_LEADING }
    ];

    /** Возвращает компактный блок правил для данного запроса (или null). */
    function getRulesForQuery(rawQuery, lang) {
        if (!rawQuery || typeof rawQuery !== 'string') return null;
        const t = rawQuery.toLowerCase().replace(/ё/g, 'е');
        const matched = [];
        const seen = new Set();

        for (const topic of TOPIC_PATTERNS) {
            if (topic.re.test(t) && !seen.has(topic.id)) {
                seen.add(topic.id);
                matched.push(topic);
            }
        }

        // Для любого запроса на построение — базовые системы обозначений по языку
        const isBuild = /построй|build|construct|write|show|draw|состав|напиш|сделай|create|harmoniz|гармониз/i.test(t);
        if (isBuild && !seen.has('notation')) {
            matched.unshift({ id: 'notation', rules: NOTATION_SYSTEMS });
        }

        if (!matched.length) return null;

        const langNote = lang === 'ru'
            ? '\nApply rules using Russian terminology in the answer.'
            : lang === 'de'
                ? '\nApply rules using German terminology in the answer.'
                : '\nApply rules using English/American terminology in the answer.';

        const header = `
############################################
###  INJECTED THEORY RULES (follow exactly) ###
############################################
These rules supplement the main notation prompt. Compute notes by rules — do not guess.`;

        const body = matched.map(m => m.rules).join('\n\n---\n\n');
        return `${header}\n${NOTATION_SYSTEMS}\n${langNote}\n\n${body}`;
    }

    /** Полный справочник (для отладки / будущего RAG). */
    function getAllRules() {
        return [NOTATION_SYSTEMS, INTERVALS, CHORD_DOUBLING, VOICE_LEADING,
            HARMONY_FUNCTIONS, SCALES, TRITONES, CHARACTERISTIC, CADENCES].join('\n\n---\n\n');
    }

    window.SolfKnowledge = {
        getRulesForQuery,
        getAllRules,
        NOTATION_SYSTEMS,
        CHORD_DOUBLING,
        VOICE_LEADING,
        HARMONY_FUNCTIONS
    };
})();
