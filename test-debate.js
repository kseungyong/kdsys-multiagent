#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { OpenClawBridge } = require('./openclaw-bridge');
const { DebateEngine } = require('./debate-engine');

async function main() {
  const bridge = new OpenClawBridge();

  // 연결 확인
  console.log('봇 연결 확인 중...');
  const health = await bridge.checkAll();
  console.log(`Online: ${health.connected.join(', ')}`);
  if (health.failed.length > 0) {
    console.log(`Offline: ${health.failed.map(f => f.botId).join(', ')}`);
  }

  const engine = new DebateEngine({ bridge, summaryMode: 'extract' });

  console.log('\n========================================');
  console.log('  자율 토론 시작');
  console.log('  주제: "AI 스타트업에서 가장 중요한 것은?"');
  console.log('  최대 3라운드');
  console.log('========================================\n');

  const debate = await engine.startDebate(
    'AI 스타트업에서 가장 중요한 것은 무엇인가?',
    {
      maxRounds: 3,
      onRoundStart: ({ roundNum, maxRounds }) => {
        console.log(`\n─────── Round ${roundNum}/${maxRounds} ───────\n`);
      },
      onBotResponse: ({ emoji, botName, summary }) => {
        console.log(`${emoji} ${botName}: ${summary}\n`);
      },
      onRoundEnd: ({ roundNum, evaluation }) => {
        console.log(`  📊 평가: ${evaluation.note}`);
      },
      onComplete: ({ totalRounds, durationMs }) => {
        console.log(`\n========================================`);
        console.log(`  토론 완료: ${totalRounds}라운드, ${(durationMs / 1000).toFixed(1)}초`);
        console.log(`========================================`);
      },
      onError: ({ botId, error }) => {
        console.log(`  ⚠️ ${botId}: ${error}`);
      },
    }
  );

  // 결론 출력
  console.log('\n===== 최종 결론 =====\n');
  const c = debate.conclusion;
  console.log(`주제: ${c.topic}`);
  console.log(`라운드: ${c.totalRounds}`);
  console.log(`종료 이유: ${c.stopNote}`);
  console.log('\n--- 각 봇 최종 입장 ---');
  for (const [botId, pos] of Object.entries(c.finalPositions)) {
    console.log(`\n[${pos.botName}]`);
    console.log(pos.position.slice(0, 300));
  }
}

main().catch(console.error);
