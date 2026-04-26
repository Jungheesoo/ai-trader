require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');

const t = JSON.parse(fs.readFileSync('./data/kis_token.json')).access_token;
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const from = '20260420';

axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', {
  params: {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: '034020',
    FID_INPUT_DATE_1: from,
    FID_INPUT_DATE_2: today,
    FID_PERIOD_DIV_CODE: 'D',
    FID_ORG_ADJ_PRC: '0'
  },
  headers: {
    Authorization: 'Bearer ' + t,
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
    tr_id: 'FHKST03010100'
  },
  timeout: 15000
}).then(function(r) {
  var rows = r.data.output2 || [];
  rows.slice(0, 5).forEach(function(d) {
    console.log('날짜:', d.stck_bsop_date, '종가:', d.stck_clpr, '시가:', d.stck_oprc, '고가:', d.stck_hgpr, '저가:', d.stck_lwpr);
  });
}).catch(function(e) {
  console.error(e.message);
});
