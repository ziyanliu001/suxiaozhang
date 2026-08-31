#!/usr/bin/env node
'use strict';

// 🏛️ Open-Core 架构拆分 · 第三阶段：物理构建与打包脚本
//
// 用途：从当前单体仓库自动提取、过滤出一份纯净的 suxiaozhang-core 开源
// 发布包（写到 dist/suxiaozhang-core/），不改动、不污染当前工作目录。
//
// 设计取舍（务必先读 docs/OPEN_CORE_ARCHITECTURE.md 再改这个文件）：
//
// 1. 源文件枚举用 `git ls-files --cached --others --exclude-standard`，
//    不是裸的 `fs.cpSync(ROOT, DIST)`——这一步天然复用仓库已有的 .gitignore
//    规则，本地开发机才有的 `private.wx*.key`（小程序代码上传私钥）、
//    `project.private.config.json`（开发者工具本地私有配置）等文件本来就
//    不会进入这份文件清单，不需要在本脚本里重新维护一份"哪些本地文件不能
//    打包"的排除名单，从根源上避免打包脚本本身沦为新的泄露点。同时又能
//    包含尚未 `git commit` 但已经 `git add`/新建在工作区的改动（不要求
//    "构建前必须先 commit"），方便边开发边试跑本脚本。
// 2. 云函数的 Enterprise 排除名单，以及 exportAccountExcel/pages/profile
//    的处理方式，均直接对应 docs/OPEN_CORE_ARCHITECTURE.md 已经写清楚的
//    判断——本脚本不是这份判断的来源，只是把已经写在文档里的结论落成
//    可执行代码。新增/调整 Enterprise 边界时，先改文档、再改这里两处
//    保持同步，不要只改一处。
// 3. 本脚本【没有】对仓库全部 70+ 个云函数逐一做过 Core/Enterprise 审计——
//    只排除了 docs/OPEN_CORE_ARCHITECTURE.md 第 3 节已经明确列出的几个
//    （getNationalDashboard/checkTenantPermission/activateTenantSubscription/
//    manageTenantSubscription/createSubscriptionOrder），外加本次新核实
//    确认的 getPlatformOverview（SaaS 平台运维方专用大盘，纯粹的多租户
//    宿主运营概念，自托管单机构部署用不上，也不应该让自托管方看到别的
//    机构的运维统计）。未列入排除名单的云函数默认保留在 Core 包内——
//    宁可多带一些用不上的机构内部治理工具函数，也不要因为一次不完整的
//    人工审计而漏删/错删，破坏本该保留的多店治理能力。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(ROOT, 'dist');
const DIST_DIR = path.join(DIST_ROOT, 'suxiaozhang-core');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function log(msg) { console.log(msg); }
function warn(msg) { console.log(`${YELLOW}⚠️  ${msg}${RESET}`); }
function ok(msg) { console.log(`${GREEN}✅ ${msg}${RESET}`); }
function fail(msg) { console.log(`${RED}❌ ${msg}${RESET}`); }

// ── 1. 顶层目录/文件：整体不进入开源包 ───────────────────────────────
// docs/：内部商业化战略与 Open-Core 拆分判断依据本身（写清楚了"哪些代码
// 故意不开源"，公开仓库反而不该收录这份"泄密地图"）；scripts/：本套构建/
// 审计工具服务于闭源主仓库维护者自己，不是开源使用者需要的产物。
const TOP_LEVEL_EXCLUDES = new Set(['docs', 'scripts']);

// ── 2. Enterprise 专有云函数：整目录排除 ─────────────────────────────
// 见文件头注释——直接对应 docs/OPEN_CORE_ARCHITECTURE.md 第 3 节表格。
const ENTERPRISE_CLOUDFUNCTIONS = [
  'getNationalDashboard',
  'checkTenantPermission',
  'activateTenantSubscription',
  'manageTenantSubscription',
  'createSubscriptionOrder',
  // 🆕 本次新核实：SaaS 平台运维方专用大盘，纯 count() 聚合查看全平台机构/
  // 门店/云资源消耗概览，自托管单机构部署天然没有"平台"这个上级概念，
  // 也不该让自托管方看到（假设的）其它机构统计——文档尚未收录，随本次
  // 一并记录进 OPEN_CORE_ARCHITECTURE.md
  'getPlatformOverview'
].map((name) => `cloudfunctions/${name}`);

// ── 3. Enterprise 专有前端页面/路由：整目录排除 ──────────────────────
// subpackages/admin/pages/platform-admin：SaaS 平台管理员专属页面
// （仅 platform_admin 角色可进入，服务端 requirePlatformAdmin 硬校验），
// 是本仓库里少有的"物理上已经是独立页面目录、天然干净可拆"的 Enterprise
// 路由，因此可以像云函数一样整目录排除，不像 pages/profile 那样需要
// 运行时旗标兜底。
const ENTERPRISE_FRONTEND_DIRS = ['miniprogram/subpackages/admin/pages/platform-admin'];

// ── 4. 文件级覆盖：整份替换成 Core-only 版本 ─────────────────────────
// 左边是仓库原路径，右边是本仓库内维护的"Core 替身"源文件。
const FILE_OVERRIDES = [
  {
    target: 'cloudfunctions/exportAccountExcel/index.js',
    source: 'scripts/core-overrides/exportAccountExcel.index.js'
  },
  {
    target: 'miniprogram/utils/buildFlags.ts',
    source: 'scripts/core-overrides/buildFlags.core.ts'
  },
  // 🆕（终局阶段）pages/statistics 与 pages/profile 的 Enterprise 扩展包
  // 汇合点——真实实现文件（见下面 SINGLE_FILE_EXCLUDES）整份排除，这两个
  // index.ts 换成导出结构相同、方法体全部安全空操作的 stub，statistics.ts/
  // profile.ts 里 `import {...} from './enterprise'` 这行代码本身不需要
  // 跟着改
  {
    target: 'miniprogram/pages/statistics/enterprise/index.ts',
    source: 'scripts/core-overrides/statistics.enterprise.index.ts'
  },
  {
    target: 'miniprogram/pages/profile/enterprise/index.ts',
    source: 'scripts/core-overrides/profile.enterprise.index.ts'
  },
  // 🆕（视图层精简）statistics.wxml/profile.wxml 用 <include> 引用这几个
  // WXML 文件——与 .ts 的 import 不同，<include> 引用的文件在编译期必须真实
  // 存在，物理删除会导致小程序编译直接报错，不是"优雅降级"。所以这里跟
  // index.ts 一样走整份覆盖（置空），而不是像同目录下只被它们内部引用的
  // 子文件那样直接删除（见下面 SINGLE_FILE_EXCLUDES）
  {
    target: 'miniprogram/pages/statistics/enterprise/nationalDashboardView.wxml',
    source: 'scripts/core-overrides/statistics.nationalDashboardView.wxml'
  },
  {
    target: 'miniprogram/pages/statistics/enterprise/procurementModal.wxml',
    source: 'scripts/core-overrides/statistics.procurementModal.wxml'
  },
  {
    target: 'miniprogram/pages/profile/enterprise/saasSubscriptionModal.wxml',
    source: 'scripts/core-overrides/profile.saasSubscriptionModal.wxml'
  }
];

// ── 5. 单文件级排除（目录保留，只删其中的 Enterprise 文件） ──────────
const SINGLE_FILE_EXCLUDES = [
  // Enterprise 专有的多店合并导出实现——见上面 FILE_OVERRIDES 里
  // index.js 已经换成不 require 它的 Core-only 版本，这里再显式排除
  // 物理文件本身，双重保险，避免 require 图以外还残留这份源码
  'cloudfunctions/exportAccountExcel/lib/exportNationalExcel.js',
  // 🆕（终局阶段）pages/statistics/enterprise 的三个真实实现文件——
  // index.ts 已被上面 FILE_OVERRIDES 换成 stub，不再 import 这三个文件，
  // 这里显式删除物理文件本身
  'miniprogram/pages/statistics/enterprise/nationalDashboardService.ts',
  'miniprogram/pages/statistics/enterprise/drillDownHandler.ts',
  'miniprogram/pages/statistics/enterprise/procurementHandler.ts',
  // 🆕（终局阶段）pages/profile/enterprise 的真实实现文件，同上
  'miniprogram/pages/profile/enterprise/saasSubscriptionHandler.ts',
  // 🆕（视图层精简）只被 nationalDashboardView.wxml 内部 <include> 引用的两个
  // 卡片片段——该文件已被上面 FILE_OVERRIDES 换成空 stub，不再引用它们，
  // 删除物理文件不会留下悬空的 <include>
  'miniprogram/pages/statistics/enterprise/rebalanceSuggestionCard.wxml',
  'miniprogram/pages/statistics/enterprise/procurementCard.wxml'
];

// ── 已知遗留耦合（本阶段不处理，如实记录，不假装已完成物理拆分） ──────
const KNOWN_MIXED_FILES = [
  // 🆕（视图层精简，2026-08-31）statistics.wxml/profile.wxml 里体量最大的
  // Enterprise 标记块（全国大屏大盘+四个弹窗、SaaS 订阅+支付兜底弹窗）已经
  // 用 <include> 物理搬出主文件，Core 构建下对应 <include> 目标文件被整份
  // 置空（见 FILE_OVERRIDES），不再随 Core 包带着这些区块的完整 UI 结构与
  // 文案。下面两项是本轮排查后仍然刻意不动的更小的残留：
  'pages/profile/profile.wxml（三处更小的 SaaS 入口——pro-service-card 卡片、' +
    'top-advanced-secondary 徽标、sa-dev-tool-row 调试入口——本身已各自叠加' +
    'enterpriseBuildEnabled && 前置条件，Core 构建下运行时不渲染；因为每处' +
    '都只有几行、且已经运行时不可达，没有进一步拆成独立 <include> 文件，' +
    '与三个大弹窗块相比性价比不高，本阶段维持现状）',
  'pages/statistics/statistics.wxss / pages/profile/profile.wxss（本轮只拆分' +
    'WXML 结构，未同步做 WXSS 按需过滤——.national-dashboard-container/' +
    '.procurement-card/.subscription-modal-mask 等 Enterprise 专属的样式' +
    '规则仍留在两份主 WXSS 里，Core 包会带着这些用不到的 CSS 类定义，纯粹' +
    '是产物体积上的冗余，不涉及信息泄露或功能问题，如实记录不假装已处理）'
];

function readTrackedAndUntrackedFiles() {
  // --cached：已提交/已 git add 的文件；--others --exclude-standard：
  // 工作区里新增但尚未提交、且没有被 .gitignore 排除的文件。两者合并
  // 起来才是"当前打开这个仓库能看到的、且不违反 .gitignore 的完整源码
  // 视图"，见文件头注释第 1 点。
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, maxBuffer: 1024 * 1024 * 64 }
  ).toString('utf8');
  return out.split('\0').filter(Boolean);
}

function isExcluded(relPath) {
  const topLevel = relPath.split('/')[0];
  if (TOP_LEVEL_EXCLUDES.has(topLevel)) return true;
  if (ENTERPRISE_CLOUDFUNCTIONS.some((dir) => relPath === dir || relPath.startsWith(dir + '/'))) return true;
  if (ENTERPRISE_FRONTEND_DIRS.some((dir) => relPath === dir || relPath.startsWith(dir + '/'))) return true;
  if (SINGLE_FILE_EXCLUDES.includes(relPath)) return true;
  return false;
}

function copyFile(relPath) {
  const src = path.join(ROOT, relPath);
  const dest = path.join(DIST_DIR, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function applyOverrides() {
  for (const { target, source } of FILE_OVERRIDES) {
    const destPath = path.join(DIST_DIR, target);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(ROOT, source), destPath);
  }
}

// app.json 的 admin 分包 pages 数组里，platform-admin 这一条路由记录也要
// 跟着 ENTERPRISE_FRONTEND_DIRS 的目录一起摘掉，否则小程序基础库加载
// app.json 时会因为声明的页面路径在磁盘上找不到对应文件而直接报错，
// 而不是"优雅降级"——这是唯一一处需要真正解析/改写 JSON 内容的地方，
// 而不是单纯拷贝或整份替换文件
function stripPlatformAdminRoute() {
  const appJsonPath = path.join(DIST_DIR, 'miniprogram/app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const subpackagesKey = appJson.subpackages ? 'subpackages' : 'subPackages';
  const list = appJson[subpackagesKey] || [];
  const adminPkg = list.find((p) => p.root === 'subpackages/admin');
  if (adminPkg && Array.isArray(adminPkg.pages)) {
    const before = adminPkg.pages.length;
    adminPkg.pages = adminPkg.pages.filter((p) => !p.includes('platform-admin'));
    if (adminPkg.pages.length !== before) {
      fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + '\n');
      ok(`app.json 已移除 platform-admin 路由声明（admin 分包 pages: ${before} → ${adminPkg.pages.length}）`);
    }
  }
}

// project.config.json 的 appid 是当前生产小程序的真实账号标识——虽然不是
// 密钥（任何人打开这个小程序、抓包都能看到），但开源模板不应该带着别人的
// 真实账号跑，替换成微信开发者工具官方承认的"无账号预览"占位值，下载源码
// 的人换成自己的 appid 即可直接在开发者工具里打开
function anonymizeProjectConfig() {
  const configPath = path.join(DIST_DIR, 'project.config.json');
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.appid) {
    config.appid = 'touristappid';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    ok('project.config.json 的 appid 已替换为 touristappid（微信开发者工具官方无账号预览占位值）');
  }
}

function generateReadmeAndEnvTemplate() {
  const readmeSrc = path.join(ROOT, 'scripts/templates/core-readme.md');
  const envSrc = path.join(ROOT, 'scripts/templates/env.example.json');
  fs.copyFileSync(readmeSrc, path.join(DIST_DIR, 'README.md'));
  fs.copyFileSync(envSrc, path.join(DIST_DIR, 'env.example.json'));
  ok('已生成 README.md 与 env.example.json');
}

function runSecurityAudit() {
  try {
    execFileSync('node', [path.join(ROOT, 'scripts/security-audit.js'), '--dir', DIST_DIR], {
      cwd: ROOT,
      stdio: 'inherit'
    });
    return true;
  } catch (err) {
    return false;
  }
}

function main() {
  log(`${CYAN}🏛️  Open-Core 构建：正在从工作区枚举源文件…${RESET}`);

  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  const files = readTrackedAndUntrackedFiles();
  let copied = 0;
  let excluded = 0;
  for (const relPath of files) {
    if (isExcluded(relPath)) {
      excluded++;
      continue;
    }
    // FILE_OVERRIDES 里的目标文件先按普通文件拷贝一份原文件也无妨——
    // 紧接着 applyOverrides() 会整份覆盖掉，这里不需要单独跳过
    copyFile(relPath);
    copied++;
  }
  ok(`已拷贝 ${copied} 个文件，按 Enterprise 名单排除 ${excluded} 个`);

  applyOverrides();
  ok(`已应用 ${FILE_OVERRIDES.length} 处 Core-only 文件覆盖`);

  stripPlatformAdminRoute();
  anonymizeProjectConfig();
  generateReadmeAndEnvTemplate();

  log('');
  log(`${CYAN}📋 已知遗留耦合（本阶段未物理拆分，如实记录）：${RESET}`);
  KNOWN_MIXED_FILES.forEach((line) => log(`   - ${line}`));

  log('');
  log(`${CYAN}🛡️  正在对生成的 Core 包运行安全防泄露审计…${RESET}`);
  const auditPassed = runSecurityAudit();

  log('');
  if (!auditPassed) {
    fail('安全审计未通过，Core 包已生成但请勿发布，见上方红色告警定位并清除敏感信息');
    process.exitCode = 1;
    return;
  }

  ok(`Open-Core 构建完成：${path.relative(ROOT, DIST_DIR)}`);
}

main();
