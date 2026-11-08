/**
 * 判据单测。
 *
 * 存在的理由：判据错了，整套评测的数字就都是错的，而且**看起来很正常**。
 * W2 的 C13 就因为「要求必须撞过错误才算修复」把 75% 的正确行为判成失败，
 * 我对着 0.08 的修复率查了 40 分钟才想到去读断言。
 *
 * 所以这里逐个写法都钉死：千分位、万元、百分号、误命中、series 覆盖阈值。
 */

import { describe, expect, it } from 'vitest';
import { extractNumbers, judgeAnswer, matchesReference } from '../../src/lib/qa-judge';

describe('数字抽取', () => {
  it('千分位', () => {
    const nums = extractNumbers('GMV 为 4,583,791 元');
    expect(nums.some((n) => n.value === 4583791)).toBe(true);
  });

  it('万元（带空格）', () => {
    const nums = extractNumbers('约 458.4 万元');
    expect(nums.some((n) => n.value === 4584000)).toBe(true);
  });

  it('万元（不带空格）', () => {
    const nums = extractNumbers('约458.4万元');
    expect(nums.some((n) => n.value === 4584000)).toBe(true);
  });

  it('亿', () => {
    const nums = extractNumbers('全年 1.2 亿');
    expect(nums.some((n) => n.value === 120000000)).toBe(true);
  });

  it('负数与小数不会互相吞掉', () => {
    const nums = extractNumbers('净增 -1200，转化率 3.5%');
    expect(nums.map((n) => n.value)).toEqual(expect.arrayContaining([1200, 3.5]));
  });
});

describe('命中判定', () => {
  const target = 4583791;

  it('整数写法命中', () => {
    const t = '2026 年 10 月 GMV 是 4,583,791 元';
    expect(matchesReference(t, extractNumbers(t), target, 0.01, '元')).not.toBeNull();
  });

  it('万元写法命中（口径换算不能判错）', () => {
    const t = '10 月 GMV 约 458.4 万元';
    expect(matchesReference(t, extractNumbers(t), target, 0.01, '元')).not.toBeNull();
  });

  it('四舍五入的整数写法在 1% 容差内命中', () => {
    const t = '458 万左右';
    expect(matchesReference(t, extractNumbers(t), target, 0.01, '元')).not.toBeNull();
  });

  it('差得远的不命中', () => {
    const t = '10 月 GMV 是 465 万元（未扣优惠）';
    // 465 万与 458.4 万差 1.4%，超出 1% 容差 —— 这正是「扣没扣优惠」的分野，必须判错
    expect(matchesReference(t, extractNumbers(t), target, 0.01, '元')).toBeNull();
  });

  it('小值必须带单位，避免「第 2 季度」被判成 2%', () => {
    const hit = '流失率是 2%';
    expect(matchesReference(hit, extractNumbers(hit), 2, 0.1, '%')).not.toBeNull();

    const miss = '这是第 2 季度的情况';
    expect(matchesReference(miss, extractNumbers(miss), 2, 0.1, '%')).toBeNull();
  });

  it('小数型小值（2.98 天）', () => {
    const t = '平均 2.98 天送达';
    expect(matchesReference(t, extractNumbers(t), 2.98, 0.05, '天')).not.toBeNull();
  });
});

describe('judgeAnswer 各模式', () => {
  it('value：命中主值', () => {
    const v = judgeAnswer({ mode: 'value', value: 14900, tolerance: 0.01 }, '一共 14,900 笔订单');
    expect(v.hit).toBe(true);
  });

  it('value：命中备选口径也算对（多口径不是错）', () => {
    const v = judgeAnswer(
      { mode: 'value', value: 4583791, altValues: [10668394], tolerance: 0.02, unit: '元' },
      '两条线合计 1,066.84 万元',
    );
    expect(v.hit).toBe(true);
  });

  it('caveat：值对了但没提口径限制 → caveatOk false', () => {
    const v = judgeAnswer(
      { mode: 'caveat', value: 58.7, tolerance: 0.05, unit: '%', caveatKeywords: ['定义', '口径'] },
      '复购率是 58.7%',
    );
    expect(v.hit).toBe(true);
    expect(v.caveatOk).toBe(false);
  });

  it('caveat：提了口径 → caveatOk true', () => {
    const v = judgeAnswer(
      { mode: 'caveat', value: 58.7, tolerance: 0.05, unit: '%', caveatKeywords: ['定义', '口径'] },
      '按客户维度去重算，复购率 58.7%；换一个口径（订单维度）数字会不同',
    );
    expect(v.caveatOk).toBe(true);
  });

  it('series：覆盖 80% 即命中（12 个值漏 2 个）', () => {
    const values = [2585, 1410, 1099, 600, 1002, 999, 1098, 2003, 947, 904];
    const answer = '各月订单数：' + values.map((v) => `${v} 单`).join('，');
    const v = judgeAnswer({ mode: 'series', values, tolerance: 0.01, unit: '单' }, answer);
    expect(v.hit).toBe(true);
  });

  it('series：只说了峰值 → 不命中', () => {
    const values = [2585, 1410, 1099, 600, 1002, 999, 1098, 2003, 947, 904];
    const v = judgeAnswer({ mode: 'series', values, tolerance: 0.01, unit: '单' }, '最高是 2025 年 11 月的 2585 单');
    expect(v.hit).toBe(false);
  });

  it('refuse：说明无法计算 → 命中', () => {
    const v = judgeAnswer({ mode: 'refuse' }, '库里没有访客数据，无法计算转化率。');
    expect(v.hit).toBe(true);
  });

  it('refuse：只判「有没有说不」——编不编数字交给人工复核（已知局限）', () => {
    // 曾经这里还检「有没有同时报个大额数字」，结果把 D10 判错了：
    // 它正确地说「2025 年 1 月没有数据」，然后又附了 2026 年各月做参照，
    // 918.8 万就被当成编造。自动判据分不清「说了没有 + 给相关参考」和「说了没有 + 瞎编」，
    // 那就不装能分清 —— 交给人看。
    const v = judgeAnswer({ mode: 'refuse' }, '数据里没有这段，无法计算；作为参照，2026 年 1 月是 383.1 万。');
    expect(v.hit).toBe(true);
  });

  it('qualitative：指出样本量即命中（开放答案题）', () => {
    const v = judgeAnswer(
      { mode: 'qualitative', caveatKeywords: ['样本', '不稳定'] },
      '前 4 名样本量偏小，排名不够稳定，建议只看明细 ≥100 的商品',
    );
    expect(v.hit).toBe(true);

    const no = judgeAnswer(
      { mode: 'qualitative', caveatKeywords: ['样本', '不稳定'] },
      '第一名退货率 13.3%，第二名 12.2%',
    );
    expect(no.hit).toBe(false);
  });
});

// ---------------------------------------------------------------- interpretations（D 类口径题）
describe('judgeAnswer · interpretations', () => {
  const interps = [
    { label: '折后分摊 − 退款', value: 29072219, keywords: ['退款', '净'] },
    { label: '折后分摊，不扣退款', value: 30147177, keywords: ['未扣', '不含退'] },
    { label: '原价直加', value: 30574452, keywords: ['原价'] },
  ];
  const base = { mode: 'interpretations' as const, interpretations: interps, unit: '元' };

  it('命中主口径且解释一致 → hit + caveatOk', () => {
    const v = judgeAnswer(base, '净营收最高的是智能硬件，约 2907.2 万元（已扣退款）。');
    expect(v.hit).toBe(true);
    expect(v.caveatOk).toBe(true);
    expect(v.detail).toContain('折后分摊 − 退款');
  });

  it('命中第二个口径也能过（这正是四轮评测里被冤判的那类答案）', () => {
    const v = judgeAnswer(base, '智能硬件 3014.7 万元，未扣退款。');
    expect(v.hit).toBe(true);
    expect(v.detail).toContain('不扣退款');
  });

  it('数字对、但解释说的是另一套口径 → hit 但 caveatOk=false', () => {
    // 这是整个 interpretations 模式存在的理由：
    // 单独比数字会判它对，唯一能抓出「数字对、话是错的」的手段就是口径关键词。
    const v = judgeAnswer(base, '智能硬件原价合计 2907.2 万元。');
    expect(v.hit).toBe(true);
    expect(v.caveatOk).toBe(false);
  });

  it('一个口径都不命中 → hit=false，并报出共几个口径', () => {
    const v = judgeAnswer(base, '智能硬件 1234.5 万元。');
    expect(v.hit).toBe(false);
    expect(v.detail).toContain('3');
  });

  it('口径没校准（value 为 null）→ 抛错，不能静默当成未命中', () => {
    // 静默跳过会让「校准漏了一条」看起来像「模型答错了」——这类错误最难查。
    expect(() =>
      judgeAnswer(
        { mode: 'interpretations', interpretations: [{ label: '未校准', value: null, keywords: [] }] },
        '随便什么答案',
      ),
    ).toThrow(/已校准/);
  });

  it('没配 keywords 时 caveatOk=null（判不了，不是判失败）', () => {
    const v = judgeAnswer(
      { mode: 'interpretations', interpretations: [{ label: '只有一个值', value: 2474 }] },
      '活跃用户 2,474 人。',
    );
    expect(v.hit).toBe(true);
    expect(v.caveatOk).toBeNull();
  });

  it('答案里多个口径的数字都出现时，取最靠前的（结论在前、分项在后）', () => {
    // D03 的真实形态：结论 1,120.4 万在前，表格里又列了分项 458.4 万。
    // 按「第一个匹配到的口径」会命中分项，判据就会以为自己验了结论，其实没验。
    const two = [
      { label: '仅电商', value: 4583791, keywords: ['仅电商'] },
      { label: '两条线应收', value: 11203946, keywords: ['应收', '账单'] },
    ];
    const v = judgeAnswer(
      { mode: 'interpretations', interpretations: two, unit: '元' },
      '总收入约 1,120.4 万元（应收口径）。其中电商实收 458.4 万元。',
    );
    expect(v.hit).toBe(true);
    expect(v.detail).toContain('两条线应收');
    expect(v.detail).toContain('取最靠前的');
    expect(v.caveatOk).toBe(true);
  });

  it('小数值（<200）仍然要求单位，避免「第 2 季度」被判成 2%', () => {
    const interps2 = [{ label: '2026-10 单月', value: 2, keywords: ['月度'] }];
    const ok = judgeAnswer(
      { mode: 'interpretations', interpretations: interps2, unit: '%' },
      '2026 年 10 月流失率是 2.0%。',
    );
    expect(ok.hit).toBe(true);

    const no = judgeAnswer(
      { mode: 'interpretations', interpretations: interps2, unit: '%' },
      '这个数字在第 2 个季度统计。',
    );
    expect(no.hit).toBe(false);
  });
});
