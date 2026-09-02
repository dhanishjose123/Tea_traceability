'use strict';

const fs = require('fs');
const path = require('path');

function mode() {
    return String(process.env.PRELOAD_CACHE_MODE || '').trim().toLowerCase();
}

function isReadMode() {
    return mode() === 'read';
}

function isWriteMode() {
    return mode() === 'write';
}

function isPreloadOnly() {
    return ['1', 'true', 'yes'].includes(String(process.env.PRELOAD_ONLY || '').toLowerCase());
}

function cacheDir() {
    return path.resolve(
        process.env.PRELOAD_CACHE_DIR || path.join(__dirname, '..', 'tmp', 'preload-cache')
    );
}

function safePart(value) {
    return String(value ?? 'none').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function cachePath(parts) {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${parts.map(safePart).join('__')}.json`);
}

function read(parts) {
    const filePath = cachePath(parts);

    if (!fs.existsSync(filePath)) {
        console.warn(`[PRELOAD_CACHE] missing ${filePath}`);
        return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`[PRELOAD_CACHE] read ${Array.isArray(parsed) ? parsed.length : 0} records from ${filePath}`);
    return parsed;
}

function write(parts, data) {
    const filePath = cachePath(parts);
    fs.writeFileSync(filePath, JSON.stringify(data || [], null, 2), 'utf8');
    console.log(`[PRELOAD_CACHE] wrote ${Array.isArray(data) ? data.length : 0} records to ${filePath}`);
}

module.exports = {
    isReadMode,
    isWriteMode,
    isPreloadOnly,
    read,
    write
};
