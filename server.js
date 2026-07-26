 
const express = require('express');
const fetch = require('node-fetch');
 
const app = express();
app.use(express.json({ limit: '10mb' }));
 
const queue = [];
let isProcessing = false;
const jobStore = {};

// ══════════════════════════════════════════════════
//  DURABLE REPORT STORAGE
//  Persist every generated PDF to the private "reports"
//  bucket in the LEADS Supabase project so past reports
//  survive worker restarts (in-memory jobStore is volatile).
// ══════════════════════════════════════════════════
function sanitizeEmail(email) {
  return String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

async function uploadReportToStorage(email, pdfBase64) {
  const url = process.env.LEADS_SUPABASE_URL;
  const key = process.env.LEADS_SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.warn('Storage: LEADS_SUPABASE_URL / LEADS_SUPABASE_SECRET_KEY not set, report storage is a no-op');
    return false;
  }
  if (!pdfBase64) {
    console.warn(`Storage: no PDF bytes to store for ${email}`);
    return false;
  }
  try {
    const objectPath = `reports/${sanitizeEmail(email)}.pdf`;
    const r = await fetch(`${url}/storage/v1/object/${objectPath}`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true',
      },
      body: Buffer.from(pdfBase64, 'base64'),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn(`Storage: report upload failed for ${email}: ${r.status} ${t.slice(0, 200)}`);
      return false;
    }
    console.log(`Report stored: ${email}`);
    return true;
  } catch (e) {
    console.warn(`Storage: report upload error for ${email}: ${e.message}`);
    return false;
  }
}

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
const BUILD_MARKER = 'art-illustrations-2026-07-26';
app.get('/', (req, res) => res.json({ status: 'RevAnalysis worker running', build: BUILD_MARKER, queueLength: queue.length, isProcessing }));
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

    uploadReportToStorage(email, pdfBase64).catch(e => console.warn(`Storage upload error for ${email}:`, e.message));

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

// Admin: download a customer's report PDF. Serves the in-memory copy first,
// then falls back to durable Supabase Storage so past reports survive restarts.
app.get('/admin/report', async (req, res) => {
  const { email, adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!email) return res.status(400).json({ error: 'Missing email param' });

  const sanitized = sanitizeEmail(email);
  const datePart = new Date().toISOString().slice(0, 10);
  const filename = `revanalysis-report-${sanitized}-${datePart}.pdf`;

  // (a) In-memory copy, if the worker still has it
  const job = jobStore[email];
  if (job && job.completedPdf) {
    const buf = Buffer.from(job.completedPdf, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buf);
  }

  // (b) Durable Supabase Storage (private "reports" bucket)
  const url = process.env.LEADS_SUPABASE_URL;
  const key = process.env.LEADS_SUPABASE_SECRET_KEY;
  if (url && key) {
    try {
      const r = await fetch(`${url}/storage/v1/object/reports/${sanitized}.pdf`, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
      });
      if (r.ok) {
        const arrayBuf = await r.arrayBuffer();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(Buffer.from(arrayBuf));
      }
    } catch (e) {
      console.warn(`Storage: report fetch error for ${email}: ${e.message}`);
    }
  }

  // (c) Never generated yet
  return res.status(404).json({ error: `Report for ${email} has not been generated yet. Use Resend first, then download in a minute.` });
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

  const SECTION_KEYS = ['EXEC','QUICKWIN','BENCH','SPEED','CONV','DEAD','RET','PRICE','CASH','OPS','LEVERAGE','SYSTEMS','AI','REF','PRIORITY','ROADMAP','ROI'];

  // 6 batches (5x3 + 1x2) — safe for Tier 1 output TPM limits
  // Sequence matters: narrative sections first, dependent sections last
  const BATCHES = [
    ['EXEC', 'QUICKWIN', 'BENCH'],
    ['SPEED', 'CONV', 'DEAD'],
    ['RET', 'PRICE', 'CASH'],
    ['OPS', 'LEVERAGE', 'SYSTEMS'],
    ['AI', 'REF', 'PRIORITY'],
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
  const reportHtml = buildEmailHtml(firstName, bizName, industry, calcData, sections, answers);
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
  await uploadReportToStorage(email, pdfBase64);
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
  const rowH=54, labelW=210, barZone=340, height=cats.length*rowH+40, width=640;
  const rows = cats.map((cat, i) => {
    const barW = Math.max(6, Math.round((cat.amt/maxAmt)*barZone));
    const y = 20+i*rowH, color = COLORS[cat.sev]||'#6B7245';
    const label = cat.n.length>28 ? cat.n.substring(0,27)+'…' : cat.n;
    return `<text x="${labelW-10}" y="${y+19}" font-family="Arial,sans-serif" font-size="14" fill="#4A423C" text-anchor="end" dominant-baseline="middle">${label}</text>
      <rect x="${labelW}" y="${y+5}" width="${barW}" height="28" rx="5" fill="${color}"/>
      <text x="${labelW+barW+9}" y="${y+19}" font-family="Arial,sans-serif" font-size="13.5" font-weight="bold" fill="${color}" dominant-baseline="middle">~$${cat.amt.toLocaleString()}/mo</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${width}" height="${height}" rx="6" fill="#F7F5F2"/>${rows}</svg>`;
}

// You-vs-benchmark horizontal 2-bar mini chart. Terracotta = you, olive = benchmark.
// Values labeled at the bar ends. Only rendered when a section has a clean numeric pair.
function svgVsBench(youVal, benchVal, opts) {
  opts = opts || {};
  const unit = opts.unit || '';
  const youLabel = opts.youLabel || 'You';
  const benchLabel = opts.benchLabel || 'Benchmark';
  const maxV = Math.max(youVal, benchVal, 1);
  const W=560, labelW=130, barZone=300, rowH=54, padT=16, H=padT+2*rowH+6;
  const bar=(y,val,color,name)=>{
    const w=Math.max(6, Math.round((val/maxV)*barZone));
    return `<text x="${labelW-12}" y="${y+24}" font-family="Arial,sans-serif" font-size="14" fill="#4A423C" text-anchor="end" dominant-baseline="middle">${name}</text>
    <rect x="${labelW}" y="${y+8}" width="${w}" height="30" rx="5" fill="${color}"/>
    <text x="${labelW+w+12}" y="${y+24}" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="${color}" dominant-baseline="middle">${val}${unit}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="6" fill="#F7F5F2"/>${bar(padT, youVal, '#C1502E', youLabel)}${bar(padT+rowH, benchVal, '#6B7245', benchLabel)}</svg>`;
}

// Simple lead drop-off funnel: leads in -> lost -> closed. Counts, from their real numbers.
function svgFunnel(leadsIn, closed) {
  const lost = Math.max(0, leadsIn - closed);
  const rows=[
    {name:'Leads in / mo', val:leadsIn, color:'#2B2320'},
    {name:'Lost',          val:lost,    color:'#C1502E'},
    {name:'Closed',        val:closed,  color:'#6B7245'},
  ];
  const maxV=Math.max(leadsIn,1);
  const W=560, labelW=130, barZone=300, rowH=50, padT=16, H=padT+rows.length*rowH+6;
  const body=rows.map((r,i)=>{
    const y=padT+i*rowH, w=Math.max(6, Math.round((r.val/maxV)*barZone));
    return `<text x="${labelW-12}" y="${y+22}" font-family="Arial,sans-serif" font-size="14" fill="#4A423C" text-anchor="end" dominant-baseline="middle">${r.name}</text>
    <rect x="${labelW}" y="${y+7}" width="${w}" height="28" rx="5" fill="${r.color}"/>
    <text x="${labelW+w+12}" y="${y+22}" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="${r.color}" dominant-baseline="middle">${r.val}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="6" fill="#F7F5F2"/>${body}</svg>`;
}

// AI adoption ladder for the AI Leverage section. Four rungs from "nothing yet"
// to "several jobs automated". The rung matching their level is terracotta, the
// next 1-2 rungs to climb are olive, the rest muted. Flat, no emoji, Inter labels.
function svgAdoptionLadder(level) {
  const lvl = Math.max(0, Math.min(Number(level) || 0, 3));
  const rungs = ['Nothing yet', 'Tried a tool', 'One tool running', 'Several jobs automated'];
  const TERRA='#C1502E', OLIVE='#6B7245', MUTED='#D8D2C8', INK='#2B2320', SUB='#6E6259';
  const W=600, H=236, padL=24, padB=64, baseY=H-padB, colW=(W-2*padL)/4, gap=18;
  const heights=[48,80,112,146];
  const wrap=(s)=>{ const p=s.split(' '); if(p.length<3) return [s]; const mid=Math.ceil(p.length/2); return [p.slice(0,mid).join(' '), p.slice(mid).join(' ')]; };
  const cols = rungs.map((label,i)=>{
    const h=heights[i], w=colW-gap, x=padL+i*colW+gap/2, y=baseY-h, cx=x+w/2;
    let fill=MUTED, badge='';
    if (i===lvl){ fill=TERRA; badge=`<text x="${cx}" y="${y-10}" font-family="Inter,Arial,sans-serif" font-size="12" font-weight="700" fill="${TERRA}" text-anchor="middle">You are here</text>`; }
    else if (i>lvl && i<=lvl+2){ fill=OLIVE; badge=`<text x="${cx}" y="${y-10}" font-family="Inter,Arial,sans-serif" font-size="11" font-weight="600" fill="${OLIVE}" text-anchor="middle">Climb next</text>`; }
    const num=`<text x="${cx}" y="${y+26}" font-family="Inter,Arial,sans-serif" font-size="16" font-weight="700" fill="#FFFFFF" text-anchor="middle">${i+1}</text>`;
    const lbl=wrap(label).map((ln,li)=>`<text x="${cx}" y="${baseY+22+li*15}" font-family="Inter,Arial,sans-serif" font-size="12.5" fill="${i===lvl?INK:SUB}" font-weight="${i===lvl?'700':'400'}" text-anchor="middle">${ln}</text>`).join('');
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}"/>${num}${badge}${lbl}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="8" fill="#F7F5F2"/><line x1="${padL}" y1="${baseY}" x2="${W-padL}" y2="${baseY}" stroke="#D9D4CC" stroke-width="1.5"/>${cols}</svg>`;
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
    return `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/><text x="${padL-6}" y="${y+4}" font-family="Arial,sans-serif" font-size="11" fill="#9ca3af" text-anchor="end">${vl}</text>`;
  }).join('');
  const xLabels=['Start','Month 1','Month 2','Month 3'].map((l,i)=>`<text x="${toX(i)}" y="${H-padB+18}" font-family="Arial,sans-serif" font-size="12" fill="#6b7280" text-anchor="middle">${l}</text>`).join('');
  const lines=datasets.map(ds=>{
    const pts=ds.values.map((v,i)=>`${toX(i)},${toY(v)}`).join(' ');
    const dots=ds.values.map((v,i)=>`<circle cx="${toX(i)}" cy="${toY(v)}" r="4" fill="${ds.color}" stroke="white" stroke-width="1.5"/>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${ds.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>${dots}`;
  }).join('');
  const legend=datasets.map((ds,i)=>{const lx=padL+i*175;return `<rect x="${lx}" y="${H-20}" width="12" height="3" rx="2" fill="${ds.color}"/><text x="${lx+17}" y="${H-11}" font-family="Arial,sans-serif" font-size="11.5" fill="#4b5563">${ds.label}</text>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="4" fill="#F7F5F2"/>${grids}<line x1="${padL}" y1="${padT+chartH}" x2="${W-padR}" y2="${padT+chartH}" stroke="#D9D4CC" stroke-width="1.5"/>${xLabels}${lines}${legend}</svg>`;
}
 
function svgScoreChart(sc) {
  const cats=[
    {label:'Conversion',score:sc.conversion,bench:65},{label:'Speed to lead',score:sc.speed,bench:60},
    {label:'Retention',score:sc.retention,bench:60},{label:'Pricing',score:sc.pricing,bench:60},
    {label:'Cash flow',score:sc.cashflow,bench:60},{label:'Operations',score:sc.operations,bench:65},
    {label:'Owner leverage',score:sc.leverage,bench:55},
  ].filter(c => typeof c.score === 'number' && !isNaN(c.score));
  const W=580,rowH=40,padL=118,padR=24,padT=16,barW=W-padL-padR,H=padT+cats.length*rowH+30;
  const rows=cats.map((cat,i)=>{
    const y=padT+i*rowH,yourW=Math.round((cat.score/100)*barW),benchX=padL+Math.round((cat.bench/100)*barW);
    const color=cat.score>=cat.bench?'#6B7245':cat.score>=cat.bench*0.7?'#B07A2A':'#C1502E';
    return `<text x="${padL-10}" y="${y+17}" font-family="Arial,sans-serif" font-size="13" fill="#4A423C" text-anchor="end">${cat.label}</text>
      <rect x="${padL}" y="${y+4}" width="${barW}" height="20" rx="4" fill="#E8E4DE"/>
      <rect x="${padL}" y="${y+4}" width="${yourW}" height="20" rx="4" fill="${color}"/>
      <line x1="${benchX}" y1="${y}" x2="${benchX}" y2="${y+28}" stroke="#9A8C80" stroke-width="1.5" stroke-dasharray="3,2"/>
      <text x="${padL+yourW+6}" y="${y+19}" font-family="Arial,sans-serif" font-size="12.5" fill="${color}" font-weight="bold">${cat.score}</text>`;
  }).join('');
  const benchLegendX=padL+Math.round(0.60*barW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;max-width:100%;margin:0 auto;"><rect width="${W}" height="${H}" rx="6" fill="#F7F5F2"/>${rows}<text x="${benchLegendX}" y="${H-9}" font-family="Arial,sans-serif" font-size="11" fill="#6E6259" text-anchor="middle">- - - Industry benchmark</text></svg>`;
}
 
// ══════════════════════════════════════════════════
//  EMAIL / PDF HTML BUILDER — Workbench theme
//  White #FFFFFF background (print-clean), ink #2B2320 text
//  Poppins 800 title + section headings, Inter body
//  Terracotta #C1502E accents, olive #6B7245 support
// ══════════════════════════════════════════════════
// Display-only monthly rounding: nearest $50 under $2k/mo, else nearest $100
function moRound(n) { const m = n / 12; const s = m >= 2000 ? 100 : 50; return Math.max(s, Math.round(m / s) * s); }

function buildEmailHtml(firstName, bizName, industry, calcData, sections, answers) {
  const L = calcData;
  const aiLevel = Math.min((answers && answers.aiAdoption != null ? answers.aiAdoption : 0), 3);
  const date = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  const rec22 = Math.round(L.total * 0.22);
  const bench = getIndustryBenchmarks(industry);
 
  const sectionKeys = ['EXEC','QUICKWIN','BENCH','SPEED','CONV','DEAD','RET','PRICE','CASH','OPS','LEVERAGE','SYSTEMS','AI','REF','PRIORITY','ROADMAP','ROI'];
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
    AI:'AI Leverage',
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
  font-size: 15.5px;
  line-height: 1.55;
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
  font-size: 12px; color: #9A8C80;
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
  font-size: 12px; font-weight: 700;
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
  font-size: 12px; color: #9A8C80;
  text-transform: uppercase; letter-spacing: .08em;
  margin-bottom: 8px; font-weight: 600;
}
.bm-you { font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 22px; font-weight: 800; line-height: 1; }
.bm-vs { font-family: 'Inter', Helvetica, Arial, sans-serif; font-size: 12px; color: #9A8C80; margin: 5px 0 3px; }
.bm-bench-val { font-family: 'Inter', Helvetica, Arial, sans-serif; font-size: 13px; color: #6E6259; margin-bottom: 6px; }
.bm-tag {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 700;
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
  color: #C1502E; font-size: 12px; font-weight: 700;
  border-radius: 6px; flex-shrink: 0;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  letter-spacing: .04em;
}
.sec-title-h {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 15.5px;
  font-weight: 800; color: #2B2320;
}
.chart-body { padding: 20px 22px; }
.chart-label {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 700;
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
  border-radius: 12px; margin-bottom: 16px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.rsec-head {
  background: #FFFFFF;
  border-bottom: 2px solid #E8E4DE;
  padding: 8px 16px;
  display: flex; align-items: center; justify-content: space-between;
}
.rsec-left { display: flex; align-items: center; gap: 10px; }
.rsec-head .sec-num { width: 24px; height: 24px; font-size: 12px; border-radius: 5px; }
.rsec-title {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 15px;
  font-weight: 800; color: #2B2320; letter-spacing: 0;
}
.rsec-amt {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif; font-size: 15px;
  font-weight: 800; color: #C1502E; white-space: nowrap;
}
.rsec-body { padding: 20px 22px; background: white; }
 
/* ── BODY CONTENT ── */
p {
  margin-bottom: 12px; color: #4A423C;
  font-size: 15.5px; line-height: 1.55;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
p:last-child { margin-bottom: 0; }
strong { font-weight: 700; color: #2B2320; }
 
/* Section subheadings */
h4 {
  font-family: 'Inter', Helvetica, Arial, sans-serif; font-size: 13.5px; font-weight: 700;
  letter-spacing: .04em; text-transform: uppercase;
  color: #2B2320; margin: 20px 0 10px;
  padding-bottom: 6px;
  border-bottom: 2px solid #E8E4DE;
  display: flex; align-items: center; gap: 8px;
}
h4::before {
  content: '';
  display: inline-block; width: 4px; height: 14px;
  background: #C1502E; border-radius: 2px; flex-shrink: 0;
}
h5 {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #6B7245; margin-bottom: 8px;
}
 
/* Lists */
ul { margin: 8px 0 14px; padding: 0; list-style: none; }
ul li {
  display: flex; gap: 8px; margin-bottom: 7px;
  font-size: 15px; color: #5A5049; line-height: 1.55;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
ul li::before { content: '→'; color: #6B7245; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
 
ol { margin: 8px 0 14px; padding: 0; list-style: none; counter-reset: steps; }
ol li {
  display: flex; gap: 10px; margin-bottom: 9px;
  font-size: 15px; color: #5A5049; line-height: 1.55;
  counter-increment: steps; font-family: 'Inter', Helvetica, Arial, sans-serif;
  padding: 9px 12px; background: #F7F5F2;
  border: 1px solid #E8E4DE; border-radius: 8px;
}
ol li::before {
  content: counter(steps);
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 22px; border-radius: 50%;
  background: rgba(107,114,69,0.12); color: #6B7245;
  font-size: 12px; font-weight: 700; flex-shrink: 0;
  font-family: 'Inter', Helvetica, Arial, sans-serif; margin-top: 1px;
}
 
/* ── QUICK WIN — amber, prominent ── */
.quick-win {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-left: 5px solid #B07A2A;
  border-radius: 0 10px 10px 0;
  padding: 12px 16px; margin: 0 0 16px 0;
  font-size: 15px; color: #78350f; font-weight: 600;
  line-height: 1.55; font-family: 'Inter', Helvetica, Arial, sans-serif;
}
 
/* ── MATH BOX — the shown work behind every leak estimate ── */
.math-box {
  background: #FBF7F0;
  border: 1px solid #D9D4CC;
  border-left: 5px solid #C1502E;
  border-radius: 0 10px 10px 0;
  padding: 14px 16px; margin: 10px 0 16px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 14.5px; color: #4A423C;
  line-height: 1.65;
  break-inside: avoid; page-break-inside: avoid;
}
/* ── INLINE CHART (injected under THE MATH) ── */
.chart-inline {
  background: #F7F5F2; border: 1px solid #E8E4DE;
  border-radius: 8px; padding: 14px; margin: 10px 0 16px;
  break-inside: avoid; page-break-inside: avoid;
}
.chart-inline .cap {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase; color: #9A8C80; margin-bottom: 10px;
}
.math-box strong { font-family: inherit; color: #2B2320; }

/* ── READ THIS FIRST — unnumbered front page, cover-style ── */
.howto {
  background: #FFFFFF;
  border: 1px solid #E8E4DE;
  border-radius: 14px;
  padding: 44px 44px;
  margin-bottom: 20px;
  break-after: page; page-break-after: always;
  break-inside: avoid; page-break-inside: avoid;
}
.howto-title {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif;
  font-size: 30px; font-weight: 800; color: #2B2320;
  letter-spacing: -0.5px; line-height: 1.1;
  margin-bottom: 6px;
}
.howto-rule { width: 56px; height: 4px; background: #C1502E; border-radius: 2px; margin: 12px 0 24px; }
.howto h4 { margin-top: 20px; }
.howto p { font-size: 15.5px; line-height: 1.6; }
.cta-btn {
  display: inline-block;
  background: #C1502E; color: #FFF8F0 !important;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 15px; font-weight: 700;
  padding: 14px 30px; border-radius: 999px;
  text-decoration: none; margin: 14px 0 6px;
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
  font-size: 12px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #6B7245;
  padding: 8px 14px;
  border-bottom: 1px solid #E8E4DE;
  background: #F0EDE8;
}
.script p {
  color: #4A423C !important;
  font-size: 14.5px;
  line-height: 1.55; margin: 0;
  padding: 10px 14px;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
.script strong { color: #2B2320 !important; }
 
/* ── ACTION BOX ── */
.action-box {
  background: #F7F5F2;
  border: 1px solid #E8E4DE;
  border-left: 5px solid #6B7245;
  border-radius: 0 10px 10px 0;
  padding: 14px 16px; margin: 12px 0;
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
  padding: 12px 16px; margin: 12px 0;
  font-size: 14.5px; color: #4A5230;
  font-weight: 600; line-height: 1.55;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
 
/* ── DISCLAIMER ── */
.disclaimer {
  background: #F7F5F2; border: 1px solid #E8E4DE;
  border-radius: 8px; padding: 9px 12px;
  margin: 10px 0; font-size: 11.5px;
  color: #9A8C80; line-height: 1.5;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
}
 
/* ── TABLES ── */
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13.5px; }
thead tr { background: #2B2320; }
th {
  background: #2B2320; color: #FFF8F0;
  padding: 8px 12px; text-align: left;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase;
}
th:first-child { border-radius: 6px 0 0 0; }
th:last-child { border-radius: 0 6px 0 0; }
td {
  padding: 8px 12px;
  border-bottom: 1px solid #E8E4DE;
  color: #5A5049; vertical-align: top;
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 13.5px;
}
tr:last-child td { border-bottom: none; }
tr:nth-child(even) td { background: #F7F5F2; }
tr:hover td { background: #F0EDE8; }
 
/* ── PLAN GRID ── */
.pgrid { display: block; }
.pcard {
  background: #F7F5F2;
  border: 1px solid #E8E4DE;
  border-radius: 10px; padding: 14px 16px; margin-bottom: 12px;
}
.ptag {
  font-family: 'Inter', Helvetica, Arial, sans-serif;
  font-size: 12px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #FFF8F0; margin-bottom: 4px;
  background: #6B7245; display: inline-block;
  padding: 4px 12px; border-radius: 20px;
  margin-bottom: 10px;
}
.ptitle {
  font-family: 'Poppins', 'Inter', Helvetica, Arial, sans-serif;
  font-size: 15px; font-weight: 800;
  color: #2B2320; margin-bottom: 10px;
}
.ptask {
  display: flex; gap: 8px; margin-bottom: 7px;
  font-size: 14px; color: #5A5049; line-height: 1.5;
  align-items: flex-start; font-family: 'Inter', Helvetica, Arial, sans-serif;
}
.ptask::before {
  content: '→'; color: #6B7245; flex-shrink: 0;
  font-weight: 700; margin-top: 1px;
}
.pmile {
  background: #FFFFFF; border: 1px solid #E8E4DE; border-radius: 8px;
  padding: 10px 12px; margin-top: 10px;
  font-size: 13px; color: #4A5230;
  font-weight: 600; line-height: 1.5;
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
  font-size: 13px; color: #9A8C80;
  margin-bottom: 3px;
}
blockquote {
  background: #F7F5F2; border: 1px solid #E8E4DE; border-radius: 8px;
  padding: 12px 16px; margin: 12px 0;
  color: #4A423C; font-size: 14px;
  line-height: 1.55;
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
  /* Sections FLOW and pack to fill pages. Atomic blocks (cards, math-box,
     tables, fix lists, scripts) keep break-inside:avoid so nothing splits
     mid-block, and section headers avoid orphaning at a page bottom. This
     removes the half-empty pages caused by forcing every section onto a
     fresh sheet. */
  break-inside: auto;
  page-break-inside: auto;
  margin-top: 26px;
}
.rsec:first-of-type { margin-top: 0; }
.rsec-head, .rsec-title { break-after: avoid-page; page-break-after: avoid; }

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
 
  // Illustrative per-section SVGs, injected right after THE MATH box, built from
  // their real numbers only. Sections without a clean numeric pair get no chart.
  const injectAfterMathBox = (html, svg) => {
    if (!html || !svg) return html;
    if (!/<div class="math-box">/.test(html)) return html;
    return html.replace(/(<div class="math-box">[\s\S]*?<\/div>)/, `$1\n<div class="chart-inline">${svg}</div>`);
  };
  const closeFrac = (L.meta && typeof L.meta.close === 'number') ? L.meta.close : null;
  const mthLeads = (L.meta && L.meta.mthLeads) ? L.meta.mthLeads : null;
  const retPct = (L.meta && typeof L.meta.retRate === 'number') ? Math.round(L.meta.retRate * 100) : null;
  const sectionCharts = {};
  if (mthLeads && closeFrac != null) {
    const closedN = Math.max(0, Math.round(mthLeads * closeFrac));
    const funnel = `<div class="cap">Your monthly lead flow</div>${svgFunnel(mthLeads, closedN)}`;
    sectionCharts.SPEED = funnel;
    sectionCharts.CONV = `<div class="cap">Close rate vs benchmark</div>${svgVsBench(Math.round(closeFrac * 100), bench.closeRate, { unit: '%' })}${funnel}`;
  }
  if (retPct != null) {
    sectionCharts.RET = `<div class="cap">Repeat rate vs benchmark</div>${svgVsBench(retPct, bench.retention, { unit: '%' })}`;
  }

  // Hormozi-style teaching illustrations, one per section, hosted in the LEADS
  // Supabase public "report-art" bucket. Each is injected right after the
  // section's chart / THE MATH box so the concept lands after the numbers.
  const ART_BASE = 'https://vpkiqqvuyqknrdgonabo.supabase.co/storage/v1/object/public/report-art/';
  const sectionArt = {
    CONV: 'close-rate.png', SPEED: 'speed-to-lead.png', DEAD: 'dead-lead.png',
    PRICE: 'pricing-margin.png', RET: 'retention-referrals.png', OPS: 'capacity-scheduling.png',
    CASH: 'cash-collection.png', LEVERAGE: 'owner-leverage.png', AI: 'ai-leverage.png'
  };
  const artAlt = {
    CONV: 'Ten quotes in, five closed — the rest leak out the side of the funnel',
    SPEED: 'Speed equals money: the faster you call a fresh lead, the more you close',
    DEAD: 'Old quotes are not dead — the money in them is still recoverable',
    PRICE: 'Raise price while cost holds flat and the profit gap widens over time',
    RET: 'One happy customer becomes many through repeat work and referrals',
    OPS: 'Gaps in the schedule and wrong-way routing quietly bleed billable hours',
    CASH: 'Get paid faster: the longer money sits uncollected, the less it is worth',
    LEVERAGE: 'When every task routes through you, you are the bottleneck',
    AI: 'You plus AI compounds over time while you working alone stays flat'
  };
  const artHtml = (k) => sectionArt[k]
    ? `<figure style="break-inside:avoid;margin:22px 0 8px;text-align:center;">`
      + `<img src="${ART_BASE}${sectionArt[k]}" alt="${artAlt[k]||''}" `
      + `style="width:100%;max-width:520px;height:auto;display:block;margin:0 auto;"/></figure>`
    : '';

  // Sections — start numbering at 01 (00 is the dashboard)
  let sectionsHtml = '';
  sectionKeys.forEach((k, i) => {
    if (!sections[k]) return;
    const catKey = catKeyMap[k];
    const catMatch = catKey ? L.cats.find(c => c.n.toLowerCase().includes(catKey.toLowerCase())) : null;
    const inj = k === 'AI' ? '' : ((sectionCharts[k] || '') + artHtml(k));
    let bodyHtml = inj ? injectAfterMathBox(sections[k], inj) : sections[k];
    // AI Leverage gets a distinct treatment — ONE reverse band opener + adoption
    // ladder in the whole report. This visual emphasis lives only in the AI section.
    if (k === 'AI') {
      const aiBand = `<div style="background:#2B2320;border-radius:12px;padding:30px 30px 28px;margin:0 0 22px;break-inside:avoid;">
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#C1502E;margin:0 0 12px;">The Compounding Lever</div>
        <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:34px;font-weight:800;line-height:1.05;letter-spacing:-0.5px;color:#FAF6EF;margin:0 0 12px;">AI: The Compounding Lever</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#E8E0D5;margin:0;">This is the one move that keeps paying you back. Set it up once and it can compound for the next 12 months, while every other fix in this report keeps running without you touching it.</div>
      </div>`;
      const aiLadder = `<div style="break-inside:avoid;margin:0 0 20px;"><div class="cap">Your AI adoption ladder</div>${svgAdoptionLadder(aiLevel)}</div>`;
      bodyHtml = aiBand + aiLadder + artHtml('AI') + bodyHtml;
    }
    sectionsHtml += `<div class="rsec">
      <div class="rsec-head">
        <div class="rsec-left"><div class="sec-num">${String(i + 1).padStart(2,'0')}</div><div class="rsec-title">${sectionTitles[k]}</div></div>
        ${catMatch?`<div class="rsec-amt">~$${moRound(catMatch.amt).toLocaleString()}/mo</div>`:''}
      </div>
      <div class="rsec-body">${bodyHtml}</div>
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
      <p>Know another owner leaking money like this? Forward them the quiz: <strong><a href="https://revanalysis.com" style="color:#C1502E;">revanalysis.com</a></strong>. It is free to find out.</p>
    </div>
  </div>`;

  // Unnumbered front page right after the cover: the honesty block + the early CTA.
  // One page, always. Owner-ordered: the CTA lives at the beginning, not just the end.
  const howtoHtml = `<div class="howto">
    <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#6B7245;margin-bottom:10px;">How to use this report</div>
    <div class="howto-title">Read This First</div>
    <div class="howto-rule"></div>
    <h4>How we got your numbers</h4>
    <p>You answered 15 questions in ranges, not exact figures. We used the conservative midpoint of each range, plus industry benchmarks for businesses like yours. Every dollar figure in this report is an estimate built to point at where money leaks, not to do your accounting. Where we had to guess, we guessed low. The fastest way to turn these estimates into real numbers is 30 minutes with your actual books.</p>
    <h4>Two ways to use this</h4>
    <p><strong>1. Do it yourself.</strong> Go straight to the Do This Week page and run that play. Then open Your Fix Order and work down the list, one play at a time. Every section says the number first, shows the math behind it, then gives you the fix.</p>
    <p><strong>2. Walk it with Flavio.</strong> Your audit includes a free 30-minute call with Flavio DeOliveira, who built this diagnostic. Bring the report and your last 10 invoices. You leave with your first three moves locked.</p>
    <a class="cta-btn" href="https://calendly.com/flaviod022/discovery-call-flavio-deoliveira">Book your free 30-minute call</a>
    <p style="font-size:12px;color:#9A8C80;margin-top:4px;">calendly.com/flaviod022/discovery-call-flavio-deoliveira</p>
  </div>`;

  const legalHtml = `<div style="background:#F7F5F2;border:1px solid #E8E4DE;border-radius:10px;padding:22px;margin-bottom:16px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9A8C80;margin-bottom:12px;">Important Notices & Disclaimers</div>
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
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#6B7245;border:1px solid rgba(107,114,69,.35);padding:4px 12px;border-radius:20px;">Confidential · Revenue Leak Audit</div>
      </div>

      <div style="margin-bottom:44px;">
        <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:40px;font-weight:800;color:#2B2320;line-height:1.1;letter-spacing:-1px;">Revenue Leak Audit</div>
        <div style="width:72px;height:4px;background:#C1502E;border-radius:2px;margin-top:14px;"></div>
      </div>

      <div style="margin-bottom:44px;">
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#9A8C80;margin-bottom:14px;">Prepared for</div>
        <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:34px;font-weight:800;color:#2B2320;line-height:1.15;letter-spacing:-0.5px;margin-bottom:8px;">${greeting || bizName}</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:500;color:#6E6259;margin-bottom:4px;">${bizName}</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#9A8C80;">${industry}</div>
      </div>

      <div style="margin-bottom:44px;">
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#9A8C80;margin-bottom:12px;">Estimated Monthly Leak</div>
        <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:56px;font-weight:800;color:#C1502E;line-height:1;letter-spacing:-2px;margin-bottom:8px;">~$${moTotal.toLocaleString()}/mo</div>
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#6E6259;">about $${L.total.toLocaleString()} a year · conservative range $${L.totalLo.toLocaleString()} – $${L.totalHi.toLocaleString()}</div>
      </div>

      <div style="display:flex;gap:32px;">
        <div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8C80;margin-bottom:4px;">Biggest Leak</div>
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#C1502E;">~$${moRound(L.cats[0].amt).toLocaleString()}/mo</div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;color:#9A8C80;margin-top:2px;">${L.cats[0].n}</div>
        </div>
        <div style="width:1px;background:#E8E4DE;"></div>
        <div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8C80;margin-bottom:4px;">Realistic 90-Day Target</div>
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#6B7245;">~$${Math.round(L.total*0.22).toLocaleString()}</div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;color:#9A8C80;margin-top:2px;">Conservative estimate</div>
        </div>
        <div style="width:1px;background:#E8E4DE;"></div>
        <div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8C80;margin-bottom:4px;">Walkthrough Call</div>
          <div style="font-family:'Poppins','Inter',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;color:#6B7245;">30 min</div>
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;color:#9A8C80;margin-top:2px;">Included with your audit</div>
        </div>
      </div>
    </div>

    <div style="border-top:1px solid #E8E4DE;padding-top:20px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;color:#9A8C80;">Generated by RevAnalysis · ${date}</div>
      <div style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;color:#9A8C80;">revanalysis.com</div>
    </div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RevAnalysis Report — ${bizName}</title><style>${css}</style></head>
<body><div class="wrap">
  ${coverHtml}
  ${howtoHtml}
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
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>Your Revenue Leak Audit</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Poppins:wght@700;800&display=swap');
  body { margin:0; padding:0; }
  img { border:0; line-height:100%; outline:none; }
  a { text-decoration:none; }
  .container { width:600px; }
  /* Small screens: fluid single column, larger text, full-width button */
  @media only screen and (max-width:600px) {
    .container { width:100% !important; }
    .panel { padding:26px 20px !important; }
    .hero { font-size:34px !important; }
    .intro { font-size:17px !important; }
    .row { font-size:15px !important; }
    .btn-wrap { width:100% !important; }
    .btn-td { width:100% !important; }
    .btn-a { display:block !important; width:100% !important; text-align:center !important; padding:16px 20px !important; box-sizing:border-box !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#EDE4D6;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EDE4D6;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr><td class="panel" style="background:#FAF6EF;border-radius:16px;padding:34px 36px;">

          <div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:#2B2320;letter-spacing:-0.3px;">RevAnalysis</div>
          <div style="width:46px;height:3px;background:#C1502E;border-radius:2px;margin:5px 0 24px;line-height:3px;font-size:0;">&nbsp;</div>

          <p class="intro" style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2B2320;margin:0 0 20px;">Here is the math${greeting}.</p>

          <div class="hero" style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:44px;font-weight:800;color:#C1502E;line-height:1.05;letter-spacing:-1px;margin:0 0 6px;">~$${moTotal.toLocaleString()}/mo</div>
          <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#6E6259;margin:0 0 26px;">estimated revenue leaking out of ${bizName || 'your business'} right now</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
            <tr><td class="row" style="padding:12px 0;border-top:1px solid #E8E4DE;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2B2320;">Biggest leak: <strong>${topName}</strong> at ~$${topMo.toLocaleString()}/mo.</td></tr>
            <tr><td class="row" style="padding:12px 0;border-top:1px solid #E8E4DE;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2B2320;">Realistic 90-day recovery: <strong>~$${rec90.toLocaleString()}</strong>.</td></tr>
            <tr><td class="row" style="padding:12px 0;border-top:1px solid #E8E4DE;border-bottom:1px solid #E8E4DE;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2B2320;">Start with page 3, <strong>Do This Week</strong>. One play, under 20 minutes, zero spend.</td></tr>
          </table>

          <table role="presentation" class="btn-wrap" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 30px;">
            <tr><td class="btn-td" bgcolor="#C1502E" style="background:#C1502E;border-radius:999px;">
              <a class="btn-a" href="https://calendly.com/flaviod022/discovery-call-flavio-deoliveira" style="display:inline-block;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:1.3;color:#FFF8F0;text-decoration:none;padding:15px 34px;min-height:44px;">Book your 30-minute call with Flavio</a>
            </td></tr>
          </table>

          <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#2B2320;margin:0 0 28px;">Flavio DeOliveira<br><span style="color:#6E6259;">RevAnalysis</span></p>

          <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#9A8C80;border-top:1px solid #E8E4DE;padding-top:16px;margin:0 0 10px;">Your full report is attached as a PDF. Keep it.</p>
          <p style="font-family:'Inter',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#9A8C80;margin:0;">You are receiving this because you requested a Revenue Leak Audit at revanalysis.com. Reply STOP to opt out of future emails.</p>

        </td></tr>
      </table>
    </td></tr>
  </table>
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
    // AI adoption (funnel-v3 quiz; "I'm not sure" and older payloads default to 0 = nothing yet)
    aiLevel: Math.min(a.aiAdoption ?? 0, 3),
    aiLabel: ['no AI doing any work yet','tried a tool or two, nothing stuck','one AI tool runs part of the business','AI already handles several jobs'][Math.min(a.aiAdoption ?? 0, 3)],
    // Repeat-customer share (funnel-v3 quiz; index 0-4 low..high). Unknown/older
    // payloads default to 2 (mid) so we keep the normal retention framing. Bottom
    // two buckets (0-1) mark a naturally low-repeat business (one-off/project work).
    repeatLevel: Math.min(a.repeatRate ?? 2, 4),
    lowRepeat: (Math.min(a.repeatRate ?? 2, 4)) <= 1,
    // Scale wording derived from revenue (team-size question was replaced by AI adoption)
    crewNote: (L.meta.revMid || 0) >= 750000 ? 'a multi-crew operation' : (L.meta.revMid || 0) >= 250000 ? 'a small-crew operation' : 'an owner-led operation',
    deadVal: Math.round((L.meta.dead || 20) * 0.12 * (parseInt(String(L.meta.avgLo).replace(/[$,]/g,'')) || 0)),
    // Ops diagnostic context (funnel-v3 quiz answers; safe defaults for older payloads)
    adminH: L.meta.adminH !== undefined ? L.meta.adminH : (a.adminHours !== undefined ? [3,7,15,25][Math.min(a.adminHours,3)] : 8),
    payLabel: ['same day or upfront','within 2 weeks','2-6 weeks','60+ days'][Math.min(a.paymentDays??1,3)],
    jobCostingLabel: ['unknown. bank balance only','rough gut feel','known for main services','tracked per job type'][Math.min(a.jobCosting??1,3)],
    schedLabel: ['chaotic with frequent rework or callbacks','loose with weekly lost time','decent with occasional gaps','tight and optimized'][Math.min(a.schedEff??1,3)],
    ownerDepLabel: ['everything stalls without the owner','major issues and firefighting','minor hiccups. team covers most of it','runs fine without the owner'][Math.min(a.ownerDep??1,3)],
    total:`~$${L.total.toLocaleString()}`, totalRange:`$${L.totalLo.toLocaleString()}–$${L.totalHi.toLocaleString()}`,
    totalMo:`~$${moRound(L.total).toLocaleString()}/month`,
    // Annual figure DERIVED from the displayed monthly so annual === monthly x 12
    // exactly (report leads monthly; the raw L.total is not shown in prose to avoid
    // a rounded-monthly vs exact-annual mismatch).
    totalYr:`~$${(moRound(L.total)*12).toLocaleString()}`,
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
- Total opportunity: ${c.totalMo} (about ${c.totalYr}/year, which is the monthly figure x 12; range: ${c.totalRange})
- Top 3: ${c.top3} | Scores: ${c.scores} | Goal: ${c.goal}
- Business scale: ${c.crewNote} (inferred from revenue) | AI adoption today: ${c.aiLabel}
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
19. MONTHLY FIRST: Lead with monthly dollar figures. When citing the total opportunity or any leak category figure, state the per-month number first; you may add the annual figure in parentheses once per section. Any annual figure you write MUST equal the monthly figure you just stated times 12, exactly. Always derive the annual from the monthly (monthly x 12), never from a separate raw calculation, and never show an annual that does not equal your monthly x 12. The client's total estimated leak is ${c.totalMo} (${c.totalYr}/year).
20. This business is located in ${c.city}, which is in the United States. Use ONLY US-specific platforms, directories, regulations, and market data. Never reference Australian platforms (HiPages, Oneflare, ServiceSeeking, Hipages), Australian regulators (WorkSafe, Fair Work), or Australian statistics.
21. HTML only: <p>, <strong>, <h4>, <ul><li>, <ol><li>, <table>, <div class="stat-call">, <div class="script"><span class="slabel">...</span><p>...</p></div>, <div class="action-box"><h5>...</h5><ol>...</ol></div>, <div class="quick-win">, <div class="math-box">
22. WORD BUDGET: Respect the stated word maximum for each section. Shorter is better. No filler, no restating other sections. Scripts and table cells do not count toward the word maximum; all prose does.
23. NO DISCLAIMERS: Do not write disclaimer text or <div class="disclaimer"> blocks. The report appends one consolidated disclaimer block at the end.
24. NEVER use em dashes or en dashes anywhere in the output. Use commas, periods, or parentheses instead.
25. Write at an 8th grade reading level. Short sentences. Say the number, then show the math, then say what to do. Never assert a precise annual outcome without the word estimate; prefer monthly figures and ranges.
26. TEACH, DO NOT JUST INSTRUCT. In every WHAT THIS MEANS beat, explain the mechanism before the fix. First say WHY this leak happens to most owners like them: it is structural, built into how a busy business runs, not a matter of effort or how much they care. Then say HOW the money actually escapes, in plain steps. Land one simple everyday analogy where it helps (a leaky pipe, a screen door left open, a bucket with a hole). Be direct and a little blunt: name the uncomfortable truth first, then point to the fix. Translate any jargon into plain words the moment you use it. One idea per sentence. The reader should finish able to explain the concept to their spouse, not just holding a task. Keep it tight: better words, not more words, and stay inside the section word budget.
27. FIGURES MUST RECONCILE. All figures in a section must agree with each other. The monthly dollar figure given to you in THE NUMBER / DEPTH RULE for this section is authoritative: use that exact number, and make the arithmetic in THE MATH end at that exact monthly figure. If you state a monthly number and an annual number, the annual MUST equal the monthly times 12, exactly, and the monthly MUST equal the annual divided by 12. Never present two dollar figures that do not reconcile this way. When a calculation naturally lands on an annual figure (a share of yearly revenue, a count of customers per year, a yearly hours cost), compute the annual first, then divide by 12 to reach the monthly, and label each line as /yr or /mo so the two never get confused. State the TIMEFRAME of every input you use: say whether a count is a one-time snapshot (sitting right now), a per-month flow (new each month), or a per-year total. A one-time backlog you can recover once must be labeled "one-time", never presented as monthly or annual recurring revenue, and never multiplied by 12. When a section shows both a one-time recovery and an ongoing figure, keep them clearly separate and label each, and make sure the one-time figure is not numerically equal to the annualized ongoing figure in a way that reads as double counting.
28. DO NOT ASSUME THEIR SOFTWARE. Never assume the business uses any particular CRM, job-management app, booking tool, or scheduling software, and never assume they use any software at all. Some run on a phone and a paper calendar, some use a generic tool, some use an industry-specific one. Refer to "your job intake and scheduling system (whatever you use today, even if that is a phone and a paper calendar)". Explain every automation as a system-agnostic PRINCIPLE first: capture every lead, reply instantly, follow up automatically, remind about invoices. Only when a tool is genuinely needed, name the CATEGORY and at most ONE example product, and say plainly it is one option among many, not a requirement. Never name a specific product as if they already use it or must buy it. If they appear to use nothing today, the first step is lightweight (a shared list, a template, a single automation), never "buy" an expensive platform.`;
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
  // AI Leverage math: monthly value of automating the automatable share of admin
  const aiMoVal = Math.round((c.adminH || 8) * 0.6 * 45 * 4.3);
  // ROI projection base: the DISPLAYED monthly total leak (report is monthly-led).
  // Recovery figures are per-month; the final column is the cumulative 90-day sum.
  const moTot = moRound(c.L.total);
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
  // FIXED SECTION SKELETON — all 8 quantified leak sections share one shape:
  // say the number, show the work, translate it, fix it, set expectations.
  // The math box replaces vague authority with visible arithmetic from THEIR data.
  const skel = (o) => `\nSTRUCTURE, MANDATORY: use these EXACT five subheadings, each in its own <h4> tag, in this EXACT order: THE NUMBER, THE MATH, WHAT THIS MEANS, THE FIX, WHAT TO EXPECT. No other subheadings. Every quantified section of this report uses this identical shape.\n\n<div class="quick-win">[${o.qw}]</div>\n\n<h4>THE NUMBER</h4>\n<p>[ONE sentence stating the estimated monthly leak in dollars. ${o.number}]</p>\n\n<h4>THE MATH</h4>\n<div class="math-box">You told us: [${o.told}].<br>Benchmark: [${o.bench}].<br>The gap: [${o.gap} Write the arithmetic out visibly with x and = signs, using ONLY the client data above, ending at the monthly estimate. Format like: 45 leads x 18 pct gap x $850 avg job = ~$6,885/mo. No unstated multipliers: every factor in the equation must be named. RECONCILE: label the timeframe of every input (a one-time snapshot, a per-month flow, or a per-year total) and never mix them without labeling; if you also state an annual figure it MUST equal the monthly figure times 12, exactly. Never present two numbers that contradict.]</div>\n\n<h4>WHAT THIS MEANS</h4>\n<p>[TEACH the mechanism here, do not just restate the loss. 3-4 short plain sentences at an 8th grade level, one idea each, second person. First: WHY this leak happens to most owners like them, and make clear it is structural (built into how a busy business runs), not a matter of effort or caring. Then: HOW the money actually escapes, step by step in plain words. Then land ONE simple everyday analogy (a leaky pipe, a screen door left open, a bucket with a hole) so they could explain it to their spouse. Name the uncomfortable truth plainly before pointing to the fix. ${o.means}]</p>\n\n<h4>THE FIX</h4>\n${o.fix}\n\n<h4>WHAT TO EXPECT</h4>\n<p>[One or two sentences: a conservative recovery range in $/mo and the time window to see it. ${o.expect}]</p>\n\nWORD BUDGET: maximum 300 words of prose. Scripts are exempt from the word cap and must stay complete, word-for-word.`;
  const prompts = {
    EXEC:`${base}\nWrite ONLY the [EXEC] section. First line: [EXEC]\n\nMaximum 200 words total. 3 short paragraphs:\n- Para 1: Open with the ${c.totalMo} estimated leak (about ${c.totalYr} a year, which is the monthly figure x 12; range: ${c.totalRange}). Monthly figure first. Conservative language, plain words.\n- Para 2: The top 3 leaks: ${c.top3}. One line each: the number and what is causing it.\n- Para 3: The next 90 days. Quote "businesses in ${c.ind} typically recover 15-25% in 90 days." Keep it realistic.\n<div class="stat-call">One real industry statistic with source name relevant to ${c.ind}.</div>\nEND the section with this EXACT sentence as its own final paragraph: <p><strong>If you read nothing else: do the play on the next page this week.</strong></p>`,

    QUICKWIN:`${base}\nWrite ONLY the [QUICKWIN] section. First line: [QUICKWIN]\n\nThis section appears right after the executive summary and is the FIRST thing the reader acts on. One play only: reactivating their dead and dormant quotes. They reported approximately ${c.dead} unanswered or dormant quotes sitting in their pipeline. The play must be doable TODAY, cost $0, and require no marketing, no ads, and no new software. Just their phone and their quote list. Maximum 300 words of prose; the scripts must stay complete and word-for-word (they are the value and do not count toward the limit).\n\n<h4>The Play: Reactivate Your ${qwContacts} Most Recent Dead Quotes</h4>\n<p>2-3 sentences: pull the ${qwContacts} most recent unconverted quotes and work ONLY those today. Why recency matters for reactivation in ${c.ind}.</p>\n<h4>The Exact Sequence: 2 Texts + 1 Call</h4>\nWrite each message COMPLETE and word-for-word, specific to ${c.ind}. The ONLY allowed placeholder is the customer's first name written as [Name].\n<div class="script"><span class="slabel">Text 1 - Send This Morning (under 160 characters)</span><p>[Complete text message]</p></div>\n<div class="script"><span class="slabel">Text 2 - Send 4 Hours Later If No Reply (under 160 characters)</span><p>[Complete text message, different angle, ends with an easy yes/no question]</p></div>\n<div class="script"><span class="slabel">Call - End of Day for Anyone Who Has Not Replied (30-second voicemail script)</span><p>[Complete word-for-word voicemail script]</p></div>\n<h4>What This Is Worth</h4>\n<p>Walk the math conservatively: ${qwContacts} contacts x 5-10% reactivation x ~${c.avgLo} average job value = approximately $${qwLo} to $${qwHi} in recovered revenue from a single afternoon. Use "estimated" language. One sentence on why 5-10% is deliberately conservative against the 10-20% reactivation rates re-engagement campaigns typically see.</p>\n<div class="action-box"><h5>Do It Today: 4 Steps, Under 1 Hour of Work</h5><ol><li>[pull the ${qwContacts} most recent unconverted quotes, with time estimate]</li><li>[send Text 1 to all of them, time estimate]</li><li>[send Text 2 at the 4-hour mark to non-responders, time estimate]</li><li>[end-of-day calls to the rest, time estimate]</li></ol></div>`,

    BENCH:`${base}\nWrite ONLY the [BENCH] section. First line: [BENCH]\n\nThis single section replaces a KPI dashboard, an industry benchmark analysis, and a competitive comparison. It is ONE tight table plus short commentary. HARD LIMIT: maximum 300 words of prose plus the one table.\n\n<h4>Your Numbers vs The Benchmarks</h4>\n<table><tr><th>Metric</th><th>You</th><th>Benchmark</th><th>What the gap costs</th></tr>\n<tr><td>Close rate</td><td>~${c.close}</td><td>${c.bench.closeRate}%</td><td>~$${catMo('close rate').toLocaleString()}/mo</td></tr>\n<tr><td>Repeat customer rate</td><td>~${Math.round((c.L.meta.retRate||0.15)*100)}%</td><td>${c.bench.retention}%</td><td>~$${catMo('retention').toLocaleString()}/mo</td></tr>\n<tr><td>Referral rate</td><td>~${Math.round((c.L.meta.refRate||0.10)*100)}%</td><td>${c.bench.referralPct}%</td><td>[one short phrase, not a dollar figure]</td></tr>\n<tr><td>Review count</td><td>${c.L.meta.reviewBand||'unknown'}</td><td>${c.bench.reviewCount}</td><td>[one short phrase]</td></tr>\n<tr><td>Payment collection</td><td>${c.payLabel}</td><td>within 14 days</td><td>~$${catMo('cash').toLocaleString()}/mo</td></tr>\n<tr><td>Weekly admin hours</td><td>~${c.adminH} hrs</td><td>[automatable target]</td><td>~$${catMo('owner leverage').toLocaleString()}/mo</td></tr></table>\nThe dollar figures in the "What the gap costs" column are pre-filled with the exact monthly leak figures used elsewhere in this report; keep them exactly as written, do not recompute or change them.\n\nThen exactly 3 short paragraphs:\n1. The one gap in this table that costs the most, and the single action that closes it.\n2. Where they sit against the typical operator in their space: price leaders vs premium operators vs niche specialists, and which tier the numbers say they should compete in.\n3. The Monday habit: check 5 numbers weekly, across revenue booked, leads in, quote-to-close rate, average job value, and pipeline value. One sentence on why owners who look at numbers first close gaps fastest.\nSource the benchmark figures to: ${c.bench.source}\n<div class="stat-call">Businesses that close benchmark gaps typically do one thing differently: they systematize what top performers do instinctively.</div>\nRemember: 300 words of prose maximum. No sub-dashboards, no extra tables.`,
 
    SPEED:`${base}${depthNote(catMo('speed'))}\nWrite ONLY the [SPEED] section. First line: [SPEED]\n${skel({
      qw:'One specific speed-to-lead action THIS WEEK, e.g. set up a missed-call auto-text or a 5-minute response rule. Under 1 hour',
      number:'Use the DEPTH RULE figure above as the monthly estimate lost to slow lead response.',
      told:`their lead response speed, ~${c.mthLeads} leads/month, ~${c.avgLo} average job, ~${c.close} close rate`,
      bench:`leads contacted within 5 minutes are roughly 21x more likely to qualify than at 30 minutes (InsideSales.com research cited by HBR), and the first responder wins most jobs`,
      gap:`~${c.mthLeads} leads/month (a per-month flow) x [share lost to faster competitors for their response tier: 0 pct within 5 minutes, 3 pct within an hour, 6 pct same day, 12 pct next day or later] x ~${c.close} close rate x ~${c.avgLo} avg job = the monthly estimate. Every input here is already monthly, so this lands directly on the monthly figure; end at the DEPTH RULE monthly figure above. If you add an annual, it MUST be that monthly x 12.`,
      means:'You are paying to generate leads that a faster competitor books. Slow response does not lose bad leads. It loses the ready-to-buy ones.',
      fix:`<ol><li>[Set up missed-call text-back: tool category and time estimate]</li><li>[The 5-minute response rule during work hours: who owns the phone, what the instant reply says]</li><li>[After-hours catch: what fires when nobody can answer]</li><li>[Weekly check: response time on the last 10 leads]</li></ol>\n<div class="script"><span class="slabel">Missed-Call Text-Back Message (under 160 characters)</span><p>[Complete text message: acknowledges the missed call, promises a callback time, asks one easy question]</p></div>\n<div class="script"><span class="slabel">Instant Web-Form Reply (under 160 characters)</span><p>[Complete text/email auto-reply]</p></div>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: the missed-call text-back and instant reply above can fire automatically without anyone at the phone, and point the reader to the AI Leverage section. No selling.]</p>`,
      expect:'Base it on closing most of the response-speed gap within 2 to 4 weeks of the text-back going live.'
    })}`,

    CONV:`${base}${depthNote(catMo('close rate'))}\nWrite ONLY the [CONV] section. First line: [CONV]\n${skel({
      qw:`One specific action THIS WEEK to improve lead conversion in ${c.ind}. Under 1 hour`,
      number:'Use the DEPTH RULE figure above as the monthly estimate for the close-rate gap. If the gap is $0, open with the strength instead: they are at or above benchmark, and this section protects the ceiling.',
      told:`close rate ~${c.close} from their last 10 quotes, ~${c.mthLeads} leads/month, ~${c.avgLo} average job`,
      bench:`${c.bench.closeRate}% close rate for ${c.bench.label} (${c.bench.source}); Salesforce: 80% of sales take 5 or more follow-up touches`,
      gap:`~${c.mthLeads} leads/month (a per-month flow) x [close-rate gap in points: the 65 pct benchmark minus their ~${c.close}] x ~${c.avgLo} avg job x 0.7 (a 30 pct lead-quality haircut, because not every extra point of close rate is winnable) = the monthly estimate. Every input is already monthly, so this lands directly on the monthly figure; end at the DEPTH RULE monthly figure above. If you add an annual, it MUST be that monthly x 12.`,
      means:'Most quotes do not die from a no. They die from silence, because nobody followed up a second, third, or fifth time.',
      fix:`<ol><li>[Put every open quote into one list, time estimate]</li><li>[Schedule the 5-email sequence below on every new quote, time estimate]</li><li>[Name one follow-up owner: who sends, and when]</li></ol>\nCRITICAL: Write each email COMPLETE, no placeholders. 45-70 words each.\n<div class="script"><span class="slabel">Email 1 - Same Day (Subject: [specific subject for ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Email 2 - Day 2 (Subject: [specific subject])</span><p>[Complete 60-word email]</p></div>\n<div class="script"><span class="slabel">Email 3 - Day 5 (Subject: [specific subject])</span><p>[Complete 60-word email, addresses the most common ${c.ind} objection]</p></div>\n<div class="script"><span class="slabel">Email 4 - Day 10 (Subject: [specific subject])</span><p>[Complete 55-word email, mild urgency]</p></div>\n<div class="script"><span class="slabel">Email 5 - Day 21 (Subject: Closing the loop)</span><p>[Complete 45-word breakup email]</p></div>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: this whole 5-touch follow-up sequence can send itself automatically on every quote, so no lead slips through silence, and point the reader to the AI Leverage section. No selling.]</p>`,
      expect:'Tie the range to running the sequence on every quote for 30 days.'
    })}`,


    DEAD:`${base}${depthNote(catMo('dormant'))}\nWrite ONLY the [DEAD] section. First line: [DEAD]\n${skel({
      qw:`One specific action THIS WEEK to re-engage cold leads in ${c.ind}. Under 1 hour`,
      number:'Use the DEPTH RULE monthly figure above as the recurring monthly leak from dead and dormant quotes going cold and never being worked again. If you also give an annual, it MUST be that monthly figure x 12. Do NOT state a separate one-time backlog dollar figure in this section; the one-time reactivation play and its own dollar range are covered in the Do This Week section.',
      told:`approximately ${c.dead} quotes sitting dormant right now (a one-time snapshot of the current pile), plus more quotes going cold every month, ~${c.avgLo} average job`,
      bench:`re-engagement campaigns typically reactivate 10-20% of dormant leads; this report uses a conservative 12%`,
      gap:`~${c.dead} dormant quotes (a one-time snapshot) x 12 pct reactivation x ~${c.avgLo} avg job sizes the recoverable value sitting in the pipeline; worked down over the year, that recurring loss is the DEPTH RULE figure of ~$[monthly]/mo (or ~$[monthly x 12]/yr, which MUST equal the monthly x 12). Name every factor and end at that monthly figure. Do NOT also state the raw pile value as a separate one-time dollar amount here, and never multiply the monthly by anything other than 12. The one-time "clear the backlog this afternoon" play and its dollar range live in the Do This Week section; this section states only the recurring monthly and its x 12 annual.`,
      means:'These people already asked you for a price. They are the cheapest revenue you will ever win back. Every week they sit, more of them hire someone else.',
      fix:`<ol><li>[Pull the full dormant quote list, newest first, time estimate]</li><li>[Send the re-engagement email below, time estimate]</li><li>[Text the non-responders 3 days later, time estimate]</li><li>[Final email at day 10, then archive, ongoing]</li></ol>\n<div class="script"><span class="slabel">Re-engagement Email (Subject: [specific to ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Follow-Up Text - 3 Days Later (under 140 chars)</span><p>[Complete text]</p></div>\n<div class="script"><span class="slabel">Final Email - Day 10 (Subject: Last one from us)</span><p>[Complete 45-word closing email]</p></div>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: an automated quote follow-up sequence can work this dormant list for you on a schedule instead of by hand, and point the reader to the AI Leverage section. No selling.]</p>`,
      expect:'First reactivated jobs typically book within 1 to 2 weeks of the first send.'
    })}`,
 
    SYSTEMS:`${base}\nWrite ONLY the [SYSTEMS] section. First line: [SYSTEMS]\n\nMaximum 250 words of prose plus the one table.\n\n<div class="quick-win">[One specific automation action THIS WEEK for ${c.ind} — one repetitive manual task to automate in under an hour]</div>\n\n<h4>Systems & Automation Diagnosis</h4>\n<p>They report approximately ${c.adminH} hours/week of manual admin (quoting, invoicing, follow-up, scheduling). At a conservative $45/hour replacement cost, that is approximately $${Math.round(c.adminH*52*45).toLocaleString()}/year of owner or staff time on work software can do. Roughly 60% of it is automatable with today's tools, reclaiming an estimated ${Math.round(c.adminH*0.6)} hours/week. Honest assessment specific to ${c.ind}.</p>\n<h4>What to Automate First — Ranked by Hours Reclaimed</h4>\n<table><tr><th>Rank</th><th>Process</th><th>Est. Hours/Week Reclaimed</th><th>How (specific to ${c.ind})</th></tr><tr><td>1</td><td>[highest-hour manual process, e.g. lead follow-up]</td><td>[hours]</td><td>[specific automation approach]</td></tr><tr><td>2</td><td>[process]</td><td>[hours]</td><td>[approach]</td></tr><tr><td>3</td><td>[process]</td><td>[hours]</td><td>[approach]</td></tr><tr><td>4</td><td>[process]</td><td>[hours]</td><td>[approach]</td></tr></table>\n<h4>The Follow-Up Machine</h4>\n<p>The single highest-value automation for ${c.ind}: automatic speed-to-lead response and structured follow-up sequences. What it looks like when running, and the estimated revenue it protects given their ~${c.close} close rate and ~${c.mthLeads} leads/month. 3-4 sentences.</p>\n<h4>AI and Modern Automation for ${c.ind}</h4>\n<p>Where AI-driven automation realistically helps a ${c.ind} business at ${c.revRange}: quote drafting, review responses, appointment reminders, invoice chasing, job notes. What to adopt now vs skip. Practical, no hype. 2-3 sentences, ending with ONE sentence naming the single tool category (and one example product) that covers most of this for their trade — no software shopping lists.</p>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: scheduling and new-lead intake can run automatically for a ${c.ind} business so jobs book and route without manual entry, and point the reader to the AI Leverage section. No selling.]</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    AI:`${base}\nWrite ONLY the [AI] section. First line: [AI]\n\nThis section is "AI Leverage": where AI can take real work off the owner's plate THIS quarter. Their current adoption level: ${c.aiLabel}. Sequence every recommendation to that level:\n- If nothing is running yet (or they tried tools and nothing stuck): start with the two proven entry points, missed-call text-back and automated review requests. Near-zero risk, live in a day, no new habits required. If tools did not stick before, say why that usually happens (tool chosen before the job was defined) and how starting smaller fixes it.\n- If one AI tool already runs part of the business (booking, quoting, or follow-up): extend into the neighboring jobs, quoting, invoicing, and follow-up automation around what already works.\n- If AI already handles several jobs: focus on connecting the pieces (lead intake to quote to invoice to review request) and measuring what each automation saves per week.\nConcrete tool-category guidance only: name the CATEGORY and at most ONE example product per category. No shopping lists. Do not sell any service. Show what is possible and practical this quarter; the report closes with how to get help if they want it.\n\nSTRUCTURE, MANDATORY: use these EXACT five subheadings, each in its own <h4> tag, in this EXACT order: THE NUMBER, THE MATH, WHAT THIS MEANS, THE FIX, WHAT TO EXPECT.\n\n<div class="quick-win">[The single first AI move for their adoption level, live within a week, under 1 hour of setup]</div>\n\n<h4>THE NUMBER</h4>\n<p>[One sentence: an estimated ~$${aiMoVal.toLocaleString()}/mo of owner time is sitting in admin work AI can take over.]</p>\n\n<h4>THE MATH</h4>\n<div class="math-box">You told us: [~${c.adminH} hrs/week of manual admin; AI today: ${c.aiLabel}].<br>Benchmark: [roughly 60% of small-business admin is automatable with current tools, valued at a conservative $45/hr].<br>The gap: ${c.adminH} hrs/week x 60 pct x $45/hr x 4.3 weeks = ~$${aiMoVal.toLocaleString()}/mo of owner time.</div>\n\n<h4>WHAT THIS MEANS</h4>\n<p>[TEACH why AI is the single highest-leverage move for a small operator, sized to their adoption level. 3-4 short plain sentences, one idea each. Make two points clearly: first, the hours AI hands back are not a one-time saving, they compound every single week; second, once the boring admin runs itself, every other fix in this report (follow-up, retention, collections) keeps running without the owner touching it. AI here is not a project for later, it is one or two boring automations that free the owner to sell and lead. Use a plain analogy if it helps.]</p>\n\n<h4>THE FIX</h4>\n<p>[Walk the full owner-time chain and show where AI plugs into EACH step, sequenced to their adoption level (${c.aiLabel}). For each step name the job AI does, the tool CATEGORY, at most ONE example product, and rough setup effort. Category plus one example only. No shopping lists, no selling.]</p>\n<ol><li>[Lead intake: capture the lead and reply instantly, e.g. missed-call text-back]</li><li>[Quote or estimate: draft and send faster]</li><li>[Follow-up: an automated multi-touch sequence on every open quote]</li><li>[Scheduling: booking, reminders, and routing without manual entry]</li><li>[Invoicing and collections: automated reminders until paid]</li><li>[Review requests: an automatic ask after every completed job]</li></ol>\n<p>[ONE sentence: which single step to start with for their current level and why, so they do not try to automate everything at once.]</p>\n\n<h4>WHAT TO EXPECT</h4>\n<p>[Conservative: estimated hours per week back and what that is worth per month, within 30 to 60 days.]</p>\n\nWORD BUDGET: maximum 420 words of prose.`,

    RET:(()=>{
      const lowRepeat = c.lowRepeat;
      const retNote = `\nREPEAT-CUSTOMER LEVEL: the owner reported their repeat-customer share as level ${c.repeatLevel} on a 0 (very low) to 4 (very high) scale. ${lowRepeat ? 'This is a naturally LOW-repeat business (one-off, big-ticket, or project / new-construction work). USE FRAMING B.' : 'This is a normal-to-high repeat business. USE FRAMING A.'}\nFRAMING A (normal/high repeat): treat this as a customer retention leak. The money is in getting past customers to buy again.\nFRAMING B (low repeat): do NOT call this a retention leak or imply the owner is failing to keep customers. In the intro, acknowledge plainly that their business may be naturally low-repeat (one-off or project work) and that this is normal for their trade. Pivot the money to REFERRALS from happy customers and UPSELL / adjacent-scope work per job (bigger scope, add-ons, the next logical project), because that is where the money is in a low-repeat business, not repeat visits. The math and THE FIX must target referrals and upsell, not repeat purchase frequency.`;
      return `${base}${depthNote(catMo('retention'))}${retNote}\nWrite ONLY the [RET] section. First line: [RET]\nThe section title stays "Customer Retention"${lowRepeat ? ', but open with a short parenthetical or adaptive subhead making clear the focus for a naturally low-repeat business is referrals and larger-scope work' : ''}.\n${skel({
      qw: lowRepeat ? `One specific action THIS WEEK to earn a referral or offer adjacent-scope work to a recent ${c.ind} customer. Under 1 hour` : `One specific retention action THIS WEEK: call or email one specific type of past customer in ${c.ind}. Under 1 hour`,
      number: lowRepeat ? 'Use the DEPTH RULE figure above as the monthly estimate being left on the table in un-asked referrals and un-offered upsell / adjacent-scope work.' : 'Use the DEPTH RULE figure above as the monthly estimate from customers who never come back.',
      told: lowRepeat ? `a naturally low repeat share (~${Math.round((c.L.meta.retRate||0.15)*100)}% return, which is normal for one-off or project work), ~${c.annCusts} customers/year, ~${c.avgLo} average job` : `~${Math.round((c.L.meta.retRate||0.15)*100)}% of customers return, ~${c.annCusts} customers/year, ~${c.avgLo} average job`,
      bench: lowRepeat ? `referred customers close at higher rates and carry 16-25% higher lifetime value (Wharton / Texas Tech); one happy customer typically produces about 1.2 referrals` : `${c.bench.retention}% retention for ${c.bench.label} (${c.bench.source}); Bain & Company: a 5 point retention lift grows profit 25-95%`,
      gap: lowRepeat ? `[referrals per happy customer] x ~${c.annCusts} customers/YEAR x [referral close rate] x ~${c.avgLo} avg job, PLUS an upsell / adjacent-scope lift of a few points on ~${c.annCusts} jobs/YEAR x ~${c.avgLo} avg job = the ANNUAL estimate (label it /yr), then divide by 12 to reach the monthly. These inputs are per-YEAR, so the raw product is annual, NOT monthly; end at the DEPTH RULE monthly figure above and show the annual as that monthly x 12. Name every factor.` : `[retention gap in points: the 35 pct benchmark minus their repeat rate] x ~${c.annCusts} customers/YEAR x ~${c.avgLo} avg job x 0.35 (a 35 pct attribution haircut, because not every non-returning customer was winnable) = the ANNUAL estimate (label it /yr). Because customers/year is a per-YEAR count, this product is annual, NOT monthly: divide it by 12 to reach the monthly, and end at the DEPTH RULE monthly figure above (show the annual as that monthly x 12). Also state the estimated lifetime value once: ${c.avgMid} avg x ~1.5 jobs/yr x 4 yrs = ~$${clvEstimate}.`,
      means: lowRepeat ? 'In a one-off business the same happy customer will not buy again soon, so the money is in who they send you and how much scope you win per job. Most owners never ask, so the referrals never come and the extra scope never gets offered.' : 'A customer who already paid you costs nothing to win again. Right now most of them finish one job and never hear from you after.',
      fix: lowRepeat ? `<ol><li>[Add a referral ask to the job-completion routine: who asks, exactly when, time estimate]</li><li>[Build one simple upsell or adjacent-scope offer for their main service and present it on every job, time estimate]</li><li>[Send the referral / check-in message below to recent completed customers, time estimate]</li><li>[Wire both into the close-out checklist so they run on every job, ongoing]</li></ol>\n<div class="script"><span class="slabel">Referral Ask at Job Completion (word-for-word, ~50 words)</span><p>[Full script, warm, specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">Adjacent-Scope Offer (word-for-word, ~50 words)</span><p>[Complete script offering the next logical project or add-on]</p></div>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: the referral ask and follow-up can fire automatically after every completed job, and point the reader to the AI Leverage section. No selling.]</p>` : `<ol><li>[List every customer from the last 12 months with no repeat job, time estimate]</li><li>[Send the 30-day check-in below to recent completions, time estimate]</li><li>[Queue the 6-month re-engagement text for everyone older, time estimate]</li><li>[Wire both into the job-completion routine so they run on every job, ongoing]</li></ol>\n<div class="script"><span class="slabel">30-Day Post-Job Check-In (Email, 70 words)</span><p>[Full email, warm, specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">6-Month Re-Engagement (Text, under 140 chars)</span><p>[Complete text]</p></div>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: these check-in and re-engagement messages can fire automatically at the right interval after every job, and point the reader to the AI Leverage section. No selling.]</p>`,
      expect: lowRepeat ? 'First referred jobs and upsell wins usually show within 30 to 60 days of adding the ask to every job.' : 'Repeat bookings usually show within 30 to 60 days of the first check-in batch.'
    })}`;
    })(),
 
    REF:`${base}\nWrite ONLY the [REF] section. First line: [REF]\n\nThis single SHORT section covers BOTH referrals and reviews. They are not quantified leak buckets — they are retention-adjacent operations routines that generate free leads. HARD LIMIT: maximum 250 words of prose (scripts excluded). No quick-win div.\n\n<h4>The Free Lead Engine</h4>\n<p>2-3 sentences: referred and review-driven customers cost $0 to acquire and close at higher rates. Referral math in one line: each activated customer produces ~1.2 referrals at ~${c.avgLo} average and ~55% conversion (Texas Tech / Wharton: referred customers carry 16-25% higher LTV). Benchmarks: referral average ${c.bench.referralPct}%, review benchmark ${c.bench.reviewCount} reviews (${c.bench.source}).</p>\n<h4>Two Routines, Wired Into Job Completion</h4>\n<p>Routine 1 — the referral ask at job completion, every time. Routine 2 — the review request text 24-48 hours after completion, every time. Both run as part of the close-out checklist so nobody has to remember. 3-4 sentences on how to wire this in.</p>\n<div class="script"><span class="slabel">Referral Ask (word-for-word at job completion)</span><p>[Complete 50-word script]</p></div>\n<div class="script"><span class="slabel">Review Request Text — 24-48 Hours After Completion (under 140 chars)</span><p>[Complete text with [your Google review link]]</p></div>\n<div class="action-box"><h5>3 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[ongoing]</li></ol></div>\nRemember: 250 words of prose maximum.`,
 
    PRICE:`${base}${depthNote(catMo('pricing'))}\nWrite ONLY the [PRICE] section. First line: [PRICE]\n${skel({
      qw:'One specific pricing action THIS WEEK: test a price increase on new quotes starting today',
      number:'Use the DEPTH RULE figure above as the monthly estimate from stale pricing and unknown margins.',
      told:`when they last raised prices (see the pricing category description in the client data) and margin visibility: ${c.jobCostingLabel}`,
      bench:`McKinsey: a 1% price improvement lifts profit roughly 11% for a typical business; inflation erodes any unraised price every year`,
      gap:`stale pricing plus unknown margins cost a few points of annual revenue. Write it as ~${c.revMid} annual revenue (a per-YEAR total) x [the margin-leak percent, name it, a few points] = ~$[annual]/yr, then divide by 12 to reach ~$[monthly]/mo. Use the revenue MIDPOINT (${c.revMid}) as the base, not the low figure. End at the DEPTH RULE monthly figure above, and show the annual as that monthly x 12 (they MUST reconcile). Name every factor.`,
      means:'Holding prices flat is a silent pay cut every year. Your customers are far less price-sensitive than the fear says.',
      fix:`<ol><li>[Raise prices 7-10% on NEW quotes only, starting today: exact first step, time estimate]</li><li>[Track close rate on the next 10 quotes at the new price: what signal confirms it held]</li><li>[Build a simple Good / Better / Best tier for their main service: approximate prices and what each includes, time estimate]</li></ol>\n<div class="script"><span class="slabel">Price Increase Communication Script</span><p>[Complete 70-word script, confident, value-focused]</p></div>\n<div class="script"><span class="slabel">Premium Tier Presentation Script</span><p>[Complete 70-word script, presents 3 options naturally]</p></div>`,
      expect:'Margin lift shows on the first jobs quoted at the new price, usually within the first month.'
    })}`,
 
    OPS:`${base}${depthNote(catMo('capacity'))}\nWrite ONLY the [OPS] section. First line: [OPS]\n${skel({
      qw:`One specific operations action THIS WEEK: fix one scheduling gap or add one quality checkpoint in ${c.ind}. Under 1 hour`,
      number:'Use the DEPTH RULE figure above as the monthly estimate from scheduling waste, callbacks, and turned-away work.',
      told:`scheduling is ${c.schedLabel}, ~${c.avgLo} average job, ${c.crewNote}`,
      bench:`callbacks, windshield time, and gaps between jobs are capacity already paid for but never billed; a complaint costs 4-6x the transaction (at ~${c.avgMid} that is roughly $${complaintCostLo} to $${complaintCostHi} each)`,
      gap:`[recoverable jobs per WEEK from tighter routing and fewer callbacks] x ~${c.avgLo} avg job x 4.3 weeks/month = the monthly estimate. The jobs figure is a per-week flow, so x 4.3 weeks makes it monthly; end at the DEPTH RULE monthly figure above, and if you add an annual it MUST be that monthly x 12. Name every factor.`,
      means:'You do not need more leads to make more money this month. You need the hours you already pay for to turn into billed jobs.',
      fix:`<ol><li>[Batch jobs by area to cut drive time: the exact scheduling change, time estimate]</li><li>[One end-of-job quality checklist that kills the most common callback in ${c.ind}, time estimate]</li><li>[Write the single most impactful SOP for their trade: name it and what it covers, time estimate]</li><li>[Track callbacks per week somewhere visible, ongoing]</li></ol>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: job scheduling, routing, and appointment reminders can be automated for a ${c.ind} business so fewer slots go unbilled, and point the reader to the AI Leverage section. No selling.]</p>`,
      expect:'Recovered capacity typically shows as 1 to 2 extra billable slots per week within the first month.'
    })}`,

    LEVERAGE:`${base}${depthNote(catMo('owner leverage'))}\nWrite ONLY the [LEVERAGE] section. First line: [LEVERAGE]\n${skel({
      qw:'One specific delegation action THIS WEEK: hand off or document one task the owner does out of habit, not necessity',
      number:'Use the DEPTH RULE figure above as the monthly estimate of owner time burned on automatable admin plus owner-dependence drag.',
      told:`~${c.adminH} hours/week of manual admin, and when the owner takes a week off: ${c.ownerDepLabel}`,
      bench:`$45/hr conservative replacement cost for admin work; roughly 60% of manual admin is automatable with today's tools`,
      gap:`${c.adminH} hrs/week (a per-week flow) x 60 pct automatable x $45/hr x 4.3 weeks/month = the core admin part of the monthly estimate; the owner-dependence drag adds the rest, up to the DEPTH RULE monthly figure above. End at that DEPTH figure, and if you add an annual it MUST be that monthly x 12. Name every factor.`,
      means:'The owner is the most expensive employee doing the cheapest work in the business. That caps growth and makes the business worth less to a buyer.',
      fix:`<ol><li>[Pick the one recurring task to hand off this week: the exact task and to whom]</li><li>[Record yourself doing the most repeated process once, then turn it into a one-page checklist, time estimate]</li><li>[Name the first 3 SOPs a ${c.ind} business should write, in order]</li><li>[Set the 90-day one-week-off test: the 4-5 things that must be true to pass, based on their answers]</li></ol>\n<table><tr><th>Bucket</th><th>Typical owner tasks</th><th>First move</th></tr><tr><td><strong>Eliminate</strong></td><td>[tasks that should not exist]</td><td>[specific action]</td></tr><tr><td><strong>Automate</strong></td><td>[repetitive admin, link to the Systems and AI Leverage sections]</td><td>[specific action]</td></tr><tr><td><strong>Delegate</strong></td><td>[tasks a team member or VA can own]</td><td>[specific action]</td></tr><tr><td><strong>Do</strong></td><td>[the 3-4 things only the owner should do]</td><td>[specific action]</td></tr></table>`,
      expect:'Reclaimed hours show within 2 weeks of the first handoff; the dollar value follows as those hours go to quoting and selling.'
    })}`,
 
    PRIORITY:`${base}\nWrite ONLY the [PRIORITY] section. First line: [PRIORITY]\n\nThis is the single master fix list for the whole report. There is NO separate implementation checklist — do not write one, and do not duplicate items. One ranked table plus two short paragraphs. Maximum 300 words of prose plus the ranked table.\n\n<h4>Your Fix Order</h4>\n<table><tr><th>Rank</th><th>Fix</th><th>Est. $/mo</th><th>Effort</th><th>Start</th></tr>\n${c.L.cats.map((cat,i)=>`<tr><td><strong>#${i+1}</strong></td><td><strong>${cat.n}</strong> — [one-line specific fix]</td><td>~$${moRound(cat.amt).toLocaleString()}/mo</td><td>[Low / Medium / High]</td><td>[Week 1-12]</td></tr>`).join('\n')}\n</table>\nFill in each bracketed cell: a one-line specific fix, an honest effort rating (Low / Medium / High), and the week number to start (sequence the low-effort, high-dollar fixes first).\n<p>Then write 2 short paragraphs explaining the sequencing — why this order maximizes early recovered revenue for ${c.biz}, and how early wins fund the discipline for the later fixes. Specific, conservative language.</p>`,
 
    ROI:`${base}\nWrite ONLY the [ROI] section. First line: [ROI]\n\nMaximum 200 words of prose plus the projection table.\n\n<h4>Conservative Recovery Projection</h4>\n<table>\n<tr><th>Scenario</th><th>Recovery Rate</th><th>Month 1 Est.</th><th>Month 2 Est.</th><th>Month 3 Est.</th><th>90-Day Total</th></tr>\n<tr><td>Conservative</td><td>15%</td><td>~$${Math.round(moTot*0.15*0.15).toLocaleString()}</td><td>~$${Math.round(moTot*0.15*0.50).toLocaleString()}</td><td>~$${Math.round(moTot*0.15).toLocaleString()}</td><td>~$${Math.round(moTot*0.15*1.65).toLocaleString()}</td></tr>\n<tr><td>Realistic</td><td>22%</td><td>~$${Math.round(moTot*0.22*0.20).toLocaleString()}</td><td>~$${Math.round(moTot*0.22*0.55).toLocaleString()}</td><td>~$${Math.round(moTot*0.22).toLocaleString()}</td><td>~$${Math.round(moTot*0.22*1.75).toLocaleString()}</td></tr>\n<tr><td>Optimistic</td><td>32%</td><td>~$${Math.round(moTot*0.32*0.25).toLocaleString()}</td><td>~$${Math.round(moTot*0.32*0.60).toLocaleString()}</td><td>~$${Math.round(moTot*0.32).toLocaleString()}</td><td>~$${Math.round(moTot*0.32*1.85).toLocaleString()}</td></tr>\n</table>\n<p>Explain what drives each scenario. Be honest that results vary.</p>\n<h4>Your 30-Minute Walkthrough Call</h4>\n<p>Remind them the audit includes a 30-minute walkthrough call with Flavio DeOliveira, who built it. Tell them exactly what to bring: this report, their last 10 invoices, and their calendar. On the call: confirm the top leak, sanity-check the numbers against real books, and lock in the first three moves. 2-3 sentences, direct.</p>\n<h4>Your Single Most Important Action in the Next 48 Hours</h4>\n<p>[Single most impactful, specific first action for ${c.biz} in ${c.ind} based on their #1 opportunity. 80 to 100 words. Exact steps. Specific to ${c.ind}.]</p>`,

CASH:`${base}${depthNote(catMo('cash'))}\nWrite ONLY the [CASH] section. First line: [CASH]\n${skel({
      qw:'One specific cash action THIS WEEK: chase one aged invoice or cost out the last completed job. Under 45 minutes',
      number:'Use the DEPTH RULE figure above as the monthly estimate from slow collection and write-off risk.',
      told:`typical collection is ${c.payLabel}, margin visibility: ${c.jobCostingLabel}, revenue ${c.revRange}`,
      bench:`well-run businesses in their trade collect on completion or within 14 days`,
      gap:`Two different things, keep them apart. (1) CASH TIED UP, a one-time balance, NOT the leak: at ${c.revMid} annual revenue, 30 days of receivables is about ~$${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12).toLocaleString()} of their own cash locked up at any moment. Label it a one-time balance, do NOT annualize it, and do NOT add it to the leak. (2) THE RECURRING LEAK, which is write-offs plus the financing cost of slow receivables: this is the DEPTH RULE monthly figure above, ~$[monthly]/mo (annual = monthly x 12). Write the leak arithmetic ending at that monthly figure, and never present the cash-tied-up balance as the leak.`,
      means:'Every day between finishing a job and getting paid, you are lending customers money for free. And old invoices quietly turn into invoices that never get paid at all.',
      fix:`<ol><li>[Payment terms on every quote and invoice: exactly what to write. Time: 30 min]</li><li>[Deposit or progress payment structure for their job sizes. Time: 45 min]</li><li>[Automated invoice reminders at day 0, day 7, day 14: tool category and message. Time: 1 hr]</li><li>[Card or ACH payment on site or by link: specific option for their trade. Time: 1 hr]</li><li>[Cost the last 10 completed jobs in one spreadsheet: labor + materials + drive time + overhead vs price. Then reprice, fix, or stop selling the losers. Time: 2 hrs]</li></ol>\n<div class="script"><span class="slabel">Overdue Invoice Call Script - Day 14, Friendly But Firm</span><p>[Complete 60-word phone script, warm, direct, asks for payment today or a date]</p></div>\n<p><strong>AI can do this part for you.</strong> [ONE concrete sentence: the day 0, 7, and 14 invoice reminders can send themselves automatically until an invoice is paid, and point the reader to the AI Leverage section. No selling.]</p>`,
      expect:'Collection time usually tightens within one billing cycle once terms and reminders go live.'
    })}`,

ROADMAP:`${base}\nWrite ONLY the [ROADMAP] section. First line: [ROADMAP]\n\nThis is a SINGLE-PAGE roadmap. Maximum 350 words total. Week-by-week bullets only — no long prose, no day-by-day detail. Every bullet is ONE line: a specific action for their trade with a time estimate.\n\n<h4>Your 90-Day Revenue Recovery Roadmap</h4>\n<p>One sentence: the order matters — early wins fund the discipline for later steps. Start the first item within 48 hours.</p>\n<div class="pgrid">\n<div class="pcard"><div class="ptag">Weeks 1–2</div><div class="ptitle">Immediate Revenue</div>\n<div class="ptask">[Dead-quote reactivation — first batch, from the Do This Week play]</div>\n<div class="ptask">[Missed-call text-back + 5-minute response rule live]</div>\n<div class="ptask">[Follow-up sequence written and scheduled]</div>\n<div class="ptask">[Review requests to last 10 completed customers]</div>\n<div class="ptask">[Weekly 5-number KPI check every Monday — 30 min, non-negotiable]</div>\n<div class="pmile">Milestone: follow-up sequence running, first reactivated jobs booked, KPI habit started.</div>\n</div>\n<div class="pcard"><div class="ptag">Weeks 3–6</div><div class="ptitle">Systems & Pricing</div>\n<div class="ptask">[Get your job intake and follow-up system in order, whatever you use today, with all current leads in one place]</div>\n<div class="ptask">[Price test on new quotes]</div>\n<div class="ptask">[Job costing baseline — margin on last 10 completed jobs]</div>\n<div class="ptask">[Payment terms + automated invoice reminders on every new invoice]</div>\n<div class="ptask">[First SOP written and handed to a named owner]</div>\n<div class="pmile">Milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.08).toLocaleString()}/mo target (~8% above baseline).</div>\n</div>\n<div class="pcard"><div class="ptag">Weeks 7–12</div><div class="ptitle">Optimize & Systematize</div>\n<div class="ptask">[Second dead-lead batch + referral and review routines wired into job completion]</div>\n<div class="ptask">[Double down on the best-converting lead source]</div>\n<div class="ptask">[Delegate or automate one recurring owner task — run the one-week-off test]</div>\n<div class="ptask">[Re-score the diagnostic and set the next 90-day targets]</div>\n<div class="pmile">Milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.22).toLocaleString()}/mo target (~22% above baseline — the realistic scenario).</div>\n</div>\n</div>\nFill in each bracketed bullet with one specific, time-boxed action for their trade. One line each. Remember: 350 words maximum, single page, no prose blocks.`,

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


// ══════════════════════════════════════════════════
//  15-MINUTE RECOVERY EMAIL (resume-to-buy)
//  Every 2 min, sweep the leads DB for unpaid, un-emailed quiz
//  submissions aged 15 min to 24 h, send one short branded nudge
//  with a resume link, then mark followup_sent so nobody is emailed twice.
// ══════════════════════════════════════════════════
const LEADS_URL_R = process.env.LEADS_SUPABASE_URL;
const LEADS_KEY_R = process.env.LEADS_SUPABASE_SECRET_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.revanalysis.com';
let _recoveryEnvWarned = false;

async function sendRecoveryEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY missing, skipping recovery email to', to);
    return false;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'RevAnalysis <reports@revanalysis.com>', to: [to], subject, html }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.warn(`Recovery send failed for ${to}: ${r.status} ${t.slice(0, 200)}`);
    return false;
  }
  return true;
}

function recoveryEmailHtml(firstName, monthlyLeak, resumeUrl) {
  const greetName = firstName ? `, ${firstName}` : '';
  const bigNumber = monthlyLeak ? `~$${monthlyLeak.toLocaleString()}/mo` : 'your revenue leak';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAF6EF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EF;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E8E4DE;border-radius:14px;">
<tr><td style="padding:36px 36px 28px 36px;">
<div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;color:#2B2320;letter-spacing:-0.3px;">RevAnalysis</div>
<div style="height:3px;width:46px;background:#C1502E;border-radius:2px;margin:10px 0 24px 0;"></div>
<p style="margin:0 0 18px 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#2B2320;">You took the quiz${greetName}. You saw the number. You did not grab the full breakdown yet.</p>
<div style="font-family:'Poppins',Helvetica,Arial,sans-serif;font-size:38px;font-weight:800;color:#C1502E;line-height:1.1;margin:6px 0 8px 0;">${bigNumber}</div>
<p style="margin:0 0 22px 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#4A423C;">The $9 audit prices all 9 leaks, shows the math, and gives you the exact fix order.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:#C1502E;">
<a href="${resumeUrl}" style="display:inline-block;padding:14px 30px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#FFF8F0;text-decoration:none;border-radius:999px;">Get my full audit for $9</a>
</td></tr></table>
<p style="margin:20px 0 0 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#6E6259;">Takes 30 seconds. Your answers are saved.</p>
<p style="margin:26px 0 0 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#2B2320;">Flavio DeOliveira, RevAnalysis</p>
</td></tr>
<tr><td style="padding:0 36px 30px 36px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11px;line-height:1.5;color:#9A8C80;">Not interested? Reply with STOP and I will not email again.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function runRecoverySweep() {
  try {
    if (!LEADS_URL_R || !LEADS_KEY_R) {
      if (!_recoveryEnvWarned) {
        console.warn('Recovery: LEADS_SUPABASE_URL / LEADS_SUPABASE_SECRET_KEY not set, recovery loop is a no-op');
        _recoveryEnvWarned = true;
      }
      return;
    }
    const now = Date.now();
    const cutoffNew = new Date(now - 15 * 60 * 1000).toISOString();      // aged >= 15 min
    const cutoffOld = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // and <= 24 h old
    const query =
      `quiz_submissions?paid=eq.false&followup_sent=eq.false` +
      `&created_at=lte.${cutoffNew}&created_at=gte.${cutoffOld}` +
      `&select=id,email,name,leak_estimate,resume_payload&order=created_at.asc&limit=50`;
    const r = await fetch(`${LEADS_URL_R}/rest/v1/${query}`, {
      headers: { apikey: LEADS_KEY_R, Authorization: `Bearer ${LEADS_KEY_R}` },
    });
    if (!r.ok) {
      console.warn('Recovery: leads query failed', r.status, (await r.text().catch(() => '')).slice(0, 160));
      return;
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const row of rows) {
      try {
        if (!row.email) continue;
        const total = (row.leak_estimate && row.leak_estimate.total) || 0;
        const monthly = total ? moRound(total) : 0;
        const firstName =
          (row.resume_payload && row.resume_payload.firstName) ||
          (row.name ? String(row.name).trim().split(/\s+/)[0] : '') || '';
        const subject = monthly
          ? `You left about $${monthly.toLocaleString()}/mo on the table`
          : 'Your revenue leak audit is one click away';
        const resumeUrl = `${APP_BASE_URL}/quiz?resume=${row.id}`;
        const html = recoveryEmailHtml(firstName, monthly, resumeUrl);
        const ok = await sendRecoveryEmail({ to: row.email, subject, html });
        if (ok) {
          await fetch(`${LEADS_URL_R}/rest/v1/quiz_submissions?id=eq.${row.id}`, {
            method: 'PATCH',
            headers: {
              apikey: LEADS_KEY_R,
              Authorization: `Bearer ${LEADS_KEY_R}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ followup_sent: true, followup_sent_at: new Date().toISOString() }),
          }).catch(e => console.warn('Recovery: mark followup_sent failed for', row.email, e.message));
          console.log(`Recovery: sent to ${row.email}`);
        }
      } catch (inner) {
        console.warn('Recovery: row error', inner && inner.message);
      }
    }
  } catch (e) {
    console.warn('Recovery sweep error:', e && e.message);
  }
}

// Register the recovery sweep once at startup. Guarded so it never throws out of the interval.
setInterval(() => { runRecoverySweep(); }, 2 * 60 * 1000);


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
