 
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
    console.log(`Completed job for ${job.email}`);
  } catch(e) {
    console.error(`Job failed for ${job.email}:`, e.message);
  }
  isProcessing = false;
  if (queue.length > 0) processNext();
}
 
// ══════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'RevAnalysis worker running', queueLength: queue.length, isProcessing }));
app.get('/status', (req, res) => res.json({ queueLength: queue.length, isProcessing, jobs: queue.map(j => ({ email: j.email, bizName: j.bizName })) }));
 
app.post('/resend', async (req, res) => {
  const { email, adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  let job = jobStore[email];

  // If not in memory, try to reconstruct from Supabase
  if (!job) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (url && key) {
      try {
        const r = await fetch(
          `${url}/rest/v1/diagnostics?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`,
          { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
        );
        const rows = await r.json();
        if (rows && rows.length > 0) {
          const row = rows[0];
          // Reconstruct calcData from Supabase fields
          const calcData = {
            total: row.total_opportunity || 0,
            totalLo: row.total_lo || 0,
            totalHi: row.total_hi || 0,
            cats: row.cats || [],
            sc: row.scores || {},
            overallScore: row.overall_score || 0,
            meta: {
              revMid: row.revenue_mid || 0,
              revLo: Math.round((row.revenue_mid || 0) * 0.6),
              revHi: Math.round((row.revenue_mid || 0) * 1.5),
              avgMid: row.avg_transaction_mid || 0,
              avgLo: Math.round((row.avg_transaction_mid || 0) * 0.6),
              close: row.close_rate || 0.5,
              revLabel: row.revenue_range || '',
              avgLabel: '',
              mthLeads: Math.max(1, Math.round((row.revenue_mid||0) / (row.avg_transaction_mid||1) / 12)),
              annCusts: Math.max(1, Math.round((row.revenue_mid||0) / (row.avg_transaction_mid||1))),
              dead: (row.answers && row.answers.deadLeads !== undefined) ? [5,20,50,112,175][Math.min(row.answers.deadLeads,4)] : 20,
              retRate: (row.answers && row.answers.repeatRate !== undefined) ? [0.07,0.15,0.27,0.42,0.60][Math.min(row.answers.repeatRate,4)] : 0.15,
              refRate: (row.answers && row.answers.referralPct !== undefined) ? [0.07,0.15,0.27,0.42,0.60][Math.min(row.answers.referralPct,4)] : 0.10,
              reviewBand: (row.answers && row.answers.reviewVolume !== undefined) ? ['<10','11-30','31-100','100+'][Math.min(row.answers.reviewVolume,3)] : '<10',
              reviewBandN: (row.answers && row.answers.reviewVolume !== undefined) ? [5,20,65,120][Math.min(row.answers.reviewVolume,3)] : 5,
            }
          };
          job = {
            email: row.email,
            firstName: row.first_name || '',
            lastName: row.last_name || '',
            title: row.title || '',
            bizName: row.biz_name || '',
            industry: row.industry || '',
            calcData,
            answers: row.answers || {},
            consentBenchmark: row.consent_benchmark || false,
          };
          jobStore[email] = job;
          console.log(`Reconstructed job for ${email} from Supabase`);
        }
      } catch(e) {
        console.warn('Supabase job reconstruction failed:', e.message);
      }
    }
  }

  if (!job) return res.status(404).json({ error: `No job found for ${email} — not in memory or Supabase` });

  if (job.completedHtml) {
    let pdfBase64 = job.completedPdf || null;
    if (!pdfBase64) {
      console.log(`PDF not cached for ${email} — regenerating...`);
      try {
        pdfBase64 = await generatePDF(job.completedHtml);
        job.completedPdf = pdfBase64;
        console.log(`PDF regenerated for ${email}`);
      } catch(e) {
        console.error(`PDF regeneration failed for ${email}:`, e.message);
      }
    }

    sendEmail({
      to: email, firstName: job.firstName||'', bizName: job.bizName,
      calcData: job.calcData,
      pdfBase64
    })
      .then(() => console.log(`Instant resend complete for ${email}`))
      .catch(e => console.error(`Resend email failed:`, e.message));
    return res.status(200).json({ queued: false, instant: true, email, message: 'Report resent with PDF attached' });
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

// QA: fetch a completed report directly. PDF if cached, else HTML, else 404.
app.get('/admin/report', (req, res) => {
  const { email, adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const job = email ? jobStore[email] : null;
  if (!job || (!job.completedPdf && !job.completedHtml)) {
    return res.status(404).json({ error: `No completed report in memory for ${email || '(missing email param)'}` });
  }
  if (job.completedPdf) {
    const buf = Buffer.from(job.completedPdf, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="RevAnalysis-Report-${String(email).replace(/[^a-zA-Z0-9@._-]/g, '')}.pdf"`);
    return res.send(buf);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(job.completedHtml);
});

app.post('/generate', (req, res) => {
  const { email, firstName, lastName, title, bizName, industry, city, calcData, answers, consentBenchmark, paidAt } = req.body;
  if (!email || !calcData) return res.status(400).json({ error: 'Missing required fields' });
  jobStore[email] = { email, firstName:firstName||'', lastName:lastName||'', title:title||'', bizName, industry, city:city||'', calcData, answers, consentBenchmark:consentBenchmark||false, savedAt: new Date().toISOString() };
  
  saveToSupabase({
    email,
    first_name: firstName||'',
    last_name: lastName||'',
    title: title||'',
    biz_name: bizName,
    industry,
    city: city||'',
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
    paid_at: paidAt || null,
  }).catch(e => console.warn('Supabase intake save failed:', e.message));

  enqueue({ email, firstName:firstName||'', lastName:lastName||'', title:title||'', city:city||'', bizName, industry, calcData, answers, consentBenchmark:consentBenchmark||false });
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
    return { closeRate:58, retention:28, referralPct:20, reviewCount:42, label:'Service businesses', source:'IBISWorld + BrightLocal' };
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
    // If we have an email, try to find an existing row from the quiz save
    // (same biz + first name, no email yet) and update it instead of inserting
    if (data.email) {
      const findR = await fetch(
        `${url}/rest/v1/diagnostics?email=eq.${encodeURIComponent(data.email)}&order=created_at.desc&limit=1&select=id`,
        { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
      );
      if (findR.ok) {
        const rows = await findR.json();
        if (rows && rows.length > 0) {
          // Found existing quiz row — update it with email + paid data
          const patchR = await fetch(
            `${url}/rest/v1/diagnostics?id=eq.${rows[0].id}`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'apikey': key,
                'Authorization': `Bearer ${key}`
              },
              body: JSON.stringify(data)
            }
          );
          if (patchR.ok) {
            console.log(`Updated existing quiz row for ${data.email}`);
          } else {
            console.warn(`Supabase patch failed ${patchR.status}`);
          }
          return;
        }
      }
    }

    // No existing row found — insert fresh
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
      console.log(`Saved to Supabase for ${data.email}`);
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
    console.log(`Supabase delivery status updated for ${email}`);
  } catch(e) {
    console.warn('Supabase update error:', e.message);
  }
}

 
// ══════════════════════════════════════════════════
//  MAIN GENERATION
// ══════════════════════════════════════════════════
async function generateAndSend({ email, firstName, lastName, title, bizName, industry, city, calcData, answers, consentBenchmark }) {

  const SECTION_KEYS = ['EXEC','QUICKWIN','BENCH','SPEED','CONV','DEAD','RET','PRICE','CASH','OPS','LEVERAGE','SYSTEMS','REF','PRIORITY','ROADMAP','ROI'];

  // 6 batches (4x3 + 2x2) — safe for Tier 1 output TPM limits
  // Sequence matters: narrative sections first, dependent sections last
  const BATCHES = [
    ['EXEC', 'QUICKWIN', 'BENCH'],
    ['SPEED', 'CONV', 'DEAD'],
    ['RET', 'PRICE', 'CASH'],
    ['OPS', 'LEVERAGE', 'SYSTEMS'],
    ['REF', 'PRIORITY'],
    ['ROADMAP', 'ROI']
  ];

  const sections = {};
  const ctx = buildServerContext(bizName, industry, calcData, answers, firstName, lastName, title, city);

  console.log(`Starting parallel generation for ${bizName} (${email}) — ${BATCHES.length} batches`);

  for (let b = 0; b < BATCHES.length; b++) {
    const batch = BATCHES[b];
    console.log(`  Batch ${b+1}/${BATCHES.length}: [${batch.join(', ')}]`);
    const batchStart = Date.now();

    await Promise.all(batch.map(async (key) => {
      let attempt = 0;
      while (attempt < 3) {
        try {
          const prompt = buildSectionPrompt(key, ctx);
          const result = await callAnthropicWithTokens(prompt, 2400);
          // ... rest unchanged
          const parsed = parseSecs(result);
          const content = parsed[key] || Object.values(parsed)[0];
          if (!content) throw new Error('Empty response from AI');
          sections[key] = content;
          console.log(`    ${key} (${Date.now() - batchStart}ms)`);
          break;
        } catch(e) {
          attempt++;
          console.warn(`    ${key} attempt ${attempt}/3: ${e.message}`);

          if (e.message.includes('429') || e.message.includes('rate')) {
            // Rate limit hit — wait longer before retry
            const waitMs = attempt * 30000;
            console.log(`    Rate limit on ${key} — waiting ${waitMs/1000}s...`);
            await sleep(waitMs);
          } else if (attempt < 3) {
            await sleep(10000);
          } else {
            // After 3 failures, use fallback content rather than killing the whole job
            console.error(`    ${key} failed after 3 attempts — using fallback`);
            sections[key] = `<p>This section encountered a generation error. Please contact support@revanalysis.com and we will resend your complete report within 24 hours.</p>`;
          }
        }
      }
    }));

    const batchTime = Date.now() - batchStart;
    console.log(`  Batch ${b+1} complete in ${Math.round(batchTime/1000)}s`);

    // Buffer between batches — gives TPM bucket time to refill
    // 5s is enough for Tier 1, reduce to 2s once you upgrade to Tier 2
    if (b < BATCHES.length - 1) {
      await sleep(5000);
    }
  }

  console.log(`All ${SECTION_KEYS.length} sections done. Building report...`);

  // Rest of generateAndSend stays the same...
  const reportHtml = buildEmailHtml(firstName, bizName, industry, calcData, sections);
  let pdfBase64 = null;
  try {
    pdfBase64 = await generatePDF(reportHtml);
    console.log('PDF generated');
  } catch(e) {
    console.error('PDF generation failed:', e.message);
  }

  await sendEmail({
    to: email, firstName, bizName,
    calcData,
    pdfBase64
  });

  jobStore[email].completedHtml = reportHtml;
  jobStore[email].completedPdf = pdfBase64;
  jobStore[email].completedAt = new Date().toISOString();
  console.log(`Report delivered to ${email}`);
  updateSupabaseDelivered(email);
}
 
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
// ══════════════════════════════════════════════════
//  SVG CHART HELPERS
// ══════════════════════════════════════════════════
function svgBarChart(cats) {
  const maxAmt = Math.max(...cats.map(c => c.amt), 1);
  const COLORS = { h:'#C1502E', m:'#B07A2A', l:'#6B7245' };
  const rowH=44, labelW=190, barZone=340, height=cats.length*rowH+40, width=620;
  const rows = cats.map((cat, i) => {
    const barW = Math.max(4, Math.round((cat.amt/maxAmt)*barZone));
    const y = 20+i*rowH, color = COLORS[cat.sev]||'#6B7245';
    const label = cat.n.length>28 ? cat.n.substring(0,27)+'…' : cat.n;
    return `<text x="${labelW-8}" y="${y+16}" font-family="Arial,sans-serif" font-size="11.5" fill="#4A423C" text-anchor="end" dominant-baseline="middle">${label}</text>
      <rect x="${labelW}" y="${y+4}" width="${barW}" height="22" rx="4" fill="${color}" opacity="0.82"/>
      <text x="${labelW+barW+7}" y="${y+16}" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="${color}" dominant-baseline="middle">~$${cat.amt.toLocaleString()}/mo</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${width}" height="${height}" rx="4" fill="#F7F5F2"/>${rows}</svg>`;
}
 
function svgLineChart(total) {
  const c15=Math.round(total*0.15), c22=Math.round(total*0.22), c32=Math.round(total*0.32);
  const datasets=[
    {label:'Conservative (15%)',color:'#B07A2A',values:[0,Math.round(c15*0.15),Math.round(c15*0.50),c15]},
    {label:'Realistic (22%)',color:'#C1502E',values:[0,Math.round(c22*0.20),Math.round(c22*0.55),c22]},
    {label:'Optimistic (32%)',color:'#6B7245',values:[0,Math.round(c32*0.25),Math.round(c32*0.60),c32]},
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="4" fill="#F7F5F2"/>${grids}<line x1="${padL}" y1="${padT+chartH}" x2="${W-padR}" y2="${padT+chartH}" stroke="#D9D4CC" stroke-width="1.5"/>${xLabels}${lines}${legend}</svg>`;
}
 
function svgScoreChart(sc) {
  const cats=[
    {label:'Conversion',score:sc.conversion,bench:65},{label:'Speed to lead',score:sc.speed,bench:60},
    {label:'Retention',score:sc.retention,bench:60},{label:'Pricing',score:sc.pricing,bench:60},
    {label:'Cash flow',score:sc.cashflow,bench:60},{label:'Operations',score:sc.operations,bench:65},
    {label:'Owner leverage',score:sc.leverage,bench:55},
  ].filter(c => typeof c.score === 'number' && !isNaN(c.score));
  const W=580,rowH=34,padL=90,padR=20,padT=16,barW=W-padL-padR,H=padT+cats.length*rowH+28;
  const rows=cats.map((cat,i)=>{
    const y=padT+i*rowH,yourW=Math.round((cat.score/100)*barW),benchX=padL+Math.round((cat.bench/100)*barW);
    const color=cat.score>=cat.bench?'#6B7245':cat.score>=cat.bench*0.7?'#B07A2A':'#C1502E';
    return `<text x="${padL-8}" y="${y+14}" font-family="Arial,sans-serif" font-size="11" fill="#4A423C" text-anchor="end">${cat.label}</text>
      <rect x="${padL}" y="${y+4}" width="${barW}" height="16" rx="3" fill="#E8E4DE"/>
      <rect x="${padL}" y="${y+4}" width="${yourW}" height="16" rx="3" fill="${color}" opacity="0.8"/>
      <line x1="${benchX}" y1="${y}" x2="${benchX}" y2="${y+24}" stroke="#9A8C80" stroke-width="1.5" stroke-dasharray="3,2"/>
      <text x="${padL+yourW+5}" y="${y+15}" font-family="Arial,sans-serif" font-size="10" fill="${color}" font-weight="bold">${cat.score}</text>`;
  }).join('');
  const benchLegendX=padL+Math.round(0.60*barW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="4" fill="#F7F5F2"/>${rows}<text x="${benchLegendX}" y="${H-8}" font-family="Arial,sans-serif" font-size="9.5" fill="#6E6259" text-anchor="middle">--- Industry benchmark</text></svg>`;
}
 
// ══════════════════════════════════════════════════
//  EMAIL / PDF HTML BUILDER — Workbench theme
//  White #FFFFFF background (print-clean), ink #2B2320 text
//  Poppins 800 title + section headings, Inter body
//  Terracotta #C1502E accents, olive #6B7245 support
// ══════════════════════════════════════════════════
// Display-only monthly rounding: nearest $50 under $2k/mo, else nearest $100
function moRound(n) { const m = n / 12; const s = m >= 2000 ? 100 : 50; return Math.max(s, Math.round(m / s) * s); }

function buildEmailHtml(firstName, bizName, industry, calcData, sections) {
  const L = calcData;
  const date = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  const rec22 = Math.round(L.total * 0.22);
  const bench = getIndustryBenchmarks(industry);
 
  const sectionKeys = ['EXEC','QUICKWIN','BENCH','SPEED','CONV','DEAD','RET','PRICE','CASH','OPS','LEVERAGE','SYSTEMS','REF','PRIORITY','ROADMAP','ROI'];
  const sectionTitles = {
    EXEC:'Executive Summary',
    QUICKWIN:'Do This Week',
    BENCH:'Your Numbers vs The Benchmarks',
    SPEED:'Speed-to-Lead',
    CONV:'Close Rate & Sales Process',
    DEAD:'Dead & Dormant Leads',
    RET:'Customer Retention',
    PRICE:'Pricing Power',
    CASH:'Cash Flow & Job Costing',
    OPS:'Capacity, Scheduling & Quality',
    LEVERAGE:'Owner Leverage',
    SYSTEMS:'Systems & Automation Audit',
    REF:'Referrals & Reviews: The Free Lead Engine',
    PRIORITY:'Your Fix Order',
    ROADMAP:'90-Day Structured Roadmap',
    ROI:'Revenue Recovery Projection'
  };
  // All 8 quantified quiz buckets map to a section
  const catKeyMap = { SPEED:'Speed', CONV:'Close rate', DEAD:'dormant', RET:'Retention', PRICE:'Pricing', CASH:'Cash', OPS:'Capacity', LEVERAGE:'Owner leverage' };
 
  const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@700;800&display=swap');

/* ── Reset ── */
* { box-sizing: border-box; margin: 0; padding: 0; }
 
/* ── Base — white Workbench ── */
body {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  background: #FFFFFF;
  color: #2B2320;
  font-size: 11px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 28px 16px; }
 
/* ── COVER — white, ink + terracotta ── */
.cover {
  background: #FFFFFF;
  border: 1px solid #E8E4DE;
  border-radius: 14px;
  padding: 48px 44px;
  margin-bottom: 20px;
  color: #2B2320;
  position: relative;
  overflow: visible;
}
 
/* ── KPI STRIP ── */
.kpi-strip {
  background: white; border-radius: 12px;
  padding: 0; margin-bottom: 16px;
  border: 1px solid #E8E4DE;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.kpi-row { display: table; width: 100%; }
.kpi-cell {
  display: table-cell; text-align: center;
  padding: 20px 12px;
  border-right: 1px solid #E8E4DE;
  vertical-align: middle;
}
.kpi-cell:last-child { border-right: none; }
.kpi-val {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif;
  font-size: 22px; font-weight: 800;
  line-height: 1.1; margin-bottom: 5px;
}
.kpi-lbl {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 9.5px; color: #9A8C80;
  text-transform: uppercase; letter-spacing: .1em;
  font-weight: 600;
}
 
/* ── BENCHMARK STRIP ── */
.bench-strip {
  background: white; border: 1px solid #E8E4DE;
  border-radius: 12px; padding: 20px 22px;
  margin-bottom: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.bench-head {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 10px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #6E6259; margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 2px solid #C1502E;
}
.bench-row { display: table; width: 100%; border-collapse: separate; border-spacing: 8px; }
.bench-cell { display: table-cell; width: 25%; }
.bench-metric-box {
  background: #F7F5F2; border: 1px solid #E8E4DE;
  border-radius: 10px; padding: 14px 10px; text-align: center;
}
.bm-lbl {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 9px; color: #9A8C80;
  text-transform: uppercase; letter-spacing: .08em;
  margin-bottom: 8px; font-weight: 600;
}
.bm-you { font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 20px; font-weight: 800; line-height: 1; }
.bm-vs { font-family: 'Inter', Helvetica, Arial, sans-serif; font-size: 9px; color: #9A8C80; margin: 5px 0 3px; }
.bm-bench-val { font-family: 'Inter', Helvetica, Arial, sans-serif; font-size: 11px; color: #6E6259; margin-bottom: 6px; }
.bm-tag {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 9px; font-weight: 700;
  padding: 3px 8px; border-radius: 20px;
  display: inline-block; letter-spacing: .04em;
}
 
/* ── CHART SECTION ── */
.chart-section {
  background: white; border: 1px solid #E8E4DE;
  border-radius: 12px; margin-bottom: 16px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.chart-head {
  background: #FFFFFF; padding: 13px 22px;
  border-bottom: 2px solid #E8E4DE;
  display: flex; align-items: center; gap: 12px;
}
.sec-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  background: rgba(193,80,46,0.10);
  color: #C1502E; font-size: 11px; font-weight: 700;
  border-radius: 6px; flex-shrink: 0;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  letter-spacing: .04em;
}
.sec-title-h {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 14px;
  font-weight: 800; color: #2B2320;
}
.chart-body { padding: 20px 22px; }
.chart-label {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #9A8C80; margin-bottom: 12px;
}
.chart-wrap {
  background: #F7F5F2; border: 1px solid #E8E4DE;
  border-radius: 8px; padding: 14px; margin-bottom: 14px;
}
.chart-wrap:last-child { margin-bottom: 0; }
 
/* ── REPORT SECTIONS ── */
.rsec {
  background: white; border: 1px solid #E8E4DE;
  border-radius: 12px; margin-bottom: 12px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.rsec-head {
  background: #FFFFFF;
  border-bottom: 2px solid #E8E4DE;
  padding: 8px 16px;
  display: flex; align-items: center; justify-content: space-between;
}
.rsec-left { display: flex; align-items: center; gap: 10px; }
.rsec-head .sec-num { width: 20px; height: 20px; font-size: 9.5px; border-radius: 5px; }
.rsec-title {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 12px;
  font-weight: 800; color: #2B2320; letter-spacing: 0;
}
.rsec-amt {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 12px;
  font-weight: 800; color: #C1502E; white-space: nowrap;
}
.rsec-body { padding: 14px 18px; background: white; }
 
/* ── BODY CONTENT ── */
p {
  margin-bottom: 9px; color: #4A423C;
  font-size: 11px; line-height: 1.4;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
p:last-child { margin-bottom: 0; }
strong { font-weight: 700; color: #2B2320; }
 
/* Section subheadings */
h4 {
  font-family: 'Inter', Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 700;
  color: #2B2320; margin: 14px 0 7px;
  padding-bottom: 5px;
  border-bottom: 2px solid #E8E4DE;
  display: flex; align-items: center; gap: 8px;
}
h4::before {
  content: '';
  display: inline-block; width: 4px; height: 12px;
  background: #C1502E; border-radius: 2px; flex-shrink: 0;
}
h5 {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 9px; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase;
  color: #6B7245; margin-bottom: 8px;
}
 
/* Lists */
ul { margin: 6px 0 10px; padding: 0; list-style: none; }
ul li {
  display: flex; gap: 8px; margin-bottom: 5px;
  font-size: 11px; color: #5A5049; line-height: 1.4;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
ul li::before { content: '→'; color: #6B7245; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
 
ol { margin: 6px 0 10px; padding: 0; list-style: none; counter-reset: steps; }
ol li {
  display: flex; gap: 10px; margin-bottom: 7px;
  font-size: 11px; color: #5A5049; line-height: 1.4;
  counter-increment: steps; font-family: 'Inter', Helvetica, Arial, sans-serif;
  padding: 6px 10px; background: #F7F5F2;
  border: 1px solid #E8E4DE; border-radius: 8px;
}
ol li::before {
  content: counter(steps);
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 50%;
  background: rgba(107,114,69,0.12); color: #6B7245;
  font-size: 9px; font-weight: 700; flex-shrink: 0;
  font-family: 'Inter', Helvetica, Arial, sans-serif; margin-top: 1px;
}
 
/* ── QUICK WIN — amber, prominent ── */
.quick-win {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-left: 5px solid #B07A2A;
  border-radius: 0 10px 10px 0;
  padding: 8px 12px; margin: 0 0 12px 0;
  font-size: 11px; color: #78350f; font-weight: 600;
  line-height: 1.45; font-family: 'Inter', Helvetica, Arial, sans-serif;
}
 
/* ── SCRIPTS ── */
.script {
  background: #F7F5F2;
  border: 1px solid #E8E4DE;
  border-radius: 10px;
  padding: 0; margin: 8px 0; overflow: hidden;
}
.slabel {
  display: block;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 8.5px; font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase;
  color: #6B7245;
  padding: 6px 12px;
  border-bottom: 1px solid #E8E4DE;
  background: #F0EDE8;
}
.script p {
  color: #4A423C !important;
  font-size: 10.5px;
  line-height: 1.45; margin: 0;
  padding: 8px 12px;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
.script strong { color: #2B2320 !important; }
 
/* ── ACTION BOX ── */
.action-box {
  background: #F7F5F2;
  border: 1px solid #E8E4DE;
  border-left: 5px solid #6B7245;
  border-radius: 0 10px 10px 0;
  padding: 10px 14px; margin: 8px 0;
}
.action-box h5 {
  color: #6B7245; margin-bottom: 8px;
}
 
/* ── STAT CALLOUT ── */
.stat-call {
  background: rgba(107,114,69,0.08);
  border: 1px solid rgba(107,114,69,0.2);
  border-left: 5px solid #6B7245;
  border-radius: 0 10px 10px 0;
  padding: 8px 12px; margin: 8px 0;
  font-size: 10.5px; color: #4A5230;
  font-weight: 600; line-height: 1.45;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
 
/* ── DISCLAIMER ── */
.disclaimer {
  background: #F7F5F2; border: 1px solid #E8E4DE;
  border-radius: 8px; padding: 7px 10px;
  margin: 8px 0; font-size: 9.5px;
  color: #9A8C80; line-height: 1.45;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
 
/* ── TABLES ── */
table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10.5px; }
thead tr { background: #2B2320; }
th {
  background: #2B2320; color: #FFF8F0;
  padding: 6px 10px; text-align: left;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 8.5px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
}
th:first-child { border-radius: 6px 0 0 0; }
th:last-child { border-radius: 0 6px 0 0; }
td {
  padding: 6px 10px;
  border-bottom: 1px solid #E8E4DE;
  color: #5A5049; vertical-align: top;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 10.5px;
}
tr:last-child td { border-bottom: none; }
tr:nth-child(even) td { background: #F7F5F2; }
tr:hover td { background: #F0EDE8; }
 
/* ── PLAN GRID ── */
.pgrid { display: block; }
.pcard {
  background: #F7F5F2;
  border: 1px solid #E8E4DE;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 8px;
}
.ptag {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase;
  color: #FFF8F0; margin-bottom: 4px;
  background: #6B7245; display: inline-block;
  padding: 3px 10px; border-radius: 20px;
  margin-bottom: 8px;
}
.ptitle {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 800;
  color: #2B2320; margin-bottom: 8px;
}
.ptask {
  display: flex; gap: 8px; margin-bottom: 5px;
  font-size: 10.5px; color: #5A5049; line-height: 1.4;
  align-items: flex-start; font-family: 'Inter', Helvetica, Arial, sans-serif;
}
.ptask::before {
  content: '→'; color: #6B7245; flex-shrink: 0;
  font-weight: 700; margin-top: 1px;
}
.pmile {
  background: #FFFFFF; border: 1px solid #E8E4DE; border-radius: 8px;
  padding: 7px 10px; margin-top: 8px;
  font-size: 10px; color: #4A5230;
  font-weight: 600; line-height: 1.45;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  border-left: 4px solid #C1502E;
}
 
/* ── FOOTER ── */
.footer {
  background: #FFFFFF; border: 2px solid #C1502E; border-radius: 12px;
  padding: 32px; text-align: center; margin-top: 20px;
}
.footer h3 {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif;
  font-size: 20px; font-weight: 800;
  color: #2B2320; margin-bottom: 8px;
}
.footer p {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; color: #9A8C80;
  margin-bottom: 3px;
}
blockquote {
  background: #F7F5F2; border: 1px solid #E8E4DE; border-radius: 8px;
  padding: 10px 14px; margin: 8px 0;
  color: #4A423C; font-size: 10.5px;
  line-height: 1.5;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  border-left: 4px solid #6B7245;
}
 
/* ── PAGE BREAK RULES (apply always, not just in print) ── */

/* Cover gets its own page */
.cover {
  break-after: always;
  page-break-after: always;
}

/* Section headers must never be orphaned from their content */
.rsec-head {
  break-after: avoid;
  page-break-after: avoid;
}
.chart-head {
  break-after: avoid;
  page-break-after: avoid;
}

/* Headings stay with whatever follows them */
h4 {
  break-after: avoid;
  page-break-after: avoid;
}
h5 {
  break-after: avoid;
  page-break-after: avoid;
}

/* These blocks must never be split across pages */
.action-box {
  break-inside: avoid;
  page-break-inside: avoid;
}
.script {
  break-inside: avoid;
  page-break-inside: avoid;
}
.quick-win {
  break-inside: avoid;
  page-break-inside: avoid;
}
.stat-call {
  break-inside: avoid;
  page-break-inside: avoid;
}
.disclaimer {
  break-inside: avoid;
  page-break-inside: avoid;
}
blockquote {
  break-inside: avoid;
  page-break-inside: avoid;
}
.pcard {
  break-inside: avoid;
  page-break-inside: avoid;
}
.kpi-strip {
  break-inside: avoid;
  page-break-inside: avoid;
}
.bench-strip {
  break-inside: avoid;
  page-break-inside: avoid;
}
.chart-wrap {
  break-inside: avoid;
  page-break-inside: avoid;
}
.bench-metric-box {
  break-inside: avoid;
  page-break-inside: avoid;
}

/* Tables split freely across pages: avoid lives on the smallest unit (tr),
   never on the whole table, so a long table can never force a mostly-empty
   page. The header row repeats on each page via table-header-group. */
table {
  break-inside: auto;
  page-break-inside: auto;
}
thead { display: table-header-group; }
tr {
  break-inside: avoid;
  page-break-inside: avoid;
}
ol li {
  break-inside: avoid;
  page-break-inside: avoid;
}
ul li {
  break-inside: avoid;
  page-break-inside: avoid;
}

/* Large containers must remain splittable: never put break-inside:avoid on
   multi-card stacks, script sequences, checklists, or section bodies. Only
   their smallest child units (above) carry avoid. */
.pgrid, .rsec-body, ol, ul {
  break-inside: auto;
  page-break-inside: auto;
}

/* Headings never orphan at the bottom of a page */
h2, h3 {
  break-after: avoid-page;
  page-break-after: avoid;
}

/* Paragraphs never leave stray lines across page boundaries */
p { orphans: 3; widows: 3; }

/* Every numbered major section starts on a fresh page.
   The dashboard (kpi strip + benchmarks + charts) fills the page after the
   cover, so the first section starting on its own page leaves no gap. */
.rsec {
  break-before: page;
  page-break-before: always;
  break-inside: auto;
  page-break-inside: auto;
}

/* ── PRINT OVERRIDES ── */
@media print {
  body { background: white; }
  .cover { border-radius: 0; }
  .rsec { border-radius: 0; overflow: visible !important; }
  .rsec-head { background: #FFFFFF !important; }
  .script { background: #F7F5F2 !important; }
  .script p { color: #4A423C !important; }
  .footer { border-radius: 0; }
  .chart-section { overflow: visible !important; }
}
`;
 
  // Benchmark comparison strip
  const yourClose = Math.round((L.meta.close||0.65)*100);
  const bm = [
    {label:'Close Rate',you:yourClose+'%',bench:bench.closeRate+'%',youN:yourClose,benchN:bench.closeRate},
    {label:'Retention',you:'~'+Math.round((L.meta.retRate||0.15)*100)+'%',bench:bench.retention+'%',youN:Math.round((L.meta.retRate||0.15)*100),benchN:bench.retention},
    {label:'Referrals',you:'~'+Math.round((L.meta.refRate||0.10)*100)+'%',bench:bench.referralPct+'%',youN:Math.round((L.meta.refRate||0.10)*100),benchN:bench.referralPct},
    {label:'Sales Process Score',
      you:`${(L.sc&&L.sc.conversion)||50}`,
      bench:'avg 65',
      youN:(L.sc&&L.sc.conversion)||50,
      benchN:65},  ];
  const bmHtml = `<div class="bench-strip">
    <div class="bench-head">Industry comparison — ${bench.label} (Source: ${bench.source})</div>
    <div class="bench-row">${bm.map(m=>{
      const status = m.youN >= m.benchN ? 'above' : m.youN >= m.benchN * 0.8 ? 'at' : 'below';
      const tagStyle=status==='above'?'background:rgba(107,114,69,.12);color:#6B7245':status==='at'?'background:rgba(176,122,42,.12);color:#B07A2A':'background:rgba(193,80,46,.12);color:#C1502E';
      const numColor=status==='above'?'#6B7245':status==='at'?'#B07A2A':'#C1502E';
      return `<div class="bench-cell"><div class="bench-metric-box"><div class="bm-lbl">${m.label}</div><div class="bm-you" style="color:${numColor}">${m.you}</div><div class="bm-vs">vs avg</div><div class="bm-bench-val">${m.bench}</div><div class="bm-tag" style="${tagStyle}">${status==='above'?'Above avg':status==='at'?'Near avg':'Below avg'}</div></div></div>`;
    }).join('')}</div>
  </div>`;
 
  // Chart section — bar chart shown in monthly figures (display-only conversion)
  const catsMonthly = L.cats.map(c => ({ ...c, amt: moRound(c.amt) }));
  const chartSection = `<div class="chart-section">
    <div class="chart-head"><div class="sec-num">00</div><div class="sec-title-h">Performance Dashboard — Visual Overview</div></div>
    <div class="chart-body">
      <div class="chart-wrap"><div class="chart-label">Estimated monthly leak by category</div>${svgBarChart(catsMonthly)}</div>
      <div class="chart-wrap"><div class="chart-label">Your performance score vs industry benchmark</div>${svgScoreChart(L.sc)}</div>
      <div class="chart-wrap"><div class="chart-label">Conservative 90-day recovery projection</div>${svgLineChart(L.total)}</div>
    </div>
  </div>`;
 
  // Sections — start numbering at 01 (00 is the dashboard)
  let sectionsHtml = '';
  sectionKeys.forEach((k, i) => {
    if (!sections[k]) return;
    const catKey = catKeyMap[k];
    const catMatch = catKey ? L.cats.find(c => c.n.toLowerCase().includes(catKey.toLowerCase())) : null;
    sectionsHtml += `<div class="rsec">
      <div class="rsec-head">
        <div class="rsec-left"><div class="sec-num">${String(i + 1).padStart(2,'0')}</div><div class="rsec-title">${sectionTitles[k]}</div></div>
        ${catMatch?`<div class="rsec-amt">~$${moRound(catMatch.amt).toLocaleString()}/mo</div>`:''}
      </div>
      <div class="rsec-body">${sections[k]}</div>
    </div>`;
  });
 
  // Final contact/booking section — the audit ends with the consultant, not an upsell
  const contactHtml = `<div class="rsec">
    <div class="rsec-head">
      <div class="rsec-left"><div class="sec-num">${String(sectionKeys.filter(k=>sections[k]).length + 1).padStart(2,'0')}</div><div class="rsec-title">Work With Flavio</div></div>
    </div>
    <div class="rsec-body">
      <p>This audit was built by Flavio DeOliveira, not a marketing agency. The same person who wrote the diagnostic math walks businesses through fixing it: systems and AI automation, customer experience, sales process, and day-to-day operations. No ad budgets, no content calendars. Just the operational fixes quantified in the sections above.</p>
      <h4>Your 30-Minute Call With Flavio Is Included</h4>
      <p>Every Revenue Leak Audit includes a 30-minute call with Flavio. Bring this report. We will confirm your top leak, sanity-check the numbers against your real books, and leave you with the first three moves in order. Book your free 30-minute call here: <strong><a href="https://calendly.com/flaviod022/discovery-call-flavio-deoliveira" style="color:#C1502E;">https://calendly.com/flaviod022/discovery-call-flavio-deoliveira</a></strong></p>
      <h4>If You Want The Fixes Implemented For You</h4>
      <ul>
        <li><strong>Systems & automation:</strong> follow-up sequences, quoting, invoicing, and admin automated so the leaks stay closed.</li>
        <li><strong>Sales process:</strong> speed-to-lead, structured follow-up, and close-rate discipline installed and measured.</li>
        <li><strong>Operations & CX:</strong> scheduling, job costing, collections, and the SOPs that let the business run without you.</li>
      </ul>
      <p>Book directly at <strong><a href="https://calendly.com/flaviod022/discovery-call-flavio-deoliveira" style="color:#C1502E;">https://calendly.com/flaviod022/discovery-call-flavio-deoliveira</a></strong> or email <strong><a href="mailto:flaviod022@gmail.com" style="color:#C1502E;">flaviod022@gmail.com</a></strong> with the subject line "Audit walkthrough" and your business name. Replies within one business day.</p>
    </div>
  </div>`;

  const legalHtml = `<div style="background:#F7F5F2;border:1px solid #E8E4DE;border-radius:10px;padding:22px;margin-bottom:16px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9A8C80;margin-bottom:12px;">Important Notices & Disclaimers</div>
    <p style="font-size:12px;color:#6E6259;line-height:1.7;margin-bottom:8px;"><strong style="color:#2B2320;">No Refund Policy:</strong> This report is a personalised, AI-generated diagnostic document. All sales are final once delivered.</p>
    <p style="font-size:12px;color:#6E6259;line-height:1.7;margin-bottom:8px;"><strong style="color:#2B2320;">Not Professional Advice:</strong> Content is for informational purposes only. Consult qualified professionals before making significant business decisions.</p>
    <p style="font-size:12px;color:#6E6259;line-height:1.7;margin-bottom:8px;"><strong style="color:#2B2320;">Estimates Only:</strong> All revenue figures are based on the ranges you self-reported. They are directional estimates, not guarantees.</p>
    <p style="font-size:12px;color:#6E6259;line-height:1.7;margin-bottom:0;"><strong style="color:#2B2320;">Data & Privacy:</strong> Your information is used solely to generate your report and will not be sold to third parties.</p>
  </div>`;
 
  const greeting = firstName ? firstName : '';
  const moTotal = moRound(L.total);
  const coverHtml = `
  <div class="cover" style="min-height:260mm;display:flex;flex-direction:column;justify-content:space-between;">
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:56px;">
        <div style="display:inline-block;">
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;letter-spacing:-0.3px;color:#2B2320;">RevAnalysis</div>
          <div style="height:3px;background:#C1502E;border-radius:2px;margin-top:3px;"></div>
        </div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#6B7245;border:1px solid rgba(107,114,69,.35);padding:4px 12px;border-radius:20px;">Confidential · Revenue Leak Audit</div>
      </div>

      <div style="margin-bottom:44px;">
        <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:40px;font-weight:800;color:#2B2320;line-height:1.1;letter-spacing:-1px;">Revenue Leak Audit</div>
        <div style="width:72px;height:4px;background:#C1502E;border-radius:2px;margin-top:14px;"></div>
      </div>

      <div style="margin-bottom:44px;">
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#9A8C80;margin-bottom:14px;">Prepared for</div>
        <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:34px;font-weight:800;color:#2B2320;line-height:1.15;letter-spacing:-0.5px;margin-bottom:8px;">${greeting || bizName}</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:500;color:#6E6259;margin-bottom:4px;">${bizName}</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#9A8C80;">${industry}</div>
      </div>

      <div style="margin-bottom:44px;">
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#9A8C80;margin-bottom:12px;">Estimated Monthly Leak</div>
        <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:56px;font-weight:800;color:#C1502E;line-height:1;letter-spacing:-2px;margin-bottom:8px;">~$${moTotal.toLocaleString()}/mo</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#6E6259;">about $${L.total.toLocaleString()} a year · conservative range $${L.totalLo.toLocaleString()} – $${L.totalHi.toLocaleString()}</div>
      </div>

      <div style="display:flex;gap:32px;">
        <div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8C80;margin-bottom:4px;">Biggest Leak</div>
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#C1502E;">~$${moRound(L.cats[0].amt).toLocaleString()}/mo</div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:10px;color:#9A8C80;margin-top:2px;">${L.cats[0].n}</div>
        </div>
        <div style="width:1px;background:#E8E4DE;"></div>
        <div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8C80;margin-bottom:4px;">Realistic 90-Day Target</div>
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#6B7245;">~$${Math.round(L.total*0.22).toLocaleString()}</div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:10px;color:#9A8C80;margin-top:2px;">Conservative estimate</div>
        </div>
        <div style="width:1px;background:#E8E4DE;"></div>
        <div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8C80;margin-bottom:4px;">Walkthrough Call</div>
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#6B7245;">30 min</div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:10px;color:#9A8C80;margin-top:2px;">Included with your audit</div>
        </div>
      </div>
    </div>

    <div style="border-top:1px solid #E8E4DE;padding-top:20px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11px;color:#9A8C80;">Generated by RevAnalysis · ${date}</div>
      <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11px;color:#9A8C80;">revanalysis.com</div>
    </div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RevAnalysis Report — ${bizName}</title><style>${css}</style></head>
<body><div class="wrap">
  ${coverHtml}
  <div class="kpi-strip"><div class="kpi-row">
    <div class="kpi-cell"><div class="kpi-val" style="color:#C1502E;">~$${moTotal.toLocaleString()}/mo</div><div class="kpi-lbl">Est. monthly leak</div></div>
    <div class="kpi-cell"><div class="kpi-val" style="color:#6B7245;">~$${moRound(L.cats[0].amt).toLocaleString()}/mo</div><div class="kpi-lbl">Biggest leak</div></div>
    <div class="kpi-cell"><div class="kpi-val" style="color:#6B7245;">~$${rec22.toLocaleString()}</div><div class="kpi-lbl">Realistic 90-day target</div></div>
    <div class="kpi-cell"><div class="kpi-val" style="color:#6B7245;">30 min</div><div class="kpi-lbl">Walkthrough call included</div></div>
  </div></div>
  ${bmHtml}
  ${chartSection}
  ${sectionsHtml}
  ${contactHtml}
  ${legalHtml}
  <div class="footer">
    <h3>Your audit is complete</h3>
    <p>Generated by RevAnalysis &middot; ${date}</p>
    <p>All figures are conservative estimates. PDF copy attached to this email. Your 30-minute call with Flavio is included. <a href="https://calendly.com/flaviod022/discovery-call-flavio-deoliveira" style="color:#C1502E;">Book your 30-minute call with Flavio</a>.</p>
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

async function callAnthropicWithTokens(prompt, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens: maxTokens, messages:[{ role:'user', content:prompt }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data.content.map(b => b.text || '').join('');
}
 
async function generatePDF(html) {
  const r = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Basic ${Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64')}` },
    body: JSON.stringify({ 
      source:html, landscape:false, use_print:true, format:'A4', 
      margin:{ top:'14mm', right:'14mm', bottom:'14mm', left:'14mm' }
    })
  });
  if (!r.ok) { const e = await r.text().catch(()=>''); throw new Error(`PDFShift ${r.status}: ${e.substring(0,200)}`); }
  const buffer = await r.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
 
// Short branded delivery note. The report itself travels ONLY as the attached PDF.
async function sendEmail({ to, firstName, bizName, calcData, pdfBase64 }) {
  const L = calcData || {};
  const moTotal = moRound(L.total || 0);
  const topCat = (Array.isArray(L.cats) && L.cats[0]) ? L.cats[0] : null;
  const topName = topCat ? topCat.n : 'Your biggest leak';
  const topMo = topCat ? moRound(topCat.amt) : 0;
  const rec90 = Math.round((L.total || 0) * 0.22);
  const greeting = firstName ? `, ${firstName}` : '';
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, server-local
  const pdfFilename = `${today}-RevAnalysis-Report.pdf`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Your Revenue Leak Audit</title></head>
<body style="margin:0;padding:0;background:#FAF6EF;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EF;padding:36px 0;"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
      <tr><td style="padding:0 24px 26px;">
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:#2B2320;letter-spacing:-0.3px;">RevAnalysis</div>
        <div style="width:44px;height:3px;background:#C1502E;border-radius:2px;margin-top:4px;"></div>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;color:#2B2320;margin:0 0 22px;">Here is the math${greeting}.</p>
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:46px;font-weight:800;color:#C1502E;line-height:1;letter-spacing:-1px;margin:0 0 6px;">~$${moTotal.toLocaleString()}/mo</div>
        <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#6E6259;margin:0 0 26px;">estimated revenue leaking out of ${bizName || 'your business'} right now</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
          <tr><td style="padding:11px 0;border-top:1px solid #E8E4DE;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#2B2320;">Biggest leak: <strong>${topName}</strong> at ~$${topMo.toLocaleString()}/mo.</td></tr>
          <tr><td style="padding:11px 0;border-top:1px solid #E8E4DE;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#2B2320;">Realistic 90-day recovery: <strong>~$${rec90.toLocaleString()}</strong>.</td></tr>
          <tr><td style="padding:11px 0;border-top:1px solid #E8E4DE;border-bottom:1px solid #E8E4DE;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#2B2320;">Start with page 3: <strong>Do This Week</strong>. One play, under 20 minutes, zero spend.</td></tr>
        </table>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 30px;"><tr><td style="background:#C1502E;border-radius:999px;">
          <a href="https://calendly.com/flaviod022/discovery-call-flavio-deoliveira" style="display:inline-block;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#FFF8F0;text-decoration:none;padding:14px 30px;">Book your 30-minute call with Flavio</a>
        </td></tr></table>
        <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;color:#2B2320;margin:0 0 32px;">Flavio DeOliveira<br><span style="color:#6E6259;">RevAnalysis</span></p>
        <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;color:#9A8C80;border-top:1px solid #E8E4DE;padding-top:16px;margin:0;">Your full report is attached as a PDF. Keep it.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  const payload = {
    from: 'RevAnalysis <reports@revanalysis.com>',
    to: [to],
    subject: `Your audit found ~$${moTotal.toLocaleString()}/mo. The PDF is attached.`,
    html
  };

  // Always attach the PDF when we have one
  if (pdfBase64) {
    payload.attachments = [{
      filename: pdfFilename,
      content: pdfBase64,
      type: 'application/pdf',
      disposition: 'attachment'
    }];
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || `Resend ${r.status}`);
  return data;
}
 
// Hard style rule: no em/en dashes in model output. Spaced dashes become
// commas; any leftover dash chars become hyphens. Applied at the single
// choke point where model output is parsed into sections (parseSecs), so
// it never touches code, comments, or URLs elsewhere in the codebase.
function scrubDashes(html) {
  return html
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, '-');
}

function parseSecs(txt) {
  const out = {};
  const re = /\[([A-Z_]+)\]([\s\S]*?)(?=\[[A-Z_]+\]|$)/g;
  let m;
  while ((m = re.exec(txt)) !== null) if (m[2].trim()) out[m[1]] = scrubDashes(m[2].trim());
  return out;
}
 
// ══════════════════════════════════════════════════
//  CONTEXT + PROMPTS
// ══════════════════════════════════════════════════
// If the industry input does not look like a real industry (test data, company
// names, numerals, long phrases), use a neutral phrase in prose instead of
// parroting it back throughout the report.
function sanitizeIndustry(industry) {
  const raw = (industry || '').trim();
  if (!raw) return 'service business';
  if (raw.split(/\s+/).length > 4) return 'service business';
  if (/\d/.test(raw)) return 'service business';
  if (/\b(test|testing|company|n\/a|none|asdf|xyz)\b/i.test(raw)) return 'service business';
  return raw;
}

function buildServerContext(bizName, industry, calcData, answers, firstName, lastName, title, city) {
  const L = calcData, a = answers || {};
  const top3 = L.cats.slice(0,3).map(c=>`${c.n} (~$${c.amt.toLocaleString()})`).join(', ');
  const goalOpts = ['Convert more of the leads I already get','Stop leads slipping through the cracks','Get past customers buying again','Raise prices without losing customers','Get paid faster and fix cash flow','Get the business running without me'];
  const goal = goalOpts[a.topGoal??0] || 'growing revenue';
  const bench = getIndustryBenchmarks(industry); // benchmarks match on the raw input
  return {
    biz:bizName, ind:sanitizeIndustry(industry),
    firstName:firstName||'', lastName:lastName||'', title:title||'',
    revRange:L.meta.revLabel, revLo:`$${L.meta.revLo.toLocaleString()}`, revMid:`$${L.meta.revMid.toLocaleString()}`,
    avgLo:`$${L.meta.avgLo.toLocaleString()}`, avgMid:`$${L.meta.avgMid.toLocaleString()}`,
    close:`${Math.round(L.meta.close*100)}%`, mthLeads:L.meta.mthLeads, annCusts:L.meta.annCusts, dead:L.meta.dead,
    // In the return object, add:
    teamSize: a.teamSize !== undefined ? [1,2,5,12,25][Math.min(a.teamSize,4)] : 3,
    deadVal: Math.round((L.meta.dead || 20) * 0.12 * (parseInt(String(L.meta.avgLo).replace(/[$,]/g,'')) || 0)),
    // Ops diagnostic context (funnel-v3 quiz answers; safe defaults for older payloads)
    adminH: L.meta.adminH !== undefined ? L.meta.adminH : (a.adminHours !== undefined ? [3,7,15,25][Math.min(a.adminHours,3)] : 8),
    payLabel: ['same day or upfront','within 2 weeks','2-6 weeks','60+ days'][Math.min(a.paymentDays??1,3)],
    jobCostingLabel: ['unknown. bank balance only','rough gut feel','known for main services','tracked per job type'][Math.min(a.jobCosting??1,3)],
    schedLabel: ['chaotic with frequent rework or callbacks','loose with weekly lost time','decent with occasional gaps','tight and optimized'][Math.min(a.schedEff??1,3)],
    ownerDepLabel: ['everything stalls without the owner','major issues and firefighting','minor hiccups. team covers most of it','runs fine without the owner'][Math.min(a.ownerDep??1,3)],
    total:`~$${L.total.toLocaleString()}`, totalRange:`$${L.totalLo.toLocaleString()}–$${L.totalHi.toLocaleString()}`,
    totalMo:`~$${moRound(L.total).toLocaleString()}/month`,
    // Quiz answers the owner marked "I'm not sure" (conservative defaults were applied)
    estKeys: (Array.isArray(a.estimatedKeys) && a.estimatedKeys.length) ? a.estimatedKeys.join(', ') : '',
    top3, goal, bench,
    cats:L.cats.map(c=>`${c.n}: ~$${c.amt.toLocaleString()} (${c.desc})`).join('\n'),
    scores:Object.entries(L.sc).map(([k,v])=>`${k}: ${v}/100`).join(', '),
    city: city || 'your area',
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
- Total opportunity: ${c.totalMo} (about ${c.total}/year; range: ${c.totalRange})
- Top 3: ${c.top3} | Scores: ${c.scores} | Goal: ${c.goal}
- Team size: ~${c.teamSize} people
- Manual admin: ~${c.adminH} hrs/week | Payment collection: ${c.payLabel} | Job costing: ${c.jobCostingLabel}
- Scheduling: ${c.schedLabel} | Owner dependence: ${c.ownerDepLabel}${c.estKeys ? `\n- NOTE: For these inputs the owner answered "not sure" and conservative defaults were applied. Hedge any figure built on them with "estimated"/"roughly": ${c.estKeys}` : ''}
 
INDUSTRY BENCHMARKS (${c.bench.label} — ${c.bench.source}):
- Close rate: ${c.bench.closeRate}% | Retention: ${c.bench.retention}% | Referrals: ${c.bench.referralPct}% | Reviews: ${c.bench.reviewCount}
 
Categories: ${c.cats}
 
RULES — NON-NEGOTIABLE:
1. Numbers first. Open with the dollar figure.
2. Short sentences. One idea each.
3. Pattern-call: "Most businesses like yours do X. That's why they're stuck."
4. Show the math. Walk through it.
5. Make inaction expensive. State the cost.
6. No fluff. No "it's important to consider."
7. Use "you" directly.
8. End with an exact action. Not a suggestion.
9. Scripts: complete, word-for-word, zero placeholders.
10. Use "estimated"/"approximately" for all figures.
11. Specific to their trade and situation. Not generic.
12. Cite by source name: Bain & Company, McKinsey, Salesforce, HBR, CSO Insights, etc.
13. Recovery: "businesses that fix this typically recover 15–25% in 90 days."
14. Reference benchmarks: "The average business in your space closes ${c.bench.closeRate}%. You're at X%. That gap costs $Y."
15. START every section (except EXEC, QUICKWIN, BENCH, REF, PRIORITY, ROADMAP, and ROI) with: <div class="quick-win">Quick Win — [One specific action THIS WEEK — concrete, doable in under 1 hour]</div>. Skip the quick-win div in any section the DEPTH RULE marks as short.
16. NO EMOJIS. No emoji, dingbats, or decorative symbols anywhere in the output. Plain text and the allowed HTML only.
17. INDUSTRY NAMING: use the exact phrase "${c.ind}" at most ONCE per section. Everywhere else write "your business", "your customers", "your trade", or a natural equivalent. Never echo the raw industry input repeatedly.
18. USE ONLY the benchmark figures provided above. Do NOT use your own training knowledge for benchmarks. The retention benchmark for this industry is ${c.bench.retention}%, not any other figure. The review benchmark is ${c.bench.reviewCount}, not any other figure.
19. MONTHLY FIRST: Lead with monthly dollar figures. When citing the total opportunity or any leak category figure, state the per-month number first (divide annual by 12, round sensibly); you may add the annual figure in parentheses once per section. The client's total estimated leak is ${c.totalMo}.
20. This business is located in ${c.city}, which is in the United States. Use ONLY US-specific platforms, directories, regulations, and market data. Never reference Australian platforms (HiPages, Oneflare, ServiceSeeking, Hipages), Australian regulators (WorkSafe, Fair Work), or Australian statistics.
21. HTML only: <p>, <strong>, <h4>, <ul><li>, <ol><li>, <table>, <div class="stat-call">, <div class="script"><span class="slabel">...</span><p>...</p></div>, <div class="action-box"><h5>...</h5><ol>...</ol></div>, <div class="quick-win">
22. WORD BUDGET: Respect the stated word maximum for each section. Shorter is better. No filler, no restating other sections. Scripts and table cells do not count toward the word maximum; all prose does.
23. NO DISCLAIMERS: Do not write disclaimer text or <div class="disclaimer"> blocks. The report appends one consolidated disclaimer block at the end.
24. NEVER use em dashes or en dashes anywhere in the output. Use commas, periods, or parentheses instead.`;
}
 
function buildSectionPrompt(key, c) {
  const base = sysPrompt(c);
  const revLoNum = c.L.meta.revLo || 0;
  const priceUplift6 = Math.round(revLoNum * 0.06).toLocaleString();
  const priceUplift6Mid = Math.round(c.L.meta.revMid * 0.06).toLocaleString();
  // Add before the OPS prompt string:
  const avgMidNum = parseInt((c.L.meta.avgMid||'').toString().replace(/[$,]/g,'')) || 1000;
  const complaintCostLo = Math.round(avgMidNum * 4).toLocaleString();
  const complaintCostHi = Math.round(avgMidNum * 6).toLocaleString();
  // Pre-calculate:
  const clvEstimate = Math.round(avgMidNum * 1.5 * 4).toLocaleString();
  // QUICKWIN math: 10 most recent dead quotes (or fewer if they reported fewer),
  // conservative 5-10% reactivation, valued at the conservative (low) avg job value
  const qwAvgNum = c.L.meta.avgLo || 0;
  const qwContacts = Math.min(10, c.dead || 10);
  const qwLo = Math.round(qwContacts * 0.05 * qwAvgNum).toLocaleString();
  const qwHi = Math.round(qwContacts * 0.10 * qwAvgNum).toLocaleString();
  // DEPTH SCALES WITH DOLLARS: small leaks get short sections, big leaks get full depth
  const catMo = (needle) => {
    const cat = c.L.cats.find(x => x.n.toLowerCase().includes(needle.toLowerCase()));
    return cat ? moRound(cat.amt) : 0;
  };
  const depthNote = (mo) => {
    if (!mo) return '';
    if (mo < 150) return `\nDEPTH RULE (overrides the structure below): this category's estimated leak is ~$${mo.toLocaleString()}/mo — small for this business. Write a SHORT section, about 150 words total: state the number, one or two sentences on why it is small for them, and ONE specific action. No quick-win div, no scripts, no tables, no action boxes.`;
    return `\nDEPTH RULE: this category's estimated leak is ~$${mo.toLocaleString()}/mo. Full depth is warranted — but maximum 300 words of prose. Keep every script complete and word-for-word (scripts do not count toward the word budget). Cut explanation, not scripts.`;
  };
  const prompts = {
    EXEC:`${base}\nWrite ONLY the [EXEC] section. First line: [EXEC]\n\n4 focused paragraphs. Maximum 250 words total:\n- Para 1: Open with the ${c.totalMo} leak (about ${c.total} a year; range: ${c.totalRange}). Lead with the monthly figure. Conservative language. Compelling ${c.ind}-specific analogy.\n- Para 2: Top 3 opportunities: ${c.top3}. Dollar context and interconnection.\n- Para 3: What the next 90 days looks like. Realistic. Quote "businesses in ${c.ind} typically recover 15–25% in 90 days."\n- Para 4: Mindset shift from reactive to systematic. What top ${c.ind} businesses do differently.\n<div class="stat-call">One real industry statistic with source name relevant to ${c.ind}.</div>`,

    QUICKWIN:`${base}\nWrite ONLY the [QUICKWIN] section. First line: [QUICKWIN]\n\nThis section appears right after the executive summary and is the FIRST thing the reader acts on. One play only: reactivating their dead and dormant quotes. They reported approximately ${c.dead} unanswered or dormant quotes sitting in their pipeline. The play must be doable TODAY, cost $0, and require no marketing, no ads, and no new software. Just their phone and their quote list. Maximum 300 words of prose; the scripts must stay complete and word-for-word (they are the value and do not count toward the limit).\n\n<h4>The Play: Reactivate Your ${qwContacts} Most Recent Dead Quotes</h4>\n<p>2-3 sentences: pull the ${qwContacts} most recent unconverted quotes and work ONLY those today. Why recency matters for reactivation in ${c.ind}.</p>\n<h4>The Exact Sequence: 2 Texts + 1 Call</h4>\nWrite each message COMPLETE and word-for-word, specific to ${c.ind}. The ONLY allowed placeholder is the customer's first name written as [Name].\n<div class="script"><span class="slabel">Text 1 - Send This Morning (under 160 characters)</span><p>[Complete text message]</p></div>\n<div class="script"><span class="slabel">Text 2 - Send 4 Hours Later If No Reply (under 160 characters)</span><p>[Complete text message, different angle, ends with an easy yes/no question]</p></div>\n<div class="script"><span class="slabel">Call - End of Day for Anyone Who Has Not Replied (30-second voicemail script)</span><p>[Complete word-for-word voicemail script]</p></div>\n<h4>What This Is Worth</h4>\n<p>Walk the math conservatively: ${qwContacts} contacts x 5-10% reactivation x ~${c.avgLo} average job value = approximately $${qwLo} to $${qwHi} in recovered revenue from a single afternoon. Use "estimated" language. One sentence on why 5-10% is deliberately conservative against the 10-20% reactivation rates re-engagement campaigns typically see.</p>\n<div class="action-box"><h5>Do It Today: 4 Steps, Under 1 Hour of Work</h5><ol><li>[pull the ${qwContacts} most recent unconverted quotes, with time estimate]</li><li>[send Text 1 to all of them, time estimate]</li><li>[send Text 2 at the 4-hour mark to non-responders, time estimate]</li><li>[end-of-day calls to the rest, time estimate]</li></ol></div>`,

    BENCH:`${base}\nWrite ONLY the [BENCH] section. First line: [BENCH]\n\nThis single section replaces a KPI dashboard, an industry benchmark analysis, and a competitive comparison. It is ONE tight table plus short commentary. HARD LIMIT: maximum 300 words of prose plus the one table.\n\n<h4>Your Numbers vs The Benchmarks</h4>\n<table><tr><th>Metric</th><th>You</th><th>Benchmark</th><th>What the gap costs</th></tr>\n<tr><td>Close rate</td><td>~${c.close}</td><td>${c.bench.closeRate}%</td><td>[estimated $/mo]</td></tr>\n<tr><td>Repeat customer rate</td><td>~${Math.round((c.L.meta.retRate||0.15)*100)}%</td><td>${c.bench.retention}%</td><td>[estimated $/mo]</td></tr>\n<tr><td>Referral rate</td><td>~${Math.round((c.L.meta.refRate||0.10)*100)}%</td><td>${c.bench.referralPct}%</td><td>[estimated $/mo]</td></tr>\n<tr><td>Review count</td><td>${c.L.meta.reviewBand||'unknown'}</td><td>${c.bench.reviewCount}</td><td>[one short phrase]</td></tr>\n<tr><td>Payment collection</td><td>${c.payLabel}</td><td>within 14 days</td><td>[one short phrase]</td></tr>\n<tr><td>Weekly admin hours</td><td>~${c.adminH} hrs</td><td>[automatable target]</td><td>[estimated $/mo at $45/hr]</td></tr></table>\n\nThen exactly 3 short paragraphs:\n1. The one gap in this table that costs the most, and the single action that closes it.\n2. Where they sit against the typical operator in their space: price leaders vs premium operators vs niche specialists, and which tier the numbers say they should compete in.\n3. The Monday habit: check 5 numbers weekly — revenue booked, leads in, quote-to-close rate, average job value, pipeline value. One sentence on why owners who look at numbers first close gaps fastest.\nSource the benchmark figures to: ${c.bench.source}\n<div class="stat-call">Businesses that close benchmark gaps typically do one thing differently: they systematize what top performers do instinctively.</div>\nRemember: 300 words of prose maximum. No sub-dashboards, no extra tables.`,
 
    SPEED:`${base}${depthNote(catMo('speed'))}\nWrite ONLY the [SPEED] section. First line: [SPEED]\n\n<div class="quick-win">[One specific speed-to-lead action THIS WEEK — e.g. set up a missed-call auto-text or a 5-minute response rule, doable in under 1 hour]</div>\n\n<h4>What Slow Response Is Costing You</h4>\n<p>Open with their estimated speed-to-lead leak in $/mo (from the DEPTH RULE figure above). The math: ~${c.mthLeads} leads/month at ~${c.avgLo}+ average job value, and the share lost to faster-responding competitors. Benchmark stats: leads contacted within 5 minutes are dramatically more likely to convert (InsideSales.com research cited by HBR: roughly 21x more likely to qualify vs a 30-minute response), and the first responder wins the majority of jobs. 3-4 sentences, conservative language.</p>\n<h4>The 5-Minute-Response System</h4>\n<p>What it looks like in practice for their business: every inbound call, form, or message gets a response within 5 minutes during work hours. Who owns the phone, what the instant reply says, how after-hours enquiries are caught. 3-4 sentences.</p>\n<h4>Missed-Call Text-Back</h4>\n<p>The single highest-leverage piece: an automatic text that fires whenever a call is missed. 2-3 sentences on setup and why it converts.</p>\n<div class="script"><span class="slabel">Missed-Call Text-Back Message (under 160 characters)</span><p>[Complete text message — acknowledges the missed call, promises a callback time, asks one easy question]</p></div>\n<div class="script"><span class="slabel">Instant Web-Form Reply (under 160 characters)</span><p>[Complete text/email auto-reply]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,

    CONV:`${base}${depthNote(catMo('close rate'))}\nWrite ONLY the [CONV] section. First line: [CONV]\n\n<div class="quick-win">[One specific action THIS WEEK to improve lead conversion in ${c.ind}]</div>\n\n<h4>Close Rate Analysis</h4>\n<p>~${c.close} vs ~${c.bench.closeRate}% ${c.ind} benchmark (${c.bench.source}). Calculate gap and dollar impact. Reference CSO Insights.</p>\n<h4>Follow-Up System Gap</h4>\n<p>Salesforce 80%/5-touch. Specific to ${c.ind}. 3–4 sentences.</p>\n<h4>5-Email Follow-Up Sequence</h4>\nCRITICAL: Write each email COMPLETE — no placeholders. 60–70 words each.\n<div class="script"><span class="slabel">Email 1 — Same Day (Subject: [specific subject for ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Email 2 — Day 2 (Subject: [specific subject])</span><p>[Complete 60-word email]</p></div>\n<div class="script"><span class="slabel">Email 3 — Day 5 (Subject: [specific subject])</span><p>[Complete 60-word email — addresses most common ${c.ind} objection]</p></div>\n<div class="script"><span class="slabel">Email 4 — Day 10 (Subject: [specific subject])</span><p>[Complete 55-word email — mild urgency]</p></div>\n<div class="script"><span class="slabel">Email 5 — Day 21 (Subject: Closing the loop)</span><p>[Complete 45-word breakup email]</p></div>\n\nNOTE: The estimated current gap vs industry benchmark is ~$${c.L.cats.find(cat => cat.n.toLowerCase().includes('close rate'))?.amt.toLocaleString()||'0'}. If this is $0, frame this section as a strength with ceiling upside — not a missed opportunity.`,


    DEAD:`${base}${depthNote(catMo('dormant'))}\nWrite ONLY the [DEAD] section. First line: [DEAD]\n\n<div class="quick-win">[One specific action THIS WEEK to re-engage cold leads in ${c.ind}]</div>\n\n<h4>Value in Your Pipeline</h4>\n<p>~${c.dead} unconverted leads × ${c.avgLo} average × 12% re-engagement rate = approximately $${c.deadVal.toLocaleString()} in recoverable revenue. 3 specific reasons leads go cold in ${c.ind}.</p>\n<h4>Re-Engagement Sequence</h4>\n<div class="script"><span class="slabel">Re-engagement Email (Subject: [specific to ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Follow-Up Text — 3 Days Later (under 140 chars)</span><p>[Complete text]</p></div>\n<div class="script"><span class="slabel">Final Email — Day 10 (Subject: Last one from us)</span><p>[Complete 45-word closing email]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[ongoing]</li></ol></div>`,
 
    SYSTEMS:`${base}\nWrite ONLY the [SYSTEMS] section. First line: [SYSTEMS]\n\nMaximum 250 words of prose plus the one table.\n\n<div class="quick-win">[One specific automation action THIS WEEK for ${c.ind} — one repetitive manual task to automate in under an hour]</div>\n\n<h4>Systems & Automation Diagnosis</h4>\n<p>They report approximately ${c.adminH} hours/week of manual admin (quoting, invoicing, follow-up, scheduling). At a conservative $45/hour replacement cost, that is approximately $${Math.round(c.adminH*52*45).toLocaleString()}/year of owner or staff time on work software can do. Roughly 60% of it is automatable with today's tools, reclaiming an estimated ${Math.round(c.adminH*0.6)} hours/week. Honest assessment specific to ${c.ind}.</p>\n<h4>What to Automate First — Ranked by Hours Reclaimed</h4>\n<table><tr><th>Rank</th><th>Process</th><th>Est. Hours/Week Reclaimed</th><th>How (specific to ${c.ind})</th></tr><tr><td>1</td><td>[highest-hour manual process, e.g. lead follow-up]</td><td>[hours]</td><td>[specific automation approach]</td></tr><tr><td>2</td><td>[process]</td><td>[hours]</td><td>[approach]</td></tr><tr><td>3</td><td>[process]</td><td>[hours]</td><td>[approach]</td></tr><tr><td>4</td><td>[process]</td><td>[hours]</td><td>[approach]</td></tr></table>\n<h4>The Follow-Up Machine</h4>\n<p>The single highest-value automation for ${c.ind}: automatic speed-to-lead response and structured follow-up sequences. What it looks like when running, and the estimated revenue it protects given their ~${c.close} close rate and ~${c.mthLeads} leads/month. 3-4 sentences.</p>\n<h4>AI and Modern Automation for ${c.ind}</h4>\n<p>Where AI-driven automation realistically helps a ${c.ind} business at ${c.revRange}: quote drafting, review responses, appointment reminders, invoice chasing, job notes. What to adopt now vs skip. Practical, no hype. 2-3 sentences, ending with ONE sentence naming the single tool category (and one example product) that covers most of this for their trade — no software shopping lists.</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    RET:`${base}${depthNote(catMo('retention'))}\nWrite ONLY the [RET] section. First line: [RET]\n\n<div class="quick-win">[One specific retention action THIS WEEK — call or email a specific type of past customer in ${c.ind}]</div>\n\n<h4>Customer Lifetime Value Estimate</h4>\n<p>${c.avgMid} avg × approximately 1.5 jobs/year × 4-year average retention = approximately $${clvEstimate} customer lifetime value. Bain & Company: 5% retention = 25–95% profit growth. Industry average retention: ${c.bench.retention}% (${c.bench.source}). Conservative language.</p>\n<h4>The Retention Gap</h4>\n<p>Estimated annual cost of their retention gap. Why ${c.ind} customers stop returning. 3–4 sentences.</p>\n<h4>3-Step Retention System for ${c.ind}</h4>\n<p>Specific touchpoints, timing, channels. Not generic.</p>\n<div class="script"><span class="slabel">30-Day Post-Job Check-In (Email — 70 words)</span><p>[Full email — warm, specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">6-Month Re-Engagement (Text — under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REF:`${base}\nWrite ONLY the [REF] section. First line: [REF]\n\nThis single SHORT section covers BOTH referrals and reviews. They are not quantified leak buckets — they are retention-adjacent operations routines that generate free leads. HARD LIMIT: maximum 250 words of prose (scripts excluded). No quick-win div.\n\n<h4>The Free Lead Engine</h4>\n<p>2-3 sentences: referred and review-driven customers cost $0 to acquire and close at higher rates. Referral math in one line: each activated customer produces ~1.2 referrals at ~${c.avgLo} average and ~55% conversion (Texas Tech / Wharton: referred customers carry 16-25% higher LTV). Benchmarks: referral average ${c.bench.referralPct}%, review benchmark ${c.bench.reviewCount} reviews (${c.bench.source}).</p>\n<h4>Two Routines, Wired Into Job Completion</h4>\n<p>Routine 1 — the referral ask at job completion, every time. Routine 2 — the review request text 24-48 hours after completion, every time. Both run as part of the close-out checklist so nobody has to remember. 3-4 sentences on how to wire this in.</p>\n<div class="script"><span class="slabel">Referral Ask (word-for-word at job completion)</span><p>[Complete 50-word script]</p></div>\n<div class="script"><span class="slabel">Review Request Text — 24-48 Hours After Completion (under 140 chars)</span><p>[Complete text with [your Google review link]]</p></div>\n<div class="action-box"><h5>3 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[ongoing]</li></ol></div>\nRemember: 250 words of prose maximum.`,
 
    PRICE:`${base}${depthNote(catMo('pricing'))}\nWrite ONLY the [PRICE] section. First line: [PRICE]\n\n<div class="quick-win">[One specific pricing action THIS WEEK — test a price increase on new quotes starting today]</div>\n\n<h4>The Pricing Opportunity</h4>\n<p>McKinsey: 1% price improvement = ~11% profit improvement. Conservative 6% adjustment on ${c.revLo} = approximately $${priceUplift6} annually. At your revenue midpoint of ${c.revMid}, that same 6% move delivers approximately $${priceUplift6Mid}. How ${c.ind} businesses test increases without losing customers.</p>\n<h4>The Price Increase Test Methodology</h4>\n<p>How to safely test a 7–10% increase in ${c.ind}. What signals confirm it's working. 3–4 sentences.</p>\n<h4>Premium Tier Example for ${c.ind}</h4>\n<p>Specific Good / Better / Best structure — approximate prices, what each tier includes.</p>\n<div class="script"><span class="slabel">Price Increase Communication Script</span><p>[Complete 70-word script — confident, value-focused]</p></div>\n<div class="script"><span class="slabel">Premium Tier Presentation Script</span><p>[Complete 70-word script — presents 3 options naturally]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    OPS:`${base}${depthNote(catMo('capacity'))}\nWrite ONLY the [OPS] section. First line: [OPS]\n\n<div class="quick-win">[One specific operations action THIS WEEK — fix one scheduling gap or implement one quality checkpoint in ${c.ind}]</div>\n\n<h4>Scheduling Efficiency — Capacity You Already Paid For</h4>\n<p>Their scheduling is ${c.schedLabel}. Callbacks, windshield time, and gaps between jobs are capacity the business already pays for but never bills. Estimate the recoverable jobs per week from tighter routing and fewer callbacks for a ${c.ind} team of ~${c.teamSize}, and the annual dollar value at ~${c.avgLo} per job. 3-4 sentences, specific to ${c.ind}.</p>\n<h4>The True Cost of Quality Issues in ${c.ind}</h4>\n<p>Each complaint costs 4–6× the original transaction value when you factor in rework, lost referrals, and reputation damage. At your average transaction of approximately ${c.avgMid}, each avoidable complaint costs approximately $${complaintCostLo}–$${complaintCostHi}. Annual impact at their complaint rate.</p>\n<h4>The 3 Critical SOPs for ${c.ind}</h4>\n<p>Name and describe the 3 most impactful SOPs specifically for ${c.ind}. For each: what it covers, key steps, what breaks without it.</p>\n<h4>Quality Control in Practice</h4>\n<p>How top-performing ${c.ind} businesses build quality checkpoints without significant overhead. 2–3 sentences with a specific example.</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li></ol></div>`,

    LEVERAGE:`${base}${depthNote(catMo('owner leverage'))}\nWrite ONLY the [LEVERAGE] section. First line: [LEVERAGE]\n\n<div class="quick-win">[One specific delegation action THIS WEEK — hand off or document one task the owner does out of habit, not necessity]</div>\n\n<h4>What Breaks When You Take a Week Off</h4>\n<p>Their diagnostic answer: ${c.ownerDepLabel}. Be direct about what that means: an owner-dependent ${c.ind} business has a hard revenue ceiling, burns out its most expensive employee on its cheapest work, and is worth far less to a buyer. Tie to their ~${c.adminH} hrs/week of manual admin. 3-4 sentences.</p>\n<h4>Eliminate / Automate / Delegate / Do</h4>\n<table><tr><th>Bucket</th><th>Typical ${c.ind} owner tasks</th><th>First move</th></tr><tr><td><strong>Eliminate</strong></td><td>[tasks that should not exist]</td><td>[specific action]</td></tr><tr><td><strong>Automate</strong></td><td>[repetitive admin — link to SYSTEMS section]</td><td>[specific action]</td></tr><tr><td><strong>Delegate</strong></td><td>[tasks a team member or VA can own]</td><td>[specific action]</td></tr><tr><td><strong>Do</strong></td><td>[the 3-4 things only the owner should do]</td><td>[specific action]</td></tr></table>\n<h4>The SOP Ladder — From Head to Paper to Team</h4>\n<p>The practical path for ${c.ind}: pick the most repeated process, record yourself doing it once, turn it into a one-page checklist, hand it to one person, review weekly for a month. Name the first 3 SOPs a ${c.ind} business should write, in order. 3-4 sentences.</p>\n<h4>The One-Week-Off Test</h4>\n<p>Define the 90-day target: the owner can take 5 working days off and revenue, scheduling, and customer communication continue. List the 4-5 specific things that must be true for a ${c.ind} business to pass, based on their answers. End with the exact first delegation to make this week.</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    PRIORITY:`${base}\nWrite ONLY the [PRIORITY] section. First line: [PRIORITY]\n\nThis is the single master fix list for the whole report. There is NO separate implementation checklist — do not write one, and do not duplicate items. One ranked table plus two short paragraphs. Maximum 300 words of prose plus the ranked table.\n\n<h4>Your Fix Order</h4>\n<table><tr><th>Rank</th><th>Fix</th><th>Est. $/mo</th><th>Effort</th><th>Start</th></tr>\n${c.L.cats.map((cat,i)=>`<tr><td><strong>#${i+1}</strong></td><td><strong>${cat.n}</strong> — [one-line specific fix]</td><td>~$${moRound(cat.amt).toLocaleString()}/mo</td><td>[Low / Medium / High]</td><td>[Week 1-12]</td></tr>`).join('\n')}\n</table>\nFill in each bracketed cell: a one-line specific fix, an honest effort rating (Low / Medium / High), and the week number to start (sequence the low-effort, high-dollar fixes first).\n<p>Then write 2 short paragraphs explaining the sequencing — why this order maximizes early recovered revenue for ${c.biz}, and how early wins fund the discipline for the later fixes. Specific, conservative language.</p>`,
 
    ROI:`${base}\nWrite ONLY the [ROI] section. First line: [ROI]\n\nMaximum 200 words of prose plus the projection table.\n\n<h4>Conservative Recovery Projection</h4>\n<table>\n<tr><th>Scenario</th><th>Recovery Rate</th><th>Month 1 Est.</th><th>Month 2 Est.</th><th>Month 3 Est.</th><th>90-Day Total</th></tr>\n<tr><td>Conservative</td><td>15%</td><td>~$${Math.round(c.L.total*0.15*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15*0.50).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td></tr>\n<tr><td>Realistic</td><td>22%</td><td>~$${Math.round(c.L.total*0.22*0.20).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22*0.55).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td></tr>\n<tr><td>Optimistic</td><td>32%</td><td>~$${Math.round(c.L.total*0.32*0.25).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32*0.60).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td></tr>\n</table>\n<p>Explain what drives each scenario. Be honest that results vary.</p>\n<h4>Your 30-Minute Walkthrough Call</h4>\n<p>Remind them the audit includes a 30-minute walkthrough call with Flavio DeOliveira, who built it. Tell them exactly what to bring: this report, their last 10 invoices, and their calendar. On the call: confirm the top leak, sanity-check the numbers against real books, and lock in the first three moves. 2-3 sentences, direct.</p>\n<h4>Your Single Most Important Action in the Next 48 Hours</h4>\n<p>[Single most impactful, specific first action for ${c.biz} in ${c.ind} based on their #1 opportunity. 80–100 words. Exact steps. Specific to ${c.ind}.]</p>`,

CASH:`${base}${depthNote(catMo('cash'))}\nWrite ONLY the [CASH] section. First line: [CASH]\n\n
Write specific cash flow and job costing guidance for ${c.biz} — a ${c.ind} business at ${c.revRange} revenue.\n\n
<div class="quick-win">[One specific cash action THIS WEEK — chase one aged invoice or calculate margin on the last completed job. Under 45 minutes.]</div>
<h4>Collection Speed — The Silent Leak</h4>
<p>Their typical collection is ${c.payLabel}. Every day between job completion and payment is unpaid financing they provide to customers. Walk the math: at ${c.revMid} annual revenue, 30 days of receivables is roughly $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12).toLocaleString()} of their own cash locked up, plus write-off risk that grows with invoice age. Industry norm for well-run ${c.ind} businesses: payment on completion or within 14 days. 3-4 sentences, specific.</p>
<div class="action-box"><h5>Collections system — set up this month</h5><ol>
<li>[Payment terms change — what to put on every quote and invoice for ${c.ind}. Time: 30 min]</li>
<li>[Deposit or progress payment structure appropriate to ${c.ind} job sizes. Time: 45 min]</li>
<li>[Automated invoice reminder sequence — day 0, day 7, day 14. Tool and message. Time: 1 hr]</li>
<li>[Card/ACH payment on site or on link — specific option for ${c.ind}. Time: 1 hr]</li>
</ol></div>
<h4>Margin Per Job Type — Do You Actually Know It?</h4>
<p>Their job costing maturity: ${c.jobCostingLabel}. Explain what flying blind on margin costs a ${c.ind} business: quoting unprofitable work, growing revenue while shrinking profit, discounting jobs that were already thin. Show the simple job-cost formula for ${c.ind} (labor + materials + drive time + overhead allocation vs price). 3-4 sentences.</p>
<h4>The Job Costing Baseline — 2 Hours, One Spreadsheet</h4>
<p>Walk them through costing their last 10 completed jobs: what columns to track, how to allocate overhead simply, and what pattern usually shows up in ${c.ind} (one service line quietly subsidizing another). End with the decision rule: reprice, fix, or stop selling the losers.</p>
<h4>Pricing Discipline Follows Costing</h4>
<p>Once margin per job type is known, pricing stops being guesswork. Connect this to their pricing answers: which job types can carry an increase first, and how knowing the numbers removes the fear of raising prices. 2-3 sentences.</p>
<div class="script"><span class="slabel">Overdue invoice call script — day 14, friendly but firm</span><p>[Complete 60-word phone script for a ${c.ind} owner chasing an overdue invoice — warm, direct, asks for payment today or a date]</p></div>`,

ROADMAP:`${base}\nWrite ONLY the [ROADMAP] section. First line: [ROADMAP]\n\nThis is a SINGLE-PAGE roadmap. Maximum 350 words total. Week-by-week bullets only — no long prose, no day-by-day detail. Every bullet is ONE line: a specific action for their trade with a time estimate.\n\n<h4>Your 90-Day Revenue Recovery Roadmap</h4>\n<p>One sentence: the order matters — early wins fund the discipline for later steps. Start the first item within 48 hours.</p>\n<div class="pgrid">\n<div class="pcard"><div class="ptag">Weeks 1–2</div><div class="ptitle">Immediate Revenue</div>\n<div class="ptask">[Dead-quote reactivation — first batch, from the Do This Week play]</div>\n<div class="ptask">[Missed-call text-back + 5-minute response rule live]</div>\n<div class="ptask">[Follow-up sequence written and scheduled]</div>\n<div class="ptask">[Review requests to last 10 completed customers]</div>\n<div class="ptask">[Weekly 5-number KPI check every Monday — 30 min, non-negotiable]</div>\n<div class="pmile">Milestone: follow-up sequence running, first reactivated jobs booked, KPI habit started.</div>\n</div>\n<div class="pcard"><div class="ptag">Weeks 3–6</div><div class="ptitle">Systems & Pricing</div>\n<div class="ptask">[CRM or job management live with all current leads loaded]</div>\n<div class="ptask">[Price test on new quotes]</div>\n<div class="ptask">[Job costing baseline — margin on last 10 completed jobs]</div>\n<div class="ptask">[Payment terms + automated invoice reminders on every new invoice]</div>\n<div class="ptask">[First SOP written and handed to a named owner]</div>\n<div class="pmile">Milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.08).toLocaleString()}/mo target (~8% above baseline).</div>\n</div>\n<div class="pcard"><div class="ptag">Weeks 7–12</div><div class="ptitle">Optimize & Systematize</div>\n<div class="ptask">[Second dead-lead batch + referral and review routines wired into job completion]</div>\n<div class="ptask">[Double down on the best-converting lead source]</div>\n<div class="ptask">[Delegate or automate one recurring owner task — run the one-week-off test]</div>\n<div class="ptask">[Re-score the diagnostic and set the next 90-day targets]</div>\n<div class="pmile">Milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.22).toLocaleString()}/mo target (~22% above baseline — the realistic scenario).</div>\n</div>\n</div>\nFill in each bracketed bullet with one specific, time-boxed action for their trade. One line each. Remember: 350 words maximum, single page, no prose blocks.`,

  };
 
  return prompts[key] || `${base}\nWrite the [${key}] section for ${c.biz}, a ${c.ind} business. First line must be exactly: [${key}]`;
}
 
// ══════════════════════════════════════════════════
//  START SERVER + RECOVER PENDING JOBS FROM SUPABASE
// ══════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
const CRON_TOKEN = process.env.CRON_TOKEN;
const ADMIN_KEY  = process.env.ADMIN_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Pricing source of truth for MRR calc. Update if plans change.
const PLAN_CENTS = { monthly: 9700, yearly: 89700 };
function monthlyCents(plan) {
  if (plan === 'yearly') return Math.round(PLAN_CENTS.yearly / 12);
  if (plan === 'monthly') return PLAN_CENTS.monthly;
  return 0;
}

async function _sb(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'PATCH' ? 'return=minimal' : 'count=exact'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase ${method} ${path} -> ${r.status} ${txt.slice(0, 200)}`);
  }
  if (method === 'PATCH') return true;
  return r.json();
}
const sbGet   = (p)      => _sb('GET', p);
const sbPatch = (p, b)   => _sb('PATCH', p, b);

async function sendResend({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing, skipping email to', to);
    return false;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'RevAnalysis <support@revanalysis.com>',
      to, subject, html
    })
  });
  if (!r.ok) {
    const t = await r.text();
    console.warn(`Resend send failed for ${to}: ${r.status} ${t.slice(0, 200)}`);
    return false;
  }
  return true;
}

function requireCronToken(req, res) {
  if (!CRON_TOKEN || req.headers['x-cron-token'] !== CRON_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function requireAdminKey(req, res) {
  const auth = req.headers.authorization || '';
  if (!ADMIN_KEY || auth !== `Bearer ${ADMIN_KEY}`) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// POST /cron/daily-email
// Fires once per morning. For each active/trialing subscriber,
// picks the next action that is not completed AND not yet emailed,
// ordered by sequence_order ascending, and emails it via Resend.
// Marks emailed_at so tomorrow it moves on to the next action.
// ----------------------------------------------------------------
app.post('/cron/daily-email', async (req, res) => {
  if (!requireCronToken(req, res)) return;
  try {
    const subs = await sbGet(`subscribers?status=in.(active,trialing)&select=id,email,biz_name`);
    let sent = 0, noAction = 0, failed = 0;
    for (const s of subs) {
      const actions = await sbGet(
        `action_queue?subscriber_id=eq.${s.id}&completed_at=is.null&emailed_at=is.null&order=sequence_order.asc&limit=1&select=id,title,body_html,script_html,dollar_impact`
      );
      if (!actions.length) { noAction++; continue; }
      const a = actions[0];
      const subject = a.title || "Today's RevAnalysis action";
      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width:600px; margin:0 auto;">
          <h2 style="color:#0f1117;">${a.title || "Today's action"}</h2>
          ${a.dollar_impact ? `<p style="color:#10b981; font-weight:600;">Estimated impact: $${Number(a.dollar_impact).toLocaleString()}</p>` : ''}
          <div>${a.body_html || ''}</div>
          ${a.script_html ? `<h3 style="margin-top:24px;">Script</h3><div>${a.script_html}</div>` : ''}
          <p style="margin-top:32px;"><a href="https://www.revanalysis.com/dashboard" style="background:#10b981; color:#fff; padding:12px 20px; text-decoration:none; border-radius:6px; display:inline-block;">Open dashboard</a></p>
          <p style="color:#6b7280; font-size:12px; margin-top:40px;">RevAnalysis coaching. Reply to unsubscribe or get help.</p>
        </div>`;
      const ok = await sendResend({ to: s.email, subject, html });
      if (ok) {
        await sbPatch(`action_queue?id=eq.${a.id}`, { emailed_at: new Date().toISOString() });
        sent++;
      } else {
        failed++;
      }
    }
    res.json({ ok: true, eligible: subs.length, sent, noAction, failed });
  } catch (e) {
    console.error('daily-email error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------
// GET /admin/subscriptions
// Returns counts, MRR in cents, recent signups. Bearer ADMIN_KEY.
// ----------------------------------------------------------------
app.get('/admin/subscriptions', async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  try {
    const all = await sbGet(
      `subscribers?select=id,email,status,plan,biz_name,trial_start,trial_end,created_at&order=created_at.desc`
    );
    const counts = { active: 0, trialing: 0, canceled: 0, other: 0 };
    let mrr_cents = 0;
    for (const s of all) {
      if (counts[s.status] != null) counts[s.status]++; else counts.other++;
      if (s.status === 'active') mrr_cents += monthlyCents(s.plan);
    }
    const recent = all.slice(0, 20).map(s => ({
      email: s.email,
      status: s.status,
      plan: s.plan,
      biz_name: s.biz_name,
      trial_end: s.trial_end,
      created_at: s.created_at
    }));
    res.json({
      ...counts,
      total: all.length,
      mrr_cents,
      mrr_usd: Math.round(mrr_cents / 100),
      recent
    });
  } catch (e) {
    console.error('admin/subscriptions error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------------------
// POST /cron/trial-ending
// Finds trialing subscribers whose trial ends in <= 48h and who
// have NOT received a warning yet. Sends the warning and marks
// trial_warning_sent_at so we never double-email.
// ----------------------------------------------------------------
app.post('/cron/trial-ending', async (req, res) => {
  if (!requireCronToken(req, res)) return;
  try {
    const nowIso = new Date().toISOString();
    const in48 = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const subs = await sbGet(
      `subscribers?status=eq.trialing&trial_end=lte.${in48}&trial_end=gte.${nowIso}&trial_warning_sent_at=is.null&select=id,email,trial_end,biz_name`
    );
    let sent = 0, failed = 0;
    for (const s of subs) {
      const endDate = new Date(s.trial_end).toLocaleDateString('en-US', { month:'long', day:'numeric' });
      const html = `
        <div style="font-family:-apple-system, BlinkMacSystemFont, sans-serif; max-width:600px; margin:0 auto;">
          <h2 style="color:#0f1117;">Your RevAnalysis trial ends ${endDate}</h2>
          <p>${s.biz_name ? s.biz_name + ', your' : 'Your'} coaching continues automatically after the trial at $97/mo. No action needed.</p>
          <p>If you want to cancel, manage it from your account tab before ${endDate}.</p>
          <p style="margin-top:24px;"><a href="https://www.revanalysis.com/dashboard" style="background:#10b981; color:#fff; padding:12px 20px; text-decoration:none; border-radius:6px; display:inline-block;">Open dashboard</a></p>
          <p style="color:#6b7280; font-size:12px; margin-top:40px;">Reply to this email with any questions.</p>
        </div>`;
      const ok = await sendResend({
        to: s.email,
        subject: `Your RevAnalysis trial ends ${endDate}`,
        html
      });
      if (ok) {
        await sbPatch(`subscribers?id=eq.${s.id}`, { trial_warning_sent_at: new Date().toISOString() });
        sent++;
      } else {
        failed++;
      }
    }
    res.json({ ok: true, eligible: subs.length, sent, failed });
  } catch (e) {
    console.error('trial-ending error:', e);
    res.status(500).json({ error: e.message });
  }
});


app.listen(PORT, async () => {
  console.log(`RevAnalysis worker running on port ${PORT}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.log('Supabase env vars not set — skipping job recovery'); return; }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `${url}/rest/v1/diagnostics?report_delivered=eq.false&email=neq.&created_at=gte.${since}&order=created_at.asc`,
      { headers: { 'apikey': key, 'Authorization': `Bearer ${key}` } }
    );
    if (!r.ok) { console.warn('Job recovery query failed:', r.status); return; }

    const rows = await r.json();
    if (!rows.length) { console.log('Job recovery: no pending jobs found'); return; }

    console.log(`Job recovery: found ${rows.length} undelivered job(s)`);
    rows.forEach(row => {
      console.log(`  Undelivered: ${row.email} (${row.biz_name}) — use POST /resend to retry`);
    });
    console.log(`Undelivered emails: ${rows.map(r => r.email).join(', ')}`);

  } catch(e) {
    console.warn('Job recovery error:', e.message);
  }
});
