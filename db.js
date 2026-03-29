// JSON file-based storage (no native deps)
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

function loadJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return def;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createSession(id) {
  const sessions = loadJson(SESSIONS_FILE, {});
  if (!sessions[id]) {
    sessions[id] = { id, created_at: Date.now() };
    saveJson(SESSIONS_FILE, sessions);
  }
  return id;
}

let msgIdCounter = Date.now();

function addMessage(sessionId, { role, agentId, name, content }) {
  const messages = loadJson(MESSAGES_FILE, []);
  const msg = {
    id: ++msgIdCounter,
    session_id: sessionId,
    role,
    agent_id: agentId || null,
    name,
    content,
    created_at: Date.now()
  };
  messages.push(msg);
  saveJson(MESSAGES_FILE, messages);
  return msg.id;
}

function getMessages(sessionId, limit = 100) {
  const messages = loadJson(MESSAGES_FILE, []);
  return messages
    .filter(m => m.session_id === sessionId)
    .slice(-limit);
}

function getSessions(limit = 20) {
  const sessions = loadJson(SESSIONS_FILE, {});
  const messages = loadJson(MESSAGES_FILE, []);
  
  return Object.values(sessions)
    .map(s => {
      const sessionMsgs = messages.filter(m => m.session_id === s.id);
      return {
        ...s,
        message_count: sessionMsgs.length,
        last_activity: sessionMsgs.length > 0
          ? sessionMsgs[sessionMsgs.length - 1].created_at
          : s.created_at
      };
    })
    .sort((a, b) => b.last_activity - a.last_activity)
    .slice(0, limit);
}

function deleteSession(sessionId) {
  const sessions = loadJson(SESSIONS_FILE, {});
  delete sessions[sessionId];
  saveJson(SESSIONS_FILE, sessions);

  const messages = loadJson(MESSAGES_FILE, []);
  saveJson(MESSAGES_FILE, messages.filter(m => m.session_id !== sessionId));
}

module.exports = { createSession, addMessage, getMessages, getSessions, deleteSession };
