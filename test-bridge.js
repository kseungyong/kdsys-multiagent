#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { OpenClawBridge } = require('./openclaw-bridge');

async function main() {
  const bridge = new OpenClawBridge();

  // 1. Health check
  console.log('=== 연결 상태 확인 ===\n');
  const health = await bridge.checkAll();
  console.log('Online:', health.connected.join(', ') || '없음');
  console.log('Offline:', health.failed.map(f => `${f.botId}(${f.error})`).join(', ') || '없음');

  // 2. 메시지 전송 테스트
  console.log('\n=== 메시지 전송 테스트 ===\n');
  for (const botId of bridge.getBotIds()) {
    try {
      console.log(`[${botId}] 전송 중...`);
      const result = await bridge.sendMessage(botId, '테스트입니다. "연결 성공"이라고만 답해주세요.', {
        timeoutMs: 60000,
      });
      console.log(`[${botId}] ✅ ${result.botName}: ${result.content}\n`);
    } catch (err) {
      console.log(`[${botId}] ❌ ${err.message}\n`);
    }
  }

  // 3. 상태 출력
  console.log('=== 최종 상태 ===');
  console.log(JSON.stringify(bridge.getStatus(), null, 2));
}

main().catch(console.error);
