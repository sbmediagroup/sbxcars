require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
// Basic rate limiter for form endpoints
const rateLimit = require('express-rate-limit');
const sellLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.SELL_RATE_LIMIT || 10), // limit each IP
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.'
});

const PORT = process.env.PORT || 3001;
const TO_EMAIL = process.env.TO_EMAIL || 'chido.ukaigwe@sbmediagroup.com';

// Serve static site from project root (one level up)
const staticDir = path.join(__dirname, '..');

// In-memory recent reCAPTCHA verification log (dev/debug only). Keeps small bounded list.
const recaptchaLog = [];
function recordRecaptcha(verifResponse, ip, type, reason){
  try{
    const entry = {
      ts: new Date().toISOString(),
      ip: ip || null,
      type: type || null, // 'v3' or 'v2'
      reason: reason || null,
      response: verifResponse || null
    };
    recaptchaLog.push(entry);
    // keep last 200 entries
    if(recaptchaLog.length > 200) recaptchaLog.shift();
    // prune entries older than 24h occasionally
    if(recaptchaLog.length > 0 && recaptchaLog.length % 50 === 0){
      const cutoff = Date.now() - (24*60*60*1000);
      while(recaptchaLog.length && new Date(recaptchaLog[0].ts).getTime() < cutoff) recaptchaLog.shift();
    }
  }catch(e){ /* ignore logging errors */ }
}

// In-memory failure tracking and blocking per IP
const failMap = new Map();
const BLOCK_THRESHOLD = Number(process.env.SELL_BLOCK_THRESHOLD || 6); // failures before block
const BLOCK_WINDOW_MS = Number(process.env.SELL_BLOCK_WINDOW_MINUTES || 60) * 60 * 1000; // window to count failures
const BLOCK_DURATION_MS = Number(process.env.SELL_BLOCK_DURATION_MINUTES || 60) * 60 * 1000; // block time

function recordFailure(ip, info){
  try{
    const now = Date.now();
    const entry = failMap.get(ip) || {count:0, firstTs: now, blockedUntil: 0};
    // if window expired, reset
    if(now - entry.firstTs > BLOCK_WINDOW_MS){
      entry.count = 0;
      entry.firstTs = now;
    }
    entry.count += 1;
    // block if threshold exceeded
    if(entry.count >= BLOCK_THRESHOLD){
      entry.blockedUntil = now + BLOCK_DURATION_MS;
      console.warn('Blocking IP for recaptcha failures', ip, 'until', new Date(entry.blockedUntil).toISOString());
      // also record a recaptcha log entry for the block event
      recordRecaptcha({blockedUntil: entry.blockedUntil, count: entry.count}, ip, 'block', info || 'threshold');
    }
    failMap.set(ip, entry);
    return entry;
  }catch(e){ return null; }
}

function clearFailures(ip){
  try{ failMap.delete(ip); }catch(e){}
}

function isBlocked(ip){
  try{
    const entry = failMap.get(ip);
    if(!entry) return false;
    if(entry.blockedUntil && Date.now() < entry.blockedUntil) return true;
    return false;
  }catch(e){ return false; }
}


// Simple HTML escaper to prevent injection in email bodies
function escapeHtml(input){
  if(input === undefined || input === null) return '';
  return String(input).replace(/[&<>"']/g, function(s){
    switch(s){
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return s;
    }
  });
}


let transporter = null;
let smtpAvailable = false;
if(process.env.SMTP_HOST && process.env.SMTP_USER){
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  transporter.verify()
    .then(()=>{
      smtpAvailable = true;
      console.log('SMTP transporter ready');
    })
    .catch(err=>{
      smtpAvailable = false;
      console.warn('SMTP verify failed — SMTP disabled', err && err.message ? err.message : err);
    });
} else {
  console.log('No SMTP config found — nodemailer disabled.');
}

// AWS SES SDK support (preferred). Use USE_AWS_SDK=true to enable.
let useAwsSdk = process.env.USE_AWS_SDK === 'true' || false;
let awsRegion = process.env.AWS_REGION || 'us-east-1';
let ses = null;
let awsConfigured = false;

// Prefer flexible credential resolution for AWS SDK: try explicit file/env first, but
// allow the AWS SDK default provider chain (shared credentials, environment, EC2/ECS roles).
try{
  const credPath = path.join(__dirname, 'aws-credentials.json');
  if(fs.existsSync(credPath)){
    const creds = JSON.parse(fs.readFileSync(credPath,'utf8'));
    if(creds.aws_access_key_id && creds.aws_secret_access_key){
      AWS.config.update({accessKeyId:creds.aws_access_key_id,secretAccessKey:creds.aws_secret_access_key,region:awsRegion});
      console.log('Loaded AWS credentials from server/aws-credentials.json');
    }
  }
}catch(err){
  console.warn('Failed to read aws-credentials.json',err && err.message ? err.message : err);
}

// If explicit env vars exist, set them (AWS SDK will also pick these up automatically)
if(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY){
  AWS.config.update({accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY,region:awsRegion});
  console.log('Loaded AWS credentials from environment variables');
}

// Initialize SES client if SDK path is desired. AWS SDK will use default provider chain
// if no explicit credentials were provided above (e.g., shared credentials or role).
if(useAwsSdk){
  try{
    ses = new AWS.SES({apiVersion: '2010-12-01', region: awsRegion});
    // quick check to validate credentials and SES access
    ses.getSendQuota().promise().then(()=>{
      awsConfigured = true;
      console.log('AWS SES SDK available and credentials validated');
    }).catch(err=>{
      awsConfigured = false;
      console.warn('AWS SES check failed — SES disabled', err && err.message ? err.message : err);
    });
  }catch(err){
    awsConfigured = false;
    console.warn('Failed to initialize AWS SES SDK', err && err.message ? err.message : err);
  }
} else {
  console.log('AWS SDK SES path not enabled (USE_AWS_SDK=false)');
}

app.post('/api/sell', async (req, res) => {
  // apply rate limiter
  await new Promise((resolve, reject)=> sellLimiter(req, res, (err)=> err ? reject(err) : resolve()));

  // Check IP blocking for repeated failed recaptcha tokens
  const clientIp = req.ip || req.connection && req.connection.remoteAddress || 'unknown';
  if(isBlocked(clientIp)){
    const entry = failMap.get(clientIp) || {};
    const retryAfter = entry.blockedUntil ? Math.ceil((entry.blockedUntil - Date.now())/1000) : 60;
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({error:'blocked', retryAfter});
  }
  const body = req.body || {};
  const fields = {
    transactionType: body.transactionType || '',
    year: body.year || '', make: body.make || '', model: body.model || '', mileage: body.mileage || '',
    location: body.location || '',
    vin: body.vin || '', currency: body.currency || '$', expectedPrice: body.expectedPrice || '',
    fullName: body.fullName || '', email: body.email || ''
  };
  // Honeypot anti-spam: hidden field `hp_name` should be empty
  if((body.hp_name || '').trim() !== ''){
    console.warn('Honeypot triggered from', req.ip);
    return res.status(400).send('Spam detected');
  }
  // Basic validation
  // Require the newly-added fields as well: transactionType and location
  // Simple server-side sanitization/validation
  const errs = [];
  if(!fields.transactionType || !/^(buy|sell)$/i.test(fields.transactionType)) errs.push('transactionType');
  if(!fields.year || !/^[0-9]{2,4}$/.test(fields.year)) errs.push('year');
  if(!fields.make) errs.push('make');
  if(!fields.model) errs.push('model');
  if(!fields.location) errs.push('location');
  if(!fields.expectedPrice || String(fields.expectedPrice).trim() === '') errs.push('expectedPrice');
  if(!fields.fullName) errs.push('fullName');
  if(!fields.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email)) errs.push('email');
  if(errs.length) return res.status(400).send('Missing or invalid fields: '+errs.join(', '));

  // Optional reCAPTCHA verification: support v3 (score) and v2 (challenge) with v3-first + v2-fallback
  // Accept either RECAPTCHA_SECRET or RECAPTCHA_SECRET_KEY from env
  const recaptchaSecretEnv = process.env.RECAPTCHA_SECRET || process.env.RECAPTCHA_SECRET_KEY || '';
  if(recaptchaSecretEnv){
    const recaptchaSecret = recaptchaSecretEnv;
    // If v3 token provided, verify it first
    if(body.recaptchaToken){
      try{
        const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'},
          body: `secret=${encodeURIComponent(recaptchaSecret)}&response=${encodeURIComponent(body.recaptchaToken)}`
        });
        const j = await verifyRes.json();
        // record full verification response for debugging
        recordRecaptcha(j, req.ip, 'v3', j && j.success ? 'success' : 'v3-failed-or-low-score');
        if(!j.success){
          console.warn('reCAPTCHA v3 failed', req.ip, j);
          // record failure and potentially block
          recordFailure(req.ip, 'v3-failed');
          return res.status(428).json({error:'require-v2', reason:'v3-failed'});
        }
        if(typeof j.score === 'number' && Number(process.env.RECAPTCHA_SCORE_THRESHOLD || 0.5) > j.score){
          console.warn('reCAPTCHA v3 low score', j.score, 'from', req.ip, j);
          // record low score reason and increment failure counter
          recordRecaptcha(j, req.ip, 'v3', 'low-score');
          recordFailure(req.ip, 'v3-low-score');
          return res.status(428).json({error:'require-v2', reason:'low-score', score: j.score});
        }
        // v3 success & acceptable score -> continue
      }catch(err){
        console.warn('reCAPTCHA v3 verify error',err && err.message ? err.message : err);
        return res.status(428).json({error:'require-v2', reason:'verify-error'});
      }
    } else if(body.recaptchaV2Token){
      // verify v2 token (user completed challenge)
      try{
        const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'},
          body: `secret=${encodeURIComponent(recaptchaSecret)}&response=${encodeURIComponent(body.recaptchaV2Token)}`
        });
        const j = await verifyRes.json();
        // record v2 verification response
        recordRecaptcha(j, req.ip, 'v2', j && j.success ? 'success' : 'v2-failed');
        if(!j.success){
          console.warn('reCAPTCHA v2 failed', req.ip, j);
          return res.status(400).send('reCAPTCHA verification failed');
        }
        // v2 success -> continue
      }catch(err){
        console.warn('reCAPTCHA v2 verify error', err && err.message ? err.message : err);
        return res.status(500).send('reCAPTCHA verification error');
      }
    } else {
      // No token provided
      return res.status(400).send('reCAPTCHA token required');
    }
  }

  // Escape fields when constructing subject/body
  const safeMake = escapeHtml(fields.make);
  const safeModel = escapeHtml(fields.model);
  const safeYear = escapeHtml(fields.year);
  const subject = `${fields.transactionType ? fields.transactionType.toUpperCase() + ' - ' : ''}New Submission — ${safeMake} ${safeModel} (${safeYear})`;
  const text = Object.keys(fields).map(k=>`${k}: ${fields[k]}`).join('\n');
  const html = `<h2>New Submission</h2><p><strong>Details</strong></p><ul>${Object.keys(fields).map(k=>`<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(fields[k])}</li>`).join('')}</ul>`;

  // If AWS SDK is configured and enabled, use SES SDK to send
  if(useAwsSdk && awsConfigured && ses){
    const params = {
      Source: process.env.SMTP_FROM || process.env.SMTP_USER || `no-reply@${process.env.TO_EMAIL?.split('@')[1] || 'example.com'}`,
      Destination: { ToAddresses: [TO_EMAIL] },
      ReplyToAddresses: [ fields.email || process.env.SMTP_FROM || process.env.SMTP_USER ],
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: html }, Text: { Data: text } }
      }
    };
    try{
      await ses.sendEmail(params).promise();
      return res.status(200).json({ok:true,via:'ses-sdk'});
    }catch(err){
      console.error('SES sendEmail error',err);
      return res.status(500).send('SES send failed');
    }
  }

  // If nodemailer transporter is available and verified, use SMTP path
  if(transporter && transporter.sendMail && smtpAvailable){
    try{
      await transporter.sendMail({from: process.env.SMTP_FROM || process.env.SMTP_USER, to: TO_EMAIL, subject, text, html, replyTo: fields.email || process.env.SMTP_FROM});
      return res.status(200).json({ok:true,via:'smtp'});
    }catch(err){
      console.error('sendMail error',err);
      return res.status(500).send('Email send failed');
    }
  }

  // No email provider available — do NOT silently succeed. Return 5xx so caller knows.
  console.error('No email provider configured: neither AWS SES nor SMTP available');
  console.error('Sell submission content:', text);
  return res.status(500).send('No email provider configured');
});

// Contact form endpoint removed — not required for current site.

// Serve static files with HTML extension fallback so clean URLs like '/contact' work
app.use(express.static(staticDir, { extensions: ['html'] }));

// Health endpoint for deployments to check SES/SMTP readiness
// Liveness endpoint: simple 200 so load balancers know the process is alive
app.get('/server/alive', (req, res) => res.status(200).json({ alive: true, timestamp: new Date().toISOString() }));

// Readiness endpoint: reports SES/SMTP readiness for deploy platform readiness checks
app.get('/server/ready', (req, res) => {
  const status = {
    uptime: process.uptime(),
    awsSdkEnabled: useAwsSdk,
    awsConfigured: !!awsConfigured,
    smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
    smtpAvailable: !!smtpAvailable,
    verifiedSender: !!(process.env.SMTP_FROM || process.env.SMTP_USER),
    toEmail: TO_EMAIL || null,
    timestamp: new Date().toISOString()
  };

  const healthy = (useAwsSdk && awsConfigured) || smtpAvailable;
  return res.status(healthy ? 200 : 503).json({ healthy, details: status });
});

// Backwards-compatibility: keep /server/health as an alias to /server/ready
app.get('/server/health', (req, res) => res.redirect(307, '/server/ready'));

// Fallback to index.html so single-page navigation still works
// Expose a small client config script so the static page can read site key from env
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type','application/javascript');
  const siteKey = process.env.RECAPTCHA_SITE_KEY || '';
  res.send(`window.RECAPTCHA_SITE_KEY = ${JSON.stringify(siteKey)};`);
});

// Dev-only: return whether server has secret and recent recaptcha log (safe only on localhost)
app.get('/debug-recaptcha', (req, res) => {
  const allowedHost = req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.ip === '::1' || req.ip === '127.0.0.1';
  if(!allowedHost){
    return res.status(404).send('Not found');
  }
  const secretPresent = !!(process.env.RECAPTCHA_SECRET || process.env.RECAPTCHA_SECRET_KEY);
  const threshold = Number(process.env.RECAPTCHA_SCORE_THRESHOLD || 0.5);
  return res.json({ secretPresent, threshold, recent: recaptchaLog.slice(-50) });
});

// Fallback to index.html so single-page navigation still works
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(PORT, ()=>console.log(`Form server listening on ${PORT}`));
