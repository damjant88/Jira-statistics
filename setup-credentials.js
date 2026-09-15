// Stores the Jira credentials the proxy uses, so the browser never holds them.
// Run: node setup-credentials.js
//
// Writes {email, token} to %APPDATA%\jira-dashboard\config.json (override with
// JIRA_CREDENTIALS_PATH). Deliberately outside the repo directory, which lives
// in OneDrive and would sync the token to the cloud.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { CREDENTIALS_PATH } = require('./jira-proxy');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

// Same as ask(), but keeps the typed characters off the screen and out of any
// terminal scrollback.
function askHidden(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        const onData = char => {
            if (['\n', '\r', ''].includes(char.toString())) return;
            readline.moveCursor(process.stdout, -1000, 0);
            readline.clearLine(process.stdout, 1);
            process.stdout.write(question);
        };
        process.stdin.on('data', onData);
        rl.question('', answer => {
            process.stdin.removeListener('data', onData);
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
    console.log(`\n  Credentials file: ${CREDENTIALS_PATH}\n`);
    if (fs.existsSync(CREDENTIALS_PATH)) {
        const overwrite = await ask('  A credentials file already exists. Overwrite? [y/N] ');
        if (!/^y(es)?$/i.test(overwrite.trim())) {
            console.log('  Left unchanged.');
            rl.close();
            return;
        }
    }

    const email = (await ask('  Jira email: ')).trim();
    const token = (await askHidden('  Jira API token (input hidden): ')).trim();
    rl.close();

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
