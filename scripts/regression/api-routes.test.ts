/**
 * 排盘后端回归：POST /api/generate + POST /api/lunar-to-solar
 *
 * 钉住：
 *   1. 直接传时辰支（hour）能排出完整命盘；
 *   2. 传钟表时间（clockHour/clockMinute + longitude）由后端换算，
 *      结果与表单 formToBirthInfo 同一口径（含晚子时换日）；
 *   3. 非法公历日期、越界年份、二义性入参都返回 400，而不是排出错盘；
 *   4. 农历转公历对不存在的闰月/日期返回 400。
 */
import assert from 'node:assert/strict';
import { POST as generatePOST } from '../../app/api/generate/route';
import { POST as lunarToSolarPOST } from '../../app/api/lunar-to-solar/route';

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const generate = (body: unknown) => generatePOST(post('http://localhost/api/generate', body));
const lunar = (body: unknown) => lunarToSolarPOST(post('http://localhost/api/lunar-to-solar', body));

async function main() {
  // ── 1) 直接传时辰支 ──────────────────────────────────────────
  const directRes = await generate({
    year: 2002, month: 4, day: 30, hour: 8, gender: 'male',
    name: '张三', province: '山东省', city: '青岛市', longitude: 120.4,
  });
  assert.equal(directRes.status, 200, '合法出生信息应返回 200');
  const direct = await directRes.json();
  assert.equal(direct.chart.palaces.length, 12, '必须返回 12 宫');
  assert.equal(direct.chart.birthInfo.hour, 8, '15:25 应为申时（支 8）');
  assert.equal(direct.chart.lunarInfo.lunarMonth, 3);
  assert.equal(direct.chart.lunarInfo.lunarDay, 18);
  assert.deepEqual(direct.chart.lunarInfo.fourPillars, ['壬午', '甲辰', '戊辰', '庚申']);

  // ── 2) 钟表时间 → 后端换算，与直接传 hour 结果一致 ────────────
  const clockRes = await generate({
    year: 2002, month: 4, day: 30, clockHour: 15, clockMinute: 25,
    gender: 'male', province: '山东省', city: '青岛市', longitude: 120.4,
  });
  assert.equal(clockRes.status, 200);
  const clock = await clockRes.json();
  assert.deepEqual(
    { year: clock.chart.birthInfo.year, month: clock.chart.birthInfo.month, day: clock.chart.birthInfo.day, hour: clock.chart.birthInfo.hour },
    { year: 2002, month: 4, day: 30, hour: 8 },
    '15:25 青岛经度校正后仍是当日申时',
  );
  assert.deepEqual(clock.chart.birthInfo.origInput, {
    year: 2002, month: 4, day: 30, clockHour: 15, clockMinute: 25,
  });
  assert.deepEqual(clock.chart.palaces, direct.chart.palaces, '两条入参路径必须排出同一张盘');

  // ── 3) 晚子时：钟表 23:30 → 次日、时辰支 0 ────────────────────
  const lateZiRes = await generate({
    year: 2002, month: 4, day: 30, clockHour: 23, clockMinute: 30, gender: 'male',
  });
  assert.equal(lateZiRes.status, 200);
  const lateZi = await lateZiRes.json();
  assert.deepEqual(
    { year: lateZi.chart.birthInfo.year, month: lateZi.chart.birthInfo.month, day: lateZi.chart.birthInfo.day, hour: lateZi.chart.birthInfo.hour },
    { year: 2002, month: 5, day: 1, hour: 0 },
    '23:30 晚子时按次日排盘',
  );

  // ── 4) 非法入参全部 400 ─────────────────────────────────────
  async function expect400(res: Response, label: string) {
    assert.equal(res.status, 400, `${label} 应返回 400`);
    const json = await res.json();
    assert.equal(json.error?.code, 'invalid_request', `${label} 应带 invalid_request`);
    assert.ok(Array.isArray(json.error?.fields) && json.error.fields.length > 0, `${label} 应带字段错误`);
  }

  await expect400(await generate({ year: 2002, month: 2, day: 30, hour: 8, gender: 'male' }), '2 月 30 日');
  await expect400(await generate({ year: 1899, month: 4, day: 30, hour: 8, gender: 'male' }), '越界年份');
  await expect400(await generate({ year: 2002, month: 4, day: 30, hour: 12, gender: 'male' }), '时辰支越界');
  await expect400(await generate({ year: 2002, month: 4, day: 30, hour: 8, gender: '男' }), '非法性别');
  await expect400(
    await generate({ year: 2002, month: 4, day: 30, hour: 8, clockHour: 15, clockMinute: 25, gender: 'male' }),
    'hour 与钟表时间同时出现',
  );
  await expect400(
    await generate({ year: 2002, month: 4, day: 30, hour: 8, gender: 'male', leapMonth: 'foo' }),
    '非法闰月策略',
  );

  const malformed = await generate('{not json');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');

  // ── 5) 农历 → 公历 ──────────────────────────────────────────
  const solarRes = await lunar({ year: 2002, month: 3, day: 18 });
  assert.equal(solarRes.status, 200);
  assert.deepEqual((await solarRes.json()).solar, { year: 2002, month: 4, day: 30 });

  const badLeap = await lunar({ year: 2002, month: 4, day: 1, isLeapMonth: true });
  assert.equal(badLeap.status, 400);
  assert.equal((await badLeap.json()).error.code, 'invalid_lunar_date');

  console.log('✅ 排盘 API：合法入参、钟表换算、晚子时、非法日期与农历换算均正确');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
