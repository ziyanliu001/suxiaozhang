import { AuthService } from '../../utils/authService';
import { createNavGuard, NavGuardInstance } from '../../utils/navGuard';
import { setSelectedStore } from '../../utils/storeManager';
import { setGenCodeHandoff } from '../../utils/genCodeHandoff';
import { isCloudAvailable } from '../../utils/cloudGuard';
import { drawStoreInvitationPoster, SponsorInfo } from '../../utils/drawStorePoster';

Page({
  _navGuard: null as NavGuardInstance | null,

  data: {
    navTop: 0,
    contentTop: 0,
    checkedAccess: false,
    isSuperAdmin: false,

    // 已激活 / 待审核 两个 Tab
    activeTab: 'active' as 'active' | 'pending',

    loading: false,
    list: [] as any[],

    pendingLoading: false,
    pendingList: [] as any[],
    approvingId: '',

    showRenameModal: false,
    renameForm: {
      storeId: '',
      oldName: '',
      newName: ''
    },
    submitting: false,

    showCreateModal: false,
    createForm: {
      storeName: '',
      address: '',
      announcement: '',
      province: '',
      operatingStatus: 'operating' as 'operating' | 'preparing' | 'paused',
      latitude: undefined as number | undefined,
      longitude: undefined as number | undefined,
      locationLabel: ''
    },
    creating: false,

    // 查看门店人员
    showStaffModal: false,
    staffLoading: false,
    staffStoreName: '',
    staffList: [] as any[],

    togglingStatusId: '',

    // 🛡️ 异常账目风控预警：呼叫 getRiskAlerts 云函数（原本服务于单店财务稽核页），
    // 按已激活门店逐个查询后汇总展示，见 loadRiskBadges()
    riskAlertStoreCount: 0,

    // 🌟 门店宣传/招募海报：复用 drawStoreInvitationPoster（index.ts「生成门店海报」
    // 同一套绘制函数），仅新增地址字段绘制，见 drawStorePoster.ts
    showStorePosterModal: false,
    generatingStorePoster: false,
    storePosterTempFilePath: '',
    posterStoreName: '',

    // 编辑通告：门店专属 / 全国总览（storeId 传空）复用同一套弹窗，见 manageNotice 云函数
    showNoticeModal: false,
    noticeLoading: false,
    noticeSubmitting: false,
    noticeForm: {
      scopeStoreId: '',
      scopeLabel: '',
      id: '',
      tag: '通知',
      title: '',
      content: ''
    }
  },

  onLoad() {
    this.calculateNavBarHeight();
    this.checkAccess();

    this._navGuard = createNavGuard({
      homePath: '/pages/index/index',
      alertMessage: '即将退出雨花爱心餐报助手，是否返回首页继续使用？'
    });
    this._navGuard.setupOnLoad();
  },

  onUnload() {
    if (this._navGuard) {
      this._navGuard.teardown();
      this._navGuard = null;
    }
  },

  calculateNavBarHeight() {
    const menuButton = wx.getMenuButtonBoundingClientRect();
    if (!menuButton) {
      this.setData({ navTop: 44, contentTop: 88 });
      return;
    }
    this.setData({
      navTop: menuButton.top,
      contentTop: menuButton.top + menuButton.height + 8
    });
  },

  async checkAccess() {
    let cached = AuthService.getCachedRoleInfo();
    if (!cached) {
      const result = await AuthService.fetchUserRole();
      cached = result.roleInfo || null;
    }
    const isSuperAdmin = !!(cached && cached.role === 'super_admin');
    this.setData({ checkedAccess: true, isSuperAdmin });

    if (isSuperAdmin) {
      this.loadStoreList();
    }
  },

  async loadStoreList() {
    this.setData({ loading: true });
    try {
      // includeInactive:true —— 门店管理页需要连"已停用"门店一起看，才能重新启用；
      // 首页 store-picker / 邀请码弹窗走的是默认调用（不传），只看得到 active 门店
      const res = await wx.cloud.callFunction({ name: 'getStoreList', data: { includeInactive: true } });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({ list: result.list || [] });
        this.loadRiskBadges();
      } else {
        wx.showToast({ title: (result && result.error) || '门店列表加载失败', icon: 'none' });
      }
    } catch (err) {
      console.error('[store-management] loadStoreList 异常:', err);
      wx.showToast({ title: '门店列表加载异常', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 🛡️ 异常账目风控预警：对每个已激活门店逐个调用 getRiskAlerts（该云函数本就是单店
  // 查询设计，super_admin 无门店归属限制可任意查），并发拉取后合并进 list——
  // 停用门店没有继续记账的意义，跳过不查，减少不必要的云函数调用
  async loadRiskBadges() {
    const activeStores = (this.data.list || []).filter((item: any) => item.status !== 'inactive');
    if (activeStores.length === 0) {
      this.setData({ riskAlertStoreCount: 0 });
      return;
    }

    const riskResults = await Promise.all(
      activeStores.map(async (store: any) => {
        try {
          const res = await wx.cloud.callFunction({ name: 'getRiskAlerts', data: { storeId: store.storeId } });
          const result = res.result as any;
          if (!result || !result.success) return null;

          const summary = result.summary || {};
          return {
            storeId: store.storeId,
            riskMissingReport: !!summary.missingReport,
            riskDaysSinceLastReport: summary.daysSinceLastReport,
            riskExpenseWarning: !!((summary.missingReceiptCount || 0) > 0 || (summary.balanceAnomalyCount || 0) > 0)
          };
        } catch (err) {
          console.warn('[store-management] loadRiskBadges 单店查询失败:', store.storeId, err);
          return null;
        }
      })
    );

    const riskMap: Record<string, any> = {};
    let alertStoreCount = 0;
    riskResults.forEach((r) => {
      if (r && (r.riskMissingReport || r.riskExpenseWarning)) {
        riskMap[r.storeId] = r;
        alertStoreCount++;
      }
    });

    const list = (this.data.list || []).map((item: any) => {
      const risk = riskMap[item.storeId];
      return {
        ...item,
        riskMissingReport: !!(risk && risk.riskMissingReport),
        riskDaysSinceLastReport: risk ? risk.riskDaysSinceLastReport : null,
        riskExpenseWarning: !!(risk && risk.riskExpenseWarning)
      };
    });

    this.setData({ list, riskAlertStoreCount: alertStoreCount });
  },

  onPullDownRefresh() {
    const reload = this.data.activeTab === 'pending' ? this.fetchPendingStoreRequests() : this.loadStoreList();
    reload.finally(() => wx.stopPullDownRefresh());
  },

  // 已激活 / 待审核 Tab 切换：待审核列表懒加载，第一次切过去才查
  onSwitchTab(e: any) {
    const tab = e.currentTarget.dataset.tab as 'active' | 'pending';
    if (tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    if (tab === 'pending' && this.data.pendingList.length === 0) {
      this.fetchPendingStoreRequests();
    }
  },

  // 🆕 待审核门店：stores 集合本身从未出现过"待审核"状态（所有建店路径都是直接 status:'active'）。
  // 真正的"待审核"是 user_roles 里 storeSelectionType==='custom' 的新建门店申请——
  // 复用 index.ts fetchPendingAuditList 同款查法，只是精简为只取"新建门店"这一类
  async fetchPendingStoreRequests() {
    this.setData({ pendingLoading: true });
    try {
      const roleInfo = AuthService.getCachedRoleInfo();
      const tenantId = (roleInfo && roleInfo.tenantId) || '';
      if (!tenantId) {
        this.setData({ pendingList: [], pendingLoading: false });
        return;
      }

      const db = wx.cloud.database();
      const res = await db.collection('user_roles')
        .where({ status: 'pending', tenantId, storeSelectionType: 'custom' })
        .orderBy('applyTime', 'desc')
        .limit(50)
        .get();

      this.setData({ pendingList: res.data || [] });
    } catch (err) {
      console.error('[store-management] fetchPendingStoreRequests 异常:', err);
      wx.showToast({ title: '待审核列表加载失败', icon: 'none' });
    } finally {
      this.setData({ pendingLoading: false });
    }
  },

  // 一键通过审核：直接复用 processRoleAudit 云函数（含新建门店的自动建店逻辑），
  // 不重新实现一套审批逻辑
  async onApproveStoreRequest(e: any) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.approvingId) return;

    this.setData({ approvingId: id });
    wx.showLoading({ title: '正在授权...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'processRoleAudit',
        data: { applyId: id, action: 'approve' }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        wx.showToast({ title: '已通过审核，门店已创建', icon: 'success' });
        this.setData({ pendingList: this.data.pendingList.filter((r: any) => r._id !== id) });

        // 审核通过会新建一条 stores 记录，存在与「门店管理」建店同样的跨页面缓存陈旧问题
        wx.removeStorageSync('all_stores_list_cache');
        wx.removeStorageSync('all_stores_list_cache_time');

        this.loadStoreList();
      } else {
        wx.showToast({ title: (result && result.error) || '审核失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[store-management] onApproveStoreRequest 异常:', err);
      wx.showToast({ title: '审核失败，请重试', icon: 'none' });
    } finally {
      this.setData({ approvingId: '' });
    }
  },

  // 查看门店人员：与 index.ts fetchApprovedVolunteerList 同款直查模式，不新增云函数
  async onViewStoreStaff(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    this.setData({
      showStaffModal: true,
      staffLoading: true,
      staffStoreName: storename,
      staffList: []
    });

    try {
      const db = wx.cloud.database();
      const res = await db.collection('user_roles')
        .where({ storeId: storeid, status: 'approved' })
        .orderBy('role', 'asc')
        .limit(100)
        .get();

      const roleLabels: Record<string, string> = {
        store_manager: '店长',
        finance: '财务',
        volunteer: '义工',
        super_admin: '超级管理员'
      };
      const staffList = (res.data || []).map((item: any) => ({
        ...item,
        roleLabel: roleLabels[item.role] || item.role
      }));

      this.setData({ staffList, staffLoading: false });
    } catch (err) {
      console.error('[store-management] onViewStoreStaff 异常:', err);
      this.setData({ staffLoading: false });
      wx.showToast({ title: '人员列表加载失败', icon: 'none' });
    }
  },

  onCloseStaffModal() {
    this.setData({ showStaffModal: false });
  },

  // 🌟 生成门店宣传/招募海报：复用 drawStoreInvitationPoster（与首页「生成门店海报」
  // 同一份绘制函数），只是这里按卡片上具体选中的门店生成，而不是"当前登录视角所在门店"
  async onGenerateStorePoster(e: any) {
    if (this.data.generatingStorePoster) return;
    const { storeid, storename, address } = e.currentTarget.dataset;

    this.setData({
      generatingStorePoster: true,
      showStorePosterModal: true,
      storePosterTempFilePath: '',
      posterStoreName: storename
    });
    wx.showLoading({ title: '正在合成海报...', mask: true });

    try {
      if (!isCloudAvailable()) throw new Error('CLOUD_SDK_UNAVAILABLE: wx.cloud 不可用，跳过云端请求');

      let qrCodeLocalPath = '';
      try {
        const qrRes = await wx.cloud.callFunction({
          name: 'getStoreQRCode',
          data: { storeId: storeid, storeName: storename }
        });
        const qrResult = qrRes.result as any;
        if (qrResult && qrResult.success && qrResult.fileID) {
          const downRes = await wx.cloud.downloadFile({ fileID: qrResult.fileID });
          qrCodeLocalPath = downRes.tempFilePath;
        }
      } catch (qrErr) {
        console.warn('[onGenerateStorePoster] 二维码获取失败，海报将使用占位框:', qrErr);
      }

      // 冠名赞助商信息：与首页同一口径，查询失败/无赞助不影响海报生成，
      // drawStoreInvitationPoster 内部本就有"无 sponsorInfo"的默认文案分支
      let sponsorInfo: SponsorInfo | null = null;
      try {
        const sponsorRes = await wx.cloud.callFunction({ name: 'getStoreSponsor', data: { storeId: storeid } });
        const sponsorResult = sponsorRes.result as any;
        if (sponsorResult && sponsorResult.success && sponsorResult.data) {
          sponsorInfo = sponsorResult.data;
        }
      } catch (sponsorErr) {
        console.warn('[onGenerateStorePoster] 赞助商信息查询失败，忽略:', sponsorErr);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      const query = wx.createSelectorQuery().in(this);
      query.select('#storePosterCanvas')
        .fields({ node: true, size: true })
        .exec(async (res) => {
          if (!res || !res[0] || !res[0].node) {
            wx.hideLoading();
            this.setData({ generatingStorePoster: false });
            wx.showToast({ title: 'Canvas 初始化失败', icon: 'none' });
            return;
          }
          const canvas = res[0].node;

          try {
            await drawStoreInvitationPoster({
              canvas,
              storeName: storename,
              sponsorInfo,
              qrCodeTempPath: qrCodeLocalPath,
              address: address || '',
              width: 320,
              height: 540
            });

            wx.canvasToTempFilePath({
              canvas,
              success: (tempRes) => {
                wx.hideLoading();
                this.setData({ storePosterTempFilePath: tempRes.tempFilePath, generatingStorePoster: false });
              },
              fail: (err) => {
                wx.hideLoading();
                this.setData({ generatingStorePoster: false });
                console.error('[onGenerateStorePoster] canvasToTempFilePath 失败:', err);
                wx.showToast({ title: '海报生成失败', icon: 'none' });
              }
            });
          } catch (drawErr) {
            wx.hideLoading();
            this.setData({ generatingStorePoster: false });
            console.error('[onGenerateStorePoster] 绘制失败:', drawErr);
            wx.showToast({ title: '海报绘制失败', icon: 'none' });
          }
        });
    } catch (err) {
      wx.hideLoading();
      this.setData({ generatingStorePoster: false });
      console.error('[onGenerateStorePoster] 异常:', err);
      wx.showToast({ title: '海报生成失败', icon: 'none' });
    }
  },

  onCloseStorePosterModal() {
    if (this.data.generatingStorePoster) return;
    this.setData({ showStorePosterModal: false });
  },

  onSaveStorePosterToPhotos() {
    const filePath = this.data.storePosterTempFilePath;
    if (!filePath) {
      wx.showToast({ title: '海报尚未绘制完成', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '海报已保存至相册', icon: 'success' });
        this.setData({ showStorePosterModal: false });
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许小程序保存图片到您的相册',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  // 门店专属通告：storeId 传具体门店 id
  onOpenStoreNotice(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    this.openNoticeEditor(storeid, storename);
  },

  // 全国总览通告：storeId 传空字符串——manageNotice 云函数把空 storeId 当机构总览级
  // 处理（与 index.ts 首页"全国总览"视角下 onSaveNotice 的约定完全一致）
  onOpenOverviewNotice() {
    this.openNoticeEditor('', '全国总览');
  },

  // 共用的通告编辑弹窗打开逻辑：先按当前范围查一次最新一条通告用于预填，
  // 有记录则后续走 update（带 id），没有则走 create——与 index.ts fetchNotices/
  // onSaveNotice 同款"严格互斥查询 + create/update 二选一"模式，不新增云函数动作
  async openNoticeEditor(scopeStoreId: string, scopeLabel: string) {
    this.setData({
      showNoticeModal: true,
      noticeLoading: true,
      noticeForm: {
        scopeStoreId,
        scopeLabel,
        id: '',
        tag: '通知',
        title: '',
        content: ''
      }
    });

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: { action: 'list', storeId: scopeStoreId }
      });
      const result = res.result as any;
      const list = (result && result.success && Array.isArray(result.data)) ? result.data : [];
      const latest = list.length > 0 ? list[0] : null;

      this.setData({
        noticeLoading: false,
        noticeForm: {
          scopeStoreId,
          scopeLabel,
          id: (latest && latest._id) || '',
          tag: (latest && latest.tag) || '通知',
          title: (latest && latest.title) || '',
          content: (latest && latest.content) || ''
        }
      });
    } catch (err) {
      console.error('[store-management] openNoticeEditor 查询失败:', err);
      this.setData({ noticeLoading: false });
      wx.showToast({ title: '当前通告加载失败', icon: 'none' });
    }
  },

  onCloseNoticeModal() {
    if (this.data.noticeSubmitting) return;
    this.setData({ showNoticeModal: false });
  },

  onNoticeTagInput(e: any) {
    this.setData({ 'noticeForm.tag': e.detail.value });
  },

  onNoticeTitleInput(e: any) {
    this.setData({ 'noticeForm.title': e.detail.value });
  },

  onNoticeContentInput(e: any) {
    this.setData({ 'noticeForm.content': e.detail.value });
  },

  async onSubmitNotice() {
    const { scopeStoreId, id, tag, title, content } = this.data.noticeForm;
    const trimmedTitle = (title || '').trim();
    const trimmedContent = (content || '').trim();

    if (!trimmedContent) {
      wx.showToast({ title: '请输入通告内容', icon: 'none' });
      return;
    }

    this.setData({ noticeSubmitting: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'manageNotice',
        data: {
          action: id ? 'update' : 'create',
          id: id || undefined,
          storeId: scopeStoreId,
          tag: tag || '通知',
          title: trimmedTitle || tag || '通知',
          content: trimmedContent,
          isActive: true
        }
      });
      const result = res.result as any;

      wx.hideLoading();
      this.setData({ noticeSubmitting: false });

      if (result && result.success) {
        this.setData({ showNoticeModal: false });
        wx.showToast({ title: id ? '通告已更新' : '通告已发布', icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.error) || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ noticeSubmitting: false });
      console.error('[store-management] onSubmitNotice 异常:', err);
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  // 停用 / 重新启用门店
  onToggleStoreStatus(e: any) {
    const { storeid, storename, status } = e.currentTarget.dataset;
    const targetStatus = status === 'active' ? 'inactive' : 'active';
    const actionLabel = targetStatus === 'inactive' ? '停用' : '启用';

    wx.showModal({
      title: `确认${actionLabel}「${storename}」？`,
      content: targetStatus === 'inactive'
        ? '停用后该门店将从「选择服务门店」与邀请码生成列表中隐藏，但历史数据不会丢失，可随时重新启用。'
        : '重新启用后该门店将恢复在「选择服务门店」与邀请码生成列表中可选。',
      confirmColor: targetStatus === 'inactive' ? '#E03131' : '#8C1D18',
      success: (res) => {
        if (res.confirm) {
          this.doToggleStoreStatus(storeid, targetStatus);
        }
      }
    });
  },

  async doToggleStoreStatus(storeId: string, targetStatus: 'active' | 'inactive') {
    if (this.data.togglingStatusId) return;
    this.setData({ togglingStatusId: storeId });
    wx.showLoading({ title: '处理中...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'updateStoreStatus',
        data: { storeId, status: targetStatus }
      });
      const result = res.result as any;

      wx.hideLoading();

      if (result && result.success) {
        const list = this.data.list.map((item: any) =>
          item.storeId === storeId ? { ...item, status: targetStatus } : item
        );
        this.setData({ list });
        wx.showToast({ title: targetStatus === 'inactive' ? '门店已停用' : '门店已重新启用', icon: 'success' });

        // 停用/启用会改变门店在"选择服务门店"/邀请码弹窗里的可见性，同样需要清缓存
        wx.removeStorageSync('all_stores_list_cache');
        wx.removeStorageSync('all_stores_list_cache_time');
      } else {
        wx.showToast({ title: (result && result.error) || '操作失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[store-management] doToggleStoreStatus 异常:', err);
      wx.showToast({ title: '操作失败，请重试', icon: 'none' });
    } finally {
      this.setData({ togglingStatusId: '' });
    }
  },

  // 生成邀请码：不在本页复制一套邀请码 UI，跳回首页触发已有的 onOpenGenCodeModal 并预选中该门店
  onGoToGenerateCode(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    setGenCodeHandoff({ storeId: storeid, storeName: storename });
    wx.switchTab({
      url: '/pages/index/index',
      fail: (err) => {
        console.warn('[store-management] 跳转首页生成邀请码失败:', err);
      }
    });
  },

  onOpenRename(e: any) {
    const { storeid, storename } = e.currentTarget.dataset;
    this.setData({
      showRenameModal: true,
      renameForm: { storeId: storeid, oldName: storename, newName: storename }
    });
  },

  onCloseRename() {
    if (this.data.submitting) return;
    this.setData({ showRenameModal: false });
  },

  onRenameInput(e: any) {
    this.setData({ 'renameForm.newName': e.detail.value });
  },

  async onSubmitRename() {
    const { storeId, oldName, newName } = this.data.renameForm;
    const trimmed = (newName || '').trim();

    if (!trimmed) {
      wx.showToast({ title: '请输入新的门店名称', icon: 'none' });
      return;
    }
    if (trimmed === oldName) {
      wx.showToast({ title: '名称未发生变化', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'updateStoreName',
        data: { storeId, newStoreName: trimmed }
      });
      const result = res.result as any;

      wx.hideLoading();
      this.setData({ submitting: false });

      if (result && result.success) {
        const updatedName = result.storeName || trimmed;
        const list = this.data.list.map((item: any) =>
          item.storeId === storeId ? { ...item, storeName: updatedName } : item
        );
        this.setData({ list, showRenameModal: false });
        wx.showToast({ title: '门店名称已更新', icon: 'success' });
      } else {
        wx.showToast({ title: (result && result.error) || '修改失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false });
      console.error('[store-management] onSubmitRename 异常:', err);
      wx.showToast({ title: '修改失败，请重试', icon: 'none' });
    }
  },

  onOpenCreateStore() {
    this.setData({
      showCreateModal: true,
      createForm: {
        storeName: '', address: '', announcement: '',
        province: '', operatingStatus: 'operating', latitude: undefined, longitude: undefined, locationLabel: ''
      }
    });
  },

  onCloseCreateStore() {
    if (this.data.creating) return;
    this.setData({ showCreateModal: false });
  },

  onCreateFormInput(e: any) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [`createForm.${field}`]: e.detail.value });
  },

  onSelectCreateOperatingStatus(e: any) {
    this.setData({ 'createForm.operatingStatus': e.currentTarget.dataset.value });
  },

  // 📍 建店时选择门店位置：wx.chooseLocation 与 store-picker 的 wx.getLocation
  // 共用同一条 app.json "scope.userLocation" 权限声明
  async onChooseStoreLocation() {
    try {
      const res: any = await wx.chooseLocation({});
      this.setData({
        'createForm.latitude': res.latitude,
        'createForm.longitude': res.longitude,
        'createForm.locationLabel': res.name || res.address || `${res.latitude}, ${res.longitude}`
      });
      // 未手动填写地址时，用选点结果顺手带出地址，减少重复输入
      if (!this.data.createForm.address && res.address) {
        this.setData({ 'createForm.address': res.address });
      }
    } catch (err) {
      console.warn('[store-management] 选择门店位置失败/取消:', err);
    }
  },

  async onSubmitCreateStore() {
    const { storeName, address, announcement, province, operatingStatus, latitude, longitude } = this.data.createForm;
    const trimmedName = (storeName || '').trim();

    if (!trimmedName) {
      wx.showToast({ title: '请填写门店名称', icon: 'none' });
      return;
    }

    this.setData({ creating: true });
    wx.showLoading({ title: '创建中...', mask: true });

    try {
      const res = await wx.cloud.callFunction({
        name: 'createStore',
        data: {
          storeName: trimmedName,
          address: (address || '').trim(),
          initialAnnouncement: (announcement || '').trim(),
          province: (province || '').trim(),
          operatingStatus,
          ...(typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : {}),
          bindAsManager: true
        }
      });
      const result = res.result as any;

      wx.hideLoading();
      this.setData({ creating: false });

      if (result && result.success) {
        // 🌟 公告系统已云端化（见 manageNotice 云函数），initialAnnouncement 在
        // createStore 里只是落库存证，这里再补一条真正挂在新店名下的跑马灯通知，
        // 让操作人建店后首页就能看到公告生效——失败不影响建店本身，只是提醒一下
        const trimmedAnnouncement = (announcement || '').trim();
        if (trimmedAnnouncement) {
          try {
            await wx.cloud.callFunction({
              name: 'manageNotice',
              data: {
                action: 'create',
                storeId: result.storeId,
                tag: '开业公告',
                title: result.storeName,
                content: trimmedAnnouncement,
                isActive: true
              }
            });
          } catch (noticeErr) {
            console.warn('[store-management] 初始公告发布失败（不影响建店结果）:', noticeErr);
          }
        }

        // 🔑 bindAsManager 只在后端把 user_roles.storeId 指到新店，前端有两处各自
        // 缓存的"当前门店"状态不会自动跟着变，必须显式刷新，否则回到首页看到的还是旧店
        await AuthService.fetchUserRole();
        setSelectedStore({ storeId: result.storeId, storeName: result.storeName });

        // 🐛 修复"首页选不到新店"：门店管理是独立页面，index.ts 的 allStoresList
        // 有 5 分钟本地缓存（all_stores_list_cache），且只在 <store-picker> 自身触发
        // storelistchange 事件时才会清（见 index.ts onStoreListChanged）——从这里建店
        // 完全触发不到那个事件，缓存不清就会让首页门店选择器/邀请码弹窗看不到新店
        // 长达 5 分钟。与 onStoreListChanged 用完全一致的清理方式，保持约定统一。
        wx.removeStorageSync('all_stores_list_cache');
        wx.removeStorageSync('all_stores_list_cache_time');

        this.setData({ showCreateModal: false });
        wx.showToast({ title: '门店创建成功', icon: 'success' });

        // 🌟 延时 1.5 秒（等 toast 显示完）后整页重载：重新走一遍 checkAccess ->
        // loadStoreList，让视图从空状态平滑切换到新建门店，不需要用户手动下拉刷新
        setTimeout(() => {
          this.onLoad();
        }, 1500);
      } else {
        wx.showToast({ title: (result && result.error) || '创建失败', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ creating: false });
      console.error('[store-management] onSubmitCreateStore 异常:', err);
      wx.showToast({ title: '创建失败，请重试', icon: 'none' });
    }
  },

  stopPropagation() {
    // 阻止弹窗内部点击冒泡触发遮罩层关闭
  },

  goBack() {
    if (this._navGuard) {
      this._navGuard.goHome();
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.reLaunch({ url: '/pages/index/index' });
    }
  }
});
