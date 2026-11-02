/**
 * POST /api/generate —— 服务端排盘。
 *
 * 入参见 lib/api/generate-request.ts：支持
 *   · { year, month, day, hour: 0-11, gender, ... }
 *   · { year, month, day, clockHour, clockMinute, longitude?, gender, ... }
 * 两种写法二选一。返回 { chart: ZiweiChart }。
 *
 * 排盘本身不调用任何 AI，也不需要 API Key。
 */

import { generateChart } from '@/lib/ziwei/algorithm';
import {
  parseGenerateRequest,
  type ApiFieldError,
} from '@/lib/api/generate-request';

export const runtime = 'nodejs';

function jsonError(
  status: number,
  code: string,
  message: string,
  fields?: ApiFieldError[],
): Response {
  return Response.json(
    { error: { code, message, ...(fields && fields.length > 0 ? { fields } : {}) } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid_json', '请求体必须是合法 JSON');
  }

  const parsed = parseGenerateRequest(body);
  if (!parsed.ok) {
    return jsonError(400, 'invalid_request', '出生信息校验失败', parsed.errors);
  }

  try {
    const chart = generateChart(parsed.value.birthInfo, {
      leapMonth: parsed.value.leapMonth,
    });
    return Response.json(
      { chart },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonError(400, 'invalid_birth_info', error.message);
    }
    console.error('[api/generate] 排盘失败', error);
    return jsonError(500, 'chart_generation_failed', '排盘失败，请稍后重试');
  }
}
