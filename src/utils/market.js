'use strict';
const { isHoliday } = require('../services/holiday');

function isMarketOpen() {
  const now = new Date();
  if (isHoliday(now)) return false;
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const time = hour * 100 + minute;
  return time >= 900 && time <= 1530;
}

function getMarketStatus() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  const hour = kst.getUTCHours();
  const minute = kst.getUTCMinutes();
  const time = hour * 100 + minute;

  if (isHoliday(now)) return 'closed';
  if (time >= 800 && time < 900) return 'pre';
  if (time >= 900 && time <= 1530) return 'regular';
  if (time > 1530 && time < 1540) return 'break';
  if (time >= 1540 && time <= 1800) return 'after';
  return 'closed';
}

module.exports = { isMarketOpen, getMarketStatus };
