const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const LOCAL_KEY_PATH = path.join(__dirname, '../data/olt-credential.key');

function getOrCreateLocalKey() {
    if (fs.existsSync(LOCAL_KEY_PATH)) {
        return fs.readFileSync(LOCAL_KEY_PATH, 'utf8').trim();
    }
    const key = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(LOCAL_KEY_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_KEY_PATH, `${key}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(LOCAL_KEY_PATH, 0o600);
    } catch (_) {}
    return key;
}

function getKey() {
    const raw = process.env.OLT_CREDENTIAL_KEY
        || process.env.APP_SECRET
        || process.env.SESSION_SECRET
        || getOrCreateLocalKey();
    if (/^[a-f0-9]{64}$/i.test(raw)) {
        return Buffer.from(raw, 'hex');
    }
    return crypto.createHash('sha256').update(String(raw)).digest();
}

function encryptCredential(value) {
    if (value === undefined || value === null || value === '') return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptCredential(value) {
    if (!value) return null;
    const parts = String(value).split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('Unsupported encrypted credential format');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

function maskCredential(value) {
    if (!value) return '';
    return '********';
}

module.exports = {
    encryptCredential,
    decryptCredential,
    maskCredential
};
