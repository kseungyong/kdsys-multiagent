'use strict';

/**
 * memory-bridge.js
 * KDSys MultiAgent - Memory API 연동 모듈
 * 세 에이전트의 메모리 클라이언트를 초기화하고 관리
 */

const { MemoryClient } = require('../kdsys-memory-api/client/index.js');
const http = require('http');

// 에이전트 앱 ID → 메모리 API agentId 매핑
const AGENT_MEMORY_IDS = {
  'ezdo':  'ijidu',
  'juhee': 'juhee',
  'mini':  'mini',
};

const clients = {};

/**
 * 에이전트별 MemoryClient 싱글톤 반환
 */
function getClient(agentId) {
  const memId = AGENT_MEMORY_IDS[agentId] || agentId;
  if (!clients[memId]) {
    clients[memId] = new MemoryClient({
      agentId: memId,
      secret:  'kdsys-dev-secret',
      baseUrl: 'http://127.0.0.1:3457',
    });
  }
  return clients[memId];
}

/**
 * shared 메모리 5개를 읽어 system prompt용 텍스트 반환
 * 실패해도 null 반환 (에러 무시)
 */
async function fetchMemoryContext(agentId, query) {
  try {
    const client = getClient(agentId);
    const results = [];

    // shared 메모리: 최근 대화 + 요약 (최대 8개)
    const shared = await client.read({ scope: 'shared', limit: 8 });
    if (shared && shared.length > 0) {
      results.push('## 최근 공유 컨텍스트 (다른 채널 포함)');
      shared.forEach(m => {
        // 내용 자체만 넣음 (prefix 없이)
        results.push(`- ${m.content.slice(0, 150)}`);
      });
    }

    if (results.length === 0) return null;
    return results.join('\n');
  } catch (e) {
    return null;
  }
}

/**
 * 메모리 저장 (fire-and-forget 용도로 사용)
 * 실패해도 에러 무시
 */
async function saveMemory(agentId, content, tags = [], category = 'conversation', scope = 'shared') {
  try {
    const client = getClient(agentId);
    await client.write(content, {
      scope,
      category,
      tags,
      importance: 0.6,
    });
  } catch (e) {
    // 실패해도 채팅 계속
  }
}

/**
 * Memory API health check
 * 연결 확인용
 */
async function healthCheck() {
  return new Promise((resolve) => {
    try {
      const req = http.get('http://127.0.0.1:3457/health', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ status: 'ok' });
          }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

module.exports = { getClient, fetchMemoryContext, saveMemory, healthCheck };
