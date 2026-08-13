const https = require('https');
const fs = require('fs');

const cmd = fs.readFileSync('C:\\workspace\\trend-trading-agents\\run_market_watch.cmd', 'utf8');
function grab(re, def) { const m = cmd.match(re); return m ? m[1] : def; }
const token = grab(/XUEQIU_TOKEN=([^\r\n"]+)/, '');
const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const urls = [
  'https://xueqiu.com/rainbow/ai/abnormal/reasons.json',
  'https://xueqiu.com/',
];

function probe(url, cb) {
  const req = https.get(url, {
    headers: { 'Cookie': 'xq_a_token=' + token, 'User-Agent': ua, 'Host': 'xueqiu.com' }
  }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      const sc = String(r.statusCode);
      const loc = String(r.headers['location'] || '');
      const sck = String(r.headers['set-cookie'] || '').replace(/\s+/g, ' ');
      let bodyHead = d.slice(0, 1200).replace(/\r?\n/g, ' ');
      console.log('=== ' + url + ' ===');
      console.log('HTTP ' + sc + ' | location=' + loc);
      console.log('set-cookie=' + sck.slice(0, 400));
      console.log('body=' + bodyHead);
      console.log('');
      cb();
    });
  });
  req.on('error', e => { console.log('REQ_ERROR ' + (e && e.message || e)); cb(); });
  req.setTimeout(15000, () => { req.destroy(); console.log('REQ_TIMEOUT ' + url); cb(); });
}

probe(urls[0], () => probe(urls[1], () => {}));
