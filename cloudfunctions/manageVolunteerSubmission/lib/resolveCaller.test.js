'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEffectiveCaller, isGrantStillValid } = require('./resolveCaller');

// 🛡️（2026-09-10）多租户巡检与权限隔离回归矩阵——这份测试是照着当天连续
// 三轮真实故障排查写的，每条用例都能对应到一次实际复现过的 bug 或一次刻意
// 验证过的安全边界，不是泛泛而写的示例断言。往后任何改动 resolveEffectiveCaller
// 都必须先跑通这份测试。
//
// ⚠️ 范围说明：这里只测 resolveEffectiveCaller 这一个纯函数——它只负责"给定
// own 文档和 targetStoreId，算出应该以哪个身份继续往下走"，不覆盖
// resolveReadTarget/resolveWriteTarget 的角色白名单判断（那两个函数目前
// 内部会发起数据库查询，还没有拆成同款纯函数，见文件末尾说明）。

test('(a) 未登录/找不到 user_roles 记录：own 为 null 时返回 null（上游据此判定无权限）', () => {
  assert.equal(resolveEffectiveCaller(null, 'store_A'), null);
  assert.equal(resolveEffectiveCaller(undefined, 'store_A'), null);
});

test('(b) 正常单店角色访问自己绑定的门店：未传 targetStoreId 时原样返回 own（本店视角，不涉及漫游）', () => {
  const own = { role: 'store_patriarch', tenantId: 'tenant_A', storeId: 'store_A' };
  assert.deepEqual(resolveEffectiveCaller(own, undefined), own);
  assert.deepEqual(resolveEffectiveCaller(own, ''), own);
});

test('(c) 单店角色水平越权访问未绑定的其他门店：没有 authorizedTenants，原样返回 own（storeId 仍是自己的店，下游按"目标门店不属于自己"拒绝）', () => {
  const own = { role: 'store_manager', tenantId: 'tenant_A', storeId: 'store_A' };
  const result = resolveEffectiveCaller(own, 'store_B_from_another_tenant');
  assert.deepEqual(result, own);
  assert.notEqual(result.storeId, 'store_B_from_another_tenant');
});

test('(d) platform_admin 没有任何巡检凭据直接访问门店：authorizedTenants 为空，原样返回 own（storeId 仍为空，下游按"您尚未绑定门店"拒绝，不会漫游写入）', () => {
  const own = { role: 'platform_admin', tenantId: '', storeId: '', authorizedTenants: [] };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.deepEqual(result, own);
  assert.equal(result.storeId, '');
  assert.equal(result.role, 'platform_admin');
});

test('(d.1) authorizedTenants 字段缺失（历史数据没有这个字段）时按空数组处理，不抛异常', () => {
  const own = { role: 'platform_admin', tenantId: '', storeId: '' };
  assert.deepEqual(resolveEffectiveCaller(own, 'store_X'), own);
});

test('(d.2) authorizedTenants 里有其他门店的授权，但不包含本次目标门店：原样返回 own，不会跨店泄漏', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [{ tenantId: 'tenant_Y', role: 'store_manager', stores: ['store_Y'] }]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.deepEqual(result, own);
});

test('(e) platform_admin 持有覆盖目标门店的有效巡检授权：resolveCaller 提取出漫游身份（role/tenantId/storeId 替换成授权记录里的值）', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [{ tenantId: 'tenant_X', role: 'store_patriarch', stores: ['store_X'] }]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.equal(result.role, 'store_patriarch');
  assert.equal(result.tenantId, 'tenant_X');
  assert.equal(result.storeId, 'store_X');
});

test('(e.1) authorizedTenants 里有多条记录，按 stores 命中正确的那一条，不会被排在前面的不相关记录干扰', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [
      { tenantId: 'tenant_Y', role: 'finance', stores: ['store_Y'] },
      { tenantId: 'tenant_X', role: 'store_manager', stores: ['store_X', 'store_X2'] }
    ]
  };
  const result = resolveEffectiveCaller(own, 'store_X2');
  assert.equal(result.tenantId, 'tenant_X');
  assert.equal(result.role, 'store_manager');
  assert.equal(result.storeId, 'store_X2');
});

test('(f) 回归用例——grant.tenantId 恰好等于 own.tenantId（历史遗留残留数据）时，身份依旧正确漫游，不会被打回原样', () => {
  // 对应 2026-09-10 真实复现的 bug：platform_admin 账号历史上是从某机构的
  // super_admin 提权而来，own.tenantId 残留着提权前所属的机构 ID；这次巡检
  // 的目标门店恰好就属于那同一个机构，grant.tenantId 与残留的 own.tenantId
  // 因此"巧合相等"。此前的实现在这种情况下会错误地放弃漫游、原样返回 own
  // （storeId 仍为空），导致 store-profile.ts 报"您尚未绑定门店"——即便
  // grantTenantAuthorization 那次调用已经成功写入了这条临时授权。
  const staleTenantId = 'tenant_legacy_residual';
  const own = {
    role: 'platform_admin',
    tenantId: staleTenantId, // 历史残留，不该是这个值，但现实中确实存在
    storeId: '',
    authorizedTenants: [{ tenantId: staleTenantId, role: 'store_patriarch', stores: ['store_X'] }]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  // 关键断言：身份必须被替换成漫游身份，不能因为 tenantId 巧合相同就原样返回 own
  assert.notEqual(result, own);
  assert.equal(result.storeId, 'store_X');
  assert.equal(result.role, 'store_patriarch');
  assert.equal(result.tenantId, staleTenantId);
});

test('(g) 巡检凭据已被撤销：authorizedTenants 数组里已经没有这条记录（撤销后的状态），原样返回 own，等同于从未授权过', () => {
  // "撤销"在数据层面就是"这条记录已经从数组里被移除"，与场景 (d) 是完全
  // 相同的决策路径——这里单独列一条用例只是为了显式覆盖"曾经有过、后来被
  // 撤销"这个语义。2026-09-10 之后新增了基于时间的 expiresAt 过期机制
  // （见下方 (g.1)~(g.4)），"撤销"与"过期"是两条独立的失效路径，不要混淆
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    // 撤销后 grantTenantAuthorization 的 revoke action 会把这条记录从数组里
    // filter 掉，撤销后的状态就是这个数组里已经没有 store_X 了
    authorizedTenants: [{ tenantId: 'tenant_other', role: 'volunteer', stores: ['store_other'] }]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.deepEqual(result, own);
  assert.equal(result.storeId, '');
});

test('(g.1) ⏱️ 授权已过期：expiresAt 早于 now，即便 storeId 命中也按未命中处理，原样返回 own', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [{
      tenantId: 'tenant_X',
      role: 'store_patriarch',
      stores: ['store_X'],
      expiresAt: '2026-09-10T11:59:59Z' // 早于 now 1 秒——刚好过期
    }]
  };
  const result = resolveEffectiveCaller(own, 'store_X', now);
  assert.deepEqual(result, own);
  assert.equal(result.storeId, '');
});

test('(g.2) ⏱️ 授权仍在有效期内：expiresAt 晚于 now，正常漫游生效', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [{
      tenantId: 'tenant_X',
      role: 'store_patriarch',
      stores: ['store_X'],
      expiresAt: '2026-09-10T13:59:59Z' // 还剩近 2 小时
    }]
  };
  const result = resolveEffectiveCaller(own, 'store_X', now);
  assert.equal(result.storeId, 'store_X');
  assert.equal(result.role, 'store_patriarch');
});

test('(g.3) ⏱️ 向后兼容：历史授权记录没有 expiresAt 字段，按不过期处理', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [{ tenantId: 'tenant_X', role: 'store_manager', stores: ['store_X'] }]
  };
  const result = resolveEffectiveCaller(own, 'store_X', Date.now());
  assert.equal(result.storeId, 'store_X');
});

test('(g.4) ⏱️ 有两条授权覆盖同一 storeId（正常不会发生，mergeGrant 按 tenantId 去重），其中一条已过期、另一条未过期时，仍能命中未过期的那一条', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [
      { tenantId: 'tenant_old', role: 'volunteer', stores: ['store_X'], expiresAt: '2026-09-10T11:00:00Z' },
      { tenantId: 'tenant_new', role: 'store_patriarch', stores: ['store_X'], expiresAt: '2026-09-10T14:00:00Z' }
    ]
  };
  const result = resolveEffectiveCaller(own, 'store_X', now);
  assert.equal(result.tenantId, 'tenant_new');
  assert.equal(result.role, 'store_patriarch');
});

test('(h) ⚠️ 根因回归——"选大家长却拿到义工权限"：同一 storeId 在数组里有两条都仍然有效的授权（历史脏数据，正常情况下 mergeGrant 已从签发端根治，这里覆盖"数据库里已经存在脏数据"这一残留场景），取 grantedAt 更新的那一条，不是数组里排在前面的那一条', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [
      { tenantId: 'tenant_stale', role: 'volunteer', stores: ['store_X'], grantedAt: '2026-09-10T10:00:00Z' },
      { tenantId: 'tenant_fresh', role: 'store_patriarch', stores: ['store_X'], grantedAt: '2026-09-10T11:00:00Z' }
    ]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.equal(result.role, 'store_patriarch');
  assert.equal(result.tenantId, 'tenant_fresh');
});

test('(h.1) 同上，但两条记录在数组里的先后顺序反过来（新的排前面）——结果不应受数组顺序影响，只认 grantedAt', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [
      { tenantId: 'tenant_fresh', role: 'store_patriarch', stores: ['store_X'], grantedAt: '2026-09-10T11:00:00Z' },
      { tenantId: 'tenant_stale', role: 'volunteer', stores: ['store_X'], grantedAt: '2026-09-10T10:00:00Z' }
    ]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.equal(result.role, 'store_patriarch');
});

test('(h.2) 两条记录都缺 grantedAt 字段（更早期的历史数据，比 grantedAt 字段本身还老）时不抛异常，按数组里最后一条兜底，不影响可用性', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [
      { tenantId: 'tenant_a', role: 'volunteer', stores: ['store_X'] },
      { tenantId: 'tenant_b', role: 'finance', stores: ['store_X'] }
    ]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.ok(result.role === 'volunteer' || result.role === 'finance');
});

test('isGrantStillValid：expiresAt 是非法日期字符串时兜底按不过期处理（写入侧异常不应该让读取侧连带炸掉）', () => {
  assert.equal(isGrantStillValid({ expiresAt: 'not-a-date' }, Date.now()), true);
});

test('isGrantStillValid：expiresAt 恰好等于 now 时判定为已过期（边界值，> 而不是 >=）', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  assert.equal(isGrantStillValid({ expiresAt: '2026-09-10T12:00:00Z' }, now), false);
});

test('容错：authorizedTenants 数组里混入 null/畸形条目（缺 stores 字段）不抛异常，正常跳过', () => {
  const own = {
    role: 'platform_admin',
    tenantId: '',
    storeId: '',
    authorizedTenants: [null, { tenantId: 'tenant_bad' }, { tenantId: 'tenant_X', role: 'store_manager', stores: ['store_X'] }]
  };
  const result = resolveEffectiveCaller(own, 'store_X');
  assert.equal(result.role, 'store_manager');
  assert.equal(result.tenantId, 'tenant_X');
});

// ⚠️ 未覆盖范围（如实标注，避免后来者误以为这份文件已经测了全部鉴权链路）：
// - resolveReadTarget/resolveWriteTarget 的角色白名单判断（CROSS_STORE_VIEW_ROLES/
//   store_manager/store_patriarch/super_admin 分支）目前仍直接内联在 index.js
//   里、内部会发起 db.collection('stores') 查询，还没有拆成不依赖 db 的纯函数，
//   本文件不覆盖。如果后续要补这部分的单测，需要先把这两个函数改造成"接受
//   预先查好的 store 文档作为参数"的纯函数（参考本文件 resolveCaller 的拆分
//   方式），而不是在测试里 mock 整个 wx-server-sdk。
// - grantTenantAuthorization 的授权签发/撤销规则（含"目标账号本来就归属这个
//   租户"的拦截豁免）见同仓库 cloudfunctions/grantTenantAuthorization/lib/
//   grantAuthorizationRules.test.js，两份测试合起来才是完整的"签发 + 消费"
//   闭环回归覆盖。
