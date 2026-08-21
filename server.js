/* ============================================================
 * Scroll or Swipe — study server
 * ------------------------------------------------------------
 * Serves the five study websites and stores the responses.
 *
 * The original sites talked to a PHP backend at mktresearch.co
 * through seven addresses. That server is gone, but the sites
 * still speak the same protocol, so this file answers the same
 * seven requests and the original websites work unchanged.
 *
 *   From the survey site
 *     registeredid       start a session, take the Prolific ID
 *     tocityushop        mark the move to the browsing task
 *     toallquestionaire  store the survey answers
 *     postform           store the demographics and finish
 *
 *   From the task site
 *     getcondition       tell the site which condition to show
 *     toshopstatistics   store one batch of interaction events
 *     closeandupdate     store the final cart and browsing times
 *
 * Written with no external packages, so it runs on a plain Node
 * installation with nothing to install first.
 *
 *   node server.js
 *
 * Configuration comes from the environment:
 *   PORT            port to listen on          (default 3000)
 *   DATA_DIR        where responses are kept   (default ./data)
 *   SITE_DIR        where the websites live    (default ./site)
 *   ADMIN_PASSWORD  password for /admin        (required for /admin)
 * ============================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Where the websites live. By default they sit next to this file,
// which is the simplest arrangement: the study folders, index.html
// and server.js all in one place.
const SITE_DIR = process.env.SITE_DIR || __dirname;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ------------------------------------------------------------
// Which conditions each study uses.
//
// The numbering is not the same in every study. Studies 1, 2 and
// 4 use all four values; Study 3 uses two; Study 5 uses two but
// the other way round. This was read from the study source code,
// where it is the switch statement that decides the layout.
//
//   layout   'v' vertical (scroll)   'h' horizontal (swipe)
//   control  'g' finger gesture      'b' on-screen buttons
// ------------------------------------------------------------
const STUDIES = {
  study1: { conditions: { 0: 'h/g', 2: 'v/g' } },
  study2: { conditions: { 0: 'h/g', 2: 'v/g' } },
  study3: { conditions: { 0: 'h/g', 1: 'v/g' } },
  study4: { conditions: { 0: 'h/g', 1: 'h/b', 2: 'v/g', 3: 'v/b' } },
  study5: { conditions: { 0: 'v/g', 1: 'h/g' } },
};

// ------------------------------------------------------------
// Storage.
//
// Each session is one line of JSON in sessions.jsonl, rewritten
// as it progresses. Interaction events are appended to their own
// file, since there are many thousands of them and they are only
// needed when the browsing measures are computed.
//
// Appending a line is a single write, so a crash cannot leave a
// half-written record behind, and the files can be read with any
// text editor if something needs checking by hand.
// ------------------------------------------------------------
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Sessions held in memory; the file on disk is the record of truth. */
const sessions = new Map();

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  const lines = fs.readFileSync(SESSIONS_FILE, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      sessions.set(row._id, row); // later lines replace earlier ones
    } catch (e) {
      console.warn('skipping unreadable line in sessions.jsonl');
    }
  }
  console.log('loaded ' + sessions.size + ' sessions');
}

function saveSession(session) {
  sessions.set(session._id, session);
  fs.appendFileSync(SESSIONS_FILE, JSON.stringify(session) + '\n');
}

function saveEvents(id, study, events) {
  if (!Array.isArray(events) || !events.length) return;
  const lines = events
    .map((e) => JSON.stringify({ _id: id, study: study, event: e }))
    .join('\n');
  fs.appendFileSync(EVENTS_FILE, lines + '\n');
}

// ------------------------------------------------------------
// Condition assignment.
//
// Assignment is balanced rather than a coin toss: the condition
// with the fewest sessions so far is chosen, and ties are broken
// at random. Over a full sample this keeps the cells even, which
// a plain random draw does not guarantee.
// ------------------------------------------------------------
function assignCondition(study) {
  const available = Object.keys(STUDIES[study].conditions).map(Number);

  const counts = new Map(available.map((c) => [c, 0]));
  for (const s of sessions.values()) {
    if (s.study === study && counts.has(s.condition)) {
      counts.set(s.condition, counts.get(s.condition) + 1);
    }
  }

  const fewest = Math.min(...counts.values());
  const candidates = available.filter((c) => counts.get(c) === fewest);
  return candidates[crypto.randomInt(candidates.length)];
}

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function sendJson(res, body, status) {
  const text = JSON.stringify(body);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) { // interaction batches can be large
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve({});
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

/** Which study a request belongs to, taken from the address it came from. */
function studyFromRequest(req, body) {
  if (body && typeof body.study === 'string' && STUDIES[body.study]) {
    return body.study;
  }
  const referer = req.headers.referer || '';
  const match = referer.match(/\/(study[1-5])\//);
  return match ? match[1] : null;
}

// ------------------------------------------------------------
// The seven endpoints
// ------------------------------------------------------------
const api = {
  /** Survey site: a participant has entered their Prolific ID. */
  registeredid(body, req) {
    const study = studyFromRequest(req, body) || 'study1';
    const id = newId();

    const session = {
      _id: id,
      study: study,
      prolific_id: String(body.prolific_id || '').trim(),
      condition: assignCondition(study),
      start_time: Number(body.start_time) || Date.now(),
      end_time: null,
      ip: clientIp(req),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      device_info: body.infolist || null,
      browsing_start_time: null,
      browsing_end_time: null,
      order: null,
      quantity: null,
      survey: null,
      demographics: null,
    };

    saveSession(session);

    // The questionnaire stores this reply as its session record and
    // reads fields back from it later. The original PHP returned
    // the shape below, noted in a comment in the page source:
    //   {code, _id, prolific_id, ip, condition, question_id}
    // Returning less than that leaves fields undefined further on,
    // so the whole record is sent back.
    return {
      code: 200,
      _id: id,
      prolific_id: session.prolific_id,
      ip: session.ip,
      condition: session.condition,
      question_id: 0,
      msg: 'ok',
    };
  },

  /** Survey site: the participant is about to start the browsing task. */
  tocityushop(body) {
    const session = sessions.get(body._id);
    if (!session) return { code: 404, msg: 'unknown session' };

    session.browsing_start_time =
      Number(body.browsing_start_time) || Date.now();
    saveSession(session);
    return { code: 200, msg: 'ok' };
  },

  /**
   * Task site: which condition should this participant see?
   *
   * The condition was decided when the session began, so the same
   * one is returned however many times the page is reloaded.
   */
  getcondition(body, req) {
    const session = body._id ? sessions.get(body._id) : null;
    if (session) {
      return { code: 200, condition: session.condition, msg: 'ok' };
    }

    // No session: the task site was opened on its own rather than
    // through the survey. Assign one so the page still works.
    const study = studyFromRequest(req, body) || 'study1';
    return { code: 200, condition: assignCondition(study), msg: 'no session' };
  },

  /** Task site: a batch of scrolls, taps and page views. */
  toshopstatistics(body, req) {
    const study = studyFromRequest(req, body) || 'unknown';
    const events = body.statisticsALineList || body.list || body.events;
    saveEvents(body._id || 'anonymous', study, events);
    return { code: 200, msg: 'ok' };
  },

  /** Task site: the participant confirmed their choices. */
  closeandupdate(body) {
    const session = sessions.get(body._id);
    if (!session) return { code: 404, msg: 'unknown session' };

    session.order = body.order != null ? String(body.order) : session.order;
    session.quantity =
      body.quantity != null ? String(body.quantity) : session.quantity;
    session.browsing_end_time =
      Number(body.browsing_end_time) || Date.now();
    saveSession(session);
    return { code: 200, msg: 'ok' };
  },

  /**
   * The cart sends the same thing under this name when the
   * participant presses Confirm.
   *
   * The order and quantity arrive as arrays here rather than as
   * comma separated text, so they are joined before storing and
   * the two routes end up with identical records.
   */
  toshopback(body) {
    const session = sessions.get(body._id);
    if (!session) return { code: 404, msg: 'unknown session' };

    const flatten = (value) =>
      Array.isArray(value) ? value.join(',') : value != null ? String(value) : null;

    session.order = flatten(body.order) ?? session.order;
    session.quantity = flatten(body.quantity) ?? session.quantity;
    session.browsing_end_time =
      Number(body.browsing_end_time) || Date.now();
    saveSession(session);
    return { code: 200, msg: 'ok' };
  },

  /** Survey site: the answers to the scale questions. */
  toallquestionaire(body) {
    const session = sessions.get(body._id);
    if (!session) return { code: 404, msg: 'unknown session' };

    session.survey = body.question_value_list || null;
    saveSession(session);
    return { code: 200, msg: 'ok' };
  },

  /**
   * The same thing under a different name.
   *
   * The questionnaire pages send their answers to an address of
   * the form api.php?action=user_question rather than to the
   * endpoint above. Both carry the same content, so this simply
   * passes the request on.
   */
  user_question(body) {
    return api.toallquestionaire(body);
  },

  /** Survey site: age, gender, and the end of the session. */
  postform(body) {
    const session = sessions.get(body._id);
    if (!session) return { code: 404, msg: 'unknown session' };

    session.demographics = body.form || null;
    session.end_time = Number(body.end_time) || Date.now();
    saveSession(session);

    return { code: 200, msg: 'ok', completion_code: 'DEMO' };
  },

  /**
   * The same thing in the photography studies.
   *
   * Those pages use their own name for the demographics step
   * (fengjing means scenery), but send the same content.
   */
  postformfengjing(body) {
    return api.postform(body);
  },
};

// ------------------------------------------------------------
// Serving the websites
// ------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveFile(res, urlPath) {
  // Resolve inside SITE_DIR only, so a crafted address cannot
  // reach files elsewhere on the machine.
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  let target = path.join(SITE_DIR, decoded);

  if (!target.startsWith(SITE_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }

  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(target).pipe(res);
}

// ------------------------------------------------------------
// Export and admin
// ------------------------------------------------------------
function csvCell(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * One row per session, with the survey answers and demographics
 * spread into their own columns so the file opens straight into
 * a spreadsheet or SPSS.
 */
function buildCsv(study) {
  const rows = [...sessions.values()].filter(
    (s) => !study || s.study === study
  );

  // Collect every survey question and demographic field that appears.
  const questionIds = new Set();
  const demoFields = new Set();
  for (const s of rows) {
    if (Array.isArray(s.survey)) {
      for (const answer of s.survey) {
        if (answer && answer.qid != null) questionIds.add(String(answer.qid));
      }
    }
    if (s.demographics && typeof s.demographics === 'object') {
      Object.keys(s.demographics).forEach((k) => demoFields.add(k));
    }
  }

  const qList = [...questionIds].sort((a, b) => Number(a) - Number(b));
  const dList = [...demoFields].sort();

  const header = [
    '_id', 'study', 'prolific_id', 'condition',
    'start_time', 'end_time', 'duration_ms',
    'browsing_start_time', 'browsing_end_time', 'browsing_duration_ms',
    'order', 'quantity', 'n_products', 'total_quantity',
    ...qList.map((q) => 'q' + q),
    ...dList,
    'user_agent',
  ];

  const lines = [header.join(',')];

  for (const s of rows) {
    const answers = new Map();
    if (Array.isArray(s.survey)) {
      for (const a of s.survey) {
        if (a && a.qid != null) answers.set(String(a.qid), a.value ?? a.v ?? '');
      }
    }

    const orderList = s.order ? String(s.order).split(',').filter(Boolean) : [];
    const qtyList = s.quantity ? String(s.quantity).split(',').filter(Boolean) : [];
    const totalQty = qtyList.reduce((sum, n) => sum + (Number(n) || 0), 0);

    const line = [
      s._id, s.study, s.prolific_id, s.condition,
      s.start_time, s.end_time,
      s.end_time && s.start_time ? s.end_time - s.start_time : '',
      s.browsing_start_time, s.browsing_end_time,
      s.browsing_end_time && s.browsing_start_time
        ? s.browsing_end_time - s.browsing_start_time
        : '',
      s.order, s.quantity, orderList.length, totalQty || '',
      ...qList.map((q) => (answers.has(q) ? answers.get(q) : '')),
      ...dList.map((f) => (s.demographics ? s.demographics[f] : '')),
      s.user_agent,
    ];

    lines.push(line.map(csvCell).join(','));
  }

  return lines.join('\n');
}

function adminAllowed(req) {
  if (!ADMIN_PASSWORD) return false; // no password set: keep it closed
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const given = decoded.slice(decoded.indexOf(':') + 1);

  // Compare in constant time so the password cannot be guessed
  // by measuring how long the check takes.
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestPassword(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Study admin"',
    'Content-Type': 'text/plain',
  });
  res.end(
    ADMIN_PASSWORD
      ? 'Password required.'
      : 'The admin pages are closed because ADMIN_PASSWORD is not set.'
  );
}

function adminPage() {
  const perStudy = {};
  for (const s of sessions.values()) {
    const bucket = (perStudy[s.study] = perStudy[s.study] || {
      total: 0, complete: 0, conditions: {},
    });
    bucket.total += 1;
    if (s.end_time) bucket.complete += 1;
    bucket.conditions[s.condition] = (bucket.conditions[s.condition] || 0) + 1;
  }

  const rows = Object.keys(STUDIES).map((study) => {
    const b = perStudy[study] || { total: 0, complete: 0, conditions: {} };
    const spread = Object.entries(STUDIES[study].conditions)
      .map(([code, label]) => code + ' (' + label + '): ' + (b.conditions[code] || 0))
      .join('<br>');
    return (
      '<tr><td>' + study + '</td><td>' + b.total + '</td><td>' +
      b.complete + '</td><td class="spread">' + spread + '</td>' +
      '<td><a href="/export.csv?study=' + study + '">download</a></td></tr>'
    );
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Study admin</title>
<style>
 body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
      max-width:760px;margin:0 auto;padding:32px 22px;color:#1a1a1a}
 h1{font-size:1.3rem;margin:0 0 4px}
 .sub{color:#666;font-size:.88rem;margin:0 0 26px}
 table{border-collapse:collapse;width:100%;font-size:.9rem}
 th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e6e6e6;
       vertical-align:top}
 th{background:#f3f6fa;font-weight:600}
 .spread{color:#555;font-size:.84rem;line-height:1.5}
 a{color:#0b4f9e}
 .all{margin-top:24px;font-size:.9rem}
</style></head><body>
<h1>Study admin</h1>
<p class="sub">${sessions.size} sessions recorded</p>
<table>
 <tr><th>Study</th><th>Started</th><th>Completed</th>
     <th>By condition</th><th>Data</th></tr>
 ${rows}
</table>
<p class="all"><a href="/export.csv">Download everything as one file</a></p>
</body></html>`;
}

// ------------------------------------------------------------
// Request routing
// ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Обращения приходят на /api/<имя>. Старые сборки использовали
  // длинный путь вида /php/public/index.php/<имя>, поэтому имя
  // берётся из последней части адреса и оба варианта работают.
  const endpoint = pathname.split('/').filter(Boolean).pop();

  if (endpoint && Object.prototype.hasOwnProperty.call(api, endpoint)) {
    const body = await readBody(req);
    try {
      return sendJson(res, api[endpoint](body, req));
    } catch (err) {
      console.error(endpoint + ' failed:', err);
      return sendJson(res, { code: 500, msg: 'server error' }, 500);
    }
  }

  if (pathname === '/admin') {
    if (!adminAllowed(req)) return requestPassword(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(adminPage());
  }

  if (pathname === '/export.csv') {
    if (!adminAllowed(req)) return requestPassword(res);
    const study = (url.match(/[?&]study=(study[1-5])/) || [])[1] || '';
    const name = study ? study + '.csv' : 'all_studies.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '"',
    });
    return res.end('\ufeff' + buildCsv(study)); // BOM so Excel reads UTF-8
  }

  if (pathname === '/health') {
    return sendJson(res, { ok: true, sessions: sessions.size });
  }

  serveFile(res, pathname === '/' ? '/index.html' : pathname);
});

loadSessions();

server.listen(PORT, () => {
  console.log('study server listening on http://localhost:' + PORT);
  console.log('  websites from ' + SITE_DIR);
  console.log('  responses to  ' + DATA_DIR);
  if (!ADMIN_PASSWORD) {
    console.log('  note: ADMIN_PASSWORD is not set, so /admin stays closed');
  }
});
