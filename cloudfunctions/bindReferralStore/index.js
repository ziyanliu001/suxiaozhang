// 云函数：bindReferralStore
// 朋友圈证书扫码引流：证书二维码 scene 出于 32 字符硬限制（见 getStoreQRCode），
// 只编码了 openid/storeId 各自的前 10 位前缀（u=<openid前10位>&s=<storeId前10位>），
// 不是完整 ID。本函数按前缀模糊匹配还原出真实门店/分享人，供首页邀请弹窗展示
// 与实际绑定使用。
//
// 🛡️ 前缀匹配是有损的（理论上存在多个 _openid/门店 _id 共享同一 10 位前缀而
// 撞车的极小概率），但这是证书 scene 长度限制下的既定取舍——邀请绑定本身也只是
// "把家人/义工的当前门店预设为分享者所在门店"这类低风险的展示性操作，不涉及
// 审批/资金，撞车的后果至多是门店预设不准确，用户仍可随时手动切店纠正。
//
// action: 'resolve' —— 只读，返回门店名 + 分享人昵称，供确认弹窗文案使用，不写库
// action: 'bind'    —— 写入/更新调用者 user_roles 记录的 storeId/storeName

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PREFIX_SCAN_LIMIT = 200;

async function findStoreByIdPrefix(prefix) {
  if (!prefix) return null;
  const res = await db.collection('stores')
    .where({ status: db.command.neq('inactive') })
    .limit(PREFIX_SCAN_LIMIT)
    .get();
  return (res.data || []).find((s) => String(s._id).startsWith(prefix)) || null;
}

async function findUserRoleByOpenidPrefix(prefix) {
  if (!prefix) return null;
  const res = await db.collection('user_roles').limit(PREFIX_SCAN_LIMIT).get();
  return (res.data || []).find((u) => String(u._openid).startsWith(prefix)) || null;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, storeIdPrefix, referrerIdPrefix } = event;

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }
  if (!storeIdPrefix) {
    return { success: false, error: '缺少门店标识' };
  }

  try {
    const store = await findStoreByIdPrefix(storeIdPrefix);
    if (!store) {
      return { success: false, error: '未找到邀请对应的门店' };
    }
    const storeName = store.storeName || '雨花斋';

    if (action === 'resolve') {
      const referrer = await findUserRoleByOpenidPrefix(referrerIdPrefix);
      return {
        success: true,
        data: {
          storeId: store._id,
          storeName,
          referrerNickName: (referrer && referrer.nickName) || '一位爱心义工'
        }
      };
    }

    if (action === 'bind') {
      const existing = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
      if (existing.data && existing.data.length > 0) {
        await db.collection('user_roles').doc(existing.data[0]._id).update({
          data: { storeId: store._id, storeName }
        });
      } else {
        // 🌟 未审核的家人/服务对象在此之前可能压根没有 user_roles 记录
        // （见 checkUserRole 云函数 status:'guest' 分支）——新建一条默认义工身份、
        // 待审核状态的记录，只是把门店预设指向邀请来源，不代表已通过任何审批
        await db.collection('user_roles').add({
          data: {
            _openid: OPENID,
            role: 'volunteer',
            status: 'guest',
            storeId: store._id,
            storeName,
            createTime: db.serverDate()
          }
        });
      }
      return { success: true, data: { storeId: store._id, storeName } };
    }

    return { success: false, error: '无效操作' };
  } catch (err) {
    console.error('[bindReferralStore] 异常:', err);
    return { success: false, error: err.message || '绑定异常' };
  }
};
