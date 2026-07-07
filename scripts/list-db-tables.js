#!/usr/bin/env node
const sqlite3 = require('sqlite3');
const path = process.argv[2];
const db = new sqlite3.Database(path);
db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", (e, r) => {
    if (e) { console.error(e); process.exit(1); }
    console.log(r.map((x) => x.name).join('\n'));
    db.close();
});
