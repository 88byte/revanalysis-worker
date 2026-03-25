 
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
    const safeBizName = (job.bizName || 'Report');
    const pdfFilename = `${safeBizName.replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf`;

    let pdfBase64 = job.completedPdf || null;
    if (!pdfBase64) {
      console.log(`PDF not cached for ${email} — regenerating...`);
      try {
        pdfBase64 = await generatePDF(job.completedHtml);
        job.completedPdf = pdfBase64;
        console.log(`✓ PDF regenerated for ${email}`);
      } catch(e) {
        console.error(`PDF regeneration failed for ${email}:`, e.message);
      }
    }

    // Try to upload to Supabase — send link instead of attachment
    let pdfUrl = null;
    if (pdfBase64) {
      pdfUrl = await uploadPDFToSupabase(pdfBase64, pdfFilename);
      if (pdfUrl) {
        console.log(`✓ PDF uploaded to Supabase for resend: ${pdfUrl}`);
      } else {
        console.warn('PDF upload failed on resend — falling back to attachment');
      }
    }

    sendEmail({
      to: email, firstName: job.firstName||'', bizName: job.bizName,
      reportHtml: job.completedHtml,
      pdfBase64: pdfUrl ? null : pdfBase64,
      pdfFilename,
      pdfUrl
    })
      .then(() => console.log(`✓ Instant resend complete for ${email}`))
      .catch(e => console.error(`Resend email failed:`, e.message));
    return res.status(200).json({ queued: false, instant: true, email, message: 'Report resent with PDF link' });
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
  const { email, firstName, lastName, title, bizName, industry, city, calcData, answers, consentBenchmark } = req.body;
  if (!email || !calcData) return res.status(400).json({ error: 'Missing required fields' });
  jobStore[email] = { email, firstName:firstName||'', lastName:lastName||'', title:title||'', bizName, industry, city:city||'', calcData, answers, consentBenchmark:consentBenchmark||false, savedAt: new Date().toISOString() };
  
  // ← ADD THIS
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
    // If we have an email, try to find an existing row from the quiz save
    // (same biz + first name, no email yet) and update it instead of inserting
    if (data.email) {
      const findR = await fetch(
        `${url}/rest/v1/diagnostics?biz_name=eq.${encodeURIComponent(data.biz_name)}&first_name=eq.${encodeURIComponent(data.first_name)}&email=eq.&order=created_at.desc&limit=1&select=id`,
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
            console.log(`✓ Updated existing quiz row for ${data.email}`);
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

async function uploadPDFToSupabase(pdfBase64, filename) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;

  try {
    const buffer = Buffer.from(pdfBase64, 'base64');
    const r = await fetch(`${url}/storage/v1/object/reports/${filename}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'x-upsert': 'true'
      },
      body: buffer
    });
    if (!r.ok) {
      const e = await r.text();
      console.warn('PDF upload failed:', e.substring(0, 200));
      return null;
    }
    // Return public URL
    return `${url}/storage/v1/object/public/reports/${filename}`;
  } catch(e) {
    console.warn('PDF upload error:', e.message);
    return null;
  }
}



 
// ══════════════════════════════════════════════════
//  MAIN GENERATION
// ══════════════════════════════════════════════════
async function generateAndSend({ email, firstName, lastName, title, bizName, industry, city, calcData, answers, consentBenchmark }) {

  const SECTION_KEYS = ['EXEC','KPI','BENCH','LOCAL','COMPETE','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','TECH','ASSETS','SCALE','HIRE','ACQUIRE','CHECKLIST','PRIORITY','ROADMAP','ROI'];

  // Batches of 3 — safe for Tier 1 output TPM limits
  // Sequence matters: narrative sections first, dependent sections last
  const BATCHES = [
    ['EXEC', 'KPI', 'BENCH'],
    ['LOCAL', 'COMPETE', 'CONV'],
    ['DEAD', 'MKTG', 'RET'],
    ['REF', 'PRICE', 'REV'],
    ['OPS', 'TECH', 'ASSETS'],
    ['SCALE', 'HIRE', 'ACQUIRE'],
    ['CHECKLIST', 'PRIORITY', 'ROADMAP'],
    ['ROI']
  ];

  const sections = {};
  const ctx = buildServerContext(bizName, industry, calcData, answers, firstName, lastName, title, city);

  console.log(`Starting parallel generation for ${bizName} (${email}) — ${BATCHES.length} batches of 3`);

  for (let b = 0; b < BATCHES.length; b++) {
    const batch = BATCHES[b];
    console.log(`  Batch ${b+1}/${BATCHES.length}: [${batch.join(', ')}]`);
    const batchStart = Date.now();

    await Promise.all(batch.map(async (key) => {
      const LONG_SECTIONS = new Set(['HIRE','ACQUIRE','SCALE','CHECKLIST','ROADMAP','TECH','ASSETS']);
      let attempt = 0;
      while (attempt < 3) {
        try {
          const prompt = buildSectionPrompt(key, ctx);
          const maxTok = LONG_SECTIONS.has(key) ? 3800 : 2400;
          const result = await callAnthropicWithTokens(prompt, maxTok);
          // ... rest unchanged
          const parsed = parseSecs(result);
          const content = parsed[key] || Object.values(parsed)[0];
          if (!content) throw new Error('Empty response from AI');
          sections[key] = content;
          console.log(`    ✓ ${key} (${Date.now() - batchStart}ms)`);
          break;
        } catch(e) {
          attempt++;
          console.warn(`    ✗ ${key} attempt ${attempt}/3: ${e.message}`);

          if (e.message.includes('429') || e.message.includes('rate')) {
            // Rate limit hit — wait longer before retry
            const waitMs = attempt * 30000;
            console.log(`    Rate limit on ${key} — waiting ${waitMs/1000}s...`);
            await sleep(waitMs);
          } else if (attempt < 3) {
            await sleep(10000);
          } else {
            // After 3 failures, use fallback content rather than killing the whole job
            console.error(`    ✗ ${key} failed after 3 attempts — using fallback`);
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
  const pdfFilename = `${(bizName||'Report').replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf`;

  let pdfBase64 = null;
  try {
    pdfBase64 = await generatePDF(reportHtml);
    console.log('✓ PDF generated');
  } catch(e) {
    console.error('PDF generation failed:', e.message);
  }

  let pdfUrl = null;
  if (pdfBase64) {
    pdfUrl = await uploadPDFToSupabase(pdfBase64, pdfFilename);
    if (pdfUrl) console.log(`✓ PDF uploaded: ${pdfUrl}`);
    else console.warn('PDF upload failed — falling back to attachment');
  }

  await sendEmail({
    to: email, firstName, bizName, reportHtml,
    pdfBase64: pdfUrl ? null : pdfBase64,
    pdfFilename, pdfUrl
  });

  jobStore[email].completedHtml = reportHtml;
  jobStore[email].completedPdf = pdfBase64;
  jobStore[email].completedAt = new Date().toISOString();
  console.log(`✓ Report delivered to ${email}`);
  updateSupabaseDelivered(email);
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
 
  const sectionKeys = ['EXEC','KPI','BENCH','LOCAL','COMPETE','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','TECH','ASSETS','SCALE','HIRE','ACQUIRE','CHECKLIST','PRIORITY','ROADMAP','ROI'];
  const sectionTitles = {
    EXEC:'Executive Summary',
    KPI:'KPI Dashboard & Your Metrics',
    BENCH:'Industry Benchmark Analysis',
    LOCAL:'Local Market & City Growth Opportunities',
    COMPETE:'Competitive Analysis',
    CONV:'Lead Conversion & Sales',
    DEAD:'Dead & Dormant Leads',
    MKTG:'Marketing Efficiency',
    RET:'Customer Retention',
    REF:'Referral Generation',
    PRICE:'Pricing Power',
    REV:'Reviews & Visibility',
    OPS:'Operations & Quality',
    TECH:'Tech & Software Stack',
    ASSETS:'Assets & Business Value',
    SCALE:'Scaling Strategy',
    HIRE:'Hiring & Team Building',
    ACQUIRE:'Acquisition Strategy',
    CHECKLIST:'Master Implementation Checklist',
    PRIORITY:'Priority Action Matrix',
    ROADMAP:'90-Day Structured Roadmap',
    ROI:'Revenue Recovery Projection'
  };
  const catKeyMap = { CONV:'conversion', DEAD:'dormant', MKTG:'Marketing', RET:'retention', REF:'Referral', PRICE:'Pricing', REV:'Reviews', OPS:'Operations' };
 
  const css = `
/* ── Reset ── */
* { box-sizing: border-box; margin: 0; padding: 0; }
 
/* ── Base ── */
body {
  font-family: Georgia, 'Times New Roman', serif;
  background: #f0f2f7;
  color: #1a202c;
  font-size: 14px;
  line-height: 1.8;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 28px 16px; }
 
/* ── COVER — dark navy, full brand ── */
.cover {
  background: #0f1f3d;
  border-radius: 14px;
  padding: 48px 44px;
  margin-bottom: 20px;
  color: white;
  position: relative;
  overflow: visible;  /* CHANGE from hidden to visible */
}
.cover::before {
  content: '';
  position: absolute;
  top: -60px; right: -60px;
  width: 280px; height: 280px;
  border-radius: 50%;
  background: rgba(255,64,64,0.08);
  pointer-events: none;
}
.cover-tag {
  display: inline-block;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 10px; font-weight: 700;
  letter-spacing: .18em; text-transform: uppercase;
  color: #6ea8fe;
  border: 1px solid rgba(110,168,254,0.3);
  padding: 4px 12px; border-radius: 20px;
  margin-bottom: 20px;
}
.cover-h {
  font-family: Georgia, serif;
  font-size: 36px; font-weight: 800;
  line-height: 1.1; margin-bottom: 12px;
  letter-spacing: -0.5px;
}
.cover-h .red { color: #ff6b6b; }
.cover-range { font-size: 14px; color: rgba(255,255,255,.5); margin-bottom: 4px; font-family: Helvetica, Arial, sans-serif; }
.cover-meta { font-size: 12px; color: rgba(255,255,255,.3); margin-bottom: 20px; font-family: Helvetica, Arial, sans-serif; }
.cover-note {
  background: rgba(255,255,255,.07);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px; padding: 10px 16px;
  font-size: 11px; color: rgba(255,255,255,.45);
  font-family: Helvetica, Arial, sans-serif; line-height: 1.6;
}
 
/* ── KPI STRIP ── */
.kpi-strip {
  background: white; border-radius: 12px;
  padding: 0; margin-bottom: 16px;
  border: 1px solid #e2e8f0;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.kpi-row { display: table; width: 100%; }
.kpi-cell {
  display: table-cell; text-align: center;
  padding: 20px 12px;
  border-right: 1px solid #e2e8f0;
  vertical-align: middle;
}
.kpi-cell:last-child { border-right: none; }
.kpi-val {
  font-family: Georgia, serif;
  font-size: 22px; font-weight: 800;
  line-height: 1.1; margin-bottom: 5px;
}
.kpi-lbl {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9.5px; color: #8d97aa;
  text-transform: uppercase; letter-spacing: .1em;
  font-weight: 600;
}
 
/* ── BENCHMARK STRIP ── */
.bench-strip {
  background: white; border: 1px solid #e2e8f0;
  border-radius: 12px; padding: 20px 22px;
  margin-bottom: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.bench-head {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 10px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #6b7280; margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 2px solid #0f1f3d;
}
.bench-row { display: table; width: 100%; border-collapse: separate; border-spacing: 8px; }
.bench-cell { display: table-cell; width: 25%; }
.bench-metric-box {
  background: #f8fafc; border: 1px solid #e2e8f0;
  border-radius: 10px; padding: 14px 10px; text-align: center;
}
.bm-lbl {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9px; color: #9ca3af;
  text-transform: uppercase; letter-spacing: .08em;
  margin-bottom: 8px; font-weight: 600;
}
.bm-you { font-family: Georgia, serif; font-size: 20px; font-weight: 800; line-height: 1; }
.bm-vs { font-family: Helvetica, Arial, sans-serif; font-size: 9px; color: #9ca3af; margin: 5px 0 3px; }
.bm-bench-val { font-family: Helvetica, Arial, sans-serif; font-size: 11px; color: #6b7280; margin-bottom: 6px; }
.bm-tag {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9px; font-weight: 700;
  padding: 3px 8px; border-radius: 20px;
  display: inline-block; letter-spacing: .04em;
}
 
/* ── CHART SECTION ── */
.chart-section {
  background: white; border: 1px solid #e2e8f0;
  border-radius: 12px; margin-bottom: 16px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.chart-head {
  background: #0f1f3d; padding: 13px 22px;
  display: flex; align-items: center; gap: 12px;
}
.sec-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  background: rgba(255,255,255,0.12);
  color: #6ea8fe; font-size: 11px; font-weight: 700;
  border-radius: 6px; flex-shrink: 0;
  font-family: Helvetica, Arial, sans-serif;
  letter-spacing: .04em;
}
.sec-title-h {
  font-family: Georgia, serif; font-size: 14px;
  font-weight: 700; color: white;
}
.chart-body { padding: 20px 22px; }
.chart-label {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: .12em; text-transform: uppercase;
  color: #9ca3af; margin-bottom: 12px;
}
.chart-wrap {
  background: #f8fafc; border: 1px solid #e2e8f0;
  border-radius: 8px; padding: 14px; margin-bottom: 14px;
}
.chart-wrap:last-child { margin-bottom: 0; }
 
/* ── REPORT SECTIONS ── */
.rsec {
  background: white; border: 1px solid #e2e8f0;
  border-radius: 12px; margin-bottom: 16px; overflow: hidden;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.rsec-head {
  background: #0f1f3d;
  padding: 14px 24px;
  display: flex; align-items: center; justify-content: space-between;
}
.rsec-left { display: flex; align-items: center; gap: 12px; }
.rsec-title {
  font-family: Georgia, serif; font-size: 14px;
  font-weight: 700; color: white; letter-spacing: 0;
}
.rsec-amt {
  font-family: Georgia, serif; font-size: 14px;
  font-weight: 700; color: #ff6b6b; white-space: nowrap;
}
.rsec-body { padding: 24px 28px; background: white; }
 
/* ── BODY CONTENT ── */
p {
  margin-bottom: 14px; color: #374151;
  font-size: 14px; line-height: 1.8;
  font-family: Georgia, serif;
}
p:last-child { margin-bottom: 0; }
strong { font-weight: 700; color: #111827; }
 
/* Section subheadings */
h4 {
  font-family: Georgia, serif; font-size: 15px; font-weight: 700;
  color: #0f1f3d; margin: 24px 0 10px;
  padding-bottom: 8px;
  border-bottom: 2px solid #e2e8f0;
  display: flex; align-items: center; gap: 8px;
}
h4::before {
  content: '';
  display: inline-block; width: 4px; height: 16px;
  background: #ff4040; border-radius: 2px; flex-shrink: 0;
}
h5 {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 10px; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase;
  color: #2557a7; margin-bottom: 12px;
}
 
/* Lists */
ul { margin: 10px 0 16px; padding: 0; list-style: none; }
ul li {
  display: flex; gap: 10px; margin-bottom: 8px;
  font-size: 14px; color: #4b5563; line-height: 1.7;
  font-family: Georgia, serif;
}
ul li::before { content: '→'; color: #3b6fd4; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
 
ol { margin: 10px 0 16px; padding: 0; list-style: none; counter-reset: steps; }
ol li {
  display: flex; gap: 14px; margin-bottom: 12px;
  font-size: 14px; color: #4b5563; line-height: 1.7;
  counter-increment: steps; font-family: Georgia, serif;
  padding: 10px 14px; background: #f8fafc;
  border: 1px solid #e2e8f0; border-radius: 8px;
}
ol li::before {
  content: counter(steps);
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 24px; border-radius: 50%;
  background: #0f1f3d; color: #6ea8fe;
  font-size: 11px; font-weight: 700; flex-shrink: 0;
  font-family: Helvetica, Arial, sans-serif; margin-top: 1px;
}
 
/* ── QUICK WIN — amber, prominent ── */
.quick-win {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-left: 5px solid #f59e0b;
  border-radius: 0 10px 10px 0;
  padding: 14px 18px; margin: 0 0 20px 0;
  font-size: 13.5px; color: #78350f; font-weight: 600;
  line-height: 1.6; font-family: Helvetica, Arial, sans-serif;
}
 
/* ── SCRIPTS — dark editorial ── */
.script {
  background: #0f1f3d;
  border-radius: 10px;
  padding: 0; margin: 14px 0; overflow: hidden;
}
.slabel {
  display: block;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase;
  color: #93c5fd;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(255,255,255,.08);
  background: rgba(0,0,0,.2);
}
.script p {
  color: #e2e8f0 !important;
  font-size: 13px; font-style: italic;
  line-height: 1.8; margin: 0;
  padding: 14px 18px;
  font-family: Georgia, serif;
}
.script strong { color: #ffffff !important; font-style: normal; }
 
/* ── ACTION BOX ── */
.action-box {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-left: 5px solid #2557a7;
  border-radius: 0 10px 10px 0;
  padding: 16px 20px; margin: 14px 0;
}
.action-box h5 {
  color: #1e40af; margin-bottom: 12px;
}
 
/* ── STAT CALLOUT ── */
.stat-call {
  background: #f0f9ff;
  border: 1px solid #bae6fd;
  border-left: 5px solid #0284c7;
  border-radius: 0 10px 10px 0;
  padding: 12px 16px; margin: 14px 0;
  font-size: 13px; color: #0c4a6e;
  font-weight: 600; line-height: 1.65;
  font-family: Helvetica, Arial, sans-serif;
}
 
/* ── DISCLAIMER ── */
.disclaimer {
  background: #f9fafb; border: 1px solid #e5e7eb;
  border-radius: 8px; padding: 10px 14px;
  margin: 12px 0; font-size: 11.5px;
  color: #6b7280; font-style: italic; line-height: 1.55;
  font-family: Helvetica, Arial, sans-serif;
}
 
/* ── TABLES ── */
table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
thead tr { background: #0f1f3d; }
th {
  background: #0f1f3d; color: #93c5fd;
  padding: 10px 14px; text-align: left;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
}
th:first-child { border-radius: 6px 0 0 0; }
th:last-child { border-radius: 0 6px 0 0; }
td {
  padding: 10px 14px;
  border-bottom: 1px solid #e5e7eb;
  color: #4b5563; vertical-align: top;
  font-family: Georgia, serif;
  font-size: 13px;
}
tr:last-child td { border-bottom: none; }
tr:nth-child(even) td { background: #f8fafc; }
tr:hover td { background: #f1f5f9; }
 
/* ── PLAN GRID ── */
.pgrid { display: block; }
.pcard {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px; padding: 18px 20px; margin-bottom: 12px;
}
.ptag {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase;
  color: #6ea8fe; margin-bottom: 4px;
  background: #0f1f3d; display: inline-block;
  padding: 3px 10px; border-radius: 20px;
  margin-bottom: 8px;
}
.ptitle {
  font-family: Georgia, serif;
  font-size: 15px; font-weight: 700;
  color: #0f1f3d; margin-bottom: 12px;
}
.ptask {
  display: flex; gap: 8px; margin-bottom: 8px;
  font-size: 13px; color: #4b5563; line-height: 1.6;
  align-items: flex-start; font-family: Georgia, serif;
}
.ptask::before {
  content: '→'; color: #3b6fd4; flex-shrink: 0;
  font-weight: 700; margin-top: 1px;
}
.pmile {
  background: #0f1f3d; border-radius: 8px;
  padding: 10px 14px; margin-top: 12px;
  font-size: 12px; color: #93c5fd;
  font-weight: 600; line-height: 1.6;
  font-family: Helvetica, Arial, sans-serif;
  border-left: 4px solid #ff6b6b;
}
 
/* ── FOOTER ── */
.footer {
  background: #0f1f3d; border-radius: 12px;
  padding: 32px; text-align: center; margin-top: 20px;
}
.footer h3 {
  font-family: Georgia, serif;
  font-size: 20px; font-weight: 700;
  color: white; margin-bottom: 8px;
}
.footer p {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 12px; color: rgba(255,255,255,.4);
  margin-bottom: 3px;
}
blockquote {
  background: #0f1f3d; border-radius: 8px;
  padding: 16px 20px; margin: 14px 0;
  color: rgba(255,255,255,.85); font-size: 13px;
  font-style: italic; line-height: 1.8;
  font-family: Georgia, serif;
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

/* Table rows and list items don't split */
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

/* Sections flow naturally but don't orphan their header */
.rsec {
  break-inside: auto;
  page-break-inside: auto;
}

/* ── PRINT OVERRIDES ── */
@media print {
  body { background: white; }
  .cover { border-radius: 0; }
  .rsec { border-radius: 0; overflow: visible !important; }  /* ADD overflow: visible */
  .rsec-head { background: #0f1f3d !important; }
  .script { background: #0f1f3d !important; }
  .script p { color: #e2e8f0 !important; }
  .footer { border-radius: 0; }
  .chart-section { overflow: visible !important; }  /* ADD this too */
}
`;
 
  // Benchmark comparison strip
  const yourClose = Math.round((L.meta.close||0.65)*100);
  const bm = [
    {label:'Close Rate',you:yourClose+'%',bench:bench.closeRate+'%',youN:yourClose,benchN:bench.closeRate},
    {label:'Retention',you:'~'+Math.round((L.meta.retRate||0.15)*100)+'%',bench:bench.retention+'%',youN:Math.round((L.meta.retRate||0.15)*100),benchN:bench.retention},
    {label:'Referrals',you:'~'+Math.round((L.meta.refRate||0.10)*100)+'%',bench:bench.referralPct+'%',youN:Math.round((L.meta.refRate||0.10)*100),benchN:bench.referralPct},
    {label:'Google Reviews',
      you:`~${L.meta.reviewBandN||20}`,
      bench:`avg ${bench.reviewCount}`,
      youN:L.meta.reviewBandN||20,
      benchN:bench.reviewCount},  ];
  const bmHtml = `<div class="bench-strip">
    <div class="bench-head">Industry comparison — ${bench.label} (Source: ${bench.source})</div>
    <div class="bench-row">${bm.map(m=>{
      const status = m.youN >= m.benchN ? 'above' : m.youN >= m.benchN * 0.8 ? 'at' : 'below';
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
 
  // Sections — start numbering at 01 (00 is the dashboard)
  let sectionsHtml = '';
  sectionKeys.forEach((k, i) => {
    if (!sections[k]) return;
    const catKey = catKeyMap[k];
    const catMatch = catKey ? L.cats.find(c => c.n.toLowerCase().includes(catKey.toLowerCase())) : null;
    sectionsHtml += `<div class="rsec">
      <div class="rsec-head">
        <div class="rsec-left"><div class="sec-num">${String(i + 1).padStart(2,'0')}</div><div class="rsec-title">${sectionTitles[k]}</div></div>
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
 
  const greeting = firstName ? firstName : '';
  const coverHtml = `
  <div class="cover" style="min-height:260mm;display:flex;flex-direction:column;justify-content:space-between;">
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:60px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.35);">RevAnalysis</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:rgba(110,168,254,.7);border:1px solid rgba(110,168,254,.25);padding:4px 12px;border-radius:20px;">Confidential · Revenue Recovery Report</div>
      </div>

      <div style="margin-bottom:48px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:16px;">Prepared for</div>
        <div style="font-family:Georgia,serif;font-size:42px;font-weight:800;color:white;line-height:1.1;letter-spacing:-1px;margin-bottom:8px;">${greeting || bizName}</div>
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:400;color:rgba(255,255,255,.6);margin-bottom:4px;">${bizName}</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:rgba(255,255,255,.3);">${industry}</div>
      </div>

      <div style="width:60px;height:3px;background:linear-gradient(to right,#ff6b6b,rgba(255,107,107,0.2));border-radius:2px;margin-bottom:48px;"></div>

      <div style="margin-bottom:48px;">
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:12px;">Estimated Revenue Opportunity</div>
        <div style="font-family:Georgia,serif;font-size:56px;font-weight:800;color:#ff6b6b;line-height:1;letter-spacing:-2px;margin-bottom:8px;">~$${L.total.toLocaleString()}</div>
        <div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:rgba(255,255,255,.4);">Conservative range: $${L.totalLo.toLocaleString()} – $${L.totalHi.toLocaleString()}</div>
      </div>

      <div style="display:flex;gap:32px;">
        <div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:4px;">Biggest Opportunity</div>
          <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#6ea8fe;">~$${L.cats[0].amt.toLocaleString()}</div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:rgba(255,255,255,.3);margin-top:2px;">${L.cats[0].n}</div>
        </div>
        <div style="width:1px;background:rgba(255,255,255,.08);"></div>
        <div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:4px;">Realistic 90-Day Target</div>
          <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#4ade80;">~$${Math.round(L.total*0.22).toLocaleString()}</div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:rgba(255,255,255,.3);margin-top:2px;">Conservative estimate</div>
        </div>
        <div style="width:1px;background:rgba(255,255,255,.08);"></div>
        <div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:4px;">Report ROI</div>
          <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#6ea8fe;">${Math.round(Math.round(L.total*0.22)/497)}x</div>
          <div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:rgba(255,255,255,.3);margin-top:2px;">Return on $497 investment</div>
        </div>
      </div>
    </div>

    <div style="border-top:1px solid rgba(255,255,255,.08);padding-top:20px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:rgba(255,255,255,.25);">Generated by RevAnalysis · ${date}</div>
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:rgba(255,255,255,.25);">revanalysis.com</div>
    </div>
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RevAnalysis Report — ${bizName}</title><style>${css}</style></head>
<body><div class="wrap">
  ${coverHtml}
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
 
async function sendEmail({ to, firstName, bizName, reportHtml, pdfBase64, pdfFilename, pdfUrl }) {
  const greeting = firstName ? `, ${firstName}` : '';
  
  // Add download button to top of email if we have a URL
  const downloadBanner = pdfUrl ? `
    <div style="background:#0f1f3d;padding:16px 24px;text-align:center;margin-bottom:0;">
      <a href="${pdfUrl}" style="display:inline-block;background:#ff6b6b;color:white;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;padding:12px 32px;border-radius:6px;text-decoration:none;">
        ⬇ Download Your PDF Report
      </a>
      <p style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:rgba(255,255,255,.4);margin:8px 0 0;">
        Your PDF is ready — click above to download
      </p>
    </div>` : '';

  const finalHtml = reportHtml.replace('<div class="wrap">', `${downloadBanner}<div class="wrap">`);

  const payload = {
    from: 'RevAnalysis <reports@revanalysis.com>',
    to: [to],
    subject: `Your RevAnalysis Report is ready${greeting} — ${bizName}`,
    html: finalHtml
  };

  // Only attach PDF if we couldn't upload it
  if (pdfBase64 && !pdfUrl) {
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
function buildServerContext(bizName, industry, calcData, answers, firstName, lastName, title, city) {
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
    // In the return object, add:
    teamSize: a.teamSize !== undefined ? [1,2,5,12,25][Math.min(a.teamSize,4)] : 3,
    deadVal: Math.round((L.meta.dead || 20) * 0.12 * (parseInt(String(L.meta.avgLo).replace(/[$,]/g,'')) || 0)),
    total:`~$${L.total.toLocaleString()}`, totalRange:`$${L.totalLo.toLocaleString()}–$${L.totalHi.toLocaleString()}`,
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
- Total opportunity: ${c.total} (range: ${c.totalRange})
- Top 3: ${c.top3} | Scores: ${c.scores} | Goal: ${c.goal}
- Team size: ~${c.teamSize} people
 
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
15. START every section (except EXEC and BENCH) with: <div class="quick-win">⚡ Quick Win — [One specific action THIS WEEK — concrete, ${c.ind}-specific, doable in under 1 hour]</div>
16. USE ONLY the benchmark figures provided above. Do NOT use your own training knowledge for benchmarks. The retention benchmark for this industry is ${c.bench.retention}%, not any other figure. The review benchmark is ${c.bench.reviewCount}, not any other figure.
17. This business is located in ${c.city}, which is in the United States. Use ONLY US-specific platforms, directories, regulations, and market data. Never reference Australian platforms (HiPages, Oneflare, ServiceSeeking, Hipages), Australian regulators (WorkSafe, Fair Work), or Australian statistics.
18. HTML only: <p>, <strong>, <h4>, <ul><li>, <ol><li>, <table>, <div class="stat-call">, <div class="script"><span class="slabel">...</span><p>...</p></div>, <div class="action-box"><h5>...</h5><ol>...</ol></div>, <div class="disclaimer">, <div class="quick-win">`;
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
  const prompts = {
    EXEC:`${base}\nWrite ONLY the [EXEC] section. First line: [EXEC]\n\n5 focused paragraphs (~280 words):\n- Para 1: Open with ~${c.total} opportunity (range: ${c.totalRange}). Conservative language. Compelling ${c.ind}-specific analogy.\n- Para 2: Why ${c.ind} businesses specifically lose revenue this way — structural reasons.\n- Para 3: Top 3 opportunities: ${c.top3}. Dollar context and interconnection.\n- Para 4: What the next 90 days looks like. Realistic. Quote "businesses in ${c.ind} typically recover 15–25% in 90 days."\n- Para 5: Mindset shift from reactive to systematic. What top ${c.ind} businesses do differently.\n<div class="stat-call">One real industry statistic with source name relevant to ${c.ind}.</div>\n<div class="disclaimer">All figures are estimates based on the ranges you provided. Actual results depend on your situation and implementation consistency.</div>`,
 
    BENCH:`${base}\nWrite ONLY the [BENCH] section. First line: [BENCH]\n\n<h4>How ${c.biz} Compares to ${c.bench.label}</h4>\nWrite 4 specific paragraphs — one per metric:\n1. Close rate: industry average ${c.bench.closeRate}% vs their ~${c.close}. Dollar impact of gap.\n2. Retention: industry average ${c.bench.retention}% vs their diagnostic answer. Dollar impact.\n3. Referrals: industry average ${c.bench.referralPct}% vs their answer. Dollar impact.\n4. Reviews: industry average ${c.bench.reviewCount} vs their count. Lead flow impact.\nFor each: state the gap, calculate the cost, give ONE action to close it in ${c.ind}.\nSource all data to: ${c.bench.source}\n<div class="stat-call">Businesses that close benchmark gaps in ${c.ind} typically do one thing differently: they systematize what top performers do instinctively.</div>`,
 
    CONV:`${base}\nWrite ONLY the [CONV] section. First line: [CONV]\n\n<div class="quick-win">[One specific action THIS WEEK to improve lead conversion in ${c.ind}]</div>\n\n<h4>Close Rate Analysis</h4>\n<p>~${c.close} vs ~${c.bench.closeRate}% ${c.ind} benchmark (${c.bench.source}). Calculate gap and dollar impact. Reference CSO Insights.</p>\n<h4>Response Speed Gap</h4>\n<p>MIT/HBR 5-minute rule applied to ${c.ind}. Conservative impact. 3–4 sentences.</p>\n<h4>Follow-Up System Gap</h4>\n<p>Salesforce 80%/5-touch. Specific to ${c.ind}. 3–4 sentences.</p>\n<h4>5-Email Follow-Up Sequence</h4>\nCRITICAL: Write each email COMPLETE — no placeholders. 60–70 words each.\n<div class="script"><span class="slabel">Email 1 — Same Day (Subject: [specific subject for ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Email 2 — Day 2 (Subject: [specific subject])</span><p>[Complete 60-word email]</p></div>\n<div class="script"><span class="slabel">Email 3 — Day 5 (Subject: [specific subject])</span><p>[Complete 60-word email — addresses most common ${c.ind} objection]</p></div>\n<div class="script"><span class="slabel">Email 4 — Day 10 (Subject: [specific subject])</span><p>[Complete 55-word email — mild urgency]</p></div>\n<div class="script"><span class="slabel">Email 5 — Day 21 (Subject: Closing the loop)</span><p>[Complete 45-word breakup email]</p></div>\n\nNOTE: The estimated current gap vs industry benchmark is ~$${c.L.cats.find(cat => cat.n.includes('conversion'))?.amt.toLocaleString()||'0'}. If this is $0, frame this section as a strength with ceiling upside — not a missed opportunity.`,


    DEAD:`${base}\nWrite ONLY the [DEAD] section. First line: [DEAD]\n\n<div class="quick-win">[One specific action THIS WEEK to re-engage cold leads in ${c.ind}]</div>\n\n<h4>Value in Your Pipeline</h4>\n<p>~${c.dead} unconverted leads × ${c.avgLo} average × 12% re-engagement rate = approximately $${c.deadVal.toLocaleString()} in recoverable revenue. 3 specific reasons leads go cold in ${c.ind}.</p>\n<h4>Re-Engagement Sequence</h4>\n<div class="script"><span class="slabel">Re-engagement Email (Subject: [specific to ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Follow-Up Text — 3 Days Later (under 140 chars)</span><p>[Complete text]</p></div>\n<div class="script"><span class="slabel">Final Email — Day 10 (Subject: Last one from us)</span><p>[Complete 45-word closing email]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[ongoing]</li></ol></div>`,
 
    MKTG:`${base}\nWrite ONLY the [MKTG] section. First line: [MKTG]\n\n<div class="quick-win">[One specific marketing action THIS WEEK for ${c.ind} — 30 minutes or less]</div>\n\n<h4>Marketing Diagnosis</h4>\n<p>Honest assessment based on their diagnostic. Specific to ${c.ind}.</p>\n<h4>The 2 Highest-ROI Channels for ${c.ind}</h4>\n<p>Name the 2 specific channels with data and source names. For each: why it works, how to implement, expected ROI.</p>\n<h4>30-Minute Weekly Content Framework</h4>\n<table><tr><th>Week</th><th>Content Type</th><th>Specific Topic for ${c.ind}</th><th>Platform</th></tr><tr><td>1</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>2</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>3</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr><tr><td>4</td><td>[type]</td><td>[specific real topic]</td><td>[platform]</td></tr></table>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    RET:`${base}\nWrite ONLY the [RET] section. First line: [RET]\n\n<div class="quick-win">[One specific retention action THIS WEEK — call or email a specific type of past customer in ${c.ind}]</div>\n\n<h4>Customer Lifetime Value Estimate</h4>\n<p>${c.avgMid} avg × approximately 1.5 jobs/year × 4-year average retention = approximately $${clvEstimate} customer lifetime value. Bain & Company: 5% retention = 25–95% profit growth. Industry average retention: ${c.bench.retention}% (${c.bench.source}). Conservative language.</p>\n<h4>The Retention Gap</h4>\n<p>Estimated annual cost of their retention gap. Why ${c.ind} customers stop returning. 3–4 sentences.</p>\n<h4>3-Step Retention System for ${c.ind}</h4>\n<p>Specific touchpoints, timing, channels. Not generic.</p>\n<div class="script"><span class="slabel">30-Day Post-Job Check-In (Email — 70 words)</span><p>[Full email — warm, specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">6-Month Re-Engagement (Text — under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REF:`${base}\nWrite ONLY the [REF] section. First line: [REF]\n\n<div class="quick-win">[One specific referral action THIS WEEK — ask a specific type of recent ${c.ind} customer]</div>\n\n<h4>The Referral Math for ${c.ind}</h4>\n<p>Each activated customer → ~1.2 referrals × ${c.avgLo} avg × ~55% conversion = ~$[calculate]. Industry referral average: ${c.bench.referralPct}% (${c.bench.source}). Texas Tech / Wharton: referred customers have 16–25% higher LTV.</p>\n<h4>The Systematic Referral Process for ${c.ind}</h4>\n<p>When to ask, how to ask, what to offer — specific to ${c.ind}. 2–3 sentences.</p>\n<div class="script"><span class="slabel">Referral Ask Script (word-for-word at job completion)</span><p>[Complete 75-word script — specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">Referral Thank-You (Text — under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    PRICE:`${base}\nWrite ONLY the [PRICE] section. First line: [PRICE]\n\n<div class="quick-win">[One specific pricing action THIS WEEK — test a price increase on new quotes starting today]</div>\n\n<h4>The Pricing Opportunity</h4>\n<p>McKinsey: 1% price improvement = ~11% profit improvement. Conservative 6% adjustment on ${c.revLo} = approximately $${priceUplift6} annually. At your revenue midpoint of ${c.revMid}, that same 6% move delivers approximately $${priceUplift6Mid}. How ${c.ind} businesses test increases without losing customers.</p>\n<h4>The Price Increase Test Methodology</h4>\n<p>How to safely test a 7–10% increase in ${c.ind}. What signals confirm it's working. 3–4 sentences.</p>\n<h4>Premium Tier Example for ${c.ind}</h4>\n<p>Specific Good / Better / Best structure — approximate prices, what each tier includes.</p>\n<div class="script"><span class="slabel">Price Increase Communication Script</span><p>[Complete 70-word script — confident, value-focused]</p></div>\n<div class="script"><span class="slabel">Premium Tier Presentation Script</span><p>[Complete 70-word script — presents 3 options naturally]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    REV:`${base}\nWrite ONLY the [REV] section. First line: [REV]\n\n<div class="quick-win">[One specific review action THIS WEEK — send review request to a specific group of recent customers]</div>\n\n<h4>The Review-to-Revenue Connection for ${c.ind}</h4>\n<p>BrightLocal: 93% of consumers check reviews. Moz: reviews account for ~15% of local search ranking. Industry average for ${c.bench.label}: ${c.bench.reviewCount} reviews (${c.bench.source}). Direct link between review volume and inbound lead flow in ${c.ind}.</p>\n<h4>Systematic Review Request Process</h4>\n<p>Exact timing, channel, message for ${c.ind}. When to ask, how to make it easy.</p>\n<div class="script"><span class="slabel">Review Request Text — 24–48 Hours After Completion (under 140 chars)</span><p>[Complete text with [your Google review link]]</p></div>\n<div class="script"><span class="slabel">Follow-Up If No Review — 5 Days Later (under 140 chars)</span><p>[Complete follow-up — gentle]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
 
    OPS:`${base}\nWrite ONLY the [OPS] section. First line: [OPS]\n\n<div class="quick-win">[One specific operations action THIS WEEK — document one process or implement one quality checkpoint in ${c.ind}]</div>\n\n<h4>The True Cost of Quality Issues in ${c.ind}</h4>\n<p>Each complaint costs 4–6× the original transaction value when you factor in rework, lost referrals, and reputation damage. At your average transaction of approximately ${c.avgMid}, each avoidable complaint costs approximately $${complaintCostLo}–$${complaintCostHi}. Annual impact at their complaint rate.</p>\n<h4>The 3 Critical SOPs for ${c.ind}</h4>\n<p>Name and describe the 3 most impactful SOPs specifically for ${c.ind}. For each: what it covers, key steps, what breaks without it.</p>\n<h4>Quality Control in Practice</h4>\n<p>How top-performing ${c.ind} businesses build quality checkpoints without significant overhead. 2–3 sentences with a specific example.</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li></ol></div>`,
 
    PRIORITY:`${base}\nWrite ONLY the [PRIORITY] section. First line: [PRIORITY]\n\n<h4>Priority Rankings for ${c.biz}</h4>\n<table><tr><th>Rank</th><th>Category</th><th>Est. Opportunity</th><th>Conservative 90-Day Target</th><th>First Action This Week</th></tr>\n${c.L.cats.map((cat,i)=>`<tr><td><strong>#${i+1}</strong></td><td>${cat.n}</td><td>~$${cat.amt.toLocaleString()}</td><td>$${Math.round(cat.amt*0.15).toLocaleString()}–$${Math.round(cat.amt*0.25).toLocaleString()}</td><td>[1 specific first step for ${c.ind}]</td></tr>`).join('\n')}\n</table>\n<p>Write 2 paragraphs explaining the sequencing strategy — why this order maximizes early results for ${c.biz} in ${c.ind}. Specific, conservative language.</p>`,
 
    PLAN:`${base}\nWrite ONLY the [PLAN] section. First line: [PLAN]\n\nEvery task SPECIFIC to ${c.ind} — not generic. Include real time estimates.\n\n<div class="pgrid">\n<div class="pcard"><div class="ptag">Week 1 — Days 1–7</div><div class="ptitle">Quick Wins</div>\n<div class="ptask">Day 1 (time): [specific ${c.ind} task]</div>\n<div class="ptask">Day 2 (time): [specific task]</div>\n<div class="ptask">Day 3 (time): [specific task]</div>\n<div class="ptask">Day 4 (time): [specific task]</div>\n<div class="ptask">Day 5 (time): [specific task]</div>\n<div class="ptask">Days 6–7 (time): [specific task]</div>\n<div class="pmile">Day 30 milestone: [3–4 specific measurable outcomes with numbers]</div>\n</div>\n<div class="pcard"><div class="ptag">Week 2 — Days 8–14</div><div class="ptitle">Foundation</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="ptask">(time): [specific task]</div>\n<div class="pmile">Day 60 milestone: [specific measurable outcomes]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 2 — Days 31–60</div><div class="ptitle">Momentum</div>\n<div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 3 — Days 61–90</div><div class="ptitle">Systematize</div>\n<div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div><div class="ptask">[specific task]</div>\n<div class="pmile">Day 90 milestone: [specific metrics for ${c.ind}]</div>\n</div>\n</div>`,
 
    ROI:`${base}\nWrite ONLY the [ROI] section. First line: [ROI]\n\n<h4>Conservative Recovery Projection</h4>\n<table>\n<tr><th>Scenario</th><th>Recovery Rate</th><th>Month 1 Est.</th><th>Month 2 Est.</th><th>Month 3 Est.</th><th>90-Day Total</th></tr>\n<tr><td>Conservative</td><td>15%</td><td>~$${Math.round(c.L.total*0.15*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15*0.50).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td></tr>\n<tr><td>Realistic</td><td>22%</td><td>~$${Math.round(c.L.total*0.22*0.20).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22*0.55).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td></tr>\n<tr><td>Optimistic</td><td>32%</td><td>~$${Math.round(c.L.total*0.32*0.25).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32*0.60).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td></tr>\n</table>\n<p>Explain what drives each scenario. Be honest that results vary.</p>\n<h4>Report ROI</h4>\n<p>At realistic scenario: ~$${Math.round(c.L.total*0.22).toLocaleString()} in 90 days on a $497 investment = approximately ${Math.round(c.L.total*0.22/497)}x return. Converting just ${Math.ceil(497/c.L.meta.avgLo)} additional dormant leads covers the cost of this report.</p>\n<div class="disclaimer">All projections are estimates. Results depend on consistent implementation, your market, and your specific circumstances.</div>\n<h4>Your Single Most Important Action in the Next 48 Hours</h4>\n<p>[Single most impactful, specific first action for ${c.biz} in ${c.ind} based on their #1 opportunity. 80–100 words. Exact steps. Specific to ${c.ind}.]</p>`,
    
    KPI:`${base}\nWrite ONLY the [KPI] section. First line: [KPI]\n\n
Write specific, math-grounded KPI guidance for ${c.biz}, a ${c.ind} business at ${c.revRange} revenue.\n\n
<h4>Your Revenue KPIs — Track Weekly</h4>
<p>Open with: the single most important number for a ${c.ind} business to watch weekly and why. Then introduce the full weekly dashboard.</p>
<div class="action-box"><h5>Weekly revenue dashboard — review every Monday</h5><ol>
<li><strong>Weekly revenue booked:</strong> Target $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/52).toLocaleString()}/week (${c.revMid} ÷ 52). If below target 2 weeks running, it is a pipeline problem — act immediately.</li>
<li><strong>Leads received:</strong> Target ${c.mthLeads}+/month. Track source (referral, Google, social, repeat). Source data tells you where to invest.</li>
<li><strong>Quotes sent vs jobs closed:</strong> Your close rate target is ${Math.min(95,Math.round(c.L.meta.close*100)+15)}% — up from your current ~${Math.round(c.L.meta.close*100)}%. Every untracked quote is invisible lost revenue.</li>
<li><strong>Average transaction value:</strong> Current ~${c.avgMid}. Flag any week where this drops more than 10% — it signals discounting or scope creep.</li>
<li><strong>Pipeline value:</strong> Total value of all open quotes. If this number stays flat for 2+ weeks, your lead generation needs attention.</li>
</ol></div>
<h4>Retention & Loyalty KPIs — Track Monthly</h4>
<div class="action-box"><h5>Monthly loyalty dashboard</h5><ol>
<li><strong>Repeat customer rate:</strong> Target ${c.bench.retention}%+ (industry avg). Your baseline: ~${Math.round(c.L.meta.retRate*100)}%. Calculate: returning customers ÷ total customers this month.</li>
<li><strong>Customer Lifetime Value (CLV):</strong> ${c.avgMid} avg × estimated annual frequency × avg years retained. Know this number — it tells you exactly how much to spend acquiring a new customer.</li>
<li><strong>Net new reviews this month:</strong> Target 4+ Google reviews per month. Below this and your visibility erodes over 12 months.</li>
<li><strong>Referral rate:</strong> New customers from referrals ÷ total new customers. Target ${c.bench.referralPct}%+. Your baseline: ~${Math.round(c.L.meta.refRate*100)}%.</li>
<li><strong>Customer reactivation rate:</strong> Past customers re-engaged this month. Even 1 per week compounds into significant annual revenue.</li>
</ol></div>
<h4>Operations KPIs — Track Weekly</h4>
<div class="action-box"><h5>Weekly operations dashboard</h5><ol>
<li><strong>On-time delivery rate:</strong> Target 95%+. Below 90% signals a capacity or scheduling problem that will affect reviews.</li>
<li><strong>Complaint rate:</strong> Target under 2%. At ${c.avgLo} avg job value, each complaint costs 4–6× the job value in lost future revenue.</li>
<li><strong>Revenue per team member:</strong> Total revenue ÷ headcount. Rising = efficiency. Flat = you need a process. Falling = you have a performance or pricing problem.</li>
<li><strong>Capacity utilization:</strong> Billable hours ÷ available hours. Under 70% = marketing problem. Over 90% = hiring problem. The zone is 75–85%.</li>
</ol></div>
<h4>Your KPI Tracking System</h4>
<p>Specific recommendation for how a ${c.ind} business at ${c.revRange} should track these — what tool (spreadsheet, CRM, job management software), who owns each metric, and what the Monday morning review should look like. 3–4 sentences, practical, specific to ${c.ind}.</p>
<div class="stat-call">The businesses that close their revenue gaps fastest all share one habit: they look at their numbers before they look at anything else on Monday morning. Build the dashboard first. The discipline follows.</div>`,

LOCAL:`${base}\nWrite ONLY the [LOCAL] section. First line: [LOCAL]\n\n
Write hyper-specific local market guidance for ${c.biz} — a ${c.ind} business based in ${c.city}.\n\n
<div class="quick-win">[One specific local action THIS WEEK — a partnership, community group, or local platform specific to ${c.ind} businesses in ${c.city}]</div>
<h4>The ${c.city} Market Opportunity for ${c.ind}</h4>
<p>Open with a sharp assessment of what the ${c.city} market looks like for ${c.ind} businesses — growth trends, population and demographic factors that drive demand, and why local dominance is winnable in this type of market. Reference real characteristics of markets like ${c.city} (size, economy type, growth trajectory). 3–4 sentences.</p>
<h4>Local SEO Domination</h4>
<p>Specific Google Business Profile and local SEO strategy for ${c.ind} in ${c.city}. Include the exact search terms people in ${c.city} use (e.g. "[service] near me", "[service] ${c.city}", "[neighbourhood] [service]"). What a fully optimized GBP looks like for ${c.ind}. How to rank above competitors in the map pack. 3–4 sentences with specific actions.</p>
<div class="action-box"><h5>Local SEO actions — this month</h5><ol>
<li>[GBP optimization step specific to ${c.ind} — time: 45 min]</li>
<li>[Local citation / directory submission specific to ${c.ind} — time: 30 min]</li>
<li>[Review acquisition tied to local ranking — time: ongoing]</li>
<li>[Local content page to create — specific topic for ${c.city} ${c.ind}]</li>
</ol></div>
<h4>Local Partnership Opportunities in ${c.city}</h4>
<p>Name 5–6 specific types of complementary businesses in ${c.city} that share your customer base but don't compete with ${c.ind}. For each: the exact referral opportunity, how to approach them, and what a simple reciprocal referral arrangement looks like. Be specific to the ${c.city} business ecosystem — think real estate agents, property managers, builders, insurance brokers, community groups, or whatever is specifically relevant to ${c.ind}.</p>
<h4>Community Presence — Getting Known in ${c.city}</h4>
<p>Specific local events, sponsorships, trade shows, expos, and community involvement opportunities relevant to ${c.ind} in a market like ${c.city}. Name local organization types (chambers of commerce, BNI, Rotary, local business Facebook groups, Nextdoor, neighborhood associations). What to do in each, what it costs, and what the ROI typically looks like for ${c.ind} businesses. 4–5 sentences.</p>
<h4>Hyperlocal Neighbourhood Strategy</h4>
<p>How to dominate one neighbourhood at a time in ${c.city} before expanding. The "plant a flag" strategy — vehicle signage, neighbourhood flyers, street-level presence, local social groups. Why this works better than broad marketing for ${c.ind} at ${c.revRange} revenue. Include one specific tactic that works in suburban markets and one that works in urban markets — cover both.</p>
<div class="script"><span class="slabel">Introduction script — meeting a potential local referral partner</span><p>[Complete 70-word script for ${c.ind} owner meeting a complementary business in ${c.city} for the first time — warm, confident, clear value exchange]</p></div>`,

COMPETE:`${base}\nWrite ONLY the [COMPETE] section. First line: [COMPETE]\n\n
Write specific competitive analysis guidance for ${c.biz} — a ${c.ind} business in ${c.city}.\n\n
<div class="quick-win">[One competitive intelligence action THIS WEEK — one specific thing to check about your top competitor today, in under 30 minutes]</div>
<h4>Mapping the ${c.ind} Competitive Landscape in ${c.city}</h4>
<p>How to identify and categorize the top 5–8 competitors in ${c.city} for ${c.ind}. Where to look (Google Maps search, Yelp, local directories, trade associations). How to segment them: price leaders vs premium operators vs niche specialists. What tier ${c.biz} competes in now vs where the opportunity is. 3–4 sentences, specific.</p>
<h4>The 6-Point Competitor Audit</h4>
<div class="action-box"><h5>Run this on your top 3 competitors — takes 2 hours total</h5><ol>
<li><strong>Review audit:</strong> Read every review — 1-star and 5-star. The 1-stars tell you what customers hate. The 5-stars tell you what they value. Both are roadmaps for you. Note the specific patterns for ${c.ind} in ${c.city}.</li>
<li><strong>Pricing audit:</strong> Request quotes as a mystery shopper. Know exactly where competitors price relative to you. Calculate the gap. Understand whether they're winning on price or losing on value.</li>
<li><strong>Response speed audit:</strong> Call or submit an enquiry form. Time their response. In ${c.ind}, response speed is one of the highest-leverage conversion variables. If they're slow, that's your opening.</li>
<li><strong>Online presence audit:</strong> GBP completeness, review count, website quality, social activity. Identify the channels they've abandoned — those are your opportunity channels.</li>
<li><strong>Service offer audit:</strong> What do they offer that you don't? What do you offer that they don't? What are customers asking for that nobody provides? That last question is where new revenue hides.</li>
<li><strong>Reputation trajectory audit:</strong> Are their reviews trending up or down over the last 6 months? A declining reputation is your fastest growth opportunity — their unhappy customers are looking for someone better.</li>
</ol></div>
<h4>Your Competitive Positioning Strategy</h4>
<p>Based on the typical ${c.ind} competitive landscape in markets like ${c.city}, write a sharp 3–4 sentence positioning strategy for ${c.biz}. What is the specific differentiation angle that wins in this market — speed, quality guarantee, specialization, local trust, premium service, technology, communication? Pick the angle that matches ${c.biz}'s diagnostic scores and lean into it hard.</p>
<h4>Winning Against the Low-Price Competitor</h4>
<p>Specific strategy for when a prospect says they got a cheaper quote from a competitor. The psychology of the conversation. What to say and what not to say. The value argument that resonates specifically for ${c.ind} services. 3–4 sentences.</p>
<div class="script"><span class="slabel">When a prospect says "I found someone cheaper"</span><p>[Complete 75-word response — confident, never defensive, specific to ${c.ind}, reframes value and risk, includes one specific proof point]</p></div>
<div class="script"><span class="slabel">Positioning statement — what ${c.biz} does differently (30-second version)</span><p>[Complete positioning script specific to ${c.ind} in ${c.city} — clear differentiation, memorable, not generic]</p></div>`,

TECH:`${base}\nWrite ONLY the [TECH] section. First line: [TECH]\n\n
Write a specific technology and software stack recommendation for ${c.biz} — a ${c.ind} business at ${c.revRange} revenue.\n\n
<div class="quick-win">[One tech action THIS WEEK — one specific software to trial or set up that would immediately improve revenue tracking or customer communication in ${c.ind}]</div>
<h4>The Tech Gap in ${c.ind} Businesses</h4>
<p>Most ${c.ind} businesses at ${c.revRange} revenue are running on a combination of spreadsheets, text messages, and memory. Open with a sharp statement about what that costs in missed follow-ups, lost quotes, and untracked revenue. Reference what top-performing ${c.ind} businesses use differently. 2–3 sentences.</p>
<h4>Your Core Tech Stack — by Category</h4>
<div class="action-box"><h5>CRM & lead management — the most important category</h5><ol>
<li>Name the 2–3 best CRM options specifically for ${c.ind} businesses at ${c.revRange} revenue. For each: approximate cost, key features relevant to ${c.ind}, and the specific workflow it fixes (follow-up automation, quote tracking, pipeline visibility). Be specific — name real software.</li>
<li>What to look for in a CRM for ${c.ind}: integrations, mobile app quality, quote/invoice capability, automation features.</li>
<li>The one CRM feature that pays for itself fastest in ${c.ind}: [specific feature and why].</li>
</ol></div>
<div class="action-box"><h5>Job management & scheduling</h5><ol>
<li>Name the 2–3 best job management platforms specifically for ${c.ind}. Cost, key features, what problem they solve. Be specific — name real software used in ${c.ind}.</li>
<li>How job management software directly increases revenue in ${c.ind}: fewer dropped balls, faster invoicing, better capacity visibility.</li>
<li>The integration between CRM and job management that most ${c.ind} businesses skip — and what it costs them.</li>
</ol></div>
<div class="action-box"><h5>Marketing & communication tools</h5><ol>
<li><strong>Review automation:</strong> Name the best review request tool for ${c.ind}. How to set it up. Expected review velocity once running.</li>
<li><strong>Email/SMS automation:</strong> Best tool for ${c.ind} follow-up sequences. Name it, cost, and the one automation to set up first.</li>
<li><strong>Social & content:</strong> Which platforms matter most for ${c.ind} in ${c.city} and what tools simplify content creation. Be specific.</li>
<li><strong>Booking & scheduling:</strong> Online booking software recommendation for ${c.ind} — if relevant to their model. Name specific tools.</li>
</ol></div>
<div class="action-box"><h5>Finance & operations</h5><ol>
<li><strong>Accounting:</strong> Specific recommendation for ${c.ind} at ${c.revRange} — not generic. What integrations matter for this industry.</li>
<li><strong>Quoting & invoicing:</strong> If separate from CRM, name the best quoting tool for ${c.ind}. What a professional quote looks like vs a basic one and the conversion rate difference.</li>
<li><strong>Reporting dashboard:</strong> How to pull all KPIs into one view. Tool recommendations for ${c.ind} at this revenue stage.</li>
</ol></div>
<h4>Implementation Order</h4>
<p>Specific recommendation for the order to implement these tools for a ${c.ind} business at ${c.revRange} — what to set up first, second, third, and why. What to delay. The common mistake of buying too much software at once and what it costs in distraction. 3–4 sentences.</p>
<div class="stat-call">The right tech stack for ${c.ind} at ${c.revRange} costs approximately $200–$600/month fully implemented. The revenue it protects — through better follow-up, faster response, and automatic review collection — is typically 10–20× that monthly cost within 90 days.</div>`,

ASSETS:`${base}\nWrite ONLY the [ASSETS] section. First line: [ASSETS]\n\n
Write specific business asset and valuation guidance for ${c.biz} — a ${c.ind} business at ${c.revRange} revenue.\n\n
<div class="quick-win">[One asset-building action THIS WEEK — one thing to document, systematize, or protect that increases business value]</div>
<h4>What Your Business Is Actually Worth</h4>
<p>Most ${c.ind} business owners think about revenue. Buyers think about EBITDA, systems, and risk. Open with the current estimated valuation range for a ${c.ind} business at ${c.revRange} using typical EBITDA multiples for this industry (name them — usually 2–5× EBITDA for service businesses, more for systemized ones). Then explain what moves that multiple up or down. 3–4 sentences with real numbers.</p>
<h4>The Value Drivers — What Buyers and Investors Pay For</h4>
<div class="action-box"><h5>The 8 assets that increase your sale price or investment value</h5><ol>
<li><strong>Recurring revenue:</strong> For ${c.ind}, what recurring or retainer revenue looks like and what it does to valuation. A maintenance contract, service plan, or membership model can add 1–2× to your multiple.</li>
<li><strong>Customer list and relationships:</strong> How many customers you have, their LTV, and how documented the relationships are. A CRM with full history is worth money. Post-it notes are not.</li>
<li><strong>Documented systems and SOPs:</strong> A business that runs without the owner is worth 2–3× more than one that depends on them. Every SOP you write today increases your future sale price.</li>
<li><strong>Brand and online reputation:</strong> Your Google review count, website domain authority, and social following are quantifiable assets. Name what these are typically worth in ${c.ind} acquisitions.</li>
<li><strong>Team and key personnel:</strong> Trained, retained staff reduce buyer risk. Staff retention agreements, org charts, and training documentation add value.</li>
<li><strong>Equipment and physical assets:</strong> Specific to ${c.ind} — what equipment, vehicles, tools, and inventory you have and how they factor into valuation. Depreciation schedules matter.</li>
<li><strong>Supplier and vendor relationships:</strong> Exclusive arrangements, preferred pricing, or long-term contracts with suppliers add value — especially in ${c.ind}.</li>
<li><strong>Intellectual property:</strong> Proprietary processes, branded service names, training materials, or content you've created. Undervalued by most ${c.ind} owners.</li>
</ol></div>
<h4>Building Value Now — Even if You're Not Selling</h4>
<p>The paradox: the actions that increase business value (documentation, systems, recurring revenue, customer retention) are the same actions that increase operating profit. Building for exit is just building a better business. Specific to ${c.ind}: what to focus on in the next 12 months to materially increase valuation. 3–4 sentences.</p>
<h4>Protecting Your Assets</h4>
<p>Specific asset protection guidance for ${c.ind} business owners: business structure (LLC vs S-Corp considerations), insurance coverage for ${c.ind} operations, non-compete and non-solicitation agreements with staff, protecting your customer list. 3–4 practical sentences — not legal advice, but operational guidance. Recommend consulting a qualified advisor.</p>
<div class="stat-call">A ${c.ind} business at ${c.revRange} with documented systems, consistent reviews, and a customer retention rate above ${c.bench.retention}% typically commands a valuation 40–60% higher than an equivalent business without those things. Start building the asset today.</div>`,

SCALE:`${base}\nWrite ONLY the [SCALE] section. First line: [SCALE]\n\n
Write specific scaling guidance for ${c.biz} — a ${c.ind} business at ${c.revRange} revenue in ${c.city}.\n\n
<div class="quick-win">[One scaling preparation action THIS WEEK — one system to document or process to standardize before adding capacity]</div>
<h4>Are You Ready to Scale?</h4>
<p>Scaling a broken system creates a bigger broken system. Before adding marketing budget, staff, or locations, be honest about the engine. Open with a sharp diagnostic: what has to be true about a ${c.ind} business at ${c.revRange} before scaling makes sense vs makes things worse. 3 sentences.</p>
<div class="action-box"><h5>The 5 readiness gates — all 5 must be true before you scale</h5><ol>
<li><strong>Quality is consistent:</strong> Complaint rate under 3%. If customers are already unhappy at current volume, more volume just means more unhappy customers and more 1-star reviews.</li>
<li><strong>Lead flow is predictable:</strong> At least 2 inbound channels generating leads without your personal involvement each week. You need to know you can fill the capacity you're about to add.</li>
<li><strong>Core processes are documented:</strong> A new hire could execute your top 5 job functions using written instructions. If the knowledge is only in your head, you cannot scale without becoming the bottleneck.</li>
<li><strong>Finances are visible:</strong> You know your gross margin per service line, cost per job, and break-even point. Scaling without this is running a race blindfolded.</li>
<li><strong>Retention is working:</strong> Repeat rate above ${Math.max(20, Math.round(c.L.meta.retRate*100)+10)}%. There is no point spending money to acquire customers faster than you lose them.</li>
</ol></div>
<h4>Scaling Levers for ${c.ind} at ${c.revRange}</h4>
<p>Name the 3–4 most relevant scaling paths for ${c.ind} businesses at this revenue level. Be specific: geographic expansion (when and how in a market like ${c.city}), service line expansion (what to add next and why), team scaling (what the staffing model looks like as you grow), and channel scaling (what marketing channels to add at scale). For each: the trigger point (what revenue/capacity number signals it's time), the risk, and the payoff.</p>
<h4>The Scaling Timeline for ${c.ind}</h4>
<table><tr><th>Revenue Stage</th><th>Focus</th><th>Key Moves</th><th>Warning Signs</th></tr>
<tr><td>Under $250k</td><td>Systematize</td><td>[specific to ${c.ind}]</td><td>[specific warning]</td></tr>
<tr><td>$250k–$500k</td><td>First hire</td><td>[specific to ${c.ind}]</td><td>[specific warning]</td></tr>
<tr><td>$500k–$1M</td><td>Team + process</td><td>[specific to ${c.ind}]</td><td>[specific warning]</td></tr>
<tr><td>$1M+</td><td>Leadership layer</td><td>[specific to ${c.ind}]</td><td>[specific warning]</td></tr></table>
<h4>The Founder Trap — and How to Escape It</h4>
<p>The biggest scaling obstacle in ${c.ind} is the owner becoming the bottleneck. Specific to ${c.ind}: what tasks the owner should eliminate, delegate, or automate first. The 4 categories (Eliminate / Automate / Delegate / Do) applied to a typical ${c.ind} owner's week. What freedom looks like at $1M in ${c.ind}. 4–5 sentences.</p>`,

HIRE:`${base}\nWrite ONLY the [HIRE] section. First line: [HIRE]\n\n
Write specific hiring and team-building guidance for ${c.biz} — a ${c.ind} business at ${c.revRange} revenue.\n\n
<div class="quick-win">[One hiring preparation action THIS WEEK — one job description to write, one process to document, or one org chart to sketch]</div>
<h4>The Hiring Decision — When and Who First</h4>
<p>The wrong hire at the wrong time destroys more small businesses than bad marketing. Open with the specific trigger that signals it's time to hire in ${c.ind}: what revenue level, what capacity utilization rate, what owner bottleneck. Name the exact first hire that generates positive ROI fastest for a ${c.ind} business at ${c.revRange} — and why. 3–4 sentences with real logic.</p>
<h4>The Hiring Sequence for ${c.ind}</h4>
<div class="action-box"><h5>First 3 hires in order — specific to ${c.ind} at ${c.revRange}</h5><ol>
<li><strong>First hire:</strong> Name the role. Approximate cost. What it frees you to do. How long before it pays for itself in ${c.ind}. What to look for in a candidate. Red flags specific to this role in ${c.ind}.</li>
<li><strong>Second hire:</strong> Same format. When the trigger is. The specific skills that matter in ${c.ind} for this role.</li>
<li><strong>Third hire:</strong> Same format. By this point, what the team structure looks like for a ${c.ind} business at this stage.</li>
</ol></div>
<h4>Where to Find Good People for ${c.ind}</h4>
<p>Specific recruiting channels that work for ${c.ind} in a market like ${c.city}: trade schools and apprenticeship programs, industry associations, job boards specific to the trade, staff referral incentives, social media recruiting. What the hiring competition looks like in ${c.ind} and how to win candidates without being the highest payer. 3–4 sentences.</p>
<h4>Onboarding That Actually Works</h4>
<p>Most ${c.ind} businesses hire someone and hand them a uniform. Describe what a proper 30-day onboarding looks like for the most common role in ${c.ind}: day 1, week 1, week 2–4, end of month 1 review. What documentation to have ready. The specific questions to answer in the first week that prevent 80% of early turnover in ${c.ind}. 3–4 sentences.</p>
<h4>Retaining Your Best People</h4>
<p>Staff turnover in ${c.ind} costs 1–2× the employee's annual salary to replace (recruiting, training, lost productivity, customer disruption). Specific retention strategies for ${c.ind} businesses: performance-based pay structures that work, career path conversations, recognition systems, flexibility considerations. What the best-paying ${c.ind} employers in ${c.city} do differently. 3–4 sentences.</p>
<div class="action-box"><h5>Before you post your first job listing</h5><ol>
<li>[Document the role in writing — what they do, not what you need. Time: 1 hour]</li>
<li>[Write the onboarding checklist — first 30 days. Time: 2 hours]</li>
<li>[Set the performance metrics for this role — what does success look like at 90 days? Time: 30 min]</li>
<li>[Define the compensation structure — base, bonus triggers, review timeline. Time: 1 hour]</li>
</ol></div>`,

ACQUIRE:`${base}\nWrite ONLY the [ACQUIRE] section. First line: [ACQUIRE]\n\n
Write specific acquisition strategy guidance for ${c.biz} — a ${c.ind} business at ${c.revRange} revenue in ${c.city}.\n\n
<div class="quick-win">[One acquisition preparation action THIS WEEK — identify one competitor or complementary business worth monitoring as a potential acquisition target]</div>
<h4>Why Acquisition Beats Cold Growth in ${c.ind}</h4>
<p>Acquiring a competitor or complementary business in ${c.city} buys you customers, revenue, staff, equipment, and brand — immediately. Organic growth takes years to achieve what a well-structured acquisition can do in 90 days. At ${c.revRange} revenue, ${c.biz} is at exactly the stage where strategic acquisition becomes viable. Open with the specific math: what a $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))*0.3).toLocaleString()} acquisition could add to annual revenue in ${c.ind}. 3 sentences.</p>
<h4>What to Look For — Ideal Acquisition Targets in ${c.ind}</h4>
<div class="action-box"><h5>Characteristics of a strong ${c.ind} acquisition target in ${c.city}</h5><ol>
<li><strong>Owner is ready to exit:</strong> Retirement-age owners, health issues, burnout. These deals happen at lower multiples because the owner prioritizes speed over price. Where to find them: industry associations, direct outreach, business brokers.</li>
<li><strong>Established customer base:</strong> A book of customers with documented history is the asset. You're not buying equipment — you're buying relationships. Ask for 2 years of revenue by customer.</li>
<li><strong>Geographic complement:</strong> A business in a ${c.city} neighbourhood or suburb you don't currently serve. Instant market expansion with zero customer acquisition cost.</li>
<li><strong>Struggling with ops, not demand:</strong> A business with good customers but poor systems, weak reviews, or an owner who can't delegate. These are undervalued because the problems are fixable — and you know how to fix them from your own diagnostic.</li>
<li><strong>Comparable service quality:</strong> Acquiring a business with a 2-star reputation inherits their problems. Look for businesses with decent reviews and operational issues — not reputation issues.</li>
</ol></div>
<h4>How to Structure a ${c.ind} Acquisition</h4>
<p>Common acquisition structures that work for ${c.ind} businesses at this stage: asset purchase vs share purchase, seller financing (where the seller takes payments over 2–5 years — reduces your upfront capital requirement significantly), earnout structures (where the seller earns part of the price based on retained revenue post-sale). Which structure is most common in ${c.ind} and why. 4–5 sentences — not legal advice, but operational orientation.</p>
<h4>How to Find and Approach Targets</h4>
<p>Specific methods for identifying acquisition targets in the ${c.ind} space in ${c.city}: direct cold outreach (what to say, what not to say), business brokers who specialize in ${c.ind} or trades, industry association relationships, word of mouth in the trade. The approach that gets the best response from owners who haven't publicly listed their business. Include a rough outreach script.</p>
<div class="script"><span class="slabel">Cold outreach to a potential acquisition target — email</span><p>[Complete 80-word email from a ${c.ind} business owner to another owner in ${c.city} — warm, respectful, no pressure, opens the conversation about future plans]</p></div>
<h4>Due Diligence — What to Check Before You Sign</h4>
<p>The 5 most important things to verify in a ${c.ind} acquisition: customer concentration risk (are 30%+ of revenues from one customer?), reason for selling (what's the owner not telling you?), staff retention risk (will key people leave?), equipment condition and maintenance records, and outstanding liabilities or complaints. Recommend hiring a qualified accountant and lawyer — but know what to look for yourself first. 3–4 sentences.</p>`,

CHECKLIST:`${base}\nWrite ONLY the [CHECKLIST] section. First line: [CHECKLIST]\n\n
Write a comprehensive implementation checklist for ${c.biz} — a ${c.ind} business. This section should be the most actionable in the entire report. Every item is specific, time-boxed, and sequenced.\n\n
<h4>Master Implementation Checklist — ${c.biz}</h4>
<p>This is your single source of truth. Print it. Tick it. Do it in order. The sequence is optimized for maximum early revenue with minimum disruption to your current operations.</p>
<div class="action-box"><h5>Week 1 — Quick wins (all doable in under 60 min each)</h5><ol>
<li>[${c.ind}-specific action — conversion — 30 min — specific outcome expected]</li>
<li>[${c.ind}-specific action — dead leads — 45 min — specific outcome expected]</li>
<li>[${c.ind}-specific action — reviews — 20 min — specific outcome expected]</li>
<li>[${c.ind}-specific action — referrals — 30 min — specific outcome expected]</li>
<li>[${c.ind}-specific action — KPI dashboard setup — 60 min — specific outcome]</li>
<li>[${c.ind}-specific action — local presence — 45 min — specific outcome]</li>
</ol></div>
<div class="action-box"><h5>Week 2 — Systems (building what runs automatically)</h5><ol>
<li>[Follow-up sequence setup — specific to ${c.ind} — time estimate]</li>
<li>[Review request automation — specific tool and setup step]</li>
<li>[CRM or job management setup — specific to ${c.ind}]</li>
<li>[Referral program documentation — specific structure for ${c.ind}]</li>
<li>[Competitor audit — 3 competitors, 2 hours, specific output]</li>
<li>[Pricing review — specific methodology for ${c.ind}]</li>
</ol></div>
<div class="action-box"><h5>Month 1 — Foundation (everything that compounds over 90 days)</h5><ol>
<li>[SOP documentation — first process to write for ${c.ind}]</li>
<li>[Google Business Profile full optimization — specific to ${c.ind}]</li>
<li>[Local partnership — first outreach, specific target type]</li>
<li>[Customer reactivation campaign — specific approach for ${c.ind}]</li>
<li>[KPI review cadence — first Monday morning dashboard review]</li>
<li>[Pricing tier creation — Good/Better/Best for ${c.ind}]</li>
<li>[Tech stack decision — which tool to implement first]</li>
</ol></div>
<div class="action-box"><h5>Month 2 — Momentum (systems running, now optimize)</h5><ol>
<li>[Content creation — first piece of local ${c.city} content]</li>
<li>[Team process — first thing to delegate or document for future hire]</li>
<li>[Retention system — 30/60/90 day customer touchpoint structure]</li>
<li>[Dead lead re-engagement — second wave]</li>
<li>[Review response — systematic response to all existing reviews]</li>
<li>[Premium service offering — design and price]</li>
</ol></div>
<div class="action-box"><h5>Month 3 — Scale preparation (building for what comes next)</h5><ol>
<li>[Hiring decision — evaluate readiness using the 5 gates from the Hiring section]</li>
<li>[Asset documentation — update for valuation]</li>
<li>[Tech stack — second tool implementation]</li>
<li>[Local market expansion — identify next neighbourhood or service area]</li>
<li>[Acquisition radar — identify and monitor 2–3 potential targets]</li>
<li>[90-day review — measure actual results against KPI targets, reset for next quarter]</li>
</ol></div>
<div class="stat-call">Businesses that complete 70%+ of this checklist in 90 days consistently recover 20–30% of their identified opportunity. The difference is not strategy — it is execution. Pick the first item. Start today.</div>`,

ROADMAP:`${base}\nWrite ONLY the [ROADMAP] section. First line: [ROADMAP]\n\n
Write a detailed, week-by-week 90-day roadmap specific to ${c.biz} — a ${c.ind} business. Every task must be specific to ${c.ind}, time-boxed, and sequenced for maximum early revenue.\n\n
<h4>Your 90-Day Revenue Recovery Roadmap</h4>
<p>This is not a wish list. It is a sequence. The order matters — early wins fund the discipline for later steps. Resistance is highest in week 1. Start the first item within 48 hours of reading this.</p>
<div class="pgrid">
<div class="pcard"><div class="ptag">Week 1 — Days 1–7</div><div class="ptitle">Immediate Revenue Actions</div>
<div class="ptask">Day 1 (30 min): [Most impactful single action for ${c.ind} — specific, doable today]</div>
<div class="ptask">Day 1 (45 min): [Second action — specific to ${c.ind}'s top gap]</div>
<div class="ptask">Day 2 (60 min): [KPI dashboard setup — specific tools and numbers for ${c.ind}]</div>
<div class="ptask">Day 2 (30 min): [Dead lead re-engagement — first batch, specific to ${c.ind}]</div>
<div class="ptask">Day 3 (45 min): [Review request to last 10 completed customers — specific script]</div>
<div class="ptask">Day 4 (60 min): [Follow-up sequence — write and schedule emails 1–3, specific to ${c.ind}]</div>
<div class="ptask">Day 5 (30 min): [Referral ask — first systematic ask, specific script from REF section]</div>
<div class="ptask">Days 6–7: [GBP optimization — specific to ${c.ind} in ${c.city}]</div>
<div class="pmile">Day 7 milestone: First follow-up sequence running. KPI dashboard live. 10+ review requests sent. First referral ask made. Measure: leads in pipeline, quotes outstanding.</div>
</div>
<div class="pcard"><div class="ptag">Week 2 — Days 8–14</div><div class="ptitle">Systems & Foundation</div>
<div class="ptask">Day 8 (2 hrs): [CRM or job management setup — specific tool for ${c.ind}]</div>
<div class="ptask">Day 9 (90 min): [Pricing review — test new rate on next 3 quotes, specific to ${c.ind}]</div>
<div class="ptask">Day 10 (60 min): [Competitor audit — 3 competitors, specific output]</div>
<div class="ptask">Day 11 (45 min): [First SOP — document most repeated ${c.ind} process]</div>
<div class="ptask">Day 12 (30 min): [Local partnership outreach — 3 emails to complementary businesses in ${c.city}]</div>
<div class="ptask">Days 13–14: [Review all week 1 KPIs — what moved, what didn't, adjust]</div>
<div class="pmile">Day 14 milestone: CRM active with all current leads loaded. Pricing test underway. First SOP written. Local outreach sent. 3+ new reviews received.</div>
</div>
<div class="pcard"><div class="ptag">Month 1 — Days 15–30</div><div class="ptitle">Momentum</div>
<div class="ptask">(2 hrs): [Customer reactivation campaign — email all customers from last 12 months, ${c.ind}-specific message]</div>
<div class="ptask">(90 min): [Premium tier design — Good/Better/Best pricing for ${c.ind}]</div>
<div class="ptask">(60 min): [Review response system — respond to all existing reviews, set up alerts]</div>
<div class="ptask">(2 hrs): [Local content — first piece targeting "${c.ind} in ${c.city}" keyword]</div>
<div class="ptask">(ongoing): [Weekly KPI review — every Monday, 30 minutes, non-negotiable]</div>
<div class="pmile">Day 30 milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.08).toLocaleString()} monthly revenue target (8% above baseline). 5+ new reviews. 2+ local partnerships active. Premium tier launched. Referral system running.</div>
</div>
<div class="pcard"><div class="ptag">Month 2 — Days 31–60</div><div class="ptitle">Optimization</div>
<div class="ptask">[Analyze which lead sources are converting best — double down]</div>
<div class="ptask">[Second SOP — next most important ${c.ind} process]</div>
<div class="ptask">[Tech tool #2 implementation — based on TECH section recommendation]</div>
<div class="ptask">[Staff/capacity review — are you hitting 80%+ utilization? Time to plan first hire]</div>
<div class="ptask">[Dead lead batch #2 — second wave re-engagement]</div>
<div class="ptask">[Local community touchpoint — attend or sponsor one ${c.city} event or group]</div>
<div class="pmile">Day 60 milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.15).toLocaleString()} monthly revenue target (15% above baseline). Review count up by 10+. Referral rate measurably improving. Hiring decision made.</div>
</div>
<div class="pcard"><div class="ptag">Month 3 — Days 61–90</div><div class="ptitle">Scale Preparation</div>
<div class="ptask">[Hiring: post first role or confirm decision to delay — based on capacity data]</div>
<div class="ptask">[Acquisition radar: identify 2–3 ${c.ind} businesses in ${c.city} worth monitoring]</div>
<div class="ptask">[Asset documentation: update business value drivers — systems, customer list, staff]</div>
<div class="ptask">[Pricing: review results of premium tier — adjust and optimize]</div>
<div class="ptask">[Q2 planning: set new 90-day KPI targets based on actual Q1 results]</div>
<div class="ptask">[Full diagnostic review: re-score all 8 categories against your new baseline]</div>
<div class="pmile">Day 90 milestone: $${Math.round(parseInt(c.revMid.replace(/[$,]/g,''))/12*1.22).toLocaleString()} monthly revenue target (22% above baseline — realistic scenario). Close rate at ${Math.min(95,Math.round(c.L.meta.close*100)+12)}%+. Referral rate at ${Math.min(50,Math.round(c.L.meta.refRate*100)+10)}%+. Systems documented. First hire underway or decision made. Business running measurably differently than Day 1.</div>
</div>
</div>`,

  };
 
  return prompts[key] || `${base}\nWrite the [${key}] section for ${c.biz}, a ${c.ind} business. First line must be exactly: [${key}]`;
}
 
// ══════════════════════════════════════════════════
//  START SERVER + RECOVER PENDING JOBS FROM SUPABASE
// ══════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
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
      console.log(`  ⚠ Undelivered: ${row.email} (${row.biz_name}) — use POST /resend to retry`);
    });
    console.log(`Undelivered emails: ${rows.map(r => r.email).join(', ')}`);

  } catch(e) {
    console.warn('Job recovery error:', e.message);
  }
});