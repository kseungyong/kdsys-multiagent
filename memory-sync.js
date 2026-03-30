'use strict';

/**
 * memory-sync.js
 * 토론 결론을 각 OpenClaw 봇의 메모리에 동기화.
 *
 * 방법 1: 로컬 봇(mini) → workspace/MEMORY.md에 직접 쓰기
 * 방법 2: 원격 봇 → Chat Completions API로 결론 전달 (봇이 자체 메모리에 저장)
 */

const fs = require('fs');
const path = require('path');
const { OpenClawBridge, BOT_CONFIG } = require('./openclaw-bridge');

// mini의 OpenClaw workspace 경로
const MINI_WORKSPACE = path.join(require('os').homedir(), '.openclaw', 'workspace');
const MINI_MEMORY_FILE = path.join(MINI_WORKSPACE, 'MEMORY.md');
const CONCLUSIONS_SECTION = '## 토론 결론 (자동 동기화)';

/**
 * 토론 결론을 모든 봇에 동기화
 */
async function syncConclusion(debate, bridge) {
  if (!debate?.conclusion) return;

  const results = { mini: false, ezdoitbot: false, iriskdsys: false };

  // 1. mini (로컬) → MEMORY.md에 직접 쓰기
  try {
    writeToMiniMemory(debate);
    results.mini = true;
    console.log('[memory-sync] mini MEMORY.md 업데이트 완료');
  } catch (e) {
    console.warn('[memory-sync] mini 쓰기 실패:', e.message);
  }

  // 2. 원격 봇들 → Chat Completions API로 전달
  const remoteBots = ['ezdoitbot', 'iriskdsys'];
  const conclusionMsg = formatConclusionForBot(debate);

  for (const botId of remoteBots) {
    try {
      if (!bridge) bridge = new OpenClawBridge();
      await bridge.sendMessage(botId, conclusionMsg, { timeoutMs: 60000 });
      results[botId] = true;
      console.log(`[memory-sync] ${botId} 결론 전달 완료`);
    } catch (e) {
      console.warn(`[memory-sync] ${botId} 전달 실패:`, e.message);
    }
  }

  return results;
}

/**
 * mini의 MEMORY.md에 토론 결론 추가
 */
function writeToMiniMemory(debate) {
  if (!fs.existsSync(MINI_MEMORY_FILE)) return;

  let content = fs.readFileSync(MINI_MEMORY_FILE, 'utf8');
  const c = debate.conclusion;
  const date = new Date().toISOString().slice(0, 10);
  const icon = c.isConsensus ? '🤝' : '📋';

  const entry = [
    `### ${icon} ${debate.topic.slice(0, 60)}`,
    `- 날짜: ${date} | ${c.totalRounds}라운드 | ${c.stopNote}`,
    `- 결론: ${(c.unifiedConclusion || '').slice(0, 300)}`,
    '',
  ].join('\n');

  // 토론 결론 섹션이 있으면 거기에 추가, 없으면 섹션 생성
  if (content.includes(CONCLUSIONS_SECTION)) {
    // 섹션 끝에 추가 (최대 10개 유지)
    const sectionIdx = content.indexOf(CONCLUSIONS_SECTION);
    const before = content.slice(0, sectionIdx + CONCLUSIONS_SECTION.length);
    let after = content.slice(sectionIdx + CONCLUSIONS_SECTION.length);

    // 기존 결론 개수 체크 (### 으로 시작하는 라인 수)
    const existingCount = (after.match(/^### /gm) || []).length;
    if (existingCount >= 10) {
      // 가장 오래된 것 삭제 (첫 번째 ### 부터 다음 ### 전까지)
      const firstEntry = after.indexOf('### ');
      const secondEntry = after.indexOf('### ', firstEntry + 1);
      if (secondEntry > firstEntry) {
        after = after.slice(secondEntry);
      }
    }

    content = before + '\n\n' + entry + after;
  } else {
    // 파일 끝에 섹션 추가
    content += '\n\n---\n\n' + CONCLUSIONS_SECTION + '\n\n' + entry;
  }

  fs.writeFileSync(MINI_MEMORY_FILE, content);
}

/**
 * 원격 봇에 전달할 결론 메시지 포맷
 */
function formatConclusionForBot(debate) {
  const c = debate.conclusion;
  const icon = c.isConsensus ? '🤝' : '📋';

  return [
    `[KDSys 토론 결론 동기화]`,
    `주제: "${debate.topic}"`,
    `${c.totalRounds}라운드, ${c.stopNote}`,
    '',
    `${icon} 결론: ${(c.unifiedConclusion || '').slice(0, 500)}`,
    '',
    `이 내용을 기억해두세요. 향후 관련 대화에서 참고할 수 있습니다.`,
  ].join('\n');
}

module.exports = { syncConclusion, writeToMiniMemory };
