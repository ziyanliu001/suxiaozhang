// 云函数：getSunshineLedger
//
// 首页「☀️ 阳光账本」入口专用的公开只读汇总查询。
//
// 🛡️ 与本项目其余云函数最大的不同（与 publicVerifyReport 同一套设计哲学）：这里刻意
// 【不做】任何 user_roles/OPENID 权限校验——首页任何访客（含未登录/未绑定门店身份的
// 家人、义工、财务、店长、家长、超管）点开都应该能看到本店的公开透明数据，不需要
// 任何权限门槛。正因为完全公开，只接受调用方明确指定的单个 storeId（不支持"全部门店"
// 之类的跨店聚合参数），且所有查询条件都强制带上这个 storeId，避免这个无鉴权接口
// 被当成任意门店数据的批量抓取入口。
//
// 🛡️ 核心风控：查询条件严格限定 approvalStatus 为 'APPROVED' 或 'AUDITED_LOCKED'，
// 绝对排除 'PENDING'（含缺失该字段的历史/草稿记录，undefined 不在这两个值内，天然被
// 排除）——阳光账本展示的必须是"已经过店长核对确认/财务稽核"的生效数据，不能让
// 尚未审核的草稿金额被公众误当作已生效数据看待。

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 🛡️ 单次查询上限：本店按日累计的审核通过记录，理论上限是"运营天数"，2000 条约等于
// 5.4 年的每日记录；超过这个规模的门店（存续更久）累计类指标会低估，但公开只读接口
// 不适合为极端场景无限拉取全表，与 getStatisticsData 等同类云函数的 limit 口径一致
const QUERY_LIMIT = 2000;

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function daysInMonth(year, month) {
  // month: 1-12
  return new Date(year, month, 0).getDate();
}

function daysBetween(dateStr, todayStr) {
  if (!dateStr) return Infinity;
  const a = new Date(dateStr).getTime();
  const b = new Date(todayStr).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

// 🐛 根因修复（2026-08-30 全平台脱敏专项）：本函数是完全无鉴权的公开接口（见
// 文件头注释），此前把"阳善（isAnonymous:false）"报表的捐赠人姓名原样吐出到
// 善缘墙——任何人扫码/访问首页都能看到真实姓名，且只判断了报告级 r.isAnonymous，
// 完全没看每一条捐赠自己的 item.isAnonymous 覆盖（逐条阳善/阴德区分功能，见
// utils/parser.ts DonorItem.isAnonymous），一份报告级"阳善"的报表里单独标记
// 阴德的那一条也会被当成阳善原样展示真实姓名。现在统一：①姓名一律脱敏展示
// （不再原样吐出全名），②按每一条自己的 isAnonymous 判断（未标记的才继承
// 报告级默认值），阴德统一展示"爱心善士"占位，阳善展示脱敏后的姓名而不是
// 直接跳过整份报表——与 miniprogram/utils/privacy.ts 的 maskName/
// formatDisplayName 同一套规则（各云函数/前端独立部署，无共享模块机制，
// 需要手动同步这几处拷贝）
function maskName(name) {
  if (!name) return '';
  const str = String(name).trim();
  if (str.length <= 1) return str + '*';
  if (str.length === 2) return str.charAt(0) + '*';
  return str.charAt(0) + '*'.repeat(str.length - 2) + str.charAt(str.length - 1);
}

// 🆕（2026-08-31 善行卡海报）个人足迹存证指纹：与 exportAccountExcel 的
// generateVerificationCode 同一套设计哲学——对本次计算出的足迹摘要（门店+
// 脱敏姓名+累计金额+结缘天数）算一次 SHA-256，截取前 16 位十六进制大写作为
// 人工可誊抄核对的"存证指纹"。目的是给分享出去的善行卡提供一个"这张卡的
// 数据有没有被二次篡改"的核对锚点，不是加密学意义上不可伪造的数字签名——
// 收到者可以要求出具方（善信本人重新打开小程序）重新生成同一份数据核对
// 是否一致
function generateFootprintCode(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16).toUpperCase();
}

function resolveItemAnonymous(item, reportLevelAnonymous) {
  return item && item.isAnonymous !== undefined ? !!item.isAnonymous : !!reportLevelAnonymous;
}

function formatDonorDisplayName(name, isAnonymous) {
  if (isAnonymous || !name || !String(name).trim()) return '爱心善士';
  return maskName(name);
}

// 🌸 近7日阳善榜专用：精确到分钟/小时的相对时间（"2小时前"），比 daysBetween
// 那套按天粒度的 timeLabel（今天/昨天/N天前）更适合一个只滚动最近 7 天的短窗口
// 列表——7 天内的记录几乎全是"今天/昨天"，天粒度会让列表看起来像是同一时间
// 发生的，丢失了本该有的先后顺序感
function formatRelativeTime(createTime) {
  if (!createTime) return '';
  const d = createTime instanceof Date ? createTime : new Date(createTime);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return '';
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return '刚刚';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}天前`;
}

exports.main = async (event) => {
  const { storeId, yearMonth } = event;

  if (!storeId || !String(storeId).trim()) {
    return { success: false, error: '缺少门店标识，无法查询' };
  }

  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // 🛡️ yearMonth 参数校验：格式不对/缺失一律退回当前月，不因客户端传入脏数据
    // 就让查询条件失效或抛异常——公开接口的输入始终按"不可信"处理
    let targetYear = currentYear;
    let targetMonth = currentMonth;
    if (yearMonth && YEAR_MONTH_RE.test(String(yearMonth))) {
      const parts = String(yearMonth).split('-');
      targetYear = parseInt(parts[0], 10);
      targetMonth = parseInt(parts[1], 10);
    }
    const isCurrentMonth = targetYear === currentYear && targetMonth === currentMonth;

    const monthStr = String(targetMonth).padStart(2, '0');
    const monthStartStr = `${targetYear}-${monthStr}-01`;
    // 当月只统计到今天为止（避免"未来日期"污染），非当月（历史月份）统计完整一个月
    const monthEndStr = isCurrentMonth
      ? `${targetYear}-${monthStr}-${String(now.getDate()).padStart(2, '0')}`
      : `${targetYear}-${monthStr}-${String(daysInMonth(targetYear, targetMonth)).padStart(2, '0')}`;
    const periodLabel = `${targetYear}年${monthStr}月`;

    // 🏪 门店名称：与 publicVerifyReport 同一份数据来源，查询失败不影响主流程
    // 🆕 orgType 随门店文档一并取出（复用同一次 doc().get()，不新增查询）：供
    // 前端"阳光账本理念弹窗"按真实机构类型（雨花斋/助老食堂/其他）区分文案，
    // 不再靠 tenantId 前缀猜测——那套猜测口径无法区分同一租户下的不同业态门店
    let storeName = '';
    let orgType = '';
    try {
      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (store) {
        storeName = store.storeName || '';
        orgType = store.orgType || '';
      }
    } catch (storeErr) {
      console.warn('[getSunshineLedger] 门店名称查询失败（不影响主流程）:', storeErr);
    }

    // 🛡️ 严格以 storeId 过滤 + 白名单 approvalStatus——不再按日期范围收窄，
    // 累计类指标需要覆盖本店全部历史已审核记录，月度指标从这份结果里再筛一次。
    // 🆕 orderBy dateString desc：供下方"最新爱心支持"善缘墙按时间倒序收集前
    // 20 条，此前没有排序，聚合类指标（求和/去重计数）不受影响，只是新增的
    // latestDonors 收集需要这份顺序保证
    const recordRes = await db.collection('report_logs')
      .where(_.and([
        { storeId },
        { isVoid: _.neq(true) },
        { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
      ]))
      .orderBy('dateString', 'desc')
      .limit(QUERY_LIMIT)
      .get();

    const records = recordRes.data || [];

    let totalDiners = 0;
    let monthlyDiners = 0;
    let takeawayMeals = 0;
    let totalHours = 0;
    let volunteerCount = 0;
    // 🆕（统计分析/阳光大盘与首页录入口径对齐）与首页 pages/index/index.ts
    // 提交表单同名字段一一对应：dineInSeniors=堂食长者、deliverySeniors=送餐
    // 长者（takeawayMeals 变量名历史遗留，实际就是这个字段的累加，见下方
    // forEach，保留不动以免影响已有的首页阳光账本弹窗展示）、takeawayCount=
    // 打包份数、listeningSeniors=倾听陪伴/关怀人次。均为新增累加器，只做加法，
    // 不改动上面任何既有字段的口径
    let dineInCount = 0;
    let takeawayCount = 0;
    let accompanyCount = 0;
    let receiptCount = 0;
    const operatingDateSet = new Set();

    // 💖 发心分布（阳善 vs 积阴德）+ 最新爱心支持善缘墙：与 getNationalDashboard
    // 全国大屏同一套统计口径（yangCount/yinCount 按餐报份数计，donationItems
    // 按明细条目展开），只是把聚合范围从"全租户所有门店"收窄到本店，因为本卡片
    // 现在要迁到个人页给全员（含无租户级权限的家人/店长）公开展示，只能用本店
    // 自己已审核公开的数据，不能带出其他门店的信息
    const todayStr = now.toISOString().slice(0, 10);
    let yangCount = 0;
    let yinCount = 0;
    const latestDonors = [];

    // 🌸 近7日阳善榜：与 latestDonors（全历史，供个人页/首页现有的阳善公开滚动墙
    // 使用）是两份独立的收集结果，互不影响——严格限定 Date.now() - 7*86400*1000
    // 这一真实 7×24 小时窗口，不是"最近 7 条"或"最近 7 天里挑一部分"。
    // 优先用 createTime（记录提交时的服务器时间戳，dataService.ts 写入 report_logs
    // 时已带上）做精确到毫秒的窗口判断；老数据缺 createTime 字段时，退回按
    // dateString（日期，无时分）与 sevenDaysAgoStr 比较，仍然保证不早于 7 天前
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sevenDaysAgoStr = new Date(sevenDaysAgoMs).toISOString().slice(0, 10);
    const latestDonorsWeekly = [];

    // 🌸 近3日阳善榜：与 latestDonorsWeekly 同款窗口判断逻辑，只是把窗口收窄到
    // 真实 3×24 小时，供个人页阳善纵向"冒出"轮播使用——该场景要的是"最近这几天
    // 谁随喜了"，7 天窗口太宽，容易把上周的记录也混进来
    const threeDaysAgoMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const threeDaysAgoStr = new Date(threeDaysAgoMs).toISOString().slice(0, 10);
    const latestDonorsThreeDay = [];

    // 🌸【最新善行】近30日滚动名单：与 Weekly/ThreeDay 同款窗口判断逻辑，
    // 窗口收窄到真实 30×24 小时。与另外两份不同的是：①本窗口额外并入
    // materials（实物捐赠，如"大米20斤"），不再只看 donationItems（善款）；
    // ②额外并入义工到岗护持记录（volunteer_duty_logs，见下方合并逻辑）——
    // "最新善行"不该只有捐赠，义工奉献工时同样是善行。deedText 如实反映
    // 真实数据（善款给"随喜 ¥金额"，实物给"捐赠+物品+数量+单位"，义工给
    // "奉献工时 N小时"），不虚构/不换算。monthlyPool 是收集阶段的原始池
    // （带 sortMs 排序键），下方与义工记录混合排序后才产出最终的
    // latestDonorsMonthly
    const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgoStr = new Date(thirtyDaysAgoMs).toISOString().slice(0, 10);
    const MONTHLY_POOL_CAP = 60;
    const monthlyPool = [];
    // 🆕（方案3兜底）全历史善行池：与 monthlyPool 收集完全同款的记录（善款+
    // 实物），唯一区别是不受 30 天窗口限制——门店近 30 天恰好没有新善行时
    // （如刚改名/长期未记账的老门店），不能让跑马灯直接跳回静态寄语空态，
    // 退回展示这份全历史里最近的记录，让用户依然能看到真实善行数据。
    // records 本身已经是"该店全部已审核历史记录"（见上方查询未按日期收窄，
    // limit(QUERY_LIMIT)=2000），复用同一次查询结果，不新增数据库调用
    const allTimePool = [];

    records.forEach((r) => {
      const dining = parseFloat(r.totalDineCount || r.diningCount) || 0;
      totalDiners += dining;
      if (r.dateString && r.dateString >= monthStartStr && r.dateString <= monthEndStr) {
        monthlyDiners += dining;
      }
      takeawayMeals += parseFloat(r.deliverySeniors) || 0;
      totalHours += parseFloat(r.volunteerHours) || 0;
      volunteerCount += parseFloat(r.totalVolunteers || r.volunteerCount) || 0;
      // 🛡️ 安全运营天数：按不重复的 dateString 计数，同一天多条记录（极少见，通常
      // 是覆盖更新前的历史脏数据）不重复计入天数
      if (r.dateString) {
        operatingDateSet.add(r.dateString);
      }

      // 🆕 与首页录入口径对齐的细分累加，字段缺失一律安全回退 0
      dineInCount += parseFloat(r.dineInSeniors) || 0;
      takeawayCount += parseFloat(r.takeawayCount) || 0;
      accompanyCount += parseFloat(r.listeningSeniors) || 0;
      // 🧾 阳光凭证公示数：与 history.ts 卡片同一条兼容路径——新记录用
      // receiptImages，老记录可能只有 receiptImageList，二选一取有值的那份，
      // 不重复计数同一条记录的两份字段
      const receiptImgs = (Array.isArray(r.receiptImages) && r.receiptImages.length > 0)
        ? r.receiptImages
        : (Array.isArray(r.receiptImageList) ? r.receiptImageList : []);
      receiptCount += receiptImgs.length;

      const donationItems = Array.isArray(r.donationItems) ? r.donationItems : [];
      if (r.isAnonymous) {
        yinCount++;
      } else {
        yangCount++;
      }
      // 🐛 根因修复：善缘墙不再"整份报表按 r.isAnonymous 一刀切要么全收要么全跳过"——
      // 逐条阳善/阴德区分功能允许单条捐赠显式覆盖报告级默认值（见 resolveItemAnonymous），
      // 报告级阴德里单独标记阳善的一条、或报告级阳善里单独标记阴德的一条，都要按
      // 它自己的标记展示，不能被报告级默认值掩盖。records 已按 dateString 降序取，
      // 先遇到的就是最新的
      if (donationItems.length > 0 && latestDonors.length < 20) {
        const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
        const timeLabel = dayDiff === null ? ''
          : dayDiff === 0 ? '今天'
          : dayDiff === 1 ? '昨天'
          : dayDiff < 7  ? dayDiff + '天前'
          : dayDiff < 30 ? Math.floor(dayDiff / 7) + '周前'
          : Math.floor(dayDiff / 30) + '个月前';
        donationItems.forEach((item) => {
          if (latestDonors.length >= 20) return;
          latestDonors.push({
            name: formatDonorDisplayName(item.name, resolveItemAnonymous(item, r.isAnonymous)),
            amount: parseFloat(item.amount) || 0,
            timeLabel
          });
        });
      }

      // 🌸 近7日阳善榜：独立的窗口判断与收集，不复用上面 latestDonors 的 20 条上限
      // 与天粒度 timeLabel——同一条记录只要落在 7 天窗口内，这里会再收一遍（用
      // 小时/分钟粒度的相对时间），两份列表用途不同，允许重复处理
      if (donationItems.length > 0 && latestDonorsWeekly.length < 30) {
        const recordMs = r.createTime ? new Date(r.createTime).getTime() : NaN;
        const inWeeklyWindow = !Number.isNaN(recordMs)
          ? recordMs >= sevenDaysAgoMs
          : !!(r.dateString && r.dateString >= sevenDaysAgoStr);
        if (inWeeklyWindow) {
          // createTime 缺失的老数据退回天粒度 timeLabel（今天/昨天/N天前），
          // 精度降级但不会显示错误的时间
          const weeklyTimeLabel = !Number.isNaN(recordMs)
            ? formatRelativeTime(r.createTime)
            : (() => {
                const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
                return dayDiff === null ? '' : dayDiff === 0 ? '今天' : dayDiff === 1 ? '昨天' : `${dayDiff}天前`;
              })();
          donationItems.forEach((item) => {
            if (latestDonorsWeekly.length >= 30) return;
            const amount = parseFloat(item.amount) || 0;
            latestDonorsWeekly.push({
              name: formatDonorDisplayName(item.name, resolveItemAnonymous(item, r.isAnonymous)),
              amount,
              // 善举说明：如实反映真实善款金额（"随喜 ¥50"），不虚构"份数"这类
              // 记录里并不存在的换算单位，避免误导公众对实际捐助内容的理解
              deedText: `随喜 ¥${amount}`,
              timeLabel: weeklyTimeLabel
            });
          });
        }
      }

      // 🌸 近3日阳善榜：与上面 latestDonorsWeekly 完全同款逻辑，只是窗口换成
      // threeDaysAgoMs/threeDaysAgoStr，同样允许与 latestDonors/latestDonorsWeekly
      // 重复处理同一条记录
      if (donationItems.length > 0 && latestDonorsThreeDay.length < 30) {
        const recordMs = r.createTime ? new Date(r.createTime).getTime() : NaN;
        const inThreeDayWindow = !Number.isNaN(recordMs)
          ? recordMs >= threeDaysAgoMs
          : !!(r.dateString && r.dateString >= threeDaysAgoStr);
        if (inThreeDayWindow) {
          const threeDayTimeLabel = !Number.isNaN(recordMs)
            ? formatRelativeTime(r.createTime)
            : (() => {
                const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
                return dayDiff === null ? '' : dayDiff === 0 ? '今天' : dayDiff === 1 ? '昨天' : `${dayDiff}天前`;
              })();
          donationItems.forEach((item) => {
            if (latestDonorsThreeDay.length >= 30) return;
            const amount = parseFloat(item.amount) || 0;
            latestDonorsThreeDay.push({
              name: formatDonorDisplayName(item.name, resolveItemAnonymous(item, r.isAnonymous)),
              amount,
              deedText: `随喜 ¥${amount}`,
              timeLabel: threeDayTimeLabel
            });
          });
        }
      }

      // 🌸 近30日"最新善行"跑马灯：善款(donationItems) + 实物(materials) 合并
      // 收集到 monthlyPool（带 sortMs，供下面与义工护持记录混合后按真实时间
      // 重新排序——不能直接定形成 latestDonorsMonthly，两类数据要混排）。
      // 窗口判断与上面两份完全同款逻辑，只是换成 thirtyDaysAgoMs/thirtyDaysAgoStr。
      // materials（实物捐赠）目前没有逐条 isAnonymous 覆盖字段（见 utils/parser.ts
      // MaterialItem 定义），只能按报告级 r.isAnonymous 判断
      const materials = Array.isArray(r.materials) ? r.materials : [];
      if ((donationItems.length > 0 || materials.length > 0) && monthlyPool.length < MONTHLY_POOL_CAP) {
        const recordMs = r.createTime ? new Date(r.createTime).getTime() : NaN;
        const fallbackMs = r.dateString ? Date.parse(r.dateString) : NaN;
        const sortMs = !Number.isNaN(recordMs) ? recordMs : fallbackMs;
        const inMonthlyWindow = !Number.isNaN(recordMs)
          ? recordMs >= thirtyDaysAgoMs
          : !!(r.dateString && r.dateString >= thirtyDaysAgoStr);
        if (inMonthlyWindow) {
          const monthlyTimeLabel = !Number.isNaN(recordMs)
            ? formatRelativeTime(r.createTime)
            : (() => {
                const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
                return dayDiff === null ? '' : dayDiff === 0 ? '今天' : dayDiff === 1 ? '昨天' : `${dayDiff}天前`;
              })();
          donationItems.forEach((item) => {
            if (monthlyPool.length >= MONTHLY_POOL_CAP) return;
            const amount = parseFloat(item.amount) || 0;
            monthlyPool.push({
              sortMs,
              name: formatDonorDisplayName(item.name, resolveItemAnonymous(item, r.isAnonymous)),
              amount,
              deedText: `随喜 ¥${amount}`,
              timeLabel: monthlyTimeLabel
            });
          });
          materials.forEach((m) => {
            if (monthlyPool.length >= MONTHLY_POOL_CAP) return;
            // 🛡️ item/quantity 缺任一项就不硬拼出"捐赠斤"这类语义不全的残缺
            // 文案；unit 缺省时按 utils/parser.ts parseMaterials 同款约定回落
            // 为"份"，不留空——宁可少展示一条也不展示一条读不通的
            if (!m.item || !m.quantity) return;
            monthlyPool.push({
              sortMs,
              name: formatDonorDisplayName(m.donor, !!r.isAnonymous),
              amount: 0,
              deedText: `捐赠${m.item}${m.quantity}${m.unit || '份'}`,
              timeLabel: monthlyTimeLabel
            });
          });
        }
      }

      // 🆕（方案3兜底）全历史善行池：与上面 monthlyPool 完全同款的收集逻辑，
      // 唯一区别是不做 inMonthlyWindow 判断——独立成一段而不是复用上面的
      // if 分支，是为了不改动已经测试过的 30 天窗口逻辑本身，只在旁边追加
      // 一份不受窗口限制的兜底数据
      if ((donationItems.length > 0 || materials.length > 0) && allTimePool.length < MONTHLY_POOL_CAP) {
        const recordMs = r.createTime ? new Date(r.createTime).getTime() : NaN;
        const fallbackMs = r.dateString ? Date.parse(r.dateString) : NaN;
        const sortMs = !Number.isNaN(recordMs) ? recordMs : fallbackMs;
        const allTimeLabel = !Number.isNaN(recordMs)
          ? formatRelativeTime(r.createTime)
          : (() => {
              const dayDiff = r.dateString ? daysBetween(r.dateString, todayStr) : null;
              return dayDiff === null ? '' : dayDiff === 0 ? '今天' : dayDiff === 1 ? '昨天' : `${dayDiff}天前`;
            })();
        donationItems.forEach((item) => {
          if (allTimePool.length >= MONTHLY_POOL_CAP) return;
          const amount = parseFloat(item.amount) || 0;
          allTimePool.push({
            sortMs,
            name: formatDonorDisplayName(item.name, resolveItemAnonymous(item, r.isAnonymous)),
            amount,
            deedText: `随喜 ¥${amount}`,
            timeLabel: allTimeLabel
          });
        });
        materials.forEach((m) => {
          if (allTimePool.length >= MONTHLY_POOL_CAP) return;
          if (!m.item || !m.quantity) return;
          allTimePool.push({
            sortMs,
            name: formatDonorDisplayName(m.donor, !!r.isAnonymous),
            amount: 0,
            deedText: `捐赠${m.item}${m.quantity}${m.unit || '份'}`,
            timeLabel: allTimeLabel
          });
        });
      }
    });

    // 🆕【最新善行】整合义工到岗护持记录：与善款/实物捐赠同属"最新善行"，
    // 此前只有捐赠类数据进这份 30 天滚动名单，义工到岗奉献工时完全没有
    // 入口展示。volunteer_duty_logs 是 manageVolunteerCheckIn 云函数的
    // 打卡落库集合，status:'active' 表示未撤销；createTime 是服务端时间戳，
    // 与上面捐赠记录用同一个 thirtyDaysAgoMs 窗口比较，才能混排出真实的
    // 时间先后顺序，而不是"捐赠一段+义工一段"两段拼接
    try {
      const volunteerLogsRes = await db.collection('volunteer_duty_logs')
        .where(_.and([
          { storeId },
          { status: 'active' },
          { createTime: _.gte(new Date(thirtyDaysAgoMs)) }
        ]))
        .orderBy('createTime', 'desc')
        .limit(MONTHLY_POOL_CAP)
        .get();
      const volunteerLogs = volunteerLogsRes.data || [];

      if (volunteerLogs.length > 0) {
        // 批量解析义工姓名：与 manageVolunteerCheckIn 榜单同款查询，一次
        // in() 覆盖，不逐条查询
        const openidList = [...new Set(volunteerLogs.map((l) => l._openid).filter(Boolean))];
        const nameMap = new Map();
        if (openidList.length > 0) {
          const nameRes = await db.collection('user_roles')
            .where({ _openid: _.in(openidList) })
            .field({ _openid: true, realName: true, nickName: true })
            .limit(openidList.length)
            .get();
          (nameRes.data || []).forEach((u) => {
            nameMap.set(u._openid, u.realName || u.nickName || '');
          });
        }

        volunteerLogs.forEach((log) => {
          if (monthlyPool.length >= MONTHLY_POOL_CAP * 2) return;
          const hours = parseFloat(log.hours) || 0;
          if (hours <= 0) return;
          const sortMs = log.createTime ? new Date(log.createTime).getTime() : NaN;
          if (Number.isNaN(sortMs)) return;
          const rawName = nameMap.get(log._openid) || '';
          monthlyPool.push({
            sortMs,
            name: rawName ? maskName(rawName) : '爱心义工',
            amount: 0,
            deedText: `义工 · 奉献工时 ${hours}小时`,
            timeLabel: formatRelativeTime(log.createTime)
          });
        });
      }
    } catch (volunteerErr) {
      // 义工记录合并失败不影响捐赠类数据正常返回——这是"最新善行"的增量来源，
      // 不是主流程的必要条件
      console.warn('[getSunshineLedger] 合并义工护持记录失败（不影响捐赠数据）:', volunteerErr);
    }

    // 混合排序：捐赠 + 义工护持按真实时间倒序合并成一份，砍到 30 条，
    // 再剥离仅用于排序的 sortMs 字段——不改变 latestDonorsMonthly 对外的
    // 数据形状（yangshan-wall 组件按 {name, deedText, timeLabel, amount} 消费）
    const monthlyWindowResult = monthlyPool
      .sort((a, b) => b.sortMs - a.sortMs)
      .slice(0, 30)
      .map(({ sortMs, ...entry }) => entry);

    // 🆕（方案3兜底）近 30 天窗口内一条善行都没有时（如门店刚改名/近期没有
    // 新记账），不再直接让 yangshan-wall 组件退回静态寄语空态——改用
    // allTimePool（不受时间窗口限制，只覆盖善款/实物，不含义工护持记录，
    // 见该常量声明处注释）里最近的记录顶上；只有本店从未有过任何阳善/实物
    // 捐赠记录（allTimePool 也是空）时，才会真正落到组件自己的空态兜底文案
    const latestDonorsMonthly = monthlyWindowResult.length > 0
      ? monthlyWindowResult
      : allTimePool
          .sort((a, b) => b.sortMs - a.sortMs)
          .slice(0, 30)
          .map(({ sortMs, ...entry }) => entry);

    const meritTotal = yangCount + yinCount;
    const yangRatioPct = meritTotal > 0 ? Math.round(yangCount / meritTotal * 1000) / 10 : 0;
    const yinRatioPct = meritTotal > 0 ? Math.round(yinCount / meritTotal * 1000) / 10 : 0;

    // ☀️ 第 8 项指标——账本公开率：此前这里恒定按"查到记录就是 100%"展示——
    // 但 records 本来就是严格过滤过 APPROVED/AUDITED_LOCKED 的子集，拿它自己
    // 除自己必然是 100%，这不是一个"账本公开率"，只是重复宣称"我筛出来的都是
    // 已审核的"。真正有意义的公开率分母应该是"本店全部已提交、未作废的餐报"，
    // 分子是其中已完成审核公示的那部分——这样长期有大量待审核积压的门店才会
    // 如实展示一个低于 100% 的数字，而不是永远自吹自擂 100%。
    // 两次都是 count()（不拉取文档内容），公开无鉴权接口下增量开销可忽略
    const [totalRecordsCountRes, approvedRecordsCountRes] = await Promise.all([
      db.collection('report_logs').where({ storeId, isVoid: _.neq(true) }).count(),
      db.collection('report_logs').where(_.and([
        { storeId },
        { isVoid: _.neq(true) },
        { approvalStatus: _.in(['APPROVED', 'AUDITED_LOCKED']) }
      ])).count()
    ]);
    const totalRecordsCount = totalRecordsCountRes.total || 0;
    const approvedRecordsCount = approvedRecordsCountRes.total || 0;
    // 没有任何记录时展示为 null，由前端呈现"暂无数据"而不是误导性的 100%/0%
    const ledgerPublicRate = totalRecordsCount > 0
      ? `${Math.round(approvedRecordsCount / totalRecordsCount * 1000) / 10}%`
      : null;

    // 🆕 善信个人爱心足迹（2026-08-31 穿透式阳光模型）：
    //
    // 🛡️ 诚实的架构边界说明——本函数是刻意【无鉴权】的公开接口（见文件头注释），
    // `donationItems` 里的捐赠人姓名是店长/义工日报时手工录入的自由文本，从未
    // 与任何真实身份（OpenID/手机号）绑定过，项目里也不存在一个"善信自助认领
    // 自己捐赠记录"的入口。因此这里能做到的只是：用调用者 OpenID 反查其在
    // user_roles 里登记的 realName（义工/店长/大家长等已绑定角色的账号才会有），
    // 再用这个姓名去匹配本店 donationItems 的姓名字段——是一次尽力而为的姓名
    // 匹配，不是身份级别的精确核验，同名不同人会被误匹配，未登记角色/纯匿名
    // 访客一律拿不到姓名、直接 hasFootprint:false。
    // 🛡️ 与"结缘门店数"字段的诚实映射：本函数按设计只接受单一 storeId、
    // 无跨店聚合能力（避免被当成批量抓取入口，见文件头注释），因此
    // donatedStoresCount 在当前实现里恒为 0 或 1，是面向未来"善信自助认领 +
    // 跨店身份体系"的字段预留，暂不代表真实的多店足迹统计。
    let personalFootprint = {
      totalAmount: 0,
      estimatedMealsCount: 0,
      firstDonationDaysAgo: 0,
      donatedStoresCount: 0,
      hasFootprint: false,
      maskedName: '',
      verificationCode: ''
    };
    try {
      const { OPENID } = cloud.getWXContext();
      if (OPENID) {
        const callerRes = await db.collection('user_roles')
          .where({ _openid: OPENID })
          .field({ realName: true })
          .limit(1)
          .get()
          .catch(() => ({ data: [] }));
        const callerName = ((callerRes.data && callerRes.data[0] && callerRes.data[0].realName) || '').trim();

        if (callerName) {
          let totalAmount = 0;
          let earliestDateStr = '';
          let totalExpenseForMealCost = 0;
          let totalDinersForMealCost = 0;

          records.forEach((r) => {
            totalExpenseForMealCost += parseFloat(r.dailyExpense || r.dailyExpenseTotal || r.ingredientCost || r.dailyIngredientText || 0) || 0;
            totalDinersForMealCost += parseFloat(r.totalDineCount || r.diningCount) || 0;

            const items = Array.isArray(r.donationItems) ? r.donationItems : [];
            items.forEach((item) => {
              if (!item || !item.name || String(item.name).trim() !== callerName) return;
              totalAmount += parseFloat(item.amount) || 0;
              if (r.dateString && (!earliestDateStr || r.dateString < earliestDateStr)) {
                earliestDateStr = r.dateString;
              }
            });
          });

          if (totalAmount > 0 && earliestDateStr) {
            // 🌟 平均单餐成本：本店查询范围内的食材支出 / 服务人次，与
            // getNationalDashboard 的 costPerMeal 同一口径；数据不足（无支出/无
            // 就餐记录）时不编造一个固定单价，estimatedMealsCount 诚实展示为 0
            const avgMealCost = totalDinersForMealCost > 0 && totalExpenseForMealCost > 0
              ? totalExpenseForMealCost / totalDinersForMealCost
              : 0;
            const estimatedMealsCount = avgMealCost > 0 ? Math.round(totalAmount / avgMealCost) : 0;
            const rawDaysAgo = daysBetween(earliestDateStr, todayStr);
            const firstDonationDaysAgo = Number.isFinite(rawDaysAgo) ? Math.max(0, rawDaysAgo) : 0;
            const roundedTotalAmount = Number(totalAmount.toFixed(2));
            const maskedName = maskName(callerName);
            const verificationCode = generateFootprintCode({
              storeId,
              maskedName,
              totalAmount: roundedTotalAmount,
              estimatedMealsCount,
              firstDonationDaysAgo
            });

            personalFootprint = {
              totalAmount: roundedTotalAmount,
              estimatedMealsCount,
              firstDonationDaysAgo,
              donatedStoresCount: 1,
              hasFootprint: true,
              maskedName,
              verificationCode
            };
          }
        }
      }
    } catch (err) {
      // 身份反查/匹配异常一律降级为无足迹，不影响阳光账本主流程
      console.warn('[getSunshineLedger] 个人爱心足迹计算失败（不影响主流程）:', err);
    }

    return {
      success: true,
      storeId,
      storeName,
      orgType,
      periodLabel,
      yearMonth: `${targetYear}-${monthStr}`,
      auditedReportsCount: records.length,
      totalDiners,
      monthlyDiners,
      takeawayMeals,
      // 🆕 与首页录入口径对齐的细分字段，供统计分析页「阳光大盘」重构使用；
      // 上面几个既有字段原样保留，不影响首页「☀️ 阳光账本」弹窗等既有消费方
      dineInCount,
      deliveryCount: takeawayMeals,
      takeawayCount,
      accompanyCount,
      receiptCount,
      totalHours: Math.round(totalHours * 10) / 10,
      volunteerCount,
      operatingDays: operatingDateSet.size,
      ledgerPublicRate,
      yangRatioPct,
      yinRatioPct,
      latestDonors,
      latestDonorsWeekly,
      latestDonorsThreeDay,
      latestDonorsMonthly,
      personalFootprint
    };
  } catch (err) {
    console.error('[getSunshineLedger] 查询异常:', err);
    return { success: false, error: err.message || '查询失败' };
  }
};
