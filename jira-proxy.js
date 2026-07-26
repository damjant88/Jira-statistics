const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3939;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url param' }));
            return;
        }
        const authHeader = req.headers['authorization'];
        const target = new URL(targetUrl);
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
                'Content-Type': proxyRes.headers['content-type'] || 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error: ' + e.message }));
        });
        proxyReq.end();
        return;
    }

    // Static file serving
    let filePath = req.url === '/' ? '/jira-dashboard.html' : req.url.split('?')[0];
    filePath = path.join(__dirname, filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`\n  Jira Dashboard Server running at:`);
    console.log(`  -> http://localhost:${PORT}\n`);
    console.log(`  Press Ctrl+C to stop.\n`);
});
