/**
 * 雨花家文化 • 每日诵读 —— 非宗教化的传统文化与正能量修身宣导内容
 * 内容来源：机构提供的权威培训原文，此文件仅做结构化整理，未对文字做任何改写
 */

export interface RainFlowerCreedGroup {
  title: string;
  items: string[];
}

// 一、社会主义核心价值观
export const CORE_VALUES = {
  title: '社会主义核心价值观',
  national: ['富强', '民主', '文明', '和谐'],
  social: ['自由', '平等', '公正', '法治'],
  individual: ['爱国', '敬业', '诚信', '友善']
};

// 二、立志格言
export const FAMOUS_QUOTES: string[] = [
  '为天地立心，为生民立命，为往圣继绝学，为万世开太平。'
];

// 三、雨花家道
export const RAIN_FLOWER_HOME = {
  coreSpirit: '没有杀戮，没有交易，只有感恩。',
  sanYou: { title: '雨花三由', items: ['由内向外', '由亲向疏', '由近及远'] } as RainFlowerCreedGroup,
  wuLe: { title: '雨花五了', items: ['吃了就好', '做了就好', '够了就好', '舍了就好', '了了就好'] } as RainFlowerCreedGroup,
  liuTong: {
    title: '雨花六同',
    items: ['同为天地人，同守道德本', '同连中华根，同承古文明', '同一价值观，同铸民族魂']
  } as RainFlowerCreedGroup,
  baXin: {
    title: '雨花八欣',
    items: ['他人欣我幸福', '家庭欣我幸福', '邻里欣我幸福', '国家欣我幸福', '社会欣我幸福', '自然欣我幸福', '生态欣我幸福', '世界欣我幸福']
  } as RainFlowerCreedGroup
};

// 四、雨花敬老核心理念 + 五、雨花敬老行为准则【十个有没有】
export const SENIORS_CARE = {
  coreBelief: '老人是宝。养儿为老，敬老为国。人人为老，老为人人。',
  tenHaveYous: [
    '只有他人，没有自己。',
    '只有陪伴，没有分析。',
    '只有倾听，没有定义。',
    '只有专注，没有评判。',
    '只有主动，没有执着。',
    '只有抚慰，没有对立。',
    '只有奉献，没有所得。',
    '只有爱心，没有占有。',
    '只有坚韧，没有抱怨。',
    '只有感恩，没有指责。'
  ]
};

// 六、雨花家德 —— 雨花人生十六最
export const SIXTEEN_BESTS: string[] = [
  '人生最基本是受教。',
  '人生最安乐是遵纪守法。',
  '人生最富贵是勤俭尽责。',
  '人生最幸福是知足。',
  '人生最高智慧是认识和了解自己。',
  '人生最大力量是真诚。',
  '人生最大债务是恩德。',
  '人生最根本是孝敬。',
  '人生最高尚是德行。',
  '人生最要紧是忠实。',
  '人生最快乐是行善。',
  '人生最广泛是爱心。',
  '人生最宝贵是时间。',
  '人生最难得是人身。',
  '人生最痛苦是生老病故。',
  '人生最能离苦得乐是圣贤教育。'
];

// 七、雨花家训（心字诀 + 家训正文 + 为学之方）
export const FAMILY_MOTTO = {
  mindFormula: '雨花训，皆用心。志悲恳，惜忠恒，憼忍愛，悟忈恩，忏慎慧，恕德性。字依心，心现相；心同体，命同根。',
  creedLines: [
    '提倡素食，康乐长寿。',
    '惜命戒杀，众生祥和。',
    '勤俭尽责，世昌人安。',
    '珍惜天物，常乐丰足。',
    '老实听话，扎根真干。',
    '一门深入，长时熏修。',
    '任何身份，上敬下和。',
    '忍不能忍，行不能行。',
    '代人之劳，成人之美。',
    '常思己过，不论人非。',
    '从始至终，没有杀戮。',
    '没有交易，只有感恩。',
    '常生惭愧，常怀忏悔。',
    '纵有修持，不自矜夸。',
    '只管自家，不管人家。',
    '只看好样，不看坏样。',
    '都是老师，唯我学生。',
    '依此修学，圣贤驯致！'
  ],
  studyMethod: '通过研习，明了家训的真实义，掌握运用家训的方法，提升内化家训的能力；时时体察自己的心念，事事践行家训的义理，处处检验学习的成效。居敬持志、知行合一。'
};

// 八、雨花家仪 —— 感恩词
export const GRATITUDE_TEXT: string[] = [
  '感恩天地滋养万物，',
  '感恩祖先慈悲智慧，',
  '感恩国家培养护佑，',
  '感恩父母养育之恩，',
  '感恩老师辛勤教导，',
  '感恩同仁关心帮助，',
  '感恩农夫辛勤劳作，',
  '感恩素食健康环保，',
  '感恩大众信任支持，',
  '感恩所有付出的人。'
];

// 九、一日修身小结 —— 感恩与祈盼
export const DAILY_SUMMARY = {
  title: '一日修身小结 · 感恩与祈盼',
  gratitude: [
    '让我们以至诚的心，',
    '感恩祖先的福荫、国家的护佑，',
    '感恩父母的哺育、老师的教诲，',
    '感恩社会的支持、大众的帮助。'
  ],
  aspiration: [
    '让我们共同祈盼：',
    '父母、亲人、老师、同仁及所有的人，',
    '德日进、过日少、身心安康、四季吉祥！',
    '祈盼公益餐桌无限延伸，让孝悌忠信走进千家万户!',
    '祈盼国家富强民族复兴，让礼义廉耻照耀大地苍穹!',
    '祈盼天下苍生美美与共，让仁爱和平庇佑世界大同!'
  ]
};

// 十、雨花家风
export const FAMILY_STYLE = {
  title: '雨花家风',
  text: '仁、中、和。'
};

// ============ 派生数据：首页【每日修身】卡片轮播用 ============

export interface DailyCultureQuote {
  text: string;
  source: string;
}

// 每日修身卡片的轮播池：立志格言 + 人生十六最 + 雨花家训正文 + 雨花家道核心精神
export const DAILY_CULTURE_QUOTES: DailyCultureQuote[] = [
  ...FAMOUS_QUOTES.map((text) => ({ text, source: '立志格言' })),
  ...SIXTEEN_BESTS.map((text) => ({ text, source: '雨花人生十六最' })),
  ...FAMILY_MOTTO.creedLines.map((text) => ({ text, source: '雨花家训' })),
  { text: RAIN_FLOWER_HOME.coreSpirit, source: '雨花家道 · 核心精神' }
];

// 按自然日期确定性选取一条（同一天多次进入首页展示同一条，跨天自动更新）
export function getDailyCultureQuote(date: Date = new Date()): DailyCultureQuote {
  const dayIndex = Math.floor(date.getTime() / 86400000);
  const idx = ((dayIndex % DAILY_CULTURE_QUOTES.length) + DAILY_CULTURE_QUOTES.length) % DAILY_CULTURE_QUOTES.length;
  return DAILY_CULTURE_QUOTES[idx];
}

// 【换一换】：随机取一条，且尽量不与当前展示的重复
export function getRandomCultureQuote(excludeText?: string): DailyCultureQuote {
  if (DAILY_CULTURE_QUOTES.length <= 1) return DAILY_CULTURE_QUOTES[0];
  let pick: DailyCultureQuote;
  let guard = 0;
  do {
    pick = DAILY_CULTURE_QUOTES[Math.floor(Math.random() * DAILY_CULTURE_QUOTES.length)];
    guard++;
  } while (pick.text === excludeText && guard < 10);
  return pick;
}

// 拼合完整感恩词文本（用于食谱面板折叠区 / 海报落款）
export function getGratitudeTextFull(): string {
  return GRATITUDE_TEXT.join('\n');
}

// 拼合完整雨花家训纯文本（无独立视觉标题的场景使用，如分享文案/海报落款，
// 故在这里而非 FAMILY_MOTTO 原始数据上补回"雨花心字诀："/"为学之方："前缀——
// 首页弹窗有独立加粗小标题，直接用 FAMILY_MOTTO.mindFormula/studyMethod 即可，不会重复）
export function getFamilyMottoFullText(): string {
  return [
    '雨花心字诀：' + FAMILY_MOTTO.mindFormula,
    '',
    ...FAMILY_MOTTO.creedLines,
    '',
    '为学之方：' + FAMILY_MOTTO.studyMethod
  ].join('\n');
}
