// 云函数：getStoreList
// 替代前端直接 db.collection('stores').get() 的全表查询。
//
// 🏢 多租户边界：门店列表（哪怕只是门店名称）也是机构的商业信息，不应被其他机构
// 或平台管理员看到。本函数按调用者所属 tenantId 过滤：
// - platform_admin 显式拒绝（不返回任何门店信息，符合其"不碰业务数据"的边界）；
// - 已分配 tenantId 的账号按 tenantId 过滤；
// - 尚未回填 tenantId 的账号（游客/未审批）直接返回空列表，不再退回"不过滤"的全表
//   兜底行为——backfillTenantId 已可用于回填存量数据，不应再以数据泄露为代价兼容旧账号。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 🛡️ 默认只返回 status==='active' 的门店（切店/邀请码等场景不该选到已停用门店）；
  // 仅门店管理页自己需要连"已停用"门店一起看（以便重新启用），显式传 includeInactive:true
  const includeInactive = !!(event && event.includeInactive);

  try {
    let tenantId = '';
    let role = '';
    if (OPENID) {
      const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
      if (roleRes.data && roleRes.data.length > 0) {
        tenantId = roleRes.data[0].tenantId || '';
        role = roleRes.data[0].role || '';
      }
    }

    if (role === 'platform_admin') {
      return { success: true, list: [] };
    }

    if (!tenantId) {
      return { success: true, list: [] };
    }

    const where = includeInactive
      ? { tenantId }
      : { tenantId, status: db.command.neq('inactive') };

    const storesRes = await db.collection('stores')
      .where(where)
      .orderBy('storeName', 'asc')
      .limit(100)
      .get();

    const list = (storesRes.data || []).map(s => ({
      storeId: s._id,
      storeName: s.storeName || '未命名门店',
      status: s.status || 'active',
      // 🌟 门店宣传/招募海报（drawStoreInvitationPoster）需要展示地址，
      // createStore 云函数本就落库 address 字段，这里一并透出，不新增查询
      address: s.address || '',
      // 🌐 门店选择器：运营状态（与上面 status 是两个不同维度的字段——status 是
      // 超管的启用/停用软删除开关，operatingStatus 是"运营中/筹备中/暂停运营"的
      // 真实业务状态展示）+ 省市（供级联筛选）+ 经纬度（供"附近门店"距离排序，
      // 未设置坐标的门店这两项为 undefined，前端自行判断降级）
      operatingStatus: s.operatingStatus || 'operating',
      province: s.province || '',
      city: s.city || '',
      latitude: typeof s.latitude === 'number' ? s.latitude : undefined,
      longitude: typeof s.longitude === 'number' ? s.longitude : undefined
    }));

    return { success: true, list };
  } catch (err) {
    console.error('[getStoreList] 异常:', err);
    return { success: false, error: err.message || '门店列表查询失败', list: [] };
  }
};
