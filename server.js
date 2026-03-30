require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const jwt = require('jsonwebtoken');
const path = require('path');
const { v4: uuidv4 } = (function() {
  try { return require('crypto'); } catch(e) { return {}; }
})() ? { v4: () => require('crypto').randomUUID() } : { v4: () => Math.random().toString(36).slice(2) };

const { AGENTS, AGENT_ORDER, callAgent } = require('./agents');
const { createSession, addMessage, getMessages, getSessions, deleteSession } = require('./db');
const { healthCheck, getClient } = require('./memory-bridge');
const multer = require('multer');
const { OpenClawBridge } = require('./openclaw-bridge');
const { DebateEngine } = require('./debate-engine');
const sharedMemory = require('./shared-memory');
const { analyzeFile, SUPPORTED_TYPES } = require('./file-analyzer');
const telegram = require('./telegram-sync');
const { syncConclusion } = require('./memory-sync');

// 파일 업로드 설정
const uploadDir = path.join(__dirname, 'data', 'uploads');
if (!require('fs').existsSync(uploadDir)) require('fs').mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// 업로드된 파일 요약 캐시 (debateId → [{ fileName, summary }])
const fileContextCache = new Map();

// OpenClaw 브릿지 & 토론 엔진 초기화
const bridge = new OpenClawBridge();
const debateEngine = new DebateEngine({ bridge, summaryMode: 'extract' });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || 'kdsys-secret-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kdsys2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware (헤더 또는 쿼리 파라미터)
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, username });
  }
  return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
});

// Sessions API
app.get('/api/sessions', authMiddleware, (req, res) => {
  const sessions = getSessions();
  res.json(sessions);
});

app.post('/api/sessions', authMiddleware, (req, res) => {
  const id = require('crypto').randomUUID();
  createSession(id);
  res.json({ id });
});

app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

app.get('/api/sessions/:id/messages', authMiddleware, (req, res) => {
  const msgs = getMessages(req.params.id);
  res.json(msgs);
});

// Agents info
app.get('/api/agents', (req, res) => {
  const agentInfo = Object.values(AGENTS).map(a => ({
    id: a.id, name: a.name, emoji: a.emoji, color: a.color
  }));
  res.json(agentInfo);
});

// Memory proxy: GET /api/memories → Memory API (mini 계정으로)
app.get('/api/memories', async (req, res) => {
  try {
    const client = getClient('mini');
    const { scope = 'shared', category, search, limit = 10, offset = 0 } = req.query;
    const memories = await client.read({ scope, category, search, limit: Number(limit), offset: Number(offset) });
    res.json({ data: memories });
  } catch (e) {
    res.status(500).json({ error: e.message, data: [] });
  }
});

// === 내보내기 API ===

// 토론 → HTML 내보내기 (토론방 UI 그대로)
app.get('/api/debates/:id/export', authMiddleware, (req, res) => {
  const debate = debateEngine.getDebate(req.params.id);
  if (!debate) return res.status(404).json({ error: '토론을 찾을 수 없습니다' });

  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const botMeta = { mini: { emoji: '🦞', color: '#ef4444' }, ezdoitbot: { emoji: '💡', color: '#4f8ef7' }, iriskdsys: { emoji: '🌸', color: '#f78ef7' } };

  let roundsHtml = '';
  for (const round of debate.rounds || []) {
    roundsHtml += `<div class="round-header">──── Round ${round.number} ────</div>`;
    for (const resp of round.responses || []) {
      if (!resp.content) continue;
      const meta = botMeta[resp.botId] || { emoji: '🤖', color: '#888' };
      roundsHtml += `
        <div class="msg">
          <div class="avatar" style="border-color:${meta.color}">${meta.emoji}</div>
          <div class="body">
            <div class="name" style="color:${meta.color}">${esc(resp.botName)}</div>
            <div class="content">${esc(resp.content)}</div>
          </div>
        </div>`;
    }
    if (round.evaluation?.note) {
      roundsHtml += `<div class="eval">📊 ${esc(round.evaluation.note)}</div>`;
    }
  }

  let conclusionHtml = '';
  if (debate.conclusion) {
    const c = debate.conclusion;
    const icon = c.isConsensus ? '🤝' : '📋';
    const title = c.isConsensus ? '합의된 결론' : '최종 결론';
    const border = c.isConsensus ? '#22c55e' : '#6366f1';
    conclusionHtml = `
      <div class="conclusion" style="border-color:${border}55">
        <h3>${icon} ${title}</h3>
        <div class="meta">${c.totalRounds}라운드 • ${esc(c.stopNote)}</div>
        <div class="conclusion-text">${esc(c.unifiedConclusion)}</div>
      </div>`;
  }

  const date = new Date(debate.startedAt).toLocaleString('ko-KR');
  const duration = debate.completedAt ? ((debate.completedAt - debate.startedAt) / 1000).toFixed(0) + '초' : '';

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>토론: ${esc(debate.topic)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f13; color: #e2e2f0; padding: 20px; max-width: 800px; margin: 0 auto; }
  .header { text-align: center; padding: 24px 0 16px; border-bottom: 1px solid #2e2e42; margin-bottom: 20px; }
  .header h1 { font-size: 1.2rem; margin-bottom: 8px; }
  .header .info { font-size: 0.82rem; color: #888899; }
  .round-header { text-align: center; padding: 12px 0; color: #888899; font-size: 0.82rem; font-weight: 600; border-bottom: 1px solid #2e2e42; margin: 16px 0 12px; }
  .msg { display: flex; gap: 12px; margin-bottom: 16px; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; background: #22222f; border: 2px solid #2e2e42; }
  .body { flex: 1; }
  .name { font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; }
  .content { background: #1a1a24; border: 1px solid #2e2e42; border-radius: 12px; padding: 12px 16px; font-size: 0.9rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
  .eval { text-align: center; padding: 8px 16px; font-size: 0.82rem; color: #6366f1; background: rgba(99,102,241,0.07); border: 1px solid rgba(99,102,241,0.2); border-radius: 8px; margin: 12px auto; max-width: 400px; }
  .conclusion { background: #1a1a24; border: 2px solid; border-radius: 12px; padding: 20px; margin: 24px 0; }
  .conclusion h3 { font-size: 1rem; margin-bottom: 8px; }
  .conclusion .meta { font-size: 0.82rem; color: #888899; margin-bottom: 12px; }
  .conclusion-text { font-size: 0.92rem; line-height: 1.7; white-space: pre-wrap; }
  .footer { text-align: center; padding: 20px 0; font-size: 0.75rem; color: #555; border-top: 1px solid #2e2e42; margin-top: 24px; }
  @media print { body { background: white; color: #222; } .content, .conclusion { background: #f8f8f8; border-color: #ddd; } .eval { background: #f0f0ff; } }
</style>
</head>
<body>
  <div class="header">
    <h1>⚔️ ${esc(debate.topic)}</h1>
    <div class="info">${date} | ${debate.rounds?.length || 0}라운드 ${duration ? '| ' + duration : ''} | KDSys MultiAgent Lab</div>
  </div>
  ${roundsHtml}
  ${conclusionHtml}
  <div class="footer">KDSys MultiAgent Lab — 자율 토론 기록</div>
</body>
</html>`;

  const filename = `토론-${debate.topic.slice(0, 30).replace(/[^\w가-힣\s-]/g, '')}.html`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(html);
});

// 채팅 세션 → HTML 내보내기
app.get('/api/sessions/:id/export', authMiddleware, (req, res) => {
  const msgs = getMessages(req.params.id, 500);
  if (!msgs || msgs.length === 0) return res.status(404).json({ error: '메시지가 없습니다' });

  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const agentColors = { ezdo: '#4f8ef7', juhee: '#f78ef7', mini: '#ef4444' };
  const agentEmojis = { ezdo: '💡', juhee: '🌸', mini: '🦞' };

  let msgsHtml = '';
  for (const msg of msgs) {
    const time = new Date(msg.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const name = msg.name || (msg.role === 'user' ? '승용씨' : '?');
    const isUser = msg.role === 'user';
    const color = agentColors[msg.agent_id] || '#888';
    const emoji = isUser ? '👤' : (agentEmojis[msg.agent_id] || '🤖');

    msgsHtml += `
      <div class="msg ${isUser ? 'user' : ''}">
        <div class="avatar" style="border-color:${isUser ? '#2563eb' : color}">${emoji}</div>
        <div class="body">
          <div class="meta"><span class="name" style="color:${isUser ? '#60a5fa' : color}">${esc(name)}</span> <span class="time">${time}</span></div>
          <div class="content ${isUser ? 'user-bg' : ''}">${esc(msg.content)}</div>
        </div>
      </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>대화 기록</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f13; color: #e2e2f0; padding: 20px; max-width: 800px; margin: 0 auto; }
  .header { text-align: center; padding: 24px 0 16px; border-bottom: 1px solid #2e2e42; margin-bottom: 20px; }
  .header h1 { font-size: 1.2rem; }
  .header .info { font-size: 0.82rem; color: #888899; margin-top: 6px; }
  .msg { display: flex; gap: 12px; margin-bottom: 16px; }
  .msg.user { flex-direction: row-reverse; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; background: #22222f; border: 2px solid #2e2e42; }
  .body { max-width: calc(100% - 50px); }
  .meta { margin-bottom: 6px; }
  .msg.user .meta { text-align: right; }
  .name { font-weight: 600; font-size: 0.9rem; }
  .time { font-size: 0.75rem; color: #888899; margin-left: 8px; }
  .content { background: #1a1a24; border: 1px solid #2e2e42; border-radius: 12px; padding: 12px 16px; font-size: 0.9rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .user-bg { background: #1e3a5f; border-color: #2563eb; }
  .footer { text-align: center; padding: 20px 0; font-size: 0.75rem; color: #555; border-top: 1px solid #2e2e42; margin-top: 24px; }
  @media print { body { background: white; color: #222; } .content { background: #f8f8f8; border-color: #ddd; } .user-bg { background: #e8f0fe; border-color: #90b0e0; } }
</style></head><body>
  <div class="header"><h1>💬 대화 기록</h1><div class="info">${msgs.length}개 메시지 | KDSys MultiAgent Lab</div></div>
  ${msgsHtml}
  <div class="footer">KDSys MultiAgent Lab — 대화 기록</div>
</body></html>`;

  const filename = `대화-${req.params.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.html`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(html);
});

// === 파일 업로드 API ===

// 한글 파일명 디코딩 (multer는 latin1로 저장)
function decodeFileName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // 디코딩 결과가 유효한 UTF-8인지 확인
    if (decoded && !decoded.includes('�')) return decoded;
  } catch (e) {}
  try { return decodeURIComponent(name); } catch (e) {}
  return name;
}

// 파일 업로드 + 분석 → 요약 반환
app.post('/api/files/analyze', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  req.file.originalname = req.body.fileName || decodeFileName(req.file.originalname);

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!SUPPORTED_TYPES[ext]) {
    require('fs').unlinkSync(req.file.path);
    return res.status(400).json({ error: `지원하지 않는 파일 형식: ${ext}` });
  }

  try {
    const result = await analyzeFile(req.file.path, req.file.originalname);
    // 임시 파일 삭제
    require('fs').unlinkSync(req.file.path);
    res.json(result);
  } catch (e) {
    try { require('fs').unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// 토론에 파일 컨텍스트 연결
app.post('/api/files/attach', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
  // 브라우저에서 보낸 fileName 필드 우선, 없으면 multer의 originalname 디코딩
  req.file.originalname = req.body.fileName || decodeFileName(req.file.originalname);

  try {
    const result = await analyzeFile(req.file.path, req.file.originalname);
    require('fs').unlinkSync(req.file.path);

    // 캐시에 저장 (토론 시작 시 사용)
    const attachId = require('crypto').randomUUID();
    fileContextCache.set(attachId, {
      fileName: result.fileName,
      summary: result.summary,
      fileType: result.fileType,
      originalSize: result.originalSize,
      analyzedAt: Date.now(),
    });

    res.json({ attachId, ...result });
  } catch (e) {
    try { require('fs').unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// === 토론 API ===

// 봇 연결 상태
app.get('/api/debate/status', authMiddleware, (req, res) => {
  res.json({ bots: bridge.getStatus() });
});

// 토론 시작
app.post('/api/debate/start', authMiddleware, async (req, res) => {
  const { topic, maxRounds = 15, attachIds = [] } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: '주제를 입력하세요' });

  // 첨부 파일 요약 수집
  let fileContext = '';
  if (attachIds.length > 0) {
    const fileSummaries = attachIds
      .map(id => fileContextCache.get(id))
      .filter(Boolean)
      .map(f => f.summary);
    if (fileSummaries.length > 0) {
      fileContext = '\n[첨부 파일 분석]\n' + fileSummaries.join('\n\n');
    }
    // 사용된 캐시 정리
    attachIds.forEach(id => fileContextCache.delete(id));
  }

  const debateId = require('crypto').randomUUID();

  // 즉시 응답 후 백그라운드에서 토론 진행
  res.json({ debateId, status: 'started', topic });

  // WebSocket으로 진행상황 브로드캐스트
  const fullTopic = fileContext ? topic.trim() + fileContext : topic.trim();

  debateEngine.startDebate(fullTopic, {
    maxRounds: Math.min(maxRounds, 15),
    onRoundStart: (data) => {
      broadcastDebateEvent('debate_round_start', data);
    },
    onBotResponse: (data) => {
      broadcastDebateEvent('debate_bot_response', data);
    },
    onRoundEnd: (data) => {
      broadcastDebateEvent('debate_round_end', data);
    },
    onComplete: (data) => {
      broadcastDebateEvent('debate_complete', data);
      // 봇 메모리에 결론 동기화 (백그라운드)
      if (data.debateId) {
        const debate = debateEngine.getDebate(data.debateId);
        if (debate) {
          syncConclusion(debate, bridge).catch(e =>
            console.warn('[debate] 메모리 동기화 실패:', e.message)
          );
        }
      }
    },
    onError: (data) => {
      broadcastDebateEvent('debate_error', data);
    },
  }).catch(err => {
    console.error('[debate] 토론 실패:', err.message);
    broadcastDebateEvent('debate_error', { debateId, error: err.message, fatal: true });
  });
});

// 토론 목록
app.get('/api/debates', authMiddleware, (req, res) => {
  res.json(debateEngine.listDebates());
});

// 토론 상세
app.get('/api/debates/:id', authMiddleware, (req, res) => {
  const debate = debateEngine.getDebate(req.params.id);
  if (!debate) return res.status(404).json({ error: '토론을 찾을 수 없습니다' });
  res.json(debate);
});

// 토론 취소
app.post('/api/debates/:id/cancel', authMiddleware, (req, res) => {
  const ok = debateEngine.cancelDebate(req.params.id);
  res.json({ ok });
});

// 메모리 동기화 상태 확인
app.get('/api/debate/sync-status', authMiddleware, (req, res) => {
  res.json({ configured: telegram.isConfigured() });
});

// 수동 메모리 동기화
app.post('/api/debates/:id/sync', authMiddleware, async (req, res) => {
  const debate = debateEngine.getDebate(req.params.id);
  if (!debate) return res.status(404).json({ error: '토론을 찾을 수 없습니다' });
  try {
    const results = await syncConclusion(debate, bridge);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === 집단 기억 API ===

// 토론 결론 검색
app.get('/api/conclusions', authMiddleware, (req, res) => {
  const { q, limit = 10 } = req.query;
  if (q) {
    res.json(sharedMemory.searchConclusions(q, { limit: Number(limit) }));
  } else {
    res.json(sharedMemory.getAllConclusions({ limit: Number(limit) }));
  }
});

// 토론 결론 삭제
app.delete('/api/conclusions/:id', authMiddleware, (req, res) => {
  const ok = sharedMemory.deleteConclusion(req.params.id);
  res.json({ ok });
});

// 인사이트 검색
app.get('/api/insights', authMiddleware, (req, res) => {
  const { q, limit = 10 } = req.query;
  if (q) {
    res.json(sharedMemory.searchInsights(q, { limit: Number(limit) }));
  } else {
    res.json([]);
  }
});

// 토론 이벤트를 인증된 WebSocket 클라이언트에 브로드캐스트
function broadcastDebateEvent(type, data) {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && ws._authenticated) {
      ws.send(JSON.stringify({ type, ...data }));
    }
  });
}

// Memory health check proxy
app.get('/api/memory/health', async (req, res) => {
  const result = await healthCheck();
  if (result) {
    res.json(result);
  } else {
    res.status(503).json({ status: 'offline' });
  }
});

// WebSocket handler
wss.on('connection', (ws) => {
  let authenticated = false;
  let currentSession = null;
  const wsSessionId = require('crypto').randomUUID(); // WebSocket 연결별 고유 ID

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // Auth
    if (msg.type === 'auth') {
      try {
        jwt.verify(msg.token, JWT_SECRET);
        authenticated = true;
        ws._authenticated = true;
        ws.send(JSON.stringify({ type: 'auth_ok' }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth failed' }));
        ws.close();
      }
      return;
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    // Join session
    if (msg.type === 'join') {
      const sessionId = msg.sessionId || require('crypto').randomUUID();
      createSession(sessionId);
      currentSession = sessionId;
      const history = getMessages(sessionId);
      ws.send(JSON.stringify({ type: 'session_joined', sessionId, history }));
      return;
    }

    // Chat message
    if (msg.type === 'chat') {
      if (!currentSession) {
        ws.send(JSON.stringify({ type: 'error', message: 'No session joined' }));
        return;
      }

      const userContent = msg.content?.trim();
      if (!userContent) return;

      // Determine which agents to call
      let agentsToCall = [...AGENT_ORDER];
      
      // Check for @mention to call specific agent
      const mentionMatch = userContent.match(/@(이지두|민이|김주희)/);
      if (mentionMatch) {
        const mentionMap = { '이지두': 'ezdo', '민이': 'mini', '김주희': 'juhee' };
        const targetAgent = mentionMap[mentionMatch[1]];
        if (targetAgent) agentsToCall = [targetAgent];
      }

      // Save user message
      addMessage(currentSession, {
        role: 'user',
        name: '승용씨',
        content: userContent
      });

      // Broadcast user message
      ws.send(JSON.stringify({
        type: 'message',
        role: 'user',
        name: '승용씨',
        content: userContent,
        timestamp: Date.now()
      }));

      // Build conversation history for agents
      // Auto-compact: 메시지 20개 초과 시 오래된 것 압축
      const COMPACT_THRESHOLD = 20;
      const history = getMessages(currentSession);
      let conversationMessages;

      if (history.length > COMPACT_THRESHOLD) {
        // 앞부분을 요약으로 대체, 최근 10개만 유지
        const oldMessages = history.slice(0, history.length - 10);
        const recentMessages = history.slice(-10);

        // 요약 텍스트 생성
        const summaryLines = oldMessages
          .filter(m => m.content && m.content.length > 10)
          .map(m => `[${m.name || (m.role === 'user' ? '승용' : '?')}]: ${m.content.slice(0, 100)}`)
          .join('\n');

        const summaryMessage = {
          role: 'user',
          content: `[이전 대화 요약 — ${oldMessages.length}개 메시지]\n${summaryLines.slice(0, 1000)}`
        };

        conversationMessages = [
          summaryMessage,
          { role: 'assistant', content: '(이전 대화 내용을 확인했습니다. 계속하겠습니다.)' },
          ...recentMessages.map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: (m.role === 'user' ? m.content : `[${m.name}]: ${m.content.replace(/^\[[\w\s가-힣·]+\]\s*:?\s*/g, '').trim()}`).trimEnd() || '(내용 없음)'
          }))
        ];
      } else {
        conversationMessages = history.map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: (m.role === 'user' ? m.content : `[${m.name}]: ${m.content.replace(/^\[[\w\s가-힣·]+\]\s*:?\s*/g, '').trim()}`).trimEnd() || '(내용 없음)'
        }));
      }

      // Call each agent sequentially
      for (const agentId of agentsToCall) {
        const agent = AGENTS[agentId];
        
        // Send typing indicator
        ws.send(JSON.stringify({
          type: 'typing',
          agentId,
          name: agent.name,
          emoji: agent.emoji
        }));

        try {
          let agentContent = '';

          // Stream tokens to client
          await callAgent(agentId, conversationMessages, (token) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'token',
                agentId,
                name: agent.name,
                emoji: agent.emoji,
                color: agent.color,
                token
              }));
            }
            agentContent += token;
          }, { sessionId: currentSession || wsSessionId, userMessage: userContent });

          // Save agent message
          addMessage(currentSession, {
            role: 'assistant',
            agentId,
            name: agent.name,
            content: agentContent
          });

          // Add to conversation for next agent (trim to avoid Anthropic trailing whitespace error)
          conversationMessages.push({
            role: 'assistant',
            content: `[${agent.name}]: ${agentContent}`.trimEnd() || `[${agent.name}]: (응답 없음)`
          });

          // Send complete message
          ws.send(JSON.stringify({
            type: 'message_complete',
            agentId,
            name: agent.name,
            emoji: agent.emoji,
            color: agent.color,
            content: agentContent,
            timestamp: Date.now()
          }));

        } catch (err) {
          console.error(`Agent ${agentId} error:`, err.message, err.stack);
          ws.send(JSON.stringify({
            type: 'agent_error',
            agentId,
            name: agent.name,
            error: err.message
          }));
        }
      }

      // Signal all agents done
      ws.send(JSON.stringify({ type: 'turn_complete' }));
    }
  });

  ws.on('close', () => {
    // cleanup if needed
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🦞 KDSys MultiAgent Lab running on port ${PORT}`);
  console.log(`   Local:      http://localhost:${PORT}`);
  console.log(`   Network:    http://192.168.100.22:${PORT}`);
});
