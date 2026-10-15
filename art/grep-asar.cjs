/**
 * 在 app.asar 里搜索一个字符串并打印上下文。
 *
 * 用途：核实 DSH 客户端 slot 的真实声明（例如 shell.overlay 的
 * cardinality / scope）。仓库里没有 DSH 源码检出，GitHub API 又限流，
 * 但本机安装目录里的 app.asar 就是构建好的 bundle，可以直接查。
 *
 * 用法：node grep-asar.cjs <searchTerm> [contextChars] [maxHits] [--asar <path>]
 *
 * asar 路径定位（默认值不硬编码任何个人目录）：
 *   --asar <文件> > 环境变量 DSH_ASAR
 *   > %LOCALAPPDATA%\Programs\DSH Desktop\resources\app.asar
 *   > %ProgramFiles%\DSH Desktop\resources\app.asar
 *   > %ProgramFiles(x86)%\DSH Desktop\resources\app.asar
 * 候选只有「真的能打开读取」才算可用：受限沙箱下 stat 可能成功而 open 被拒
 * （ENOENT / EACCES），这类候选会被单独列出，避免把「读不了」误报成「不存在」。
 * 全部不可用时打印尝试过的位置与原因，退出码 2。
 */
const fs = require('fs')
const path = require('path')

function usage(code) {
  console.error('usage: node grep-asar.cjs <term> [context] [maxHits] [--asar <path>]')
  process.exit(code)
}

function asarCandidates() {
  const cands = []
  if (process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app.asar'))
  }
  for (const env of ['ProgramFiles', 'ProgramFiles(x86)', 'PROGRAMFILES', 'PROGRAMW6432']) {
    if (process.env[env]) {
      cands.push(path.join(process.env[env], 'DSH Desktop', 'resources', 'app.asar'))
    }
  }
  return [...new Set(cands)]
}

/** 探测单个候选：只有能真正 open 才算可用；否则把原因记进 unusable。 */
function probeAsar(p, unusable) {
  try {
    fs.statSync(p)
  } catch {
    return false // 真的不存在，不算「存在但读不了」
  }
  let fd
  try {
    fd = fs.openSync(p, 'r')
  } catch (e) {
    unusable.push(`${p} —— 存在但无法读取（${(e && e.code) || 'unknown'}），通常是沙箱/权限限制`)
    return false
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) {
      unusable.push(`${p} —— 可打开但不是普通文件`)
      return false
    }
    if (st.size === 0) {
      unusable.push(`${p} —— 可打开但长度为 0（疑似受限环境给出的空壳）`)
      return false
    }
    return true
  } finally {
    fs.closeSync(fd)
  }
}

/** 返回 { file, tried, unusable }。 */
function resolveAsar(explicit) {
  const tried = []
  const unusable = []

  if (explicit) {
    tried.push(explicit)
    return { file: probeAsar(explicit, unusable) ? explicit : null, tried, unusable }
  }
  if (process.env.DSH_ASAR) {
    const p = process.env.DSH_ASAR
    tried.push(`${p} —— 环境变量 DSH_ASAR`)
    if (probeAsar(p, unusable)) return { file: p, tried, unusable }
  }
  for (const cand of asarCandidates()) {
    tried.push(cand)
    if (probeAsar(cand, unusable)) return { file: cand, tried, unusable }
  }
  return { file: null, tried, unusable }
}

const positional = []
let asarArg = null
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--asar') {
      asarArg = argv[i + 1]
      if (asarArg === undefined) usage(2)
      i += 1
    } else if (a === '--help' || a === '-h') {
      usage(0)
    } else if (a.startsWith('--')) {
      console.error('unknown option: ' + a)
      usage(2)
    } else {
      positional.push(a)
    }
  }
}

const term = positional[0]
const ctx = Number(positional[1] || 260)
const maxHits = Number(positional[2] || 4)
if (!term) usage(2)

const resolved = resolveAsar(asarArg)
if (!resolved.file) {
  const lines = ['FAIL: 找不到可读取的 app.asar。']
  if (resolved.unusable.length > 0) {
    lines.push('存在但读不了的候选：')
    for (const u of resolved.unusable) lines.push('  ! ' + u)
  }
  lines.push('尝试过的位置：')
  if (resolved.tried.length === 0) lines.push('  （无可用候选：环境变量缺失）')
  for (const t of resolved.tried) lines.push('  - ' + t)
  lines.push('请用 --asar <文件> 指定一个可读的 app.asar，或设置环境变量 DSH_ASAR。')
  lines.push('提示：受限沙箱常会拒绝读取安装目录下的文件（stat 成功但 open 报 ENOENT/EACCES），此时需要在可读该文件的权限下运行本脚本。')
  console.error(lines.join('\n'))
  process.exit(2)
}
const ASAR = resolved.file

const buf = fs.readFileSync(ASAR)
console.log('asar:', ASAR)
console.log('asar bytes:', buf.length, ' searching:', JSON.stringify(term))

let from = 0
let hits = 0
let total = 0
while (hits < maxHits) {
  const at = buf.indexOf(term, from, 'utf8')
  if (at < 0) break
  total++
  const start = Math.max(0, at - ctx)
  const end = Math.min(buf.length, at + term.length + ctx)
  const snippet = buf.toString('utf8', start, end).replace(/\s+/g, ' ')
  console.log('\n--- hit @' + at + ' ---')
  console.log(snippet)
  from = at + term.length
  hits++
}
console.log('\ntotal occurrences found (capped):', total, ' printed:', hits)
