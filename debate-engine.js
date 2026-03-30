'use strict';

/**
 * debate-engine.js
 * KDSys MultiAgent - 자율 토론 엔진
 *
 * 3개 OpenClaw 봇이 주제에 대해 자율적으로 토론하고,
 * 오케스트레이터가 라운드를 관리하며 결론을 도출.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { OpenClawBridge } = require('./openclaw-bridge');
const { summarize } = require('./summarizer');

let anthropic;
try {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch (e) {
  anthropic = null;
}
const { saveConclusion, buildPriorContext, saveInsight } = require('./shared-memory');

const DEBATES_FILE = path.join(__dirname, 'data', 'debates.json');

const DEBATE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const BOT_ORDER = ['mini', 'ezdoitbot', 'iriskdsys'];

const BOT_ROLES = {
  mini: { name: '민이', role: 'PM/총괄', emoji: '🦞', perspective: 'PM 관점에서 전략적으로' },
  ezdoitbot: { name: '이지두', role: '아이디어맨', emoji: '💡', perspective: '창의적/기술적 관점에서' },
  iriskdsys: { name: '김주희', role: '현실 검증', emoji: '🌸', perspective: '실무/비용/실현가능성 관점에서' },
};

class DebateEngine {
  constructor({ bridge, summaryMode = 'extract' } = {}) {
    this.bridge = bridge || new OpenClawBridge();
    this.summaryMode = summaryMode;
    this.debates = new Map();  // debateId → debate state (active only)
    this._loadDebates();       // 파일에서 기존 토론 로드
  }

  _loadDebates() {
    try {
      const data = JSON.parse(fs.readFileSync(DEBATES_FILE, 'utf8'));
      for (const d of data) {
        this.debates.set(d.id, d);
      }
    } catch (e) {
      // 파일 없으면 무시
    }
  }

  _persistDebates() {
    const dataDir = path.dirname(DEBATES_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    // 최근 50개만 저장
    const all = Array.from(this.debates.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50);
    fs.writeFileSync(DEBATES_FILE, JSON.stringify(all, null, 2));
  }

  /**
   * 토론 시작
   */
  async startDebate(topic, {
    maxRounds = 15,
    onRoundStart,
    onBotResponse,
    onRoundEnd,
    onComplete,
    onError,
  } = {}) {
    const debateId = crypto.randomUUID();
    const debate = {
      id: debateId,
      topic,
      status: DEBATE_STATUS.RUNNING,
      maxRounds,
      rounds: [],
      conclusion: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    this.debates.set(debateId, debate);

    try {
      // 관련 과거 기억 검색 → 컨텍스트 주입
      let priorContext = '';
      try {
        priorContext = buildPriorContext(topic);
        if (priorContext) {
          console.log(`[debate] 관련 과거 결론 ${priorContext.split('\n주제:').length - 1}개 발견`);
        }
      } catch (e) {
        // 메모리 검색 실패해도 토론 계속
      }

      for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
        if (debate.status === DEBATE_STATUS.CANCELLED) break;

        const round = {
          number: roundNum,
          responses: [],
          summaries: [],
          evaluation: null,
        };

        if (onRoundStart) onRoundStart({ debateId, roundNum, maxRounds });

        // 이전 라운드 요약 생성
        const previousContext = this._buildRoundContext(debate, roundNum);

        // 각 봇에게 순차 질문
        for (const botId of BOT_ORDER) {
          const botRole = BOT_ROLES[botId];
          const otherResponses = round.summaries.join('\n');

          const prompt = this._buildBotPrompt({
            topic,
            botRole,
            roundNum,
            maxRounds,
            previousContext,
            otherResponses,
            priorContext,
          });

          try {
            const result = await this.bridge.sendMessage(botId, prompt, { timeoutMs: 90000 });

            round.responses.push({
              botId,
              botName: botRole.name,
              content: result.content,
              usage: result.usage,
            });

            // 다음 봇에게 전달할 요약 생성
            const summary = await summarize(result.content, {
              mode: this.summaryMode,
              context: topic,
              maxLen: 200,
            });
            round.summaries.push(`${botRole.emoji} ${botRole.name}: ${summary}`);

            if (onBotResponse) onBotResponse({
              debateId, roundNum, botId,
              botName: botRole.name,
              emoji: botRole.emoji,
              content: result.content,
              summary,
            });
          } catch (err) {
            console.error(`[debate] ${botRole.name} 응답 실패 (Round ${roundNum}):`, err.message);
            round.responses.push({
              botId,
              botName: botRole.name,
              content: null,
              error: err.message,
            });
            round.summaries.push(`${botRole.emoji} ${botRole.name}: (응답 실패)`);

            if (onError) onError({ debateId, roundNum, botId, error: err.message });
          }
        }

        // 라운드 평가 (합의 감지)
        round.evaluation = this._evaluateRound(debate, round);
        debate.rounds.push(round);

        if (onRoundEnd) onRoundEnd({
          debateId, roundNum, maxRounds,
          evaluation: round.evaluation,
          summaries: round.summaries,
        });

        // 종료 조건 확인
        if (round.evaluation.shouldStop) {
          break;
        }
      }

      // 최종 결론 생성 (Claude 심판이 종합)
      debate.conclusion = await this._generateConclusion(debate);
      debate.status = DEBATE_STATUS.COMPLETED;
      debate.completedAt = Date.now();

      // 집단 기억에 결론 저장
      try {
        saveConclusion(debate);
        console.log(`[debate] 결론 저장 완료: "${debate.topic}"`);
      } catch (e) {
        console.warn('[debate] 결론 저장 실패:', e.message);
      }

      // 파일 영구 저장
      this._persistDebates();

      if (onComplete) onComplete({
        debateId,
        conclusion: debate.conclusion,
        totalRounds: debate.rounds.length,
        durationMs: debate.completedAt - debate.startedAt,
      });

      return debate;
    } catch (err) {
      debate.status = DEBATE_STATUS.FAILED;
      debate.completedAt = Date.now();
      this._persistDebates();
      if (onError) onError({ debateId, error: err.message, fatal: true });
      throw err;
    }
  }

  /**
   * 토론 취소
   */
  cancelDebate(debateId) {
    const debate = this.debates.get(debateId);
    if (debate && debate.status === DEBATE_STATUS.RUNNING) {
      debate.status = DEBATE_STATUS.CANCELLED;
      debate.completedAt = Date.now();
      this._persistDebates();
      return true;
    }
    return false;
  }

  /**
   * 토론 상태 조회
   */
  getDebate(debateId) {
    return this.debates.get(debateId) || null;
  }

  /**
   * 모든 토론 목록
   */
  listDebates({ limit = 20 } = {}) {
    return Array.from(this.debates.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(d => ({
        id: d.id,
        topic: d.topic,
        status: d.status,
        rounds: d.rounds.length,
        startedAt: d.startedAt,
        completedAt: d.completedAt,
      }));
  }

  // --- 내부 메서드 ---

  /**
   * 이전 라운드 컨텍스트 빌드 (슬라이딩 윈도우)
   * 최근 1라운드만 요약으로 전달, 나머지는 생략
   */
  _buildRoundContext(debate, currentRound) {
    if (debate.rounds.length === 0) return '';

    const lastRound = debate.rounds[debate.rounds.length - 1];
    const lines = [
      `[이전 라운드 ${lastRound.number} 요약]`,
      ...lastRound.summaries,
    ];

    if (lastRound.evaluation?.note) {
      lines.push(`심판 평가: ${lastRound.evaluation.note}`);
    }

    return lines.join('\n');
  }

  /**
   * 봇에게 보낼 프롬프트 생성
   */
  _buildBotPrompt({ topic, botRole, roundNum, maxRounds, previousContext, otherResponses, priorContext }) {
    const parts = [];

    parts.push(`[토론] 주제: "${topic}"`);
    parts.push(`라운드 ${roundNum}/${maxRounds}`);
    parts.push(`당신의 역할: ${botRole.name} (${botRole.role})`);
    parts.push(`관점: ${botRole.perspective} 분석하고 의견을 제시하세요.`);

    if (priorContext) {
      parts.push(`\n[관련 과거 토론 결론]\n${priorContext}`);
    }

    if (previousContext) {
      parts.push(`\n${previousContext}`);
    }

    if (otherResponses) {
      parts.push(`\n[이번 라운드 다른 참여자 의견]\n${otherResponses}`);
    }

    parts.push('\n[지침]');
    parts.push('- 구체적 근거와 함께 의견을 제시하세요');
    parts.push('- 다른 참여자 의견에 동의/반박할 점이 있으면 명확히 밝히세요');
    parts.push('- 5줄 이내로 핵심만 답하세요');

    if (roundNum >= maxRounds - 1) {
      parts.push('- 마지막 라운드입니다. 최종 입장을 정리해주세요');
    }

    return parts.join('\n');
  }

  /**
   * 라운드 평가 — 합의/루프 감지
   */
  _evaluateRound(debate, round) {
    const validResponses = round.responses.filter(r => r.content);

    // 응답이 하나도 없으면 중단
    if (validResponses.length === 0) {
      return { shouldStop: true, reason: 'no_responses', note: '모든 봇 응답 실패' };
    }

    // 마지막 라운드면 종료
    if (debate.rounds.length + 1 >= debate.maxRounds) {
      return { shouldStop: true, reason: 'max_rounds', note: '최대 라운드 도달' };
    }

    // 루프 감지: 이전 라운드와 응답 유사도 체크
    if (debate.rounds.length >= 2) {
      const prevRound = debate.rounds[debate.rounds.length - 1];
      const similarity = this._calculateSimilarity(
        round.summaries.join(' '),
        prevRound.summaries.join(' ')
      );

      if (similarity > 0.8) {
        return { shouldStop: true, reason: 'convergence', note: `수렴 감지 (유사도: ${(similarity * 100).toFixed(0)}%)` };
      }
    }

    // 합의 감지: 2라운드 이상 진행 후, 봇들이 서로 동의하는지
    if (debate.rounds.length >= 1 && validResponses.length >= 2) {
      const contents = validResponses.map(r => r.content.toLowerCase());
      const agreementWords = [
        '동의', '맞습니다', '그렇습니다', '같은 의견', '합의',
        '공감', '동감', '일리 있', '옳은 말', '저도 같은',
        '종합하면', '정리하면', '결론적으로', '모두 동의',
      ];
      const agreementCount = contents.filter(c =>
        agreementWords.some(w => c.includes(w))
      ).length;

      if (agreementCount >= 2) {
        return { shouldStop: true, reason: 'consensus', note: '합의 도달' };
      }
    }

    return { shouldStop: false, reason: 'continue', note: '토론 계속' };
  }

  /**
   * 간단한 텍스트 유사도 (Jaccard)
   */
  _calculateSimilarity(a, b) {
    const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
    const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
    if (wordsA.size === 0 && wordsB.size === 0) return 1;

    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  /**
   * 최종 결론 생성
   */
  async _generateConclusion(debate) {
    const lastRound = debate.rounds[debate.rounds.length - 1];
    if (!lastRound) return { summary: '토론 없음' };

    // 각 봇의 마지막 유효 응답 수집
    const finalPositions = {};
    for (const round of [...debate.rounds].reverse()) {
      for (const resp of round.responses) {
        if (resp.content && !finalPositions[resp.botId]) {
          finalPositions[resp.botId] = {
            botName: resp.botName,
            position: resp.content,
          };
        }
      }
    }

    const stopReason = lastRound.evaluation?.reason || 'max_rounds';
    const stopNote = lastRound.evaluation?.note || '';
    const isConsensus = stopReason === 'consensus' || stopReason === 'convergence';

    // Claude 심판이 세 입장을 종합하여 단일 결론 생성
    let unifiedConclusion = '';
    try {
      unifiedConclusion = await this._synthesizeConclusion(debate.topic, finalPositions, isConsensus);
    } catch (e) {
      console.warn('[debate] Claude 결론 생성 실패, 폴백:', e.message);
      // 폴백: 단순 조합
      const names = Object.values(finalPositions).map(p => p.botName).join(', ');
      unifiedConclusion = `${names}의 논의를 종합하면, 이 주제에 대해 다양한 관점이 제시되었습니다.`;
    }

    return {
      topic: debate.topic,
      totalRounds: debate.rounds.length,
      stopReason,
      stopNote,
      isConsensus,
      unifiedConclusion,
      finalPositions,
      allSummaries: debate.rounds.map(r => ({
        round: r.number,
        summaries: r.summaries,
        evaluation: r.evaluation?.note,
      })),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Claude Haiku 심판 — 세 봇의 입장을 하나의 결론으로 종합
   */
  async _synthesizeConclusion(topic, finalPositions, isConsensus) {
    if (!anthropic) throw new Error('Anthropic API not configured');

    const positionTexts = Object.values(finalPositions)
      .map(p => `[${p.botName}]: ${p.position?.slice(0, 400)}`)
      .join('\n\n');

    const prompt = isConsensus
      ? `세 참여자가 합의에 도달한 토론입니다. 아래 입장들을 종합하여 **하나의 합의된 결론**을 3~5줄로 작성해.
참여자 의견을 나열하지 말고, 통합된 하나의 결론만 써.`
      : `세 참여자의 토론이 끝났지만 완전한 합의에는 도달하지 못했습니다. 아래 입장들을 종합하여 **공통점과 핵심 결론**을 3~5줄로 정리해.
참여자 의견을 나열하지 말고, 종합된 하나의 결론만 써.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: '너는 토론 심판이야. 여러 참여자의 의견을 하나의 통합된 결론으로 종합하는 역할이야. 간결하고 명확하게, 한국어로 작성해. 반드시 문장을 완성해서 끝내.',
      messages: [{
        role: 'user',
        content: `주제: "${topic}"\n\n${positionTexts}\n\n${prompt}`,
      }],
    });

    return response.content[0]?.text || '';
  }
}

module.exports = { DebateEngine, DEBATE_STATUS, BOT_ORDER, BOT_ROLES };
