'use strict';

const path = require('path');

describe('config', () => {
  let config;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.DATA_PATH;
    delete process.env.OPENCLAW_WORKSPACE;
  });

  test('기본 DATA_PATH는 ./data', () => {
    config = require('../../config');
    expect(config.DATA_PATH).toBe(path.join(__dirname, '..', '..', 'data'));
  });

  test('DATA_PATH 환경변수 오버라이드', () => {
    process.env.DATA_PATH = '/tmp/test-data';
    config = require('../../config');
    expect(config.DATA_PATH).toBe('/tmp/test-data');
  });

  test('paths 객체에 필수 경로 포함', () => {
    config = require('../../config');
    const requiredPaths = ['conclusions', 'debates', 'insights', 'sessions', 'messages', 'uploads', 'miniMemory'];
    for (const key of requiredPaths) {
      expect(config.paths[key]).toBeDefined();
      expect(typeof config.paths[key]).toBe('string');
    }
  });

  test('limits 기본값 존재', () => {
    config = require('../../config');
    expect(config.limits.maxConclusions).toBe(200);
    expect(config.limits.maxInsights).toBe(500);
    expect(config.limits.maxDebates).toBe(50);
    expect(config.limits.maxRounds).toBe(15);
    expect(config.limits.fileSizeMB).toBe(10);
  });
});
