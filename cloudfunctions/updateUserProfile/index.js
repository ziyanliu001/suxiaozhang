// 云函数：updateUserProfile - 更新当前用户头像/昵称
//
// 接入微信官方"头像昵称填写能力"配套后端：
// - avatarUrl：客户端先通过 button open-type="chooseAvatar" 拿到临时头像文件，
//   自行 wx.cloud.uploadFile 上传到 users/avatars/ 目录后，把返回的 fileID 传进来，
//   本函数只做校验与落库，不处理文件上传本身。
// - nickName：客户端 <input type="nickname"> 失焦后拿到的最终昵称文本。
//
// 写入位置：本项目以 user_roles 作为"当前用户是谁"的唯一权威记录（同时承载角色/门店/
// 机构信息），头像昵称同样写在这张表上，避免再引入一张 users/user_profiles 表造成
// 同一用户的身份信息分裂在两处、后续查询要做二次 join。
// 若调用者尚无 user_roles 记录（全新用户，还未申请任何门店角色），则按 volunteer/guest
// 状态新建一条最小记录，确保"先完善头像昵称、再申请门店身份"这个更自然的使用顺序可行。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_NICKNAME_LENGTH = 20;

function isLikelyCloudFileId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { avatarUrl, nickName } = event;

  if (!OPENID) {
    return { success: false, error: '无法获取用户身份' };
  }

  const updateData = {};

  if (avatarUrl !== undefined) {
    if (!isLikelyCloudFileId(avatarUrl)) {
      return { success: false, error: '头像地址不合法' };
    }
    updateData.avatarUrl = avatarUrl;
  }

  if (nickName !== undefined) {
    const trimmed = String(nickName).trim();
    if (!trimmed) {
      return { success: false, error: '昵称不能为空' };
    }
    if (trimmed.length > MAX_NICKNAME_LENGTH) {
      return { success: false, error: `昵称过长（最多 ${MAX_NICKNAME_LENGTH} 字）` };
    }
    updateData.nickName = trimmed;
  }

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: '缺少 avatarUrl 或 nickName 参数' };
  }

  try {
    const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
    const existing = roleRes.data && roleRes.data[0];

    if (existing) {
      updateData.updateTime = db.serverDate();
      await db.collection('user_roles').doc(existing._id).update({ data: updateData });
    } else {
      // 全新用户：尚未申请任何门店角色，先落地一条最小身份记录承载头像昵称
      // 🛡️ 服务端 SDK 的 .add() 不会像客户端 SDK 那样自动注入 _openid，必须显式写入，
      // 否则下次调用时 .where({ _openid: OPENID }) 查不到这条记录，会重复建出多条孤儿记录
      await db.collection('user_roles').add({
        data: {
          _openid: OPENID,
          role: 'volunteer',
          status: 'guest',
          storeId: '',
          storeName: '',
          tenantId: '',
          avatarUrl: updateData.avatarUrl || '',
          nickName: updateData.nickName || '',
          createdAt: db.serverDate(),
          updateTime: db.serverDate()
        }
      });
    }

    return {
      success: true,
      avatarUrl: updateData.avatarUrl,
      nickName: updateData.nickName
    };
  } catch (err) {
    console.error('[updateUserProfile] 异常:', err);
    return { success: false, error: err.message || '更新用户资料失败' };
  }
};
