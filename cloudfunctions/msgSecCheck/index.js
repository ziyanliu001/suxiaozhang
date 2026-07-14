const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 内容安全检测云函数
 * 
 * 降级策略：
 * 1. API 调用成功 → 返回检测结果
 * 2. API 暂时不可用 → 记录到 pending_audit 集合，标记为待人工审核
 * 3. 明确违规（errCode 87014）→ 直接拒绝
 */

exports.main = async (event, context) => {
  const { text, contentType = 'report', storeId = '', reportDate = '' } = event;
  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID;

  // 空文本直接通过
  if (!text || text.trim() === '') {
    return { safe: true, auditStatus: 'skipped' };
  }

  // 文本长度限制（微信 API 限制 500KB，这里保守限制 10000 字符）
  if (text.length > 10000) {
    return {
      safe: false,
      auditStatus: 'rejected',
      reason: '文本内容过长，请精简后重试'
    };
  }

  try {
    const result = await cloud.openapi.security.msgSecCheck({
      openid: openId,
      scene: contentType === 'notice' ? 3 : 2, // 场景：2=评论，3=公告
      version: 2,
      content: text
    });

    // 检测到违规内容
    if (result && result.result && result.result.suggest === 'risky') {
      // 记录违规日志
      await logAuditRecord(db, {
        openId,
        contentType,
        content: text.slice(0, 500), // 仅保留前500字符
        storeId,
        reportDate,
        status: 'rejected',
        reason: 'risky_content',
        timestamp: Date.now()
      });

      return {
        safe: false,
        auditStatus: 'rejected',
        reason: '内容包含违规信息'
      };
    }

    // 安全通过
    return {
      safe: true,
      auditStatus: 'passed',
      detail: result?.result?.suggest || 'pass'
    };

  } catch (err) {
    // 明确违规（错误码 87014）
    if (err.errCode === 87014 || (err.errMsg && err.errMsg.includes('87014'))) {
      await logAuditRecord(db, {
        openId,
        contentType,
        content: text.slice(0, 500),
        storeId,
        reportDate,
        status: 'rejected',
        reason: 'errcode_87014',
        timestamp: Date.now()
      });

      return {
        safe: false,
        auditStatus: 'rejected',
        reason: '内容包含违规信息'
      };
    }

    // API 暂时不可用 → 降级策略：允许通过，但记录到待审核队列
    console.warn('[msgSecCheck] API 调用失败，启用降级策略:', err);

    // 记录到待审核队列
    await logAuditRecord(db, {
      openId,
      contentType,
      content: text.slice(0, 500),
      storeId,
      reportDate,
      status: 'pending_audit',
      reason: 'api_unavailable',
      errorMessage: err.message || err.errMsg || 'unknown',
      timestamp: Date.now()
    });

    // 降级通过（可根据配置改为拒绝）
    return {
      safe: true,
      auditStatus: 'degraded_pass',
      message: '内容审核服务暂时不可用，已标记为待审核',
      degraded: true
    };
  }
};

/**
 * 记录审核日志
 */
async function logAuditRecord(db, record) {
  try {
    // 尝试写入 pending_audit 集合（如不存在则静默失败）
    await db.collection('content_audit_logs').add({
      data: record
    });
  } catch (e) {
    // 集合不存在时静默失败
    console.warn('[msgSecCheck] 记录审核日志失败:', e.message);
  }
}