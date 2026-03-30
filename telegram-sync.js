'use strict';

/**
 * telegram-sync.js
 * KDSys MultiAgent - 텔레그램 동기화
 * 토론 결론을 텔레그램 그룹에 공유
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * 텔레그램 그룹에 메시지 전송
 */
async function sendToGroup(text, { parseMode = 'Markdown' } = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_ID) {
    console.warn('[telegram] 토큰 또는 그룹 ID 미설정');
    return false;
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_GROUP_ID,
        text,
        parse_mode: parseMode,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error('[telegram] 전송 실패:', data.description);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[telegram] 전송 에러:', e.message);
    return false;
  }
}

/**
 * 토론 결론을 텔레그램 형식으로 변환 후 전송
 */
async function shareDebateConclusion(debate) {
  if (!debate?.conclusion) return false;

  const c = debate.conclusion;
  const icon = c.isConsensus ? '🤝' : '📋';
  const title = c.isConsensus ? '합의된 결론' : '최종 결론';

  const lines = [];
  lines.push(`⚔️ *자율 토론 완료*`);
  lines.push(`📋 *주제:* ${escapeMarkdown(debate.topic.slice(0, 200))}`);
  lines.push(`⏱ ${c.totalRounds}라운드 • ${c.stopNote || ''}`);
  lines.push('');
  lines.push(`${icon} *${title}*`);

  if (c.unifiedConclusion) {
    lines.push(escapeMarkdown(c.unifiedConclusion.slice(0, 800)));
  }

  lines.push('');
  lines.push('_— KDSys MultiAgent Lab_');

  return sendToGroup(lines.join('\n'));
}

/**
 * 토론 시작 알림
 */
async function notifyDebateStart(topic) {
  return sendToGroup(`⚔️ *토론 시작*\n📋 ${escapeMarkdown(topic.slice(0, 200))}\n\n_봇들이 토론 중입니다..._`);
}

/**
 * Markdown 특수문자 이스케이프
 */
function escapeMarkdown(text) {
  return (text || '').replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/**
 * 설정 상태 확인
 */
function isConfigured() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_GROUP_ID);
}

module.exports = { sendToGroup, shareDebateConclusion, notifyDebateStart, isConfigured };
