// 云函数：manageStoreProfile - 门店档案（人员画像 7 项人数指标 + 品牌档案信息 +
// 运营状态/省市/坐标）的读取与编辑
//
// 权限模型：
// - 读（get）：任意已绑定门店的角色（店长/财务/义工）只读本店画像；super_admin/
//   hq_finance/regional_finance 可传 storeId 或 storeName（统计大屏门店下拉框
//   目前只掌握 storeName，没有 storeId，见 statistics.ts 调用处）查看本机构内
//   任意门店，两者都未传时按各自 caller.storeId 兜底。
// - 写（update）：仅 store_manager（限本店，storeId 强制取自身份记录，不信任客户端
//   传入值）或 super_admin（限本机构内任意门店，校验目标门店 tenantId）。
//   与 manageDailyMenu/manageExpenseTemplate/manageNotice 同款权限校验模式。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 人员画像：7 项人数指标，走 clampCount（非负整数）
const PROFILE_FIELDS = [
  'partyMembers',
  'socialWorkers',
  'volunteersCount',
  'dineInSeniorsCount',
  'deliverySeniorsCount',
  'listeningSeniorsCount',
  'otherCount'
];

// 门店档案信息：文本/日期类字段，走 sanitizeText（裁剪长度），不走数字 clamp。
// address 此前只在 createStore 时写一次，这里补上编辑入口。contactPhone 是
// 申请高阶角色/新建门店前的档案补全校验（processRoleAudit）新增依赖的字段之一，
// 之前门店层级完全没有这个字段
const TEXT_PROFILE_FIELDS = ['address', 'contactPhone', 'openDate', 'registeredName', 'background', 'characteristics', 'province', 'city'];
const MAX_TEXT_FIELD_LENGTH = 500;
const MAX_STORE_PHOTOS = 9;
const VALID_OPERATING_STATUSES = ['operating', 'preparing', 'paused'];

// 🏪 店铺模板自定义（首页"店铺模板自定义"卡片）：致谢词/宣传标语/公众号名称，
// 与人员画像字段一样落在 stores 集合，各自长度上限对齐前端 wxml 的 maxlength，
// 防止超长文本破坏餐报文本/公示海报排版
const TEMPLATE_FIELD_LIMITS = {
  thankText: 150,
  slogan1: 60,
  slogan2: 60,
  mpAccount: 100
};
const TEMPLATE_FIELDS = Object.keys(TEMPLATE_FIELD_LIMITS);

// 🏪 门店资质与实景公示：门头照/民政备案复印件/食品安全承诺，与原有的 storePhotos
// （门店环境照）是四个各自独立的照片分类，同走 sanitizePhotos 校验，只是分类
// 存储、上限各自更小——这几类通常只需要 1-2 张证件/门头照，不需要 9 张这么多
const CATEGORY_PHOTOS_MAX = 6;
const PHOTO_FIELDS = ['storePhotos', 'storefrontPhotos', 'civilAffairsPhotos', 'foodSafetyPledgePhotos'];

function sanitizeText(v, maxLength) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, maxLength || MAX_TEXT_FIELD_LENGTH);
}

// storePhotos：门店照片，云存储 fileID 数组，参考 activity-log 九宫格惯例上限 9 张
function sanitizePhotos(v, max) {
  if (!Array.isArray(v)) return [];
  return v.filter((item) => typeof item === 'string' && item.trim()).slice(0, max || MAX_STORE_PHOTOS);
}

function sanitizeCoord(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : undefined;
}

// 🆕 轻量省市提取：门店档案编辑时若 province/city 仍留空，尝试从门店名称/地址
// 文本里猜一猜。不追求覆盖全国行政区划，只覆盖本项目门店实际集中分布的常见
// 地区；猜不出来就返回空字符串，不编造数据
const REGION_CITY_TO_PROVINCE = {
  '厦门': '福建省', '漳州': '福建省', '泉州': '福建省', '福州': '福建省', '莆田': '福建省',
  '三明': '福建省', '南平': '福建省', '龙岩': '福建省', '宁德': '福建省'
};
const REGION_DISTRICT_TO_CITY = {
  '海沧': '厦门', '思明': '厦门', '湖里': '厦门', '集美': '厦门', '同安': '厦门', '翔安': '厦门',
  '芗城': '漳州', '龙文': '漳州', '龙海': '漳州',
  '鲤城': '泉州', '丰泽': '泉州', '洛江': '泉州', '泉港': '泉州', '晋江': '泉州', '石狮': '泉州', '南安': '泉州'
};
function extractRegionFromText(text) {
  const str = String(text || '');
  if (!str) return { province: '', city: '' };
  for (const cityBase of Object.keys(REGION_CITY_TO_PROVINCE)) {
    if (str.includes(cityBase)) {
      return { province: REGION_CITY_TO_PROVINCE[cityBase], city: `${cityBase}市` };
    }
  }
  for (const districtBase of Object.keys(REGION_DISTRICT_TO_CITY)) {
    if (str.includes(districtBase)) {
      const cityBase = REGION_DISTRICT_TO_CITY[districtBase];
      return { province: REGION_CITY_TO_PROVINCE[cityBase] || '', city: `${cityBase}市` };
    }
  }
  return { province: '', city: '' };
}

// 允许跨店查看（不限于自己绑定门店）的角色：与 getStatisticsData/getNationalDashboard
// 里"总部级只读汇总"的角色口径一致，仅用于本函数的 get（只读），不影响 update 权限
const CROSS_STORE_VIEW_ROLES = ['super_admin', 'hq_finance', 'regional_finance'];

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 读权限：本店任意角色只读；总部级角色可传 storeId 或 storeName 查看机构内任意门店
async function resolveReadTarget(caller, requestedStoreId, requestedStoreName) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  if (CROSS_STORE_VIEW_ROLES.includes(caller.role) && (requestedStoreId || requestedStoreName)) {
    let store = null;
    if (requestedStoreId) {
      const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
      store = storeRes && storeRes.data;
    } else {
      const where = { storeName: requestedStoreName };
      if (caller.tenantId) where.tenantId = caller.tenantId;
      const listRes = await db.collection('stores').where(where).limit(1).get().catch(() => null);
      store = listRes && listRes.data && listRes.data[0];
    }
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: store._id };
  }

  if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店' };
  return { allowed: true, storeId: caller.storeId };
}

// 写权限：仅店长（限本店）或超管（限本机构内任意门店）
async function resolveWriteTarget(caller, requestedStoreId) {
  if (!caller) return { allowed: false, error: '无权限：未找到您的角色信息' };

  // 🏛️ 权限向下继承：大家长天然拥有店长的全套日常管理权限（自己发起的编辑直接生效，
  // 不会像普通店长那样被下面的家长风控锁挂起——见 update 分支里 caller.role ===
  // 'store_manager' 的判断，patriarch 自己编辑自己不需要"等自己确认"）
  if (caller.role === 'store_manager' || caller.role === 'store_patriarch') {
    if (!caller.storeId) return { allowed: false, error: '您尚未绑定门店，无法编辑门店画像' };
    return { allowed: true, storeId: caller.storeId };
  }

  if (caller.role === 'super_admin') {
    if (!requestedStoreId) return { allowed: false, error: '请指定目标门店' };
    const storeRes = await db.collection('stores').doc(requestedStoreId).get().catch(() => null);
    const store = storeRes && storeRes.data;
    if (!store) return { allowed: false, error: '目标门店不存在' };
    if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
      return { allowed: false, error: '无权限：目标门店不属于您所在的机构' };
    }
    return { allowed: true, storeId: requestedStoreId };
  }

  return { allowed: false, error: '无权限：仅店长或超级管理员可编辑门店人员与服务人群画像' };
}

function clampCount(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}

// 🏛️ 家长风控锁：门店是否绑定了家长/督导——绑定了才需要走"店长发起、家长/超管
// 确认"的挂起流程；未绑定家长的门店，行为与升级前完全一致（店长直接生效）
function hasBoundPatriarch(store) {
  return !!(store && store.patriarchOpenId);
}

exports.main = async (event, context) => {
  const { action, storeId, storeName } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    const caller = await resolveCaller(OPENID);

    if (action === 'get') {
      const target = await resolveReadTarget(caller, storeId, storeName);
      if (!target.allowed) return { success: false, error: target.error };

      const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (!store) return { success: false, error: '门店不存在' };

      const profile = {};
      PROFILE_FIELDS.forEach((f) => { profile[f] = store[f] || 0; });
      TEXT_PROFILE_FIELDS.forEach((f) => { profile[f] = store[f] || ''; });
      TEMPLATE_FIELDS.forEach((f) => { profile[f] = store[f] || ''; });
      PHOTO_FIELDS.forEach((f) => { profile[f] = Array.isArray(store[f]) ? store[f] : []; });

      return {
        success: true,
        data: {
          storeId: target.storeId,
          storeName: store.storeName || '',
          canEdit: caller && (caller.role === 'store_manager' || caller.role === 'store_patriarch' || caller.role === 'super_admin'),
          // 🏛️ 家长/店长姓名：海报落款、验真页、家长大盘展示姓名的唯一数据来源
          patriarch: store.patriarch || '',
          manager: store.manager || '',
          // 🌐 运营状态（与门店启用/停用的 status 是两个不同维度）+ 坐标
          // （未设置时为 undefined，前端据此判断是否参与"附近门店"距离计算）
          operatingStatus: store.operatingStatus || 'operating',
          latitude: typeof store.latitude === 'number' ? store.latitude : undefined,
          longitude: typeof store.longitude === 'number' ? store.longitude : undefined,
          // 待审批的画像变更（若有）：供 store-profile 页展示"有一份更新正在等待审批"提示
          pendingProfileUpdate: store.pendingProfileUpdate || null,
          ...profile
        }
      };
    }

    if (action === 'update') {
      const target = await resolveWriteTarget(caller, storeId);
      if (!target.allowed) return { success: false, error: target.error };

      const updateFields = {};
      // 🐛 只在调用方真的传了这个字段时才写入——此前这里无条件对全部 7 项数字
      // 字段调用 clampCount(event[f])，而 clampCount(undefined) 会返回 0，导致
      // 任何"只想单独更新其他字段"的局部提交（例如资质公示照片管理弹窗只提交
      // 3 个照片字段，压根不带这 7 项数字字段）都会把人员与服务人群画像的真实
      // 数字静默清零。与下面 TEXT_PROFILE_FIELDS/PHOTO_FIELDS 已有的"只在提供时
      // 才写入"逻辑对齐，明确传 0 仍然会写入（0 !== undefined），只有完全不传
      // 这个字段才跳过
      PROFILE_FIELDS.forEach((f) => { if (event[f] !== undefined) updateFields[f] = clampCount(event[f]); });
      // 文本档案字段（地址/开业日期等）可能只想单独改其中一项，若不管有没有传都
      // 无条件塞 sanitizeText(undefined) === ''，会把没在本次请求里出现的字段
      // 静默清空，等于每次局部更新都顺带抹掉其余档案信息
      TEXT_PROFILE_FIELDS.forEach((f) => { if (event[f] !== undefined) updateFields[f] = sanitizeText(event[f]); });
      // 🌟 店铺模板自定义字段：同样"只在调用方真的传了才写入"，只提交部分字段（如只改
      // 致谢词）时不会把没提交的宣传标语静默清空
      TEMPLATE_FIELDS.forEach((f) => { if (event[f] !== undefined) updateFields[f] = sanitizeText(event[f], TEMPLATE_FIELD_LIMITS[f]); });
      PHOTO_FIELDS.forEach((f) => {
        if (event[f] !== undefined) updateFields[f] = sanitizePhotos(event[f], f === 'storePhotos' ? MAX_STORE_PHOTOS : CATEGORY_PHOTOS_MAX);
      });
      if (VALID_OPERATING_STATUSES.includes(event.operatingStatus)) {
        updateFields.operatingStatus = event.operatingStatus;
      }
      const lat = sanitizeCoord(event.latitude);
      const lng = sanitizeCoord(event.longitude);
      if (lat !== undefined && lng !== undefined) {
        updateFields.latitude = lat;
        updateFields.longitude = lng;
      }

      // 🆕 保存时省市智能回填：调用方这次没有主动修改 province/city（未传这两个
      // 字段），且门店档案里目前这两项都还是空的，才尝试从门店名称/地址文本里
      // 轻量提取兜底——调用方明确改动这两个字段时（哪怕改成空值）不做任何猜测
      // 覆盖，只补"确实还没填过"的历史/新建门店
      if (updateFields.province === undefined && updateFields.city === undefined) {
        const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (store && !store.province && !store.city) {
          const addressForGuess = updateFields.address !== undefined ? updateFields.address : (store.address || '');
          const guessed = extractRegionFromText(`${store.storeName || ''} ${addressForGuess}`);
          if (guessed.province || guessed.city) {
            updateFields.province = guessed.province;
            updateFields.city = guessed.city;
          }
        }
      }

      // 🏛️ 家长风控锁：店长发起且本店已绑定家长/督导时，不直接生效，改为存入
      // pendingProfileUpdate 挂起对象等待确认；超管发起或门店未绑定家长时，
      // 行为与升级前完全一致（直接生效）
      if (caller.role === 'store_manager') {
        const storeRes = await db.collection('stores').doc(target.storeId).get().catch(() => null);
        const store = storeRes && storeRes.data;
        if (hasBoundPatriarch(store)) {
          if (store.pendingProfileUpdate) {
            return { success: false, error: '已有一份画像更新正在等待家长/超管审批，请勿重复提交' };
          }
          await db.collection('stores').doc(target.storeId).update({
            data: {
              pendingProfileUpdate: {
                ...updateFields,
                requestedBy: OPENID,
                requestedAt: db.serverDate()
              }
            }
          });
          return { success: true, pending: true, message: '已提交家长/超管审批，确认后生效' };
        }
      }

      const updateData = { ...updateFields };
      updateData.lastProfileUpdatedBy = OPENID;
      updateData.lastProfileUpdatedAt = db.serverDate();

      await db.collection('stores').doc(target.storeId).update({ data: updateData });

      return { success: true, message: '门店人员与服务人群画像已更新', data: updateData };
    }

    if (action === 'approveProfileUpdate' || action === 'rejectProfileUpdate') {
      if (!caller || (caller.role !== 'store_patriarch' && caller.role !== 'super_admin')) {
        return { success: false, error: '无权限：仅家长或超级管理员可确认画像变更申请' };
      }
      if (!storeId) return { success: false, error: '缺少 storeId 参数' };

      const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
      const store = storeRes && storeRes.data;
      if (!store) return { success: false, error: '门店不存在' };
      if (caller.tenantId && store.tenantId && caller.tenantId !== store.tenantId) {
        return { success: false, error: '无权限：不能审批其他机构的门店' };
      }
      if (caller.role === 'store_patriarch' && caller.storeId !== storeId) {
        return { success: false, error: '无权限：不能审批其他门店的画像变更申请' };
      }
      if (!store.pendingProfileUpdate) {
        return { success: false, error: '该门店当前没有待确认的画像变更申请' };
      }

      if (action === 'rejectProfileUpdate') {
        await db.collection('stores').doc(storeId).update({ data: { pendingProfileUpdate: null } });
        return { success: true, message: '已驳回画像变更申请，数据保持原状' };
      }

      const pending = store.pendingProfileUpdate;
      const updateData = {};
      // 🐛 与 update 分支同一处修复：只在这份挂起申请当初真的提交过这个字段时
      // 才写入，避免只提交了资质公示照片的挂起申请，审批通过后把人员画像数字清零
      PROFILE_FIELDS.forEach((f) => { if (pending[f] !== undefined) updateData[f] = clampCount(pending[f]); });
      TEXT_PROFILE_FIELDS.forEach((f) => { if (pending[f] !== undefined) updateData[f] = sanitizeText(pending[f]); });
      TEMPLATE_FIELDS.forEach((f) => { if (pending[f] !== undefined) updateData[f] = sanitizeText(pending[f], TEMPLATE_FIELD_LIMITS[f]); });
      PHOTO_FIELDS.forEach((f) => {
        if (pending[f] !== undefined) updateData[f] = sanitizePhotos(pending[f], f === 'storePhotos' ? MAX_STORE_PHOTOS : CATEGORY_PHOTOS_MAX);
      });
      if (VALID_OPERATING_STATUSES.includes(pending.operatingStatus)) {
        updateData.operatingStatus = pending.operatingStatus;
      }
      if (typeof pending.latitude === 'number' && typeof pending.longitude === 'number') {
        updateData.latitude = pending.latitude;
        updateData.longitude = pending.longitude;
      }
      updateData.lastProfileUpdatedBy = pending.requestedBy || '';
      updateData.lastProfileUpdatedAt = db.serverDate();
      updateData.pendingProfileUpdate = null;

      await db.collection('stores').doc(storeId).update({ data: updateData });

      return { success: true, message: '已确认画像变更', data: updateData };
    }

    return { success: false, error: '未知操作: ' + action };
  } catch (err) {
    console.error('[manageStoreProfile] 异常:', err);
    return { success: false, error: err.message || '服务异常' };
  }
};
