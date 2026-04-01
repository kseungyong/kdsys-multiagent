'use strict';

const { extractSummary, summarize } = require('../../summarizer');

describe('extractSummary', () => {
  test('짧은 텍스트는 그대로 반환', () => {
    expect(extractSummary('짧은 텍스트', 300)).toBe('짧은 텍스트');
  });

  test('null/빈 텍스트 처리', () => {
    expect(extractSummary(null)).toBeNull();
    expect(extractSummary('')).toBe('');
  });

  test('결론 키워드가 있으면 해당 라인 추출', () => {
    const text = '첫 줄입니다.\n두번째 줄.\n결론: AI 토론 시스템은 효과적이다.\n마지막 줄.';
    const result = extractSummary(text, 300);
    expect(result).toContain('결론');
    expect(result).toContain('AI 토론 시스템');
  });

  test('핵심 키워드 추출', () => {
    const text = '서론입니다 블라블라.\n분석 내용.\n핵심: 메모리 동기화가 중요하다.\n기타.';
    const result = extractSummary(text, 300);
    expect(result).toContain('핵심');
  });

  test('따라서 키워드 추출', () => {
    const text = '긴 설명 라인 하나.\n더 긴 설명.\n따라서 결국 이런 방식이 최선이다.\n끝.';
    const result = extractSummary(text, 300);
    expect(result).toContain('따라서');
  });

  test('불릿 포인트 추출 (2개 이상)', () => {
    const text = '서론입니다.\n- 첫번째 포인트\n- 두번째 포인트\n- 세번째 포인트\n결론 없음 마무리.';
    const result = extractSummary(text, 300);
    expect(result).toContain('첫번째 포인트');
    expect(result).toContain('두번째 포인트');
  });

  test('키워드/불릿 없으면 첫+끝 문장', () => {
    const text = '첫 번째 문장입니다.\n중간 내용.\n또 다른 중간.\n마지막 문장입니다. 이것은 길어서 테스트가 가능합니다.';
    const result = extractSummary(text, 300);
    expect(result).toContain('첫 번째 문장');
    expect(result).toContain('마지막 문장');
  });

  test('maxLen 초과 시 잘림', () => {
    const text = '결론: ' + 'A'.repeat(500);
    const result = extractSummary(text, 100);
    expect(result.length).toBeLessThanOrEqual(103); // 100 + '...'
    expect(result).toMatch(/\.\.\.$/);
  });

  test('첫줄과 마지막줄이 같으면 하나만 반환', () => {
    const line = 'A'.repeat(100);
    // 4줄 반복 → 총 길이 > 300 → extractSummary 진입 → first===last → 한 줄만
    const text = [line, line, line, line].join('\n');
    const result = extractSummary(text, 300);
    expect(result).not.toContain('\n');
  });

  test('첫+끝 경로에서도 maxLen 적용', () => {
    const text = 'A'.repeat(200) + '\n중간\n' + 'B'.repeat(200);
    const result = extractSummary(text, 100);
    expect(result.length).toBeLessThanOrEqual(103);
  });
});

describe('summarize', () => {
  test('빈 텍스트 → 빈 문자열', async () => {
    expect(await summarize('')).toBe('');
    expect(await summarize(null)).toBe('');
  });

  test('짧은 텍스트 → 그대로 반환', async () => {
    const result = await summarize('짧은 텍스트', { mode: 'extract' });
    expect(result).toBe('짧은 텍스트');
  });

  test('extract 모드: extractSummary 사용', async () => {
    const long = '결론: AI가 효과적이다.\n' + 'A'.repeat(500);
    const result = await summarize(long, { mode: 'extract', maxLen: 300 });
    expect(result).toContain('결론');
  });

  test('claude 모드: API 없으면 폴백', async () => {
    const long = '서론.\n' + 'A'.repeat(500);
    // Anthropic API가 테스트에서는 미설정 → 폴백
    const result = await summarize(long, { mode: 'claude', maxLen: 300 });
    expect(result.length).toBeGreaterThan(0);
  });

  test('auto 모드: 짧은 텍스트는 extract', async () => {
    const text = '결론: 이것은 자동 모드 테스트.\n' + 'A'.repeat(400);
    const result = await summarize(text, { mode: 'auto', maxLen: 300 });
    expect(result).toContain('결론');
  });

  test('알 수 없는 모드 → extract 폴백', async () => {
    const text = '결론: 폴백 테스트.\n' + 'A'.repeat(400);
    const result = await summarize(text, { mode: 'unknown', maxLen: 300 });
    expect(result).toContain('결론');
  });
});
