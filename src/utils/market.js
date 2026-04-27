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

// 장 상태 세분화 (정규장/시간외/휴장)
function getMarketStatus() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const time = hour * 100 + minute;

  if (day === 0 || day === 6) return 'closed';
  if (time >= 800 && time < 900) return 'pre';      // 장 전 시간외
  if (time >= 900 && time <= 1530) return 'regular'; // 정규장
  if (time > 1530 && time < 1540) return 'break';   // 장 마감 휴식
  if (time >= 1540 && time <= 1800) return 'after';  // 장 후 시간외
  return 'closed';
}

module.exports = { isMarketOpen, getMarketStatus };
