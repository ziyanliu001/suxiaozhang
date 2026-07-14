const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const LOCK_TTL_MS = 15 * 60 * 1000;
const MIN_RENEW_INTERVAL_MS = 30 * 1000;

/**
 * 事务版本：查询用户角色
 */
async function getUserRoleInTransaction(transaction, openId) {
  try {
    const roleRes = await transaction.collection('user_roles')
      .where({ _openid: openId })
      .limit(1)
      .get();
    if (roleRes.data && roleRes.data.length > 0) {
      const user = roleRes.data[0];
      return {
        role: user.role || 'volunteer',
        name: user.realName || user.name || user.nickName || '义工',
        isAdmin: ['super_admin', 'store_manager'].includes(user.role)
      };
    }

    const userRes = await transaction.collection('users')
      .where({ _openid: openId })
      .limit(1)
      .get();
    if (userRes.data && userRes.data.length > 0) {
      const user = userRes.data[0];
      const oldRole = user.role || 'user';
      const mappedRole = oldRole === 'admin' ? 'super_admin' : 'volunteer';
      return {
        role: mappedRole,
        name: user.realName || user.name || user.nickName || '义工',
        isAdmin: mappedRole === 'super_admin' || mappedRole === 'store_manager'
      };
    }
  } catch (e) {
    console.error('[manageDraftLock] 查询用户角色失败:', e);
  }
  return { role: 'volunteer', name: '义工', isAdmin: false };
}

/**
 * 非事务版本：查询用户角色（用于非事务场景）
 */
async function getUserRole(openId) {
  try {
    const roleRes = await db.collection('user_roles')
      .where({ _openid: openId })
      .limit(1)
      .get();
    if (roleRes.data && roleRes.data.length > 0) {
      const user = roleRes.data[0];
      return {
        role: user.role || 'volunteer',
        name: user.realName || user.name || user.nickName || '义工',
        isAdmin: ['super_admin', 'store_manager'].includes(user.role)
      };
    }

    const userRes = await db.collection('users')
      .where({ _openid: openId })
      .limit(1)
      .get();
    if (userRes.data && userRes.data.length > 0) {
      const user = userRes.data[0];
      const oldRole = user.role || 'user';
      const mappedRole = oldRole === 'admin' ? 'super_admin' : 'volunteer';
      return {
        role: mappedRole,
        name: user.realName || user.name || user.nickName || '义工',
        isAdmin: mappedRole === 'super_admin' || mappedRole === 'store_manager'
      };
    }
  } catch (e) {
    console.error('[manageDraftLock] 查询用户角色失败:', e);
  }
  return { role: 'volunteer', name: '义工', isAdmin: false };
}

/**
 * 脱敏 openId（仅保留后4位）
 */
function maskOpenId(openId) {
  if (!openId || openId.length < 8) return '***';
  return '***' + openId.slice(-4);
}

/**
 * 校验锁的 storeId 字段是否匹配
 */
function validateLockStoreId(lockData, expectedStoreId) {
  if (!lockData) return true;
  if (lockData.storeId && lockData.storeId !== expectedStoreId) {
    console.error('[manageDraftLock] storeId 不匹配:', lockData.storeId, '!=', expectedStoreId);
    return false;
  }
  return true;
}

exports.main = async (event, context) => {
  const { action, storeId, reportDate } = event;
  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID;

  if (!openId) {
    return { success: false, errMsg: '无法获取用户身份' };
  }

  const lockDocId = `lock_${storeId}_${reportDate}`;

  // ─── ACQUIRE：事务原子加锁 ──────────────────────────────
  if (action === 'ACQUIRE') {
    try {
      const result = await db.runTransaction(async (transaction) => {
        const now = Date.now();
        let currentLock = null;
        try {
          const lockDoc = await transaction.collection('store_locks').doc(lockDocId).get();
          currentLock = lockDoc.data;
        } catch (e) {
          currentLock = null;
        }

        // 校验 storeId 字段（防止文档被错误覆盖）
        if (!validateLockStoreId(currentLock, storeId)) {
          return { success: false, errMsg: '门店数据异常，请刷新重试' };
        }

        // 已有有效锁，且持有者不是本人 → 加锁失败
        if (currentLock && currentLock.expireAt > now && currentLock.ownerOpenId !== openId) {
          return {
            success: false,
            isLocked: true,
            lockedBy: currentLock.operatorName || '其他义工',
            expireAt: currentLock.expireAt,
            remainingMs: Math.max(0, currentLock.expireAt - now),
            message: `义工【${currentLock.operatorName}】正在录入此餐报中，您当前为只读视图。`
          };
        }

        // 无锁 / 锁已过期 / 本人持有 → 原子设置锁
        const userInfo = await getUserRoleInTransaction(transaction, openId);
        const newLock = {
          storeId,
          reportDate,
          ownerOpenId: openId,
          operatorName: userInfo.name,
          acquiredAt: currentLock && currentLock.ownerOpenId === openId ? currentLock.acquiredAt : now,
          lastRenewAt: now,
          expireAt: now + LOCK_TTL_MS
        };

        await transaction.collection('store_locks').doc(lockDocId).set({
          data: newLock
        });

        return {
          success: true,
          isLocked: false,
          expireAt: newLock.expireAt,
          remainingMs: LOCK_TTL_MS
        };
      });

      return result;
    } catch (err) {
      console.error('[manageDraftLock] ACQUIRE 事务失败:', err);
      return { success: false, errMsg: '加锁失败，请稍后重试' };
    }
  }

  // ─── RENEW：事务原子续期 ────────────────────────────────
  else if (action === 'RENEW') {
    try {
      const result = await db.runTransaction(async (transaction) => {
        const now = Date.now();
        let currentLock = null;
        try {
          const lockDoc = await transaction.collection('store_locks').doc(lockDocId).get();
          currentLock = lockDoc.data;
        } catch (e) {
          currentLock = null;
        }

        if (!currentLock) {
          return { success: false, errMsg: '锁不存在' };
        }

        // 校验 storeId
        if (!validateLockStoreId(currentLock, storeId)) {
          return { success: false, errMsg: '门店数据异常' };
        }

        // 校验持有者
        if (currentLock.ownerOpenId !== openId) {
          return { success: false, errMsg: '无权续期他人的锁' };
        }

        // 防止频繁续期
        if (currentLock.lastRenewAt && now - currentLock.lastRenewAt < MIN_RENEW_INTERVAL_MS) {
          return {
            success: true,
            expireAt: currentLock.expireAt,
            remainingMs: Math.max(0, currentLock.expireAt - now)
          };
        }

        const newExpireAt = now + LOCK_TTL_MS;
        await transaction.collection('store_locks').doc(lockDocId).update({
          data: {
            lastRenewAt: now,
            expireAt: newExpireAt
          }
        });

        return {
          success: true,
          expireAt: newExpireAt,
          remainingMs: LOCK_TTL_MS
        };
      });

      return result;
    } catch (err) {
      console.error('[manageDraftLock] RENEW 事务失败:', err);
      return { success: false, errMsg: '续期失败' };
    }
  }

  // ─── RELEASE：事务原子释放 ──────────────────────────────
  else if (action === 'RELEASE') {
    try {
      const result = await db.runTransaction(async (transaction) => {
        const now = Date.now();
        let currentLock = null;
        try {
          const lockDoc = await transaction.collection('store_locks').doc(lockDocId).get();
          currentLock = lockDoc.data;
        } catch (e) {
          currentLock = null;
        }

        // 锁不存在或已过期 → 视为成功
        if (!currentLock || currentLock.expireAt <= now) {
          return { success: true };
        }

        // 校验 storeId
        if (!validateLockStoreId(currentLock, storeId)) {
          return { success: false, errMsg: '门店数据异常' };
        }

        // 获取用户角色
        const userInfo = await getUserRoleInTransaction(transaction, openId);

        // 仅持有者本人或管理员可释放
        if (currentLock.ownerOpenId !== openId && !userInfo.isAdmin) {
          return { success: false, errMsg: '无权释放他人的锁' };
        }

        await transaction.collection('store_locks').doc(lockDocId).remove();
        return { success: true };
      });

      return result;
    } catch (err) {
      console.error('[manageDraftLock] RELEASE 事务失败:', err);
      // 文档不存在也算成功
      if (err && (err.errCode === -1 || err.message && err.message.includes('not found'))) {
        return { success: true };
      }
      return { success: false, errMsg: '释放锁失败' };
    }
  }

  // ─── FORCE_RELEASE：管理员强制释放 ──────────────────────
  else if (action === 'FORCE_RELEASE') {
    try {
      const result = await db.runTransaction(async (transaction) => {
        // 事务内验证管理员身份
        const userInfo = await getUserRoleInTransaction(transaction, openId);
        if (!userInfo.isAdmin) {
          return { success: false, errMsg: '无管理员权限' };
        }

        let currentLock = null;
        try {
          const lockDoc = await transaction.collection('store_locks').doc(lockDocId).get();
          currentLock = lockDoc.data;
        } catch (e) {
          currentLock = null;
        }

        // 锁不存在也视为成功
        if (!currentLock) {
          return { success: true };
        }

        // 校验 storeId
        if (!validateLockStoreId(currentLock, storeId)) {
          return { success: false, errMsg: '门店数据异常' };
        }

        await transaction.collection('store_locks').doc(lockDocId).remove();
        return { success: true };
      });

      return result;
    } catch (err) {
      if (err && (err.errCode === -1 || err.message && err.message.includes('not found'))) {
        return { success: true };
      }
      console.error('[manageDraftLock] FORCE_RELEASE 事务失败:', err);
      return { success: false, errMsg: '强制释放失败' };
    }
  }

  // ─── QUERY：查询锁状态（ownerOpenId 脱敏） ─────────────
  else if (action === 'QUERY') {
    try {
      const now = Date.now();
      const lockRes = await db.collection('store_locks').doc(lockDocId).get();
      const lockData = lockRes.data;

      if (!lockData || lockData.expireAt <= now) {
        return {
          success: true,
          isLocked: false,
          remainingMs: 0
        };
      }

      // 校验 storeId
      if (!validateLockStoreId(lockData, storeId)) {
        return { success: true, isLocked: false, remainingMs: 0, errMsg: '门店数据异常' };
      }

      const userInfo = await getUserRole(openId);

      return {
        success: true,
        isLocked: true,
        lockedBy: lockData.operatorName || '其他义工',
        ownerOpenIdMasked: maskOpenId(lockData.ownerOpenId),  // 脱敏
        expireAt: lockData.expireAt,
        remainingMs: Math.max(0, lockData.expireAt - now),
        isOwner: lockData.ownerOpenId === openId,
        canForceUnlock: userInfo.isAdmin
      };
    } catch (err) {
      return { success: true, isLocked: false, remainingMs: 0 };
    }
  }

  return { success: false, errMsg: '未知操作类型' };
};