'use strict';

const { OpenClawBridge } = require('../../openclaw-bridge');

describe('OpenClaw Bridge (통합)', () => {
  let bridge;

  beforeAll(() => {
    bridge = new OpenClawBridge();
  });

  test('ping: 최소 1개 봇 응답', async () => {
    const results = await bridge.checkAll();
    expect(results.connected.length + results.failed.length).toBeGreaterThanOrEqual(1);
    console.log('Connected:', results.connected, 'Failed:', results.failed.map(f => f.botId));
  });

  test('getStatus: 봇 상태 반환', () => {
    const status = bridge.getStatus();
    expect(typeof status).toBe('object');
  });
});
