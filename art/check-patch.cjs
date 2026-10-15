/**
 * 校验 DSH web profile 的 cordis.patch.yml 是否仍能正确解析，
 * 并断言当前期望的条目集合（Agnes 已卸载）。
 *
 * 为什么必须做：这个文件是 DSH 启动时读取的 patch 层，YAML 一旦损坏
 * 可能导致 DSH 起不来。所以每次改动后都用 harness 自己在用的 js-yaml
 * 实测一遍，并断言期望条目仍在、已移除的条目确已消失。
 *
 * 用 .cjs 后缀：本包 package.json 是 "type": "module"，
 * .js 会被当作 ESM 而拿不到 require。
 *
 * 用法：
 *   node art/check-patch.cjs
 *   node art/check-patch.cjs --patch "<profile>/cordis.patch.yml" --yaml "<profile>/node_modules/js-yaml"
 *
 * 路径定位（默认值不硬编码任何个人目录）：
 *   patch 文件：--patch > 环境变量 DSH_PATCH_FILE
 *               > (--profile 或 DSH_PROFILE_DIR / DSH_WEB_PROFILE) 下的 cordis.patch.yml
 *               > %APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml
 *   js-yaml ：--yaml > 环境变量 DSH_JS_YAML
 *               > patch 同侧的 node_modules/js-yaml > 逐级 require.resolve('js-yaml')
 * 找不到时打印「尝试过哪些位置」并以退出码 2 失败，绝不静默通过。
 */
const fs = require('fs')
const path = require('path')

const PKG = 'dsh-pet-guardian-dragon'

function fail(msg) {
  console.error('FAIL: ' + msg)
  process.exit(2)
}

function parseArgv(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--patch' || a === '--yaml' || a === '--profile') {
      const v = argv[i + 1]
      if (v === undefined) fail(`参数 ${a} 缺少取值`)
      opts[a.slice(2)] = v
      i += 1
    } else if (a === '--help' || a === '-h') {
      console.log('usage: node art/check-patch.cjs [--patch <file>] [--yaml <dir>] [--profile <dir>]')
      process.exit(0)
    } else {
      fail(`未知参数：${a}`)
    }
  }
  return opts
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 返回 { file, tried }；tried 用于缺路径时给出可操作的报错。 */
function resolvePatch(opts) {
  const tried = []
  const take = (p) => {
    tried.push(p)
    return isFile(p) ? p : null
  }
  if (opts.patch) return { file: take(opts.patch), tried }
  if (process.env.DSH_PATCH_FILE) return { file: take(process.env.DSH_PATCH_FILE), tried }
  const profileDir = opts.profile || process.env.DSH_PROFILE_DIR || process.env.DSH_WEB_PROFILE
  if (profileDir) return { file: take(path.join(profileDir, 'cordis.patch.yml')), tried }
  if (process.env.APPDATA) {
    return {
      file: take(path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web', 'cordis.patch.yml')),
      tried,
    }
  }
  return { file: null, tried }
}

/** 返回 { dir, tried }。 */
function resolveYaml(opts, patchFile) {
  const tried = []
  if (opts.yaml) {
    tried.push(opts.yaml)
    return { dir: opts.yaml, tried }
  }
  if (process.env.DSH_JS_YAML) {
    tried.push(process.env.DSH_JS_YAML)
    return { dir: process.env.DSH_JS_YAML, tried }
  }

  const bases = []
  if (patchFile) bases.push(path.dirname(patchFile))
  const profileDir = opts.profile || process.env.DSH_PROFILE_DIR || process.env.DSH_WEB_PROFILE
  if (profileDir) bases.push(profileDir)
  bases.push(path.resolve(__dirname, '..'), process.cwd())

  for (const base of bases) {
    const cand = path.join(base, 'node_modules', 'js-yaml')
    tried.push(cand)
    if (fs.existsSync(cand)) return { dir: cand, tried }
  }
  for (const base of bases) {
    tried.push(`require.resolve('js-yaml', { paths: ['${base}'] })`)
    try {
      return { dir: require.resolve('js-yaml', { paths: [base] }), tried }
    } catch {
      /* 继续尝试下一个基准目录 */
    }
  }
  return { dir: null, tried }
}

const opts = parseArgv(process.argv.slice(2))

const patch = resolvePatch(opts)
if (!patch.file) {
  fail(
    '找不到 cordis.patch.yml。尝试过的位置：\n  - ' +
      (patch.tried.join('\n  - ') || '(无可用候选)') +
      '\n请用 --patch <文件>，或设置 DSH_PROFILE_DIR / DSH_PATCH_FILE。'
  )
}

const yamlRes = resolveYaml(opts, patch.file)
if (!yamlRes.dir) {
  fail(
    '找不到 js-yaml。尝试过的位置：\n  - ' +
      (yamlRes.tried.join('\n  - ') || '(无可用候选)') +
      '\n请用 --yaml <目录>，或设置 DSH_JS_YAML。'
  )
}

let yaml
try {
  yaml = require(yamlRes.dir)
} catch (e) {
  fail(`js-yaml 载入失败（${yamlRes.dir}）：${e && e.message}`)
}

console.log('patch  =', patch.file)
console.log('js-yaml=', yamlRes.dir)

const text = fs.readFileSync(patch.file, 'utf8')
const doc = yaml.load(text)

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === undefined ? '' : ' -> ' + detail}`)
}

if (!Array.isArray(doc)) {
  console.error('FAIL: 顶层不是数组，实际是 ' + typeof doc)
  process.exit(1)
}
console.log('top-level: array, entries =', doc.length)

// 顶层 id 条目
const topIds = doc.filter((e) => e && typeof e === 'object' && typeof e.id === 'string').map((e) => e.id)
console.log('top-level ids =', JSON.stringify(topIds))

// insert 列表里的行
const insertRows = doc
  .filter((e) => e && typeof e === 'object' && Array.isArray(e.insert))
  .flatMap((e) => e.insert)
const insertIds = insertRows.map((r) => r && r.id)
console.log('insert row ids =', JSON.stringify(insertIds))

console.log('\n断言：')
check('每行 insert 都带字符串 id/name', insertRows.every((r) => r && typeof r.id === 'string' && typeof r.name === 'string'))
check('桌宠条目已就位', insertIds.includes(PKG))
check('原有 agent-default-model 未被破坏', topIds.includes('agent-default-model'))
check('原有 permission 未被破坏', topIds.includes('permission'))
check('Agnes 注册行已移除', !/(^|["'])agnes-image(["']|$)/.test(text) && !insertIds.includes('agnes-image'))
check('文件内不再出现 agnes', !/agnes/i.test(text))

console.log(`\n${failures === 0 ? 'OK: cordis.patch.yml 解析通过，条目符合预期，Agnes 已彻底移除' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
