require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = (function() {
  try { return require('crypto'); } catch(e) { return {}; }
})() ? { v4: () => require('crypto').randomUUID() } : { v4: () => Math.random().toString(36).slice(2) };

const { AGENTS, AGENT_ORDER, callAgent } = require('./agents');
const { createSession, addMessage, getMessages, getSessions, deleteSession } = require('./db');
const { healthCheck, getClient } = require('./memory-bridge');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || 'kdsys-secret-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kdsys2026';

app.use(express.json());
app.use(express.static('public'));

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
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
      const history = getMessages(currentSession);
      const conversationMessages = history.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: (m.role === 'user' ? m.content : `[${m.name}]: ${m.content}`).trimEnd() || '(내용 없음)'
      }));

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
