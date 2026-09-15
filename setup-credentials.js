// Stores the Jira credentials the proxy uses, so the browser never holds them.
// Run: node setup-credentials.js
//
// Writes {email, token} to %APPDATA%\jira-dashboard\config.json (override with
// JIRA_CREDENTIALS_PATH). Deliberately outside the repo directory, which lives
// in OneDrive and would sync the token to the cloud.
//
// Values can also be piped in, one per line (email, then token), for unattended
// setup: echo "me@example.com`nTOKEN" | node setup-credentials.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { execFile } = require('child_process');
const { Writable } = require('stream');
const { CREDENTIALS_PATH } = require('./jira-proxy');

const JIRA_HOST = process.env.JIRA_HOST || 'smithmicro.atlassian.net';

const interactive = Boolean(process.stdin.isTTY);

// --- piped input ---------------------------------------------------------
let pipedLines = [];

function readAllStdin() {
    return new Promise(resolve => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
    });
}

// --- interactive input ---------------------------------------------------
// Output passes through a stream we can silence, so the token can be read
// without echoing it to the screen or into terminal scrollback.
const output = new Writable({
    write(chunk, encoding, callback) {
        if (!output.muted) process.stdout.write(chunk, encoding);
        callback();
    }
});
const rl = interactive
    ? readline.createInterface({ input: process.stdin, output, terminal: true })
    : null;

function ask(question) {
    if (!interactive) return Promise.resolve(pipedLines.shift() || '');
    return new Promise(resolve => rl.question(question, resolve));
}

function askHidden(question) {
    if (!interactive) return Promise.resolve(pipedLines.shift() || '');
    return new Promise(resolve => {
        process.stdout.write(question);
        output.muted = true;
        rl.question('', answer => {
            output.muted = false;
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}

// The token prompt shows nothing as you type, so a paste that seems not to have
// registered invites a second one. Catch the duplicate rather than storing it.
function deduplicate(token) {
    const half = token.length / 2;
    if (token.length % 2 === 0 && half > 0 && token.slice(0, half) === token.slice(half)) {
        return { token: token.slice(0, half), wasDoubled: true };
    }
    return { token, wasDoubled: false };
}

// Enough of the value to confirm the right thing arrived, not enough to leak it.
function maskToken(token) {
    if (token.length <= 12) return `${token.length} characters`;
    return `${token.length} characters, ${token.slice(0, 5)}…${token.slice(-4)}`;
}

// Confirm the credential actually works before storing it, so a bad paste is
// caught here instead of surfacing later as an unexplained empty dashboard.
function verifyCredentials(email, token, host) {
    return new Promise(resolve => {
        const req = https.request({
            hostname: host,
            port: 443,
            path: '/rest/api/3/myself',
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64')
            }
        }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
                try {
                    resolve({ ok: true, displayName: JSON.parse(body).displayName });
                } catch {
                    resolve({ ok: true, displayName: null });
                }
            });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, error: 'timed out' }); });
        req.end();
    });
}

// Best effort on Windows: strip inherited ACLs so only this account can read it.
function restrictPermissions(file) {
    return new Promise(resolve => {
        if (process.platform !== 'win32') {
            try { fs.chmodSync(file, 0o600); } catch {}
            return resolve(null);
        }
        const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
        execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], err => resolve(err));
    });
}

(async () => {
    if (!interactive) {
        pipedLines = (await readAllStdin()).split('\n').map(l => l.replace(/\r$/, ''));
    }

    console.log(`\n  Credentials file: ${CREDENTIALS_PATH}\n`);
    if (fs.existsSync(CREDENTIALS_PATH)) {
        const overwrite = await ask('  A credentials file already exists. Overwrite? [y/N] ');
        if (!/^y(es)?$/i.test(overwrite.trim())) {
            console.log('  Left unchanged.');
            if (rl) rl.close();
            return;
        }
    }

    const email = (await ask('  Jira email: ')).trim();
    const raw = (await askHidden('  Jira API token (input hidden): ')).trim();

    if (!email || !raw) {
        console.error('\n  Both an email and a token are required. Nothing written.');
        if (rl) rl.close();
        process.exitCode = 1;
        return;
    }

    const { token, wasDoubled } = deduplicate(raw);
    if (wasDoubled) {
        console.log('\n  The token appeared twice — looks like it was pasted twice. Using one copy.');
    }
    console.log(`  Token received: ${maskToken(token)}`);

    process.stdout.write(`  Checking it against ${JIRA_HOST}... `);
    const check = await verifyCredentials(email, token, JIRA_HOST);
    if (check.ok) {
        console.log(`authenticated as ${check.displayName || email}.`);
    } else {
        const why = check.status ? `HTTP ${check.status}` : check.error;
        console.log(`failed (${why}).`);
        const anyway = await ask('  Save it anyway? [y/N] ');
        if (!/^y(es)?$/i.test(anyway.trim())) {
            console.log('  Nothing written.');
            if (rl) rl.close();
            process.exitCode = 1;
            return;
        }
    }
    if (rl) rl.close();

    fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ email, token }, null, 2), { mode: 0o600 });
    const aclError = await restrictPermissions(CREDENTIALS_PATH);

    console.log(`\n  Saved to ${CREDENTIALS_PATH}`);
    if (aclError) {
        console.log('  Note: could not tighten file permissions automatically.');
    } else {
        console.log('  Readable by your account only.');
    }
    console.log('  A running proxy picks this up on its next request — no restart needed.');
    console.log('  Leave the Settings token field in the dashboard blank.\n');
})();
