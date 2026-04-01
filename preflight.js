'use strict';

/**
 * preflight.js
 * 서버 시작 시 API 키 유효성 사전 검증.
 * 실패해도 서버는 정상 시작 (non-blocking).
 */

const https = require('https');
const http = require('http');

const KEY_TTL_MS = 60 * 60 * 1000; // 1시간

let cached = null;
let checkedAt = 0;

async function checkGemini() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { valid: false, error: 'not configured' };
  return new Promise((resolve) => {
    const req = https.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
      { timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200
          ? { valid: true }
          : { valid: false, error: `HTTP ${res.statusCode}` });
      }
    );
    req.on('error', (e) => resolve({ valid: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false, error: 'timeout' }); });
  });
}

async function checkOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { valid: false, error: 'not configured' };
  return new Promise((resolve) => {
    const req = https.get(
      'https://api.openai.com/v1/models',
      { headers: { Authorization: `Bearer ${key}` }, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200
          ? { valid: true }
          : { valid: false, error: `HTTP ${res.statusCode}` });
      }
    );
    req.on('error', (e) => resolve({ valid: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false, error: 'timeout' }); });
  });
}

function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { valid: false, error: 'not configured' };
  if (!key.startsWith('sk-ant-')) return { valid: false, error: 'invalid format' };
  return { valid: true };
}

async function runPreflight() {
  const [gemini, openai] = await Promise.all([checkGemini(), checkOpenAI()]);
  const anthropic = checkAnthropic();

  cached = { gemini, openai, anthropic };
  checkedAt = Date.now();

  for (const [name, result] of Object.entries(cached)) {
    if (result.valid) {
      console.log(`[preflight] ${name}: ✓ valid`);
    } else {
      console.warn(`[preflight] ${name}: ✗ ${result.error}`);
    }
  }

  return cached;
}

function getKeyStatus() {
  if (!cached) return null;
  const expired = Date.now() - checkedAt > KEY_TTL_MS;
  return { ...cached, _expired: expired, _checkedAt: new Date(checkedAt).toISOString() };
}

function isCacheExpired() {
  return !cached || Date.now() - checkedAt > KEY_TTL_MS;
}

module.exports = { runPreflight, getKeyStatus, isCacheExpired };
