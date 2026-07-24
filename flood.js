// brutal.js
// Upload folder ke banyak repo GitHub secepat mungkin.
// Mode brutal: concurrency tinggi, upload paralel, minim delay.

const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Argumen ---
const args = process.argv.slice(2);
let token = '';
let baseName = 'repo';
let folder = '.';
let isPrivate = false;
let count = 1;
let concurrency = 10; // default agak gila
let delay = 0;        // jeda antar repo (ms), default 0

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--token' && args[i+1]) token = args[++i];
  else if (a === '--name' && args[i+1]) baseName = args[++i];
  else if (a === '--folder' && args[i+1]) folder = args[++i];
  else if (a === '--private') isPrivate = true;
  else if (a === '--count' && args[i+1]) count = parseInt(args[++i], 10) || 1;
  else if (a === '--concurrency' && args[i+1]) concurrency = parseInt(args[++i], 10) || 10;
  else if (a === '--delay' && args[i+1]) delay = parseInt(args[++i], 10) || 0;
  else if (a === '--brutal') { concurrency = 20; delay = 0; } // preset maksa
}

if (!token) {
  console.log('Usage: node brutal.js --token <ghp_xxx> [--name reponame] [--folder ./dir] [--count 5] [--concurrency 10] [--brutal]');
  process.exit(1);
}

// Warna singkat
const c = {
  r: '\x1b[0m',
  g: '\x1b[32m',
  y: '\x1b[33m',
  c: '\x1b[36m',
  d: '\x1b[90m',
};

// Request GitHub
function github(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'brutal-uploader',
        'Content-Type': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Baca semua file (rekursif)
function getAllFiles(dir, ignorePaths) {
  const ignore = new Set(ignorePaths);
  const out = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fp = path.join(dir, item.name);
    if (ignore.has(fp)) continue;
    if (item.isDirectory()) {
      if (item.name === '.git' || item.name === 'node_modules') continue;
      out.push(...getAllFiles(fp, ignorePaths));
    } else {
      out.push(fp);
    }
  }
  return out;
}

// Suffix acak
function randomSuffix() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789.-~';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return '.' + s;
}

// Format ukuran
function fmtSize(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b/1024).toFixed(1)+'KB';
  if (b < 1073741824) return (b/1048576).toFixed(1)+'MB';
  return (b/1073741824).toFixed(2)+'GB';
}

// Upload paralel semua file ke repo
async function uploadFiles(owner, repoName, branch, fileList, baseDir) {
  const tasks = fileList.map(async (absPath) => {
    const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
    const content = await fs.promises.readFile(absPath);
    const b64 = content.toString('base64');
    return github('PUT', `/repos/${owner}/${repoName}/contents/${rel}`, {
      message: `Add ${rel}`,
      content: b64,
      branch: branch,
    });
  });
  await Promise.all(tasks);
}

// Buat 1 repo + upload
async function createRepoWithFiles(owner, baseDir, fileInfos) {
  let repoName = baseName + randomSuffix();
  let repo;
  try {
    repo = await github('POST', '/user/repos', {
      name: repoName,
      private: isPrivate,
      auto_init: true,
    });
  } catch (e) {
    if (e.message.includes('422')) {
      repoName = baseName + randomSuffix();
      repo = await github('POST', '/user/repos', {
        name: repoName,
        private: isPrivate,
        auto_init: true,
      });
    } else throw e;
  }

  // Upload paralel
  if (fileInfos.length > 0) {
    await uploadFiles(owner, repo.name, repo.default_branch, fileInfos.map(f => f.abs), baseDir);
  }
  return { url: repo.html_url, files: fileInfos.length };
}

(async () => {
  try {
    // Cek login
    console.log('Login...');
    const user = await github('GET', '/user');
    const owner = user.login;
    console.log(`${c.g}${owner}${c.r}`);

    // Siapkan daftar file
    const scriptPath = __filename;
    const filePaths = getAllFiles(folder, [scriptPath]);
    const fileInfos = filePaths.map(p => ({ abs: p, size: fs.statSync(p).size }));
    const totalSize = fileInfos.reduce((a,f) => a+f.size, 0);
    console.log(`${filePaths.length} file (${fmtSize(totalSize)}) → ${count} repo`);

    // Antrian repo
    const repoQueue = Array.from({ length: count }, (_, i) => i+1);
    let completed = 0;
    const startTime = Date.now();

    // Worker pool (concurrency)
    const workers = [];
    const runWorker = async () => {
      while (repoQueue.length > 0) {
        const idx = repoQueue.shift();
        try {
          const result = await createRepoWithFiles(owner, folder, fileInfos);
          completed++;
          const elapsed = ((Date.now() - startTime)/1000).toFixed(1);
          console.log(`${c.g}[${completed}/${count}]${c.r} ${result.url} (${elapsed}s)`);
        } catch (e) {
          completed++;
          console.log(`${c.r}Gagal: ${e.message}${c.r}`);
        }
        // jeda antar repo di worker (bisa 0)
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
      }
    };

    // Mulai worker
    for (let i = 0; i < Math.min(concurrency, count); i++) {
      workers.push(runWorker());
    }
    await Promise.all(workers);

    const totalTime = ((Date.now() - startTime)/1000).toFixed(1);
    console.log(`\n${c.g}Berhasil: ${completed} repo dalam ${totalTime}s${c.r}`);
  } catch (e) {
    console.log(`${c.r}Error: ${e.message}${c.r}`);
    process.exit(1);
  }
})();