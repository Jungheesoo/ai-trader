// 한국 주식시장 휴장일 (설날/추석은 매년 업데이트 필요)
const FIXED_HOLIDAYS = [
  '01-01', // 신정
  '03-01', // 삼일절
  '05-05', // 어린이날
  '06-06', // 현충일
  '08-15', // 광복절
  '10-03', // 개천절
  '10-09', // 한글날
  '12-25', // 성탄절
];

// 설날/추석 연휴 (업데이트 필요)
const LUNAR_HOLIDAYS_2025 = [
  '2025-01-28', '2025-01-29', '2025-01-30',
  '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
];

const LUNAR_HOLIDAYS_2026 = [
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-09-24', '2026-09-25', '2026-09-26',
];

const ALL_LUNAR_HOLIDAYS = [...LUNAR_HOLIDAYS_2025, ...LUNAR_HOLIDAYS_2026];

function toKSTDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function isHoliday(date) {
  const d = date instanceof Date ? date : new Date(date);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const dayOfWeek = kst.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return true;

  const yyyy_mm_dd = kst.toISOString().slice(0, 10);
  const mmdd = yyyy_mm_dd.slice(5, 10);
  if (FIXED_HOLIDAYS.includes(mmdd)) return true;

  if (ALL_LUNAR_HOLIDAYS.includes(yyyy_mm_dd)) return true;

  return false;
}

function isMarketOpen(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isHoliday(d)) return false;
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const totalMinutes = hours * 60 + minutes;
  return totalMinutes >= 9 * 60 && totalMinutes < 15 * 60 + 30;
}

function isWeekday(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = d.getDay();
  return day >= 1 && day <= 5 && !isHoliday(d);
}

function isFriday(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getDay() === 5 && !isHoliday(d);
}

function isMonday(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getDay() === 1 && !isHoliday(d);
}

function getNextTradingDay(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setDate(d.getDate() + 1);
  while (isHoliday(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function isTradingHours(date) {
  return isMarketOpen(date);
}

module.exports = { isHoliday, isMarketOpen, isWeekday, isFriday, isMonday, getNextTradingDay, isTradingHours };
