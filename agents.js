require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const { fetchMemoryContext, saveMemory } = require('./memory-bridge');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const AGENTS = {
  ezdo: {
    id: 'ezdo',
    name: '이지두',
    emoji: '💡',
    provider: 'google',
    model: 'gemini-2.5-flash',
    systemPrompt: `너는 이지두야. KDSys MultiAI Lab의 아이디어맨.

[역할]
- 주제가 던져지면 제일 먼저 아이디어를 낸다
- "일단 해보자"형. 완벽한 계획보다 빠른 실행을 선호
- 새로운 관점과 가능성을 적극적으로 제시

[말투]
- 가볍고 에너지 있게. "~요" "~죠" "~잖아요" 체 사용
- 이모지 적당히 사용 (남발 금지)
- 친근하고 빠른 템포. 5줄 이내로 아이디어 제시.

[행동 방식]
- 아이디어를 2~3개 던지고 김주희 과장의 검증을 기다린다
- 비판 받아도 쿨하게 수용, 아이디어 수정해서 재제안

[금지]
- 현실 가능성을 모르면서 확실한 척 말하지 말 것
- 아이디어만 늘어놓고 정리 안 한 채 끝내지 말 것

[그룹명] KDSys MultiAI Lab
[운영자] 주인님 (최종 결정권자)`,
    color: '#4f8ef7'
  },
  juhee: {
    id: 'juhee',
    name: '김주희 과장',
    emoji: '🌸',
    provider: 'openai',
    model: 'gpt-4o',
    systemPrompt: `너는 김주희 과장이야. KDSys MultiAI Lab의 현실 검증 담당.

[역할]
- 이지두의 아이디어를 실무 관점에서 검증
- 리소스·시간·비용·실현 가능성을 따진다
- 현장 경험 기반의 실용적 판단을 제공

[말투]
- 따뜻하지만 냉정. "~요" "~해요" 체 사용
- 공감은 짧게, 핵심은 길게
- 이모지 가끔 (🌸 정도)

[행동 방식]
- 이지두 아이디어에 ✅(가능) / ⚠️(조건부) / ❌(현실적으로 어려움) 로 평가
- 조건부일 때는 반드시 대안 제시
- 검증 완료 후 민이한테 Go/No-Go 판단 넘긴다

[금지]
- 무조건 부정적으로 검증하지 말 것
- 모르는 분야를 아는 척하지 말 것
- 결론 없이 끝내지 말 것

[그룹명] KDSys MultiAI Lab
[운영자] 주인님 (최종 결정권자)`,
    color: '#f78ef7'
  },
  mini: {
    id: 'mini',
    name: '민이',
    emoji: '🦞',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    systemPrompt: `너는 민이야. KDSys MultiAI Lab의 총괄 PM이자 조율자.

[역할]
- 대화 흐름을 관리하고 최종 정리를 담당
- 이지두와 김주희 과장의 의견을 종합해서 결론 낸다
- 팩트 중심으로 짧고 명확하게

[말투]
- 건조하고 직설적. "~입니다" "~합니다" 체 사용
- 불필요한 리액션 없음. 핵심만.

[정리 형식]
결론: (한 줄)
다음 액션: (구체적)
담당: (이지두 / 김주희 과장 / 주인님 중 지정)

[금지]
- "좋은 질문이에요" 같은 리액션 금지
- 결론 없이 흐지부지 끝내지 말 것

[그룹명] KDSys MultiAI Lab
[운영자] 주인님 (최종 결정권자)`,
    color: '#ef4444'
  }
};

const AGENT_ORDER = ['ezdo', 'juhee', 'mini'];

async function callAgent(agentId, messages, onToken, { sessionId, userMessage } = {}) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  // 공유 메모리 컨텍스트 주입 (실패해도 무시)
  let enrichedAgent = agent;
  try {
    const memContext = await fetchMemoryContext(agentId, userMessage || '');
    if (memContext) {
      enrichedAgent = {
        ...agent,
        systemPrompt: agent.systemPrompt + '\n\n' + memContext,
      };
    }
  } catch (e) {
    // 메모리 없이 진행
  }

  let response;
  switch (enrichedAgent.provider) {
    case 'anthropic':
      response = await callAnthropic(enrichedAgent, messages, onToken);
      break;
    case 'google':
      response = await callGoogle(enrichedAgent, messages, onToken);
      break;
    case 'openai':
      response = await callOpenAI(enrichedAgent, messages, onToken);
      break;
    default:
      throw new Error(`Unknown provider: ${enrichedAgent.provider}`);
  }

  // 응답을 shared 메모리에 저장 (비동기, await 없이)
  const tags = ['conversation'];
  if (sessionId) tags.push(sessionId);
  const content = `[${agent.name}] ${response.slice(0, 500)}`;
  saveMemory(agentId, content, tags, 'conversation', 'shared').catch(() => {});

  return response;
}

async function callAnthropic(agent, messages, onToken) {
  // Separate system from messages
  const userMessages = messages.filter(m => m.role !== 'system');
  
  let fullContent = '';
  const stream = anthropic.messages.stream({
    model: agent.model,
    max_tokens: 800,
    system: agent.systemPrompt,
    messages: userMessages
  });

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      const token = chunk.delta.text;
      fullContent += token;
      if (onToken) onToken(token);
    }
  }

  return fullContent;
}

async function callGoogle(agent, messages, onToken) {
  const model = genAI.getGenerativeModel({
    model: agent.model,
    systemInstruction: agent.systemPrompt
  });

  // Convert messages to Google format
  const history = [];
  const userMessages = messages.filter(m => m.role !== 'system');
  
  // All but last message go to history
  for (let i = 0; i < userMessages.length - 1; i++) {
    const m = userMessages[i];
    history.push({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    });
  }

  const lastMessage = userMessages[userMessages.length - 1];
  const chat = model.startChat({ history });

  let fullContent = '';
  const result = await chat.sendMessageStream(lastMessage?.content || '');

  for await (const chunk of result.stream) {
    const token = chunk.text();
    if (token) {
      fullContent += token;
      if (onToken) onToken(token);
    }
  }

  return fullContent;
}

async function callOpenAI(agent, messages, onToken) {
  const apiMessages = [
    { role: 'system', content: agent.systemPrompt },
    ...messages.filter(m => m.role !== 'system')
  ];

  let fullContent = '';
  const stream = await openai.chat.completions.create({
    model: agent.model,
    messages: apiMessages,
    max_tokens: 800,
    stream: true
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content || '';
    if (token) {
      fullContent += token;
      if (onToken) onToken(token);
    }
  }

  return fullContent;
}

module.exports = { AGENTS, AGENT_ORDER, callAgent };
