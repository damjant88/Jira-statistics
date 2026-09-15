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
const { execFile } = require('child_process');
const { Writable } = require('stream');
const { CREDENTIALS_PATH } = require('./jira-proxy');

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
    const token = (await askHidden('  Jira API token (input hidden): ')).trim();
    if (rl) rl.close();

    if (!email || !token) {
        console.error('\n  Both an email and a token are required. Nothing written.');
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ email, token }, null, 2), { mode: 0o600 });
    const aclError = await restrictPermissions(CREDENTIALS_PATH);

    console.log(`\n  Saved to ${CREDENTIALS_PATH}`);
    if (aclError) {
        console.log('  Note: could not tighten file permissions automatically.');
    } else {
        console.log('  Readable by your account only.');
    }
    console.log('  Restart the proxy to pick it up. Leave the Settings token field blank.\n');
})();
