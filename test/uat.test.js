// UAT: เปิดหน้าเว็บจริงใน jsdom แล้วเดินทุก flow — รันด้วย npm test
// D1–D6 คือ defect ที่พบตอนตรวจรับ แต่ละเทสต้องล้มกับโค้ดก่อนแก้
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto, createHash } = require('crypto');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'paperless-workflow.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIGN_MS = 1600; // doSign รอ 1.4 วินาที
const AI_MS = 1700;   // แผง AI โผล่หลัง 1.5 วินาที

async function load() {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
      if (!w.TextEncoder) w.TextEncoder = TextEncoder;
      w.Element.prototype.scrollIntoView = () => {};
      w.scrollTo = () => {};
    },
  });
  const w = dom.window;
  const page = { w, $: (id) => w.document.getElementById(id), ev: (code) => w.eval(code) };
  if (page.ev('typeof seedHashes') !== 'undefined') await page.ev('seedHashes');
  return page;
}

async function signForm(p, { tpl = 'purchase', title = 'ทดสอบ UAT', amount = '12000', detail = 'รายละเอียด' } = {}) {
  p.w.pickTpl(tpl);
  p.$('f-title').value = title;
  p.$('f-amount').value = amount;
  p.$('f-detail').value = detail;
  p.w.doSign();
  await sleep(SIGN_MS);
}

async function submitNew(p, opts) {
  await signForm(p, opts);
  p.w.submitDoc();
  return p.ev('documents[0]');
}

const doc = (p, titlePart) => p.ev('documents').find((d) => d.title.includes(titlePart));
const timeline = (p) => [...p.w.document.querySelectorAll('#page-detail .tl-dot')].map((e) => e.textContent.trim());

test('D1: เอกสารที่ส่งใหม่ขึ้นในกล่องรออนุมัติ', async () => {
  const p = await load();
  const d = await submitNew(p, { title: 'จัดซื้อโปรเจกเตอร์', amount: '120000' });
  p.w.switchRole('approver');
  assert.match(p.$('inboxList').textContent, new RegExp(d.id));
});

test('D2: fingerprint คำนวณจากเนื้อหาจริง และได้ค่าเดิมทุกครั้งที่โหลด', async () => {
  const a = await load();
  const b = await load();
  const d1 = a.ev('documents').find((d) => d.id === 'DOC-101');
  const d2 = b.ev('documents').find((d) => d.id === 'DOC-101');
  assert.equal(d1.hash, d2.hash);
  const expected = createHash('sha256').update(a.ev('signedContent')(d1)).digest('hex');
  assert.equal(d1.hash, expected);
});

test('D2: ลงนามแล้วแก้ฟอร์มไม่ได้ และเอกสารที่ส่งคือเนื้อหาที่ลงนาม', async () => {
  const p = await load();
  await signForm(p, { title: 'ชื่อตอนลงนาม', amount: '30000' });
  assert.equal(p.$('f-title').disabled, true);
  assert.equal(p.$('f-amount').disabled, true);
  p.$('f-title').value = 'แก้หลังลงนาม';
  p.$('f-amount').value = '-900000';
  p.w.submitDoc();
  const d = p.ev('documents[0]');
  assert.equal(d.title, 'ชื่อตอนลงนาม');
  assert.equal(d.amount, 30000);
});

test('D2: ตรวจลายมือชื่อจับได้เมื่อเนื้อหาถูกแก้หลังลงนาม', async () => {
  const p = await load();
  const d = await submitNew(p, { title: 'ตรวจลายมือชื่อ', amount: '20000' });
  p.w.openDoc(d.id, 'mydocs');
  assert.equal(await p.w.verifySig(d.id), true);
  d.amount = 2000000;
  assert.equal(await p.w.verifySig(d.id), false);
  assert.match(p.$('verifyZone').textContent, /ถูกแก้หลังลงนาม/);
});

test('D3: HTML ในชื่อเรื่องแสดงเป็นข้อความ ไม่ถูกรัน', async () => {
  const p = await load();
  const evil = '<img src=x onerror="window.__xss=1">ประชุม';
  const d = await submitNew(p, { tpl: 'memo', title: evil, amount: '' });
  const list = p.$('myDocsList');
  assert.equal(list.querySelector('img'), null);
  assert.match(list.textContent, /<img src=x/);
  p.w.openDoc(d.id, 'mydocs');
  p.w.showPage('audit');
  assert.equal(p.w.document.querySelector('#page-detail img, #auditBody img, #auditFilter img'), null);
  assert.equal(p.w.__xss, undefined);
});

test('D4: วงเงินติดลบหรือใบจัดซื้อวงเงิน 0 ลงนามไม่ได้', async () => {
  const p = await load();
  const before = p.ev('documents.length');
  await signForm(p, { amount: '-900000' });
  assert.equal(p.ev('signState'), null);
  assert.equal(p.$('f-title').disabled, false);
  p.w.resetCreate();
  await signForm(p, { amount: '0' });
  assert.equal(p.ev('signState'), null);
  p.w.resetCreate();
  await signForm(p, { tpl: 'memo', amount: '' }); // บันทึกข้อความไม่มีวงเงินได้
  assert.notEqual(p.ev('signState'), null);
  assert.equal(p.ev('documents.length'), before);
});

test('D5: STP เฉพาะใบจัดซื้อ 1–49,999 บาท ใบลาและบันทึกต้องให้คนอนุมัติ', async () => {
  const p = await load();
  p.w.switchRole('approver');
  const buttons = async (d) => {
    p.w.openDoc(d.id, 'inbox');
    await sleep(AI_MS);
    return [...p.w.document.querySelectorAll('#aiZone button')].map((b) => b.textContent);
  };
  assert.ok((await buttons(doc(p, 'หมึกพิมพ์'))).some((t) => t.includes('STP')));
  for (const title of ['ใบลาพักผ่อน', 'อบรมพัฒนาบุคลากร', 'เดินทางไปราชการ']) {
    const bs = await buttons(doc(p, title));
    assert.ok(!bs.some((t) => t.includes('STP')), `${title} ไม่ควรได้ STP`);
    assert.ok(bs.some((t) => t.includes('อนุมัติ')) && bs.some((t) => t.includes('ตีกลับ')), `${title} ต้องมีปุ่มอนุมัติ/ตีกลับ`);
  }
});

test('D6: ตีกลับแล้ว timeline แสดง ✕ ที่ขั้นปัจจุบัน', async () => {
  const p = await load();
  p.w.switchRole('approver');
  const d = doc(p, 'คอมพิวเตอร์ 20');
  p.w.openDoc(d.id, 'inbox');
  await sleep(AI_MS);
  p.w.rejectDoc(d.id);
  const dots = timeline(p);
  assert.ok(dots.includes('✕'), `timeline: ${dots.join(' ')}`);
  assert.ok(!dots.every((x) => x === '✓'));
});

test('เดิม: อนุมัติด้วยคนแล้ว timeline ครบทุกขั้น', async () => {
  const p = await load();
  p.w.switchRole('approver');
  const d = doc(p, 'ปรับอากาศ');
  p.w.openDoc(d.id, 'inbox');
  await sleep(AI_MS);
  p.w.approveDoc(d.id);
  assert.equal(d.state, 'approved');
  assert.ok(timeline(p).every((x) => x === '✓'));
});

test('เดิม: กล่องรออนุมัติเรียง ด่วน → ปกติ → ไม่เร่งด่วน', async () => {
  const p = await load();
  p.w.switchRole('approver');
  const rank = { ด่วน: 0, ปกติ: 1, ไม่เร่งด่วน: 2 };
  const prios = [...p.w.document.querySelectorAll('#inboxList .doc-row')].map((r) => {
    const b = [...r.querySelectorAll('.badge')].find((x) => x.textContent in rank);
    return rank[b.textContent];
  });
  assert.deepEqual(prios, [...prios].sort((a, b) => a - b));
});

test('เดิม: กรอง audit trail ตามเลขเอกสารได้เฉพาะของเอกสารนั้น', async () => {
  const p = await load();
  p.w.showPage('audit');
  p.$('auditFilter').value = 'DOC-102';
  p.w.renderAudit();
  const rows = [...p.w.document.querySelectorAll('#auditBody tr')];
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.textContent.includes('DOC-102')));
});
