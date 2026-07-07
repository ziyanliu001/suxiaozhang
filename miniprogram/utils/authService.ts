const OPENID_CACHE_KEY = 'auth_openid';
const USER_CACHE_KEY = 'auth_user';
const LOGIN_TIMEOUT_MS = 5000;
const TEMP_OPENID_PREFIX = 'local_';

function withTimeout(promise, timeoutMs, timeoutMsg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function generateTempOpenid(): string {
  return TEMP_OPENID_PREFIX + Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

export const AuthService = {
  async ensureLogin(): Promise<{ success: boolean; openid?: string; error?: string; isTemp?: boolean }> {
    const cached = this.getOpenid();
    if (cached) {
      return { success: true, openid: cached, isTemp: cached.startsWith(TEMP_OPENID_PREFIX) };
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
        return { success: true, openid: r.openid, isTemp: false };
      }

      console.warn('[AuthService] 登录失败，使用临时 openid:', r?.error);
      const tempOpenid = generateTempOpenid();
      wx.setStorageSync(OPENID_CACHE_KEY, tempOpenid);
      return { success: true, openid: tempOpenid, isTemp: true };
    } catch (err: any) {
      console.error('[AuthService] 登录异常，使用临时 openid:', err);
      const tempOpenid = generateTempOpenid();
      wx.setStorageSync(OPENID_CACHE_KEY, tempOpenid);
      return { success: true, openid: tempOpenid, isTemp: true };
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

  isTempOpenid(): boolean {
    const openid = this.getOpenid();
    return !!openid && openid.startsWith(TEMP_OPENID_PREFIX);
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
