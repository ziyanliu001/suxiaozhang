// 🌟 通知展示统一数据字典：分类规则（判定"物资告急/喜讯通报/系统公告"等展示
// 标签与配色）与正文去重（剥离与标题重复的"【标题】"前缀）集中在这一处，
// index.ts（首页跑马灯 + 详情弹窗）与 notice.ts（通知页"系统通知"列表徽标）
// 都从这里读，不再各自维护一份可能不一致的分类/格式化逻辑。
//
// 🐛 根因修复："爱心物资接力/物资储备临界告急"类通知被错误打上"喜讯通报"标签：
// notice.ts 此前把 notices 集合里存的 tag 字段原样当徽标文本展示，从不做任何
// 语义校验——而 index.ts 编辑弹窗 openNoticeEdit/openNoticeCreate 此前又把
// tag 输入框默认值硬编码成"喜讯通报"，只要发布/编辑时没有手动改成匹配内容的
// 分类，两处叠加就会把物资告急类内容长期顶着一个"喜讯通报"的标签展示。
// 现在改为：徽标文案统一按标题+正文的关键词语义优先判定，不再无条件信任库里
// 存的 tag 原文；编辑表单默认值也不再硬编码单一分类，改为按内容自动建议。
// 分类规则按优先级从上到下匹配，命中第一条即停止，未命中任何规则时落到默认
// "系统公告"（日常公告/放假通知等场景）。

export interface NoticeClassification {
  noticeType: string;
  headerTitle: string;
  themeClass: string;
  typeIcon: string;
  // 短标签文案：供列表徽标（notice.ts）与其它需要紧凑展示的场景复用
  typeLabel: string;
  // 列表徽标配色分类，对应 notice.wxss 里的 .cat-tag-* 系列 class
  tagColorClass: string;
}

interface NoticeClassifyRule extends NoticeClassification {
  test: RegExp;
}

const NOTICE_CLASSIFY_RULES: NoticeClassifyRule[] = [
  { noticeType: 'closure', test: /停业|维护|暂停|关闭/, headerTitle: '⚠️【停业公告】', themeClass: 'type-closure', typeIcon: '⚠️', typeLabel: '停业公告', tagColorClass: 'system' },
  // 🎯 物资告急/求助接力拆成两条独立规则，分别对应更精确的"物资接力"/
  // "求助通报"标签文案，而不是笼统共用一个"喜讯通报"或"门店公告"
  { noticeType: 'urgent', test: /物资|库存|大米|食用油|储备临界/, headerTitle: '🚨【物资告急】', themeClass: 'type-urgent', typeIcon: '🚨', typeLabel: '物资接力', tagColorClass: 'urgent' },
  { noticeType: 'urgent', test: /呼吁|招募|急需|求助|紧急/, headerTitle: '📢【爱心呼吁】', themeClass: 'type-urgent', typeIcon: '📢', typeLabel: '求助通报', tagColorClass: 'urgent' },
  // 🎯 补充捐赠/善款相关关键词：此前只认"喜讯|试营业|开业|喜报"，"爱心捐赠到账/
  // 善款达标"这类没有字面"喜讯"二字的喜讯类内容会漏判，落到下面 thanks 规则
  // （命中"感恩/感谢"）或默认的系统公告，错失"喜讯通报"该有的醒目展示
  { noticeType: 'good_news', test: /喜讯|试营业|开业|喜报|捐赠到账|善款到账|善款达标|捐款到账|目标达成|众筹成功/, headerTitle: '🎉【喜讯通报】', themeClass: 'type-good_news', typeIcon: '🎉', typeLabel: '喜讯通报', tagColorClass: 'good_news' },
  { noticeType: 'thanks', test: /感恩|致谢|鸣谢|感谢/, headerTitle: '❤️【感恩鸣谢】', themeClass: 'type-thanks', typeIcon: '❤️', typeLabel: '感恩鸣谢', tagColorClass: 'good_news' },
];

const NOTICE_CLASSIFY_DEFAULT: NoticeClassification = {
  noticeType: 'general',
  headerTitle: '📌【门店公告】',
  themeClass: 'type-general',
  typeIcon: '📌',
  // 🎯 日常公告/放假通知等没命中任何关键词规则的兜底分类，标签文案从此前的
  // "门店公告"改成"系统公告"，与 notice.ts"系统通知"分区的语境对齐
  typeLabel: '系统公告',
  tagColorClass: 'system'
};

export function classifyNotice(tag: string, title: string, content: string): NoticeClassification {
  const text = `${tag || ''} ${title || ''} ${content || ''}`;
  return NOTICE_CLASSIFY_RULES.find((rule) => rule.test.test(text)) || NOTICE_CLASSIFY_DEFAULT;
}

// 🐛 正文展示去重：预置文案（getNoticeTemplate）与店长自行编辑保存的通报，
// 正文开头习惯性带一份"【标题】"前缀（如 title="爱心物资接力"，
// content="【爱心物资接力】感恩各位爱心人士..."）——卡片/弹窗本就在标题位置
// 单独展示过一次标题，正文再重复一遍是明显的视觉冗余。只在渲染取值时剥离这份
// 与标题完全一致的前缀，不修改任何已落库数据，编辑表单回填时仍是原始文本
export function stripTitlePrefixFromContent(content: string, title: string): string {
  if (!content || !title) return content || '';
  const prefix = `【${title}】`;
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : content;
}
