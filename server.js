const express = require('express');
const fetch = require('node-fetch');
 
const app = express();
app.use(express.json({ limit: '10mb' }));
 
// ══════════════════════════════════════════════════
//  JOB QUEUE
//  Jobs process one at a time — no concurrent API calls
//  Customers wait in line, all get fully AI-generated reports
//  No fallbacks — retries on failure instead
// ══════════════════════════════════════════════════
const queue = [];
let isProcessing = false;

// Store all jobs by email so they can be resent
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
  console.log(`Processing job for ${job.email}. Remaining in queue: ${queue.length}`);
  try {
    await generateAndSend(job);
    console.log(`✓ Completed job for ${job.email}`);
  } catch(e) {
    console.error(`✗ Job failed for ${job.email}:`, e.message);
  }
  isProcessing = false;
  if (queue.length > 0) {
    console.log(`Starting next job. ${queue.length} remaining.`);
    processNext();
  }
}
 
// ══════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'RevAnalysis worker running',
    queueLength: queue.length,
    isProcessing
  });
});
 
// ══════════════════════════════════════════════════
//  QUEUE STATUS — useful for monitoring
// ══════════════════════════════════════════════════
app.get('/status', (req, res) => {
  res.json({
    queueLength: queue.length,
    isProcessing,
    jobs: queue.map(j => ({ email: j.email, bizName: j.bizName }))
  });
});


// ══════════════════════════════════════════════════
//  RESEND ENDPOINT — for manual resends when customer 
//  didn't receive their report
//  Usage: POST /resend  { "email": "customer@email.com" }
//  Protected by ADMIN_KEY env var
// ══════════════════════════════════════════════════
app.post('/resend', (req, res) => {
  const { email, adminKey } = req.body;

  // Basic protection so random people can't trigger resends
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const job = jobStore[email];
  if (!job) {
    return res.status(404).json({ 
      error: `No job found for ${email}`,
      availableEmails: Object.keys(jobStore)
    });
  }

  enqueue({ ...job });
  console.log(`Resend queued for ${email}`);
  res.status(200).json({ queued: true, email, bizName: job.bizName });
});

// ══════════════════════════════════════════════════
//  LIST STORED JOBS — see all jobs you can resend
// ══════════════════════════════════════════════════
app.get('/jobs', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const jobs = Object.values(jobStore).map(j => ({
    email: j.email,
    bizName: j.bizName,
    industry: j.industry,
    savedAt: j.savedAt
  }));
  res.json({ count: jobs.length, jobs });
});
 
// ══════════════════════════════════════════════════
//  GENERATE ENDPOINT
//  Returns 200 immediately, adds job to queue
// ══════════════════════════════════════════════════
app.post('/generate', (req, res) => {
  const { email, bizName, industry, calcData, answers } = req.body;
  if (!email || !calcData) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Save job data for potential resend
  jobStore[email] = { email, bizName, industry, calcData, answers, savedAt: new Date().toISOString() };

  enqueue({ email, bizName, industry, calcData, answers });
  const position = queue.length;
  const estimatedMinutes = isProcessing ? Math.round((position + 1) * 6) : Math.round(position * 6);
  res.status(200).json({ queued: true, position, estimatedMinutes });
});
 
// ══════════════════════════════════════════════════
//  MAIN GENERATION FUNCTION
// ══════════════════════════════════════════════════
async function generateAndSend({ email, bizName, industry, calcData, answers }) {
  const SECTION_KEYS = ['EXEC','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','PRIORITY','PLAN','ROI'];
  const sections = {};
  const ctx = buildServerContext(bizName, industry, calcData, answers);
 
  console.log(`Starting generation for ${bizName} (${email})`);
 
  for (let i = 0; i < SECTION_KEYS.length; i++) {
    const key = SECTION_KEYS[i];
    console.log(`  Section ${i+1}/12: ${key}`);
 
    // Retry up to 3 times — waits 30s between retries for rate limit to clear
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
        break; // success — move to next section
      } catch(e) {
        attempt++;
        console.warn(`  ✗ ${key} attempt ${attempt}/3 failed: ${e.message}`);
        if (attempt < 3) {
          console.log(`  Waiting 30s before retry...`);
          await sleep(30000);
        } else {
          // After 3 failures throw so the whole job fails cleanly
          // The customer will need to be contacted manually
          throw new Error(`Section ${key} failed after 3 attempts: ${e.message}`);
        }
      }
    }
 
    // 22-second delay between sections — keeps under Anthropic rate limit
    if (i < SECTION_KEYS.length - 1) {
      await sleep(22000);
    }
  }
 
  console.log(`All 12 sections done for ${bizName}. Generating PDF...`);
 
  const reportHtml = buildEmailHtml(bizName, industry, calcData, sections);
 
  let pdfBase64 = null;
  try {
    pdfBase64 = await generatePDF(reportHtml);
    console.log('PDF generated');
  } catch(e) {
    // PDF failing is non-fatal — send email without attachment
    console.warn('PDF failed, sending without attachment:', e.message);
  }
 
  await sendEmail({
    to: email,
    bizName,
    reportHtml,
    pdfBase64,
    pdfFilename: `${(bizName||'Report').replace(/[^a-z0-9]/gi,'_')}_RevAnalysis_Report.pdf`
  });
 
  console.log(`✓ Email sent to ${email}`);
}
 
// ══════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));
 
function buildServerContext(bizName, industry, calcData, answers) {
  const L = calcData;
  const a = answers || {};
  const top3 = L.cats.slice(0,3).map(c => `${c.n} (estimated ~$${c.amt.toLocaleString()})`).join(', ');
  const goalOpts = [
    'Get more consistent inbound leads',
    'Convert more leads into paying customers',
    'Get past customers buying again',
    'Build a referral system that works automatically',
    'Raise prices without losing customers',
    'Fix quality and stop losing money on errors'
  ];
  const goal = goalOpts[a.topGoal ?? 0] || 'growing revenue';
  return {
    biz: bizName, ind: industry,
    revRange: L.meta.revLabel,
    revLo: `$${L.meta.revLo.toLocaleString()}`,
    revMid: `$${L.meta.revMid.toLocaleString()}`,
    avgLo: `$${L.meta.avgLo.toLocaleString()}`,
    avgMid: `$${L.meta.avgMid.toLocaleString()}`,
    close: `${Math.round(L.meta.close * 100)}%`,
    mthLeads: L.meta.mthLeads,
    annCusts: L.meta.annCusts,
    dead: L.meta.dead,
    total: `~$${L.total.toLocaleString()}`,
    totalRange: `$${L.totalLo.toLocaleString()}–$${L.totalHi.toLocaleString()}`,
    top3, goal,
    cats: L.cats.map(c => `${c.n}: ~$${c.amt.toLocaleString()} (${c.desc})`).join('\n'),
    scores: Object.entries(L.sc).map(([k,v]) => `${k}: ${v}/100`).join(', '),
    L
  };
}
 
async function callAnthropic(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2200,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data.content.map(b => b.text || '').join('');
}
 
async function generatePDF(html) {
  const r = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64')}`
    },
    body: JSON.stringify({
      source: html,
      landscape: false,
      use_print: false,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    })
  });
  if (!r.ok) throw new Error(`PDFShift ${r.status}`);
  const buffer = await r.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
 
async function sendEmail({ to, bizName, reportHtml, pdfBase64, pdfFilename }) {
  const payload = {
    from: 'RevAnalysis <reports@flaviodeoliveira.com>',
    to: [to],
    subject: `Your RevAnalysis Report is ready — ${bizName}`,
    html: reportHtml
  };
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
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
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
 
function sysPrompt(c) {
  return `You are a senior business revenue consultant writing a comprehensive diagnostic report for ${c.biz}, a ${c.ind} business.
 
CLIENT DIAGNOSTIC DATA (note: revenue is a range estimate):
- Revenue range: ${c.revRange} (using conservative low estimate ${c.revLo} for calculations)
- Average transaction: approximately ${c.avgMid} (range-based estimate)
- Monthly leads: ~${c.mthLeads} (estimated) | Close rate: ~${c.close} | Annual customers: ~${c.annCusts}
- Total estimated annual opportunity: ${c.total} (conservative range: ${c.totalRange})
- Top 3 opportunities: ${c.top3}
- Performance scores: ${c.scores}
- Owner's #1 goal: ${c.goal}
 
All 8 opportunity categories (conservative estimates):
${c.cats}
 
CRITICAL WRITING RULES:
1. ALWAYS acknowledge figures are estimates — use "estimated", "approximately", "based on your diagnostic"
2. Never state precise figures as definitive facts
3. Write specifically for ${c.ind} businesses — not generic advice
4. Cite real research by SOURCE NAME only — no URLs
5. Every section MUST include complete, word-for-word scripts
6. Number all action steps with realistic time estimates
7. Write 250–300 words per section
8. COMPLETE every section fully — do not truncate
9. Use recovery language like "businesses in ${c.ind} typically recover 15–25% of identified gaps in 90 days"
10. HTML formatting: <p>, <strong>, <h4>, <div class="stat-call">, <div class="script">, <div class="action-box">`;
}
 
function buildSectionPrompt(key, c) {
  const base = sysPrompt(c);
  const prompts = {
    EXEC: `${base}\nWrite ONLY the [EXEC] section. Use this exact marker on the first line.\n\n[EXEC]\nWrite 5 focused paragraphs (~280 words total) for ${c.biz}, a ${c.ind} business. Open with the ~${c.total} opportunity. Explain why ${c.ind} specifically loses revenue this way. Cover top 3 opportunities: ${c.top3}. Describe the 90-day implementation path. End with the reactive-to-systematic mindset shift.\n<div class="stat-call">Include one real industry statistic with source name relevant to ${c.ind}.</div>\n<div class="disclaimer">Note: All figures are estimates based on ranges provided. Actual results depend on your situation and implementation consistency.</div>`,
    CONV: `${base}\nWrite ONLY the [CONV] section. Use this exact marker on the first line.\n\n[CONV]\nWrite the lead conversion analysis (~280 words) for ${c.biz}, a ${c.ind} business:\n<h4>Close Rate Analysis</h4>\n<p>${c.close} close rate vs ~65% ${c.ind} benchmark. Calculate opportunity. Reference CSO Insights.</p>\n<h4>Response Speed Gap</h4>\n<p>MIT/HBR 5-minute rule applied to ${c.ind}. 3-4 sentences.</p>\n<h4>Follow-Up System Gap</h4>\n<p>Salesforce 80%/5-touch. Specific to ${c.ind}. 3-4 sentences.</p>\n<h4>5-Email Follow-Up Sequence</h4>\nCRITICAL: Each email COMPLETE. 60-70 words each. Do not truncate.\n<div class="script"><span class="slabel">Email 1 — Same Day (Subject: [specific to ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Email 2 — Day 2 (Subject: [specific])</span><p>[Complete 60-word email]</p></div>\n<div class="script"><span class="slabel">Email 3 — Day 5 (Subject: [specific])</span><p>[Complete 60-word email addressing ${c.ind} objection]</p></div>\n<div class="script"><span class="slabel">Email 4 — Day 10 (Subject: [specific])</span><p>[Complete 55-word email mild urgency]</p></div>\n<div class="script"><span class="slabel">Email 5 — Day 21 (Subject: Closing the loop)</span><p>[Complete 45-word breakup email]</p></div>`,
    DEAD: `${base}\nWrite ONLY the [DEAD] section. Use this exact marker on the first line.\n\n[DEAD]\nWrite the dead leads section (~230 words) for ${c.biz}, a ${c.ind} business:\n<h4>Value in Your Pipeline</h4>\n<p>~${c.dead} leads × ${c.avgLo} avg × 12% re-engagement = approximately $[X]. 3 reasons leads go cold in ${c.ind}.</p>\n<h4>Re-Engagement Sequence</h4>\n<div class="script"><span class="slabel">Re-engagement Email (Subject: [specific to ${c.ind}])</span><p>[Complete 65-word email]</p></div>\n<div class="script"><span class="slabel">Follow-Up Text — 3 Days Later (under 140 chars)</span><p>[Complete text]</p></div>\n<div class="script"><span class="slabel">Final Email — Day 10 (Subject: Last one from us)</span><p>[Complete 45-word email]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
    MKTG: `${base}\nWrite ONLY the [MKTG] section. Use this exact marker on the first line.\n\n[MKTG]\nWrite the marketing efficiency section (~240 words) for ${c.biz}, a ${c.ind} business:\n<h4>Marketing Diagnosis</h4><p>Honest assessment specific to ${c.ind}.</p>\n<h4>The 2 Highest-ROI Channels for ${c.ind}</h4><p>Name channels with data and source names. Specific ROI for each.</p>\n<h4>30-Minute Weekly Content Framework</h4>\n<table><tr><th>Week</th><th>Content Type</th><th>Topic for ${c.ind}</th><th>Platform</th></tr>\n<tr><td>1</td><td>[type]</td><td>[topic]</td><td>[platform]</td></tr>\n<tr><td>2</td><td>[type]</td><td>[topic]</td><td>[platform]</td></tr>\n<tr><td>3</td><td>[type]</td><td>[topic]</td><td>[platform]</td></tr>\n<tr><td>4</td><td>[type]</td><td>[topic]</td><td>[platform]</td></tr></table>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
    RET: `${base}\nWrite ONLY the [RET] section. Use this exact marker on the first line.\n\n[RET]\nWrite the customer retention section (~240 words) for ${c.biz}, a ${c.ind} business:\n<h4>Customer Lifetime Value Estimate</h4><p>${c.avgMid} × frequency × lifespan = ~$[CLV]. Bain & Company: 5% retention = 25-95% profit growth. Applied to ~${c.annCusts} customers.</p>\n<h4>The Retention Gap</h4><p>Estimated cost of gap. Why ${c.ind} customers stop returning.</p>\n<h4>3-Step Retention System for ${c.ind}</h4><p>Specific touchpoints, timing, channels.</p>\n<div class="script"><span class="slabel">30-Day Post-Job Check-In (Email — 70 words)</span><p>[Full email specific to ${c.ind}]</p></div>\n<div class="script"><span class="slabel">6-Month Re-Engagement (Text — under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
    REF: `${base}\nWrite ONLY the [REF] section. Use this exact marker on the first line.\n\n[REF]\nWrite the referral generation section (~230 words) for ${c.biz}, a ${c.ind} business:\n<h4>The Referral Math for ${c.ind}</h4><p>1.2 referrals × ${c.avgLo} × 55% = ~$[X] per customer. Texas Tech / Wharton: 16-25% higher LTV.</p>\n<h4>The Systematic Referral Process for ${c.ind}</h4><p>When, how, what to offer. 2-3 sentences.</p>\n<div class="script"><span class="slabel">Referral Ask Script (at job completion)</span><p>[Complete 75-word script]</p></div>\n<div class="script"><span class="slabel">Referral Thank-You (Text under 140 chars)</span><p>[Complete text]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
    PRICE: `${base}\nWrite ONLY the [PRICE] section. Use this exact marker on the first line.\n\n[PRICE]\nWrite the pricing power section (~250 words) for ${c.biz}, a ${c.ind} business:\n<h4>The Pricing Opportunity</h4><p>McKinsey: 1% price = ~11% profit. 6% on ${c.revLo} = approximately $[X]. How ${c.ind} tests increases.</p>\n<h4>The Price Increase Test Methodology</h4><p>Step-by-step safe 7-10% increase for ${c.ind}. 3-4 sentences.</p>\n<h4>Premium Tier Example for ${c.ind}</h4><p>Specific Good/Better/Best with prices and inclusions.</p>\n<div class="script"><span class="slabel">Price Increase Communication Script</span><p>[Complete 70-word script — confident, not apologetic]</p></div>\n<div class="script"><span class="slabel">Premium Tier Presentation Script</span><p>[Complete 70-word script — presents 3 options naturally]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
    REV: `${base}\nWrite ONLY the [REV] section. Use this exact marker on the first line.\n\n[REV]\nWrite the reviews and visibility section (~210 words) for ${c.biz}, a ${c.ind} business:\n<h4>The Review-to-Revenue Connection for ${c.ind}</h4><p>BrightLocal: 93% check reviews. Moz: ~15% of local search. Impact for ${c.ind} from 10 to 50 to 100+ reviews.</p>\n<h4>Systematic Review Request Process</h4><p>Exact timing, channel, message for ${c.ind}.</p>\n<div class="script"><span class="slabel">Review Request Text — 24-48 Hours After Completion</span><p>[Complete text under 140 chars with [your Google review link]]</p></div>\n<div class="script"><span class="slabel">Follow-Up If No Review — 5 Days Later</span><p>[Complete follow-up text under 140 chars]</p></div>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step]</li></ol></div>`,
    OPS: `${base}\nWrite ONLY the [OPS] section. Use this exact marker on the first line.\n\n[OPS]\nWrite the operations and quality section (~220 words) for ${c.biz}, a ${c.ind} business:\n<h4>The True Cost of Quality Issues in ${c.ind}</h4><p>4-6x transaction value per complaint. At ${c.avgLo} avg = approximately $[X] each. Annual impact.</p>\n<h4>The 3 Critical SOPs for ${c.ind}</h4><p>3 most impactful SOPs specific to ${c.ind}. For each: what it covers, key steps, what breaks without it.</p>\n<h4>Quality Control in Practice</h4><p>How top ${c.ind} businesses build checkpoints without overhead. Specific example.</p>\n<div class="action-box"><h5>4 Action Steps</h5><ol><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li><li>[step, time]</li></ol></div>`,
    PRIORITY: `${base}\nWrite ONLY the [PRIORITY] section. Use this exact marker on the first line.\n\n[PRIORITY]\nWrite the priority action matrix (~220 words) for ${c.biz}, a ${c.ind} business:\n<h4>Priority Rankings for ${c.biz}</h4>\n<table><tr><th>Rank</th><th>Category</th><th>Est. Opportunity</th><th>Conservative 90-Day Target</th><th>First Action This Week</th></tr>\n${c.L.cats.map((cat,i)=>`<tr><td><strong>#${i+1}</strong></td><td>${cat.n}</td><td>~$${cat.amt.toLocaleString()}</td><td>$${Math.round(cat.amt*0.15).toLocaleString()}–$${Math.round(cat.amt*0.25).toLocaleString()}</td><td>[1 specific action for ${c.ind}]</td></tr>`).join('')}\n</table>\n<p>2 paragraphs: why this sequencing maximizes early results for ${c.biz} in ${c.ind}.</p>`,
    PLAN: `${base}\nWrite ONLY the [PLAN] section. Use this exact marker on the first line.\n\n[PLAN]\nWrite the 90-day roadmap for ${c.biz}, a ${c.ind} business. Every task specific to ${c.ind}.\n<div class="pgrid">\n<div class="pcard"><div class="ptag">Week 1 — Days 1–7</div><div class="ptitle">Quick Wins</div>\n<div class="ptask">Day 1 (time): [specific ${c.ind} task]</div>\n<div class="ptask">Day 2 (time): [specific task]</div>\n<div class="ptask">Day 3 (time): [specific task]</div>\n<div class="ptask">Day 4 (time): [specific task]</div>\n<div class="ptask">Day 5 (time): [specific task]</div>\n<div class="ptask">Days 6–7 (time): [specific task]</div>\n<div class="pmile">Day 30 milestone: [3-4 measurable outcomes]</div>\n</div>\n<div class="pcard"><div class="ptag">Week 2 — Days 8–14</div><div class="ptitle">Foundation</div>\n<div class="ptask">(time): [task]</div><div class="ptask">(time): [task]</div>\n<div class="ptask">(time): [task]</div><div class="ptask">(time): [task]</div>\n<div class="ptask">(time): [task]</div>\n<div class="pmile">Day 60 milestone: [specific outcomes]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 2 — Days 31–60</div><div class="ptitle">Momentum</div>\n<div class="ptask">[task]</div><div class="ptask">[task]</div><div class="ptask">[task]</div>\n<div class="ptask">[task]</div><div class="ptask">[task]</div>\n</div>\n<div class="pcard"><div class="ptag">Month 3 — Days 61–90</div><div class="ptitle">Systematize</div>\n<div class="ptask">[task]</div><div class="ptask">[task]</div><div class="ptask">[task]</div>\n<div class="ptask">[task]</div><div class="ptask">[task]</div>\n<div class="pmile">Day 90 milestone: [measurable metrics for ${c.ind}]</div>\n</div>\n</div>`,
    ROI: `${base}\nWrite ONLY the [ROI] section. Use this exact marker on the first line.\n\n[ROI]\nWrite the revenue recovery projection (~220 words) for ${c.biz}, a ${c.ind} business:\n<h4>Conservative Recovery Projection</h4>\n<table>\n<tr><th>Scenario</th><th>Recovery Rate</th><th>Month 1 Est.</th><th>Month 2 Est.</th><th>Month 3 Est.</th><th>90-Day Total</th></tr>\n<tr><td>Conservative</td><td>15%</td><td>~$${Math.round(c.L.total*0.15*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15*0.50).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.15).toLocaleString()}</td></tr>\n<tr><td>Realistic</td><td>22%</td><td>~$${Math.round(c.L.total*0.22*0.20).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22*0.55).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.22).toLocaleString()}</td></tr>\n<tr><td>Optimistic</td><td>32%</td><td>~$${Math.round(c.L.total*0.32*0.25).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32*0.60).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td><td>~$${Math.round(c.L.total*0.32).toLocaleString()}</td></tr>\n</table>\n<p>Explain what drives each scenario. Be honest that results vary.</p>\n<h4>Report ROI</h4>\n<p>Realistic: ~$${Math.round(c.L.total*0.22).toLocaleString()} in 90 days on $297 = approximately ${Math.round(c.L.total*0.22/297)}x return. Converting just ${Math.ceil(297/c.L.meta.avgLo)} dormant leads covers the report cost.</p>\n<div class="disclaimer">All projections are estimates. Results depend on implementation, market, and your specific situation.</div>\n<h4>Your Single Most Important Action in the Next 48 Hours</h4>\n<p>[Single most impactful specific action for ${c.biz} in ${c.ind}. Why highest-leverage. Exact steps today. 80-100 words.]</p>`,
  };
  return prompts[key] || `${base}\nWrite the [${key}] section for ${c.biz}, a ${c.ind} business. Use [${key}] as the first line marker.`;
}
 
function buildEmailHtml(bizName, industry, calcData, sections) {
  const L = calcData;
  const sectionKeys = ['EXEC','CONV','DEAD','MKTG','RET','REF','PRICE','REV','OPS','PRIORITY','PLAN','ROI'];
  const sectionTitles = {
    EXEC:'Executive Summary', CONV:'Lead Conversion & Sales', DEAD:'Dead & Dormant Leads',
    MKTG:'Marketing Efficiency', RET:'Customer Retention', REF:'Referral Generation',
    PRICE:'Pricing Power', REV:'Reviews & Visibility', OPS:'Operations & Quality',
    PRIORITY:'Priority Action Matrix', PLAN:'90-Day Recovery Roadmap', ROI:'Revenue Recovery Projection'
  };
  let sectionsHtml = '';
  sectionKeys.forEach((k, i) => {
    if (!sections[k]) return;
    const catMatch = L.cats.find(c => {
      if(k==='CONV') return c.n.includes('conversion');
      if(k==='DEAD') return c.n.includes('dormant');
      if(k==='MKTG') return c.n.includes('Marketing');
      if(k==='RET') return c.n.includes('retention');
      if(k==='REF') return c.n.includes('Referral');
      if(k==='PRICE') return c.n.includes('Pricing');
      if(k==='REV') return c.n.includes('Reviews');
      if(k==='OPS') return c.n.includes('Operations');
      return false;
    });
    sectionsHtml += `<div style="margin-bottom:32px;border:1px solid #e4e8f0;border-radius:10px;overflow:hidden;"><div style="background:#f8f9fc;padding:16px 24px;border-bottom:1px solid #e4e8f0;display:flex;align-items:center;justify-content:space-between;"><span style="font-family:'Georgia',serif;font-size:15px;font-weight:700;color:#0f1f3d;">${String(i+1).padStart(2,'0')} — ${sectionTitles[k]}</span>${catMatch?`<span style="font-family:'Georgia',serif;font-size:14px;font-weight:700;color:#dc2626;">~$${catMatch.amt.toLocaleString()}/yr</span>`:''}</div><div style="padding:24px;font-size:14px;line-height:1.8;color:#5a6478;">${sections[k]}</div></div>`;
  });
  const date = new Date().toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#eef0f5;font-family:Helvetica,Arial,sans-serif"><div style="max-width:800px;margin:0 auto;padding:32px 16px;"><div style="background:#0f1f3d;border-radius:12px;padding:40px;margin-bottom:24px;color:white;"><div style="font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#6ea8fe;margin-bottom:12px;">CONFIDENTIAL · REVENUE RECOVERY REPORT</div><div style="font-family:'Georgia',serif;font-size:36px;font-weight:800;line-height:1.1;margin-bottom:12px;">Estimated Revenue Opportunity:<br><span style="color:#ff6b6b;">~$${L.total.toLocaleString()}</span></div><div style="font-size:14px;color:rgba(255,255,255,.6);margin-bottom:4px;">Conservative range: $${L.totalLo.toLocaleString()} – $${L.totalHi.toLocaleString()}</div><div style="font-size:13px;color:rgba(255,255,255,.4);">${bizName} · ${industry} · ${date}</div><div style="margin-top:16px;background:rgba(255,255,255,.08);border-radius:8px;padding:12px 16px;font-size:12px;color:rgba(255,255,255,.5);">Conservative estimates based on your diagnostic. PDF attached.</div></div><div style="background:white;border-radius:10px;padding:20px 24px;margin-bottom:24px;border:1px solid #e4e8f0;"><div style="display:flex;gap:20px;flex-wrap:wrap;"><div style="flex:1;min-width:120px;text-align:center;"><div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#ff6b6b;">~$${L.total.toLocaleString()}</div><div style="font-size:11px;color:#8d97aa;text-transform:uppercase;">Est. annual opportunity</div></div><div style="flex:1;min-width:120px;text-align:center;"><div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#6ea8fe;">~$${L.cats[0].amt.toLocaleString()}</div><div style="font-size:11px;color:#8d97aa;text-transform:uppercase;">Biggest opportunity</div></div><div style="flex:1;min-width:120px;text-align:center;"><div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#4ade80;">~$${Math.round(L.total*0.22).toLocaleString()}</div><div style="font-size:11px;color:#8d97aa;text-transform:uppercase;">Realistic 90-day target</div></div><div style="flex:1;min-width:120px;text-align:center;"><div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:#6ea8fe;">${Math.round(L.total*0.22/297)}x</div><div style="font-size:11px;color:#8d97aa;text-transform:uppercase;">Est. report ROI</div></div></div></div>${sectionsHtml}<div style="background:#0f1f3d;border-radius:12px;padding:32px;text-align:center;margin-top:24px;"><div style="font-family:'Georgia',serif;font-size:22px;font-weight:700;color:white;margin-bottom:8px;">Your report is complete</div><div style="font-size:14px;color:rgba(255,255,255,.5);margin-bottom:4px;">Generated by RevAnalysis · ${date}</div><div style="font-size:12px;color:rgba(255,255,255,.35);">All figures are conservative estimates. PDF copy attached.</div></div></div></body></html>`;
}
 
// ══════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`RevAnalysis worker running on port ${PORT}`);
});