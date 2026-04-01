'use strict';

const { syncConclusion } = require('../../memory-sync');
const { getClient } = require('../../memory-bridge');

describe('Memory Sync (통합)', () => {
  test('syncConclusion: 3개 에이전트 모두 저장 성공', async () => {
    const mockDebate = {
      topic: '[테스트] 통합 테스트 메모리 동기화',
      conclusion: {
        isConsensus: true,
        totalRounds: 2,
        stopNote: '테스트 합의',
        unifiedConclusion: '통합 테스트용 결론입니다.',
      },
    };

    const result = await syncConclusion(mockDebate);
    expect(result.miniMemoryMd).toBe(true);
    expect(result.sharedMemoryApi.mini).toBe(true);
    expect(result.sharedMemoryApi.ezdo).toBe(true);
    expect(result.sharedMemoryApi.juhee).toBe(true);
  });

  test('저장된 결론 조회 가능', async () => {
    const memories = await getClient('mini').read({ scope: 'shared', category: 'debate', limit: 1 });
    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0].content).toContain('토론 결론');
  });
});
