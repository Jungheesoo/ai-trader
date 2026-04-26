// KST(UTC+9) 기준 날짜/시간 유틸
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function nowKST() {
  return new Date(Date.now() + KST_OFFSET_MS);
}

// 'YYYY-MM-DD' (KST 기준)
function getTodayKST() {
  return nowKST().toISOString().slice(0, 10);
}

// 현재 시각 ISO 문자열 (KST 기준이지만 저장용으로 UTC처럼 사용)
function nowISOString() {
  return new Date().toISOString();
}

module.exports = { nowKST, getTodayKST, nowISOString };
