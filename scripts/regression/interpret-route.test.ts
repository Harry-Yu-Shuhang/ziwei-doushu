/**
 * /api/interpret 回归：
 *   1. 用 birthInfo 在服务端重新排盘，再把命盘上下文交给模型；
 *   2. 上游 OpenAI 兼容 SSE（含跨 chunk 的半行）被正确转成前端约定的
 *      data: {"delta":{"text":"..."}} + data: [DONE]；
 *   3. 非法入参与未配置 Key 分别返回 400 / 503。
 */
import assert from 'node:assert/strict';
import { generateChart } from '../../lib/ziwei/algorithm';
import { POST as interpretPOST } from '../../app/api/interpret/route';

const chart = generateChart({
  year: 2002, month: 4, day: 30, hour: 8, gender: 'male',
  province: '山东省', city: '青岛市', longitude: 120.4,
});

function request(body: unknown): Request {
  return new Request('http://localhost/api/interpret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function upstreamChunks(): string[] {
  const events = [
    { choices: [{ delta: { reasoning_content: '先看命宫…' } }] },
    { choices: [{ delta: { content: '【命格】\n' } }] },
    { choices: [{ delta: { content: '命宫空宫借天同天梁。' } }] },
    { choices: [{ delta: { content: '\n\n【事业】\n身宫落官禄。' } }] },
  ];
  return [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ];
}

async function main() {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  };

  process.env.AI_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'test-key';
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
  process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';

  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    const encoder = new TextEncoder();
    const chunks = upstreamChunks();
    // 故意在 JSON 中间切开，验证跨 chunk 的半行会被拼回来
    const first = chunks[0].slice(0, 37);
    const rest = chunks[0].slice(37) + chunks.slice(1).join('');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first));
        controller.enqueue(encoder.encode(rest));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;

  try {
    const res = await interpretPOST(request({
      chart,
      messages: [{ role: 'user', content: '请给我完整解读' }],
    }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const body = await res.text();
    const deltas = body
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line.slice(6) !== '[DONE]')
      .map((line) => JSON.parse(line.slice(6)).delta.text)
      .join('');
    assert.equal(deltas, '【命格】\n命宫空宫借天同天梁。\n\n【事业】\n身宫落官禄。');
    assert.ok(body.includes('data: [DONE]'), '流结束必须发 [DONE]');

    // 上游请求：模型、SSE、思考模式、命盘上下文
    assert.equal(captured!.url, 'https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(String(captured!.init.body));
    assert.equal(payload.model, 'deepseek-v4-pro');
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.thinking, { type: 'enabled' });
    assert.equal(payload.messages[0].role, 'system');
    assert.match(payload.messages[0].content, /命宫在申/);
    assert.match(payload.messages[0].content, /【十二宫】/);
    assert.doesNotMatch(payload.messages[0].content, /先看命宫/, 'reasoning_content 不应回灌到上下文');
    assert.deepEqual(payload.messages[1], { role: 'user', content: '请给我完整解读' });

    // ── 非法入参 ──────────────────────────────────────────────
    for (const [label, body, code] of [
      ['缺 chart', { messages: [{ role: 'user', content: 'hi' }] }, 'invalid_chart'],
      ['空 messages', { chart, messages: [] }, 'invalid_request'],
      ['system 角色', { chart, messages: [{ role: 'system', content: 'hi' }] }, 'invalid_request'],
    ] as const) {
      const bad = await interpretPOST(request(body));
      assert.equal(bad.status, 400, `${label} 应返回 400`);
      assert.equal((await bad.json()).error.code, code, `${label} 错误码`);
    }

    // ── 未配置 Key ────────────────────────────────────────────
    delete process.env.AI_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
    const unconfigured = await interpretPOST(request({
      chart,
      messages: [{ role: 'user', content: 'hi' }],
    }));
    assert.equal(unconfigured.status, 503);
    assert.equal((await unconfigured.json()).error.code, 'ai_not_configured');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('✅ AI 解读接口：服务端重排、SSE 转发、半行拼接、错误码均正确');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
