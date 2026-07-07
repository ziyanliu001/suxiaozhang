const OPENID_CACHE_KEY = 'auth_openid';
const USER_CACHE_KEY = 'auth_user';
const LOGIN_TIMEOUT_MS = 5000;

function withTimeout(promise, timeoutMs, timeoutMsg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const AuthService = {
  async ensureLogin(): Promise<{ success: boolean; openid?: string; error?: string }> {
    const cached = this.getOpenid();
    if (cached) {
      return { success: true, openid: cached };
    }

    try {
      const result = await withTimeout(
        wx.cloud.callFunction({ name: 'login' }),
        LOGIN_TIMEOUT_MS,
        '登录超时，请检查网络后重试'
      );

      const r = result.result as any;
      if (r && r.success && r.openid) {
        wx.setStorageSync(OPENID_CACHE_KEY, r.openid);
        if (r.user) {
          wx.setStorageSync(USER_CACHE_KEY, JSON.stringify(r.user));
        }
        console.log('[AuthService] 静默登录成功:', r.openid);
        return { success: true, openid: r.openid };
      }

      console.warn('[AuthService] 登录失败:', r?.error);
      return { success: false, error: r?.error || '登录失败' };
    } catch (err: any) {
      console.error('[AuthService] 登录异常:', err);
      const msg = err.errMsg || err.message || '网络异常，请重试';
      return { success: false, error: msg };
    }
  },

  getOpenid(): string | null {
    try {
      return wx.getStorageSync(OPENID_CACHE_KEY) || null;
    } catch {
      return null;
    }
  },

  getUser(): any | null {
    try {
      const data = wx.getStorageSync(USER_CACHE_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  isLoggedIn(): boolean {
    return !!this.getOpenid();
  },

  clearAuth(): void {
    try {
      wx.removeStorageSync(OPENID_CACHE_KEY);
      wx.removeStorageSync(USER_CACHE_KEY);
      console.log('[AuthService] 登录缓存已清除');
    } catch (err) {
      console.error('[AuthService] clearAuth 异常:', err);
    }
  }
};
