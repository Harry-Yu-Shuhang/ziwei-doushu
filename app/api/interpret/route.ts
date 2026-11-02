/**
 * POST /api/interpret —— AI 命盘解读（SSE 流式）。
 *
 * 入参（与 components/InsightPanel.tsx、ChatPanel.tsx 对齐）：
 *   { chart: ZiweiChart, messages: [{ role: 'user' | 'assistant', content: string }] }
 *
 * 安全与一致性：
 *   · 不直接信任客户端传来的星曜文本；只取 chart.birthInfo，用本仓库引擎重新排盘。
 *   · 模型走 OpenAI 兼容协议，供应商由 lib/ai/config.ts 按环境变量选择。
 *
 * 出参：SSE，每行 data: {"delta":{"text":"..."}}，结束时 data: [DONE]。
 */

import { generateChart } from '@/lib/ziwei/algorithm';
import { parseGenerateRequest } from '@/lib/api/generate-request';
import { getAiConfig, chatCompletionsUrl } from '@/lib/ai/config';
import { chartToContext } from '@/lib/ai/chart-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;

const SYSTEM_PROMPT = `你是「倪海厦《天纪》紫微斗数」体系的命盘解读师，为命主解读一张已经排好的紫微斗数命盘。

【硬性规则】
1. 只使用给出的命盘数据：星曜、宫位、亮度、四化、大限、命主/身主、五行局。盘上没有的信息不要编造。
2. 以三合派／倪海厦体系为主：命宫、身宫、三方四正、生年四化、空宫借对宫。不要用飞星派宫干自化。
3. 先说结论，再说依据；每条判断都要落到具体星曜与宫位，避免空泛套话。
4. 健康、投资、法律等话题只谈倾向与注意事项，不做确定性承诺或诊断。
5. 使用简体中文。小节标题必须单独成行，格式为 **【小节名】**。不要输出与命盘无关的寒暄、免责声明或重复命盘原文。
6. 除非用户明确要求展开，整体解读控制在 900-1400 字。
7. 用户问题与命盘无关时，礼貌说明你只解读命盘相关内容。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

function parseMessages(input: unknown): { ok: true; value: ChatMessage[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: 'messages 必须是非空数组' };
  }
  if (input.length > MAX_MESSAGES) {
    return { ok: false, message: `messages 不能超过 ${MAX_MESSAGES} 条` };
  }

  const messages: ChatMessage[] = [];
  let total = 0;
  for (const item of input) {
    if (!isRecord(item)) return { ok: false, message: 'messages 每项必须是对象' };
    const role = item.role;
    if (role !== 'user' && role !== 'assistant') {
      return { ok: false, message: "messages[].role 只能是 'user' 或 'assistant'" };
    }
    if (typeof item.content !== 'string') {
      return { ok: false, message: 'messages[].content 必须是字符串' };
    }
    const content = item.content.trim();
    if (!content) continue;
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, message: `单条消息不能超过 ${MAX_MESSAGE_CHARS} 字` };
    }
    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      return { ok: false, message: `消息总长度不能超过 ${MAX_TOTAL_CHARS} 字` };
    }
    messages.push({ role, content });
  }

  if (!messages.some((message) => message.role === 'user')) {
    return { ok: false, message: '至少需要一条 user 消息' };
  }
  return { ok: true, value: messages };
}

/** 从客户端 chart.birthInfo 重建命盘，避免信任客户端拼出来的星曜。 */
function rebuildChart(chart: unknown): ReturnType<typeof generateChart> | null {
  if (!isRecord(chart) || !isRecord(chart.birthInfo)) return null;
  const birthInfo = chart.birthInfo;
  const parsed = parseGenerateRequest({
    ...birthInfo,
    leapMonth: birthInfo.leapMonthPolicy,
  });
  if (!parsed.ok) return null;
  try {
    return generateChart(parsed.value.birthInfo, { leapMonth: parsed.value.leapMonth });
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid_json', '请求体必须是合法 JSON');
  }
  if (!isRecord(body)) {
    return jsonError(400, 'invalid_request', '请求体必须是 JSON 对象');
  }

  const messages = parseMessages(body.messages);
  if (!messages.ok) {
    return jsonError(400, 'invalid_request', messages.message);
  }

  const chart = rebuildChart(body.chart);
  if (!chart) {
    return jsonError(400, 'invalid_chart', 'chart.birthInfo 缺失或不是合法的出生信息');
  }

  const config = getAiConfig();
  if (!config) {
    return jsonError(
      503,
      'ai_not_configured',
      '未配置 AI 模型：请设置 AI_PROVIDER 与对应的 API Key（如 DEEPSEEK_API_KEY）',
    );
  }

  const upstreamPayload: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\n${chartToContext(chart)}` },
      ...messages.value,
    ],
    stream: true,
    // 思考模式的 reasoning 也计入 max_tokens，留足空间避免正文被截断
    max_tokens: 16384,
  };
  // DeepSeek V4 默认开启思考模式；显式写出来，避免不同 SDK/网关的默认值不一致。
  if (config.provider === 'deepseek') {
    upstreamPayload.thinking = { type: 'enabled' };
  }

  let upstream: Response;
  try {
    upstream = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(upstreamPayload),
      signal: request.signal,
    });
  } catch (error) {
    console.error('[api/interpret] 上游请求失败', error);
    return jsonError(502, 'upstream_unreachable', 'AI 服务连接失败');
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[api/interpret] 上游返回 ${upstream.status}: ${detail.slice(0, 500)}`);
    return jsonError(502, 'upstream_error', `AI 服务返回 ${upstream.status}`);
  }

  const encoder = new TextEncoder();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (cancelled) return false;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };
      // 前端按字面量 data: [DONE] 判定流结束，不能再套一层 JSON.stringify
      const sendDone = () => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch {
          cancelled = true;
        }
      };
      const close = () => {
        try { controller.close(); } catch { /* already closed/cancelled */ }
      };

      let buffer = '';
      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const rawLine of lines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              sendDone();
              close();
              return;
            }
            try {
              const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
              const text = parsed.choices?.[0]?.delta?.content;
              if (typeof text === 'string' && text.length > 0) {
                if (!send({ delta: { text } })) return;
              }
            } catch {
              // 忽略上游的非 JSON 心跳/空行
            }
          }
        }
        sendDone();
        close();
      } catch (error) {
        if (!cancelled) {
          console.error('[api/interpret] 流式转发失败', error);
          send({ error: { code: 'stream_failed', message: 'AI 流式响应中断' } });
          close();
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    },
    cancel() {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
