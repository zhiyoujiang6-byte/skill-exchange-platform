'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const files = ['index.html', 'styles.css', 'app.js', 'config.js'];
const destination = path.join(__dirname, 'public');

async function build() {
  // Read every source first, so a missing file cannot leave a partial build.
  const content = await Promise.all(files.map(file => fs.readFile(path.join(__dirname, file))));
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(files.map((file, index) => fs.writeFile(path.join(destination, file), content[index])));
  console.log('Built public frontend: ' + files.join(', '));
}

build().catch(err => { console.error(err.message); process.exitCode = 1; });
