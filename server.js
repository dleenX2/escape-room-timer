const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const session = require('cookie-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(session({
    name: 'session',
    keys: ['escape-room-secret-key-123!'],
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const publicDir = fs.existsSync(path.join(__dirname, 'public')) 
    ? path.join(__dirname, 'public') 
    : __dirname;
app.use(express.static(publicDir));

const DATA_FILE = path.join(__dirname, 'data.json');
let appData = {
    timerState: {
        remainingSeconds: 2400, // default 40 mins
        isRunning: false,
        lastUpdateTime: null
    },
    hints: [],
    stats: {
        hintRequests: 0,
        answerViews: 0,
        viewedHints: [],
        viewedAnswers: []
    }
};

if (fs.existsSync(DATA_FILE)) {
    try {
        const rawData = fs.readFileSync(DATA_FILE);
        const parsed = JSON.parse(rawData);
        if (parsed.timerState) {
            appData.timerState = parsed.timerState;
        }
        if (Array.isArray(parsed.hints)) appData.hints = parsed.hints;
        if (parsed.stats) {
            appData.stats = parsed.stats;
            if (!appData.stats.viewedHints) appData.stats.viewedHints = [];
            if (!appData.stats.viewedAnswers) appData.stats.viewedAnswers = [];
        } else {
            appData.stats = { hintRequests: 0, answerViews: 0, viewedHints: [], viewedAnswers: [] };
        }
    } catch(e) {
        console.error("Error reading data file. Initializing defaults.", e);
    }
}

function saveData() {
    try {
        const tempFile = DATA_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(appData, null, 2));
        fs.renameSync(tempFile, DATA_FILE); // Atomic write prevents data corruption
    } catch (e) {
        console.error("Failed to save data:", e);
    }
}

function requireAdminAPI(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// Player APIs
app.get('/api/timer', (req, res) => {
    res.json(appData.timerState);
});

app.post('/api/hint', (req, res) => {
    const { qNumber } = req.body;
    if (qNumber === undefined || qNumber === null) {
        return res.json({ success: false, message: '문제 번호를 입력하세요.' });
    }
    const cleanQ = String(qNumber).trim();
    if (cleanQ === '' || cleanQ === 'undefined' || cleanQ === 'null') {
        return res.json({ success: false, message: '올바른 문제 번호가 아닙니다.' });
    }
    const item = appData.hints.find(h => h.qNumber === cleanQ);
    if (item) {
        if (!appData.stats.viewedHints.includes(cleanQ)) {
            appData.stats.viewedHints.push(cleanQ);
            appData.stats.hintRequests = appData.stats.viewedHints.length;
            saveData();
            io.emit('stats_update', appData.stats);
        }
        res.json({ success: true, hint: item.hint, answer: item.answer });
    } else {
        res.json({ success: false, message: '해당 문제 번호에 대한 정보를 찾을 수 없습니다.' });
    }
});

app.get('/api/stats', (req, res) => {
    res.json(appData.stats);
});

app.post('/api/stats/answer', (req, res) => {
    const { qNumber } = req.body;
    if (qNumber === undefined || qNumber === null) {
        return res.status(400).json({ error: 'qNumber is required' });
    }
    const cleanQ = String(qNumber).trim();
    if (cleanQ === '' || cleanQ === 'undefined' || cleanQ === 'null') {
        return res.status(400).json({ error: 'Invalid qNumber' });
    }
    if (!appData.stats.viewedAnswers.includes(cleanQ)) {
        appData.stats.viewedAnswers.push(cleanQ);
        appData.stats.answerViews = appData.stats.viewedAnswers.length;
        saveData();
        io.emit('stats_update', appData.stats);
    }
    res.json({ success: true, stats: appData.stats });
});

// Admin Auth APIs
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === 'admin1234') { 
        req.session.isAdmin = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session = null;
    res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
    res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// Admin Data APIs
app.get('/api/admin/hints', requireAdminAPI, (req, res) => {
    res.json(appData.hints);
});

app.post('/api/admin/hints', requireAdminAPI, (req, res) => {
    if (Array.isArray(req.body.hints)) {
        appData.hints = req.body.hints;
        saveData();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, message: 'Invalid hints format.' });
    }
});

app.post('/api/admin/stats/reset', requireAdminAPI, (req, res) => {
    appData.stats = { hintRequests: 0, answerViews: 0, viewedHints: [], viewedAnswers: [] };
    saveData();
    io.emit('stats_update', appData.stats);
    res.json({ success: true, stats: appData.stats });
});

app.post('/api/admin/timer', requireAdminAPI, (req, res) => {
    const { action, seconds } = req.body;
    const state = appData.timerState;

    if (state.isRunning) {
        const now = Date.now();
        const elapsed = Math.floor((now - state.lastUpdateTime) / 1000);
        state.remainingSeconds = Math.max(0, state.remainingSeconds - elapsed);
        state.lastUpdateTime = now; 
    }

    if (action === 'start') {
        if (!state.isRunning) {
            state.isRunning = true;
            state.lastUpdateTime = Date.now();
        }
    } else if (action === 'pause') {
        state.isRunning = false;
        state.lastUpdateTime = null;
    } else if (action === 'set') {
        state.remainingSeconds = parseInt(seconds, 10);
        state.isRunning = false;
        state.lastUpdateTime = null;
    } else if (action === 'add') {
        state.remainingSeconds += parseInt(seconds, 10);
    } else if (action === 'subtract') {
        state.remainingSeconds = Math.max(0, state.remainingSeconds - parseInt(seconds, 10));
    }

    saveData();
    io.emit('timer_update', state);
    res.json({ success: true, timerState: state });
});

app.post('/api/admin/audio', requireAdminAPI, (req, res) => {
    const { action, filename, loop } = req.body;
    io.emit('audio_control', { action, filename, loop });
    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.emit('timer_update', appData.timerState);
    socket.emit('stats_update', appData.stats);
});

app.get('/admin', (req, res) => {
    res.sendFile('admin.html', { root: publicDir });
});

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.error('Bad JSON parsing:', err.message);
        return res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
    }
    next();
});

app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).send('Not found');
    res.sendFile('index.html', { root: publicDir });
});

const PORT = process.env.PORT || 3000;
const os = require('os');
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    const networkInterfaces = os.networkInterfaces();
    console.log('\n다른 기기(휴대폰 등)에서 접속할 수 있는 주소:');
    for (const devName in networkInterfaces) {
        const iface = networkInterfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && !alias.internal) {
                console.log(`- http://${alias.address}:${PORT}`);
            }
        }
    }
});
