const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function getPrevDayIsoString(dateString) {
  const d = new Date(dateString);
  d.setDate(d.getDate() - 1);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

exports.main = async (event, context) => {
  const { shopName, mpAccount, targetDateString } = event;

  if (!shopName || !targetDateString) {
    return {
      success: false,
      error: '缺少必要参数: shopName 或 targetDateString'
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateString)) {
    return {
      success: false,
      error: '日期格式不正确，应为 YYYY-MM-DD'
    };
  }

  try {
    const cleanStore = (s) => String(s || '').replace(/[区市省店\s]/g, '').trim();
    const targetStore = cleanStore(shopName);

    const prevDateString = getPrevDayIsoString(targetDateString);

    let matched = null;
    let matchType = 'none';

    if (targetStore && targetStore !== '全部门店') {
      const exactMatchRes = await db.collection('report_logs')
        .where({
          shopName: shopName,
          dateString: prevDateString
        })
        .limit(1)
        .get();

      if (exactMatchRes.data && exactMatchRes.data.length > 0) {
        matched = exactMatchRes.data[0];
        matchType = 'exact';
        console.log(`[getPreviousBalance] 精准匹配 T-1 成功: ${prevDateString}`);
      } else {
        const fuzzyMatchRes = await db.collection('report_logs')
          .where({
            dateString: prevDateString
          })
          .limit(10)
          .get();

        if (fuzzyMatchRes.data && fuzzyMatchRes.data.length > 0) {
          matched = fuzzyMatchRes.data.find(item => {
            const itemStore = cleanStore(item.shopName || item.store || '');
            return itemStore.includes(targetStore) || targetStore.includes(itemStore);
          }) || fuzzyMatchRes.data[0];
          matchType = 'exact_date';
          console.log(`[getPreviousBalance] 日期精准匹配成功，门店模糊匹配: ${prevDateString}`);
        }
      }
    }

    if (!matched) {
      const fallbackRes = await db.collection('report_logs')
        .where({
          dateString: _.lt(targetDateString)
        })
        .orderBy('dateString', 'desc')
        .limit(20)
        .get();

      if (fallbackRes.data && fallbackRes.data.length > 0) {
        if (!targetStore || targetStore === '全部门店') {
          matched = fallbackRes.data[0];
        } else {
          matched = fallbackRes.data.find(item => {
            const itemStore = cleanStore(item.shopName || item.store || '');
            return itemStore.includes(targetStore) || targetStore.includes(itemStore);
          }) || fallbackRes.data[0];
        }
        matchType = 'fallback';
        console.log(`[getPreviousBalance] 降级匹配成功，最近日期: ${matched.dateString}`);
      }
    }

    if (matched) {
      const endingBalance = matched.todayBalance != null && matched.todayBalance !== ''
        ? matched.todayBalance
        : (matched.adjustedBalance != null ? matched.adjustedBalance : null);

      return {
        success: true,
        data: {
          balance: endingBalance,
          dateString: matched.dateString,
          shopName: matched.shopName,
          mpAccount: matched.mpAccount,
          matchType: matchType
        }
      };
    }

    return {
      success: true,
      data: null,
      message: '未找到该店铺的上期结余记录',
      matchType: 'none'
    };
  } catch (error) {
    console.error('getPreviousBalance error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};
