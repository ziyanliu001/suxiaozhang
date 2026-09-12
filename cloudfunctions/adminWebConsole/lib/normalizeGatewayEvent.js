'use strict';

// 🛡️（2026-09-13）本函数现在同时有两种触发方式：① 微信开发者工具"云端测试"/
// cloud.callFunction() 直接调用，业务字段（action/username/password 等）平铺在
// event 上；② web-admin/index.html 改用腾讯云开发控制台配置的 HTTP 网关触发
// （POST 到 <envId>-<random>.<region>.app.tcloudbase.com/adminWebConsole），网关会
// 把 HTTP 请求体封装进 event.body（字符串），业务字段不再平铺在 event 顶层。
// 两种触发方式必须都能正确解析出同一份业务字段，否则网页发出的请求会因为
// event.action 读到 undefined 而全部命中"未知操作"分支。
function normalizeGatewayEvent(event) {
  if (!event || typeof event !== 'object') return {};
  if (typeof event.body === 'string') {
    try {
      return JSON.parse(event.body) || {};
    } catch (err) {
      return {};
    }
  }
  if (event.body && typeof event.body === 'object') {
    return event.body;
  }
  return event;
}

module.exports = { normalizeGatewayEvent };
