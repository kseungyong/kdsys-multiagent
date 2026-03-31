'use strict';

/**
 * shared-memory.js
 * KDSys MultiAgent - 집단 기억 (Shared Brain)
 *
 * 토론 결론, 인사이트, 실패 기록을 저장하고 검색.
 * /compact 후에도 결론은 별도 저장되어 연속성 유지.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = config.DATA_PATH;
const CONCLUSIONS_FILE = config.paths.conclusions;
const INSIGHTS_FILE = config.paths.insights;

// --- 파일 I/O ---

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJson(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- 토론 결론 관리 ---

/**
 * 토론 결론 저장
 */
function saveConclusion(debate) {
  const conclusions = loadJson(CONCLUSIONS_FILE, []);

  const entry = {
    id: debate.id,
    topic: debate.topic,
    totalRounds: debate.rounds?.length || 0,
    stopReason: debate.conclusion?.stopReason || 'unknown',
    stopNote: debate.conclusion?.stopNote || '',
    finalPositions: {},
    keywords: extractKeywords(debate.topic),
    timestamp: new Date().toISOString(),
    savedAt: Date.now(),
  };

  // 각 봇의 최종 입장 요약 (300자 이내)
  if (debate.conclusion?.finalPositions) {
    for (const [botId, pos] of Object.entries(debate.conclusion.finalPositions)) {
      entry.finalPositions[botId] = {
        botName: pos.botName,
        position: pos.position?.slice(0, 300) || '',
      };
    }
  }

  // 중복 방지 (같은 ID 업데이트)
  const idx = conclusions.findIndex(c => c.id === entry.id);
  if (idx >= 0) {
    conclusions[idx] = entry;
  } else {
    conclusions.push(entry);
  }

  // 최대 200개 유지 (오래된 것 삭제)
  if (conclusions.length > config.limits.maxConclusions) {
    conclusions.splice(0, conclusions.length - config.limits.maxConclusions);
  }

  saveJson(CONCLUSIONS_FILE, conclusions);
  return entry;
}

/**
 * 주제 관련 과거 결론 검색 (키워드 매칭)
 */
function searchConclusions(query, { limit = 5 } = {}) {
  const conclusions = loadJson(CONCLUSIONS_FILE, []);
  if (conclusions.length === 0) return [];

  const queryKeywords = extractKeywords(query);
  if (queryKeywords.length === 0) {
    // 키워드 없으면 최신순
    return conclusions.slice(-limit).reverse();
  }

  // 키워드 매칭 점수 계산
  const scored = conclusions.map(c => {
    const topicKeywords = c.keywords || extractKeywords(c.topic);
    const overlap = queryKeywords.filter(k => topicKeywords.includes(k)).length;
    const score = overlap / Math.max(queryKeywords.length, 1);
    return { ...c, relevanceScore: score };
  });

  return scored
    .filter(c => c.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.savedAt - a.savedAt)
    .slice(0, limit);
}

/**
 * 모든 결론 조회
 */
function getAllConclusions({ limit = 50 } = {}) {
  const conclusions = loadJson(CONCLUSIONS_FILE, []);
  return conclusions.slice(-limit).reverse();
}

/**
 * 결론 삭제
 */
function deleteConclusion(id) {
  const conclusions = loadJson(CONCLUSIONS_FILE, []);
  const filtered = conclusions.filter(c => c.id !== id);
  saveJson(CONCLUSIONS_FILE, filtered);
  return filtered.length < conclusions.length;
}

// --- 인사이트 관리 ---

/**
 * 인사이트 저장 (토론에서 도출된 개별 교훈)
 */
function saveInsight({ content, source, tags = [] }) {
  const insights = loadJson(INSIGHTS_FILE, []);
  const entry = {
    id: require('crypto').randomUUID(),
    content: content.slice(0, 500),
    source, // debateId or 'manual'
    tags,
    keywords: extractKeywords(content),
    timestamp: new Date().toISOString(),
    savedAt: Date.now(),
  };

  insights.push(entry);

  // 최대 500개
  if (insights.length > config.limits.maxInsights) {
    insights.splice(0, insights.length - config.limits.maxInsights);
  }

  saveJson(INSIGHTS_FILE, insights);
  return entry;
}

/**
 * 인사이트 검색
 */
function searchInsights(query, { limit = 5 } = {}) {
  const insights = loadJson(INSIGHTS_FILE, []);
  if (insights.length === 0) return [];

  const queryKeywords = extractKeywords(query);
  if (queryKeywords.length === 0) {
    return insights.slice(-limit).reverse();
  }

  const scored = insights.map(ins => {
    const kws = ins.keywords || extractKeywords(ins.content);
    const overlap = queryKeywords.filter(k => kws.includes(k)).length;
    const score = overlap / Math.max(queryKeywords.length, 1);
    return { ...ins, relevanceScore: score };
  });

  return scored
    .filter(i => i.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || b.savedAt - a.savedAt)
    .slice(0, limit);
}

// --- 컨텍스트 빌더 (토론 엔진용) ---

/**
 * 토론 시작 시 주입할 관련 과거 컨텍스트 생성
 */
function buildPriorContext(topic, { maxLen = 600 } = {}) {
  const related = searchConclusions(topic, { limit: 3 });
  if (related.length === 0) return '';

  const lines = ['[관련 과거 토론 결론]'];
  for (const c of related) {
    lines.push(`\n주제: "${c.topic}" (${c.totalRounds}라운드, ${c.stopNote})`);
    for (const [botId, pos] of Object.entries(c.finalPositions || {})) {
      lines.push(`  - ${pos.botName}: ${pos.position.slice(0, 100)}`);
    }
  }

  let result = lines.join('\n');
  if (result.length > maxLen) {
    result = result.slice(0, maxLen) + '\n...';
  }
  return result;
}

// --- 유틸리티 ---

/**
 * 간단한 키워드 추출 (한국어 + 영어)
 * 불용어 제거, 2글자 이상만
 */
function extractKeywords(text) {
  if (!text) return [];

  const stopWords = new Set([
    // 한국어 불용어
    '이', '그', '저', '것', '수', '를', '에', '의', '가', '은', '는', '들',
    '에서', '으로', '하고', '이다', '있다', '없다', '하는', '하다', '그리고',
    '또는', '하지만', '그래서', '때문에', '위해', '대해', '관해', '통해',
    '무엇', '어떻게', '왜', '누가', '어디', '언제', '얼마나',
    // 영어 불용어
    'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'and', 'but', 'or',
    'not', 'no', 'yes', 'this', 'that', 'these', 'those', 'for',
    'with', 'from', 'about', 'into', 'what', 'how', 'why', 'when',
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\sㄱ-ㅎ가-힣]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stopWords.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // 중복 제거
}

module.exports = {
  saveConclusion,
  searchConclusions,
  getAllConclusions,
  deleteConclusion,
  saveInsight,
  searchInsights,
  buildPriorContext,
  extractKeywords,
};
