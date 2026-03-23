const express = require('express');
const fetch = require('node-fetch');
 
const app = express();
app.use(express.json({ limit: '10mb' }));
 
const queue = [];
let isProcessing = false;
const jobStore = {};
 
function enqueue(job) {
  queue.push(job);
  console.log(`Job queued for ${job.email}. Queue length: ${queue.length}`);
  processNext();
}
 
async function processNext() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const job = queue.shift();
  console.log(`Processing job for ${job.email}. Remaining: ${queue.length}`);
  try {
    await generateAndSend(job);
    console.log(`✓ Completed job for ${job.email}`);
  } catch(e) {
    console.error(`✗ Job failed for ${job.email}:`, e.message);
  }
  isProcessing = false;
  if (queue.length > 0) processNext();
}
 
app.get('/', (req, res) => res.json({ status: 'RevAnalysis worker running', queueLength: queue.length, isProcessing }));
app.get('/status', (req, res) => res.json({ queueLength: queue.length, isProcessing, jobs: queue.map(j => ({ email: j.email, bizName: j.bizName })) }));
 
app.post('/resend', (req, res) => {
  const { email, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const job = jobStore[email];
  if (!job) return res.status(404).json({ error: `No job found for ${email}` });
  if (job.completedHtml) {
    sendEmail({ to: email, bizName: job.bizName, reportHtml: job.completedHtml, pdfBase64: job.completedPdf || null, pdfFilename: `${(job.bizName||'Report').replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf` })
      .then(() => console.log(`✓ Instant resend complete for ${email}`))
      .catch(e => console.error(`Resend email failed:`, e.message));
    return res.status(200).json({ queued: false, instant: true, email, message: 'Report resent instantly from cache' });
  }
  enqueue({ ...job });
  res.status(200).json({ queued: true, instant: false, email, message: 'Report queued for regeneration' });
});
 
app.post('/cancel', (req, res) => {
  const { email, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const index = queue.findIndex(j => j.email === email);
  if (index === -1) {
    if (isProcessing && jobStore[email] && !jobStore[email].completedAt) return res.status(409).json({ error: 'Job is currently processing and cannot be cancelled' });
    return res.status(404).json({ error: `No queued job found for ${email}` });
  }
  queue.splice(index, 1);
  delete jobStore[email];
  res.status(200).json({ cancelled: true, email, remainingQueue: queue.length });
});
 
app.get('/jobs', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const jobs = Object.values(jobStore).map(j => ({ email: j.email, bizName: j.bizName, industry: j.industry, savedAt: j.savedAt, completedAt: j.completedAt || null }));
  res.json({ count: jobs.length, jobs });
});
 
app.post('/generate', (req, res) => {
  const { email, bizName, industry, calcData, answers } = req.body;
  if (!email || !calcData) return res.status(400).json({ error: 'Missing required fields' });
  jobStore[email] = { email, bizName, industry, calcData, answers, savedAt: new Date().toISOString() };
  enqueue({ email, bizName, industry, calcData, answers });
  const position = queue.length;
  const estimatedMinutes = isProcessing ? Math.round((position + 1) * 6) : Math.round(position * 6);
  res.status(200).json({ queued: true, position, estimatedMinutes });
});
 
// ══════════════════════════════════════════════════
//  MAIN GENERATION
// ══════════════════════════════════════════════════
async function generateAndSend({ email, bizName, industry, calcData, answers }) {
  const SECTION_KEYS = ['EXEC','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','PRIORITY','PLAN','ROI'];
  const sections = {};
  const ctx = buildServerContext(bizName, industry, calcData, answers);
 
  console.log(`Starting generation for ${bizName} (${email})`);
 
  for (let i = 0; i < SECTION_KEYS.length; i++) {
    const key = SECTION_KEYS[i];
    console.log(`  Section ${i+1}/12: ${key}`);
    let attempt = 0;
    while (attempt < 3) {
      try {
        const prompt = buildSectionPrompt(key, ctx);
        const result = await callAnthropic(prompt);
        const parsed = parseSecs(result);
        const content = parsed[key] || Object.values(parsed)[0];
        if (!content) throw new Error('Empty response from AI');
        sections[key] = content;
        console.log(`  ✓ ${key} done`);
        break;
      } catch(e) {
        attempt++;
        console.warn(`  ✗ ${key} attempt ${attempt}/3 failed: ${e.message}`);
        if (attempt < 3) { console.log(`  Waiting 30s...`); await sleep(30000); }
        else throw new Error(`Section ${key} failed after 3 attempts: ${e.message}`);
      }
    }
    if (i < SECTION_KEYS.length - 1) await sleep(22000);
  }
 
  console.log(`All 12 sections done. Generating PDF...`);
  const reportHtml = buildEmailHtml(bizName, industry, calcData, sections);
 
  let pdfBase64 = null;
  try {
    pdfBase64 = await generatePDF(reportHtml);
    console.log('PDF generated');
  } catch(e) {
    console.warn('PDF failed, sending without attachment:', e.message);
  }
 
  await sendEmail({ to: email, bizName, reportHtml, pdfBase64, pdfFilename: `${(bizName||'Report').replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf` });
  jobStore[email].completedHtml = reportHtml;
  jobStore[email].completedPdf = pdfBase64;
  jobStore[email].completedAt = new Date().toISOString();
  console.log(`✓ Email sent to ${email}`);
}
 
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
// ══════════════════════════════════════════════════
//  SVG CHART HELPERS
//  Pure SVG strings — no JavaScript required.
//  PDFShift and all email clients render these perfectly.
// ══════════════════════════════════════════════════
 
function svgBarChart(cats) {
  // Horizontal bar chart — opportunity by category
  const maxAmt = Math.max(...cats.map(c => c.amt), 1);
  const COLORS = { h: '#dc2626', m: '#d97706', l: '#16a34a' };
  const rowH = 44;
  const labelW = 190;
  const barZone = 370;
  const height = cats.length * rowH + 40;
  const width = 620;
 
  const rows = cats.map((cat, i) => {
    const barW = Math.max(4, Math.round((cat.amt / maxAmt) * barZone));
    const y = 20 + i * rowH;
    const color = COLORS[cat.sev] || '#2557a7';
    const label = cat.n.length > 28 ? cat.n.substring(0, 27) + '…' : cat.n;
    const amtLabel = '~$' + cat.amt.toLocaleString();
    return `
      <text x="${labelW - 8}" y="${y + 16}" font-family="Arial,sans-serif" font-size="11.5"
        fill="#374151" text-anchor="end" dominant-baseline="middle">${label}</text>
      <rect x="${labelW}" y="${y + 4}" width="${barW}" height="22" rx="4" fill="${color}" opacity="0.85"/>
      <text x="${labelW + barW + 7}" y="${y + 16}" font-family="Arial,sans-serif" font-size="11"
        font-weight="bold" fill="${color}" dominant-baseline="middle">${amtLabel}</text>`;
  }).join('');
 
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
    viewBox="0 0 ${width} ${height}" style="display:block;max-width:100%;margin:0 auto;">
    <rect width="${width}" height="${height}" rx="4" fill="#f9fafb"/>
    ${rows}
  </svg>`;
}
 
function svgLineChart(total) {
  // 3-scenario recovery line chart
  const c15 = Math.round(total * 0.15);
  const c22 = Math.round(total * 0.22);
  const c32 = Math.round(total * 0.32);
 
  const datasets = [
    { label: 'Conservative (15%)', color: '#d97706', values: [0, Math.round(c15 * 0.15), Math.round(c15 * 0.50), c15] },
    { label: 'Realistic (22%)',    color: '#2557a7', values: [0, Math.round(c22 * 0.20), Math.round(c22 * 0.55), c22] },
    { label: 'Optimistic (32%)',   color: '#16a34a', values: [0, Math.round(c32 * 0.25), Math.round(c32 * 0.60), c32] },
  ];
 
  const W = 580, H = 220;
  const padL = 72, padR = 20, padT = 20, padB = 56;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const maxVal = c32 * 1.08;
  const labels = ['Start', 'Month 1', 'Month 2', 'Month 3'];
 
  const toX = i => padL + (i / 3) * chartW;
  const toY = v => padT + chartH - (v / maxVal) * chartH;
 
  // Gridlines
  const grids = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = toY(f * maxVal);
    const v = Math.round(f * maxVal);
    const vLabel = v >= 1000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 4}" font-family="Arial,sans-serif" font-size="9.5" fill="#9ca3af" text-anchor="end">${vLabel}</text>`;
  }).join('');
 
  // X labels
  const xLabels = labels.map((l, i) => `<text x="${toX(i)}" y="${H - padB + 18}" font-family="Arial,sans-serif" font-size="10.5" fill="#6b7280" text-anchor="middle">${l}</text>`).join('');
 
  // Lines + dots
  const lines = datasets.map(ds => {
    const pts = ds.values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
    const dots = ds.values.map((v, i) => `<circle cx="${toX(i)}" cy="${toY(v)}" r="4" fill="${ds.color}" stroke="white" stroke-width="1.5"/>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${ds.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>
      ${dots}`;
  }).join('');
 
  // Legend
  const legend = datasets.map((ds, i) => {
    const lx = padL + i * 178;
    return `<rect x="${lx}" y="${H - 20}" width="12" height="3" rx="2" fill="${ds.color}"/>
      <text x="${lx + 17}" y="${H - 12}" font-family="Arial,sans-serif" font-size="10" fill="#4b5563">${ds.label}</text>`;
  }).join('');
 
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
    viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;">
    <rect width="${W}" height="${H}" rx="4" fill="#f9fafb"/>
    ${grids}
    <line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="#d1d5db" stroke-width="1.5"/>
    ${xLabels}
    ${lines}
    ${legend}
  </svg>`;
}
 
function svgScoreChart(sc) {
  // Score bar chart — 7 categories vs benchmark
  const cats = [
    { label: 'Conversion',  score: sc.conversion,  bench: 65 },
    { label: 'Marketing',   score: sc.marketing,   bench: 60 },
    { label: 'Retention',   score: sc.retention,   bench: 60 },
    { label: 'Referrals',   score: sc.referrals,   bench: 55 },
    { label: 'Pricing',     score: sc.pricing,     bench: 60 },
    { label: 'Reviews',     score: sc.reviews,     bench: 55 },
    { label: 'Operations',  score: sc.operations,  bench: 65 },
  ];
 
  const W = 580, rowH = 34, padL = 90, padR = 20, padT = 16, barW = W - padL - padR;
  const H = padT + cats.length * rowH + 28;
 
  const rows = cats.map((cat, i) => {
    const y = padT + i * rowH;
    const yourW = Math.round((cat.score / 100) * barW);
    const benchX = padL + Math.round((cat.bench / 100) * barW);
    const color = cat.score >= cat.bench ? '#16a34a' : cat.score >= cat.bench * 0.7 ? '#d97706' : '#dc2626';
    return `
      <text x="${padL - 8}" y="${y + 14}" font-family="Arial,sans-serif" font-size="11" fill="#374151" text-anchor="end">${cat.label}</text>
      <rect x="${padL}" y="${y + 4}" width="${barW}" height="16" rx="3" fill="#e5e7eb"/>
      <rect x="${padL}" y="${y + 4}" width="${yourW}" height="16" rx="3" fill="${color}" opacity="0.8"/>
      <line x1="${benchX}" y1="${y}" x2="${benchX}" y2="${y + 24}" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="3,2"/>
      <text x="${padL + yourW + 5}" y="${y + 15}" font-family="Arial,sans-serif" font-size="10" fill="${color}" font-weight="bold">${cat.score}</text>`;
  }).join('');
 
  const benchLegendX = padL + Math.round(0.60 * barW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
    viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;">
    <rect width="${W}" height="${H}" rx="4" fill="#f9fafb"/>
    ${rows}
    <text x="${benchLegendX}" y="${H - 8}" font-family="Arial,sans-serif" font-size="9.5" fill="#6b7280" text-anchor="middle">--- Industry benchmark</text>
  </svg>`;
}
 
// ══════════════════════════════════════════════════
//  EMAIL/PDF HTML BUILDER
//  Full inline CSS so every class the AI generates
//  renders correctly in PDFShift and email clients.
// ══════════════════════════════════════════════════
function buildEmailHtml(bizName, industry, calcData, sections) {
  const L = calcData;
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const rec22 = Math.round(L.total * 0.22);
 
  const sectionKeys = ['EXEC','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','PRIORITY','PLAN','ROI'];
  const sectionTitles = {
    EXEC:'Executive Summary', CONV:'Lead Conversion & Sales', DEAD:'Dead & Dormant Leads',
    MKTG:'Marketing Efficiency', RET:'Customer Retention', REF:'Referral Generation',
    PRICE:'Pricing Power', REV:'Reviews & Visibility', OPS:'Operations & Quality',
    PRIORITY:'Priority Action Matrix', PLAN:'90-Day Recovery Roadmap', ROI:'Revenue Recovery Projection'
  };
  const catKeyMap = {
    CONV:'conversion', DEAD:'dormant', MKTG:'Marketing',
    RET:'retention', REF:'Referral', PRICE:'Pricing', REV:'Reviews', OPS:'Operations'
  };
 
  // ── CSS (covers every class the AI prompts generate) ──
  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Helvetica, Arial, sans-serif; background: #eef0f5; color: #111827; font-size: 14px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
    .wrap { max-width: 800px; margin: 0 auto; padding: 32px 16px; }
 
    /* ── Cover ── */
    .cover { background: #0f1f3d; border-radius: 12px; padding: 40px; margin-bottom: 24px; color: white; }
    .cover-tag { font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: #6ea8fe; margin-bottom: 12px; }
    .cover-h { font-family: Georgia, serif; font-size: 34px; font-weight: 800; line-height: 1.1; margin-bottom: 12px; }
    .cover-h .red { color: #ff6b6b; }
    .cover-range { font-size: 14px; color: rgba(255,255,255,.6); margin-bottom: 4px; }
    .cover-meta { font-size: 13px; color: rgba(255,255,255,.4); margin-bottom: 16px; }
    .cover-note { background: rgba(255,255,255,.08); border-radius: 8px; padding: 12px 16px; font-size: 12px; color: rgba(255,255,255,.5); }
 
    /* ── KPI strip ── */
    .kpi-strip { background: white; border-radius: 10px; padding: 20px 24px; margin-bottom: 24px; border: 1px solid #e4e8f0; }
    .kpi-row { display: table; width: 100%; }
    .kpi-cell { display: table-cell; text-align: center; padding: 4px 8px; border-right: 1px solid #e4e8f0; }
    .kpi-cell:last-child { border-right: none; }
    .kpi-val { font-family: Georgia, serif; font-size: 22px; font-weight: 700; line-height: 1.2; margin-bottom: 4px; }
    .kpi-lbl { font-size: 10px; color: #8d97aa; text-transform: uppercase; letter-spacing: .08em; }
 
    /* ── Chart section ── */
    .chart-section { background: white; border-radius: 10px; border: 1px solid #e4e8f0; margin-bottom: 20px; overflow: hidden; }
    .chart-section-head { background: #f8f9fc; padding: 14px 24px; border-bottom: 1px solid #e4e8f0; display: flex; align-items: center; gap: 12px; }
    .sec-num { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; background: #0f1f3d; color: #6ea8fe; font-size: 11px; font-weight: 700; border-radius: 6px; flex-shrink: 0; }
    .sec-title { font-family: Georgia, serif; font-size: 14px; font-weight: 700; color: #0f1f3d; }
    .chart-body { padding: 24px; }
    .chart-label { font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #8d97aa; margin-bottom: 12px; }
    .chart-row { display: table; width: 100%; border-collapse: separate; border-spacing: 12px; }
    .chart-cell { display: table-cell; width: 50%; vertical-align: top; }
    .chart-wrap { background: #f9fafb; border: 1px solid #e4e8f0; border-radius: 8px; padding: 14px; margin-bottom: 16px; }
 
    /* ── Report sections ── */
    .rsec { background: white; border: 1px solid #e4e8f0; border-radius: 10px; margin-bottom: 20px; overflow: hidden; }
    .rsec-head { background: #f8f9fc; padding: 14px 24px; border-bottom: 1px solid #e4e8f0; display: flex; align-items: center; justify-content: space-between; }
    .rsec-left { display: flex; align-items: center; gap: 12px; }
    .rsec-title { font-family: Georgia, serif; font-size: 14px; font-weight: 700; color: #0f1f3d; }
    .rsec-amt { font-family: Georgia, serif; font-size: 14px; font-weight: 700; color: #dc2626; white-space: nowrap; }
    .rsec-body { padding: 24px; }
 
    /* ── Rich content classes (AI generates these) ── */
    p { margin-bottom: 12px; color: #374151; font-size: 14px; line-height: 1.75; }
    p:last-child { margin-bottom: 0; }
    strong { font-weight: 600; color: #111827; }
    h4 { font-family: Georgia, serif; font-size: 15px; font-weight: 700; color: #0f1f3d; margin: 20px 0 8px; }
    h5 { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #2557a7; margin-bottom: 10px; }
 
    ul { margin: 8px 0 14px; padding: 0; list-style: none; }
    ul li { display: flex; gap: 8px; margin-bottom: 8px; font-size: 14px; color: #5a6478; line-height: 1.6; }
    ul li::before { content: '→'; color: #3b6fd4; font-weight: 600; flex-shrink: 0; }
 
    ol { margin: 8px 0 14px; padding: 0; list-style: none; counter-reset: steps; }
    ol li { display: flex; gap: 12px; margin-bottom: 10px; font-size: 14px; color: #5a6478; line-height: 1.6; counter-increment: steps; }
    ol li::before { content: counter(steps); display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 50%; background: #0f1f3d; color: #6ea8fe; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
 
    /* Script boxes */
    .script { background: #0f1f3d; border-radius: 8px; padding: 18px 20px; margin: 14px 0; }
    .slabel { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #93c5fd; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.12); padding-bottom: 8px; }
    .script p { color: #e2e8f0 !important; font-size: 13px; font-style: italic; line-height: 1.75; margin-bottom: 6px; }
    .script p:last-child { margin-bottom: 0; }
    .script strong { color: #ffffff !important; }
 
    /* Action box */
    .action-box { background: #f8f9fc; border: 1px solid #e4e8f0; border-left: 4px solid #2557a7; border-radius: 0 8px 8px 0; padding: 18px 20px; margin: 14px 0; }
 
    /* Stat callout */
    .stat-call { background: #eef3fd; border-left: 4px solid #2557a7; border-radius: 0 8px 8px 0; padding: 12px 16px; margin: 14px 0; font-size: 13px; color: #1e3a5f; font-weight: 500; line-height: 1.6; }
 
    /* Disclaimer */
    .disclaimer { background: #f3f4f6; border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 12px; color: #6b7280; font-style: italic; line-height: 1.5; }
 
    /* blockquote */
    blockquote { background: #0f1f3d; border-radius: 8px; padding: 16px 20px; margin: 14px 0; color: rgba(255,255,255,.85); font-size: 13px; font-style: italic; line-height: 1.75; }
 
    /* Tables */
    table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
    th { background: #0f1f3d; color: #6ea8fe; padding: 10px 14px; text-align: left; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
    td { padding: 10px 14px; border-bottom: 1px solid #e4e8f0; color: #5a6478; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #f9fafb; }
 
    /* Plan grid — force single column in email (safer) */
    .pgrid { display: block; }
    .pcard { background: #f8f9fc; border: 1px solid #e4e8f0; border-radius: 8px; padding: 18px 20px; margin-bottom: 16px; }
    .ptag { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #2557a7; margin-bottom: 6px; }
    .ptitle { font-size: 14px; font-weight: 700; color: #0f1f3d; margin-bottom: 12px; }
    .ptask { display: flex; gap: 8px; margin-bottom: 8px; font-size: 13px; color: #5a6478; line-height: 1.5; align-items: flex-start; }
    .ptask::before { content: '→'; color: #3b6fd4; flex-shrink: 0; font-weight: 600; margin-top: 1px; }
    .pmile { background: #0f1f3d; border-radius: 6px; padding: 10px 14px; margin-top: 12px; font-size: 12px; color: #6ea8fe; font-weight: 500; line-height: 1.5; }
 
    /* Footer */
    .footer { background: #0f1f3d; border-radius: 12px; padding: 32px; text-align: center; margin-top: 24px; }
    .footer h3 { font-family: Georgia, serif; font-size: 20px; font-weight: 700; color: white; margin-bottom: 8px; }
    .footer p { font-size: 13px; color: rgba(255,255,255,.5); margin-bottom: 4px; }
  `;
 
  // ── Chart section (SVG — renders in PDFShift and all email clients) ──
  const chartSection = `
    <div class="chart-section">
      <div class="chart-section-head">
        <div class="sec-num">00</div>
        <div class="sec-title">Performance Dashboard — Visual Overview</div>
      </div>
      <div class="chart-body">
        <div class="chart-wrap">
          <div class="chart-label">Estimated revenue opportunity by category</div>
          ${svgBarChart(L.cats)}
        </div>
        <div class="chart-wrap">
          <div class="chart-label">Your performance score vs industry benchmark</div>
          ${svgScoreChart(L.sc)}
        </div>
        <div class="chart-wrap">
          <div class="chart-label">Conservative 90-day recovery projection</div>
          ${svgLineChart(L.total)}
        </div>
      </div>
    </div>`;
 
  // ── Report sections ──
  let sectionsHtml = '';
  sectionKeys.forEach((k, i) => {
    if (!sections[k]) return;
    const catKey = catKeyMap[k];
    const catMatch = catKey ? L.cats.find(c => c.n.includes(catKey)) : null;
    sectionsHtml += `
      <div class="rsec">
        <div class="rsec-head">
          <div class="rsec-left">
            <div class="sec-num">${String(i + 1).padStart(2, '0')}</div>
            <div class="rsec-title">${sectionTitles[k]}</div>
          </div>
          ${catMatch ? `<div class="rsec-amt">~$${catMatch.amt.toLocaleString()}/yr</div>` : ''}
        </div>
        <div class="rsec-body">${sections[k]}</div>
      </div>`;
  });
 
  // ── Disclaimer ──
  const legalHtml = `
    <div style="background:#f8f9fc;border:1px solid #e4e8f0;border-radius:10px;padding:24px 28px;margin-bottom:20px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8d97aa;margin-bottom:14px;">Important Notices & Disclaimers</div>
      <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:10px;"><strong style="color:#0f1f3d;">No Refund Policy:</strong> This report is a personalised, AI-generated diagnostic document. As it is delivered digitally and immediately upon generation, all sales are final.</p>
      <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:10px;"><strong style="color:#0f1f3d;">Not Professional Advice:</strong> Content is for informational and educational purposes only. Consult qualified professionals before making significant business decisions.</p>
      <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:10px;"><strong style="color:#0f1f3d;">Estimates Only:</strong> All revenue figures are based on the ranges you self-reported. They are directional estimates, not guarantees or verified financial assessments.</p>
      <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:0;"><strong style="color:#0f1f3d;">Data & Privacy:</strong> Information provided during this diagnostic is used solely to generate your personalised report and will not be sold to third parties.</p>
    </div>`;
 
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>RevAnalysis Report — ${bizName}</title>
  <style>${css}</style>
</head>
<body>
<div class="wrap">
 
  <!-- Cover -->
  <div class="cover">
    <div class="cover-tag">Confidential · Revenue Recovery Report</div>
    <div class="cover-h">Estimated Revenue Opportunity:<br><span class="red">~$${L.total.toLocaleString()}</span></div>
    <div class="cover-range">Conservative range: $${L.totalLo.toLocaleString()} – $${L.totalHi.toLocaleString()}</div>
    <div class="cover-meta">${bizName} · ${industry} · ${date}</div>
    <div class="cover-note">These are conservative estimates based on diagnostic ranges you provided. A PDF copy of this report is attached.</div>
  </div>
 
  <!-- KPI strip -->
  <div class="kpi-strip">
    <div class="kpi-row">
      <div class="kpi-cell">
        <div class="kpi-val" style="color:#dc2626;">~$${L.total.toLocaleString()}</div>
        <div class="kpi-lbl">Est. annual opportunity</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val" style="color:#6ea8fe;">~$${L.cats[0].amt.toLocaleString()}</div>
        <div class="kpi-lbl">Biggest opportunity</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val" style="color:#16a34a;">~$${rec22.toLocaleString()}</div>
        <div class="kpi-lbl">Realistic 90-day target</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-val" style="color:#6ea8fe;">${Math.round(rec22 / 297)}x</div>
        <div class="kpi-lbl">Est. report ROI</div>
      </div>
    </div>
  </div>
 
  <!-- SVG Charts (no JavaScript — PDFShift safe) -->
  ${chartSection}
 
  <!-- AI-generated sections -->
  ${sectionsHtml}
 
  <!-- Disclaimers -->
  ${legalHtml}
 
  <!-- Footer -->
  <div class="footer">
    <h3>Your report is complete</h3>
    <p>Generated by RevAnalysis · ${date}</p>
    <p>All figures are conservative estimates. PDF copy attached to this email.</p>
  </div>
 
</div>
</body>
</html>`;
}
 
// ══════════════════════════════════════════════════
//  ANTHROPIC + PDF + EMAIL
// ══════════════════════════════════════════════════
async function callAnthropic(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2200, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data.content.map(b => b.text || '').join('');
}
 
async function generatePDF(html) {
  const r = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64')}` },
    body: JSON.stringify({
      source: html,
      landscape: false,
      use_print: false,
      format: 'A4',
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' }
    })
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`PDFShift ${r.status}: ${errText.substring(0, 200)}`);
  }
  const buffer = await r.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
 
async function sendEmail({ to, bizName, reportHtml, pdfBase64, pdfFilename }) {
  const payload = {
    from: 'RevAnalysis <report@RevAnalysis.com>',
    to: [to],
    subject: `Your RevAnalysis Report is ready — ${bizName}`,
    html: reportHtml
  };
  if (pdfBase64) {
    payload.attachments = [{ filename: pdfFilename, content: pdfBase64, type: 'application/pdf', disposition: 'attachment' }];
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || `Resend ${r.status}`);
  return data;
}
 
function parseSecs(txt) {
  const out = {};
  const re = /\[([A-Z_]+)\]([\s\S]*?)(?=\[[A-Z_]+\]|$)/g;
  let m;
  while ((m = re.exec(txt)) !== null) if (m[2].trim()) out[m[1]] = m[2].trim();
  return out;
}
 
// ══════════════════════════════════════════════════
//  PROMPTS
// ══════════════════════════════════════════════════
function buildServerContext(bizName, industry, calcData, answers) {
  const L = calcData;
  const a = answers || {};
  const top3 = L.cats.slice(0,3).map(c => `${c.n} (estimated ~$${c.amt.toLocaleString()})`).join(', ');
  const goalOpts = ['Get more consistent inbound leads','Convert more leads into paying customers','Get past customers buying again','Build a referral system that works automatically','Raise prices without losing customers','Fix quality and stop losing money on errors'];
  const goal = goalOpts[a.topGoal ?? 0] || 'growing revenue';
  return {
    biz: bizName, ind: industry,
    revRange: L.meta.revLabel, revLo: `$${L.meta.revLo.toLocaleString()}`, revMid: `$${L.meta.revMid.toLocaleString()}`,
    avgLo: `$${L.meta.avgLo.toLocaleString()}`, avgMid: `$${L.meta.avgMid.toLocaleString()}`,
    close: `${Math.round(L.meta.close * 100)}%`, mthLeads: L.meta.mthLeads, annCusts: L.meta.annCusts, dead: L.meta.dead,
    total: `~$${L.total.toLocaleString()}`, totalRange: `$${L.totalLo.toLocaleString()}–$${L.totalHi.toLocaleString()}`,
    top3, goal,
    cats: L.cats.map(c => `${c.n}: ~$${c.amt.toLocaleString()} (${c.desc})`).join('\n'),
    scores: Object.entries(L.sc).map(([k,v]) => `${k}: ${v}/100`).join(', '),
    L
  };
}
 
function sysPrompt(c) {
  return `You are a no-BS business growth advisor writing a diagnostic report for ${c.biz}, a ${c.ind} business. Your style is direct, math-first, and action-oriented. You name problems clearly, show the dollar cost immediately, and give the exact fix.

CLIENT DIAGNOSTIC DATA:
- Revenue range: ${c.revRange} (conservative low: ${c.revLo} used for calculations)
- Average transaction: ~${c.avgMid} | Monthly leads: ~${c.mthLeads} | Close rate: ~${c.close}
- Annual customers: ~${c.annCusts} | Total estimated opportunity: ${c.total} (range: ${c.totalRange})
- Top 3 opportunities: ${c.top3}
- Performance scores: ${c.scores}
- Owner's #1 goal: ${c.goal}

All 8 categories (conservative estimates):
${c.cats}

WRITING STYLE RULES — NON-NEGOTIABLE:
1. Numbers first. Always open with the dollar figure, then explain it.
2. Short sentences. One idea per sentence. No run-ons.
3. Name the mistake directly. "Most ${c.ind} businesses do X. That's why they're stuck."
4. Show the math. Walk through the calculation. Make it feel real and specific.
5. Make inaction expensive. Every gap has a cost. State it.
6. No corporate fluff. No "it's important to consider" — say what it is.
7. Use "you" directly. This is a conversation, not a white paper.
8. Every section ends with an exact action. Not a suggestion. An instruction.
9. Scripts must be complete and word-for-word. No [insert name here] placeholders — write the actual words.
10. Use "estimated", "approximately", "based on your diagnostic" for all dollar figures — these are directional, not audited.
11. Write specifically for ${c.ind}. Not generic small business advice.
12. Cite research by source name only: Bain & Company, McKinsey, Salesforce, HBR, etc.
13. Recovery framing: "businesses in ${c.ind} that fix this one thing typically recover 15–25% of the gap within 90 days."
14. HTML only: <p>, <strong>, <h4>, <ul><li>, <ol><li>, <div class="stat-call">, <div class="script"><span class="slabel">...</span><p>...</p></div>, <div class="action-box"><h5>...</h5><ol>...</ol></div>, <div class="disclaimer">`;
}
 
function buildSectionPrompt(key, c) {
  const base = sysPrompt(c);
  const prompts = {
    EXEC: `${base}\nWrite ONLY the [EXEC] section. First line must be exactly: [EXEC]\n\nWrite 5 focused paragraphs (~280 words total) for ${c.biz}, a ${c.ind} business:\n- Para 1: Open with the ~${c.total} estimated opportunity. Use conservative language. Compelling ${c.ind}-specific analogy.\n- Para 2: Why ${c.ind} businesses specifically lose revenue this way — structural industry reasons.\n- Para 3: The top 3 estimated opportunities: ${c.top3}. Their dollar context and interconnection.\n- Para 4: What the next 90 days looks like with implementation. Realistic.\n- Para 5: The mindset shift from reactive to systematic.\n<div class="stat-call">Include one real industry statistic with source name relevant to ${c.ind}.</div>\n<div class="disclaimer">All figures are estimates based on the ranges you provided. Actual results depend on your situation and implementation consistency.</div>`,
 
    CONV: `${base}\nWrite ONLY the [CONV] section. First line must be exactly: [CONV]\n\n<h4>Close Rate Analysis</h4>\n<p>${c.close} close rate vs ~65% ${c.ind} benchmark. Calculate opportunity using conservative estimates. Reference CSO Insights. Use "estimated" language.</p>\n<h4>Response Speed Gap</h4>\n<p>MIT/HBR 5-minute rule applied specifically to ${c.ind}. 3–4 sentences.</p>\n<h4>Follow-Up System Gap</h4>\n<p>Salesforce 80%/5-touch data. Specific to ${c.ind}. 3–4 sentences.</p>\n<h4>5-Email Follow-Up Sequence</h4>\nCRITICAL: Write each email in FULL — no placeholders. 60–70 words each.\n<div class="script"><span class="slabel">Email 1 — Same Day (Subject: [write a real subject line for ${c.ind}])</span><p>[Write complete 65-word email — warm, specific to ${c.ind}, ends with one clear question]</p></div>\n<div class="script"><span class="slabel">Email 2 — Day 2 (Subject: [real subject line])</span><p>[Complete 60-word email — adds value, soft nudge]</p></div>\n<div class="script"><span class="slabel">Email 3 — Day 5 (Subject: [real subject line])</span><p>[Complete 60-word email — addresses the most common ${c.ind} objection]</p></div>\n<div class="script"><span class="slabel">Email 4 — Day 10 (Subject: [real subject line])</span><p>[Complete 55-word email — mild urgency, final real attempt]</p></div>\n<div class="script"><span class="slabel">Email 5 — Day 21 (Subject: Closing the loop)</span><p>[Complete 45-word breakup email — leaves door open, signed off warmly]</p></div>`,
 
    DEAD: `${base}\nWrite ONLY the [DEAD] section. First line must be exactly: [DEAD]\n\n<h4>Value in Your Pipeline</h4>\n<p>Calculate: ~${c.dead} leads × ${c.avgLo} conservative avg × 12% re-engagement rate = approximately $[calculate this]. Explain 3 specific reasons leads go cold in ${c.ind}. Use "estimated" language.</p>\n<h4>Re-Engagement Sequence</h4>\nCRITICAL: Write each message in FULL.\n<div class="script"><span class="slabel">Re-engagement Email (Subject: [real subject line for ${c.ind}])</span><p>[Complete 65-word email — natural, no pressure, specific to ${c.ind} context]</p></div>\n<div class="script"><span class="slabel">Follow-Up Text — 3 Days Later (under 140 chars)</span><p>[Complete text message — conversational, references the email]</p></div>\n<div class="script"><span class="slabel">Final Email — Day 10 (Subject: Last one from us)</span><p>[Complete 45-word closing email — leaves door open, no pressure]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[specific step with time estimate]</li><li>[specific step with time estimate]</li><li>[specific step with time estimate]</li><li>[specific ongoing step]</li></ol></div>`,
 
    MKTG: `${base}\nWrite ONLY the [MKTG] section. First line must be exactly: [MKTG]\n\n<h4>Marketing Diagnosis</h4>\n<p>Honest assessment of their marketing based on diagnostic data. Specific to ${c.ind}.</p>\n<h4>The 2 Highest-ROI Channels for ${c.ind}</h4>\n<p>Name the 2 specific channels with real data and source names. For each: why it works in ${c.ind}, how to implement, expected ROI. Specific not generic.</p>\n<h4>30-Minute Weekly Content Framework</h4>\n<table><tr><th>Week</th><th>Content Type</th><th>Topic for ${c.ind}</th><th>Platform</th></tr><tr><td>1</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>2</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>3</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>4</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr></table>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    RET: `${base}\nWrite ONLY the [RET] section. First line must be exactly: [RET]\n\n<h4>Customer Lifetime Value Estimate</h4>\n<p>Show math: ${c.avgMid} est. avg × estimated annual frequency for ${c.ind} × estimated lifespan = ~$[CLV]. Apply Bain & Company's finding (5% retention = 25–95% profit growth) to ~${c.annCusts} annual customers. Use conservative language.</p>\n<h4>The Retention Gap</h4>\n<p>Estimated annual cost of their retention gap. Why ${c.ind} customers stop returning — specific to the industry. 3–4 sentences.</p>\n<h4>3-Step Retention System for ${c.ind}</h4>\n<p>Specific touchpoints, timing, and channels that work in ${c.ind}. Industry-specific, not generic.</p>\nCRITICAL: Write each template in FULL.\n<div class="script"><span class="slabel">30-Day Post-Job Check-In (Email — write in full, 70 words)</span><p>[Full email — warm, specific to ${c.ind}, ends with open question]</p></div>\n<div class="script"><span class="slabel">6-Month Re-Engagement (Text — under 140 chars)</span><p>[Complete text — natural, references the original service]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REF: `${base}\nWrite ONLY the [REF] section. First line must be exactly: [REF]\n\n<h4>The Referral Math for ${c.ind}</h4>\n<p>Conservative calculation: each activated ${c.ind} customer generates ~1.2 referrals × ${c.avgLo} conservative avg × ~55% conversion = ~$[calculate this] per activated customer. Apply Texas Tech / Wharton referral LTV research (16–25% higher LTV). Use "estimated" language.</p>\n<h4>The Systematic Referral Process for ${c.ind}</h4>\n<p>When to ask, how to ask, what to offer — specific to ${c.ind}. What top performers do differently. 2–3 sentences.</p>\nCRITICAL: Write scripts in FULL.\n<div class="script"><span class="slabel">Referral Ask Script (word-for-word — at job completion in ${c.ind})</span><p>[Complete natural 75-word script — specific to ${c.ind} context, ends with a clear ask]</p></div>\n<div class="script"><span class="slabel">Referral Thank-You (Text — when someone sends a referral, under 140 chars)</span><p>[Complete text — warm, acknowledges the referral specifically]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    PRICE: `${base}\nWrite ONLY the [PRICE] section. First line must be exactly: [PRICE]\n\n<h4>The Pricing Opportunity</h4>\n<p>McKinsey: 1% price improvement = ~11% profit improvement. Calculate: a conservative 6% price adjustment on ${c.revLo} = approximately $[calculate this] annually. How ${c.ind} businesses test price increases without losing customers. Use "estimated" and "approximately" language.</p>\n<h4>The Price Increase Test Methodology</h4>\n<p>Step-by-step: how to safely test a 7–10% increase in ${c.ind}. What signals confirm it's working. 3–4 sentences.</p>\n<h4>Premium Tier Example for ${c.ind}</h4>\n<p>Specific Good / Better / Best structure for ${c.ind} — approximate prices and what each tier includes. Concrete and industry-specific.</p>\nCRITICAL: Write scripts in FULL.\n<div class="script"><span class="slabel">Price Increase Communication Script (natural for ${c.ind})</span><p>[Complete 70-word script — confident, value-focused, not apologetic]</p></div>\n<div class="script"><span class="slabel">Premium Tier Presentation Script</span><p>[Complete 70-word script — presents 3 options naturally, lets customer choose]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REV: `${base}\nWrite ONLY the [REV] section. First line must be exactly: [REV]\n\n<h4>The Review-to-Revenue Connection for ${c.ind}</h4>\n<p>BrightLocal: 93% of consumers check reviews. Moz: reviews account for ~15% of local search ranking. For ${c.ind} specifically, explain the direct link between review volume and inbound lead flow. What moving from 10 to 50 to 100+ reviews typically does. Conservative estimates only.</p>\n<h4>Systematic Review Request Process</h4>\n<p>Exact timing, channel, and message for requesting reviews in ${c.ind}. When to ask (optimal moment post-job), how to make it easy, how to follow up once.</p>\nCRITICAL: Write templates in FULL.\n<div class="script"><span class="slabel">Review Request Text — 24–48 Hours After Completion (under 140 chars)</span><p>[Complete text — natural, includes [your Google review link] placeholder]</p></div>\n<div class="script"><span class="slabel">Follow-Up If No Review — 5 Days Later (under 140 chars)</span><p>[Complete follow-up text — gentle, not pushy]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    OPS: `${base}\nWrite ONLY the [OPS] section. First line must be exactly: [OPS]\n\n<h4>The True Cost of Quality Issues in ${c.ind}</h4>\n<p>Each complaint in ${c.ind} conservatively costs 4–6x the transaction value: redo time + lost repeat business + review risk. At ${c.avgLo} conservative avg, each avoidable complaint costs approximately $[calculate this]. Estimated annual impact at their current complaint rate. Use conservative language.</p>\n<h4>The 3 Critical SOPs for ${c.ind}</h4>\n<p>Name and describe the 3 most impactful SOPs specifically for ${c.ind} — not generic. For each: what it covers, key steps, what breaks without it.</p>\n<h4>Quality Control in Practice</h4>\n<p>How top-performing ${c.ind} businesses build quality checkpoints without significant overhead. 2–3 sentences with a specific example.</p>\n<div class="action-box"><h5>4 Action Steps with Time Estimates</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li></ol></div>`,
 
    PRIORITY: `${base}\nWrite ONLY the [PRIORITY] section. First line must be exactly: [PRIORITY]\n\n<h4>Priority Rankings for ${c.biz}</h4>\n<table><tr><th>Rank</th><th>Category</th><th>Est. Opportunity</th><th>Conservative 90-Day Target</th><th>First Action This Week</th></tr>\n${c.L.cats.map((cat,i)=>`<tr><td><strong>#${i+1}</strong></td><td>${cat.n}</td><td>~$${cat.amt.toLocaleString()}</td><td>$${Math.round(cat.amt*0.15).toLocaleString()}–$${Math.round(cat.amt*0.25).toLocaleString()}</td><td>[Write 1 specific, actionable first step for this category in ${c.ind}]</td></tr>`).join('\n')}\n</table>\n<p>Write 2 paragraphs explaining the sequencing strategy — why this specific order maximizes early results for ${c.biz} in ${c.ind}. Specific about which categories to tackle first and why. Use realistic, conservative language about expected outcomes.</p>`,
 
    PLAN: `${base}\nWrite ONLY the [PLAN] section. First line must be exactly: [PLAN]\n\nWrite the 90-day roadmap for ${c.biz}, a ${c.ind} business. Every task must be SPECIFIC to ${c.ind} — not generic. Include real time estimates in every task.\n\n<div class="pgrid">\n<div class="pcard"><div class="ptag">Week 1 — Days 1–7</div><div class="ptitle">Quick Wins</div>\n<div class="ptask">Day 1 (time): [specific ${c.ind} task]</div>\n<div class="ptask">Day 2 (time): [specific task]</div>\n<div class="ptask">Day 3 (time): [specific task]</div>\n<div class="ptask">Day 4 (time): [specific task]</div>\n<div class="ptask">Day 5 (time): [specific task]</div>\n<div class="ptask">Days 6–7 (time): [specific task]</div>\n<div class="pmile">Day 30 milestone: [3–4 specific measurable outcomes with numbers]</div>\n</div>\n<div class="pcard"><div class="ptag">Week 2 — Days 8–14</div><div class="ptitle">Foundation</div>\n<div class="ptask">(time): [specific ${c.ind} task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="pmile">Day 60 milestone: [specific measurable outcomes]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 2 — Days 31–60</div><div class="ptitle">Momentum</div>\n<div class="ptask">[specific task with time]</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 3 — Days 61–90</div><div class="ptitle">Systematize</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n<div class="ptask">[specific task]</div>\n<div class="pmile">Day 90 milestone: [specific metrics — what measurable improvement looks like for ${c.ind}]</div>\n</div>\n</div>`,
 
    ROI: `${base}\nWrite ONLY the [ROI] section. First line must be exactly: [ROI]\n\n<h4>Conservative Recovery Projection</h4>\n<table>\n<tr><th>Scenario</th><th>Recovery Rate</th><th>Month 1 Est.</th><th>Month 2 Est.</th><th>Month 3 Est.</th><th>90-Day Total</th></tr>\n<tr><td>Conservative</td><td>15%</td><td>~$${Math.round(c.L.total*0.15*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15*0.50).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td></tr>\n<tr><td>Realistic</td><td>22%</td><td>~$${Math.round(c.L.total*0.22*0.20).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22*0.55).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td></tr>\n<tr><td>Optimistic</td><td>32%</td><td>~$${Math.round(c.L.total*0.32*0.25).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32*0.60).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td></tr>\n</table>\n<p>Explain what specific behaviors and implementation consistency drives each scenario. Be honest that results vary.</p>\n<h4>Report ROI</h4>\n<p>At the realistic scenario: ~$${Math.round(c.L.total*0.22).toLocaleString()} estimated 90-day recovery on a $297 investment = approximately ${Math.round(c.L.total*0.22/297)}x return if implemented consistently. Converting just ${Math.ceil(297/c.L.meta.avgLo)} additional dormant leads at the conservative average covers the cost of this report.</p>\n<div class="disclaimer">All projections are estimates based on diagnostic inputs and industry benchmarks. Actual results depend on consistent implementation, local market conditions, team capacity, and your specific business circumstances. These figures are directional, not guaranteed outcomes.</div>\n<h4>Your Single Most Important Action in the Next 48 Hours</h4>\n<p>[Write the single most impactful, specific first action for ${c.biz} in ${c.ind} based on their #1 opportunity. Explain why it's highest-leverage and give exact steps to take today. 80–100 words. Specific to ${c.ind} — not generic advice.]</p>`,
  };
  return prompts[key] || `${base}\nWrite the [${key}] section for ${c.biz}, a ${c.ind} business. First line must be exactly: [${key}]`;
}
 
// ══════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`RevAnalysis worker running on port ${PORT}`));