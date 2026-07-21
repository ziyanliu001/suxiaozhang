// 云函数：一次性清理 user_roles 集合里的模板占位垃圾数据
// 背景：_id=9367f7326a58e975009e56c91fa5b817 这条记录的 _openid 是字面量占位符
// "你的真实OpenID"（显然是模板/文档没有被替换成真实 OpenID 就直接写进了库），
// 属于误建的垃圾数据，需要清掉，只留下真实 OpenID 的那条 status:'active' 记录。
//
// 🛡️ 安全设计：
// 1. 用 doc(TARGET_ID) 精确定位单条记录，不用 where + remove 批量删除，
//    避免像 cleanDevData 那种 `_id: exists(true)` 写法误伤到无关数据；
// 2. 删除前二次校验 _openid 必须严格等于占位符原文，任何不匹配都直接中止，
//    防止 _id 抄错或记录已被改写导致误删真实数据；
// 3. 默认 dry-run：不传 { confirm: true } 只做预检+预览，不会真的执行删除，
//    必须显式二次调用才会真正落库删除；
// 4. 删除后自动回查整张 user_roles 表并原样返回，方便直接肉眼确认「只剩
//    真实 OpenID 的那条 active 记录」，不需要再单独查一次。
//
// 用法（微信开发者工具 -> 云开发 -> 云函数 -> 本函数 -> 云端测试）：
//   第一次：测试参数传 {}，仅预检，确认 preview 里的 _openid 确实是占位符；
//   第二次：确认无误后，测试参数传 { "confirm": true }，执行真正删除。
// 清理完成后，建议把这个云函数从项目里删掉（同目录的 cleanDevData /
// recalculateLedgerChain 就是这么处理的，一次性工具用完即扔）。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const TARGET_ID = '9367f7326a58e975009e56c91fa5b817';
const PLACEHOLDER_OPENID = '你的真实OpenID';

exports.main = async (event = {}) => {
  try {
    const docRes = await db.collection('user_roles').doc(TARGET_ID).get().catch(() => null);

    if (!docRes || !docRes.data) {
      return {
        success: false,
        error: `未找到 _id=${TARGET_ID} 的记录，可能已经被清理过，或 _id 有误`
      };
    }

    const target = docRes.data;

    if (target._openid !== PLACEHOLDER_OPENID) {
      return {
        success: false,
        error: `安全校验未通过：该记录 _openid 为 "${target._openid}"，与预期占位符 "${PLACEHOLDER_OPENID}" 不一致，为防止误删已中止操作，请人工核实后再处理`,
        record: target
      };
    }

    if (!event.confirm) {
      return {
        success: true,
        dryRun: true,
        message: '预检通过：该记录确认是模板占位垃圾数据，可以安全删除。请带上 { "confirm": true } 再次调用本函数以真正执行删除。',
        preview: target
      };
    }

    await db.collection('user_roles').doc(TARGET_ID).remove();

    const remainRes = await db.collection('user_roles').get();

    return {
      success: true,
      deletedId: TARGET_ID,
      message: '占位垃圾数据已删除',
      remainingCount: remainRes.data.length,
      remaining: remainRes.data.map(r => ({
        _id: r._id,
        _openid: r._openid,
        role: r.role,
        status: r.status,
        storeName: r.storeName || '',
        tenantId: r.tenantId || ''
      }))
    };
  } catch (err) {
    return {
      success: false,
      error: (err && err.message) || String(err)
    };
  }
};
