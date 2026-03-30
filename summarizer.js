'use strict';

/**
 * summarizer.js
 * 봇 응답을 압축하여 토큰 절약.
 * 규칙 기반 추출 (기본) + Claude Haiku 요약 (옵션)
 */

const Anthropic = require('@anthropic-ai/sdk');

let anthropic;
try {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch (e) {
  anthropic = null;
}

/**
 * 규칙 기반 요약 — 비용 $0, 빠름
 * 핵심 문장만 추출하여 maxLen 이내로 압축
 */
function extractSummary(text, maxLen = 300) {
  if (!text || text.length <= maxLen) return text;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 1. "결론:", "핵심:", "요약:" 등 뒤의 내용 우선
  const keyPhrases = ['결론', '핵심', '요약', '정리', '따라서', '결국', '즉,'];
  for (const line of lines) {
    for (const phrase of keyPhrases) {
      if (line.includes(phrase)) {
        const extracted = line.length > maxLen ? line.slice(0, maxLen) + '...' : line;
        return extracted;
      }
    }
  }

  // 2. 불릿 포인트 추출
  const bullets = lines.filter(l => /^[-•*▸▹✅⚠️❌\d+[.)]]/.test(l));
  if (bullets.length >= 2) {
    let result = bullets.join('\n');
    if (result.length > maxLen) result = result.slice(0, maxLen) + '...';
    return result;
  }

  // 3. 첫 문장 + 마지막 문장
  const first = lines[0] || '';
  const last = lines[lines.length - 1] || '';
  if (first === last) return first.slice(0, maxLen);
  let result = `${first}\n${last}`;
  if (result.length > maxLen) result = result.slice(0, maxLen) + '...';
  return result;
}

/**
 * Claude Haiku 요약 — 고품질, ~$0.002/회
 */
async function claudeSummary(text, { context = '', maxLen = 200 } = {}) {
  if (!anthropic) throw new Error('Anthropic API not configured');
  if (!text || text.length <= maxLen) return text;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 150,
    system: '너는 요약 전문가야. 주어진 텍스트의 핵심 주장과 근거를 3줄 이내로 압축해. 불필요한 인사말이나 수식어 제거. 한국어로.',
    messages: [{
      role: 'user',
      content: context
        ? `[맥락: ${context}]\n\n다음을 요약해:\n${text}`
        : `다음을 요약해:\n${text}`,
    }],
  });

  return response.content[0]?.text || extractSummary(text, maxLen);
}

/**
 * 메인 요약 함수 — mode에 따라 전략 선택
 *  - 'extract': 규칙 기반 추출 ($0, 빠름)
 *  - 'claude': Claude Haiku 요약 (고품질, 유료)
 *  - 'auto': 짧으면 추출, 길면 Claude
 */
async function summarize(text, { mode = 'extract', context = '', maxLen = 300 } = {}) {
  if (!text) return '';
  if (text.length <= maxLen) return text;

  if (mode === 'extract') {
    return extractSummary(text, maxLen);
  }

  if (mode === 'claude') {
    try {
      return await claudeSummary(text, { context, maxLen });
    } catch (e) {
      console.warn('[summarizer] Claude 요약 실패, 규칙 기반 폴백:', e.message);
      return extractSummary(text, maxLen);
    }
  }

  if (mode === 'auto') {
    if (text.length > 800 && anthropic) {
      try {
        return await claudeSummary(text, { context, maxLen });
      } catch (e) {
        return extractSummary(text, maxLen);
      }
    }
    return extractSummary(text, maxLen);
  }

  return extractSummary(text, maxLen);
}

module.exports = { summarize, extractSummary, claudeSummary };
