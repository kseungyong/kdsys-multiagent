'use strict';

/**
 * config.js
 * 중앙 설정 관리. 환경변수 → 기본값 폴백.
 */

const path = require('path');

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, 'data');
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.join(require('os').homedir(), '.openclaw', 'workspace');

module.exports = {
  DATA_PATH,
  OPENCLAW_WORKSPACE,

  // 파일 경로
  paths: {
    conclusions: path.join(DATA_PATH, 'conclusions.json'),
    debates: path.join(DATA_PATH, 'debates.json'),
    insights: path.join(DATA_PATH, 'insights.json'),
    sessions: path.join(DATA_PATH, 'sessions.json'),
    messages: path.join(DATA_PATH, 'messages.json'),
    uploads: path.join(DATA_PATH, 'uploads'),
    miniMemory: path.join(OPENCLAW_WORKSPACE, 'MEMORY.md'),
  },

  // 제한값
  limits: {
    maxConclusions: 200,
    maxInsights: 500,
    maxDebates: 50,
    maxRounds: 15,
    fileSizeMB: 10,
  },
};
