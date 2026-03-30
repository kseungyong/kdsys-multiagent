#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { OpenClawBridge } = require('./openclaw-bridge');
const { DebateEngine } = require('./debate-engine');
const sharedMemory = require('./shared-memory');

async function main() {
  const bridge = new OpenClawBridge();
  await bridge.checkAll();
  const engine = new DebateEngine({ bridge, summaryMode: 'extract' });

  // --- 토론 A ---
  console.log('===== 토론 A: AI 스타트업 =====\n');
  const debateA = await engine.startDebate(
    'AI 스타트업의 핵심 성공 요인은?',
    {
      maxRounds: 2,
      onRoundStart: ({ roundNum }) => console.log(`  Round ${roundNum}`),
      onBotResponse: ({ emoji, botName, summary }) => console.log(`  ${emoji} ${botName}: ${summary.slice(0, 80)}`),
      onComplete: ({ totalRounds, durationMs }) => console.log(`  완료: ${totalRounds}라운드, ${(durationMs/1000).toFixed(0)}초\n`),
    }
  );

  // 결론 저장 확인
  console.log('--- 저장된 결론 확인 ---');
  const saved = sharedMemory.getAllConclusions({ limit: 3 });
  console.log(`결론 ${saved.length}개 저장됨`);
  console.log(`최근 주제: "${saved[0]?.topic}"\n`);

  // --- 토론 B (관련 주제) ---
  console.log('===== 토론 B: 스타트업 투자 (관련 주제) =====\n');
  console.log('>> 과거 결론이 주입되는지 확인\n');

  const debateB = await engine.startDebate(
    'AI 스타트업에 투자할 때 가장 중요하게 봐야 할 것은?',
    {
      maxRounds: 2,
      onRoundStart: ({ roundNum }) => console.log(`  Round ${roundNum}`),
      onBotResponse: ({ emoji, botName, summary }) => console.log(`  ${emoji} ${botName}: ${summary.slice(0, 80)}`),
      onComplete: ({ totalRounds, durationMs }) => console.log(`  완료: ${totalRounds}라운드, ${(durationMs/1000).toFixed(0)}초\n`),
    }
  );

  // 검색 테스트
  console.log('--- 키워드 검색 테스트 ---');
  const results = sharedMemory.searchConclusions('AI 스타트업');
  console.log(`"AI 스타트업" 검색 결과: ${results.length}개`);
  for (const r of results) {
    console.log(`  - "${r.topic}" (관련도: ${(r.relevanceScore * 100).toFixed(0)}%)`);
  }

  // 영구 저장 확인
  console.log('\n--- 파일 저장 확인 ---');
  const fs = require('fs');
  console.log(`conclusions.json 존재: ${fs.existsSync('./data/conclusions.json')}`);
  console.log(`debates.json 존재: ${fs.existsSync('./data/debates.json')}`);
}

main().catch(console.error);
