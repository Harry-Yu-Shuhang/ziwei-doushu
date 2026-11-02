/**
 * POST /api/generate 的入参校验与归一化。
 *
 * 支持两种出生时间写法（二选一）：
 *   · hour：已换算好的时辰地支索引 0-11（0=子）
 *   · clockHour + clockMinute (+ longitude)：钟表时间，由后端按真太阳时换算，
 *     并与表单共用 lib/ziwei/birth-input.ts 的同一套晚子时换日规则。
 *
 * 校验与排盘分开：这里只保证字段合法、日期真实存在，不调用排盘引擎。
 */

import type { BirthInfo } from '@/lib/ziwei/types';
import { DEFAULT_LEAP_MONTH, type LeapMonth } from '@/lib/ziwei/school-config';
import { LUNAR_YEAR_MIN, LUNAR_YEAR_MAX } from '@/lib/ziwei/lunar-solar';
import { isValidGregorianDate } from '@/lib/ziwei/true-solar-time';
import { solarClockToChartDate } from '@/lib/ziwei/birth-input';

export const LEAP_MONTH_POLICIES: readonly LeapMonth[] = [
  'split',
  'next-month',
  'prev-month',
  'origin-month',
];

export interface GenerateRequest {
  birthInfo: BirthInfo;
  leapMonth: LeapMonth;
}

export interface ApiFieldError {
  field: string;
  message: string;
}

export type ParseResult =
  | { ok: true; value: GenerateRequest }
  | { ok: false; errors: ApiFieldError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireInt(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  errors: ApiFieldError[],
): number | undefined {
  const value = body[field];
  if (value === undefined) {
    errors.push({ field, message: `${field} 必填` });
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push({ field, message: `${field} 必须是 ${min}-${max} 之间的整数` });
    return undefined;
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  errors: ApiFieldError[],
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push({ field, message: `${field} 必须是字符串` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    errors.push({ field, message: `${field} 不能超过 ${maxLength} 个字符` });
    return undefined;
  }
  return trimmed || undefined;
}

export function parseGenerateRequest(input: unknown): ParseResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ field: 'body', message: '请求体必须是 JSON 对象' }] };
  }

  const errors: ApiFieldError[] = [];
  const year = requireInt(input, 'year', LUNAR_YEAR_MIN, LUNAR_YEAR_MAX, errors);
  const month = requireInt(input, 'month', 1, 12, errors);
  const day = requireInt(input, 'day', 1, 31, errors);

  if (year !== undefined && month !== undefined && day !== undefined && !isValidGregorianDate(year, month, day)) {
    errors.push({ field: 'day', message: '公历日期不存在' });
  }

  const gender = input.gender;
  if (gender !== 'male' && gender !== 'female') {
    errors.push({ field: 'gender', message: "gender 必须是 'male' 或 'female'" });
  }

  // ── 时辰：hour 与 clockHour/clockMinute 二选一 ──
  const hasHour = input.hour !== undefined;
  const hasClock = input.clockHour !== undefined || input.clockMinute !== undefined;
  let hour: number | undefined;
  let clock: { clockHour: number; clockMinute: number } | undefined;
  if (hasHour && hasClock) {
    errors.push({ field: 'hour', message: 'hour 与 clockHour/clockMinute 只能二选一' });
  } else if (hasHour) {
    hour = requireInt(input, 'hour', 0, 11, errors);
  } else if (hasClock) {
    const clockHour = requireInt(input, 'clockHour', 0, 23, errors);
    const clockMinute = requireInt(input, 'clockMinute', 0, 59, errors);
    if (clockHour !== undefined && clockMinute !== undefined) {
      clock = { clockHour, clockMinute };
    }
  } else {
    errors.push({
      field: 'hour',
      message: 'hour（时辰支 0-11）或 clockHour + clockMinute 必填其一',
    });
  }

  let longitude: number | undefined;
  if (input.longitude !== undefined) {
    if (
      typeof input.longitude !== 'number' ||
      !Number.isFinite(input.longitude) ||
      input.longitude < -180 ||
      input.longitude > 180
    ) {
      errors.push({ field: 'longitude', message: 'longitude 必须是 -180 到 180 之间的数字' });
    } else {
      longitude = input.longitude;
    }
  }

  const name = optionalString(input, 'name', 50, errors);
  const province = optionalString(input, 'province', 50, errors);
  const city = optionalString(input, 'city', 50, errors);

  let leapMonth: LeapMonth = DEFAULT_LEAP_MONTH;
  if (input.leapMonth !== undefined) {
    if (
      typeof input.leapMonth !== 'string' ||
      !LEAP_MONTH_POLICIES.includes(input.leapMonth as LeapMonth)
    ) {
      errors.push({
        field: 'leapMonth',
        message: `leapMonth 必须是 ${LEAP_MONTH_POLICIES.join(' / ')} 之一`,
      });
    } else {
      leapMonth = input.leapMonth as LeapMonth;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // 上面的校验已保证这些值存在
  let chartDate = { year: year!, month: month!, day: day!, hour: hour! };
  let origInput: BirthInfo['origInput'];
  if (clock) {
    chartDate = solarClockToChartDate({
      year: year!,
      month: month!,
      day: day!,
      clockHour: clock.clockHour,
      clockMinute: clock.clockMinute,
      longitude,
    });
    origInput = {
      year: year!,
      month: month!,
      day: day!,
      clockHour: clock.clockHour,
      clockMinute: clock.clockMinute,
    };
  }

  // 晚子时/经度换日可能把排盘日推出受理区间
  if (chartDate.year < LUNAR_YEAR_MIN || chartDate.year > LUNAR_YEAR_MAX) {
    return {
      ok: false,
      errors: [{
        field: 'year',
        message: `按真太阳时与晚子时换日后超出 ${LUNAR_YEAR_MIN}-${LUNAR_YEAR_MAX} 年受理区间`,
      }],
    };
  }

  return {
    ok: true,
    value: {
      birthInfo: {
        ...chartDate,
        gender: gender as 'male' | 'female',
        name,
        province,
        city,
        longitude,
        origInput,
      },
      leapMonth,
    },
  };
}
