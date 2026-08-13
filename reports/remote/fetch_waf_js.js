const https = require('https');
const fs = require('fs');

const cmd = fs.readFileSync('C:\\workspace\\trend-trading-agents\\run_market_watch.cmd', 'utf8');
function grab(re, def) { const m = cmd.match(re); return m ? m[1] : def; }
const token = grab(/XUEQIU_TOKEN=([^\r\n"]+)/, '');
const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// first get homepage to obtain acw_tc + the dynamic waf script path
function getHome(cb) {
  const req = https.get('https://xueqiu.com/', {
    headers: { 'Cookie': 'xq_a_token=' + token, 'User-Agent': ua, 'Host': 'xueqiu.com' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      const sck = String(r.headers['set-cookie'] || '');
      const acwTc = (sck.match(/acw_tc=([^;]+)/) || [])[1] || '';
      const m = d.match(/<script\s+src="(\/u21pn7x6\/[^"]+)"/);
      const scriptSrc = m ? m[1] : '';
      console.log('acw_tc=' + acwTc + ' scriptSrc=' + scriptSrc);
      cb(acwTc, scriptSrc);
    });
  });
  req.on('error', e => { console.log('HOME_ERR ' + e.message); cb('', ''); });
  req.setTimeout(15000, () => { req.destroy(); console.log('HOME_TIMEOUT'); cb('', ''); });
}

function getScript(acwTc, scriptSrc, cb) {
  if (!scriptSrc) { console.log('NO_SCRIPT'); cb(''); return; }
  const req = https.get('https://xueqiu.com' + scriptSrc, {
    headers: { 'Cookie': 'xq_a_token=' + token + '; acw_tc=' + acwTc, 'User-Agent': ua, 'Host': 'xueqiu.com' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      fs.writeFileSync('C:\\workspace\\waf_script.js', d);
      console.log('SCRIPT_LEN=' + d.length);
      console.log('HAS_arg1=' + /arg1/.test(d));
      console.log('HAS_acw_sc__v2=' + /acw_sc__v2/.test(d));
      console.log('HAS_setCookie=' + /setCookie/.test(d));
      console.log('--- head 500 ---');
      console.log(d.slice(0, 500));
      cb(d);
    });
  });
  req.on('error', e => { console.log('SCRIPT_ERR ' + e.message); cb(''); });
  req.setTimeout(15000, () => { req.destroy(); console.log('SCRIPT_TIMEOUT'); cb(''); });
}

getHome((acwTc, scriptSrc) => getScript(acwTc, scriptSrc, () => {}));
