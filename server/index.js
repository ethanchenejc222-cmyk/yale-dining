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

// ── Library Hours – scrape schedule.yale.edu/hours ───────────────────────────
// Yale's own LibCal-hosted hours page — far more reliable than the raw API
const HOURS_URL = 'https://schedule.yale.edu/hours/';

// Known library metadata keyed by the name fragment that appears in the hours table
const LIBRARIES = [
  { key:'Bass',              name:'Bass Library',                          addr:'130 Wall St',                lat:41.3113, lng:-72.9281, url:'https://library.yale.edu/bass' },
  { key:'Beinecke',         name:'Beinecke Rare Book Library',            addr:'121 Wall St',                lat:41.3114, lng:-72.9267, url:'https://beinecke.library.yale.edu' },
  { key:'Classics',         name:'Classics Library',                      addr:'344 College St',             lat:41.3155, lng:-72.9310, url:'https://library.yale.edu/classics' },
  { key:'Cushing',          name:'Cushing/Whitney Medical Library',       addr:'333 Cedar St',               lat:41.3031, lng:-72.9346, url:'https://library.medicine.yale.edu' },
  { key:'Divinity',         name:'Divinity Library',                      addr:'409 Prospect St',            lat:41.3229, lng:-72.9266, url:'https://library.yale.edu/divinity' },
  { key:'Gilmore Music',    name:'Gilmore Music Library',                 addr:'120 High St',                lat:41.3116, lng:-72.9262, url:'https://library.yale.edu/visit-and-study/libraries-locations/irving-s-gilmore-music-library' },
  { key:'Haas Arts',        name:'Haas Arts Library',                     addr:'190 York St',                lat:41.3072, lng:-72.9329, url:'https://web.library.yale.edu/arts' },
  { key:'Lewis Walpole',    name:'Lewis Walpole Library',                 addr:'154 Main St, Farmington CT', lat:41.7184, lng:-72.8293, url:'https://library.yale.edu/walpole' },
  { key:'Lillian Goldman',  name:'Lillian Goldman Law Library',           addr:'127 Wall St',                lat:41.3110, lng:-72.9272, url:'https://library.law.yale.edu' },
  { key:'Marx',             name:'Marx Science & Social Science Library', addr:'219 Prospect St',            lat:41.3203, lng:-72.9245, url:'https://library.yale.edu/marx' },
  { key:'Sterling',         name:'Sterling Memorial Library',             addr:'120 High St',                lat:41.3116, lng:-72.9262, url:'https://web.library.yale.edu/building/sterling-memorial-library' },
  { key:'Yale Center for British Art', name:'Yale Center for British Art',addr:'1080 Chapel St',            lat:41.3067, lng:-72.9307, url:'https://britishart.yale.edu/reference-library-and-photo-archives' },
];

const todayKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

function stripTags(s) {
  return s.replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&ndash;/g,'–').replace(/&#8211;/g,'–')
    .replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}

// Scrape today's hours from the HTML table on schedule.yale.edu/hours
async function scrapeLibraryHours() {
  const r = await fetch(HOURS_URL, { headers: { 'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36', 'Accept':'text/html,*/*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  // Build today's date label as it appears in the table header, e.g. "Mar 07 Saturday"
  const today = new Date();
  const monthAbbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][today.getMonth()];
  const dayNum = today.getDate();
  const todayLabel = `${monthAbbr} ${String(dayNum).padStart(2,'0')}`;
  const todayLabelAlt = `${monthAbbr} ${dayNum}`;

  // The page has multiple <table> elements (one per week). Find the one containing today's date.
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch;
  let todayColIdx = -1;
  let targetTableHtml = null;

  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tbl = tableMatch[0];
    const thCells = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thMatch;
    while ((thMatch = thRe.exec(tbl)) !== null) thCells.push(stripTags(thMatch[1]));
    const idx = thCells.findIndex(h => h.includes(todayLabel) || h.includes(todayLabelAlt));
    if (idx !== -1) { todayColIdx = idx; targetTableHtml = tbl; break; }
  }

  // Fallback: search by day name if date format differs
  if (!targetTableHtml) {
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const todayName = dayNames[today.getDay()];
    const tableRe2 = /<table[\s\S]*?<\/table>/gi;
    while ((tableMatch = tableRe2.exec(html)) !== null) {
      const tbl = tableMatch[0];
      const thCells = [];
      const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thMatch;
      while ((thMatch = thRe.exec(tbl)) !== null) thCells.push(stripTags(thMatch[1]));
      const idx = thCells.findIndex(h => h.includes(todayName));
      if (idx !== -1) { todayColIdx = idx; targetTableHtml = tbl; break; }
    }
  }

  if (!targetTableHtml || todayColIdx < 0) throw new Error(`Could not find today's column (tried: "${todayLabel}")`);

  // Parse all <tr> rows from the correct table only
  const results = {};
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(targetTableHtml)) !== null) {
    const row = rowMatch[1];
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(row)) !== null) cells.push(stripTags(cellMatch[1]));
    if (cells.length < 2) continue;
    const libName = cells[0];
    const hoursText = cells[todayColIdx] || '';
    if (libName && hoursText) results[libName] = hoursText;
  }

  if (Object.keys(results).length === 0) throw new Error('Parsed 0 rows — HTML structure may have changed');
  return results;
}

// Scrape ALL weeks from schedule.yale.edu/hours → { 'YYYY-MM-DD': { 'Bass': '10am-6pm', ... } }
async function scrapeAllWeeks() {
  const r = await fetch(HOURS_URL, { headers: { 'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122 Safari/537.36', 'Accept':'text/html,*/*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  const byDate = {}; // 'YYYY-MM-DD' → { libName: hoursText }

  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tbl = tableMatch[0];
    // Parse header <th> cells to get dates
    const thCells = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let thMatch;
    while ((thMatch = thRe.exec(tbl)) !== null) thCells.push(stripTags(thMatch[1]));
    if (thCells.length < 2) continue;

    // Parse date strings from headers like "Mar 07 Saturday"
    // Map column index → ISO date string
    const colDates = [];
    const monthMap = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    for (const cell of thCells) {
      const m = cell.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s+/);
      if (m && monthMap[m[1]] !== undefined) {
        const now = new Date();
        const mo = monthMap[m[1]];
        const yr = (mo < now.getMonth() - 3) ? now.getFullYear()+1 : now.getFullYear();
        const d = new Date(yr, mo, parseInt(m[2]));
        colDates.push(d.toISOString().slice(0,10));
      } else {
        colDates.push(null);
      }
    }
    if (!colDates.some(Boolean)) continue;

    // Parse rows
    const rowRe2 = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe2.exec(tbl)) !== null) {
      const row = rowMatch[1];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(row)) !== null) cells.push(stripTags(cellMatch[1]));
      if (cells.length < 2) continue;
      const libName = cells[0];
      cells.forEach((hoursText, i) => {
        if (i === 0 || !colDates[i] || !hoursText) return;
        if (!byDate[colDates[i]]) byDate[colDates[i]] = {};
        // Only store first match per lib per date (don't overwrite with sub-rooms)
        if (!byDate[colDates[i]][libName]) byDate[colDates[i]][libName] = hoursText;
      });
    }
  }
  return byDate;
}

function normalizeHours(raw) {
  if (!raw) return '';
  let s = raw.replace(/\(.*?\)/g,'').replace(/[^;]+only\b/gi,'').trim();
  s = s.split(';')[0].trim();
  // strip trailing commas/dots
  s = s.replace(/[,\.]+$/, '').trim();
  return s;
}

function isClosedText(s) {
  if (!s) return true;
  const t = s.toLowerCase().trim();
  return t === 'closed' || t === '–' || t === '-' || t === '' || t.startsWith('closed');
}

// Find next open date string and hours for a library given byDate data
function findNextOpen(libKey, byDate, todayIso) {
  const dates = Object.keys(byDate).sort();
  for (const d of dates) {
    if (d <= todayIso) continue;
    const matchKey = Object.keys(byDate[d]).find(k => k.toLowerCase().includes(libKey.toLowerCase()));
    const hoursText = matchKey ? byDate[d][matchKey] : '';
    if (!isClosedText(hoursText)) {
      // Format like "Mon Mar 9"
      const dt = new Date(d + 'T12:00:00');
      const dayAbbr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
      const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()];
      return { date: `${dayAbbr} ${mo} ${dt.getDate()}`, hours: normalizeHours(hoursText) };
    }
  }
  return null;
}

app.get('/api/libraries-raw', async (req,res) => {
  try {
    const all = await scrapeAllWeeks();
    res.json(all);
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get('/api/libraries', async (req,res) => {
  const todayIso = todayKey();
  const cacheKey = todayIso+'v6';
  const f = cacheFile('libraries', cacheKey);
  const cached = readCache(f);
  if (cached?.date === cacheKey) return res.json(cached.data);

  try {
    const byDate = await scrapeAllWeeks();
    const todayRows = byDate[todayIso] || {};

    const locations = LIBRARIES.map(lib => {
      const matchKey = Object.keys(todayRows).find(k => k.toLowerCase().includes(lib.key.toLowerCase()));
      const hoursText = matchKey ? todayRows[matchKey] : '';
      const isClosed = isClosedText(hoursText);
      const rendered = isClosed ? '' : normalizeHours(hoursText);
      const nextOpen = isClosed ? findNextOpen(lib.key, byDate, todayIso) : null;

      return {
        name: lib.name,
        addr: lib.addr,
        lat: lib.lat,
        lng: lib.lng,
        url: lib.url,
        open: !isClosed,
        rendered,
        closedToday: isClosed,
        nextOpen, // { date: 'Mon Mar 9', hours: '8:30am – 11pm' } or null
      };
    });

    const data = { date: cacheKey, locations };
    writeCache(f, { date: cacheKey, data });
    res.json(data);
  } catch(err) {
    if (cached) return res.json(cached.data);
    const fallback = LIBRARIES.map(lib => ({ ...lib, open: null, rendered: '', closedToday: null, nextOpen: null }));
    res.json({ date: cacheKey, locations: fallback, error: err.message });
  }
});

app.get('/api/cache-stats',(req,res)=>{
  try{const files=fs.readdirSync(CACHE_DIR);res.json({dir:CACHE_DIR,entries:files.length,files});}
  catch{res.json({entries:0,files:[]});}
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

app.listen(PORT,()=>console.log(`Yale Dining :${PORT}  cache:${CACHE_DIR}`));
