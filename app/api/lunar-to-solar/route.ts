/**
 * POST /api/lunar-to-solar —— 农历日期转公历，供排盘前使用。
 *
 * 入参：{ year, month: 1-12, day: 1-30, isLeapMonth?: boolean }
 * 返回：{ solar: { year, month, day } }
 *
 * 非法农历日期（年份越界 / 闰月不存在 / 当月没这天）一律 400，绝不静默顺延。
 */

import {
  LUNAR_YEAR_MAX,
  LUNAR_YEAR_MIN,
  isValidLunarDate,
  lunarToSolar,
} from '@/lib/ziwei/lunar-solar';

export const runtime = 'nodejs';

interface FieldError {
  field: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonError(status: number, code: string, message: string, fields?: FieldError[]): Response {
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
  if (!isRecord(body)) {
    return jsonError(400, 'invalid_request', '请求体必须是 JSON 对象');
  }

  const errors: FieldError[] = [];
  const intField = (field: string, min: number, max: number): number | undefined => {
    const value = body[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      errors.push({ field, message: `${field} 必须是 ${min}-${max} 之间的整数` });
      return undefined;
    }
    return value;
  };

  const year = intField('year', LUNAR_YEAR_MIN, LUNAR_YEAR_MAX);
  const month = intField('month', 1, 12);
  const day = intField('day', 1, 30);

  let isLeapMonth = false;
  if (body.isLeapMonth !== undefined) {
    if (typeof body.isLeapMonth !== 'boolean') {
      errors.push({ field: 'isLeapMonth', message: 'isLeapMonth 必须是布尔值' });
    } else {
      isLeapMonth = body.isLeapMonth;
    }
  }

  if (errors.length > 0) return jsonError(400, 'invalid_request', '农历日期校验失败', errors);

  if (!isValidLunarDate(year!, month!, day!, isLeapMonth)) {
    return jsonError(400, 'invalid_lunar_date', '农历日期不存在（闰月或当月天数不匹配）', [
      { field: 'day', message: `${year} 年${isLeapMonth ? '闰' : ''}${month} 月没有第 ${day} 天` },
    ]);
  }

  const solar = lunarToSolar(year!, month!, day!, isLeapMonth);
  if (!solar) {
    return jsonError(400, 'invalid_lunar_date', '农历日期换算失败');
  }

  return Response.json({ solar }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
