'use strict';

/**
 * memory-sync.js
 * 토론 결론을 봇 메모리에 동기화.
 *
 * 경로 1: mini MEMORY.md 직접 쓰기 → 다음 세션 시작 시 자동 주입
 * 경로 2: 공유 메모리 API (port 3457) → 모든 봇이 memory_search로 조회 가능
 */

const fs = require('fs');
const config = require('./config');
const { saveMemory } = require('./memory-bridge');

const MINI_MEMORY_FILE = config.paths.miniMemory;
const CONCLUSIONS_SECTION = '## 토론 결론 (자동 동기화)';

/**
 * 토론 결론을 모든 경로로 동기화
 */
async function syncConclusion(debate) {
  if (!debate?.conclusion) return;

  const results = { miniMemoryMd: false, sharedMemoryApi: {} };

  // 1. mini MEMORY.md 직접 쓰기 (다음 세션에 자동 주입)
  try {
    writeToMiniMemory(debate);
    results.miniMemoryMd = true;
    console.log('[memory-sync] mini MEMORY.md 업데이트 완료');
  } catch (e) {
    console.warn('[memory-sync] mini MEMORY.md 쓰기 실패:', e.message);
  }

  // 2. 공유 메모리 API에 저장 (모든 봇이 memory_search로 조회 가능)
  const conclusionText = formatConclusionText(debate);
  const tags = ['debate-conclusion', debate.conclusion.isConsensus ? 'consensus' : 'no-consensus'];

  for (const agentId of ['mini', 'ezdo', 'juhee']) {
    try {
      await saveMemory(agentId, conclusionText, tags, 'debate', 'shared');
      results.sharedMemoryApi[agentId] = true;
      console.log(`[memory-sync] 공유 메모리 저장 완료 (${agentId})`);
    } catch (e) {
      results.sharedMemoryApi[agentId] = false;
      console.warn(`[memory-sync] 공유 메모리 저장 실패 (${agentId}):`, e.message);
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

  if (content.includes(CONCLUSIONS_SECTION)) {
    const sectionIdx = content.indexOf(CONCLUSIONS_SECTION);
    const before = content.slice(0, sectionIdx + CONCLUSIONS_SECTION.length);
    let after = content.slice(sectionIdx + CONCLUSIONS_SECTION.length);

    const existingCount = (after.match(/^### /gm) || []).length;
    if (existingCount >= 10) {
      const firstEntry = after.indexOf('### ');
      const secondEntry = after.indexOf('### ', firstEntry + 1);
      if (secondEntry > firstEntry) {
        after = after.slice(secondEntry);
      }
    }

    content = before + '\n\n' + entry + after;
  } else {
    content += '\n\n---\n\n' + CONCLUSIONS_SECTION + '\n\n' + entry;
  }

  fs.writeFileSync(MINI_MEMORY_FILE, content);
}

/**
 * 공유 메모리에 저장할 결론 텍스트 포맷
 */
function formatConclusionText(debate) {
  const c = debate.conclusion;
  const icon = c.isConsensus ? '🤝' : '📋';

  return [
    `[토론 결론] ${debate.topic}`,
    `${c.totalRounds}라운드, ${c.stopNote}`,
    `${icon} ${(c.unifiedConclusion || '').slice(0, 400)}`,
  ].join('\n');
}

module.exports = { syncConclusion, writeToMiniMemory };
