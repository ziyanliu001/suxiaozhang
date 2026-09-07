// scripts/seedActivationCodes.ts
// 离线批量生成 tenant_activation_codes 种子数据（"package" 类型激活码）。
//
// 🏛️ 字段结构与生成算法均照抄 cloudfunctions/activateTenantSubscription/
// index.js 的 handleGenerate/generateRandomCode——那是这张集合唯一真实的
// 写入路径，本脚本不是另一套独立设计，只是把同一套规则搬到离线批量场景：
//   - CODE_CHARSET 排除 0/O、1/I 等易混淆字符，与线上完全一致；
//   - code 展示格式固定为 12 位随机串按 4-4-4 分组、短横线连接；
//   - 文档字段与 handleGenerate 里 codeType==='package' 分支逐字段对齐。
//
// ⚠️ 门店配额（pro=10/enterprise=30）不是激活码文档本身的字段——它是
// handleRedeem 在兑换那一刻按 planType 现算的派生值（PLAN_STORE_LIMITS），
// 这里只在 SPEC_POOL 里保留 storeLimitForReference 供人工核对/打印展示，
// 不写入生成的文档，避免出现一个线上兑换逻辑从不读取的死字段。
//
// ⚠️ 本脚本只在本地生成可导入 JSON，不直连微信云开发数据库——本地环境没有
// 云开发管理员级 SDK 凭据，cloud.init() 依赖云函数运行时环境，脚本环境里
// 用不了。真正入库走两条正规路径之一：①云开发控制台"导入 JSON"功能导入
// tenant_activation_codes 集合；②平台管理员本人登录小程序走
// activateTenantSubscription 的 generate action 铸造。
//
// ⚠️ 生成的激活码等价于可直接兑换出真实付费套餐权益的凭证，属于敏感产出物，
// 输出目录 scripts/output/ 已经在 .gitignore 里排除，不会被提交进版本库。

// 🐛 项目 tsconfig 没有 @types/node（CLAUDE.md 严禁未经许可引入新的第三方
// npm 包，这里不新增 @types/node 依赖）。改用 require()——typings/types/wx/
// index.d.ts 里已有全局 `declare function require(module: string): any`
// （小程序 npm 支持的既有声明，签名足够宽泛，可以直接拿来 require Node
// 内置模块），不需要 import 语法触发模块类型解析
const fs = require('fs');

const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_SOURCE_TAG = 'offline-seed-script:scripts/seedActivationCodes.ts';

type PlanType = 'pro' | 'enterprise';

interface SpecPoolEntry {
  label: string;
  planType: PlanType;
  durationDays: number;
  count: number;
  storeLimitForReference: number;
}

interface ActivationCodeDoc {
  code: string;
  codeNormalized: string;
  codeType: 'package';
  planType: PlanType;
  durationDays: number;
  status: 'UNUSED';
  createdBy: string;
  createdAt: string;
  redeemedBy: null;
  redeemedByTenantId: null;
  redeemedAt: null;
}

const SPEC_POOL: SpecPoolEntry[] = [
  { label: '专业版 · 标准年卡', planType: 'pro', durationDays: 365, count: 8, storeLimitForReference: 10 },
  { label: '旗舰版 · 标准年卡', planType: 'enterprise', durationDays: 365, count: 4, storeLimitForReference: 30 },
  { label: '专业版 · 30天体验卡', planType: 'pro', durationDays: 30, count: 2, storeLimitForReference: 10 },
  { label: '旗舰版 · 30天体验卡', planType: 'enterprise', durationDays: 30, count: 2, storeLimitForReference: 30 }
];

function generateRandomCode(): { display: string; normalized: string } {
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
  }
  return { display: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, normalized: raw };
}

function generateUniqueCode(usedNormalized: Set<string>): { display: string; normalized: string } {
  // 🛡️ 12 位随机串 + 33 字符集，理论碰撞概率极低，但 codeNormalized 上有
  // 唯一索引（createIndexes/index.js），不能假设"随机就一定不撞"，撞了就重掷
  let candidate = generateRandomCode();
  while (usedNormalized.has(candidate.normalized)) {
    candidate = generateRandomCode();
  }
  usedNormalized.add(candidate.normalized);
  return candidate;
}

function buildActivationCodes(): { doc: ActivationCodeDoc; spec: SpecPoolEntry }[] {
  const usedNormalized = new Set<string>();
  const createdAt = new Date().toISOString();
  const result: { doc: ActivationCodeDoc; spec: SpecPoolEntry }[] = [];

  for (const spec of SPEC_POOL) {
    for (let i = 0; i < spec.count; i++) {
      const { display, normalized } = generateUniqueCode(usedNormalized);
      const doc: ActivationCodeDoc = {
        code: display,
        codeNormalized: normalized,
        codeType: 'package',
        planType: spec.planType,
        durationDays: spec.durationDays,
        status: 'UNUSED',
        createdBy: CODE_SOURCE_TAG,
        createdAt,
        redeemedBy: null,
        redeemedByTenantId: null,
        redeemedAt: null
      };
      result.push({ doc, spec });
    }
  }
  return result;
}

function printChecklist(entries: { doc: ActivationCodeDoc; spec: SpecPoolEntry }[]): void {
  console.log(`\n共生成 ${entries.length} 张激活码：\n`);
  let currentLabel = '';
  for (const { doc, spec } of entries) {
    if (spec.label !== currentLabel) {
      currentLabel = spec.label;
      console.log(`\n【${spec.label}】planType=${spec.planType} durationDays=${spec.durationDays} 参考门店配额=${spec.storeLimitForReference}`);
    }
    console.log(`  ${doc.code}`);
  }
  console.log('');
}

// 🐛 不用 __dirname/process.cwd()（同样需要 @types/node 才有类型声明）——
// 固定用相对于仓库根目录的 scripts/output 路径，脚本约定必须在仓库根目录
// 下执行（与 package.json 里其余 scripts/*.js 的既有运行方式一致）
const OUTPUT_DIR = 'scripts/output';

// 🐛 云开发控制台"导入 JSON"要求内容是 JSON Lines（ndjson，每行一个独立
// JSON 对象，不带外层方括号/逗号），但底层 Mongo 导入接口只认 .json/.csv
// 这两种文件名后缀——之前用 .jsonl 后缀触发了另一层报错
// "invalid import filename(only support .json or .csv)"。
// 后缀与内容格式是两回事：文件名固定用 .json，内容依然是逐行独立对象的
// JSON Lines，不要因为换回 .json 后缀就误以为要改回外层数组格式
function writeOutputFile(entries: { doc: ActivationCodeDoc; spec: SpecPoolEntry }[]): string {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = `${OUTPUT_DIR}/activation-codes-${timestamp}.json`;
  const lines = entries.map((e: { doc: ActivationCodeDoc }) => JSON.stringify(e.doc));
  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  return outputPath;
}

function main(): void {
  const entries = buildActivationCodes();
  printChecklist(entries);
  const outputPath = writeOutputFile(entries);
  console.log(`已写入 .json 文件（内容为 JSON Lines 格式）：${outputPath}`);
  console.log('该目录已在 .gitignore 中排除，不会被提交进版本库；如需真正生效，');
  console.log('请通过微信云开发控制台"导入 JSON"功能导入 tenant_activation_codes 集合');
  console.log('（控制台实际要求 JSON Lines/ndjson 格式，每行一个独立对象）。');
}

main();
