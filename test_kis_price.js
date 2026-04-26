require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const axios = require('axios');
const fs = require('fs');

const t = JSON.parse(fs.readFileSync('./data/kis_token.json')).access_token;

axios.get('https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price', {
  params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '034020' },
  headers: {
    Authorization: 'Bearer ' + t,
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
    tr_id: 'FHKST01010100'
  },
  timeout: 10000
}).then(function(r) {
  var o = r.data.output;
  console.log('stck_prpr(현재가):', o.stck_prpr);
  console.log('stck_clpr(종가)  :', o.stck_clpr);
  console.log('prdy_clpr(전일종가):', o.prdy_clpr);
}).catch(function(e) {
  console.error(e.message);
});
