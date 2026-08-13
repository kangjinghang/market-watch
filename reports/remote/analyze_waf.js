const https = require('https');
const fs = require('fs');

const cmd = fs.readFileSync('C:\\workspace\\trend-trading-agents\\run_market_watch.cmd', 'utf8');
function grab(re, def) { const m = cmd.match(re); return m ? m[1] : def; }
const token = grab(/XUEQIU_TOKEN=([^\r\n"]+)/, '');
const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// 1) get acw_tc from homepage
function getHome(cb) {
  const req = https.get('https://xueqiu.com/', {
    headers: { 'Cookie': 'xq_a_token=' + token, 'User-Agent': ua, 'Host': 'xueqiu.com' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      const sck = String(r.headers['set-cookie'] || '');
      const acwTc = (sck.match(/acw_tc=([^;]+)/) || [])[1] || '';
      // find dynamic script src
      const m = d.match(/\/u21pn7x6\/[a-z0-9]+\/[a-z0-9]+\/(?:psk8uqfi|[\w]+)/);
      const scriptSrc = m ? m[0] : '';
      fs.writeFileSync('C:\\workspace\\waf_home.html', d);
      console.log('acw_tc=' + acwTc);
      console.log('scriptSrc=' + scriptSrc);
      cb(acwTc, scriptSrc);
    });
  });
  req.on('error', e => { console.log('HOME_ERR ' + e.message); cb('', ''); });
  req.setTimeout(15000, () => { req.destroy(); console.log('HOME_TIMEOUT'); cb('', ''); });
}

// 2) fetch the WAF challenge JS
function getScript(acwTc, scriptSrc, cb) {
  if (!scriptSrc) { console.log('NO_SCRIPT_SRC'); cb(''); return; }
  const req = https.get('https://xueqiu.com' + scriptSrc, {
    headers: { 'Cookie': 'xq_a_token=' + token + '; acw_tc=' + acwTc, 'User-Agent': ua, 'Host': 'xueqiu.com' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      fs.writeFileSync('C:\\workspace\\waf_script.js', d);
      console.log('script_len=' + d.length);
      console.log('--- script head (first 600) ---');
      console.log(d.slice(0, 600));
      console.log('--- contains arg1? ' + /arg1/.test(d) + ' | contains _0x? ' + /_0x/.test(d) + ' ---');
      cb(d);
    });
  });
  req.on('error', e => { console.log('SCRIPT_ERR ' + e.message); cb(''); });
  req.setTimeout(15000, () => { req.destroy(); console.log('SCRIPT_TIMEOUT'); cb(''); });
}

getHome((acwTc, scriptSrc) => getScript(acwTc, scriptSrc, () => {}));
