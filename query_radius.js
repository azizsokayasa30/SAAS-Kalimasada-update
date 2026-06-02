const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data/radius.db', (err) => {
    if (err) console.error('Error opening db', err);
});
db.all('SELECT * FROM radgroupreply', (err, rows) => {
    console.log('radgroupreply:', rows ? rows.length : err);
});
db.all('SELECT * FROM radcheck', (err, rows) => {
    console.log('radcheck:', rows ? rows.length : err);
});
