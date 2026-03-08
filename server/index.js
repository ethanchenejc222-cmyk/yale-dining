const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// ── Disk cache helpers ────────────────────────────────────────────────────────
const CACHE_DIR = process.env.CACHE_DIR || '/tmp/yale-dining-cache';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const cacheFile = (...p) => path.join(CACHE_DIR, p.join('_').replace(/[^a-z0-9_\-]/gi,'-')+'.json');
const readCache = f => { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return null; } };
const writeCache = (f,d) => { try { fs.writeFileSync(f,JSON.stringify(d)); } catch(e){console.warn('cache:',e.message);} };

// biweek key: year + 2-week block (so changes at most every 14 days)
const biweekKey = (d=new Date()) => {
  const start = new Date(d.getFullYear(),0,1);
  return `${d.getFullYear()}-BW${Math.floor((d-start)/86400000/14)}`;
};

const FETCH_HDR = {
  'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language':'en-US,en;q=0.9',
};

// ── Nutrislice proxy – daily disk cache ───────────────────────────────────────
const NS_BASE = 'https://yalehospitality.api.nutrislice.com';

app.get('/api/menu/:hall/:mealType/:year/:month/:day', async (req,res) => {
  const {hall,mealType,year,month,day} = req.params;
  const dateStr = `${year}-${month}-${day}`;
  const f = cacheFile('ns',hall,mealType,dateStr);
  const cached = readCache(f);
  if (cached?.cachedDate === dateStr) return res.json(cached.data);
  const url = `${NS_BASE}/menu/api/weeks/school/${hall}/menu-type/${mealType}/${year}/${month}/${day}/`;
  try {
    const r = await fetch(url,{headers:{'Accept':'application/json','User-Agent':'Mozilla/5.0'}});
    if (!r.ok) return res.status(r.status).json({error:`NS ${r.status}`});
    const data = await r.json();
    writeCache(f,{cachedDate:dateStr,data});
    res.json(data);
  } catch(err) {
    if (cached) return res.json(cached.data);
    res.status(500).json({error:err.message});
  }
});

// ── When & Where – biweekly disk cache ───────────────────────────────────────
// Returns: { entries[], closedToday[], specialEvents[], scrapedAt }
// entries: { dateRange, text, start, end }
// closedToday: slugs of halls closed today
// specialEvents: { date, text, hallSlugs[] } — brinner, holiday dinners, etc.

const HALL_KW = {
  'benjamin-franklin-college': ['franklin'],
  'berkeley-college':          ['berkeley'],
  'branford-college':          ['branford'],
  'davenport-college':         ['davenport'],
  'ezra-stiles-college':       ['stiles','ezra stiles','ezra'],
  'hopper-college':            ['hopper','grace hopper'],
  'jonathan-edwards-college':  ['jonathan edwards','j.e.','j. e.'],
  'morse-college':             ['morse'],
  'pauli-murray-college':      ['murray','pauli murray'],
  'pierson-college':           ['pierson'],
  'saybrook-college':          ['saybrook'],
  'silliman-college':          ['silliman'],
  'timothy-dwight-college':    ['timothy dwight','t.d.','t. d.'],
  'trumbull-college':          ['trumbull'],
};
const ALL_SLUGS = Object.keys(HALL_KW);

function parseEventDate(s,baseYear=new Date().getFullYear()){
  const p = s.trim().split('/');
  if (p.length < 2) return null;
  const m=parseInt(p[0]),d=parseInt(p[1]);
  const y=p[2]?parseInt(p[2])+(parseInt(p[2])<100?2000:0):baseYear;
  // Use UTC noon to avoid timezone off-by-one: a date stored as UTC midnight
  // can appear as the previous day in EST clients. Noon UTC is safe for all timezones.
  const dt=new Date(Date.UTC(y,m-1,d,12,0,0));
  // If date looks like it's in the past more than 6 months, try next year
  const now=new Date();
  if (dt<now && (now-dt)>180*86400000) dt.setUTCFullYear(dt.getUTCFullYear()+1);
  return dt;
}

app.get('/api/closures', async (req,res) => {
  const bw = biweekKey()+'v4';
  const f = cacheFile('closures',bw);
  const cached = readCache(f);
  if (cached?.bw === bw) return res.json(cached.data);

  try {
    const r = await fetch('https://hospitality.yale.edu/when-where',{headers:FETCH_HDR});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    // The page renders entries as plain text after stripping HTML.
    // Pattern: **3/7 - 3/8 |** text   OR   **3/25 |** text
    // In raw HTML these appear as <strong>3/7 - 3/8 |</strong> text
    // We strip HTML tags first for easier parsing.
    const plain = html
      .replace(/<strong>/gi,'**').replace(/<\/strong>/gi,'**')
      .replace(/<[^>]+>/g,' ')
      .replace(/&amp;/g,'&').replace(/&ndash;/g,'–').replace(/&mdash;/g,'—')
      .replace(/&#\d+;/g,' ').replace(/&[a-z]+;/g,' ');

    const entries = [];
    // Match **dateRange |** text lines
    const re = /\*\*([\d\/\s\-–]+)\|?\*\*\s*([^\n*]{5,})/g;
    let m;
    while ((m=re.exec(plain))!==null) {
      const rawRange = m[1].trim().replace(/\|/,'').trim();
      const text = m[2].trim().replace(/\s+/g,' ');
      if (!rawRange || !text) continue;

      const rangeParts = rawRange.split(/\s*[-–]\s*/);
      const start = parseEventDate(rangeParts[0]);
      const end   = rangeParts[1] ? parseEventDate(rangeParts[1]) : start;
      if (!start||!end) continue;
      // Normalize to UTC noon (already set by parseEventDate, but enforce for safety)
      start.setUTCHours(12,0,0,0); end.setUTCHours(12,0,0,0);
      entries.push({ dateRange:rawRange, text, start:start.getTime(), end:end.getTime() });
    }

    const now = new Date(); now.setHours(0,0,0,0);
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);

    // Determine which halls are CLOSED today
    // Real patterns from Yale Hospitality:
    //  A) "Berkely open for...; Morse open for...; all other residential dining halls closed"
    //  B) "All residential dining halls closed except for Hopper is open for continental breakfast"
    //  C) "Davenport closed, Franklin closed, Murray closed, Pierson closed, Timothy Dwight closed"
    //  D) "All residential dining halls resume regular hours" (no closure)

    const closedToday = new Set();
    let allResClosed = false;
    const openExceptions = new Set();

    for (const e of entries) {
      const start=new Date(e.start), end=new Date(e.end);
      if (now<start||now>end) continue;
      const t = e.text.toLowerCase();

      // Split on semicolons and commas to get individual clauses
      const clauses = t.split(/[;,]+/).map(s=>s.trim()).filter(Boolean);

      // Check if any clause says "all other / all residential ... closed"
      const hasAllOtherClosed = clauses.some(c=>
        (c.includes('all other') || c.includes('all residential') || c.includes('all college') || c.includes('all dining'))
        && c.includes('closed')
      );
      // Check if any clause says "all ... resume" (explicitly open)
      const hasAllResume = clauses.some(c=>
        (c.includes('all residential') || c.includes('all college'))
        && (c.includes('resume') || c.includes('regular hours') || c.includes('routine hours'))
      );

      if (hasAllResume) {
        // This day explicitly resumes — clear any closed status, no action
        continue;
      }

      if (hasAllOtherClosed) {
        allResClosed = true;
        // Every clause that mentions a hall name WITHOUT "closed" = open exception
        for (const clause of clauses) {
          if (clause.includes('closed') && (clause.includes('all other') || clause.includes('all residential'))) continue;
          if (clause.includes('open') || (!clause.includes('closed'))) {
            for (const [slug,kws] of Object.entries(HALL_KW)) {
              if (kws.some(kw=>clause.includes(kw))) {
                openExceptions.add(slug);
              }
            }
          }
        }
        // Also handle "except" pattern: "all closed except Hopper"
        const exceptIdx = t.indexOf('except');
        if (exceptIdx !== -1) {
          const afterExcept = t.slice(exceptIdx);
          for (const [slug,kws] of Object.entries(HALL_KW)) {
            if (kws.some(kw=>afterExcept.includes(kw))) openExceptions.add(slug);
          }
        }
      } else {
        // No "all other closed" — parse individual hall clauses
        for (const clause of clauses) {
          const isClosed = clause.includes('closed');
          const isOpen = clause.includes('open') || clause.includes('resume');
          if (!isClosed && !isOpen) continue;
          for (const [slug,kws] of Object.entries(HALL_KW)) {
            if (kws.some(kw=>clause.includes(kw))) {
              if (isClosed && !isOpen) closedToday.add(slug);
              // if both mentioned (e.g. "X closed, Y open"), isOpen wins for openExceptions
            }
          }
        }
      }
    }

    // Apply allResClosed: everyone not in openExceptions is closed
    if (allResClosed) {
      for (const slug of ALL_SLUGS) {
        if (!openExceptions.has(slug)) closedToday.add(slug);
      }
      // Remove open exceptions from closed set (safety)
      for (const slug of openExceptions) closedToday.delete(slug);
    }

    const openSlugs = [...openExceptions];

    // Detect special dining events (brinner, holiday dinner, global table, etc.)
    const EVENT_KW = ['brinner','holiday','global table','mena dinner','tasting','chef in residence','dinner in'];
    const specialEvents = [];
    for (const e of entries) {
      const t = e.text.toLowerCase();
      if (!EVENT_KW.some(kw=>t.includes(kw))) continue;
      const hallSlugs = [];
      for (const [slug,kws] of Object.entries(HALL_KW)) {
        if (kws.some(kw=>t.includes(kw))) hallSlugs.push(slug);
      }
      specialEvents.push({ dateRange:e.dateRange, text:e.text, start:e.start, end:e.end, hallSlugs });
    }

    // Filter entries to ±21 days for announcements
    const cutoff = new Date(now); cutoff.setDate(now.getDate()+21);
    const relevant = entries.filter(e => new Date(e.end)>=now && new Date(e.start)<=cutoff);

    const data = {
      announcements: relevant,
      closedToday: [...closedToday],
      openSlugs,           // halls confirmed open even on all-closed days
      allResClosed,
      specialEvents,
      scrapedAt: new Date().toISOString(),
    };
    writeCache(f,{bw,data});
    res.json(data);
  } catch(err) {
    if (cached) return res.json(cached.data);
    console.error('closures error:',err.message);
    res.status(500).json({error:err.message,announcements:[],closedToday:[],specialEvents:[]});
  }
});

// ── Slifka – weekly cache + image proxy ──────────────────────────────────────
const isoWeek = (d=new Date()) => {
  const dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  dt.setUTCDate(dt.getUTCDate()+4-(dt.getUTCDay()||7));
  const y=dt.getUTCFullYear();
  const w=Math.ceil((((dt-new Date(Date.UTC(y,0,1)))/86400000)+1)/7);
  return `${y}-W${String(w).padStart(2,'0')}`;
};

app.get('/api/slifka', async (req,res) => {
  const week=isoWeek()+'v2'; // v2 = new format with type field
  const f=cacheFile('slifka',week);
  const cached=readCache(f);
  if (cached?.week===week) return res.json(cached.data);
  const dbg=[];
  try {
    dbg.push('fetching slifkacenter.org/menu/');
    const r=await fetch('https://slifkacenter.org/menu/',{headers:{...FETCH_HDR,Referer:'https://slifkacenter.org/'}});
    dbg.push(`status ${r.status}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html=await r.text();
    dbg.push(`html ${html.length} chars`);

    const titleMatch=html.match(/Menu for ([^<\n]+)/i);
    const title=titleMatch?titleMatch[1].trim():'';

    // Extract menu images only — skip logos (filename contains "logo" or "Slifka-Center-logo")
    // We want <a href="URL"><img src="..." title="TITLE"></a> blocks
    // Grab href+title pairs from the clickable image blocks
    const menuImgs = []; // [{url, title, type}]
    const seen=new Set();

    // Pattern: <a href="URL.png"><img ... title="TITLE" ...></a>  (or title before src)
    const blockRe = /<a[^>]+href="(https?:\/\/slifkacenter\.org\/wp-content\/uploads\/[^"]+\.(?:png|jpg|jpeg|webp))"[^>]*>[\s\S]*?<img[^>]+title="([^"]*)"[^>]*>/gi;
    let m;
    while((m=blockRe.exec(html))!==null){
      const url=m[1], imgTitle=m[2];
      if(url.toLowerCase().includes('logo')) continue;
      if(seen.has(url)) continue;
      seen.add(url);
      // Classify by title text
      const t=imgTitle.toLowerCase();
      let type='other';
      if(t.includes('weekend')||t.includes('shabbat')) type='weekend';
      else if(t.includes('lunch')) type='lunch';
      else if(t.includes('dinner')) type='dinner';
      menuImgs.push({url,title:imgTitle,type});
    }
    dbg.push(`menu imgs from blocks: ${menuImgs.length}`);

    // Fallback: grab hrefs to uploads that aren't logos, not thumbnails
    if(menuImgs.length===0){
      const hrefRe=/href="(https?:\/\/slifkacenter\.org\/wp-content\/uploads\/(?!.*logo)[^"]+\.(?:png|jpg|jpeg|webp))"/gi;
      while((m=hrefRe.exec(html))!==null){
        const url=m[1];
        if(seen.has(url)||url.toLowerCase().includes('logo')) continue;
        seen.add(url);
        const fn=url.split('/').pop().toLowerCase();
        let type='other';
        if(fn.includes('weekend')||fn.includes('shabbat')) type='weekend';
        else if(fn.includes('lunch')) type='lunch';
        else if(fn.includes('dinner')) type='dinner';
        menuImgs.push({url,title:'',type});
      }
      dbg.push(`fallback href imgs: ${menuImgs.length}`);
    }

    const data={title,images:menuImgs,debug:dbg};
    writeCache(f,{week,data});
    res.json(data);
  } catch(err) {
    dbg.push(`error: ${err.message}`);
    if (cached) return res.json({...cached.data,debug:dbg,stale:true});
    res.status(500).json({error:err.message,debug:dbg,images:[]});
  }
});

app.get('/api/slifka-image', async (req,res) => {
  const {url}=req.query;
  if (!url||!url.startsWith('https://slifkacenter.org/')) return res.status(400).send('bad url');
  try {
    const r=await fetch(url,{headers:FETCH_HDR});
    if (!r.ok) return res.status(r.status).send('upstream error');
    res.setHeader('Content-Type',r.headers.get('content-type')||'image/jpeg');
    res.setHeader('Cache-Control','public,max-age=604800');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch(err){res.status(500).send(err.message);}
});

// ── Venue menus – biweekly cache ──────────────────────────────────────────────
const VENUES = {
  commons:{url:'https://hospitality.yale.edu/restaurants-cafes-more/schwarzman-center/commons',name:'Commons',hours:'Mon–Thu 11:00 AM–3:00 PM',description:'Rooted · Pasta e Basta · Rostir · Lotus',concepts:['Rooted','Pasta e Basta','Rostir','Lotus']},
  elm:    {url:'https://hospitality.yale.edu/restaurants-cafes-more/schwarzman-center/elm',    name:'Elm',   hours:'Mon–Fri 8:00 AM–8:00 PM',description:'Coffee · sandwiches · baked goods',concepts:[]},
  ivy:    {url:'https://hospitality.yale.edu/restaurants-cafes-more/schwarzman-center/ivy',    name:'The Ivy',hours:'Check website for hours',description:'Schwarzman Center restaurant',concepts:[]},
};

app.get('/api/venue/:venue', async (req,res) => {
  const cfg=VENUES[req.params.venue];
  if (!cfg) return res.status(404).json({error:'unknown'});
  const bw=biweekKey();
  const f=cacheFile('venue',req.params.venue,bw);
  const cached=readCache(f);
  if (cached?.bw===bw) return res.json(cached.data);
  try {
    const r=await fetch(cfg.url,{headers:FETCH_HDR});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html=await r.text();
    const pdfRe=/href="(\/sites\/default\/files\/files\/[^"]+\.pdf)"/gi;
    const pdfs=[],seen=new Set();
    let m;
    while((m=pdfRe.exec(html))!==null){
      const full='https://hospitality.yale.edu'+m[1];
      if(!seen.has(full)){seen.add(full);pdfs.push(full);}
    }
    const data={name:cfg.name,hours:cfg.hours,description:cfg.description,menuLinks:pdfs.map((u,i)=>({url:u,label:cfg.concepts[i]||`Menu ${i+1}`}))};
    writeCache(f,{bw,data});
    res.json(data);
  } catch(err){
    if (cached) return res.json(cached.data);
    res.json({name:cfg.name,hours:cfg.hours,description:cfg.description,menuLinks:[],error:err.message});
  }
});

// ── Library Hours – LibCal per-library fetch – daily disk cache ───────────────
// Yale uses iid=457. Each library has a specific lid. We fetch each individually
// because the bulk lid=0 endpoint has unreliable open/rendered fields.
const LIBCAL_BASE = 'https://api3.libcal.com/api_hours_today.php?iid=457&format=json&lid=';

const LIBRARIES = [
  { lid:384,  name:'Bass Library',                          addr:'130 Wall St',                lat:41.3113, lng:-72.9281, url:'https://library.yale.edu/bass' },
  { lid:3604, name:'Sterling Memorial Library',             addr:'120 High St',                lat:41.3116, lng:-72.9262, url:'https://web.library.yale.edu/building/sterling-memorial-library' },
  { lid:3605, name:'Gilmore Music Library',                 addr:'120 High St (in Sterling)',  lat:41.3116, lng:-72.9262, url:'https://library.yale.edu/visit-and-study/libraries-locations/irving-s-gilmore-music-library' },
  { lid:3606, name:'Manuscripts & Archives',                addr:'120 High St (in Sterling)',  lat:41.3116, lng:-72.9262, url:'https://web.library.yale.edu/mssa' },
  { lid:3607, name:'Beinecke Rare Book Library',            addr:'121 Wall St',                lat:41.3114, lng:-72.9267, url:'https://beinecke.library.yale.edu' },
  { lid:3608, name:'Haas Arts Library',                     addr:'190 York St',                lat:41.3072, lng:-72.9329, url:'https://web.library.yale.edu/arts' },
  { lid:395,  name:'Marx Science & Social Science Library', addr:'219 Prospect St',            lat:41.3203, lng:-72.9245, url:'https://library.yale.edu/marx' },
  { lid:3609, name:'Cushing/Whitney Medical Library',       addr:'333 Cedar St',               lat:41.3031, lng:-72.9346, url:'https://library.medicine.yale.edu' },
  { lid:3610, name:'Lillian Goldman Law Library',           addr:'127 Wall St',                lat:41.3110, lng:-72.9272, url:'https://library.law.yale.edu' },
  { lid:396,  name:'Divinity Library',                      addr:'409 Prospect St',            lat:41.3229, lng:-72.9266, url:'https://library.yale.edu/divinity' },
  { lid:3611, name:'Classics Library',                      addr:'344 College St',             lat:41.3155, lng:-72.9310, url:'https://library.yale.edu/classics' },
  { lid:3612, name:'Lewis Walpole Library',                 addr:'154 Main St, Farmington CT', lat:41.7184, lng:-72.8293, url:'https://library.yale.edu/walpole' },
  { lid:3613, name:'Yale Center for British Art',           addr:'1080 Chapel St',             lat:41.3067, lng:-72.9307, url:'https://britishart.yale.edu/reference-library-and-photo-archives' },
];

// Note: lid values for Sterling, Gilmore, Manuscripts, Beinecke, Haas, Med, Law,
// Classics, Walpole, YCBA are estimated — the /api/libraries-raw endpoint will
// show the real values. Bass=384, Marx=395, Divinity=396 are confirmed from Yale docs.

async function fetchOneLibrary(lib) {
  const url = LIBCAL_BASE + lib.lid;
  const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0','Accept':'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for lid=${lib.lid}`);
  const json = await r.json();
  // Response is { locations: [{ lid, name, open, rendered, times }] }
  const loc = (json.locations || [])[0];
  if (!loc) return { ...lib, open: null, rendered: '', closedToday: null };

  const openRaw = loc.open;
  const isOpen = openRaw === true || openRaw === 1 || openRaw === '1';
  const isUnknown = openRaw === undefined || openRaw === null;

  let rendered = (loc.rendered || '').trim()
    .replace(/&amp;/g,'&').replace(/&ndash;/g,'–').replace(/&#8211;/g,'–')
    .replace(/<[^>]+>/g,'').trim();

  // If rendered still says "Closed" but open=true, try times.hours
  const timesHours = loc.times?.hours || [];
  if (isOpen && (!rendered || rendered.toLowerCase() === 'closed') && timesHours.length) {
    const h = timesHours[0];
    if (h.from && h.to) rendered = `${h.from} - ${h.to}`;
  }

  const closedToday = isUnknown ? null : !isOpen;
  return {
    ...lib,
    open: isUnknown ? null : isOpen,
    rendered: (isOpen && rendered.toLowerCase() !== 'closed') ? rendered : '',
    closedToday,
  };
}

const todayKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// Raw debug: fetch bulk lid=0 so we can see what LibCal actually returns
app.get('/api/libraries-raw', async (req,res) => {
  try {
    const r = await fetch('https://api3.libcal.com/api_hours_today.php?iid=457&lid=0&format=json',
      { headers:{ 'User-Agent':'Mozilla/5.0','Accept':'application/json' } });
    const text = await r.text();
    res.setHeader('Content-Type','application/json');
    res.send(text);
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get('/api/libraries', async (req,res) => {
  const today = todayKey()+'v4';
  const f = cacheFile('libraries', today);
  const cached = readCache(f);
  if (cached?.date === today) return res.json(cached.data);

  try {
    // First fetch the bulk lid=0 to discover real lids and get a name→lid map
    const bulkR = await fetch('https://api3.libcal.com/api_hours_today.php?iid=457&lid=0&format=json',
      { headers:{ 'User-Agent':'Mozilla/5.0','Accept':'application/json' } });
    const bulk = bulkR.ok ? await bulkR.json() : { locations: [] };

    // Build a name→{lid,open,rendered,timesHours} map from bulk response
    const bulkMap = {};
    for (const loc of (bulk.locations || [])) {
      const openRaw = loc.open;
      const isOpen = openRaw === true || openRaw === 1 || openRaw === '1';
      const isUnknown = openRaw === undefined || openRaw === null;
      let rendered = (loc.rendered || '').trim()
        .replace(/&amp;/g,'&').replace(/&ndash;/g,'–').replace(/&#8211;/g,'–')
        .replace(/<[^>]+>/g,'').trim();
      const timesHours = loc.times?.hours || [];
      if (isOpen && (!rendered || rendered.toLowerCase() === 'closed') && timesHours.length) {
        const h = timesHours[0];
        if (h.from && h.to) rendered = `${h.from} - ${h.to}`;
      }
      bulkMap[loc.name] = { lid: loc.lid, isOpen, isUnknown, rendered, timesHours };
    }

    // For each known library, use bulk data if name matches, else fetch individually by lid
    const locations = await Promise.all(LIBRARIES.map(async lib => {
      // Try name match first (most reliable)
      const bulk = bulkMap[lib.name];
      if (bulk) {
        const closedToday = bulk.isUnknown ? null : !bulk.isOpen;
        return {
          ...lib,
          lid: bulk.lid || lib.lid,
          open: bulk.isUnknown ? null : bulk.isOpen,
          rendered: (bulk.isOpen && bulk.rendered.toLowerCase() !== 'closed') ? bulk.rendered : '',
          closedToday,
        };
      }
      // Fall back to individual lid fetch
      return fetchOneLibrary(lib).catch(err => ({ ...lib, open: null, rendered: '', closedToday: null, error: err.message }));
    }));

    const data = { date: today, locations };
    writeCache(f, { date: today, data });
    res.json(data);
  } catch(err) {
    if (cached) return res.json(cached.data);
    const fallback = LIBRARIES.map(lib => ({ ...lib, open: null, rendered: '', closedToday: null }));
    res.json({ date: today, locations: fallback, error: err.message });
  }
});

app.get('/api/cache-stats',(req,res)=>{
  try{const files=fs.readdirSync(CACHE_DIR);res.json({dir:CACHE_DIR,entries:files.length,files});}
  catch{res.json({entries:0,files:[]});}
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

app.listen(PORT,()=>console.log(`Yale Dining :${PORT}  cache:${CACHE_DIR}`));
