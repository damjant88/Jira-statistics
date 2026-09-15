const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3939;

// Loopback only. Binding 0.0.0.0 exposed this server — including the static
// file handler — to every machine on the local network.
const HOST = '127.0.0.1';

const ROOT = __dirname;

// Only these hosts may be reached through /jira-proxy. Without an allowlist the
// endpoint is an open relay: it forwards the Authorization header to whatever
// host the url param names, which both leaks the Jira credential and turns this
// process into an SSRF pivot.
const ALLOWED_HOSTS = new Set(
    (process.env.JIRA_ALLOWED_HOSTS || 'smithmicro.atlassian.net')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean)
);

// Requests the browser labels as cross-site are refused: without CORS headers a
// hostile page cannot read our responses, but it could still *send* requests and
// have them answered with our credentials attached.
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

// Credentials live here rather than in the browser, so no page — and no XSS in
// one — ever holds the Jira token. Kept outside the repo directory, which is
// inside OneDrive and would otherwise sync the token to the cloud.
const CREDENTIALS_PATH = process.env.JIRA_CREDENTIALS_PATH || path.join(
    process.env.APPDATA || path.join(os.homedir(), '.config'),
    'jira-dashboard',
    'config.json'
);

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

// Returns { email, token, source } or null. Env vars win over the config file.
function loadCredentials() {
    if (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
        return { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN, source: 'environment' };
    }
    try {
        const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg.email && cfg.token) {
            return { email: cfg.email, token: cfg.token, source: CREDENTIALS_PATH };
        }
        return null;
    } catch {
        return null;
    }
}

// The client's own Authorization header wins, so typing a token into Settings
// still works; otherwise the server supplies the configured credential.
function authHeaderFor(clientAuthHeader, credentials) {
    if (clientAuthHeader) return clientAuthHeader;
    if (!credentials) return null;
    return 'Basic ' + Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
}

function isAllowedTarget(targetUrl) {
    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        return { ok: false, reason: 'Malformed url param', status: 400 };
    }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
        return { ok: false, reason: `Target not allowed: ${target.protocol}//${target.hostname}`, status: 403 };
    }
    return { ok: true, target };
}

// True when the request is same-origin, or carries no browser origin hints at
// all (curl, the dashboard opened directly). A cross-site fetch is refused.
function isSameSiteRequest(headers) {
    const fetchSite = headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
    const origin = headers['origin'];
    if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
    return true;
}

// Resolve a request path inside ROOT, or null if it escapes.
function resolveStaticPath(requestUrl) {
    const raw = requestUrl === '/' ? '/jira-dashboard.html' : requestUrl.split('?')[0];
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null; // malformed percent-encoding
    }
    if (decoded.includes('\0')) return null;
    // Treat the path as relative to ROOT and collapse any ../ segments, then
    // verify the result is still inside ROOT.
    const resolved = path.resolve(ROOT, '.' + path.posix.normalize(decoded.replace(/\\/g, '/')));
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
    return resolved;
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

// Re-read the credentials file when it changes, so running setup-credentials.js
// against an already-started proxy takes effect without a restart.
let credCache = { mtimeMs: undefined, value: null };

function currentCredentials() {
    let mtimeMs = null;
    try {
        mtimeMs = fs.statSync(CREDENTIALS_PATH).mtimeMs;
    } catch {
        mtimeMs = null;
    }
    if (mtimeMs !== credCache.mtimeMs) {
        credCache = { mtimeMs, value: loadCredentials() };
    }
    return credCache.value;
}

const server = http.createServer((req, res) => {
    // No CORS headers: the dashboard is served by this same process, so its
    // requests are same-origin. "Access-Control-Allow-Origin: *" let any site
    // the user visited script this server.
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Proxy endpoint: /jira-proxy?url=<encoded-jira-url>
    if (req.url.startsWith('/jira-proxy')) {
        if (!isSameSiteRequest(req.headers)) {
            sendJson(res, 403, { error: 'Cross-site request refused' });
            return;
        }
        // The dashboard only reads. Refusing everything else keeps the
        // server-held credential from being used for writes.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'Only GET is allowed' });
            return;
        }

        const parsed = url.parse(req.url, true);
        const targetUrl = parsed.query.url;
        if (!targetUrl) {
            sendJson(res, 400, { error: 'Missing url param' });
            return;
        }

        const check = isAllowedTarget(targetUrl);
        if (!check.ok) {
            sendJson(res, check.status, { error: check.reason });
            return;
        }
        const target = check.target;

        const auth = authHeaderFor(req.headers['authorization'], currentCredentials());
        if (!auth) {
            sendJson(res, 401, {
                error: 'No Jira credentials configured. Run "node setup-credentials.js", '
                     + 'or enter a token in the dashboard Settings panel.'
            });
            return;
        }

        const options = {
            hostname: target.hostname,
            port: 443,
            path: target.pathname + target.search,
            method: req.method,
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': auth }
        };

        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/json'
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            sendJson(res, 502, { error: 'Proxy error: ' + e.message });
        });
        proxyReq.end();
        return;
    }

    // Static file serving, confined to ROOT
    const filePath = resolveStaticPath(req.url);
    if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
        res.end(content);
    });
});

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        console.log(`\n  Jira Dashboard Server running at:`);
        console.log(`  -> http://localhost:${PORT}\n`);
        console.log(`  Bound to ${HOST} only. Allowed proxy hosts: ${[...ALLOWED_HOSTS].join(', ')}`);
        const startupCreds = currentCredentials();
        if (startupCreds) {
            console.log(`  Jira credentials: ${startupCreds.email} (from ${startupCreds.source})\n`);
        } else {
            console.log(`  Jira credentials: NONE — run "node setup-credentials.js" to store them,`);
            console.log(`  or enter a token in the dashboard Settings panel.\n`);
        }
        console.log(`  Press Ctrl+C to stop.\n`);
    });
}

module.exports = { resolveStaticPath, isAllowedTarget, isSameSiteRequest, authHeaderFor, loadCredentials, currentCredentials, CREDENTIALS_PATH };
