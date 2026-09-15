const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3939;

// Loopback only. Binding 0.0.0.0 exposed this server — including the static
// file handler — to every machine on the local network.
const HOST = '127.0.0.1';

const ROOT = __dirname;

// Only these hosts may be reached through /jira-proxy. Without an allowlist the
// endpoint is an open relay: it forwards the caller's Authorization header to
// whatever host the url param names, which both leaks the Jira credential and
// turns this process into an SSRF pivot.
const ALLOWED_HOSTS = new Set(
    (process.env.JIRA_ALLOWED_HOSTS || 'smithmicro.atlassian.net')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean)
);

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
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
        const parsed = url.parse(req.url, true);
        const targetUrl = parsed.query.url;
        if (!targetUrl) {
            sendJson(res, 400, { error: 'Missing url param' });
            return;
        }

        let target;
        try {
            target = new URL(targetUrl);
        } catch {
            sendJson(res, 400, { error: 'Malformed url param' });
            return;
        }
        if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
            sendJson(res, 403, { error: `Target not allowed: ${target.protocol}//${target.hostname}` });
            return;
        }

        const authHeader = req.headers['authorization'];
        const options = {
            hostname: target.hostname,
            port: 443,
            path: target.pathname + target.search,
            method: req.method,
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
        };
        if (authHeader) options.headers['Authorization'] = authHeader;

        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/json'
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            sendJson(res, 502, { error: 'Proxy error: ' + e.message });
        });
        // Forward the request body; end() alone silently dropped POST/PUT bodies.
        req.pipe(proxyReq);
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

server.listen(PORT, HOST, () => {
    console.log(`\n  Jira Dashboard Server running at:`);
    console.log(`  -> http://localhost:${PORT}\n`);
    console.log(`  Bound to ${HOST} only. Allowed proxy hosts: ${[...ALLOWED_HOSTS].join(', ')}\n`);
    console.log(`  Press Ctrl+C to stop.\n`);
});
