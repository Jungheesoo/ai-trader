'use strict';

function isMarketOpen() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const time = hour * 100 + minute;
  if (day === 0 || day === 6) return false;
  return time >= 900 && time <= 1530;
}

module.exports = { isMarketOpen };
