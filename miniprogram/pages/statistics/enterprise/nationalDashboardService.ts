// 🏛️ Open-Core 架构拆分 · 终局阶段：全国大屏（Enterprise）聚合业务逻辑
//
// 本文件是从 pages/statistics/statistics.ts 物理搬迁出来的方法集合，不是
// 独立运行的模块——这些方法最终会被 spread 进 statistics.ts 的 Page({...})
// 对象，运行时与 Core 方法共享同一个页面实例（同一份 this.data/setData）。
// 之所以能这样拆分：微信小程序 Page() 只是把传入对象的所有属性合并到一个
// 组件实例上，方法定义在哪个源文件里不影响运行时 this 绑定与调用方式——
// statistics.ts 里散落的 `this.loadNationalDashboard()` 之类调用点完全不需要
// 跟着搬，只要最终合并结果里存在这个方法即可。
//
// 收录范围：全国大屏数据拉取（loadNationalDashboard）+ SWR 本地快照
// （tryRenderNationalSnapshot/saveNationalSnapshot）、地区/自定义门店筛选、
// 矩阵格式化与支援预警计算、跨店调拨建议文案、全国运营/财务报表 CSV 导出、
// 机构 SaaS 权益看板与套餐升级引导、多店合并 Excel 导出、全国公示海报。
// 不包含「大屏矩阵行点击下钻单店」（见 ./drillDownHandler.ts）与「爱心粮油
// 集采直通车」（见 ./procurementHandler.ts）——task 明确要求三个模块分开，
// 尽管三者在原文件里物理上紧挨在一起。
//
// tsconfig.json 全局关闭了 noImplicitThis/strict，与 statistics.ts 原有写法
// 一致，本文件方法体内的 this 沿用隐式 any，不额外声明 this 参数类型。
import { formatMoney, sanitizeReportForVolunteer } from '../../../utils/dataService';
import { AuthService } from '../../../utils/authService';
import { callFunctionWithTimeout } from '../../../utils/withTimeout';
import { reportCloudSdkErrorIfCorrupted } from '../../../utils/cloudGuard';
import { writeLocalFileSafe } from '../../../utils/localFileCache';
import { canExportNationalExcel, resolveEnterpriseCapabilities } from '../../../utils/enterpriseCapabilities';
import { requestOpenSubscription } from '../../../utils/subscriptionHandoff';
import { getSafeSystemInfo } from '../../../utils/util';
import { formatCompactNumber, formatDate } from '../statistics';

// 🏢 全国大屏平台类型筛选器选项：value 与 stores.orgType 字段一致，仅供
// formatNationalMatrixData/formatSuperAdminInsights 的 orgTypeShortName()
// 内部使用，statistics.wxml 不直接绑定这份列表（未暴露为 data 字段）
const ORG_TYPE_FILTER_OPTIONS = [
  { label: '全部平台', value: 'all', shortName: '全网' },
  { label: '🌸 雨花斋', value: 'yuhuazhai', shortName: '雨花斋' },
  { label: '👵 助老食堂', value: 'elderly_canteen', shortName: '社区助老食堂' },
  { label: '🤝 义工服务站', value: 'volunteer_station', shortName: '义工服务站' }
];

function orgTypeShortName(orgType: string): string {
  const opt = ORG_TYPE_FILTER_OPTIONS.find(o => o.value === orgType);
  return (opt && opt.shortName) || '其他爱心组织';
}

// 🆕 "按地区筛选"省市下拉的轻量方案：不维护全国行政区划静态数据字典（体积大、
// 门店铺开到新省市还要跟着改），province/city 全部动态从 storeDirectory
// （getStoreList 云函数返回的真实门店数据）里提取
function stripRegionSuffix(str: string): string {
  return String(str || '').trim().replace(/(省|市|自治区|特别行政区|地区)$/, '');
}

function dedupeRegionNames(rawValues: string[]): string[] {
  const baseToDisplay = new Map<string, string>();
  rawValues.forEach((raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    const base = stripRegionSuffix(value);
    const existing = baseToDisplay.get(base);
    if (!existing || value.length > existing.length) {
      baseToDisplay.set(base, value);
    }
  });
  return Array.from(baseToDisplay.values());
}

const FALLBACK_BASE_PROVINCES = ['福建省', '广东省', '浙江省', '江苏省', '北京', '上海'];

// 🛡️ 平台客服联系方式：procurementHandler.ts 的「登记合作意向」复用同一份，
// 从这里 export 供其 import，不各自重复维护一份拷贝
export const PLATFORM_SUPPORT_CONTACT = { phone: '15859242258', wechat: 'renfei1888' };

// 🐛 根因修复：全国大屏是跨机构/跨门店的聚合查询，服务端要扫描的数据量远超
// 单店 getReports，withTimeout.ts 的通用默认超时（8000ms）在弱网/冷启动叠加
// 高并发时经常提前判死，实际云函数还在正常跑、只是前端已经先一步展示了
// 失败态。单独为这一次调用放宽超时阈值
const NATIONAL_DASHBOARD_TIMEOUT_MS = 15000;

// 🆕 全国大屏本地快照缓存（SWR：Stale-While-Revalidate）：先渲染上一次的
// 聚合结果，再静默发起真实请求刷新
const NATIONAL_SNAPSHOT_VERSION = 1;
const NATIONAL_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function getNationalSnapshotCacheKey(): string {
  const cached = AuthService.getCachedRoleInfo();
  const tenantId = (cached && cached.tenantId) || 'unknown';
  return 'national_dashboard_snapshot_' + tenantId;
}

export const nationalDashboardHandlers = {
  tryRenderNationalSnapshot(): boolean {
    try {
      const key = getNationalSnapshotCacheKey();
      const snapshot = wx.getStorageSync(key);
      if (!snapshot || typeof snapshot !== 'object') return false;
      if (snapshot.version !== NATIONAL_SNAPSHOT_VERSION) return false;
      if (!snapshot.cachedAt || Date.now() - snapshot.cachedAt > NATIONAL_SNAPSHOT_MAX_AGE_MS) return false;
      if (!snapshot.data || typeof snapshot.data !== 'object') return false;
      this.setData(snapshot.data);
      console.log('[NationalDashboard] 命中本地快照，秒开渲染，随后静默刷新真实数据');
      return true;
    } catch (err) {
      console.warn('[NationalDashboard] 读取本地快照失败:', err);
      return false;
    }
  },

  // 🆕 SWR 快照写入：与本次真实请求成功后落地的 setData payload 完全一致的
  // 字段集合，附带 cachedAt 时间戳与 NATIONAL_SNAPSHOT_VERSION。写入失败
  // （存储配额已满等）不影响本次页面正常展示，只是下次没有快照可用于秒开，
  // 静默吞掉异常，不打断主流程
  saveNationalSnapshot(payload: any) {
    try {
      const key = getNationalSnapshotCacheKey();
      wx.setStorageSync(key, {
        version: NATIONAL_SNAPSHOT_VERSION,
        cachedAt: Date.now(),
        data: payload
      });
    } catch (err) {
      console.warn('[NationalDashboard] 写入本地快照失败:', err);
    }
  },

  async loadNationalDashboard() {
    console.log('[NationalDashboard] 开始拉取全国大屏数据...');
    // 🐛 根因修复（并发雪崩）：initUserRole() 命中本地角色缓存时会先同步触发一次
    // applyRolePermissions()，随后 AuthService.fetchUserRole() 网络请求落地后又
    // 会再触发一次——两次都可能各自独立地走到 loadNationalDashboard()（大家长
    // _autoNationalIntent 分支 / 超管 shouldDefaultToNational 分支），叠加
    // onPatriarchGoNational 等用户主动入口，同一时间窗口内轻易打出两份并发的
    // getNationalDashboard 请求，互相排队拖长响应时间、甚至先返回的那次
    // finally 已经把 loading 置回 false 让后一次重复渲染。这里用 nationalDashboardLoading
    // 本身当请求中防重标志位，同一时刻只允许一次真正在途的调用
    if (this.data.nationalDashboardLoading) return;
    if (!this.data.canViewNationalDashboard) return;
    if (!this.data.isAllStoresMode) return;

    // 🏛️ 架构共识（工作空间 vs 全国大屏双轨制，见 CLAUDE.md）：全国大屏是
    // 社会公信力总览，查看权限不挂钩租户订阅套餐——此前这里有一道
    // checkTenantPermission(MULTI_STORE_DASHBOARD) 拦截，免费版租户的大家长/
    // 财务角色切换组织类型 Tab 时每次请求都会被打回单店视图，界面表现为
    // "点了没反应"。现在查看权限只保留角色卡口（canViewNationalDashboard）+
    // 服务端 tenantId 硬隔离，付费墙只保留在 Excel 批量导出等真正的深度功能上
    // （见 onOpenPlanUpgradeModal('Excel 报表导出') 调用处），不在这里拦截
    //
    // 🆕 SWR 快照秒开（2026-08-31）：仅本次页面生命周期内第一次调用时尝试
    // 命中本地快照——命中则直接渲染缓存数据、不展示阻塞式骨架屏，紧接着
    // 仍然照常发起下面的真实请求做静默刷新；未命中（首次进入且从无缓存/
    // 缓存已过期/版本不匹配，或非首次调用）则退回原有的 loading 骨架屏
    // 体验，行为与升级前完全一致
    const isFirstLoad = !this._nationalDashboardEverLoaded;
    const hasSnapshot = isFirstLoad && this.tryRenderNationalSnapshot();
    this._nationalDashboardEverLoaded = true;
    this.setData({ showNationalDashboard: true, nationalDashboardLoading: !hasSnapshot, nationalDashboardError: '' });

    try {
      // 🛡️ rangeType 仅超管高阶面板使用；云函数侧会再次校验调用者角色，非 super_admin
      // 传了也会被服务端忽略，这里传参不代表前端信任该参数会生效
      // 🆕 filterMode/province/city/storeIds：按地区筛选/自定义门店对比的聚合范围
      // 传参，服务端 getNationalDashboard 会在"已确认属于本机构"的门店集合内做
      // 子集收窄，不传或 filterMode='national' 时行为与升级前完全一致
      const filterMode = this.data.nationalFilterMode || 'national';
      // 🐛 根因修复（精简冗余分类层级）：工作空间进入统计页时早已锁定"雨花公益
      // 食堂专区"这一个业务范围，顶部的平台分类 Tab（全部平台/雨花斋/助老
      // 食堂/义工服务站）是多余的一层——用户已经在专区内，不需要再选一次
      // "看哪个专区"。orgType 固定传 'all'，直接呈现本机构名下的完整爱心网络
      // 大盘，不再依赖已移除的 Tab 选择状态（原 nationalOrgTypeFilter 字段/
      // onOrgTypeFilterChange 分类切换逻辑一并删除，见 statistics.wxml
      // org-type-filter-scroll 移除处注释）
      const callParams: any = { rangeType: this.data.nationalRangeType, filterMode, orgType: 'all' };
      if (filterMode === 'region') {
        callParams.province = this.data.selectedProvince || '';
        callParams.city = this.data.selectedCity || '';
      } else if (filterMode === 'custom') {
        callParams.storeIds = this.data.customStoreSelection || [];
      }
      console.log('[DEBUG] 准备调用 getNationalDashboard，传入参数：', callParams);

      // 见 NATIONAL_DASHBOARD_TIMEOUT_MS 声明处注释——只这一次调用放宽超时，
      // 不影响其余调用点仍使用 withTimeout.ts 的默认 8000ms
      const result = await callFunctionWithTimeout({
        name: 'getNationalDashboard',
        data: callParams
      }, NATIONAL_DASHBOARD_TIMEOUT_MS);

      console.log('[DEBUG] getNationalDashboard 返回原始结果：', result);

      const r = result.result as any;
      // 🐛 DEBUG：本云函数的响应体没有 data/errMsg 字段（见 cloudfunctions/
      // getNationalDashboard/index.js 的 return 语句），成功时是 nationalSummary/
      // storeMatrix/superAdminInsights，失败时业务错误信息在 r.error（result.errMsg
      // 是 wx.cloud.callFunction 这层 SDK 调用失败才会有的字段，业务上的失败走的是
      // success:false + error，这里按真实响应结构打印，不按不存在的字段名瞎打）
      console.log('[DEBUG] getNationalDashboard 业务数据 result.nationalSummary/storeMatrix：', r && r.nationalSummary, r && r.storeMatrix);
      console.log('[DEBUG] getNationalDashboard 业务报错信息 result.error：', r && r.error);

      if (r && r.success) {
        // 🛡️ 客户端第二层脱敏防线：云函数出口已按角色做过服务端脱敏，
        // 这里对拿到的数据再跑一遍同名 sanitizeReportForVolunteer，双重兜底
        const role = this.data.currentUserRole;
        const sanitizedSummary = sanitizeReportForVolunteer(r.nationalSummary || {}, role);
        // 🆕 大额数值紧凑展示：只新增 *Display 展示字段，不覆盖原始数值——
        // nationalTotalDiners 等原始字段仍保留（wxml 的"是否已加载完成"判据、
        // formatSuperAdminInsights 内部计算都还依赖它们的原始数值语义）
        // 📊 长者服务结构比例条：堂食/送餐/倾听三维度各自占比（保留一位小数，四舍五入，
        // 三项之和因取整可能差 ±1%，属正常现象，不影响阅读）。
        // 任一维度都没有数据时，比例条不渲染（WXML 侧已有 > 0 的 wx:if 保护）
        const dineIn   = sanitizedSummary.nationalDineInSeniors   || 0;
        const delivery = sanitizedSummary.nationalDeliverySeniors || 0;
        const listen   = sanitizedSummary.nationalListeningSeniors || 0;
        const careTotal = dineIn + delivery + listen;
        const dineInRatioPct   = careTotal > 0 ? Math.round(dineIn   / careTotal * 1000) / 10 : 0;
        const deliveryRatioPct = careTotal > 0 ? Math.round(delivery / careTotal * 1000) / 10 : 0;
        const listenRatioPct   = careTotal > 0 ? Math.round(listen   / careTotal * 1000) / 10 : 0;

        // 🆕 义工与用餐统计·底栏自动汇总：8 项基础指标里的前 7 项（堂食/送餐长者、
        // 打包份数、到岗/送餐义工、倾听陪伴、服务工时）云函数早已聚合好
        // （nationalDineInSeniors 等字段），这里只补 3 个纯客户端算术派生值：
        //   用餐总数           = 堂食长者 + 送餐长者 + 打包份数（不含服务工时，单位不同）
        //   志愿者总人次       = 到岗义工 + 送餐义工
        //   总人次自动汇总     = 用餐总数 + 志愿者总人次 + 倾听陪伴长者
        //   （六项"人次"类指标的总和；服务工时单位是"小时"，不计入这个人次汇总）
        const takeaway = sanitizedSummary.nationalTakeawayCount || 0;
        const onDutyVolunteers = sanitizedSummary.nationalTotalVolunteers || 0;
        const deliveryVolunteers = sanitizedSummary.nationalDeliveryVolunteers || 0;
        const totalDiningCount = dineIn + delivery + takeaway;
        const totalVolunteerPersonTimes = onDutyVolunteers + deliveryVolunteers;
        const totalServicePersonTimes = totalDiningCount + totalVolunteerPersonTimes + listen;

        // 🌸 全网爱心支持与善缘墙（超管 & 专业版全国大屏专属）：与个人页「发心分布」
        // 比例条（profile.ts fetchStoreLoveWallSummary，单店口径）是两套独立计算。
        // 这里直接展示云函数已聚合好的 totalSupportCount/yangshanCount/yindeCount/
        // yangshanAmount/yindeAmount（全租户全门店口径，通过上面 ...sanitizedSummary
        // 展开带出，金额已 toFixed(2) 处理好），不需要在客户端再额外计算占比

        const displaySummary = {
          ...sanitizedSummary,
          nationalTotalDinersDisplay: formatCompactNumber(sanitizedSummary.nationalTotalDiners),
          nationalTotalIncomeDisplay: formatCompactNumber(sanitizedSummary.nationalTotalIncome),
          nationalTotalExpenseDisplay: formatCompactNumber(sanitizedSummary.nationalTotalExpense),
          totalDiningCount,
          totalVolunteerPersonTimes,
          totalServicePersonTimes,
          dineInRatioPct,
          deliveryRatioPct,
          listenRatioPct,
          // 🏛️（2026-08-31 Open-Core 架构拆分）预先算好的商业能力矩阵，供 WXML
          // 直接绑定 nationalData.enterpriseCapabilities.xxx，不再依赖
          // subscriptionQuota.features 的具体嵌套形状——见 utils/enterpriseCapabilities.ts
          // 头部注释
          enterpriseCapabilities: resolveEnterpriseCapabilities(sanitizedSummary.subscriptionQuota)
        };
        const sanitizedMatrix = sanitizeReportForVolunteer(r.storeMatrix || [], role);
        const cleanedMatrix = this.formatNationalMatrixData(sanitizedMatrix);
        // 🆕 多店排行榜：storeMatrix 服务端已按 totalDiners 降序返回（见
        // getNationalDashboard），这里再显式排一次序（不依赖调用方约定不变）+
        // 按 openDays（本次统计窗口内实际提交过餐报的天数，即"报表活跃度"）
        // 单独排一份——两份榜单都是纯客户端对已拿到手的同一份 matrix 数据重新
        // 排序取 Top 5，不需要为此再发一次云函数请求
        const topDinersStores = cleanedMatrix.slice().sort((a: any, b: any) => (b.totalDiners || 0) - (a.totalDiners || 0)).slice(0, 5);
        const topActiveStores = cleanedMatrix.slice().sort((a: any, b: any) => (b.openDays || 0) - (a.openDays || 0)).slice(0, 5);
        const supportNeededStores = this.deriveSupportNeededStores(cleanedMatrix);
        // 🆕 SWR 快照：与本次真正 setData 的字段集合保持完全一致（同一个
        // 对象字面量，不是照着抄一份可能悄悄漂移的拷贝），下次冷启动/重新
        // 进入全国大屏时用它秒开首屏，见 tryRenderNationalSnapshot()
        const snapshotPayload = {
          nationalData: displaySummary,
          nationalMatrixList: cleanedMatrix,
          nationalTopDinersStores: topDinersStores,
          nationalTopActiveStores: topActiveStores,
          supportNeededStores,
          // 非超管时云函数恒返回 null，这里原样落地，高阶面板 wx:if 会自动不渲染
          superAdminInsights: this.formatSuperAdminInsights(r.superAdminInsights, sanitizedSummary),
          // 🆕 影像墙平台徽章：每张图云函数已带上 orgType 原始值，转成短文案
          nationalMediaGallery: (r.superAdminInsights && Array.isArray(r.superAdminInsights.nationalMediaGallery))
            ? r.superAdminInsights.nationalMediaGallery.map((g: any) => ({ ...g, orgTypeLabel: orgTypeShortName(g.orgType) }))
            : [],
          // 🆕 顶部横幅机构名：见 data.currentTenantName 声明处注释
          currentTenantName: r.tenantName || ''
        };
        this.setData(snapshotPayload);
        this.saveNationalSnapshot(snapshotPayload);

        // 🔢 义工与用餐服务数据看板：数据落地后驱动一次 0 → 目标值的滚动动画。
        // 🆕 SWR 快照命中时跳过这次动画——数字在快照渲染那一刻就已经是正确
        // 值了，若真实数据回来后再从 0 重新滚动一遍，视觉上会变成"数字先对、
        // 后归零、再滚回来"的诡异闪烁，只有本次是"从无到有"首次落地数据时
        // 才需要这个动画
        if (!hasSnapshot) {
          this.animateCareCountUp({
            dineIn,
            delivery,
            takeaway,
            listen,
            onDutyVolunteers,
            deliveryVolunteers,
            volunteerHours: sanitizedSummary.nationalTotalVolunteerHours || 0,
            totalDiningCount,
            totalVolunteerPersonTimes,
            totalServicePersonTimes
          });
        }
      } else {
        // 🐛 根因修复：此前云函数返回 success:false（例如账号缺 tenantId、无权限）
        // 时什么反馈都没有，容器又靠 nationalData 是否有值来决定渲不渲染，
        // 用户只会看到点了"全部门店"后界面空白，不知道发生了什么
        const errMsg = (r && r.error) || '全国总览加载失败，请重试';
        this.setData({ nationalDashboardError: errMsg });
        wx.showToast({ title: errMsg, icon: 'none', duration: 4000 });
      }
    } catch (err: any) {
      console.error('[loadNationalDashboard] 加载失败:', err);
      reportCloudSdkErrorIfCorrupted(err);
      const errMsg = (err && err.errMsg) || '网络异常，全国总览加载失败';
      this.setData({ nationalDashboardError: errMsg });
      wx.showToast({ title: errMsg, icon: 'none', duration: 4000 });
    } finally {
      this.setData({ nationalDashboardLoading: false });
    }
  },

  // 🆕 门店目录懒加载：地区筛选的省市级联 picker、自定义门店勾选列表都依赖这份
  // {storeId,storeName,province,city}[] 数据，复用已有的 getStoreList 云函数
  // （本就按 tenantId 隔离，见该云函数注释），只在首次用到时才请求一次，之后
  // 两个筛选入口共用同一份缓存，不重复查询。返回 false 代表加载失败，调用方
  // 应放弃本次打开弹窗的操作
  async ensureStoreDirectory(): Promise<boolean> {
    if (this.data.storeDirectory.length > 0) return true;
    try {
      const res: any = await callFunctionWithTimeout({ name: 'getStoreList', data: {} });
      const result = res.result;
      if (!result || !result.success || !Array.isArray(result.list)) {
        wx.showToast({ title: '门店目录加载失败，请重试', icon: 'none' });
        return false;
      }
      const storeDirectory = result.list.map((s: any) => ({
        storeId: s.storeId,
        storeName: s.storeName,
        province: s.province || '',
        city: s.city || ''
      }));
      // 🐛 根因修复：下拉只有"全部省份"——此前 province 选项直接对原始字符串去重，
      // 门店档案 province/city 是自由文本（见 manageStoreProfile），真实数据经常
      // 缺失/写法不一致，一旦所有门店都还没填这两个字段，Set 去重后就是空数组，
      // 下拉自然只剩兜底占位项。现在有实际门店省份时优先展示（真实数据源），
      // 完全没有时才退回 FALLBACK_BASE_PROVINCES 这份轻量基础名单，保证下拉
      // 至少有得选；一旦有门店真正填了省份，这份兜底名单会被真实数据自然取代
      const storeProvinces = dedupeRegionNames(storeDirectory.map((s: any) => s.province));
      const provincePickerOptions = ['全部省份'].concat(
        storeProvinces.length > 0 ? storeProvinces : FALLBACK_BASE_PROVINCES
      );
      const cityPickerOptions = ['全部城市'].concat(
        dedupeRegionNames(storeDirectory.map((s: any) => s.city))
      );
      this.setData({ storeDirectory, provincePickerOptions, cityPickerOptions });
      return true;
    } catch (err) {
      console.error('[ensureStoreDirectory] 门店目录加载异常:', err);
      reportCloudSdkErrorIfCorrupted(err);
      wx.showToast({ title: '网络异常，门店目录加载失败', icon: 'none' });
      return false;
    }
  },

  async openRegionFilterModal() {
    const ok = await this.ensureStoreDirectory();
    if (!ok) return;
    this.setData({
      showRegionFilterModal: true,
      // 每次重新打开都先收起两个下拉面板，不携带上一次关闭前可能残留的展开态
      showProvinceDropdown: false,
      showCityDropdown: false
    });
  },

  onCancelRegionFilter() {
    this.setData({ showRegionFilterModal: false, showProvinceDropdown: false, showCityDropdown: false });
  },

  // 🐛 根因修复：双重弹窗冲突——此前省份/城市用原生 <picker mode="selector">，
  // 点击后会在已经打开的半屏自定义弹窗（.patch-modal-mask）之上再叠加一层系统
  // 原生底部选择器，两层弹层互相遮挡/抢占焦点，交互体验混乱。改为弹窗内部的
  // 内嵌式下拉列表——点击触发器只在同一个弹窗内展开/收起一个绝对定位的选项
  // 面板（见 wxml .region-dropdown-list 与其 position:absolute 样式），不再
  // 调用任何原生弹层。两个下拉互斥：展开一个时自动收起另一个
  onToggleProvinceDropdown() {
    this.setData({ showProvinceDropdown: !this.data.showProvinceDropdown, showCityDropdown: false });
  },

  onToggleCityDropdown() {
    this.setData({ showCityDropdown: !this.data.showCityDropdown, showProvinceDropdown: false });
  },

  // 省份选项点击：联动收窄城市下拉的可选项——只保留该省份下 storeDirectory
  // 里真实存在的城市，不重新发起查询。与原 onRegionProvinceChange（原生 picker
  // 版）同一套收窄逻辑，只是触发来源从 picker 的 bindchange 换成列表项的 bindtap。
  // 🐛 按去后缀的基准名比较（而非严格 === ），门店档案里"福建"/"福建省"这类
  // 写法差异也能正确匹配到同一个选中的省份，不会因为后缀不一致而查出 0 家门店
  onSelectProvinceOption(e: any) {
    const idx = e.currentTarget.dataset.index;
    const options = this.data.provincePickerOptions;
    const province = idx === 0 ? '' : options[idx];
    const provinceBase = stripRegionSuffix(province);
    const cityPickerOptions = ['全部城市'].concat(
      dedupeRegionNames(
        this.data.storeDirectory
          .filter((s: any) => !province || stripRegionSuffix(s.province) === provinceBase)
          .map((s: any) => s.city)
      )
    );
    this.setData({
      selectedProvinceIndex: idx,
      selectedProvince: province,
      cityPickerOptions,
      selectedCityIndex: 0,
      selectedCity: '',
      showProvinceDropdown: false
    });
  },

  onSelectCityOption(e: any) {
    const idx = e.currentTarget.dataset.index;
    const options = this.data.cityPickerOptions;
    const city = idx === 0 ? '' : options[idx];
    this.setData({ selectedCityIndex: idx, selectedCity: city, showCityDropdown: false });
  },

  onConfirmRegionFilter() {
    const { selectedProvince, selectedCity } = this.data;
    const label = (selectedProvince || selectedCity)
      ? `📍 ${[selectedProvince, selectedCity].filter(Boolean).join('·')}`
      : '📍 全部地区';
    this.setData({
      nationalFilterMode: 'region',
      isAllStoresMode: true,
      showNationalDashboard: true,
      showRegionFilterModal: false,
      showProvinceDropdown: false,
      showCityDropdown: false,
      shopName: '全部门店',
      currentUserStoreName: label
    });
    // 🛡️ filterMode:'region' 下，loadNationalDashboard() 会从 this.data.selectedProvince/
    // selectedCity 拼装 { filterMode:'region', province, city } 传给 getNationalDashboard
    // 云函数（见该方法内 callParams 构建逻辑），这里的 setData 已经落好这两个字段，
    // 无需在这里重复传参
    this.loadNationalDashboard();
  },

  async openCustomStoreModal() {
    const ok = await this.ensureStoreDirectory();
    if (!ok) return;
    // 每次打开都从 storeDirectory 重建草稿列表，把上一次已确认的
    // customStoreSelection 回填成对应项的 checked:true，避免重开弹窗时丢失
    // 上次的选择；搜索框每次重开都清空，matchesSearch 全部重置为可见
    const selectedSet = new Set(this.data.customStoreSelection);
    const customStoreDraftList = this.data.storeDirectory.map((s: any) => ({
      storeId: s.storeId,
      storeName: s.storeName,
      province: s.province || '',
      city: s.city || '',
      checked: selectedSet.has(s.storeId),
      matchesSearch: true
    }));
    const customStoreProvinceChips = Array.from(
      new Set(customStoreDraftList.map(s => s.province).filter(Boolean))
    );
    this.setData({
      customStoreDraftList,
      customStoreDraftCheckedCount: customStoreDraftList.filter(s => s.checked).length,
      customStoreSearchKeyword: '',
      customStoreProvinceChips,
      showCustomStoreModal: true
    });
  },

  onCancelCustomStores() {
    this.setData({ showCustomStoreModal: false });
  },

  // 🆕 门店名称搜索框：按关键字重新计算每一项的 matchesSearch（同作用域字段，
  // wx:if 直接读取），而不是在 wx:for 表达式里对"顶层 keyword + 循环变量"做
  // 混合字符串匹配——避免重蹈 checked 状态那类跨作用域表达式的重渲染追踪问题
  onCustomStoreSearchInput(e: any) {
    const keyword = String(e.detail.value || '').trim().toLowerCase();
    const customStoreDraftList = this.data.customStoreDraftList.map(s => ({
      ...s,
      matchesSearch: !keyword || s.storeName.toLowerCase().includes(keyword)
    }));
    this.setData({ customStoreSearchKeyword: keyword, customStoreDraftList });
  },

  // 🆕 按省份一键全选：把该省份下所有门店的 checked 置为 true（不清空其他
  // 省份已勾选的门店），供跨店对比时快速圈定"整个省份"这一常见场景
  onSelectAllByProvince(e: any) {
    const province = e.currentTarget.dataset.province;
    if (!province) return;
    let addedCount = 0;
    const customStoreDraftList = this.data.customStoreDraftList.map(s => {
      if (s.province === province && !s.checked) {
        addedCount++;
        return { ...s, checked: true };
      }
      return s;
    });
    if (addedCount === 0) return;
    this.setData({
      customStoreDraftList,
      customStoreDraftCheckedCount: this.data.customStoreDraftCheckedCount + addedCount
    });
  },

  // 🐛 根因修复：勾选框状态不同步——此前 checked 靠
  // customStoreDraftSelection.includes(store.storeId) 这个跨作用域计算表达式
  // 驱动，checkbox-group 的聚合 bindchange 回传"当前所有已勾选项 value 数组"后
  // 反推每一行是否命中，WXML 对这类表达式的重渲染依赖追踪不可靠，容易出现勾选
  // 图标与真实选中状态脱节。改为点击整行时，只更新这一项自己身上的 checked
  // 字段——用精确下标路径 setData（wx:for 列表单项更新的标准写法），并同步更新
  // 已选计数，确保图标与数据状态始终一致
  onToggleCustomStoreDraft(e: any) {
    const index = e.currentTarget.dataset.index;
    const list = this.data.customStoreDraftList;
    const target = list[index];
    if (!target) return;
    const nextChecked = !target.checked;
    this.setData({
      [`customStoreDraftList[${index}].checked`]: nextChecked,
      customStoreDraftCheckedCount: this.data.customStoreDraftCheckedCount + (nextChecked ? 1 : -1)
    });
  },

  onConfirmCustomStores() {
    const checkedStores = this.data.customStoreDraftList.filter(s => s.checked);
    if (checkedStores.length === 0) {
      wx.showToast({ title: '请至少勾选一家门店', icon: 'none' });
      return;
    }
    const selection = checkedStores.map(s => s.storeId);
    const label = checkedStores.length === 1
      ? `🏬 ${checkedStores[0].storeName}`
      : `🏬 自定义(${checkedStores.length}家门店)`;
    this.setData({
      customStoreSelection: selection,
      nationalFilterMode: 'custom',
      isAllStoresMode: true,
      showNationalDashboard: true,
      showCustomStoreModal: false,
      shopName: '全部门店',
      currentUserStoreName: label
    });
    this.loadNationalDashboard();
  },

  // 全国大屏顶部"更改筛选"入口：按当前生效的 nationalFilterMode 重新打开对应弹窗
  onChangeNationalFilter() {
    if (this.data.nationalFilterMode === 'region') {
      this.openRegionFilterModal();
    } else if (this.data.nationalFilterMode === 'custom') {
      this.openCustomStoreModal();
    }
  },

  // 🔐 专业版功能拦截弹窗：utils/tenantPermission.ts 原来的 promptTenantUpgrade()
  // 用的是原生 wx.showModal——原生弹窗按钮完全渲染在 webview/WXML 之外，没有
  // 任何 class/id 可挂，WXSS 对它的按钮布局零控制力。这里改为页面自有的自定义
  // 半屏卡片弹窗，"知道了"/"去反馈"两个按钮才能真正用 flex 强制居中重构样式
  // 大家长快捷入口：统计页右上角"全国看板 ↗"按钮，直接进入全国大屏
  onPatriarchGoNational() {
    if (!this.data.isPatriarch) return;
    this._triggerPatriarchNationalView();
  },

  // 大家长全国看板统一触发入口（onPatriarchGoNational + _autoNationalIntent 共用）：
  // 🏛️ 架构共识（工作空间 vs 全国大屏双轨制，见 CLAUDE.md）：全国大屏查看权限
  // 不挂钩订阅套餐，此前这里的 checkTenantPermission(MULTI_STORE_DASHBOARD)
  // 订阅拦截已移除——免费版租户的大家长直接进入全国视图，与超管/其它角色
  // 待遇一致；真正的付费墙留在 Excel 批量导出等深度功能上
  async _triggerPatriarchNationalView() {
    this.setData({ isAllStoresMode: true });
    await this.loadNationalDashboard();
  },

  // 🌟 featureName：具体触发这次拦截的功能名（如"Excel 报表导出"，见
  // CLAUDE.md 双轨制架构——全国大屏查看已免费，付费墙目前只剩这一类深度
  // 功能），拼进 feature-locked-modal 组件的提示文案；不传时组件自己兜底成
  // "该功能"。大家长/超管分支不弹这个轻量拦截弹窗——直接设交接标记后跳个人
  // 中心，profile.onShow 检测到标记会自动唤起详细的套餐订购/权益对比弹窗
  // （唯一维护权益文案的地方，见 profile.ts showSubscriptionModal），不再
  // 出现死循环 Toast
  onOpenPlanUpgradeModal(featureName?: string) {
    if (this.data.isPatriarch || this.data.isAdmin) {
      requestOpenSubscription();
      wx.switchTab({ url: '/pages/profile/profile' });
    } else {
      this.setData({ showPlanUpgradeModal: true, planUpgradeFeatureName: featureName || '该功能' });
    }
  },

  onClosePlanUpgradeModal() {
    this.setData({ showPlanUpgradeModal: false });
  },

  // 🐛 修复"全国平均单餐成本"异常金额：云函数已按 nationalTotalDiners>0 兜底过一次，
  // 但活跃门店数为 0（例如切到"近7天"等窄区间恰好全员离线）时同样不该展示一个具体金额——
  // 分母门店数为 0 时哪怕算出的数值本身不是 NaN，也不代表"真实的单餐成本"，这里补上
  // activeStoreCount 维度的兜底，并统一格式化成两位小数字符串，避免 wxml 直接吐出裸数字 0
  formatSuperAdminInsights(insights: any, summary: any): any {
    if (!insights) return null;

    const totalDiners = Number(summary && summary.nationalTotalDiners) || 0;
    const activeStoreCount = Number(insights.activeStoreCount) || 0;
    const rawAvgCost = Number(insights.avgCostPerMeal);

    const avgCostPerMealStr = (activeStoreCount <= 0 || totalDiners <= 0 || !isFinite(rawAvgCost))
      ? '—'
      : formatMoney(rawAvgCost);

    // 🆕 离线门店预警平台徽章：insights.offlineStores 每项已由云函数带上 orgType 原始值
    const offlineStores = Array.isArray(insights.offlineStores)
      ? insights.offlineStores.map((s: any) => ({ ...s, orgTypeLabel: orgTypeShortName(s.orgType) }))
      : insights.offlineStores;

    return {
      ...insights,
      avgCostPerMealStr,
      offlineStores
    };
  },

  // 超管高阶面板：切换"近7天/本月/本季度/全部时间"，重新拉取云函数聚合数据
  onSwitchNationalRange(e: any) {
    const rangeType = e.currentTarget.dataset.range;
    if (!rangeType || rangeType === this.data.nationalRangeType) return;
    this.setData({ nationalRangeType: rangeType });
    this.loadNationalDashboard();
  },

  // 一键快筛：正常运营门店 / 需关注预警门店——纯本地过滤 wx:if，数据已在 nationalMatrixList 里，不重新请求
  onSwitchMatrixFilter(e: any) {
    const filter = e.currentTarget.dataset.filter;
    if (!filter || filter === this.data.storeMatrixFilter) return;
    this.setData({ storeMatrixFilter: filter });
  },

  // 排行榜 Tab 切换：餐报活跃度 / 服务人次——两份榜单已在 loadNationalDashboard 里
  // 一次性算好（nationalTopActiveStores/nationalTopDinersStores），这里只切换展示
  onSwitchRankingTab(e: any) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.rankingTab) return;
    this.setData({ rankingTab: tab });
  },

  // 🆘 支援预警队列：遍历已格式化的 storeMatrix，对每家门店计算综合风险得分，
  // 筛出得分 > 0 的门店并按分值降序返回，供 WXML 渲染「门店健康度告警中心」面板。
  //
  // 🆕（2026-08-30 动态续航预测引擎）得分维度改用服务端新版字段：
  //   +45  isSeriouslyOffline：超过 7 天未提交餐报（失联，运营中断风险最高）
  //   +30  isOffline（未达"失联"程度）：超过 3 天未提交餐报
  //   +40  healthStatus === 'CRITICAL'：资金续航 ≤7 天
  //   +20  healthStatus === 'WARNING'：资金续航 8~15 天
  //   +20  latestBalance < 0：账面已出现赤字
  //   +10  hasRiskFlag：凭证合规率 < 100%（仅超管视角下发此字段）
  //   +25  stapleUrgent：主料（大米/食用油）库存告急——与资金续航是独立维度，
  //        资金健康但恰好断粮的门店也需要被这份告警中心捕捉到
  //   +15  volunteerDeficit（2026-08-31 新增）：近7天日均出勤义工数 < 3 人，
  //        "资金-物资-义工"三维健康度监控的第三个维度，权重略低于资金/主料——
  //        义工短缺通常有更长的缓冲期去补位，不像断粮/资金告急那样紧迫
  // healthStatus === 'NEW_STORE'（新店爬坡中，开餐天数 < 3 天）直接跳过，不计
  // 入告警中心——样本量太小，不构成"需要支援"的信号，只是还没攒够数据。
  //
  // reasonTags 优先直接复用服务端 alertTags（getNationalDashboard 已按同一套
  // 优先级组装好文案：离线/失联 → 凭证合规 → 资金告急/预警），不再客户端重新
  // 拼一遍措辞，避免两处文案/权重日后各自漂移不一致；账面赤字是服务端目前
  // 没有转成文案标签的信号，这里作为补充追加。
  deriveSupportNeededStores(stores: any[]): any[] {
    const result: any[] = [];

    for (const s of stores) {
      if (s.healthStatus === 'NEW_STORE') continue;

      let score = 0;
      if (s.isSeriouslyOffline) {
        score += 45;
      } else if (s.isOffline) {
        score += 30;
      }
      if (s.healthStatus === 'CRITICAL') {
        score += 40;
      } else if (s.healthStatus === 'WARNING') {
        score += 20;
      }
      const balance = parseFloat(s.latestBalance ?? s.balance ?? 'NaN');
      const hasDeficit = !isNaN(balance) && balance < 0;
      if (hasDeficit) {
        score += 20;
      }
      if (s.hasRiskFlag) {
        score += 10;
      }
      if (s.stapleUrgent) {
        score += 25;
      }
      if (s.volunteerDeficit) {
        score += 15;
      }

      if (score === 0) continue;

      // 严重程度标签：用于 WXML 选择呼吸灯颜色
      const severity: 'critical' | 'high' | 'medium' =
        score >= 55 ? 'critical' : score >= 30 ? 'high' : 'medium';

      const location = [s.province, s.city].filter(Boolean).join('·');
      const reasonTags: string[] = Array.isArray(s.alertTags) ? [...s.alertTags] : [];
      if (hasDeficit) {
        reasonTags.push(`账面赤字（¥${Math.abs(balance).toFixed(0)}）`);
      }
      if (reasonTags.length === 0) {
        reasonTags.push('需关注');
      }

      result.push({ ...s, supportScore: score, severity, reasonTags, location });
    }

    // 按得分降序，最多展示 10 条（防止全国性事件时卡片无限膨胀）
    return result.sort((a: any, b: any) => b.supportScore - a.supportScore).slice(0, 10);
  },

  // 🆕 失联告警一键督导触达（2026-08-31）：一键联系——managerPhone 只在
  // CRITICAL/OFFLINE 门店由服务端下发（getNationalDashboard 只对
  // isSuperAdmin || isPatriarchCaller 附带这个字段，其余角色本就看不到本卡片，
  // 见 WXML wx:if="isPatriarch || isAdmin"），没有登记电话时不留一个点了没
  // 反应的死按钮，退而求其次复制门店名称，方便用户自己在通讯录/群聊里找人
  onCallStoreManager(e: any) {
    const item = (e.currentTarget.dataset.item || {}) as any;
    const phone = item.managerPhone;
    if (!phone) {
      wx.setClipboardData({
        data: item.storeName || '',
        success: () => wx.showToast({ title: '暂未登记店长电话，已复制门店名称', icon: 'none', duration: 2500 })
      });
      return;
    }
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => wx.showToast({ title: '拨号失败，请手动拨打', icon: 'none' })
    });
  },

  // 🆕 督导关怀：按 reasonTags 的优先级（失联→离线→资金→主料→合规，与
  // deriveSupportNeededStores 的加分权重排序一致）挑一句最贴切的具体原因，
  // 不逐条堆砌，保持关怀文案简洁自然、像真人写的而不是系统日志
  onCopyCareMessage(e: any) {
    const item = (e.currentTarget.dataset.item || {}) as any;
    const location = item.location ? `【${item.location}】` : '';
    const managerLabel = item.managerName ? `${item.managerName}店长` : `${item.storeName || '门店'}店长`;
    const tags: string[] = Array.isArray(item.reasonTags) ? item.reasonTags : [];

    // 🐛 2026-08-31 二次迭代：失联/离线场景的措辞对齐最新规范给定的精确文案
    // （"已多日未提交日报"/"请问近期运营或物资是否需要支持？"），其余场景
    // 沿用同一条收尾问句，保持模板统一、不为每种告警各自维护一套问法
    let concern = '门店近期运营情况';
    if (tags.some((t: string) => t.indexOf('失联') !== -1) || tags.some((t: string) => t.indexOf('离线') !== -1)) {
      concern = '门店已多日未提交日报';
    } else if (tags.some((t: string) => t.indexOf('资金') !== -1)) {
      concern = '门店资金续航偏紧';
    } else if (tags.some((t: string) => t.indexOf('主料') !== -1)) {
      concern = '门店主料库存偏紧';
    } else if (tags.some((t: string) => t.indexOf('合规') !== -1)) {
      concern = '门店凭证合规率有待补齐';
    } else if (tags.some((t: string) => t.indexOf('赤字') !== -1)) {
      concern = '门店账面出现赤字';
    }

    const message = `【雨花爱心关怀】${location}${managerLabel}您好，系统检测到${concern}，请问近期运营或物资是否需要支持？`;
    wx.setClipboardData({
      data: message,
      success: () => wx.showToast({ title: '关怀文案已复制，可直接粘贴发送', icon: 'none', duration: 2500 })
    });
  },

  // 🆕 复制跨店调拨/劝募建议文案（2026-08-31）：与 rebalanceSuggestions 的
  // 两种情形一一对应——撮合到支援门店时生成一段"请求平调"的协同话术，
  // 撮合不到时改生成一段面向公众的"定向劝募"话术，方便大家长直接粘贴到
  // 微信工作群/朋友圈发起协调
  onCopyRebalanceSuggestion(e: any) {
    const item = (e.currentTarget.dataset.item || {}) as any;
    let message: string;
    if (item.sourceStoreName) {
      message = `【雨花爱心网络协同】${item.targetStoreName}${item.urgency === 'HIGH' ? '近期资金续航紧张' : '近期主料库存偏紧'}，${item.sourceStoreName}资金续航相对充裕（约${item.sourceFundingDays}天），恳请${item.sourceStoreName}大家长/店长协助进行一次爱心平调支援，双方可直接联系具体协商，感恩！`;
    } else {
      message = `【雨花爱心倡议】${item.targetStoreName}${item.reason || '近期运营遇到困难'}，同城/同省暂无充裕门店可平调，恳请各界爱心人士与机构伸出援手，助力门店渡过难关，感恩！`;
    }
    wx.setClipboardData({
      data: message,
      success: () => wx.showToast({ title: '建议文案已复制，可直接粘贴发送', icon: 'none', duration: 2500 })
    });
  },

  formatNationalMatrixData(rawStores: any[]): any[] {
    return rawStores.map((store: any) => {
      const diners = parseInt(store.totalDiners || store.diningCount || 0);

      // 🌟 志工只读脱敏视角：服务端已将 costPerMeal 等成本字段置空并标记 isCostRestricted，
      // 此时不再尝试用（同样被脱敏的）收支字段反推成本，直接展示统一遮罩文案
      let costPerMealStr = '';
      let isCostValid = false;

      if (store.isCostRestricted) {
        costPerMealStr = '***（仅店长可见）';
        isCostValid = false;
      } else {
        const foodExpense = parseFloat(store.foodExpense || store.dailyExpenseTotal || store.ingredientExpense || 0);
        if (diners > 0 && foodExpense > 0) {
          costPerMealStr = `¥${(foodExpense / diners).toFixed(2)}/餐`;
          isCostValid = true;
        } else if (foodExpense === 0) {
          // 🌟 去内卷文案：不用带背景框的"无日常开销"标签制造"这家店有问题"的观感，
          // 统一改成中性、不带底色徽章的"暂无支出"——见 statistics.wxml 里
          // isCostValid 为 false 且 costPerMealStr 命中这个值时不再套 .cost-badge 底色
          costPerMealStr = '暂无支出';
        } else {
          costPerMealStr = '筹备中';
        }
      }

      let statusLevel: 'ample' | 'warning' | 'urgent' | 'nodata' = 'nodata';
      let statusText = '';

      // 🌟 精确续航天数属于可反推资金余额的财务隐私：志工脱敏响应中 fundingDays 已被
      // 服务端置空，但定性的 healthStatus 标签依然保留——因此这里优先按 healthStatus
      // 判断状态标签，仅当 fundingDays 是真实数字时才在文案里附上具体天数（管理者视角）
      const hasExactDays = typeof store.fundingDays === 'number';

      // 🆕（2026-08-30 动态续航预测引擎）healthStatus 枚举改为大写四态：
      // NEW_STORE（开餐天数 < 3 天，样本太小不评级）/ HEALTHY / WARNING / CRITICAL
      if (store.healthStatus === 'NEW_STORE') {
        // 🐛 "告急(0天)"误报修复：新店/无结余数据时服务端已经把 healthStatus
        // 明确标成 'NEW_STORE'（而不是拿默认值 0 硬算出一个假的"资金告急"），
        // 这里对应展示中性的"新店筹备中"，不制造不必要的焦虑感
        statusLevel = 'nodata';
        statusText = '⚪ 新店筹备中';
      } else if (store.healthStatus === 'HEALTHY') {
        statusLevel = 'ample';
        statusText = hasExactDays ? `🟢 充足(${store.fundingDays}天)` : '🟢 充足';
      } else if (store.healthStatus === 'WARNING') {
        statusLevel = 'warning';
        statusText = hasExactDays ? `🟡 注意(${store.fundingDays}天)` : '🟡 注意';
      } else if (store.healthStatus) {
        // 'CRITICAL' 及其他未识别取值，一律按告急处理（历史即有的兜底口径，不改变含义）
        statusLevel = 'urgent';
        statusText = hasExactDays ? `🔴 告急(${store.fundingDays}天)` : '🔴 告急';
      } else {
        // 兼容旧数据：既无 healthStatus 也无 fundingDays 时，退回用余额/日均开销就地反推
        // （仅管理者视角会走到这里——志工响应即使字段缺失也不会误算出虚假的告急状态）
        // 🐛 同一个"告急(0天)"误报根因：balance/foodExpense/days 全部缺失时会被 parseFloat/parseInt
        // 兜底成 0，估算出的 estimatedDays 也是 0，会被当成"资金见底"而不是"没有数据"。
        // 先判断是否真的有任何一项原始字段存在，完全没有时展示中性的"新店筹备中"
        const hasBalanceField = store.balance != null || store.latestBalance != null;
        const hasExpenseField = store.foodExpense != null || store.dailyExpenseTotal != null;
        const hasDaysField = store.openDays != null || store.days != null;

        if (!hasBalanceField && !hasExpenseField && !hasDaysField) {
          statusLevel = 'nodata';
          statusText = '⚪ 新店筹备中';
        } else {
          const balance = parseFloat(store.balance || store.latestBalance || 0);
          const foodExpense = parseFloat(store.foodExpense || store.dailyExpenseTotal || 0);
          const days = parseInt(store.openDays || store.days || 0);
          let dailyCostEstimate = foodExpense > 0 && days > 0 ? (foodExpense / days) : 100;
          if (dailyCostEstimate < 50) dailyCostEstimate = 100;
          const estimatedDays = Math.floor(balance / dailyCostEstimate);

          if (estimatedDays >= 10) {
            statusLevel = 'ample';
            statusText = `🟢 充足(${estimatedDays}天)`;
          } else if (estimatedDays >= 5) {
            statusLevel = 'warning';
            statusText = `🟡 注意(${estimatedDays}天)`;
          } else {
            statusLevel = 'urgent';
            statusText = `🔴 告急(${estimatedDays}天)`;
          }
        }
      }

      return {
        ...store,
        costPerMealStr,
        isCostValid,
        statusLevel,
        statusText,
        // 🆕 平台徽章文案：topDinersStores/topActiveStores/supportNeededStores 均由
        // cleanedMatrix（本函数的返回值）派生 slice/sort/spread 得来，这里加一次
        // 即可让排行榜、待支援预警列表同时拿到，无需在三处各自重复映射
        orgTypeLabel: orgTypeShortName(store.orgType)
      };
    });
  },

  // 🆕 空状态防呆引导："切回全国总览大屏"——与 onSwitchToAllStores 不同，那个
  // 方法只是把本店切到 getStatisticsData/getReports 口径的"全部门店"聚合视图
  // （仍留在单店风格的 stats-content 里），这里要跳的是真正的 national-dashboard-
  // container 大屏，与 onSuperAdminSelectStore 选中"🌐 全国总览"时完全同一套
  // 状态变更（含刻意不调用 setSelectedStore()——'全国总览'是仅供本页内部判断用
  // 的虚拟聚合项，不能写进其他页面也会读取的全局门店缓存，否则会把"全国总览"
  // 污染成好像是一个真实门店），直接触发 loadNationalDashboard() 拉取全租户聚合数据
  onGoToNationalDashboard() {
    if (!this.data.canViewAllStoresDropdown) return;
    this.setData({
      shopName: '全部门店',
      currentUserStoreName: '🌐 全国总览',
      currentUserStoreId: '',
      isAllStoresMode: true,
      hasOtherStoreData: false,
      statistics: null,
      showNationalDashboard: true
    });
    this.loadNationalDashboard();
  },

  onOpenNationalReportModal() {
    if (!this.data.isAdmin) return;
    this.setData({ showNationalReportModal: true });
  },

  onCloseNationalReportModal() {
    if (this.data.generatingNationalReport) return;
    this.setData({ showNationalReportModal: false });
  },

  onToggleReportSelection(e: any) {
    const key = e.currentTarget.dataset.key as 'operations' | 'financeAudit';
    this.setData({ [`nationalReportSelection.${key}`]: !this.data.nationalReportSelection[key] });
  },

  // 🔢 义工与用餐服务数据看板·数字滚动动画：ease-out 缓动，单个定时器同时驱动
  // 看板内全部数值（而非每个格子各开一个 setInterval），减少 setData 调用次数。
  // 参考 subpackages/admin/pages/journey/journey.ts 的 animateCountUp 同一套 ease-out 三次方缓动
  animateCareCountUp(targets: Record<string, number>, duration: number = 700) {
    if (this._careCountUpTimer) {
      clearInterval(this._careCountUpTimer);
      this._careCountUpTimer = null;
    }

    const steps = 24;
    const stepTime = Math.max(16, Math.round(duration / steps));
    let currentStep = 0;

    this._careCountUpTimer = setInterval(() => {
      currentStep++;
      const progress = Math.min(1, currentStep / steps);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next: Record<string, number> = {};
      Object.keys(targets).forEach((key) => {
        const val = (targets[key] || 0) * eased;
        // 服务工时允许一位小数（与 nationalTotalVolunteerHours 的展示口径一致），其余取整
        next[key] = key === 'volunteerHours' ? parseFloat(val.toFixed(1)) : Math.round(val);
      });
      this.setData({ careDisplay: next });

      if (progress >= 1) {
        clearInterval(this._careCountUpTimer);
        this._careCountUpTimer = null;
        // 收尾强制对齐目标值，避免缓动舍入误差停留在肉眼可辨的偏差上
        this.setData({ careDisplay: { ...targets } });
      }
    }, stepTime);
  },

  onPreviewNationalPhoto(e: any) {
    const index = e.currentTarget.dataset.index as number;
    const gallery = this.data.nationalMediaGallery || [];
    const urls = gallery.map((p: any) => p.url).filter(Boolean);
    if (!urls.length) return;
    wx.previewImage({ current: urls[index] || urls[0], urls });
  },

  // 🆕 影像墙缩略图加载失败兜底（临时链接过期等场景），标记该项改渲染占位图标，
  // 避免网格里露出微信默认的裂图图标
  onNationalPhotoError(e: any) {
    const index = e.currentTarget.dataset.index;
    if (index === undefined || index === null) return;
    this.setData({ [`nationalMediaGallery[${index}].loadError`]: true });
  },

  // 《全国门店运营汇总表》：服务人次/开餐天数/单餐成本/续航与离线预警，取自已加载的 nationalMatrixList
  buildNationalOperationsCSV(): string {
    let csv = '门店名称,城市,服务人次,开餐天数,单餐成本,续航预警,是否离线,最近记账日期\n';
    (this.data.nationalMatrixList || []).forEach((s: any) => {
      const name = String(s.storeName || '').replace(/"/g, '""');
      const city = String(s.city || '未知').replace(/"/g, '""');
      const costPerMeal = s.isCostRestricted ? '***' : (s.costPerMealStr || '');
      const isOfflineText = s.isOffline === undefined ? '' : (s.isOffline ? '是' : '否');
      csv += `"${name}","${city}",${s.totalDiners || 0},${s.openDays || 0},"${costPerMeal}","${s.statusText || ''}","${isOfflineText}","${s.lastReportDate || ''}"\n`;
    });
    return csv;
  },

  // 《全国财务与凭证审计表》：收支/结余 + 凭证合规率，凭证合规率为超管专属字段（普通角色恒为空）
  buildNationalFinanceAuditCSV(): string {
    let csv = '门店名称,服务汇入(元),开餐总支出(元),食材支出(元),账户结余(元),凭证合规率\n';
    (this.data.nationalMatrixList || []).forEach((s: any) => {
      const name = String(s.storeName || '').replace(/"/g, '""');
      const complianceText = (s.receiptComplianceRate === null || s.receiptComplianceRate === undefined)
        ? ''
        : `${s.receiptComplianceRate}%`;
      csv += `"${name}",${s.totalIncome || 0},${s.totalExpense || 0},${s.ingredientExpense || 0},${s.latestBalance || 0},"${complianceText}"\n`;
    });

    const insights = this.data.superAdminInsights;
    if (insights) {
      csv += `\n全国汇总（${insights.rangeLabel || ''}）\n`;
      csv += `全国平均单餐成本(元),${insights.avgCostPerMealStr || '—'}\n`;
      csv += `全国凭证合规率,${insights.complianceRate === null ? '' : insights.complianceRate + '%'}\n`;
      csv += `超过${insights.offlineAlertThresholdDays}天未记账门店数,${insights.offlineStoreCount}\n`;
      // 📸 影像卷宗附录
      if (insights.nationalTotalPhotos !== undefined) {
        csv += `\n【影像卷宗与凭证档案】\n`;
        csv += `全网凭证照片总张数,${insights.totalReceiptPhotos || 0}\n`;
        csv += `全网食谱照片总张数,${insights.totalMenuPhotos || 0}\n`;
        csv += `全网日志照片总张数,${insights.totalLogPhotos || 0}\n`;
        csv += `全网影像档案合计张数,${insights.nationalTotalPhotos || 0}\n`;
      }
    }
    return csv;
  },

  buildSelectedNationalReportCSV(): { csv: string; label: string } | null {
    const { operations, financeAudit } = this.data.nationalReportSelection;
    if (!operations && !financeAudit) return null;

    const parts: string[] = [];
    const labels: string[] = [];
    if (operations) {
      parts.push('《全国门店运营汇总表》\n' + this.buildNationalOperationsCSV());
      labels.push('运营汇总表');
    }
    if (financeAudit) {
      parts.push('《全国财务与凭证审计表》\n' + this.buildNationalFinanceAuditCSV());
      labels.push('财务审计表');
    }
    return { csv: parts.join('\n\n'), label: labels.join('+') };
  },

  fallbackCopyToClipboard(csvText: string) {
    wx.setClipboardData({
      data: csvText,
      success: () => {
        wx.showModal({
          title: '已复制表格文本',
          content: '手机端无法直接写本地文件，已将 CSV 表格内容复制到剪贴板，您可以直接粘贴到微信聊天框或 Excel 中！',
          showCancel: false
        });
      }
    });
  },

  onCopyNationalReport() {
    if (!this.data.isAdmin) return;
    const built = this.buildSelectedNationalReportCSV();
    if (!built) {
      wx.showToast({ title: '请至少勾选一种报表', icon: 'none' });
      return;
    }
    this.fallbackCopyToClipboard(built.csv);
  },

  onExportNationalReport() {
    if (!this.data.isAdmin) return;
    const built = this.buildSelectedNationalReportCSV();
    if (!built) {
      wx.showToast({ title: '请至少勾选一种报表', icon: 'none' });
      return;
    }

    this.setData({ generatingNationalReport: true });
    wx.showLoading({ title: '正在生成表格...', mask: true });

    try {
      const csvContent = '﻿' + built.csv;
      const rangeLabel = (this.data.superAdminInsights && this.data.superAdminInsights.rangeLabel) || '全部时间';
      const fileName = `全国${built.label}_${rangeLabel}.csv`;
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

      // 🐛 根因修复（本地文件写满报错）：见 exportLocalCSV 同类修复注释，写入
      // 失败时先清理"全国"前缀的历史导出文件再重试一次
      const written = writeLocalFileSafe(filePath, csvContent, 'utf8', '全国');
      if (!written) throw new Error('本地表格文件写入失败');
      wx.hideLoading();
      this.setData({ generatingNationalReport: false, showNationalReportModal: false });

      if ((wx as any).shareFileMessage) {
        (wx as any).shareFileMessage({
          filePath: filePath,
          fileName: fileName,
          success: () => {
            wx.showToast({ title: '报表已成功导出并发送！', icon: 'success' });
          },
          fail: (err) => {
            if (!err.errMsg || !err.errMsg.includes('cancel')) {
              this.tryOpenDocumentFallback(filePath);
            }
          }
        });
      } else {
        this.tryOpenDocumentFallback(filePath);
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({ generatingNationalReport: false });
      console.error('[NationalReport] CSV 导出失败:', error);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  },

  // ========== 🆕（2026-08-31）超管专属：机构多店合并阳光台账 Excel 导出 ==========
  // 与上面「全国运营/财务报表 CSV 导出」是两条独立通道：那条是纯客户端从
  // 已加载的 nationalMatrixList/superAdminInsights 聚合摘要派生的轻量 CSV，
  // 这条是重新发起 exportAccountExcel 云调用、按 report_logs 逐条明细生成
  // 的正式多 Sheet .xlsx 工作簿（各店一个 Sheet + 机构总览 Sheet），附带
  // 存证核验码，供理事会/民政核对存档

  // 🆕（2026-08-31 商业化权益中心）机构 SaaS 权益看板：顶部配额微章点击后
  // 弹出的自定义半屏弹窗，展示门店席位进度条 + 三项衍生能力（合并导出/调拨
  // 引擎/存证徽章）开通状态。这是"查看我当前用量"，不是"套餐对比购买"——
  // 后者唯一真源仍是 profile.ts 的 showSubscriptionModal，见
  // onOpenPlanUpgradeModal 头部注释，本弹窗不重复一份定价文案
  onShowSubscriptionQuotaDetail() {
    if (!this.data.nationalData || !this.data.nationalData.subscriptionQuota) return;
    this.setData({ showSaasBenefitsModal: true });
  },

  onCloseSaasBenefitsModal() {
    this.setData({ showSaasBenefitsModal: false });
  },

  // 阻止点击半屏弹窗卡片内部时冒泡到外层遮罩触发关闭
  noop() {},

  // 「扩容 / 续费咨询」：大家长/超管本就有权限自助升级，直接引导前往个人中心
  // 唤起真正的套餐订购弹窗（与 onOpenPlanUpgradeModal 同一套角色分支）；
  // 其余角色一键复制平台客服微信，线下联系咨询
  onConsultUpgrade() {
    this.setData({ showSaasBenefitsModal: false });
    if (this.data.isPatriarch || this.data.isAdmin) {
      requestOpenSubscription();
      wx.switchTab({ url: '/pages/profile/profile' });
      return;
    }
    wx.setClipboardData({
      data: PLATFORM_SUPPORT_CONTACT.wechat,
      success: () => wx.showToast({ title: `已复制客服微信号：${PLATFORM_SUPPORT_CONTACT.wechat}，请在微信添加好友咨询`, icon: 'none', duration: 3000 })
    });
  },

  // 🏛️（2026-08-31 商业化权益中心）免费版试用引导：机构多店合并导出是"审计
  // 增值服务"付费层能力，云端 exportAccountExcel 已按 isNationalExport 做了
  // 硬校验，这里是体验层前置拦截——免费版机构点击"数据导出"直接走既有的
  // feature-locked-modal 升级转化漏斗，不再弹出一个反正会被服务端拒绝的
  // 导出确认弹窗，避免用户点了"确认导出"才收到失败提示的糟糕体验
  onOpenNationalExcelExportModal() {
    if (!this.data.isAdmin) return;
    const quota = this.data.nationalData && this.data.nationalData.subscriptionQuota;
    // 🏛️（2026-08-31 Open-Core 架构拆分）改走 canExportNationalExcel() 命名
    // 判定函数，不再直接读 quota.features.canExportNationalExcel 裸字段——
    // 仍保留 `quota &&` 前置判断：quota 尚未加载完成时不拦截（让用户先进入
    // 弹窗，真正的硬校验交给服务端），只在"已经明确知道这个机构不享有该
    // 权益"时才拦截，语义与改造前完全一致
    if (quota && !canExportNationalExcel(quota)) {
      this.onOpenPlanUpgradeModal('机构多店合并导出');
      return;
    }
    this.setData({ showNationalExcelExportModal: true });
  },

  onCloseNationalExcelExportModal() {
    if (this.data.generatingNationalExcelExport) return;
    this.setData({ showNationalExcelExportModal: false });
  },

  // 将大屏当前选中的 nationalRangeType（7d/month/quarter/year/all）换算成
  // exportAccountExcel 认识的 tabType: 'custom' + 具体 startDate/endDate，
  // 让合并导出的统计口径与大屏当前展示的数据范围保持一致，而不是另起一套
  // 用户没有主动选过的周期
  buildNationalExportDateRange(): { startDate: string; endDate: string } {
    const rangeType = this.data.nationalRangeType;
    const today = new Date();
    const endDate = formatDate(today);
    const daysMap: Record<string, number> = { '7d': 7, month: 30, quarter: 90, year: 365 };
    const days = daysMap[rangeType];
    if (!days) {
      // 'all'：用一个足够早的锚点日期覆盖机构全部历史记录
      return { startDate: '2000-01-01', endDate };
    }
    const start = new Date(today);
    start.setDate(start.getDate() - days);
    return { startDate: formatDate(start), endDate };
  },

  async onConfirmNationalExcelExport() {
    if (this.data.generatingNationalExcelExport) return;
    this.setData({ generatingNationalExcelExport: true });
    wx.showLoading({ title: '正在生成合并台账...', mask: true });

    try {
      const { startDate, endDate } = this.buildNationalExportDateRange();
      const res = await callFunctionWithTimeout({
        name: 'exportAccountExcel',
        data: { isNationalExport: true, tabType: 'custom', startDate, endDate }
      });
      const result = (res.result || {}) as any;
      wx.hideLoading();
      this.setData({ generatingNationalExcelExport: false, showNationalExcelExportModal: false });

      if (result.success && result.tempFileURL) {
        if (result.verificationCode) {
          wx.showModal({
            title: '✅ 台账已生成',
            content: `存证核验码：${result.verificationCode}\n\n请妥善留存此核验码，用于核对该台账文件是否被篡改替换。`,
            showCancel: false,
            confirmText: '我知道了',
            success: () => this.downloadAndOpenExcel(result.tempFileURL, result.fileName || '多店合并阳光台账.xlsx')
          });
        } else {
          this.downloadAndOpenExcel(result.tempFileURL, result.fileName || '多店合并阳光台账.xlsx');
        }
      } else if (result.requiresUpgrade) {
        // 🛡️ 服务端强鉴权兜底：理论上前端 onOpenNationalExcelExportModal 已经
        // 拦过一次，这里是"客户端缓存的 subscriptionQuota 与服务端最新套餐状态
        // 不一致"（如刚好套餐到期）时的兜底，改走真正的升级引导而不是普通报错
        this.onOpenPlanUpgradeModal('机构多店合并导出');
      } else {
        wx.showToast({ title: result.errMsg || '导出失败，请重试', icon: 'none' });
      }
    } catch (err: any) {
      wx.hideLoading();
      this.setData({ generatingNationalExcelExport: false });
      console.error('[NationalExcelExport] 导出失败:', err);
      reportCloudSdkErrorIfCorrupted(err);
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  },

  onGenerateNationalPoster() {
    const { nationalData } = this.data;
    if (!nationalData || nationalData.nationalTotalDiners === undefined) {
      wx.showToast({ title: '暂无数据', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '正在合成全国公示海报...', mask: true });

    try {
      const query = wx.createSelectorQuery();
      query.select('#posterCanvas')
        .fields({ node: true, size: true })
        .exec((res: any) => {
          if (!res[0] || !res[0].node) {
            wx.hideLoading();
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }

          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          // 🌟 复用项目已有的 getSafeSystemInfo（已经把 wx.getWindowInfo 缺失时的兜底
          // 封装好了），不再新增一处 wx.getWindowInfo 直接调用的已知类型缺口实例
          const dpr = getSafeSystemInfo().pixelRatio || 2;

          const W = 600;

          // 🐛 根因修复：此前 H 是拍脑袋写死的 820，与实际绘制内容的真实高度经常
          // 对不上——数据卡片区固定只有 4 格（2 行），画完后白色卡片内部与画布
          // 底部各留出一大截不自然的空白，长图比例显得头重脚轻。改为先把要展示
          // 的卡片数据组装成数组（并追加此前完全没在海报里出现过的义工到岗
          // 人次/工时、物资消耗——这些数据 nationalData 里本就有，只是海报没画），
          // 再按数组长度动态换算白色卡片与整张画布的高度，画多少内容就撑多高
          const dataCards: Array<{ label: string; value: string; color: string }> = [
            { label: '全国服务汇入', value: `+¥${nationalData.nationalTotalIncome}`, color: '#2B8A3E' },
            { label: '全国开餐总支出', value: `-¥${nationalData.nationalTotalExpense}`, color: '#C62828' },
            { label: '全国累计开餐天数', value: `${nationalData.nationalOpenDays} 天`, color: '#8C1D18' },
            { label: '覆盖门店数量', value: `${nationalData.totalStores || 0} 家`, color: '#8C1D18' }
          ];
          // 🆕 全国义工到岗人次/工时：此前海报完全没有呈现志愿服务成果，只有财务
          // 数字——补上这两项与"全国累计服务用餐人次"呼应的服务成果类指标
          if (nationalData.nationalTotalVolunteers > 0 || nationalData.nationalTotalVolunteerHours > 0) {
            dataCards.push(
              { label: '全国义工到岗人次', value: `${nationalData.nationalTotalVolunteers} 人次`, color: '#1C7ED6' },
              { label: '全国义工服务工时', value: `${nationalData.nationalTotalVolunteerHours} 小时`, color: '#1C7ED6' }
            );
          }
          // 🆕 核心物资消耗：只在确实有数据的品类里各占一格，不拼出"大米 0斤"
          // 这种没有意义的空数据卡片
          if (nationalData.nationalRiceTotal > 0) dataCards.push({ label: '全国大米消耗', value: `${nationalData.nationalRiceTotal} 斤`, color: '#F08C00' });
          if (nationalData.nationalFlourTotal > 0) dataCards.push({ label: '全国面粉消耗', value: `${nationalData.nationalFlourTotal} 斤`, color: '#F08C00' });
          if (nationalData.nationalOilTotal > 0) dataCards.push({ label: '全国食用油消耗', value: `${nationalData.nationalOilTotal} 斤`, color: '#F08C00' });
          if (nationalData.nationalVegetableTotal > 0) dataCards.push({ label: '全国蔬菜消耗', value: `${nationalData.nationalVegetableTotal} 斤`, color: '#F08C00' });

          const cardStartY = 320;
          const cardW = (W - 100) / 2;
          const cardH = 90;
          const cardGapX = 20;
          const cardGapY = 16;
          const cardRows = Math.ceil(dataCards.length / 2);
          const cardsEndY = cardStartY + cardRows * cardH + (cardRows - 1) * cardGapY;
          const footerY = cardsEndY + 40;
          const cardBottomPadding = 30;
          const whiteCardH = (footerY + 24 + cardBottomPadding) - 160;
          const H = 160 + whiteCardH + 40;

          canvas.width = W * dpr;
          canvas.height = H * dpr;
          ctx.scale(dpr, dpr);

          ctx.fillStyle = '#FAF6F0';
          ctx.fillRect(0, 0, W, H);

          ctx.fillStyle = '#1C7ED6';
          ctx.fillRect(0, 0, W, 140);

          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 26px "PingFang SC", sans-serif';
          ctx.fillText('🌐 雨花斋全国爱心矩阵 · 公示海报', 40, 60);
          ctx.font = '18px sans-serif';
          ctx.fillText(`已覆盖 ${nationalData.totalStores || 0} 家门店`, 40, 100);

          ctx.fillStyle = '#FFFFFF';
          ctx.shadowColor = 'rgba(0, 0, 0, 0.05)';
          ctx.shadowBlur = 10;
          ctx.fillRect(30, 160, 540, whiteCardH);
          ctx.shadowBlur = 0;

          ctx.fillStyle = '#212529';
          ctx.font = 'bold 20px sans-serif';
          ctx.fillText('全国累计服务用餐人次', 60, 210);
          ctx.fillStyle = '#1C7ED6';
          ctx.font = 'bold 44px sans-serif';
          ctx.fillText(`${nationalData.nationalTotalDiners}`, 60, 265);
          ctx.font = '16px sans-serif';
          ctx.fillStyle = '#868E96';
          ctx.fillText('人次', 60 + ctx.measureText(`${nationalData.nationalTotalDiners}`).width + 12, 262);

          dataCards.forEach((card, index) => {
            const col = index % 2;
            const row = Math.floor(index / 2);
            const x = 40 + col * (cardW + cardGapX);
            const y = cardStartY + row * (cardH + cardGapY);

            ctx.fillStyle = '#F8F9FA';
            this.roundRect(ctx, x, y, cardW, cardH, 10, true);

            ctx.fillStyle = '#868E96';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(card.label, x + cardW / 2, y + 30);

            ctx.fillStyle = card.color;
            ctx.font = 'bold 22px sans-serif';
            ctx.fillText(card.value, x + cardW / 2, y + 65);
          });
          ctx.textAlign = 'left';

          ctx.fillStyle = '#8C7355';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('感恩各位爱心人士护持与全国义工团队无私付出！', W / 2, footerY);
          ctx.fillStyle = '#ADB5BD';
          ctx.font = '10px sans-serif';
          ctx.fillText('本平台仅用于爱心餐报与志愿服务记录，不直接面向公众发起公开募捐', W / 2, footerY + 24);
          ctx.textAlign = 'left';

          wx.canvasToTempFilePath({
            canvas: canvas,
            success: (tempRes: any) => {
              wx.hideLoading();
              this.setData({
                posterTempFilePath: tempRes.tempFilePath,
                showPosterModal: true
              });
            },
            fail: () => {
              wx.hideLoading();
              wx.showToast({ title: '海报生成失败', icon: 'none' });
            }
          });
        });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '海报生成异常', icon: 'none' });
    }
  }
};
