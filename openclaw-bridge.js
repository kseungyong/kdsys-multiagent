'use strict';

/**
 * openclaw-bridge.js
 * KDSys MultiAgent - OpenClaw Gateway Bridge
 *
 * 3개 봇(mini, ezdoitbot, iriskdsys)의 게이트웨이에 연결하여 메시지 송수신.
 * 주력: HTTP Chat Completions API (안정적, OpenAI 호환)
 * 예비: WebSocket (향후 스트리밍용)
 */

const BOT_CONFIG = {
  mini: {
    name: '민이',
    emoji: '🦞',
    host: '100.70.77.22',
    port: 23456,
    token: process.env.OPENCLAW_MINI_TOKEN || '',
  },
  ezdoitbot: {
    name: '이지두',
    emoji: '💡',
    host: '100.115.75.66',
    port: 18789,
    token: process.env.OPENCLAW_EZDO_TOKEN || '',
  },
  iriskdsys: {
    name: '김주희',
    emoji: '🌸',
    host: '100.97.141.120',
    port: 18789,
    token: process.env.OPENCLAW_IRIS_TOKEN || '',
  },
};

/**
 * 지수 백오프 재시도 헬퍼
 */
async function withRetry(fn, { maxRetries = 2, initialDelayMs = 1000, backoffFactor = 2, shouldRetry } = {}) {
  let delay = initialDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      if (shouldRetry && !shouldRetry(err)) throw err;
      console.warn(`[openclaw-bridge] 재시도 ${attempt + 1}/${maxRetries}: ${err.message} (${delay}ms 후)`);
      await new Promise(r => setTimeout(r, delay));
      delay *= backoffFactor;
    }
  }
}

/**
 * 재시도할 가치가 있는 에러인지 판별
 */
function isRetryableError(err) {
  if (err.name === 'AbortError') return true;
  if (err.message?.includes('fetch failed')) return true;
  if (err.message?.includes('ECONNREFUSED')) return true;
  if (err.message?.includes('ETIMEDOUT')) return true;
  if (err.message?.includes('HTTP 5')) return true; // 5xx
  if (err.message?.includes('HTTP 429')) return true; // rate limit
  return false;
}

class OpenClawBridge {
  constructor() {
    this.botStatus = {};  // botId → { status, lastCheck, lastError }
  }

  /**
   * 모든 봇 연결 상태 확인 (health check)
   */
  async checkAll() {
    const results = { connected: [], failed: [] };
    for (const botId of Object.keys(BOT_CONFIG)) {
      try {
        await this.ping(botId);
        results.connected.push(botId);
      } catch (err) {
        results.failed.push({ botId, error: err.message });
      }
    }
    return results;
  }

  /**
   * 단일 봇 health check
   */
  async ping(botId) {
    const config = BOT_CONFIG[botId];
    if (!config) throw new Error(`Unknown bot: ${botId}`);

    const url = `http://${config.host}:${config.port}/`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      this.botStatus[botId] = { status: 'online', lastCheck: Date.now(), lastError: null };
      return true;
    } catch (err) {
      clearTimeout(timeoutId);
      this.botStatus[botId] = { status: 'offline', lastCheck: Date.now(), lastError: err.message };
      throw new Error(`${config.name} offline: ${err.message}`);
    }
  }

  /**
   * 봇에 메시지 전송 (HTTP Chat Completions)
   * OpenClaw 게이트웨이의 /v1/chat/completions 엔드포인트 사용
   */
  async sendMessage(botId, message, { history = [], timeoutMs = 120000, maxRetries = 2 } = {}) {
    const config = BOT_CONFIG[botId];
    if (!config) throw new Error(`Unknown bot: ${botId}`);
    if (!config.token) throw new Error(`No token for ${botId}`);

    const executeSend = async () => {
      const url = `http://${config.host}:${config.port}/v1/chat/completions`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const messages = [
        ...history,
        { role: 'user', content: message },
      ];

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages, stream: false }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body}`);
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || '';
        const usage = data.usage || {};

        this.botStatus[botId] = { status: 'online', lastCheck: Date.now(), lastError: null };

        return {
          content,
          usage,
          model: data.model,
          botId,
          botName: config.name,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        this.botStatus[botId] = { status: 'error', lastCheck: Date.now(), lastError: err.message };
        throw err;
      }
    };

    return withRetry(executeSend, { maxRetries, shouldRetry: isRetryableError });
  }

  /**
   * 봇에 메시지 전송 + SSE 스트리밍
   */
  async sendMessageStream(botId, message, onToken, { history = [], timeoutMs = 120000, maxRetries = 2 } = {}) {
    const config = BOT_CONFIG[botId];
    if (!config) throw new Error(`Unknown bot: ${botId}`);
    if (!config.token) throw new Error(`No token for ${botId}`);

    const executeStream = async () => {
      const url = `http://${config.host}:${config.port}/v1/chat/completions`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const messages = [
        ...history,
        { role: 'user', content: message },
      ];

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ messages, stream: true }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status}: ${body}`);
        }

        // SSE 스트리밍 파싱
        let fullContent = '';
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);
              const token = chunk.choices?.[0]?.delta?.content || '';
              if (token) {
                fullContent += token;
                if (onToken) onToken(token);
              }
            } catch (e) {
              console.warn(`[openclaw-bridge] SSE 파싱 실패: ${data.slice(0, 100)}`);
            }
          }
        }

        this.botStatus[botId] = { status: 'online', lastCheck: Date.now(), lastError: null };

        return {
          content: fullContent,
          botId,
          botName: config.name,
        };
      } catch (err) {
        this.botStatus[botId] = { status: 'error', lastCheck: Date.now(), lastError: err.message };
        throw err;
      }
    };

    return withRetry(executeStream, { maxRetries, shouldRetry: isRetryableError });
  }

  /**
   * 모든 봇 상태 조회
   */
  getStatus() {
    const status = {};
    for (const [botId, config] of Object.entries(BOT_CONFIG)) {
      status[botId] = {
        name: config.name,
        emoji: config.emoji,
        host: `${config.host}:${config.port}`,
        ...this.botStatus[botId] || { status: 'unknown', lastCheck: null, lastError: null },
      };
    }
    return status;
  }

  /**
   * 봇 설정 조회
   */
  getBotConfig(botId) {
    return BOT_CONFIG[botId] || null;
  }

  /**
   * 봇 ID 목록
   */
  getBotIds() {
    return Object.keys(BOT_CONFIG);
  }
}

module.exports = { OpenClawBridge, BOT_CONFIG };
