
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
 
// ══════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'RevAnalysis worker running', queueLength: queue.length, isProcessing }));
app.get('/status', (req, res) => res.json({ queueLength: queue.length, isProcessing, jobs: queue.map(j => ({ email: j.email, bizName: j.bizName })) }));
 
app.post('/resend', (req, res) => {
  const { email, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const job = jobStore[email];
  if (!job) return res.status(404).json({ error: `No job found for ${email}` });
  if (job.completedHtml) {
    sendEmail({ to: email, firstName: job.firstName||'', bizName: job.bizName, reportHtml: job.completedHtml, pdfBase64: job.completedPdf || null, pdfFilename: `${(job.bizName||'Report').replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf` })
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
  const jobs = Object.values(jobStore).map(j => ({
    email: j.email, firstName: j.firstName||'', lastName: j.lastName||'', title: j.title||'',
    bizName: j.bizName, industry: j.industry, savedAt: j.savedAt,
    completedAt: j.completedAt || null, consentBenchmark: j.consentBenchmark||false,
  }));
  res.json({ count: jobs.length, jobs });
});
 
app.post('/generate', (req, res) => {
  const { email, firstName, lastName, title, bizName, industry, calcData, answers, consentBenchmark } = req.body;
  if (!email || !calcData) return res.status(400).json({ error: 'Missing required fields' });
  jobStore[email] = { email, firstName:firstName||'', lastName:lastName||'', title:title||'', bizName, industry, calcData, answers, consentBenchmark:consentBenchmark||false, savedAt: new Date().toISOString() };
  
  // ← ADD THIS
  saveToSupabase({
    email,
    first_name: firstName||'',
    last_name: lastName||'',
    title: title||'',
    biz_name: bizName,
    industry,
    revenue_range: calcData?.meta?.revLabel||'',
    revenue_mid: calcData?.meta?.revMid||0,
    avg_transaction_mid: calcData?.meta?.avgMid||0,
    close_rate: calcData?.meta?.close||0,
    overall_score: calcData?.overallScore||0,
    total_opportunity: calcData?.total||0,
    total_lo: calcData?.totalLo||0,
    total_hi: calcData?.totalHi||0,
    cats: calcData?.cats||[],
    scores: calcData?.sc||{},
    answers: answers||{},
    consent_benchmark: consentBenchmark||false,
    report_delivered: false,
  }).catch(e => console.warn('Supabase intake save failed:', e.message));

  enqueue({ email, firstName:firstName||'', lastName:lastName||'', title:title||'', bizName, industry, calcData, answers, consentBenchmark:consentBenchmark||false });
  const position = queue.length;
  const estimatedMinutes = isProcessing ? Math.round((position + 1) * 6) : Math.round(position * 6);
  res.status(200).json({ queued: true, position, estimatedMinutes });
});
 
// ══════════════════════════════════════════════════
//  INDUSTRY BENCHMARKS
// ══════════════════════════════════════════════════
function getIndustryBenchmarks(industry) {
  const ind = (industry || '').toLowerCase();
  if (ind.includes('plumb')||ind.includes('hvac')||ind.includes('electr')||ind.includes('roof')||ind.includes('contractor')||ind.includes('landscap')||ind.includes('pest')||ind.includes('paint'))
    return { closeRate:58, retention:28, referralPct:20, reviewCount:42, label:'Home service contractors', source:'IBISWorld + BrightLocal' };
  if (ind.includes('retail')||ind.includes('boutique')||ind.includes('shop')||ind.includes('store')||ind.includes('apparel'))
    return { closeRate:72, retention:25, referralPct:14, reviewCount:85, label:'Retail businesses', source:'NRF + Google' };
  if (ind.includes('gym')||ind.includes('fitness')||ind.includes('yoga')||ind.includes('crossfit')||ind.includes('wellness')||ind.includes('studio'))
    return { closeRate:62, retention:48, referralPct:30, reviewCount:110, label:'Fitness & wellness businesses', source:'IHRSA + Yelp' };
  if (ind.includes('consult')||ind.includes('account')||ind.includes('legal')||ind.includes('law')||ind.includes('financial')||ind.includes('advisory'))
    return { closeRate:52, retention:58, referralPct:38, reviewCount:28, label:'Professional services firms', source:'HBR + Clutch' };
  if (ind.includes('restaurant')||ind.includes('cafe')||ind.includes('food')||ind.includes('cater')||ind.includes('bakery'))
    return { closeRate:82, retention:35, referralPct:22, reviewCount:180, label:'Food & hospitality businesses', source:'NRA + Google' };
  if (ind.includes('real estate')||ind.includes('realtor')||ind.includes('property')||ind.includes('agent'))
    return { closeRate:42, retention:22, referralPct:45, reviewCount:35, label:'Real estate businesses', source:'NAR + Zillow' };
  if (ind.includes('clean')||ind.includes('maid')||ind.includes('janitorial'))
    return { closeRate:64, retention:52, referralPct:26, reviewCount:55, label:'Cleaning service businesses', source:'IBISWorld + Angi' };
  if (ind.includes('salon')||ind.includes('barber')||ind.includes('spa')||ind.includes('beauty')||ind.includes('nail'))
    return { closeRate:75, retention:55, referralPct:32, reviewCount:95, label:'Beauty & personal care businesses', source:'PBA + Yelp' };
  if (ind.includes('dental')||ind.includes('medical')||ind.includes('chiro')||ind.includes('physio')||ind.includes('therapy')||ind.includes('clinic'))
    return { closeRate:68, retention:62, referralPct:35, reviewCount:65, label:'Healthcare & wellness practices', source:'ADA + Healthgrades' };
  if (ind.includes('tech')||ind.includes('software')||ind.includes('saas')||ind.includes('digital')||ind.includes('agency'))
    return { closeRate:45, retention:72, referralPct:28, reviewCount:22, label:'Tech & digital service businesses', source:'Salesforce + Clutch' };
  return { closeRate:60, retention:35, referralPct:22, reviewCount:55, label:'Small businesses in your sector', source:'SBA + Google' };
}


// ══════════════════════════════════════════════════
//  SUPABASE — save diagnostic data
// ══════════════════════════════════════════════════
async function saveToSupabase(data) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.warn('Supabase env vars missing — skipping save'); return; }

  try {
    const r = await fetch(`${url}/rest/v1/diagnostics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(data)
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.warn(`Supabase save failed ${r.status}:`, err.substring(0, 200));
    } else {
      console.log(`✓ Saved to Supabase for ${data.email}`);
    }
  } catch(e) {
    console.warn('Supabase save error:', e.message);
  }
}

async function updateSupabaseDelivered(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;

  try {
    await fetch(`${url}/rest/v1/diagnostics?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        report_delivered: true,
        delivered_at: new Date().toISOString()
      })
    });
    console.log(`✓ Supabase delivery status updated for ${email}`);
  } catch(e) {
    console.warn('Supabase update error:', e.message);
  }
}



 
// ══════════════════════════════════════════════════
//  MAIN GENERATION
// ══════════════════════════════════════════════════
async function generateAndSend({ email, firstName, lastName, title, bizName, industry, calcData, answers, consentBenchmark }) {
  const SECTION_KEYS = ['EXEC','BENCH','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','PRIORITY','PLAN','ROI'];
  const sections = {};
  const ctx = buildServerContext(bizName, industry, calcData, answers, firstName, lastName, title);
 
  console.log(`Starting generation for ${bizName} (${email}) — ${SECTION_KEYS.length} sections`);
 
  for (let i = 0; i < SECTION_KEYS.length; i++) {
    const key = SECTION_KEYS[i];
    console.log(`  Section ${i+1}/${SECTION_KEYS.length}: ${key}`);
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
 
  console.log(`All sections done. Generating PDF...`);
  const reportHtml = buildEmailHtml(firstName, bizName, industry, calcData, sections);
 
  let pdfBase64 = null;
  try {
    pdfBase64 = await generatePDF(reportHtml);
    console.log('PDF generated');
  } catch(e) {
    console.warn('PDF failed, sending without attachment:', e.message);
  }
 
  const pdfFilename = `${(bizName||'Report').replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf`;
  await sendEmail({ to: email, firstName, bizName, reportHtml, pdfBase64, pdfFilename });
  jobStore[email].completedHtml = reportHtml;
  jobStore[email].completedPdf = pdfBase64;
  jobStore[email].completedAt = new Date().toISOString();
  console.log(`✓ Email sent to ${email}`);
  updateSupabaseDelivered(email); // ← ADD THIS LINE


}
 
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
// ══════════════════════════════════════════════════
//  SVG CHART HELPERS
// ══════════════════════════════════════════════════
function svgBarChart(cats) {
  const maxAmt = Math.max(...cats.map(c => c.amt), 1);
  const COLORS = { h:'#dc2626', m:'#d97706', l:'#16a34a' };
  const rowH=44, labelW=190, barZone=360, height=cats.length*rowH+40, width=620;
  const rows = cats.map((cat, i) => {
    const barW = Math.max(4, Math.round((cat.amt/maxAmt)*barZone));
    const y = 20+i*rowH, color = COLORS[cat.sev]||'#2557a7';
    const label = cat.n.length>28 ? cat.n.substring(0,27)+'…' : cat.n;
    return `<text x="${labelW-8}" y="${y+16}" font-family="Arial,sans-serif" font-size="11.5" fill="#374151" text-anchor="end" dominant-baseline="middle">${label}</text>
      <rect x="${labelW}" y="${y+4}" width="${barW}" height="22" rx="4" fill="${color}" opacity="0.82"/>
      <text x="${labelW+barW+7}" y="${y+16}" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="${color}" dominant-baseline="middle">~$${cat.amt.toLocaleString()}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${width}" height="${height}" rx="4" fill="#f9fafb"/>${rows}</svg>`;
}
 
function svgLineChart(total) {
  const c15=Math.round(total*0.15), c22=Math.round(total*0.22), c32=Math.round(total*0.32);
  const datasets=[
    {label:'Conservative (15%)',color:'#d97706',values:[0,Math.round(c15*0.15),Math.round(c15*0.50),c15]},
    {label:'Realistic (22%)',color:'#2557a7',values:[0,Math.round(c22*0.20),Math.round(c22*0.55),c22]},
    {label:'Optimistic (32%)',color:'#16a34a',values:[0,Math.round(c32*0.25),Math.round(c32*0.60),c32]},
  ];
  const W=580,H=220,padL=72,padR=20,padT=20,padB=56;
  const chartW=W-padL-padR, chartH=H-padT-padB, maxVal=c32*1.08;
  const toX=i=>padL+(i/3)*chartW, toY=v=>padT+chartH-(v/maxVal)*chartH;
  const grids=[0,0.25,0.5,0.75,1].map(f=>{
    const y=toY(f*maxVal),v=Math.round(f*maxVal),vl=v>=1000?'$'+(v/1000).toFixed(0)+'k':'$'+v;
    return `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/><text x="${padL-6}" y="${y+4}" font-family="Arial,sans-serif" font-size="9.5" fill="#9ca3af" text-anchor="end">${vl}</text>`;
  }).join('');
  const xLabels=['Start','Month 1','Month 2','Month 3'].map((l,i)=>`<text x="${toX(i)}" y="${H-padB+18}" font-family="Arial,sans-serif" font-size="10.5" fill="#6b7280" text-anchor="middle">${l}</text>`).join('');
  const lines=datasets.map(ds=>{
    const pts=ds.values.map((v,i)=>`${toX(i)},${toY(v)}`).join(' ');
    const dots=ds.values.map((v,i)=>`<circle cx="${toX(i)}" cy="${toY(v)}" r="4" fill="${ds.color}" stroke="white" stroke-width="1.5"/>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${ds.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>${dots}`;
  }).join('');
  const legend=datasets.map((ds,i)=>{const lx=padL+i*175;return `<rect x="${lx}" y="${H-20}" width="12" height="3" rx="2" fill="${ds.color}"/><text x="${lx+17}" y="${H-12}" font-family="Arial,sans-serif" font-size="10" fill="#4b5563">${ds.label}</text>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="4" fill="#f9fafb"/>${grids}<line x1="${padL}" y1="${padT+chartH}" x2="${W-padR}" y2="${padT+chartH}" stroke="#d1d5db" stroke-width="1.5"/>${xLabels}${lines}${legend}</svg>`;
}
 
function svgScoreChart(sc) {
  const cats=[
    {label:'Conversion',score:sc.conversion,bench:65},{label:'Marketing',score:sc.marketing,bench:60},
    {label:'Retention',score:sc.retention,bench:60},{label:'Referrals',score:sc.referrals,bench:55},
    {label:'Pricing',score:sc.pricing,bench:60},{label:'Reviews',score:sc.reviews,bench:55},
    {label:'Operations',score:sc.operations,bench:65},
  ];
  const W=580,rowH=34,padL=90,padR=20,padT=16,barW=W-padL-padR,H=padT+cats.length*rowH+28;
  const rows=cats.map((cat,i)=>{
    const y=padT+i*rowH,yourW=Math.round((cat.score/100)*barW),benchX=padL+Math.round((cat.bench/100)*barW);
    const color=cat.score>=cat.bench?'#16a34a':cat.score>=cat.bench*0.7?'#d97706':'#dc2626';
    return `<text x="${padL-8}" y="${y+14}" font-family="Arial,sans-serif" font-size="11" fill="#374151" text-anchor="end">${cat.label}</text>
      <rect x="${padL}" y="${y+4}" width="${barW}" height="16" rx="3" fill="#e5e7eb"/>
      <rect x="${padL}" y="${y+4}" width="${yourW}" height="16" rx="3" fill="${color}" opacity="0.8"/>
      <line x1="${benchX}" y1="${y}" x2="${benchX}" y2="${y+24}" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="3,2"/>
      <text x="${padL+yourW+5}" y="${y+15}" font-family="Arial,sans-serif" font-size="10" fill="${color}" font-weight="bold">${cat.score}</text>`;
  }).join('');
  const benchLegendX=padL+Math.round(0.60*barW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="4" fill="#f9fafb"/>${rows}<text x="${benchLegendX}" y="${H-8}" font-family="Arial,sans-serif" font-size="9.5" fill="#6b7280" text-anchor="middle">--- Industry benchmark</text></svg>`;
}
 
// ══════════════════════════════════════════════════
//  EMAIL / PDF HTML BUILDER
//  Cover page: dark navy
//  Section headers: dark navy
//  Section body: white
// ══════════════════════════════════════════════════
function buildEmailHtml(firstName, bizName, industry, calcData, sections) {
  const L = calcData;
  const date = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  const rec22 = Math.round(L.total * 0.22);
  const bench = getIndustryBenchmarks(industry);
 
  const sectionKeys = ['EXEC','BENCH','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','PRIORITY','PLAN','ROI'];
  const sectionTitles = {
    EXEC:'Executive Summary', BENCH:'Industry Benchmark Analysis',
    CONV:'Lead Conversion & Sales', DEAD:'Dead & Dormant Leads',
    MKTG:'Marketing Efficiency', RET:'Customer Retention', REF:'Referral Generation',
    PRICE:'Pricing Power', REV:'Reviews & Visibility', OPS:'Operations & Quality',
    PRIORITY:'Priority Action Matrix', PLAN:'90-Day Recovery Roadmap', ROI:'Revenue Recovery Projection'
  };
  const catKeyMap = { CONV:'conversion', DEAD:'dormant', MKTG:'Marketing', RET:'retention', REF:'Referral', PRICE:'Pricing', REV:'Reviews', OPS:'Operations' };
 
  const css = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Helvetica, Arial, sans-serif; background: #eef0f5; color: #111827; font-size: 14px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 800px; margin: 0 auto; padding: 28px 16px; }
.cover { background: #0f1f3d; border-radius: 12px; padding: 40px; margin-bottom: 20px; color: white; }
.cover-tag { font-size: 10px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: #6ea8fe; margin-bottom: 12px; }
.cover-h { font-family: Georgia, serif; font-size: 32px; font-weight: 800; line-height: 1.1; margin-bottom: 10px; }
.cover-h .red { color: #ff6b6b; }
.cover-range { font-size: 13px; color: rgba(255,255,255,.5); margin-bottom: 4px; }
.cover-meta { font-size: 12px; color: rgba(255,255,255,.35); margin-bottom: 16px; }
.cover-note { background: rgba(255,255,255,.07); border-radius: 8px; padding: 10px 14px; font-size: 11px; color: rgba(255,255,255,.45); }
.kpi-strip { background: white; border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; border: 1px solid #e4e8f0; }
.kpi-row { display: table; width: 100%; }
.kpi-cell { display: table-cell; text-align: center; padding: 4px 8px; border-right: 1px solid #e4e8f0; }
.kpi-cell:last-child { border-right: none; }
.kpi-val { font-family: Georgia, serif; font-size: 20px; font-weight: 700; line-height: 1.2; margin-bottom: 4px; }
.kpi-lbl { font-size: 10px; color: #8d97aa; text-transform: uppercase; letter-spacing: .08em; }
.bench-strip { background: white; border: 1px solid #e4e8f0; border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; }
.bench-head { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #8d97aa; margin-bottom: 12px; }
.bench-row { display: table; width: 100%; border-collapse: separate; border-spacing: 8px; }
.bench-cell { display: table-cell; width: 25%; }
.bench-metric-box { background: #f9fafb; border: 1px solid #e4e8f0; border-radius: 8px; padding: 12px; text-align: center; }
.bm-lbl { font-size: 10px; color: #8d97aa; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.bm-you { font-family: Georgia, serif; font-size: 17px; font-weight: 700; }
.bm-vs { font-size: 10px; color: #8d97aa; margin: 3px 0; }
.bm-bench-val { font-size: 12px; color: #8d97aa; }
.bm-tag { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; display: inline-block; margin-top: 5px; }
.chart-section { background: white; border: 1px solid #e4e8f0; border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
.chart-head { background: #0f1f3d; padding: 12px 20px; display: flex; align-items: center; gap: 10px; }
.sec-num { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; background: rgba(255,255,255,0.1); color: #6ea8fe; font-size: 11px; font-weight: 700; border-radius: 6px; flex-shrink: 0; }
.sec-title-h { font-family: Georgia, serif; font-size: 13px; font-weight: 700; color: white; }
.chart-body { padding: 18px 20px; }
.chart-label { font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #8d97aa; margin-bottom: 10px; }
.chart-wrap { background: #f9fafb; border: 1px solid #e4e8f0; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.rsec { border: 1px solid #e4e8f0; border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
.rsec-head { background: #0f1f3d; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; }
.rsec-left { display: flex; align-items: center; gap: 10px; }
.rsec-title { font-family: Georgia, serif; font-size: 13px; font-weight: 700; color: white; }
.rsec-amt { font-family: Georgia, serif; font-size: 13px; font-weight: 700; color: #ff6b6b; white-space: nowrap; }
.rsec-body { padding: 20px; background: white; }
.quick-win { background: linear-gradient(135deg, #fefce8, #fef3c7); border: 1px solid #fde68a; border-left: 4px solid #f59e0b; border-radius: 0 8px 8px 0; padding: 11px 14px; margin: 0 0 14px 0; font-size: 13px; color: #78350f; font-weight: 500; line-height: 1.55; }
p { margin-bottom: 12px; color: #374151; font-size: 14px; line-height: 1.75; }
p:last-child { margin-bottom: 0; }
strong { font-weight: 600; color: #111827; }
h4 { font-family: Georgia, serif; font-size: 15px; font-weight: 700; color: #0f1f3d; margin: 18px 0 8px; }
h5 { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #2557a7; margin-bottom: 10px; }
ul { margin: 8px 0 12px; padding: 0; list-style: none; }
ul li { display: flex; gap: 8px; margin-bottom: 7px; font-size: 14px; color: #5a6478; line-height: 1.6; }
ul li::before { content: '→'; color: #3b6fd4; font-weight: 600; flex-shrink: 0; }
ol { margin: 8px 0 12px; padding: 0; list-style: none; counter-reset: steps; }
ol li { display: flex; gap: 12px; margin-bottom: 9px; font-size: 14px; color: #5a6478; line-height: 1.6; counter-increment: steps; }
ol li::before { content: counter(steps); display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 50%; background: #0f1f3d; color: #6ea8fe; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
.script { background: #0f1f3d; border-radius: 8px; padding: 16px 18px; margin: 12px 0; }
.slabel { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #93c5fd; margin-bottom: 9px; border-bottom: 1px solid rgba(255,255,255,.1); padding-bottom: 7px; }
.script p { color: #e2e8f0 !important; font-size: 13px; font-style: italic; line-height: 1.75; margin-bottom: 6px; }
.script strong { color: #ffffff !important; }
.action-box { background: #f8f9fc; border: 1px solid #e4e8f0; border-left: 4px solid #2557a7; border-radius: 0 8px 8px 0; padding: 16px 18px; margin: 12px 0; }
.stat-call { background: #eef3fd; border-left: 4px solid #2557a7; border-radius: 0 8px 8px 0; padding: 11px 14px; margin: 12px 0; font-size: 13px; color: #1e3a5f; font-weight: 500; line-height: 1.6; }
.disclaimer { background: #f3f4f6; border-radius: 8px; padding: 10px 14px; margin: 10px 0; font-size: 12px; color: #6b7280; font-style: italic; line-height: 1.5; }
blockquote { background: #0f1f3d; border-radius: 8px; padding: 14px 18px; margin: 12px 0; color: rgba(255,255,255,.85); font-size: 13px; font-style: italic; line-height: 1.75; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
th { background: #0f1f3d; color: #6ea8fe; padding: 9px 13px; text-align: left; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
td { padding: 9px 13px; border-bottom: 1px solid #e4e8f0; color: #5a6478; vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr:nth-child(even) td { background: #f9fafb; }
.pgrid { display: block; }
.pcard { background: #f8f9fc; border: 1px solid #e4e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.ptag { font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #2557a7; margin-bottom: 5px; }
.ptitle { font-size: 14px; font-weight: 700; color: #0f1f3d; margin-bottom: 9px; }
.ptask { display: flex; gap: 8px; margin-bottom: 7px; font-size: 13px; color: #5a6478; line-height: 1.5; align-items: flex-start; }
.ptask::before { content: '→'; color: #3b6fd4; flex-shrink: 0; font-weight: 600; margin-top: 1px; }
.pmile { background: #0f1f3d; border-radius: 6px; padding: 9px 13px; margin-top: 9px; font-size: 12px; color: #6ea8fe; font-weight: 500; line-height: 1.5; }
.footer { background: #0f1f3d; border-radius: 12px; padding: 28px; text-align: center; margin-top: 18px; }
.footer h3 { font-family: Georgia, serif; font-size: 18px; font-weight: 700; color: white; margin-bottom: 6px; }
.footer p { font-size: 12px; color: rgba(255,255,255,.4); margin-bottom: 3px; }
`;
 
  // Benchmark comparison strip
  const yourClose = Math.round((L.meta.close||0.65)*100);
  const bm = [
    {label:'Close Rate',you:yourClose+'%',bench:bench.closeRate+'%',youN:yourClose,benchN:bench.closeRate},
    {label:'Retention',you:'~'+Math.round((L.meta.retRate||0.15)*100)+'%',bench:bench.retention+'%',youN:Math.round((L.meta.retRate||0.15)*100),benchN:bench.retention},
    {label:'Referrals',you:'~'+Math.round((L.meta.refRate||0.10)*100)+'%',bench:bench.referralPct+'%',youN:Math.round((L.meta.refRate||0.10)*100),benchN:bench.referralPct},
    {label:'Google Reviews',you:L.meta.reviewBand||'<30',bench:bench.reviewCount+'',youN:L.meta.reviewBandN||20,benchN:bench.reviewCount},
  ];
  const bmHtml = `<div class="bench-strip">
    <div class="bench-head">Industry comparison — ${bench.label} (Source: ${bench.source})</div>
    <div class="bench-row">${bm.map(m=>{
      const status=m.youN>=m.benchN*0.9?'above':m.youN>=m.benchN*0.6?'at':'below';
      const tagStyle=status==='above'?'background:rgba(22,163,74,.12);color:#16a34a':status==='at'?'background:rgba(217,119,6,.12);color:#d97706':'background:rgba(220,38,38,.12);color:#dc2626';
      const numColor=status==='above'?'#16a34a':status==='at'?'#d97706':'#dc2626';
      return `<div class="bench-cell"><div class="bench-metric-box"><div class="bm-lbl">${m.label}</div><div class="bm-you" style="color:${numColor}">${m.you}</div><div class="bm-vs">vs avg</div><div class="bm-bench-val">${m.bench}</div><div class="bm-tag" style="${tagStyle}">${status==='above'?'Above avg':status==='at'?'Near avg':'Below avg'}</div></div></div>`;
    }).join('')}</div>
  </div>`;
 
  // Chart section
  const chartSection = `<div class="chart-section">
    <div class="chart-head"><div class="sec-num">00</div><div class="sec-title-h">Performance Dashboard — Visual Overview</div></div>
    <div class="chart-body">
      <div class="chart-wrap"><div class="chart-label">Estimated revenue opportunity by category</div>${svgBarChart(L.cats)}</div>
      <div class="chart-wrap"><div class="chart-label">Your performance score vs industry benchmark</div>${svgScoreChart(L.sc)}</div>
      <div class="chart-wrap"><div class="chart-label">Conservative 90-day recovery projection</div>${svgLineChart(L.total)}</div>
    </div>
  </div>`;
 
  // Sections
  let sectionsHtml = '';
  sectionKeys.forEach((k, i) => {
    if (!sections[k]) return;
    const catKey = catKeyMap[k];
    const catMatch = catKey ? L.cats.find(c => c.n.toLowerCase().includes(catKey.toLowerCase())) : null;
    sectionsHtml += `<div class="rsec">
      <div class="rsec-head">
        <div class="rsec-left"><div class="sec-num">${String(i).padStart(2,'0')}</div><div class="rsec-title">${sectionTitles[k]}</div></div>
        ${catMatch?`<div class="rsec-amt">~$${catMatch.amt.toLocaleString()}/yr</div>`:''}
      </div>
      <div class="rsec-body">${sections[k]}</div>
    </div>`;
  });
 
  const legalHtml = `<div style="background:#f8f9fc;border:1px solid #e4e8f0;border-radius:10px;padding:22px;margin-bottom:16px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8d97aa;margin-bottom:12px;">Important Notices & Disclaimers</div>
    <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:8px;"><strong style="color:#0f1f3d;">No Refund Policy:</strong> This report is a personalised, AI-generated diagnostic document. All sales are final once delivered.</p>
    <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:8px;"><strong style="color:#0f1f3d;">Not Professional Advice:</strong> Content is for informational purposes only. Consult qualified professionals before making significant business decisions.</p>
    <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:8px;"><strong style="color:#0f1f3d;">Estimates Only:</strong> All revenue figures are based on the ranges you self-reported. They are directional estimates, not guarantees.</p>
    <p style="font-size:12px;color:#5a6478;line-height:1.7;margin-bottom:0;"><strong style="color:#0f1f3d;">Data & Privacy:</strong> Your information is used solely to generate your report and will not be sold to third parties.</p>
  </div>`;
 
  const greeting = firstName ? `, ${firstName}` : '';
 
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RevAnalysis Report — ${bizName}</title><style>${css}</style></head>
<body><div class="wrap">
  <div class="cover">
    <div class="cover-tag">Confidential &middot; Revenue Recovery Report</div>
    <div class="cover-h">Estimated Revenue Opportunity${greeting}:<br><span class="red">~$${L.total.toLocaleString()}</span></div>
    <div class="cover-range">Conservative range: $${L.totalLo.toLocaleString()} – $${L.totalHi.toLocaleString()}</div>
    <div class="cover-meta">${bizName} &middot; ${industry} &middot; ${date}</div>
    <div class="cover-note">These are conservative estimates based on diagnostic ranges you provided. A PDF copy is attached.</div>
  </div>
  <div class="kpi-strip"><div class="kpi-row">
    <div class="kpi-cell"><div class="kpi-val" style="color:#dc2626;">~$${L.total.toLocaleString()}</div><div class="kpi-lbl">Est. annual opportunity</div></div>
    <div class="kpi-cell"><div class="kpi-val" style="color:#6ea8fe;">~$${L.cats[0].amt.toLocaleString()}</div><div class="kpi-lbl">Biggest opportunity</div></div>
    <div class="kpi-cell"><div class="kpi-val" style="color:#16a34a;">~$${rec22.toLocaleString()}</div><div class="kpi-lbl">Realistic 90-day target</div></div>
    <div class="kpi-cell"><div class="kpi-val" style="color:#6ea8fe;">${Math.round(rec22/497)}x</div><div class="kpi-lbl">Est. report ROI</div></div>
  </div></div>
  ${bmHtml}
  ${chartSection}
  ${sectionsHtml}
  ${legalHtml}
  <div class="footer">
    <h3>Your report is complete</h3>
    <p>Generated by RevAnalysis &middot; ${date}</p>
    <p>All figures are conservative estimates. PDF copy attached to this email.</p>
  </div>
</div></body></html>`;
}
 
// ══════════════════════════════════════════════════
//  ANTHROPIC + PDF + EMAIL
// ══════════════════════════════════════════════════
async function callAnthropic(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:2400, messages:[{ role:'user', content:prompt }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data.content.map(b => b.text || '').join('');
}
 
async function generatePDF(html) {
  const r = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Basic ${Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64')}` },
    body: JSON.stringify({ source:html, landscape:false, use_print:false, format:'A4', margin:{ top:'12mm', right:'12mm', bottom:'12mm', left:'12mm' } })
  });
  if (!r.ok) { const e = await r.text().catch(()=>''); throw new Error(`PDFShift ${r.status}: ${e.substring(0,200)}`); }
  const buffer = await r.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
 
async function sendEmail({ to, firstName, bizName, reportHtml, pdfBase64, pdfFilename }) {
  const greeting = firstName ? `, ${firstName}` : '';
  const payload = {
    from: 'RevAnalysis <reports@revanalysis.com>',
    to: [to],
    subject: `Your RevAnalysis Report is ready${greeting} — ${bizName}`,
    html: reportHtml
  };
  if (pdfBase64) payload.attachments = [{ filename:pdfFilename, content:pdfBase64, type:'application/pdf', disposition:'attachment' }];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.RESEND_API_KEY}` },
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
//  CONTEXT + PROMPTS
// ══════════════════════════════════════════════════
function buildServerContext(bizName, industry, calcData, answers, firstName, lastName, title) {
  const L = calcData, a = answers || {};
  const top3 = L.cats.slice(0,3).map(c=>`${c.n} (~$${c.amt.toLocaleString()})`).join(', ');
  const goalOpts = ['Get more consistent inbound leads','Convert more leads into paying customers','Get past customers buying again','Build a referral system that works automatically','Raise prices without losing customers','Fix quality and stop losing money on errors'];
  const goal = goalOpts[a.topGoal??0] || 'growing revenue';
  const bench = getIndustryBenchmarks(industry);
  return {
    biz:bizName, ind:industry,
    firstName:firstName||'', lastName:lastName||'', title:title||'',
    revRange:L.meta.revLabel, revLo:`$${L.meta.revLo.toLocaleString()}`, revMid:`$${L.meta.revMid.toLocaleString()}`,
    avgLo:`$${L.meta.avgLo.toLocaleString()}`, avgMid:`$${L.meta.avgMid.toLocaleString()}`,
    close:`${Math.round(L.meta.close*100)}%`, mthLeads:L.meta.mthLeads, annCusts:L.meta.annCusts, dead:L.meta.dead,
    total:`~$${L.total.toLocaleString()}`, totalRange:`$${L.totalLo.toLocaleString()}–$${L.totalHi.toLocaleString()}`,
    top3, goal, bench,
    cats:L.cats.map(c=>`${c.n}: ~$${c.amt.toLocaleString()} (${c.desc})`).join('\n'),
    scores:Object.entries(L.sc).map(([k,v])=>`${k}: ${v}/100`).join(', '),
    L
  };
}
 
function sysPrompt(c) {
  const nameRef = c.firstName ? ` for ${c.firstName}${c.lastName?' '+c.lastName:''}` : '';
  const titleRef = c.title ? ` (${c.title})` : '';
  return `You are a no-BS business growth advisor writing a diagnostic report${nameRef}${titleRef} at ${c.biz}, a ${c.ind} business. Direct, math-first, action-oriented.
 
CLIENT DATA:
- Revenue: ${c.revRange} (conservative low: ${c.revLo}) | Avg transaction: ~${c.avgMid}
- Monthly leads: ~${c.mthLeads} | Close rate: ~${c.close} | Annual customers: ~${c.annCusts}
- Total opportunity: ${c.total} (range: ${c.totalRange})
- Top 3: ${c.top3} | Scores: ${c.scores} | Goal: ${c.goal}
 
INDUSTRY BENCHMARKS (${c.bench.label} — ${c.bench.source}):
- Close rate: ${c.bench.closeRate}% | Retention: ${c.bench.retention}% | Referrals: ${c.bench.referralPct}% | Reviews: ${c.bench.reviewCount}
 
Categories: ${c.cats}
 
RULES — NON-NEGOTIABLE:
1. Numbers first. Open with the dollar figure.
2. Short sentences. One idea each.
3. "Most ${c.ind} businesses do X. That's why they're stuck."
4. Show the math. Walk through it.
5. Make inaction expensive. State the cost.
6. No fluff. No "it's important to consider."
7. Use "you" directly.
8. End with an exact action. Not a suggestion.
9. Scripts: complete, word-for-word, zero placeholders.
10. Use "estimated"/"approximately" for all figures.
11. Specific to ${c.ind}. Not generic.
12. Cite by source name: Bain & Company, McKinsey, Salesforce, HBR, BrightLocal, etc.
13. Recovery: "businesses in ${c.ind} that fix this typically recover 15–25% in 90 days."
14. Reference benchmarks: "The average ${c.ind} business closes ${c.bench.closeRate}%. You're at X%. That gap costs $Y."
15. START every section (except EXEC and BENCH) with: <div class="quick-win">[One specific action THIS WEEK — concrete, ${c.ind}-specific, doable in under 1 hour]</div>
16. HTML only: <p>, <strong>, <h4>, <ul><li>, <ol><li>, <table>, <div class="stat-call">, <div class="script"><span class="slabel">...</span><p>...</p></div>, <div class="action-box"><h5>...</h5><ol>...</ol></div>, <div class="disclaimer">, <div class="quick-win">`;
}
 
function buildSectionPrompt(key, c) {
  const base = sysPrompt(c);
  const prompts = {
    EXEC:`${base}\nWrite ONLY the [EXEC] section. First line: [EXEC]\n\n5 focused paragraphs (~280 words):\n- Para 1: Open with ~${c.total} opportunity (range: ${c.totalRange}). Conservative language. Compelling ${c.ind}-specific analogy.\n- Para 2: Why ${c.ind} businesses specifically lose revenue this way — structural reasons.\n- Para 3: Top 3 opportunities: ${c.top3}. Dollar context and interconnection.\n- Para 4: What the next 90 days looks like. Realistic. Quote "businesses in ${c.ind} typically recover 15–25% in 90 days."\n- Para 5: Mindset shift from reactive to systematic. What top ${c.ind} businesses do differently.\n<div class="stat-call">One real industry statistic with source name relevant to ${c.ind}.</div>\n<div class="disclaimer">All figures are estimates based on the ranges you provided. Actual results depend on your situation and implementation consistency.</div>`,
 
    BENCH:`${base}\nWrite ONLY the [BENCH] section. First line: [BENCH]\n\n<h4>How ${c.biz} Compares to ${c.bench.label}</h4>\nWrite 4 specific paragraphs — one per metric:\n1. Close rate: industry average ${c.bench.closeRate}% vs their ~${c.close}. Dollar impact of gap.\n2. Retention: industry average ${c.bench.retention}% vs their diagnostic answer. Dollar impact.\n3. Referrals: industry average ${c.bench.referralPct}% vs their answer. Dollar impact.\n4. Reviews: industry average ${c.bench.reviewCount} vs their count. Lead flow impact.\nFor each: state the gap, calculate the cost, give ONE action to close it in ${c.ind}.\nSource all data to: ${c.bench.source}\n<div class="stat-call">Businesses that close benchmark gaps in ${c.ind} typically do one thing differently: they systematize what top performers do instinctively.</div>`,
 
    CONV:`${base}\nWrite ONLY the [CONV] section. First line: [CONV]\n\n<div class="quick-win">[One specific action THIS WEEK to improve lead conversion in ${c.ind}]</div>\n\n<h4>Close Rate Analysis</h4>\n<p>~${c.close} vs ~${c.bench.closeRate}% ${c.ind} benchmark (${c.bench.source}). Calculate gap and dollar impact. Reference CSO Insights.</p>\n<h4>Response Speed Gap</h4>\n<p>MIT/HBR 5-minute rule applied to ${c.ind}. Conservative impact. 3–4 sentences.</p>\n<h4>Follow-Up System Gap</h4>\n<p>Salesforce 80%/5-touch. Specific to ${c.ind}. 3–4 sentences.</p>\n<h4>5-Email Follow-Up Sequence</h4>\nCRITICAL: Write each email COMPLETE — no placeholders. 60–70 words each.\n<div class="script"><span class="slabel">Email 1 — Same Day (Subject: [specific subject for ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Email 2 — Day 2 (Subject: [specific subject])</span><p>[Complete 60-word email]</p></div>\n<div class="script"><span class="slabel">Email 3 — Day 5 (Subject: [specific subject])</span><p>[Complete 60-word email — addresses most common ${c.ind} objection]</p></div>\n<div class="script"><span class="slabel">Email 4 — Day 10 (Subject: [specific subject])</span><p>[Complete 55-word email — mild urgency]</p></div>\n<div class="script"><span class="slabel">Email 5 — Day 21 (Subject: Closing the loop)</span><p>[Complete 45-word breakup email]</p></div>`,
 
    DEAD:`${base}\nWrite ONLY the [DEAD] section. First line: [DEAD]\n\n<div class="quick-win">[One specific action THIS WEEK to re-engage cold leads in ${c.ind}]</div>\n\n<h4>Value in Your Pipeline</h4>\n<p>~${c.dead} leads × ${c.avgLo} avg × 12% re-engagement = approximately $[calculate]. 3 specific reasons leads go cold in ${c.ind}.</p>\n<h4>Re-Engagement Sequence</h4>\n<div class="script"><span class="slabel">Re-engagement Email (Subject: [specific to ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Follow-Up Text — 3 Days Later (under 140 chars)</span><p>[Complete text]</p></div>\n<div class="script"><span class="slabel">Final Email — Day 10 (Subject: Last one from us)</span><p>[Complete 45-word closing email]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[ongoing]</li></ol></div>`,
 
    MKTG:`${base}\nWrite ONLY the [MKTG] section. First line: [MKTG]\n\n<div class="quick-win">[One specific marketing action THIS WEEK for ${c.ind} — 30 minutes or less]</div>\n\n<h4>Marketing Diagnosis</h4>\n<p>Honest assessment based on their diagnostic. Specific to ${c.ind}.</p>\n<h4>The 2 Highest-ROI Channels for ${c.ind}</h4>\n<p>Name the 2 specific channels with data and source names. For each: why it works, how to implement, expected ROI.</p>\n<h4>30-Minute Weekly Content Framework</h4>\n<table><tr><th>Week</th><th>Content Type</th><th>Specific Topic for ${c.ind}</th><th>Platform</th></tr><tr><td>1</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>2</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>3</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>4</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr></table>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    RET:`${base}\nWrite ONLY the [RET] section. First line: [RET]\n\n<div class="quick-win">[One specific retention action THIS WEEK — call or email a specific type of past customer in ${c.ind}]</div>\n\n<h4>Customer Lifetime Value Estimate</h4>\n<p>${c.avgMid} avg × estimated annual frequency × lifespan = ~$[CLV]. Bain & Company: 5% retention = 25–95% profit growth. Industry average retention: ${c.bench.retention}% (${c.bench.source}). Conservative language.</p>\n<h4>The Retention Gap</h4>\n<p>Estimated annual cost of their retention gap. Why ${c.ind} customers stop returning. 3–4 sentences.</p>\n<h4>3-Step Retention System for ${c.ind}</h4>\n<p>Specific touchpoints, timing, channels. Not generic.</p>\n<div class="script"><span class="slabel">30-Day Post-Job Check-In (Email — 70 words)</span><p>[Full email — warm, specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">6-Month Re-Engagement (Text — under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REF:`${base}\nWrite ONLY the [REF] section. First line: [REF]\n\n<div class="quick-win">[One specific referral action THIS WEEK — ask a specific type of recent ${c.ind} customer]</div>\n\n<h4>The Referral Math for ${c.ind}</h4>\n<p>Each activated customer → ~1.2 referrals × ${c.avgLo} avg × ~55% conversion = ~$[calculate]. Industry referral average: ${c.bench.referralPct}% (${c.bench.source}). Texas Tech / Wharton: referred customers have 16–25% higher LTV.</p>\n<h4>The Systematic Referral Process for ${c.ind}</h4>\n<p>When to ask, how to ask, what to offer — specific to ${c.ind}. 2–3 sentences.</p>\n<div class="script"><span class="slabel">Referral Ask Script (word-for-word at job completion)</span><p>[Complete 75-word script — specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">Referral Thank-You (Text — under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    PRICE:`${base}\nWrite ONLY the [PRICE] section. First line: [PRICE]\n\n<div class="quick-win">[One specific pricing action THIS WEEK — test a price increase on new quotes starting today]</div>\n\n<h4>The Pricing Opportunity</h4>\n<p>McKinsey: 1% price improvement = ~11% profit improvement. Conservative 6% adjustment on ${c.revLo} = approximately $[calculate] annually. How ${c.ind} businesses test increases without losing customers.</p>\n<h4>The Price Increase Test Methodology</h4>\n<p>How to safely test a 7–10% increase in ${c.ind}. What signals confirm it's working. 3–4 sentences.</p>\n<h4>Premium Tier Example for ${c.ind}</h4>\n<p>Specific Good / Better / Best structure — approximate prices, what each tier includes.</p>\n<div class="script"><span class="slabel">Price Increase Communication Script</span><p>[Complete 70-word script — confident, value-focused]</p></div>\n<div class="script"><span class="slabel">Premium Tier Presentation Script</span><p>[Complete 70-word script — presents 3 options naturally]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REV:`${base}\nWrite ONLY the [REV] section. First line: [REV]\n\n<div class="quick-win">[One specific review action THIS WEEK — send review request to a specific group of recent customers]</div>\n\n<h4>The Review-to-Revenue Connection for ${c.ind}</h4>\n<p>BrightLocal: 93% of consumers check reviews. Moz: reviews account for ~15% of local search ranking. Industry average for ${c.bench.label}: ${c.bench.reviewCount} reviews (${c.bench.source}). Direct link between review volume and inbound lead flow in ${c.ind}.</p>\n<h4>Systematic Review Request Process</h4>\n<p>Exact timing, channel, message for ${c.ind}. When to ask, how to make it easy.</p>\n<div class="script"><span class="slabel">Review Request Text — 24–48 Hours After Completion (under 140 chars)</span><p>[Complete text with [your Google review link]]</p></div>\n<div class="script"><span class="slabel">Follow-Up If No Review — 5 Days Later (under 140 chars)</span><p>[Complete follow-up — gentle]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    OPS:`${base}\nWrite ONLY the [OPS] section. First line: [OPS]\n\n<div class="quick-win">[One specific operations action THIS WEEK — document one process or implement one quality checkpoint in ${c.ind}]</div>\n\n<h4>The True Cost of Quality Issues in ${c.ind}</h4>\n<p>Each complaint costs 4–6x the transaction value. At ${c.avgLo} avg, each avoidable complaint costs approximately $[calculate]. Annual impact at their complaint rate.</p>\n<h4>The 3 Critical SOPs for ${c.ind}</h4>\n<p>Name and describe the 3 most impactful SOPs specifically for ${c.ind}. For each: what it covers, key steps, what breaks without it.</p>\n<h4>Quality Control in Practice</h4>\n<p>How top-performing ${c.ind} businesses build quality checkpoints without significant overhead. 2–3 sentences with a specific example.</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li></ol></div>`,
 
    PRIORITY:`${base}\nWrite ONLY the [PRIORITY] section. First line: [PRIORITY]\n\n<h4>Priority Rankings for ${c.biz}</h4>\n<table><tr><th>Rank</th><th>Category</th><th>Est. Opportunity</th><th>Conservative 90-Day Target</th><th>First Action This Week</th></tr>\n${c.L.cats.map((cat,i)=>`<tr><td><strong>#${i+1}</strong></td><td>${cat.n}</td><td>~$${cat.amt.toLocaleString()}</td><td>$${Math.round(cat.amt*0.15).toLocaleString()}–$${Math.round(cat.amt*0.25).toLocaleString()}</td><td>[1 specific first step for ${c.ind}]</td></tr>`).join('\n')}\n</table>\n<p>Write 2 paragraphs explaining the sequencing strategy — why this order maximizes early results for ${c.biz} in ${c.ind}. Specific, conservative language.</p>`,
 
    PLAN:`${base}\nWrite ONLY the [PLAN] section. First line: [PLAN]\n\nEvery task SPECIFIC to ${c.ind} — not generic. Include real time estimates.\n\n<div class="pgrid">\n<div class="pcard"><div class="ptag">Week 1 — Days 1–7</div><div class="ptitle">Quick Wins</div>\n<div class="ptask">Day 1 (time): [specific ${c.ind} task]</div>\n<div class="ptask">Day 2 (time): [specific task]</div>\n<div class="ptask">Day 3 (time): [specific task]</div>\n<div class="ptask">Day 4 (time): [specific task]</div>\n<div class="ptask">Day 5 (time): [specific task]</div>\n<div class="ptask">Days 6–7 (time): [specific task]</div>\n<div class="pmile">Day 30 milestone: [3–4 specific measurable outcomes with numbers]</div>\n</div>\n<div class="pcard"><div class="ptag">Week 2 — Days 8–14</div><div class="ptitle">Foundation</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="pmile">Day 60 milestone: [specific measurable outcomes]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 2 — Days 31–60</div><div class="ptitle">Momentum</div>\n<div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 3 — Days 61–90</div><div class="ptitle">Systematize</div>\n<div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div>\n<div class="pmile">Day 90 milestone: [specific metrics for ${c.ind}]</div>\n</div>\n</div>`,
 
    ROI:`${base}\nWrite ONLY the [ROI] section. First line: [ROI]\n\n<h4>Conservative Recovery Projection</h4>\n<table>\n<tr><th>Scenario</th><th>Recovery Rate</th><th>Month 1 Est.</th><th>Month 2 Est.</th><th>Month 3 Est.</th><th>90-Day Total</th></tr>\n<tr><td>Conservative</td><td>15%</td><td>~$${Math.round(c.L.total*0.15*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15*0.50).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td></tr>\n<tr><td>Realistic</td><td>22%</td><td>~$${Math.round(c.L.total*0.22*0.20).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22*0.55).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td></tr>\n<tr><td>Optimistic</td><td>32%</td><td>~$${Math.round(c.L.total*0.32*0.25).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32*0.60).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td></tr>\n</table>\n<p>Explain what drives each scenario. Be honest that results vary.</p>\n<h4>Report ROI</h4>\n<p>At realistic scenario: ~$${Math.round(c.L.total*0.22).toLocaleString()} in 90 days on a $497 investment = approximately ${Math.round(c.L.total*0.22/497)}x return. Converting just ${Math.ceil(497/c.L.meta.avgLo)} additional dormant leads covers the cost of this report.</p>\n<div class="disclaimer">All projections are estimates. Results depend on consistent implementation, your market, and your specific circumstances.</div>\n<h4>Your Single Most Important Action in the Next 48 Hours</h4>\n<p>[Single most impactful, specific first action for ${c.biz} in ${c.ind} based on their #1 opportunity. 80–100 words. Exact steps. Specific to ${c.ind}.]</p>`,
  };
 
  return prompts[key] || `${base}\nWrite the [${key}] section for ${c.biz}, a ${c.ind} business. First line must be exactly: [${key}]`;
}
 
// ══════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`RevAnalysis worker running on port ${PORT}`));