// 页面：加入产销工坊 —— 扫码 或 手动输入邀请码 的统一落地页
//
// 🚪 两种进入方式：
//   1. 扫码：manageWorkspaceInvite.generate 生成的小程序码 page 直接指向本页
//      （不是雨花公益专区惯用的"统一落地 pages/index/index 再由 app.ts 全局
//      解析 scene"模式），微信扫码启动时 options.scene 会直接传给本页的
//      onLoad，本页自己解码、自己处理，不需要改动 app.ts/index.ts。
//   2. 手动输入：profile.ts 的"输入工坊邀请码加入"入口直接 navigateTo 本页，
//      不带任何参数，用户在页面里自己输入 6 位邀请码。
interface PeekResult {
  tenantId: string;
  tenantName: string;
  role: string;
  roleLabel: string;
}

Page({
  data: {
    navTop: 0,
    contentTop: 0,

    code: '',
    peeking: false,
    peekResult: null as PeekResult | null,
    peekError: '',

    realName: '',
    phone: '',
    submitting: false,

    // 🎨 纯交互态，不影响 peek/redeem 业务逻辑：当前聚焦的输入框 field 名
    // （'code'/'realName'/'phone'），驱动高亮边框；清空按钮复用同一个
    // data-field 约定
    focusedField: ''
  },

  onLoad(options: Record<string, string>) {
    this.calculateNavBarHeight();

    // 扫码启动：options.scene 是 URL 编码过的 "wcode=XXXXXX"
    const rawScene = options && (options.scene || (options as any).query?.scene);
    if (rawScene) {
      const scene = decodeURIComponent(rawScene);
      const match = /(?:^|&)wcode=([A-Z0-9]+)/i.exec(scene);
      if (match && match[1]) {
        const code = match[1].toUpperCase();
        this.setData({ code });
        this.doPeek(code);
        return;
      }
    }
    // 兼容未来可能出现的直接携带 code 参数打开本页的场景（当前仓库内暂无调用方）
    if (options && options.code) {
      const code = String(options.code).toUpperCase();
      this.setData({ code });
      this.doPeek(code);
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

  goBack() {
    // 扫码冷启动时可能没有可返回的页面栈，失败就落到首页 tab
    wx.navigateBack({
      delta: 1,
      fail: () => wx.switchTab({ url: '/pages/index/index' })
    });
  },

  onCodeInput(e: any) {
    this.setData({ code: String(e.detail.value || '').toUpperCase(), peekResult: null, peekError: '' });
  },

  // 🎨 聚焦高亮边框：纯展示态，data-field 与 wxml 里三个 input 的
  // data-field="code"/"realName"/"phone" 一一对应
  onFieldFocus(e: any) {
    this.setData({ focusedField: e.currentTarget.dataset.field || '' });
  },

  onFieldBlur() {
    this.setData({ focusedField: '' });
  },

  // 🎨 一键清空：只清空对应字段本身，code 字段额外清掉上一次查询结果，
  // 避免清空后残留一份"对不上当前输入"的邀请码预览
  onClearField(e: any) {
    const field = e.currentTarget.dataset.field;
    if (field === 'code') {
      this.setData({ code: '', peekResult: null, peekError: '' });
    } else if (field === 'realName') {
      this.setData({ realName: '' });
    } else if (field === 'phone') {
      this.setData({ phone: '' });
    }
  },

  onTapPeek() {
    if (this.data.peeking) return; // 防重复点击：查询进行中再次点击直接忽略
    const code = (this.data.code || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' });
      return;
    }
    this.doPeek(code);
  },

  async doPeek(code: string) {
    this.setData({ peeking: true, peekResult: null, peekError: '' });
    try {
      const res = await wx.cloud.callFunction({ name: 'manageWorkspaceInvite', data: { action: 'peek', code } });
      const result = res.result as any;
      if (result && result.success) {
        this.setData({
          peekResult: {
            tenantId: result.tenantId,
            tenantName: result.tenantName,
            role: result.role,
            roleLabel: result.roleLabel
          }
        });
      } else {
        this.setData({ peekError: (result && result.error) || '邀请码无效' });
      }
    } catch (err) {
      console.error('[workspace-join] doPeek 异常:', err);
      this.setData({ peekError: '查询异常，请重试' });
    } finally {
      this.setData({ peeking: false });
    }
  },

  onRealNameInput(e: any) {
    this.setData({ realName: e.detail.value });
  },

  onPhoneInput(e: any) {
    this.setData({ phone: e.detail.value });
  },

  async onConfirmJoin() {
    if (this.data.submitting) return;
    if (!this.data.peekResult) return;
    const realName = (this.data.realName || '').trim();
    if (!realName) {
      wx.showToast({ title: '请填写您的真实姓名', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '加入中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'manageWorkspaceInvite',
        data: { action: 'redeem', code: this.data.code, realName, phone: this.data.phone }
      });
      const result = res.result as any;
      wx.hideLoading();

      if (!result || !result.success) {
        wx.showToast({ title: (result && result.error) || '加入失败，请重试', icon: 'none' });
        return;
      }

      wx.showToast({ title: `已加入「${result.tenantName}」`, icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/profile/profile' }), 1200);
    } catch (err) {
      wx.hideLoading();
      console.error('[workspace-join] onConfirmJoin 异常:', err);
      wx.showToast({ title: '加入失败，请重试', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
