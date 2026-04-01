'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('shared-memory', () => {
  let sharedMemory;
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
    process.env.DATA_PATH = tmpDir;
    sharedMemory = require('../../shared-memory');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATA_PATH;
  });

  describe('extractKeywords', () => {
    test('한국어 키워드 추출', () => {
      const kws = sharedMemory.extractKeywords('마이크로서비스 전환 전략에 대해 논의');
      expect(kws).toContain('마이크로서비스');
      expect(kws).toContain('전환');
      // "전략에"는 조사 포함 → 정확한 형태소 분리 없이 "전략에"로 추출됨
      expect(kws.some(k => k.startsWith('전략'))).toBe(true);
    });

    test('불용어 제거', () => {
      const kws = sharedMemory.extractKeywords('이것은 그리고 하다');
      // 불용어만 있으면 결과가 적어야 함
      expect(kws.length).toBeLessThanOrEqual(1);
    });

    test('영어 불용어 제거', () => {
      const kws = sharedMemory.extractKeywords('the quick brown fox and the lazy dog');
      expect(kws).not.toContain('the');
      expect(kws).not.toContain('and');
      expect(kws).toContain('quick');
      expect(kws).toContain('brown');
    });

    test('빈 텍스트', () => {
      expect(sharedMemory.extractKeywords('')).toEqual([]);
      expect(sharedMemory.extractKeywords(null)).toEqual([]);
    });

    test('중복 키워드 제거', () => {
      const kws = sharedMemory.extractKeywords('AI AI AI 토론 토론');
      const unique = [...new Set(kws)];
      expect(kws.length).toBe(unique.length);
    });
  });

  describe('saveConclusion / searchConclusions', () => {
    const mockDebate = {
      id: 'test-1',
      topic: '마이크로서비스 전환 전략',
      rounds: [{ responses: [] }, { responses: [] }],
      conclusion: {
        stopReason: 'consensus',
        stopNote: '합의 도달',
        finalPositions: {
          mini: { botName: '민이', position: '단계적 전환 추천' },
          ezdo: { botName: '이지두', position: 'API 게이트웨이 먼저' },
        },
      },
    };

    test('결론 저장 후 검색 가능', () => {
      sharedMemory.saveConclusion(mockDebate);
      const results = sharedMemory.searchConclusions('마이크로서비스');
      expect(results.length).toBe(1);
      expect(results[0].topic).toBe('마이크로서비스 전환 전략');
    });

    test('관련 없는 검색어 → 결과 없음', () => {
      sharedMemory.saveConclusion(mockDebate);
      const results = sharedMemory.searchConclusions('블록체인 NFT');
      expect(results.length).toBe(0);
    });

    test('getAllConclusions 동작', () => {
      sharedMemory.saveConclusion(mockDebate);
      sharedMemory.saveConclusion({ ...mockDebate, id: 'test-2', topic: '두번째 토론' });
      const all = sharedMemory.getAllConclusions();
      expect(all.length).toBe(2);
    });

    test('중복 ID 업데이트', () => {
      sharedMemory.saveConclusion(mockDebate);
      sharedMemory.saveConclusion({ ...mockDebate, topic: '수정된 주제' });
      const all = sharedMemory.getAllConclusions();
      expect(all.length).toBe(1);
    });
  });

  describe('buildPriorContext', () => {
    test('관련 결론 없으면 빈 문자열', () => {
      expect(sharedMemory.buildPriorContext('랜덤 주제')).toBe('');
    });

    test('관련 결론 있으면 컨텍스트 생성', () => {
      sharedMemory.saveConclusion({
        id: 'ctx-1',
        topic: 'AI 토론 시스템 개선',
        rounds: [{}],
        conclusion: {
          stopReason: 'consensus',
          stopNote: '합의',
          finalPositions: { mini: { botName: '민이', position: '좋은 방향이다' } },
        },
      });
      const ctx = sharedMemory.buildPriorContext('AI 시스템');
      expect(ctx).toContain('관련 과거 토론 결론');
      expect(ctx).toContain('AI 토론 시스템 개선');
    });
  });
});
