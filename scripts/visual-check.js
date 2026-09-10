#!/usr/bin/env node
'use strict';

// 📸 视觉快照脚本 · visual:check
//
// 用途：终结"代码审计说已经改对了，但看不到真实渲染效果"这种靠猜的开发方式——
// 用 miniprogram-automator 拉起一个专门用于自动化的微信开发者工具实例，跳转到
// 指定页面，截两张图（首屏 + 上滑后）存到本地，供接下来用 Read 工具直接
// "看图"核对，而不是继续对着源码猜视觉效果。
//
// 用法：
//   npm run visual:check                                            # 默认目标页 platform-admin
//   node scripts/visual-check.js /pages/index/index                 # 指定其它页面路径
//   WX_DEVTOOLS_CLI_PATH=/path/to/cli node scripts/visual-check.js   # CLI 路径不同时覆盖
//
// ⚠️ 如实标注两个边界：
// 1. miniprogram-automator 的 automator.connect({wsEndpoint}) 需要一个由
//    `cli auto --project <path> --auto-port <port>` 单独开启的 WebSocket
//    自动化端口——这与 agent-check.js 用的"服务端口"（HTTP 调用，18374）是
//    两个完全不同的机制，用户手动双击打开的那个开发者工具窗口并没有开启
//    这个自动化端口，无法直接 connect 上去。本脚本改用 automator.launch()：
//    它会用 child_process 另外拉起一个新的、专门用于自动化的开发者工具窗口
//    （项目路径相同，但是独立的进程/窗口，不影响你手动操作的那一个），启动
//    时自带 --auto-port，launch() 内部会自己等这个端口就绪再 connect。
// 2. resolveCliPath() 只认 macOS/Windows 的默认安装路径，Linux 下永远解析
//    不到，必须显式传 cliPath——这里默认指向本机通过
//    io.github.msojocs.wechat-devtools-linux 这个非官方 Linux 移植包装出的
//    cli 入口脚本（`dpkg -l` 可查到这个包），如果换了机器/换了安装方式，
//    用 WX_DEVTOOLS_CLI_PATH 环境变量覆盖，不要直接改这个默认值。
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const REPO_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, '.agent', 'snapshots');
const DEFAULT_CLI_PATH = '/opt/apps/io.github.msojocs.wechat-devtools-linux/files/bin/bin/wechat-devtools-cli';
const CLI_PATH = process.env.WX_DEVTOOLS_CLI_PATH || DEFAULT_CLI_PATH;
const TARGET_PAGE = process.argv[2] || '/subpackages/admin/pages/platform-admin/platform-admin';
// 滚动截图的偏移量，对应任务里"向上滚动 400px"的要求
const SCROLL_OFFSET_PX = 400;
// 截图文件名按目标页最后一段路径命名（默认页面固定叫 platform-admin，与
// 任务里指定的 platform-admin-latest.png/platform-admin-scrolled.png 一致；
// 传其它页面路径时自动换成对应的文件名，不会互相覆盖）
const PAGE_SLUG = TARGET_PAGE.replace(/^\//, '').split('?')[0].split('/').filter(Boolean).pop() || 'page';

function sectionLog(msg) {
  console.log(`\n▶ ${msg}`);
}

async function main() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  if (!fs.existsSync(CLI_PATH)) {
    console.error(`✗ 找不到微信开发者工具 CLI：${CLI_PATH}`);
    console.error('  如果这台机器的安装路径不同，用 WX_DEVTOOLS_CLI_PATH=<真实路径> node scripts/visual-check.js 覆盖');
    process.exit(1);
  }

  sectionLog('启动自动化专用的开发者工具实例（会另外弹出一个独立窗口，不影响你手动打开的那一个，首次启动含真实项目编译，耐心等待）...');
  let miniProgram;
  try {
    miniProgram = await automator.launch({
      cliPath: CLI_PATH,
      projectPath: REPO_ROOT,
      timeout: 60000
    });
  } catch (err) {
    console.error('✗ 启动/连接开发者工具自动化实例失败：', err);
    console.error('  排查方向：CLI 路径是否正确、开发者工具的 CLI/HTTP 调用安全设置是否已开启、60s 超时是否够用（首次编译较慢可适当调大脚本里的 timeout）。');
    process.exit(1);
  }

  try {
    sectionLog(`跳转到 ${TARGET_PAGE}`);
    // 🐛 根因（实测确认，不是猜测）：全新自动化实例冷启动时，第一次
    // reLaunch 到子包页面会被 app 自身的冷启动路由（登录态/云开发初始化/
    // 首次角色拉取尚未跑完）静默改写回 pages/index/index——用
    // currentPage() 读真实落点验证过，第一次必现改写，第二次才稳定生效。
    // 这里重试几次、每次加长等待，等冷启动流程真正跑完再继续，不是防御性
    // 瞎写的重试
    let page;
    let landedPath = '';
    const targetNormalized = TARGET_PAGE.replace(/^\//, '').split('?')[0];
    for (let attempt = 1; attempt <= 4; attempt++) {
      page = await miniProgram.reLaunch(TARGET_PAGE);
      await (page ? page.waitFor(1000 * attempt) : new Promise((r) => setTimeout(r, 1000 * attempt)));
      const actualPage = await miniProgram.currentPage();
      landedPath = (actualPage && actualPage.path) || '';
      console.log(`[诊断] 第 ${attempt} 次 reLaunch 后 currentPage(): ${landedPath}`);
      if (landedPath === targetNormalized) {
        page = actualPage;
        break;
      }
    }
    if (landedPath !== targetNormalized) {
      console.warn(`⚠️ 尝试 4 次后仍未停留在目标页（当前：${landedPath}），继续按当前实际页面截图，供诊断用`);
    }

    const topPath = path.join(SNAPSHOT_DIR, `${PAGE_SLUG}-latest.png`);
    await miniProgram.screenshot({ path: topPath });
    console.log(`✓ 首屏截图已保存：${topPath}`);

    sectionLog(`向上滚动 ${SCROLL_OFFSET_PX}px`);
    await miniProgram.pageScrollTo(SCROLL_OFFSET_PX);
    if (page) {
      await page.waitFor(600);
    }

    const scrolledPath = path.join(SNAPSHOT_DIR, `${PAGE_SLUG}-scrolled.png`);
    await miniProgram.screenshot({ path: scrolledPath });
    console.log(`✓ 滚动后截图已保存：${scrolledPath}`);

    console.log(`\n🎉 视觉快照完成，可直接用 Read 工具查看以上两个 PNG 文件核对渲染效果。`);
  } finally {
    await miniProgram.close();
  }
}

main().catch((err) => {
  console.error('✗ 视觉快照脚本异常：', err);
  process.exit(1);
});
