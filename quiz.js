// ===== SOLF.AI QUIZ (SYNCED & LIMITED) =====

// Лимиты для викторин согласно тарифам
const QUIZ_LIMITS = {
    free:      3,
    basic:     10,
    pro:       Infinity,
    unlimited: Infinity
};

const QUIZ_USAGE_WINDOW_MS = 12 * 60 * 60 * 1000;

const QUESTIONS_PER_QUIZ = 10;

let audioContext = null;
let quizMode = null;
let currentAnswer = null;
let quizScore = 0;
let quizTotal = 0;
let currentBaseNote = 0;

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const intervals = [
    { name: 'Minor 2nd', nameRu: 'Малая секунда', semitones: 1 },
    { name: 'Major 2nd', nameRu: 'Большая секунда', semitones: 2 },
    { name: 'Minor 3rd', nameRu: 'Малая терция', semitones: 3 },
    { name: 'Major 3rd', nameRu: 'Большая терция', semitones: 4 },
    { name: 'Perfect 4th', nameRu: 'Чистая кварта', semitones: 5 },
    { name: 'Tritone',   nameRu: 'Тритон',        semitones: 6 },
    { name: 'Perfect 5th', nameRu: 'Чистая квинта', semitones: 7 },
    { name: 'Minor 6th', nameRu: 'Малая секста',  semitones: 8 },
    { name: 'Major 6th', nameRu: 'Большая секста', semitones: 9 },
    { name: 'Minor 7th', nameRu: 'Малая септима', semitones: 10 },
    { name: 'Major 7th', nameRu: 'Большая септима', semitones: 11 },
    { name: 'Octave',    nameRu: 'Октава',        semitones: 12 }
];

const chords = [
    { name: 'Major',     nameRu: 'Мажор',     semitones: [0, 4, 7] },
    { name: 'Minor',     nameRu: 'Минор',     semitones: [0, 3, 7] },
    { name: 'Diminished', nameRu: 'Уменьшенный', semitones: [0, 3, 6] },
    { name: 'Augmented', nameRu: 'Увеличенный', semitones: [0, 4, 8] }
];

// ==========================================
// 1. ЛОГИКА ЛИМИТОВ (СИНХРОНИЗАЦИЯ)
// ==========================================

function getQuizUsageKey() {
    const userId = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : 'guest';
    return `solfai_quiz_usage_${userId}`;
}

function isQuizUserLoggedIn() {
    return typeof currentUser !== 'undefined' && Boolean(currentUser?.id);
}

function getQuizUsage() {
    if (isQuizUserLoggedIn()) {
        return {
            timestamp: Number(currentUser?.quiz_window_start) || Date.now(),
            count: Number(currentUser?.quiz_count) || 0,
        };
    }
    const key = getQuizUsageKey();
    const data = JSON.parse(localStorage.getItem(key) || '{}');
    const now = Date.now();
    if (!data.timestamp || (now - data.timestamp) > QUIZ_USAGE_WINDOW_MS) {
        return { timestamp: now, count: 0 };
    }
    return data;
}

function saveQuizUsage(data) {
    localStorage.setItem(getQuizUsageKey(), JSON.stringify(data));
}

function getRemainingQuizzes() {
    const planType = (typeof currentPlan !== 'undefined' && currentPlan) ? currentPlan.type : 'free';
    const limit = QUIZ_LIMITS[planType] !== undefined ? QUIZ_LIMITS[planType] : 3;

    if (limit === Infinity) return 999;

    if (isQuizUserLoggedIn()) {
        const dbUsage = Number(currentUser?.quiz_count);
        return Math.max(0, limit - (Number.isFinite(dbUsage) ? dbUsage : 0));
    }

    const usage = getQuizUsage();
    return Math.max(0, limit - usage.count);
}

function useQuiz() {
    const planType = (typeof currentPlan !== 'undefined' && currentPlan) ? currentPlan.type : 'free';
    const limit = QUIZ_LIMITS[planType] !== undefined ? QUIZ_LIMITS[planType] : 3;

    if (limit === Infinity) return true;

    if (isQuizUserLoggedIn()) {
        const cur = Number(currentUser.quiz_count) || 0;
        if (cur >= limit) return false;
        currentUser.quiz_count = cur + 1;
        updateQuizCounter();
        const workerUrl = typeof WORKER_URL !== 'undefined' ? WORKER_URL : 'https://solf-ai-api.mlemonw.workers.dev';
        fetch(`${workerUrl}/increment-usage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentUser.id, type: 'quiz' }),
        })
            .then(r => r.json())
            .then(data => {
                if (data && Number.isFinite(Number(data.quiz_count))) {
                    currentUser.quiz_count = Number(data.quiz_count);
                    if (Number.isFinite(Number(data.quiz_window_start))) {
                        currentUser.quiz_window_start = Number(data.quiz_window_start);
                    }
                    localStorage.setItem('solfai_user', JSON.stringify(currentUser));
                    updateQuizCounter();
                }
            })
            .catch(err => console.warn('[Quiz] usage sync failed:', err));
        return true;
    }

    const usage = getQuizUsage();
    if (usage.count < limit) {
        usage.count++;
        if (!usage.timestamp) usage.timestamp = Date.now();
        saveQuizUsage(usage);
        updateQuizCounter();
        return true;
    }
    return false;
}

function updateQuizCounter() {
    const remaining = getRemainingQuizzes();
    const planType = (typeof currentPlan !== 'undefined' && currentPlan) ? currentPlan.type : 'free';
    const limit = QUIZ_LIMITS[planType];
    
    const displayValue = (limit === Infinity) ? '∞' : remaining;

    const counterEl = document.getElementById('quizLimitCount') || document.getElementById('quizCountDisplay');
    if (counterEl) {
        counterEl.textContent = displayValue;
        if (remaining === 0 && limit !== Infinity) {
            counterEl.style.color = '#ef4444'; 
        } else {
            counterEl.style.color = 'var(--purple-soft)';
        }
    }
}

// ==========================================
// 2. ИНИЦИАЛИЗАЦИЯ И УПРАВЛЕНИЕ
// ==========================================

function initQuiz() {
    const modal = document.getElementById('quizModal');
    
    document.getElementById('openQuizBtn')?.addEventListener('click', () => {
        if (typeof closeSidebarWhenOpeningTool === 'function') closeSidebarWhenOpeningTool();
        updateQuizCounter();
        modal.classList.add('active');
        showQuizModes();
    });

    // Модалка предупреждения о выходе
    document.getElementById('quizCloseBtn')?.addEventListener('click', () => {
        const isGameActive = document.getElementById('quizGame').style.display === 'block';
        if (isGameActive) {
            document.getElementById('quizExitModal')?.classList.add('active');
        } else {
            forceCloseQuiz();
        }
    });

    document.getElementById('quizContinueBtn')?.addEventListener('click', () => {
        document.getElementById('quizExitModal')?.classList.remove('active');
    });

    document.getElementById('quizExitConfirmBtn')?.addEventListener('click', () => {
        document.getElementById('quizExitModal')?.classList.remove('active');
        forceCloseQuiz();
    });
    
    document.querySelectorAll('.quiz-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => startQuiz(btn.dataset.mode));
    });

    document.getElementById('playSoundBtn')?.addEventListener('click', playCurrentQuestion);
    
    document.getElementById('quizAgainBtn')?.addEventListener('click', () => {
        startQuiz(quizMode);
    });

    setTimeout(updateQuizCounter, 1000); 
}

function showQuizModes() {
    document.getElementById('quizModes').style.display = 'grid';
    document.getElementById('quizGame').style.display = 'none';
    document.getElementById('quizResult').style.display = 'none';
    quizMode = null;
}

function forceCloseQuiz() {
    stopAllSounds();
    document.getElementById('quizModal').classList.remove('active');
    setTimeout(showQuizModes, 300);
}

// ==========================================
// 3. ИГРОВОЙ ПРОЦЕСС
// ==========================================

function startQuiz(mode) {
    if (getRemainingQuizzes() <= 0) {
        if (typeof showLimitModal === 'function') {
            document.getElementById('quizModal').classList.remove('active');
            showLimitModal();
        } else {
            alert('Daily quiz limit reached. Please upgrade your plan or wait for the reset.');
        }
        return;
    }

    if (!useQuiz()) return;

    quizMode = mode;
    quizScore = 0;
    quizTotal = 0;
    
    document.getElementById('quizModes').style.display = 'none';
    document.getElementById('quizResult').style.display = 'none';
    document.getElementById('quizGame').style.display = 'block';
    
    document.getElementById('scoreValue').textContent = '0';
    
    const totalEl = document.getElementById('totalQuestions') || document.getElementById('totalValue');
    if(totalEl) totalEl.textContent = QUESTIONS_PER_QUIZ;
    
    nextQuestion();
}

function nextQuestion() {
    if (quizTotal >= QUESTIONS_PER_QUIZ) {
        finishQuiz();
        return;
    }
    
    quizTotal++;
    
    document.getElementById('quizOptions').innerHTML = '';
    document.getElementById('quizFeedback').className = 'quiz-feedback';
    document.getElementById('quizFeedback').textContent = '';
    
    generateQuestion();
}

function generateQuestion() {
    if (quizMode === 'interval' || quizMode === 'intervals') {
        generateIntervalQuestion();
    } else if (quizMode === 'chord') {
        generateChordQuestion();
    } else if (quizMode === 'note' || quizMode === 'perfect_pitch') {
        generatePitchQuestion();
    } else {
        generateIntervalQuestion(); 
    }
}

function generateIntervalQuestion() {
    const interval = intervals[Math.floor(Math.random() * intervals.length)];
    const baseNoteIdx = Math.floor(Math.random() * 24) + 48; // C3 to C5
    currentBaseNote = baseNoteIdx;
    currentAnswer = interval;
    
    let options = [interval];
    while (options.length < 4) {
        const randomInt = intervals[Math.floor(Math.random() * intervals.length)];
        if (!options.includes(randomInt)) options.push(randomInt);
    }
    options.sort(() => Math.random() - 0.5);
    
    renderOptions(options, (opt) => {
        const currentLang = localStorage.getItem('solfai_lang') || 'en';
        return currentLang === 'ru' ? opt.nameRu : opt.name;
    });
    
    setTimeout(playCurrentQuestion, 500);
}

function generateChordQuestion() {
    const chord = chords[Math.floor(Math.random() * chords.length)];
    const baseNoteIdx = Math.floor(Math.random() * 24) + 48; // C3 to C5
    currentBaseNote = baseNoteIdx;
    currentAnswer = chord;

    let options = [chord];
    while (options.length < 4) {
        const randomChord = chords[Math.floor(Math.random() * chords.length)];
        if (!options.includes(randomChord)) options.push(randomChord);
    }
    options.sort(() => Math.random() - 0.5);

    renderOptions(options, (opt) => {
        const currentLang = localStorage.getItem('solfai_lang') || 'en';
        return currentLang === 'ru' ? opt.nameRu : opt.name;
    });

    setTimeout(playCurrentQuestion, 500);
}

function generatePitchQuestion() {
    const noteIdx = Math.floor(Math.random() * 24) + 48; 
    currentBaseNote = noteIdx;
    const noteName = noteNames[noteIdx % 12];
    currentAnswer = noteName;
    
    let options = [noteName];
    while (options.length < 4) {
        const randomNote = noteNames[Math.floor(Math.random() * noteNames.length)];
        if (!options.includes(randomNote)) options.push(randomNote);
    }
    options.sort(() => Math.random() - 0.5); 
    
    renderOptions(options, (opt) => opt); 
    
    setTimeout(playCurrentQuestion, 500);
}

function renderOptions(options, labelFn) {
    const container = document.getElementById('quizOptions');
    container.innerHTML = '';
    
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'quiz-option';
        btn.textContent = labelFn(opt);
        btn.onclick = () => checkAnswer(opt, btn);
        container.appendChild(btn);
    });
}

function checkAnswer(selected, btn) {
    const allBtns = document.querySelectorAll('.quiz-option');
    allBtns.forEach(b => b.disabled = true);
    
    const isCorrect = selected === currentAnswer;
    
    if (isCorrect) {
        btn.classList.add('correct');
        quizScore++;
        document.getElementById('scoreValue').textContent = quizScore;
        showFeedback(true);
    } else {
        btn.classList.add('wrong');
        allBtns.forEach(b => {
            let btnVal = b.textContent; 
            if (quizMode === 'interval' || quizMode === 'intervals' || quizMode === 'chord') {
                const currentLang = localStorage.getItem('solfai_lang') || 'en';
                const correctName = currentLang === 'ru' ? currentAnswer.nameRu : currentAnswer.name;
                if (btnVal === correctName) b.classList.add('correct');
            } else {
                if (btnVal === currentAnswer) b.classList.add('correct');
            }
        });
        showFeedback(false);
    }
    
    setTimeout(nextQuestion, 1500);
}

function showFeedback(isCorrect) {
    const fb = document.getElementById('quizFeedback');
    const ok = typeof solfaiGetText === 'function';
    if (isCorrect) {
        fb.textContent = ok ? solfaiGetText('quizCorrect') : 'Correct!';
        fb.className = 'quiz-feedback correct';
    } else {
        fb.textContent = ok ? solfaiGetText('quizWrong') : 'Oops...';
        fb.className = 'quiz-feedback wrong';
    }
}

function finishQuiz() {
    document.getElementById('quizGame').style.display = 'none';
    
    const resultContainer = document.getElementById('quizResult');
    resultContainer.style.display = 'flex';
    resultContainer.style.flexDirection = 'column';
    resultContainer.style.alignItems = 'center';
    resultContainer.style.gap = '16px';
    
    const percentage = (quizScore / QUESTIONS_PER_QUIZ) * 100;
    const gt = typeof solfaiGetText === 'function' ? solfaiGetText : () => '';
    let msg = '';
    if (percentage === 100) {
        msg = gt('quizResultPerfect') || 'Perfect!';
    } else if (percentage >= 80) {
        msg = gt('quizResultGreat') || 'Great!';
    } else if (percentage >= 50) {
        msg = gt('quizResultGood') || 'Not bad!';
    } else {
        msg = gt('quizResultKeepPracticing') || 'Keep practicing!';
    }
    
    const resultTextEl = document.getElementById('resultText') || document.getElementById('resultMessage');
    if (resultTextEl) {
        resultTextEl.innerHTML = `
            <div style="font-size: 2.2rem; font-weight: 700; color: var(--purple-glow); margin-bottom: 8px;">
                ${quizScore} / ${QUESTIONS_PER_QUIZ}
            </div>
            <div style="font-size: 1.2rem; color: var(--text-primary);">
                ${msg}
            </div>
        `;
    }
}

// ==========================================
// 4. АУДИО ДВИЖОК
// ==========================================

function initAudio() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

function playCurrentQuestion() {
    initAudio();
    if (quizMode === 'interval' || quizMode === 'intervals') {
        playInterval(currentBaseNote, currentAnswer.semitones);
    } else if (quizMode === 'chord') {
        playChord(currentBaseNote, currentAnswer.semitones);
    } else if (quizMode === 'note' || quizMode === 'perfect_pitch') {
        playNote(currentBaseNote);
    } else {
        playInterval(currentBaseNote, currentAnswer.semitones || 4);
    }
}

function playNote(noteIdx, startTime = 0, duration = 0.8) {
    initAudio(); 
    
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    
    const freq = 440 * Math.pow(2, (noteIdx - 69) / 12);
    
    osc.type = 'triangle';
    osc.frequency.value = freq;
    
    osc.connect(gain);
    gain.connect(audioContext.destination);
    
    const now = audioContext.currentTime + startTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    
    osc.start(now);
    osc.stop(now + duration);
}

function playInterval(baseNote, semitones) {
    playNote(baseNote, 0, 1.0);
    playNote(baseNote + semitones, 0.6, 1.0); 
}

function playChord(baseNote, semitonesArray) {
    if (!Array.isArray(semitonesArray)) return;
    semitonesArray.forEach(semitone => {
        playNote(baseNote + semitone, 0, 1.0);
    });
}

function stopAllSounds() {
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
}
