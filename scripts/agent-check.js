#!/usr/bin/env node
'use strict';

// 🤖 本地自闭环流水线 · agent:check
//
// 用途：Agent（我）每次改动代码后自主跑通"类型校验 → 自动化测试 → 通知微信
// 开发者工具重新编译"这条链路，不再需要人类手动切回 IDE 按 Ctrl+B 肉眼确认。
//
// 用法：
//   npm run agent:check
//   WX_DEVTOOLS_PORT=18374 npm run agent:check          # 显式指定安全端口
//   AGENT_CHECK_SKIP_DEVTOOLS=1 npm run agent:check      # 开发者工具未启动时跳过第 3 步
//
// ⚠️ 如实标注一个重要边界（不要被脚本名字里的"compile"误导）：
// 微信开发者工具官方 HTTP V2 / CLI V2 接口（developers.weixin.qq.com/miniprogram/
// dev/devtools/http.html、.../cli.html）里并不存在一个"编译并返回 WXML/WXSS/JS
// 语法错误列表"的接口——`/v2/open`/`/v2/autopreview` 这类接口的作用是"让已经
// 打开的项目重新加载/编译"，编译成功与否、有没有语法错误，只会体现在 IDE 自己
// 的图形界面控制台里，HTTP 层面只能拿到"这次调用本身有没有成功发出"这一层反馈
// （连不上端口 / project.config.json 路径不对 / 未登录等），不能替代 tsc 或者
// node --test 这类真正能返回结构化错误的校验。因此本脚本的第 3 步只承担"通知
// IDE 重新编译，让你不用手动点"这一件事，代码正确性的把关完全靠前两步。
// 这里最初设想的 `/build/compile` 端点在官方文档与实测里都不存在，实测过的
// 真实端点是 `/v2/open?project=<encoded path>`（附带一次 `/v2/cleancache?
// clean=compile` 尽量清掉旧编译缓存，呼应本仓库此前"疑似 DevTools 编译缓存
// 导致复现不了的假性 editing:true 泄漏"那次排查记录）。
const { spawnSync } = require('child_process');
const http = require('http');
const path = require('path');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const REPO_ROOT = path.resolve(__dirname, '..');
const DEVTOOLS_PORT = process.env.WX_DEVTOOLS_PORT || '18374';
const DEVTOOLS_PROJECT = process.env.WX_DEVTOOLS_PROJECT || REPO_ROOT;
const SKIP_DEVTOOLS = process.env.AGENT_CHECK_SKIP_DEVTOOLS === '1';

function section(title) {
  console.log(`\n${BOLD}${CYAN}▶ ${title}${RESET}`);
}

// 跑一个 npm script，直接把子进程 stdout/stderr 接到当前终端（stdio:'inherit'）——
// typecheck/test 本身已经会打印足够详细的诊断信息（tsc 的文件:行号、
// node --test 的失败用例名+断言差异），这里不重复截获再转述一遍，避免信息
// 在转述过程中被截断或丢失关键上下文
function runNpmScript(scriptName) {
  const result = spawnSync('npm', ['run', scriptName], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.error) {
    console.error(`${RED}${BOLD}✗ 无法启动 npm run ${scriptName}：${result.error.message}${RESET}`);
    return false;
  }
  return result.status === 0;
}

// 微信开发者工具 HTTP V2 服务的最小封装：GET 请求 + 8s 超时 + 按官方观察到的
// 错误形状（HTTP 非 200，或 body 里带 code/message 字段）判定失败。这里没有
// 依赖任何第三方 HTTP 库，用 Node 内置 http 模块手写，避免为了一个内部脚本
// 引入额外 npm 依赖
function devtoolsHttpGet(urlPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(DEVTOOLS_PORT), path: urlPath, timeout: 8000 },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (e) {
            parsed = null;
          }
          const ok = res.statusCode === 200 && !(parsed && parsed.code);
          resolve({ ok, statusCode: res.statusCode, body: raw, parsed });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: '', parsed: null, timedOut: true });
    });
    req.on('error', (err) => {
      resolve({ ok: false, statusCode: 0, body: '', parsed: null, err });
    });
  });
}

async function notifyDevtools() {
  const encodedProject = encodeURIComponent(DEVTOOLS_PROJECT);

  // 第一步：清编译缓存（best-effort，失败只警告不拦截）——本仓库此前排查
  // "editing:true 疑似泄漏"时怀疑过是 DevTools 编译缓存没刷新导致的假性复现，
  // 这里顺手把这条怀疑落地成一个自动化步骤，而不是每次都靠人肉猜
  const cleanRes = await devtoolsHttpGet(`/v2/cleancache?clean=compile&project=${encodedProject}`);
  if (!cleanRes.ok) {
    console.warn(`${YELLOW}⚠️ 清编译缓存未成功（不阻断，继续尝试重新加载项目）：${cleanRes.body || (cleanRes.err && cleanRes.err.message) || '超时'}${RESET}`);
  } else {
    console.log(`${GREEN}✓ 已清除开发者工具编译缓存${RESET}`);
  }

  // 第二步：真正触发"重新加载并编译当前项目"——官方 API 没有独立的
  // "只编译不重开"接口，/v2/open 对一个已经打开的项目再次调用会重新加载/
  // 编译，是目前唯一能程序化触发的等价动作
  const openRes = await devtoolsHttpGet(`/v2/open?project=${encodedProject}`);
  return openRes;
}

async function main() {
  section('Step 1/3  npm run typecheck');
  const typecheckOk = runNpmScript('typecheck');
  if (!typecheckOk) {
    console.error(`\n${RED}${BOLD}✗ typecheck 未通过，上方是 tsc 的原始输出——先按文件:行号定位修完再重跑 npm run agent:check。${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ typecheck 通过${RESET}`);

  section('Step 2/3  npm test');
  const testOk = runNpmScript('test');
  if (!testOk) {
    console.error(`\n${RED}${BOLD}✗ 测试未全绿，上方是 node --test 的原始输出——先看是哪条 test() 断言失败再重跑 npm run agent:check。${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ 测试全部通过${RESET}`);

  section('Step 3/3  通知微信开发者工具重新编译');
  if (SKIP_DEVTOOLS) {
    console.log(`${YELLOW}⏭️ AGENT_CHECK_SKIP_DEVTOOLS=1，跳过开发者工具通知（typecheck/test 已通过，这一步只是 IDE 侧的便利动作，不是代码正确性门禁）${RESET}`);
    console.log(`\n${GREEN}${BOLD}🎉 自动化自检完成（已跳过开发者工具通知）${RESET}`);
    process.exit(0);
  }

  console.log(`目标：127.0.0.1:${DEVTOOLS_PORT}，项目路径：${DEVTOOLS_PROJECT}`);
  const openRes = await notifyDevtools();
  if (!openRes.ok) {
    console.error(`\n${RED}${BOLD}✗ 未能通知开发者工具重新编译${RESET}`);
    if (openRes.timedOut) {
      console.error(`${RED}  原因：连接 127.0.0.1:${DEVTOOLS_PORT} 超时（8s）${RESET}`);
    } else if (openRes.err) {
      console.error(`${RED}  原因：${openRes.err.message}${RESET}`);
    } else {
      console.error(`${RED}  HTTP ${openRes.statusCode}，响应：${openRes.body}${RESET}`);
    }
    console.error(`${YELLOW}  排查清单：
  1. 微信开发者工具是否已启动并打开本项目？
  2. 设置 → 安全设置 → 服务端口是否已开启，端口号是否确实是 ${DEVTOOLS_PORT}？
     （不一致时用 WX_DEVTOOLS_PORT=xxxx npm run agent:check 覆盖）
  3. project.config.json 是否就在 ${DEVTOOLS_PROJECT} 目录下？
  4. 临时想跳过这一步：AGENT_CHECK_SKIP_DEVTOOLS=1 npm run agent:check${RESET}`);
    process.exit(1);
  }
  console.log(`${GREEN}✓ 已通知开发者工具重新加载并编译项目${RESET}`);

  console.log(`\n${GREEN}${BOLD}🎉 自动化自检完成，开发者工具已重新编译${RESET}`);
  process.exit(0);
}

main();
