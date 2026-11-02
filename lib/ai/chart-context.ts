/**
 * 把 ZiweiChart 压成给 LLM 看的文本。只输出排盘事实，不做解读。
 *
 * 注意：这里只读我们自己的 generateChart 产物；/api/interpret 会用
 * chart.birthInfo 在服务端重新排盘，不直接信任客户端传来的星曜文本。
 */

import { BRANCHES, SHICHEN, STEMS } from '@/lib/ziwei/constants';
import type { Star, ZiweiChart } from '@/lib/ziwei/types';

function starText(star: Star): string {
  const brightness = star.brightnessRaw ? `(${star.brightnessRaw})` : '';
  const siHua = star.siHua ? `·化${star.siHua}` : '';
  return `${star.name}${brightness}${siHua}`;
}

function palaceStars(palace: ZiweiChart['palaces'][number]): string {
  const groups: Star['type'][] = ['major', 'lucky', 'sha', 'minor'];
  return groups
    .map((type) => palace.stars.filter((star) => star.type === type).map(starText).join('、'))
    .filter(Boolean)
    .join('；');
}

export function chartToContext(chart: ZiweiChart): string {
  const { birthInfo, lunarInfo } = chart;
  const gender = birthInfo.gender === 'male' ? '男' : '女';
  const hourName = SHICHEN[birthInfo.hour]?.name ?? `时辰支${birthInfo.hour}`;
  const place = [birthInfo.province, birthInfo.city].filter(Boolean).join(' ');

  const siHua: string[] = [];
  for (const palace of chart.palaces) {
    for (const star of palace.stars) {
      if (star.siHua) siHua.push(`${star.name}化${star.siHua}（${palace.name}）`);
    }
  }

  const palaceLines = chart.palaces.map((palace) => {
    const flags = [
      palace.isMingGong ? '命宫' : '',
      palace.isShenGong ? '身宫' : '',
      palace.isEmpty
        ? `空宫借${palace.borrowedFromName ?? '对宫'}（${(palace.borrowedStars ?? []).join('、')}）`
        : '',
    ].filter(Boolean).join('，');
    const daXian = palace.daXianAge ? `大限${palace.daXianAge[0]}-${palace.daXianAge[1]}` : '';
    const stars = palaceStars(palace);
    return `- ${BRANCHES[palace.branch]}宫 · ${palace.name}（${STEMS[palace.stem]}${BRANCHES[palace.branch]}`
      + `${daXian ? `，${daXian}` : ''}${flags ? `，${flags}` : ''}）：${stars || '无主星'}`;
  });

  const daXianLines = chart.daXians.map((daXian) => {
    const current = chart.currentDaXianIndex >= 0
      && chart.daXians[chart.currentDaXianIndex]?.startAge === daXian.startAge
      ? '（当前大限）'
      : '';
    return `${daXian.startAge}-${daXian.endAge}岁 ${daXian.palaceName}${current}`;
  });

  return [
    '【出生信息】',
    `- 公历：${birthInfo.year}-${birthInfo.month}-${birthInfo.day} ${hourName}，${gender}${place ? `，${place}` : ''}`,
    `- 农历：${lunarInfo.lunarYear}年${lunarInfo.isLeapMonth ? '闰' : ''}${lunarInfo.lunarMonth}月${lunarInfo.lunarDay}日`,
    lunarInfo.fourPillars
      ? `- 四柱（节气）：${lunarInfo.fourPillars.join(' ')}`
      : '',
    '',
    '【命盘基本信息】',
    `- ${chart.wuxingJuName}，${chart.yinYangGender ?? ''}`,
    `- 命宫在${BRANCHES[chart.mingGongBranch]}，身宫在${BRANCHES[chart.shenGongBranch]}`,
    `- 命主：${chart.mingZhu ?? '未知'}；身主：${chart.shenZhu ?? '未知'}；紫微在${BRANCHES[chart.ziweiPos]}`,
    `- 生年四化：${siHua.join('、') || '无'}`,
    `- 当前虚岁：${chart.currentAge}`,
    '',
    '【十二宫】',
    ...palaceLines,
    '',
    '【大限】',
    ...daXianLines,
  ].filter((line) => line !== '').join('\n');
}
