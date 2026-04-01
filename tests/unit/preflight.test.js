'use strict';

describe('preflight', () => {
  let preflight;

  beforeEach(() => {
    jest.resetModules();
    // 환경변수 초기화
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('키 미설정 시 valid:false, error:"not configured"', async () => {
    preflight = require('../../preflight');
    const result = await preflight.runPreflight();
    expect(result.gemini).toEqual({ valid: false, error: 'not configured' });
    expect(result.openai).toEqual({ valid: false, error: 'not configured' });
    expect(result.anthropic).toEqual({ valid: false, error: 'not configured' });
  });

  test('Anthropic 키 형식 검증: 잘못된 형식', async () => {
    process.env.ANTHROPIC_API_KEY = 'invalid-key';
    preflight = require('../../preflight');
    const result = await preflight.runPreflight();
    expect(result.anthropic).toEqual({ valid: false, error: 'invalid format' });
  });

  test('Anthropic 키 형식 검증: 올바른 형식', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
    preflight = require('../../preflight');
    const result = await preflight.runPreflight();
    expect(result.anthropic).toEqual({ valid: true });
  });

  test('getKeyStatus: preflight 전에는 null', () => {
    preflight = require('../../preflight');
    expect(preflight.getKeyStatus()).toBeNull();
  });

  test('getKeyStatus: preflight 후 캐시 반환', async () => {
    preflight = require('../../preflight');
    await preflight.runPreflight();
    const status = preflight.getKeyStatus();
    expect(status).not.toBeNull();
    expect(status._checkedAt).toBeDefined();
    expect(status._expired).toBe(false);
  });

  test('isCacheExpired: 초기에는 true', () => {
    preflight = require('../../preflight');
    expect(preflight.isCacheExpired()).toBe(true);
  });

  test('isCacheExpired: preflight 후 false', async () => {
    preflight = require('../../preflight');
    await preflight.runPreflight();
    expect(preflight.isCacheExpired()).toBe(false);
  });
});
