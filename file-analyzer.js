'use strict';

/**
 * file-analyzer.js
 * 파일을 분석하고 요약하여 토론 컨텍스트용 텍스트 생성.
 * 파일 원문은 1회만 읽고, 봇들에겐 요약만 전달.
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

let anthropic;
try {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} catch (e) {
  anthropic = null;
}

// 지원 파일 타입
const SUPPORTED_TYPES = {
  // 텍스트 기반
  '.txt': 'text',
  '.md': 'text',
  '.csv': 'text',
  '.json': 'text',
  '.js': 'code',
  '.ts': 'code',
  '.py': 'code',
  '.html': 'code',
  '.css': 'code',
  '.yaml': 'text',
  '.yml': 'text',
  '.xml': 'text',
  '.log': 'text',
  // PDF
  '.pdf': 'pdf',
  // 이미지 (Claude Vision)
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
};

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 파일 분석 + 요약 (메인 함수)
 * @returns {{ summary: string, fileType: string, fileName: string, originalSize: number }}
 */
async function analyzeFile(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const fileType = SUPPORTED_TYPES[ext];

  if (!fileType) {
    throw new Error(`지원하지 않는 파일 형식: ${ext}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > 10 * 1024 * 1024) {
    throw new Error('파일 크기 제한: 최대 10MB');
  }

  let rawText = '';
  let isImage = false;

  switch (fileType) {
    case 'text':
    case 'code':
      rawText = fs.readFileSync(filePath, 'utf8');
      // 너무 길면 앞뒤만
      if (rawText.length > 15000) {
        rawText = rawText.slice(0, 10000) + '\n\n... (중략) ...\n\n' + rawText.slice(-3000);
      }
      break;

    case 'pdf':
      rawText = await extractPdfText(filePath);
      if (rawText.length > 15000) {
        rawText = rawText.slice(0, 10000) + '\n\n... (중략) ...\n\n' + rawText.slice(-3000);
      }
      break;

    case 'image':
      isImage = true;
      break;
  }

  // Claude Haiku로 요약
  let summary;
  if (isImage) {
    summary = await analyzeImage(filePath, ext, originalName);
  } else {
    summary = await summarizeContent(rawText, originalName, fileType);
  }

  return {
    summary,
    fileType,
    fileName: originalName || path.basename(filePath),
    originalSize: stat.size,
    ext,
  };
}

/**
 * 텍스트/코드/PDF 내용을 Claude로 요약
 */
async function summarizeContent(text, fileName, fileType) {
  if (!text || text.trim().length === 0) {
    return `[${fileName}] 파일 내용이 비어있습니다.`;
  }

  // 짧은 파일은 요약 불필요
  if (text.length < 500) {
    return `[${fileName}] 내용:\n${text}`;
  }

  if (!anthropic) {
    // API 없으면 규칙 기반 추출
    const lines = text.split('\n').filter(l => l.trim()).slice(0, 20);
    return `[${fileName}] 주요 내용 (${text.length}자):\n${lines.join('\n').slice(0, 800)}`;
  }

  const typeLabel = fileType === 'code' ? '코드 파일' : fileType === 'pdf' ? 'PDF 문서' : '텍스트 파일';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system: `너는 파일 분석 전문가야. 주어진 ${typeLabel}의 핵심 내용을 5줄 이내로 요약해.
구체적인 수치, 핵심 주장, 주요 항목을 포함해. 한국어로 작성. 반드시 문장을 완성해서 끝내.`,
    messages: [{
      role: 'user',
      content: `파일명: ${fileName}\n\n내용:\n${text.slice(0, 12000)}`,
    }],
  });

  const summary = response.content[0]?.text || '';
  return `[${fileName}] ${summary}`;
}

/**
 * 이미지를 Claude Vision으로 분석
 */
async function analyzeImage(filePath, ext, fileName) {
  if (!anthropic) {
    return `[${fileName}] 이미지 파일 (분석하려면 Anthropic API 키 필요)`;
  }

  const imageData = fs.readFileSync(filePath);
  const base64 = imageData.toString('base64');
  const mediaType = IMAGE_MEDIA_TYPES[ext] || 'image/png';

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 500,
    system: '이미지의 핵심 내용을 5줄 이내로 설명해. 텍스트, 차트, 다이어그램이 있으면 핵심 데이터를 추출해. 한국어로.',
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `이 이미지(${fileName})의 핵심 내용을 요약해주세요.`,
        },
      ],
    }],
  });

  const summary = response.content[0]?.text || '';
  return `[${fileName}] ${summary}`;
}

/**
 * PDF 텍스트 추출
 */
async function extractPdfText(filePath) {
  try {
    const pdfParse = require('pdf-parse-new');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (e) {
    return `(PDF 텍스트 추출 실패: ${e.message})`;
  }
}

module.exports = { analyzeFile, SUPPORTED_TYPES };
