// Drives every control on the holiday gift boxes page and checks every number on screen.
// Needs the preview build served (python3 tools/serve.py 8781) and, for the payment step, the dev
// checkout (node tools/bh_checkout_dev.mjs on :8792, built in with KL_BH_ENDPOINT). Test mode only:
// ?today= pins the date. Screenshots go to /tmp. Run: node tools/test_bh_page.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.BASE || "http://localhost:8781";
const URL = BASE + "/gifts/holiday-gift-boxes?today=2026-10-15";
const OUT = "/tmp";

async function browser(width) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(CH, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/bhtest-${port}`, 'about:blank'], { stdio: 'ignore' });
  let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (t.length) break; } catch {} await sleep(250); }
  const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'eval error'); return m.result.result.value; };
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 900 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 900 });
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  for (let i = 0; i < 40; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(250); }
  await sleep(800);
  const shot = async name => { const m = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(m.result.data, 'base64')); };
  return { ev, shot, send, close: () => { ws.close(); proc.kill(); } };
}

let fails = 0, passes = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passes++ : fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const click = sel => `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('missing '+${JSON.stringify(sel)}); e.click(); return true})()`;
const text = sel => `(document.querySelector(${JSON.stringify(sel)})||{}).textContent?.trim()`;
const state = `(()=>({
  open: !document.getElementById('co').hidden,
  tab: document.querySelector('.co-tabs [aria-selected=true]')?.dataset.box,
  badges: [...document.querySelectorAll('[data-badge]')].map(b=>b.hasAttribute('data-zero')?0:+b.textContent),
  tiles: Object.fromEntries([...document.querySelectorAll('.tile')].map(t=>[t.dataset.id, +t.querySelector('output').textContent])),
  on: [...document.querySelectorAll('.tile.on')].map(t=>t.dataset.id),
  minusDisabled: [...document.querySelectorAll('.tile')].filter(t=>t.querySelector('[data-step="-1"]').disabled).map(t=>t.dataset.id),
  groups: [...document.querySelectorAll('.co-grp')].map(g=>[g.querySelector('.co-gh').textContent, [...g.querySelectorAll('.co-ln')].map(l=>l.textContent.trim())]),
  count: document.getElementById('co-count').textContent, sum: document.getElementById('co-sum').textContent,
  pay: document.getElementById('co-pay').textContent, pbar: document.getElementById('co-pb').textContent,
  mine: document.querySelector('.mine').textContent.replace(/\\s+/g,' ').trim(),
}))()`;
const calOpen = `[...document.querySelectorAll('#co-cal [data-day]')].map(b=>b.dataset.day)`;
const calMonth = `document.querySelector('#co-cal .cal-h b')?.textContent`;
const arrows = `[...document.querySelectorAll('#co-cal [data-mon]')].map(b=>b.disabled)`;

// ---------------- desktop ----------------
{
  const b = await browser(1440);
  const { ev, shot, send } = b;

  // Toolbar
  check('gold bar text is dark enough to read', await ev(`getComputedStyle(document.querySelector('.tah-bar')).color`), 'rgb(27, 26, 24)');
  check('gold bar', await ev(text('.tah-bar')), "✴︎ Holiday gift boxes from Baker's Heart and Kawika Lopez. Pickups start November 16. ✴︎");
  check('desktop menu visible, hamburger hidden', await ev(`[getComputedStyle(document.querySelector('.tah-nav')).display, getComputedStyle(document.querySelector('.tah-menu')).display]`), ['flex', 'none']);
  check('top-level menu', await ev(`[...document.querySelectorAll('.tah-nav > li > a')].map(a=>a.firstChild.textContent.trim())`),
    ['About', 'Programs', 'Social Enterprises', 'Our Community', 'Donate', 'Shop', 'Contact Us']);
  check('every toolbar link goes to Touch A Heart', await ev(`[...document.querySelectorAll('.tah-head a')].filter(a=>!/^https:\\/\\/(touchahearthawaii\\.org|give\\.touchahearthawaii\\.org)\\//.test(a.href)).map(a=>a.href)`), []);
  check('toolbar link count (desktop + phone menus, logo)', await ev(`document.querySelectorAll('.tah-head a').length`), 36);
  check('Shop dropdown items', await ev(`[...document.querySelectorAll('.tah-nav > li')][5].querySelectorAll('.tah-sub a').length`), 4);
  check('toolbar order button', await ev(state + '.mine'), 'Order a gift box');
  check('proposal banner removed', await ev(`!!document.querySelector('.mock-banner')`), false);
  check('pickup line', await ev(`document.querySelector('#boxes .prose').textContent.includes('You can order now. Pickups run November 16 to December 22, at Kalihi Union Church on weekdays or Pearl City Community Church on Wednesdays.')`), true);
  check('order buttons', await ev(`[...document.querySelectorAll('[data-open]')].map(b=>b.dataset.open+':'+b.textContent.replace(/\\s+/g,' ').trim())`),
    [':Order a gift box', 'team:Order the Team box', 'client:Order the Client box', 'team:Order gift boxes']);
  check('wall prints clickable', await ev(`[...document.querySelectorAll('[data-pick]')].map(f=>f.dataset.pick+':'+f.querySelector('[role=button]').getAttribute('aria-label'))`),
    ['mokulele:Order a box with Mokulele', 'mokulua:Order a box with Mokulua', 'shoreline:Order a box with Shoreline Cascade', 'leahi:Order a box with Lēʻahi Kahiko', 'kahana:Order a box with Kahana', 'malie:Order a box with Mālie']);
  check('just-cookies and just-prints links', await ev(`[...document.querySelectorAll('.just-card')].map(c=>[c.querySelector('h3').textContent, c.querySelector('a').href])`),
    [['Just looking for cookies?', 'https://touchahearthawaii.org/collections/bh-holiday'], ['Just looking for prints?', BASE + '/store/']]);
  check('wall prints match the rules, in order', await ev("[...document.querySelectorAll('[data-pick]')].map(f=>f.dataset.pick)"), ['mokulele', 'mokulua', 'shoreline', 'leahi', 'kahana', 'malie']);
  check('just section sits below the boxes and the story', await ev(`document.querySelector('.just').getBoundingClientRect().top > [...document.querySelectorAll('main .band')].pop().getBoundingClientRect().top`), true);
  check('sale first: boxes come before the story', await ev(`document.getElementById('boxes').compareDocumentPosition(document.querySelector('main .band')) & 4`), 4);
  check('both order buttons above the fold at 1440 x 900', await ev(`[...document.querySelectorAll('#boxes [data-open]')].every(b=>b.getBoundingClientRect().bottom<=900)`), true);
  check('a + on each box, and the wall heading', await ev(`[document.querySelectorAll('#boxes .box .plus').length, document.querySelector('#boxes .pick-foot h3').textContent]`), [2, 'Plus the photograph you pick']);
  check('order: boxes, then plus and wall, then box details', await ev(`(()=>{const b=document.querySelector('#boxes .boxes'),w=document.querySelector('#boxes .wall'),n=document.querySelector('#boxes .box-note');return (b.compareDocumentPosition(w)&4)&&(w.compareDocumentPosition(n)&4)?'ok':'wrong'})()`), 'ok');
  check('one frame holds the boxes, the + and the wall', await ev(`(()=>{const o=document.querySelector('#boxes .offer');return !!o && ['.boxes','.box .plus','.wall','.pick-foot h3'].every(q=>o.querySelector(q)) && !o.querySelector('.box-note')})()`), true);
  check('order inside the frame: boxes, +, wall, then heading and line', await ev(`(()=>{const q=s=>document.querySelector('#boxes .offer '+s);const seq=[q('.boxes'),q('.wall'),q('.pick-foot h3'),q('.pick-foot p')];return seq.every((e,i)=>i===0||(seq[i-1].compareDocumentPosition(e)&4))})()`), true);
  check('wall sits right against the boxes', await ev(`(()=>{const b=document.querySelector('#boxes .boxes').getBoundingClientRect(),w=document.querySelector('#boxes .wall').getBoundingClientRect();return Math.round(w.top-b.bottom)})()`), 0);
  check('one + per box, centred on the seam', await ev(`[...document.querySelectorAll('#boxes .box')].map(c=>{const r=c.getBoundingClientRect(),p=c.querySelector('.plus').getBoundingClientRect();return [Math.round(p.left+p.width/2-(r.left+r.width/2)), Math.round(p.top+p.height/2-r.bottom), getComputedStyle(c.querySelector('.plus')).display]})`), [[0, 0, 'grid'], [0, 0, 'grid']]);
  check('order buttons: no glow, spark and sweep run forever', await ev(`[...document.querySelectorAll('.btn-order')].map(b=>{const sp=b.querySelector('.trace-spark'),sh=b.querySelector('.shine');return [b.getAnimations().length, sp.getAnimations().length, sp.getAnimations()[0].effect.getTiming().iterations===Infinity, sp.getAnimations()[0].playState, sh.getAnimations().length]})`), [[0, 1, true, 'running', 1], [0, 1, true, 'running', 1]]);
  check('spark is Baker\'s Heart gold', await ev(`getComputedStyle(document.querySelector('.trace-spark')).stroke`), 'rgb(194, 157, 59)');
  check('outline sits 6px outside each button', await ev(`[...document.querySelectorAll('.btn-order')].map(b=>{const r=b.getBoundingClientRect(),o=b.querySelector('.trace-base').getBoundingClientRect();return [Math.round(r.left-o.left), Math.round(o.right-r.right), Math.round(r.top-o.top), Math.round(o.bottom-r.bottom)]})`), [[6, 6, 6, 6], [6, 6, 6, 6]].map(x=>x.map(v=>v+0)));
  check('buttons centred in the white text area', await ev(`[...document.querySelectorAll('.btn-order')].map(b=>{const r=b.getBoundingClientRect(),c=b.parentElement.getBoundingClientRect();return Math.abs(Math.round((r.left+r.right)/2-(c.left+c.right)/2))<=1})`), [true, true]);
  check('order buttons are narrower than their card', await ev(`[...document.querySelectorAll('.btn-order')].every(b=>b.getBoundingClientRect().width < b.parentElement.getBoundingClientRect().width - 48)`), true);
  const overlaps = [];
  for (const w of [1440, 1280, 1100, 1024, 960, 900, 820, 768, 720]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(150);
    overlaps.push(await ev(`(()=>{const hit=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;return [...document.querySelectorAll('#boxes .box')].filter(c=>{const p=c.querySelector('.plus');return getComputedStyle(p).display!=='none'&&hit(p.getBoundingClientRect(),c.querySelector('.trace-base').getBoundingClientRect())}).length})()`));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(200);
  check('no + touches an Order button or its outline from 720 to 1440 wide', overlaps, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  check('opening line', await ev(text('.hero .lede')), "Your clients and team get cookies to share now and a photograph that lives on the wall for years. Every box supports Touch A Heart's job training and a local artist.");
  check('no "know by heart" anywhere', await ev(`document.body.textContent.includes('know by heart')`), false);
  await shot('bh-d1-top');

  // The window starts empty; the Client button opens on the Client tab
  await ev(click('[data-open="client"]')); await sleep(300);
  let s = await ev(state);
  check('client button opens on the Client tab, empty', [s.open, s.tab, s.count, s.sum, s.mine, s.on], [true, 'client', '0 boxes', '$0', 'Order a gift box', []]);
  check('empty message', await ev(text('#co-lines')), 'Nothing here yet. Add a photograph to start your order.');
  check('what line (client)', await ev(text('#co-what')), "Every Client box has a matted print of the photograph you pick and a Baker's Heart gift box of lace cookies and biscotti bites.");
  check('tiles match the rules', await ev("[...document.querySelectorAll('.tile .nm')].map(n=>n.textContent)"), ['Mokulele', 'Mokulua', 'Shoreline Cascade', 'Lēʻahi Kahiko', 'Kahana', 'Mālie']);
  check('body scroll locked', await ev(`document.body.style.overflow`), 'hidden');
  check('focus on close', await ev(`document.activeElement.className`), 'co-x');
  await ev(click('.tile[data-id="malie"] [data-step="1"]')); await ev(click('.tile[data-id="malie"] [data-step="1"]'));
  await ev(click('[data-close].co-x')); await sleep(200);
  check('close button closes', await ev(`document.getElementById('co').hidden`), true);
  check('scroll restored', await ev(`document.body.style.overflow`), '');
  check('order kept after closing', (await ev(state)).mine, 'Your order 2');

  // Team button
  await ev(click('[data-open="team"]')); await sleep(300);
  for (let i = 0; i < 4; i++) await ev(click('.tile[data-id="mokulele"] [data-step="1"]'));
  await ev(click('.tile[data-id="shoreline"] [data-step="1"]')); await ev(click('.tile[data-id="shoreline"] [data-step="1"]')); await sleep(100);
  s = await ev(state);
  check('team tab', s.tab, 'team');
  check('badges team, client', s.badges, [6, 2]);
  check('team tiles', s.tiles, { mokulele: 4, mokulua: 0, shoreline: 2, leahi: 0, kahana: 0, malie: 0 });
  check('minus disabled at zero', s.minusDisabled, ['mokulua', 'leahi', 'kahana', 'malie']);
  check('order list groups', s.groups, [['Team boxes, 6$480', ['Mokulele4', 'Shoreline Cascade2']], ['Client boxes, 2$240', ['Mālie2']]]);
  check('totals', [s.count, s.sum, s.pay, s.mine], ['8 boxes', '$720', 'Continue to payment, $720', 'Your order 8']);
  check('what line (team)', await ev(text('#co-what')), "Every Team box has a matted print of the photograph you pick and a Baker's Heart Double Box, twelve lace cookies in three flavors.");
  check('side column sits beside the prints', await ev(`(()=>{const a=document.querySelector('.co-main').getBoundingClientRect(),b=document.getElementById('co-side').getBoundingClientRect();return b.left>a.right-1 && Math.abs(b.top-a.top)<2})()`), true);
  check('phone bar hidden on desktop', await ev(`getComputedStyle(document.querySelector('.co-pbar')).display`), 'none');
  check('tiles 3 across', await ev(`new Set([...document.querySelectorAll('.tile')].slice(0,3).map(t=>Math.round(t.getBoundingClientRect().top))).size`), 1);
  check('pickup before spot', [await ev(text('#co-field')), await ev(`document.getElementById('co-cal').hidden`)], ['Pick a spot first', true]);
  await shot('bh-d2-window');

  // Steppers: add Kahana to the Team tab
  await ev(click('.tile[data-id="kahana"] [data-step="1"]')); await sleep(100);
  s = await ev(state);
  check('+ Kahana (team)', [s.tiles.kahana, s.badges, s.count, s.sum, s.mine], [1, [7, 2], '9 boxes', '$800', 'Your order 9']);
  check('new line flashes', await ev(`document.querySelector('[data-line="team-kahana"]').classList.contains('flash')`), true);
  check('Kahana line in print order', s.groups[0], ['Team boxes, 7$560', ['Mokulele4', 'Shoreline Cascade2', 'Kahana1']]);
  // Switch tabs and add to Client
  await ev(click('.co-tabs [data-box="client"]')); await sleep(100);
  await ev(click('.tile[data-id="mokulua"] [data-step="1"]')); await ev(click('.tile[data-id="mokulua"] [data-step="1"]')); await ev(click('.tile[data-id="mokulua"] [data-step="1"]')); await sleep(100);
  s = await ev(state);
  check('client + Mokulua x3', [s.tab, s.tiles.mokulua, s.badges, s.count, s.sum, s.pbar], ['client', 3, [7, 5], '12 boxes', '$1160', '12 boxes, $1160']);
  check('client group', s.groups[1], ['Client boxes, 5$600', ['Mokulua3', 'Mālie2']]);
  // Minus to zero removes the line
  await ev(click('.tile[data-id="malie"] [data-step="-1"]')); await ev(click('.tile[data-id="malie"] [data-step="-1"]')); await sleep(100);
  s = await ev(state);
  check('Mālie to zero', [s.tiles.malie, s.groups[1], s.sum], [0, ['Client boxes, 3$360', ['Mokulua3']], '$920']);
  check('one client box says box', await ev(`(()=>{window.__co.order.client={mokulua:1};document.querySelector('.co-tabs [data-box="client"]').click();return [...document.querySelectorAll('.co-gh')].map(g=>g.textContent)})()`), ['Team boxes, 7$560', 'Client box, 1$120']);

  // Pay checks
  await ev(click('#co-pay')); check('pay without spot', await ev(text('#co-msg')), 'Pick a pickup spot first.');

  // Kalihi calendar (ordering on 2026-10-15)
  check('today is the test date', await ev(`window.__co.state().today`), '2026-10-15');
  await ev(click('input[value="kalihi"]')); await sleep(100);
  check('Kalihi month and arrows', [await ev(calMonth), await ev(arrows)], ['November 2026', [true, false]]);
  check('Kalihi November open days', await ev(calOpen), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-30']);
  check('Kalihi note', await ev(text('#co-note')), "Kalihi pickups are weekdays, 8 am to 1 pm, through December 22, and we're closed Thanksgiving weekend. We need five business days to get your order ready, so the earliest you can pick is Monday, November 16.");
  await ev(click('#co-pay')); check('pay without date', await ev(text('#co-msg')), 'Pick a pickup date first.');
  await ev(click('#co-cal [data-mon="1"]')); await sleep(100);
  check('December arrows', [await ev(calMonth), await ev(arrows)], ['December 2026', [false, true]]);
  check('Kalihi December open days', await ev(calOpen), ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22']);
  await ev(click('#co-cal [data-day="2026-12-21"]')); await sleep(100);
  check('picked Dec 21', [await ev(text('#co-field')), await ev(`document.querySelector('[data-day="2026-12-21"]').getAttribute('aria-pressed')`)], ['Monday, December 21', 'true']);
  // Switch to Pearl City: Dec 21 isn't a Wednesday, so it clears
  await ev(click('input[value="pearl"]')); await sleep(100);
  check('Pearl City clears Dec 21', await ev(text('#co-field')), 'Pick a date');
  check('Pearl City November open days', [await ev(calMonth), await ev(calOpen)], ['November 2026', ['2026-11-18', '2026-11-25']]);
  check('Pearl City note', await ev(text('#co-note')), 'Pearl City pickups are on Wednesdays, 1:30 to 3 pm, through December 16. We need five business days to get your order ready, so the earliest you can pick is Wednesday, November 18.');
  await ev(click('#co-cal [data-mon="1"]')); await sleep(100);
  check('Pearl City December open days', await ev(calOpen), ['2026-12-02', '2026-12-09', '2026-12-16']);
  await ev(click('#co-cal [data-day="2026-12-09"]')); await sleep(100);
  // Switch back to Kalihi: Wednesday Dec 9 is open there too, so it stays
  await ev(click('input[value="kalihi"]')); await sleep(100);
  check('Kalihi keeps Dec 9', [await ev(text('#co-field')), await ev(calMonth)], ['Wednesday, December 9', 'December 2026']);
  await ev(click('#co-pay'));
  check('pay without the terms tick', await ev(text('#co-msg')), "Tick the box to confirm you've read the terms of sale.");
  check('test card note shows in test mode', await ev(text('.co-test')), 'Test checkout. Use card 4242 4242 4242 4242, any future date and any CVC.');
  // Payment pane: the checkout script (dev, sandbox) returns a session and Stripe's form mounts in the window
  await ev(click('#co-ack')); await ev(click('#co-pay'));
  let paneUp = false;
  for (let i = 0; i < 40 && !paneUp; i++) { await sleep(500); paneUp = await ev(`!document.getElementById('co-paying').hidden && !!document.querySelector('#co-stripe iframe')`); }
  check('payment pane opens with Stripe\'s form', paneUp, true);
  check('payment pane title and review', [await ev(text('#co-title')), await ev(`['Mokulele','Mokulua','Kalihi Union Church','Pickup Wednesday, December 9, 8 am to 1 pm','$680'].every(t=>document.getElementById('co-review').textContent.includes(t))`)], ['Payment', true]);
  check('only the payment pane shows while paying', await ev(`['co-build','co-paying','co-done','co-pbar'].map(id=>getComputedStyle(document.getElementById(id)).display)`), ['none', 'grid', 'none', 'none']);
  await shot('bh-d5-payment');
  await ev(click('#co-back')); await sleep(200);
  check('change the order goes back, order kept', [await ev(text('#co-title')), await ev(`['co-build','co-paying'].map(id=>getComputedStyle(document.getElementById(id)).display)`), (await ev(state)).count, await ev(`document.getElementById('co-stripe').innerHTML`)], ['Build your order', ['grid', 'none'], '8 boxes', '']);
  check('pay button reachable with the calendar open', await ev(`(()=>{const sc=document.getElementById('co-scroll');sc.scrollTop=sc.scrollHeight;const r=document.getElementById('co-pay').getBoundingClientRect();return r.bottom<=innerHeight && r.top>=0})()`), true);
  await shot('bh-d3-pickup');
  await ev(`document.getElementById('co-scroll').scrollTop=0`);

  // Clear the order
  await ev(click('#co-clear')); await sleep(100);
  s = await ev(state);
  check('cleared', [s.count, s.sum, s.pay, s.mine, s.badges, s.on], ['0 boxes', '$0', 'Continue to payment', 'Order a gift box', [0, 0], []]);
  check('empty message', await ev(text('#co-lines')), 'Nothing here yet. Add a photograph to start your order.');
  check('clear link hidden when empty', await ev(`document.getElementById('co-clear').hidden`), true);
  await ev(click('#co-pay')); check('pay with empty order', await ev(text('#co-msg')), 'Add at least one box first.');
  await shot('bh-d4-empty');

  // Escape closes; clicking the dim area closes
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(100);
  check('Escape closes', await ev(`document.getElementById('co').hidden`), true);
  await ev(click('.mine')); await sleep(100);
  check('toolbar button opens, keeps last tab', [await ev(`!document.getElementById('co').hidden`), (await ev(state)).tab], [true, 'client']);
  await ev(`document.querySelector('.co-dim').click()`); await sleep(100);
  check('dim area closes', await ev(`document.getElementById('co').hidden`), true);

  // Wall print opens with that print highlighted
  await ev(`document.querySelector('[data-pick="leahi"]').scrollIntoView()`);
  await ev(click('[data-pick="leahi"]')); await sleep(200);
  check('wall click opens, highlights Lēʻahi', [await ev(`!document.getElementById('co').hidden`), await ev(`document.querySelector('.tile[data-id="leahi"]').classList.contains('pulse')`)], [true, true]);
  await ev(click('.co-x'));
  await ev(`(()=>{const f=document.querySelector('[data-pick="kahana"] [role=button]');f.focus();f.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`); await sleep(200);
  check('Enter on a wall print opens', await ev(`document.querySelector('.tile[data-id="kahana"]').classList.contains('pulse') && !document.getElementById('co').hidden`), true);
  check('no horizontal overflow (desktop)', await ev(`document.documentElement.scrollWidth`), 1440);

  // The season: closed after Dec 15, and big orders only through Dec 1
  for (const [today, closedNow] of [['2026-12-16', true], ['2026-12-15', false]]) {
    await send('Page.navigate', { url: URL.replace('today=2026-10-15', 'today=' + today) }); await sleep(1800);
    check(`order buttons on ${today}`, await ev(`[...document.querySelectorAll('.btn-order')].map(b=>[b.disabled, b.firstChild.nodeValue.trim()])`),
      closedNow ? [[true, 'Ordering is closed for this season'], [true, 'Ordering is closed for this season']] : [[false, 'Order the Team box'], [false, 'Order the Client box']]);
    check(`window opens on ${today}`, await ev(`(()=>{document.querySelector('[data-pick="malie"]').click();return !document.getElementById('co').hidden})()`), !closedNow);
  }
  await send('Page.navigate', { url: URL.replace('today=2026-10-15', 'today=2026-12-02') }); await sleep(1800);
  await ev(click('[data-open="team"]'));
  await ev(`(()=>{const b=document.querySelector('.tile[data-id="malie"] [data-step="1"]');for(let i=0;i<26;i++)b.click();})()`);
  await ev(click('input[value="kalihi"]')); await sleep(100);
  await ev(click('#co-cal [data-day="2026-12-10"]')); await ev(click('#co-ack')); await ev(click('#co-pay'));
  check('26 boxes after Dec 1', await ev(text('#co-msg')), 'Orders of more than 25 boxes could be placed through December 1. You can still order up to 25.');
  b.close();
}

// ---------------- phone ----------------
{
  const b = await browser(390);
  const { ev, shot } = b;
  check('phone: hamburger shown, desktop menu hidden', await ev(`[getComputedStyle(document.querySelector('.tah-nav')).display, getComputedStyle(document.querySelector('.tah-menu')).display]`), ['none', 'block']);
  await ev(click('.tah-menu summary')); await sleep(150);
  check('phone menu opens with every link', await ev(`document.querySelectorAll('.tah-menu-list a').length`), 15);
  await shot('bh-p1-menu');
  await ev(click('.tah-menu summary'));
  check('phone toolbar fits', await ev(`(()=>{const r=document.querySelector('.mine').getBoundingClientRect();return r.right<=390})()`), true);
  await shot('bh-p2-top');
  check('phone: no + touches an Order button or its outline', await ev(`(()=>{const hit=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;return [...document.querySelectorAll('#boxes .box')].filter(c=>{const p=c.querySelector('.plus');return getComputedStyle(p).display!=='none'&&hit(p.getBoundingClientRect(),c.querySelector('.trace-base').getBoundingClientRect())}).length})()`), 0);
  check('phone: one + on the seam above the wall', await ev(`[...document.querySelectorAll('#boxes .box .plus')].map(p=>getComputedStyle(p).display)`), ['none', 'grid']);
  await ev(click('[data-open="team"]')); await sleep(300);
  await ev(`(()=>{const add=(id,n)=>{const b=document.querySelector('.tile[data-id="'+id+'"] [data-step="1"]');for(let i=0;i<n;i++)b.click();};add('mokulele',4);add('shoreline',2);document.querySelector('.co-tabs [data-box="client"]').click();add('malie',2);document.querySelector('.co-tabs [data-box="team"]').click();})()`);
  check('phone: window fills the screen', await ev(`(()=>{const r=document.querySelector('.co-panel').getBoundingClientRect();return [r.left,r.width,Math.round(r.height)]})()`), [0, 390, 844]);
  check('phone: tiles 2 across', await ev(`new Set([...document.querySelectorAll('.tile')].slice(0,2).map(t=>Math.round(t.getBoundingClientRect().top))).size`), 1);
  check('phone: order list under the prints', await ev(`document.getElementById('co-side').getBoundingClientRect().top > document.querySelector('.co-grid').getBoundingClientRect().bottom`), true);
  check('phone: bottom bar', [await ev(`getComputedStyle(document.querySelector('.co-pbar')).display`), await ev(text('#co-pb'))], ['flex', '8 boxes, $720']);
  await shot('bh-p3-window');
  await ev(click('#co-pb-go')); await sleep(900);
  check('phone: jump lands on the order list', await ev(`Math.round(document.getElementById('co-side').getBoundingClientRect().top)`) < 140, true);
  await ev(click('input[value="pearl"]')); await sleep(100);
  await shot('bh-p4-side');
  check('phone: no sideways scroll in window', await ev(`(()=>{const s=document.getElementById('co-scroll');return s.scrollWidth<=s.clientWidth})()`), true);
  await ev(click('.co-x'));
  check('phone: page has no sideways scroll', await ev(`document.documentElement.scrollWidth`), 390);
  b.close();
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
