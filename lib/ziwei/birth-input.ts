/**
 * 钟表时间 → 排盘日 + 时辰支。
 *
 * 这里是「真太阳时经度校正 + 晚子时换日」的唯一实现：
 *   · 表单（lib/ziwei/share.ts 的 formToBirthInfo）
 *   · 后端（/api/generate 的 clockHour/clockMinute 入参）
 * 都调用本模块，避免两条路径排出不同的盘。
 *
 * 口径与表单一致：只做经度修正（中央经线 120°），不含均时差；
 * 均时差版本见 true-solar-time.ts 的 calculateTrueSolarTime，不要混用。
 */

import {
  branchFromSolarMinutes,
  resolveZiweiDayOffset,
  shiftGregorianDate,
} from './true-solar-time';

export interface SolarClockInput {
  year: number;
  month: number;
  day: number;
  clockHour: number;
  clockMinute: number;
  /** 出生地经度；不传按 120°（北京时间中央经线）处理，等于不做经度修正。 */
  longitude?: number;
}

export interface ChartDate {
  year: number;
  month: number;
  day: number;
  /** 时辰地支索引 0-11（0=子） */
  hour: number;
}

/** 钟表时间 → 排盘日与时辰支（晚子时按次日排盘）。 */
export function solarClockToChartDate(input: SolarClockInput): ChartDate {
  const longitude = input.longitude ?? 120;
  const solar = input.clockHour * 60 + input.clockMinute + (longitude - 120) * 4;
  const normalizedMinutes = ((solar % 1440) + 1440) % 1440;
  const hour = branchFromSolarMinutes(normalizedMinutes);
  const dayOffset = resolveZiweiDayOffset({
    dayOffset: Math.floor(solar / 1440),
    normalizedMinutes,
    branch: hour,
  });
  const date = dayOffset !== 0
    ? shiftGregorianDate(input, dayOffset)
    : { year: input.year, month: input.month, day: input.day };
  return { ...date, hour };
}
