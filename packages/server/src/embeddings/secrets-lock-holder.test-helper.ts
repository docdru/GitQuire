import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) throw new Error('Missing secrets path');
const db = new DatabaseSync(`${path}.embeddings-lock.sqlite`);
db.exec('BEGIN EXCLUSIVE');
process.stdout.write('READY\n');
setInterval(() => db.isOpen, 1000);
