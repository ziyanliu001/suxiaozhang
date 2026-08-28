// 云函数：ledgerIngestionAdapter — 长辈代报餐/签到统一记账适配器
//
// 🛡️ 为什么不直接写 report_logs：report_logs 是门店每日资金台账，客户端
// utils/dataService.ts 的 DataService.saveReport() 每次保存都会把当前表单
// 内存态整份 update() 回库（formattedData 白名单里明确包含 dineInSeniors/
// deliverySeniors 等字段）。如果这里在后台异步给这两个字段做 db.command.inc()，
// 用户下一次正常保存（点【生成餐报文本】）会把这个后台增量原样覆盖冲掉——
// 这是这套架构已验证过的真实覆盖行为，不是猜测。所以长辈代报的溯源信息
// （operator_openid/target_elder_id/proxy_type/input_channel/raw_ai_payload/
// is_heartbeat_trigger）落在这张独立的 elder_checkin_logs 流水集合上，不进
// report_logs；真正让"代报人数"体现在今日餐报里，由前端在提交成功后把 +1
// 合并进当前表单内存态完成（与人工在表单里手动点一下等效），走的还是既有的
// recalcDiningStats() → saveReportAsync() 链路，本适配器全程不碰 report_logs。
// 与 manageVolunteerSubmission 用独立的 material_logs 承接物资消耗、不碰
// report_logs 财务字段是同一个安全边界原则。
//
// 与阶段二对接点：入参里的 input_channel/raw_ai_payload 原样透传落库；
// 阶段二的语音/OCR 解析云函数只需要把识别结果拼成同样形状的 JSON 调用本函数
// 同一个 action:'checkin'，不需要另开一条写入路径。
//
// action：
// - searchElder：按门店 + 手机号后4位模糊匹配候选长辈列表，供前端二次确认
//   勾选（服务端不做唯一性猜测，命中多个候选原样返回，由人工选择）。
// - checkin：登记一次长辈代报餐/签到。写入 elder_checkin_logs 一条流水；
//   若 serviceType 指示"关爱陪伴/送餐到家"等义工服务项，顺带写一条
//   volunteer_timebank_logs 工时积分记录（AUTO_APPROVE_ROLES 免二次审核，
//   判定逻辑与 manageVolunteerSubmission.handleSubmit 一致：只信服务端查出的
//   调用者真实角色，不信 event 里任何客户端标记）；异步（吞掉失败，
//   console.warn 不重新抛出）把命中的 elder_guardian_bindings.last_active_time
//   续期，供 cronHeartbeatWatcher 心跳判定使用。

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const GUARDIAN_COLLECTION = 'elder_guardian_bindings';
const CHECKIN_COLLECTION = 'elder_checkin_logs';
const TIMEBANK_COLLECTION = 'volunteer_timebank_logs';

// 与 manageVolunteerSubmission 同一份角色边界：任一合法门店角色均可提交，
// 不放行家人/其他未识别角色；管理者角色本人提交免二次审核
const ALLOWED_SUBMIT_ROLES = ['volunteer', 'store_manager', 'store_patriarch', 'super_admin'];
const AUTO_APPROVE_ROLES = ['store_manager', 'store_patriarch', 'super_admin'];
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'];
const PROXY_TYPES = ['SELF', 'VOLUNTEER_PROXY', 'FAMILY_PROXY'];
const INPUT_CHANNELS = ['MANUAL_PASTE', 'VOICE_LLM', 'OCR_SCAN'];
// 服务类型 → 每小时积分换算，阶段一先按 1:1，后续如需差异化换算表由运营侧调整
const SERVICE_TYPE_POINTS_PER_HOUR = {
  '关爱陪伴': 1,
  '送餐到家': 1,
  '堂食服务': 1,
  '洗切打饭': 1
};

function isCollectionNotExistError(err) {
  return !!err && (err.errCode === -502005 || /database collection not exists/i.test(String(err.errMsg || err.message || '')));
}

async function resolveCaller(OPENID) {
  if (!OPENID) return null;
  const roleRes = await db.collection('user_roles').where({ _openid: OPENID }).limit(1).get();
  return (roleRes.data && roleRes.data[0]) || null;
}

// 🐛 云函数容器时区固定为 UTC，与 manageVolunteerSubmission 同一套 +8 小时
// 偏移换算，取北京时间的 dateString
function todayStr() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

async function handleSearchElder(event, OPENID) {
  const caller = await resolveCaller(OPENID);
  if (!caller || !ALLOWED_SUBMIT_ROLES.includes(caller.role)) {
    return { success: false, error: '无权限查询' };
  }

  const storeId = event.storeId || caller.storeId || '';
  const phoneLast4 = String(event.phoneLast4 || '').trim();
  if (!storeId) return { success: false, error: '未识别到您所在的门店，请先在首页选择门店' };
  if (!/^\d{4}$/.test(phoneLast4)) return { success: false, error: '请输入长辈手机号后4位（4位数字）' };

  let rows;
  try {
    const res = await db.collection(GUARDIAN_COLLECTION)
      .where({ canteen_store_id: storeId })
      .get();
    rows = (res.data || []).filter((item) => String(item.elder_phone || '').slice(-4) === phoneLast4);
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    rows = [];
  }

  return {
    success: true,
    data: {
      candidates: rows.map((item) => ({
        elder_id: item._id,
        elder_name: item.elder_name || '',
        elder_phone_masked: item.elder_phone ? `****${String(item.elder_phone).slice(-4)}` : '',
        relationship: item.relationship || ''
      }))
    }
  };
}

// 命中长辈后异步续期心跳，失败只 console.warn，绝不影响签到主流程的成功返回
async function renewHeartbeat(elderId) {
  if (!elderId) return;
  try {
    await db.collection(GUARDIAN_COLLECTION).doc(elderId).update({
      data: {
        last_active_time: db.serverDate(),
        notify_status: 'normal'
      }
    });
  } catch (err) {
    console.warn('[ledgerIngestionAdapter] 长辈心跳续期失败（不阻断签到主流程）:', err);
  }
}

async function writeTimebankLog({ OPENID, callerRole, storeId, storeName, tenantId, serviceType, hours, sourceId }) {
  const parsedHours = Math.max(0, parseFloat(hours) || 0);
  if (parsedHours <= 0) return null;

  const pointsPerHour = SERVICE_TYPE_POINTS_PER_HOUR[serviceType] || 1;
  const autoApprove = AUTO_APPROVE_ROLES.includes(callerRole);
  const doc = {
    volunteer_openid: OPENID,
    storeId,
    storeName,
    tenantId,
    dateString: todayStr(),
    service_type: serviceType,
    hours: parsedHours,
    points: parseFloat((parsedHours * pointsPerHour).toFixed(2)),
    audit_status: autoApprove ? 'AUTO_APPROVED' : 'MANAGER_CONFIRMED',
    source_collection: CHECKIN_COLLECTION,
    source_id: sourceId,
    createTime: db.serverDate()
  };

  try {
    await db.collection(TIMEBANK_COLLECTION).add({ data: doc });
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(TIMEBANK_COLLECTION).catch(() => {});
    await db.collection(TIMEBANK_COLLECTION).add({ data: doc });
  }
  return doc;
}

async function handleCheckin(event, OPENID) {
  if (!OPENID) return { success: false, error: '未登录，无法提交' };

  const caller = await resolveCaller(OPENID);
  if (!caller || !ALLOWED_SUBMIT_ROLES.includes(caller.role)) {
    return { success: false, error: '无权限提交' };
  }

  const storeId = event.storeId || caller.storeId || '';
  if (!storeId) return { success: false, error: '未识别到您所在的门店，请先在首页选择门店' };

  const mealType = MEAL_TYPES.includes(event.mealType) ? event.mealType : '';
  if (!mealType) return { success: false, error: '请选择餐次' };

  const proxyType = PROXY_TYPES.includes(event.proxy_type) ? event.proxy_type : 'VOLUNTEER_PROXY';
  const inputChannel = INPUT_CHANNELS.includes(event.input_channel) ? event.input_channel : 'MANUAL_PASTE';

  const elderId = event.target_elder_id || '';
  if (!elderId) return { success: false, error: '请先勾选要代报的长辈' };

  const elderRes = await db.collection(GUARDIAN_COLLECTION).doc(elderId).get().catch(() => null);
  const elderDoc = elderRes && elderRes.data;
  if (!elderDoc || elderDoc.canteen_store_id !== storeId) {
    return { success: false, error: '未找到该长辈的绑定记录，请重新搜索' };
  }

  let tenantId = caller.tenantId || '';
  if (!tenantId && storeId) {
    const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
    tenantId = (storeRes && storeRes.data && storeRes.data.tenantId) || '';
  }

  const checkinDoc = {
    storeId,
    storeName: caller.storeName || '',
    tenantId,
    dateString: todayStr(),
    mealType,
    target_elder_id: elderId,
    target_elder_name: elderDoc.elder_name || '',
    operator_openid: OPENID,
    operator_name: caller.nickName || '',
    proxy_type: proxyType,
    input_channel: inputChannel,
    raw_ai_payload: event.raw_ai_payload || null,
    is_heartbeat_trigger: true,
    createTime: db.serverDate()
  };

  let addRes;
  try {
    addRes = await db.collection(CHECKIN_COLLECTION).add({ data: checkinDoc });
  } catch (err) {
    if (!isCollectionNotExistError(err)) throw err;
    await db.createCollection(CHECKIN_COLLECTION).catch(() => {});
    addRes = await db.collection(CHECKIN_COLLECTION).add({ data: checkinDoc });
  }

  let timebankCredited = null;
  const serviceType = String(event.serviceType || '').trim();
  if (serviceType) {
    timebankCredited = await writeTimebankLog({
      OPENID,
      callerRole: caller.role,
      storeId,
      storeName: caller.storeName || '',
      tenantId,
      serviceType,
      hours: event.hours,
      sourceId: addRes._id
    });
  }

  // 心跳续期与主流程解耦，不阻塞签到返回
  renewHeartbeat(elderId).catch(() => {});

  return {
    success: true,
    data: {
      checkinId: addRes._id,
      mealType,
      proxyType,
      matchedElder: { elder_id: elderId, elder_name: elderDoc.elder_name || '' },
      timebankCredited: timebankCredited ? { hours: timebankCredited.hours, points: timebankCredited.points } : null
    }
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  switch (action) {
    case 'searchElder':
      return handleSearchElder(event, OPENID);
    case 'checkin':
      return handleCheckin(event, OPENID);
    default:
      return { success: false, error: '未知操作' };
  }
};
