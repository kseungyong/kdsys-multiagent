'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('DebateEngine', () => {
  let DebateEngine, BOT_ORDER, BOT_ROLES;
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'de-test-'));
    process.env.DATA_PATH = tmpDir;
    ({ DebateEngine, BOT_ORDER, BOT_ROLES } = require('../../debate-engine'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_PATH;
  });

  describe('exports', () => {
    test('BOT_ORDER는 3개 봇', () => {
      expect(BOT_ORDER).toHaveLength(3);
    });

    test('BOT_ROLES는 객체', () => {
      expect(typeof BOT_ROLES).toBe('object');
      for (const botId of BOT_ORDER) {
        expect(BOT_ROLES[botId]).toBeDefined();
      }
    });
  });

  describe('Jaccard similarity (_calculateSimilarity)', () => {
    let engine;

    beforeEach(() => {
      const mockBridge = { sendMessage: jest.fn() };
      engine = new DebateEngine({ bridge: mockBridge });
    });

    test('동일 텍스트 → 1.0', () => {
      expect(engine._calculateSimilarity('hello world', 'hello world')).toBe(1);
    });

    test('완전히 다른 텍스트 → 0', () => {
      expect(engine._calculateSimilarity('hello world', 'foo bar baz')).toBe(0);
    });

    test('부분 겹침 → 0 < sim < 1', () => {
      const sim = engine._calculateSimilarity('hello world foo', 'hello bar baz');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    test('빈 문자열 둘 다 → 1', () => {
      expect(engine._calculateSimilarity('', '')).toBe(1);
    });
  });

  describe('_evaluateRound 합의 감지', () => {
    let engine;

    beforeEach(() => {
      const mockBridge = { sendMessage: jest.fn() };
      engine = new DebateEngine({ bridge: mockBridge });
    });

    test('동의 키워드 2개 이상이면 합의', () => {
      const debate = { rounds: [{ responses: [] }], maxRounds: 10 };
      const round = {
        responses: [
          { botId: 'mini', content: '저도 동의합니다. 좋은 의견이에요.' },
          { botId: 'ezdo', content: '맞습니다. 이 방향이 옳습니다.' },
          { botId: 'iriskdsys', content: '다른 의견이 있습니다.' },
        ],
        summaries: ['a', 'b', 'c'],
      };
      const result = engine._evaluateRound(debate, round);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe('consensus');
    });

    test('동의 키워드 1개 이하면 계속', () => {
      const debate = { rounds: [{ responses: [] }], maxRounds: 10 };
      const round = {
        responses: [
          { botId: 'mini', content: '저는 반대합니다.' },
          { botId: 'ezdo', content: '동의하지 않습니다.' },
          { botId: 'iriskdsys', content: '다른 관점을 제시합니다.' },
        ],
        summaries: ['x', 'y', 'z'],
      };
      const result = engine._evaluateRound(debate, round);
      expect(result.shouldStop).toBe(false);
    });

    test('최대 라운드 도달 시 종료', () => {
      const debate = {
        rounds: Array(9).fill({ responses: [], summaries: [] }),
        maxRounds: 10,
      };
      const round = {
        responses: [{ botId: 'mini', content: '의견' }],
        summaries: ['s'],
      };
      const result = engine._evaluateRound(debate, round);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe('max_rounds');
    });

    test('응답 없으면 중단', () => {
      const debate = { rounds: [], maxRounds: 10 };
      const round = { responses: [], summaries: [] };
      const result = engine._evaluateRound(debate, round);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe('no_responses');
    });

    test('수렴 감지: 이전 라운드와 유사도 > 0.8', () => {
      const sameSummary = '같은 내용 반복 동일한 의견';
      const debate = {
        rounds: [
          { responses: [{ content: 'a' }], summaries: [sameSummary] },
          { responses: [{ content: 'b' }], summaries: [sameSummary] },
        ],
        maxRounds: 10,
      };
      const round = {
        responses: [{ botId: 'mini', content: '의견' }],
        summaries: [sameSummary],
      };
      const result = engine._evaluateRound(debate, round);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe('convergence');
    });

    test('종합하면 키워드도 합의 감지', () => {
      const debate = { rounds: [{ responses: [] }], maxRounds: 10 };
      const round = {
        responses: [
          { botId: 'mini', content: '종합하면 이런 결론이 됩니다.' },
          { botId: 'ezdo', content: '정리하면 같은 방향입니다.' },
        ],
        summaries: ['a', 'b'],
      };
      const result = engine._evaluateRound(debate, round);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe('consensus');
    });
  });

  describe('인스턴스 생성', () => {
    test('bridge 없이 생성 가능', () => {
      const engine = new DebateEngine({});
      expect(engine).toBeDefined();
    });

    test('listDebates 빈 상태에서 동작', () => {
      const engine = new DebateEngine({});
      const list = engine.listDebates();
      expect(Array.isArray(list)).toBe(true);
    });

    test('getDebate 없는 ID → null/undefined', () => {
      const engine = new DebateEngine({});
      const result = engine.getDebate('nonexistent-id');
      expect(result).toBeFalsy();
    });
  });
});
