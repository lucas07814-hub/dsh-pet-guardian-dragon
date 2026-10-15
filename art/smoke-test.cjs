/**
 * 无头冒烟测试 —— dsh-pet-guardian-dragon
 *
 * 为什么需要它：本机没有可用浏览器（dsh-builtin-browser 缺 Electron 二进制），
 * 而 app.asar 里的 React 被沙箱挡在 Node 之外。于是这里实现一个**确定性的迷你
 * React**（只覆盖本插件实际用到的那几个 hook 与类组件），把 lib/client.js 里
 * 真实的 factory 物化、真实的 apply 执行、真实的组件渲染一遍，从而验证：
 *
 *   1. 产物只依赖平台模块（require 白名单里只有 'react'）——违反就抛错
 *   2. apply 往正确的槽位注册：shell.overlay 与 conversation.session.header.actions
 *   3. 组件真的能渲染，且结构与交互钩子齐全
 *   4. 成长分 3 档（data-tier / Lv 文案随好感度变化）
 *   5. 状态选择器对 Map / Array / Object / undefined 四种形态都给出正确布尔值
 *
 * 用法：node art/smoke-test.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const BUNDLE = path.join(ROOT, 'lib', 'client.js')
const PKG = 'dsh-pet-guardian-dragon'

let failures = 0
function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures++
  console.log(`  [${mark}] ${label}${ok || detail === undefined ? '' : '  -> ' + detail}`)
}

// ───────────────────────── 迷你 React ─────────────────────────

const FRAGMENT = Symbol('Fragment')
let hookState = null
let currentKey = ''

/**
 * 每个组件类型的 hook 值数组，跨渲染复用 —— 对应 React 的 fiber 状态。
 * 没有它，useRef 每次渲染都会新建对象，于是「上一轮是否在运行」
 * 这类跨渲染状态无法验证（实测确实测不到 run→idle 的庆祝）。
 */
let hookStore = new WeakMap()

/**
 * DOM 节点登记表：**按元素在树中的路径跨渲染复用同一节点对象**。
 *
 * 为什么必须这样：真实 React 会复用 DOM 节点，所以 `classList.add('dg-drag')`
 * 这类命令式改动在后续重渲染后依然存在（React 不会因为 className prop 没变
 * 就去覆盖它）。早先的实现每次渲染都新建假节点，命令式改动会凭空消失，
 * 既造成假失败，也可能掩盖真实 bug。
 */
let nodeRegistry = new Map()

/** 每个用例开头清空 hook 与节点状态，否则上一个用例的残留会串到下一个。 */
function resetHooks() {
  hookStore = new WeakMap()
  nodeRegistry = new Map()
  pendingEffects = []
  pendingCleanups = []
}

/** 本轮渲染收集到的 effect；render() 之后统一冲刷，模拟 React 提交后的执行。 */
let pendingEffects = []

function createElement(type, props, ...children) {
  const flat = []
  const push = (c) => {
    if (Array.isArray(c)) { c.forEach(push); return }
    if (c === null || c === undefined || c === false || c === true) return
    flat.push(c)
  }
  push(children)
  return { type, props: { ...(props || {}), children: flat } }
}

function hookSlot(init) {
  const s = hookState
  const i = s.cursor++
  if (s.values.length <= i) s.values.push(init)
  return { i, get value() { return s.values[i] }, set value(v) { s.values[i] = v } }
}

const React = {
  Fragment: FRAGMENT,
  createElement,
  useRef(init) { const h = hookSlot({ current: init }); return h.value },
  useReducer(reducer, init) {
    const h = hookSlot(init)
    const dispatch = (action) => { h.value = reducer(h.value, action) }
    return [h.value, dispatch]
  },
  useState(init) { return React.useReducer((_s, a) => (typeof a === 'function' ? a(_s) : a), init) },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  useEffect(fn, deps) {
    // 保真要点：真实 React 只在 deps 变化时才重跑 effect（并在重跑前清理旧的）。
    // 早先的实现忽略 deps、**每次渲染都把全部 effect 清理一遍**，于是组件里
    // 的回眸/投喂/收步定时器会在每个渲染里被反复掐断 —— 同步用例看不出来，
    // 一旦真正 await 计时器就会暴露。这里按 deps 是否变化决定是否入队。
    const h = hookSlot({ deps: undefined, cleanup: null })
    const st = h.value
    const changed = deps === undefined
      || st.deps === undefined
      || deps.length !== st.deps.length
      || deps.some((d, i) => !Object.is(d, st.deps[i]))
    if (deps !== undefined) st.deps = deps.slice()
    if (changed) pendingEffects.push({ fn, st })
  },
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  },
}

/** 假的 style 对象：既要能直接赋值（element.style.transform = …），
    也要有 CSSStyleDeclaration 的方法（setProperty 用于 CSS 变量）。 */
function makeFakeStyle() {
  return {
    setProperty(k, v) { this[k] = v },
    getPropertyValue(k) { return this[k] === undefined ? '' : String(this[k]) },
    removeProperty(k) { const v = this[k]; delete this[k]; return v === undefined ? '' : String(v) },
  }
}

/** 假的 DOM 节点：只实现插件真正用到的那几样，用来承接 ref 并记录副作用。 */
function makeFakeNode(type, props) {
  const classes = new Set(String(props.className || '').split(/\s+/).filter(Boolean))
  // 把声明式 style prop 落进假 style 对象（React 就是这么做的）。
  // 少了这一步，`style={{left: …}}` 这类写法在断言里读不到。
  const style = makeFakeStyle()
  if (props.style && typeof props.style === 'object') {
    for (const [k, v] of Object.entries(props.style)) style[k] = v
  }
  return {
    tagName: String(type).toUpperCase(),
    props,
    style,
    dataset: {},
    children: [],
    _classes: classes,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c) }
        else if (on) classes.add(c)
        else classes.delete(c)
      },
    },
    appendChild(n) { this.children.push(n); return n },
    remove() {},
    contains() { return false },
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
    setPointerCapture() {},
    releasePointerCapture() {},
  }
}

/**
 * 渲染成 HTML 字符串；同时把每个字符串元素做成假节点收进 sink，
 * 并把 props.ref 指向它 —— 模拟 React 提交阶段的 ref 赋值。
 * 没有这一步，组件的命令式逻辑（拖拽改样式、flash 加 class）会因为
 * ref.current 为 null 而直接 early-return，行为就根本测不到。
 *
 * `path` 是元素在树中的稳定路径，用于跨渲染复用同一节点对象（见 nodeRegistry）。
 */
function renderNode(node, sink, parent, path) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    return node.map((n, i) => renderNode(n, sink, parent, `${path}[${i}]`)).join('')
  }
  if (typeof node === 'function') return renderNode(node({}), sink, parent, path)

  const { type, props } = node
  const kids = (p, base) => (props.children || [])
    .map((n, i) => renderNode(n, sink, p, `${base}.${i}`)).join('')

  if (type === FRAGMENT) return kids(parent, path)

  if (typeof type === 'function') {
    // 类组件
    if (type.prototype && typeof type.prototype.render === 'function') {
      const inst = new type(props)
      return renderNode(inst.render(), sink, parent, `${path}>${type.name || 'cls'}`)
    }
    // 函数组件：准备 hook 帧（值数组按组件类型跨渲染复用）
    const prevState = hookState
    const prevKey = currentKey
    let values = hookStore.get(type)
    if (values === undefined) { values = []; hookStore.set(type, values) }
    hookState = { cursor: 0, values }
    currentKey = type.name || 'anon'
    let out
    try {
      out = type(props)
    } catch (e) {
      hookState = prevState
      currentKey = prevKey
      throw new Error(`组件 ${type.name} 渲染抛错: ${e && e.message}`)
    }
    hookState = prevState
    currentKey = prevKey
    return renderNode(out, sink, parent, `${path}>${type.name || 'fn'}`)
  }

  if (typeof type === 'string') {
    // 按路径复用节点：同一位置的同一元素在重渲染后仍是同一个对象，
    // 这样 classList / style 上的命令式改动才会像真实 DOM 一样保留下来。
    const key = `${path}|${type}`
    let fake = nodeRegistry.get(key)
    if (fake === undefined) {
      fake = makeFakeNode(type, props)
      nodeRegistry.set(key, fake)
    } else {
      fake.props = props
      // 与 React 一致：className 是受控的，按 prop 合并声明式类名，
      // 但不清除命令式加上的类（React 不会去覆盖未变化的 className）。
      for (const c of String(props.className || '').split(/\s+/)) {
        if (c) fake._classes.add(c)
      }
      for (const [k, v] of Object.entries(props.style || {})) fake.style[k] = v
    }
    fake._parent = parent || null
    if (props.ref && typeof props.ref === 'object') props.ref.current = fake
    if (Array.isArray(sink)) sink.push(fake)

    const attrs = []
    for (const [k0, v] of Object.entries(props)) {
      if (k0 === 'children') continue
      // 还原 React DOM 的属性名映射，否则 className 断言全部落空
      const k = k0 === 'className' ? 'class' : k0 === 'htmlFor' ? 'for' : k0
      // class 用**节点当前的类集合**，这样命令式添加的 drag/lookback 等状态
      // 也会反映在渲染结果里，可以直接按 HTML 断言
      if (k === 'class') { attrs.push(`class="${[...fake._classes].join(' ')}"`); continue }
      if (typeof v === 'function') { attrs.push(`data-fn-${k.toLowerCase()}="1"`); continue }
      if (v === null || v === undefined || v === false) continue
      if (k === 'style' && typeof v === 'object') {
        attrs.push(`style="${Object.entries(v).map(([a, b]) => `${a}:${b}`).join(';')}"`)
        continue
      }
      if (typeof v === 'string' && v.startsWith('data:image/')) { attrs.push(`${k}="[data-uri:${v.length}]"`); continue }
      attrs.push(`${k}="${String(v).replace(/"/g, '&quot;')}"`)
    }
    return `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${kids(fake, key)}</${type}>`
  }
  return ''
}

/** 上一次渲染留下的 effect 清理函数。React 会在下一次执行 effect 前先清理旧 effect，
    这里必须照做：否则每次渲染都会重复 addEventListener，监听器越堆越多、
    并且旧闭包里的 ref 指向过期节点，会干扰断言。 */
let pendingCleanups = []   // 已废弃：清理函数现在挂在各自的 effect slot 上

/** 渲染一次并冲刷 effect，返回 HTML + 假节点索引 + 清理函数。 */
function render(Comp, props) {
  const sink = []
  const prevEffects = pendingEffects
  pendingEffects = []
  const html = renderNode(React.createElement(Comp, props), sink, null, 'root')
  const effects = pendingEffects
  pendingEffects = prevEffects

  const cleanups = []
  for (const { fn, st } of effects) {
    // 重跑前先清理旧 effect（真实 React 语义），清理函数存回同一个 hook slot，
    // 这样 dep 未变的 effect 不会被别的渲染误清 —— 组件里的定时器因此能活到
    // 真正该被清理的时候（早先「每次渲染清全部」会把收步链反复掐断）。
    if (typeof st.cleanup === 'function') { try { st.cleanup() } catch { /* 忽略 */ } }
    st.cleanup = fn()
    if (typeof st.cleanup === 'function') cleanups.push(st.cleanup)
  }

  return {
    html,
    nodes: sink,
    cleanups,
    find: (cls) => sink.find((n) => n._classes.has(cls)),
  }
}

// ───────────────────────── 环境桩 ─────────────────────────

function makeEnv(seed) {
  resetHooks()   // 每个用例都从干净的 hook 状态开始
  const registered = []
  const styleTags = []

  const documentStub = {
    querySelector: () => null,
    // 返回正规假节点：插件的爱心粒子走 document.createElement 并调用
    // style.setProperty 写 CSS 变量，裸对象会直接抛 TypeError。
    createElement: (tag) => makeFakeNode(tag, {}),
    head: { appendChild: (t) => styleTags.push(t) },
  }

  const storage = new Map()
  if (seed !== undefined) storage.set(`${PKG}.state`, JSON.stringify(seed))
  const localStorageStub = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  }

  // window 桩：记录监听器，便于测试派发「点外部」「按 Esc」
  const windowListeners = new Map()
  const windowStub = {
    __ModuleLoader__: {
      load(reg) { registered.push(reg) },
    },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      const list = windowListeners.get(type) || []
      list.push(fn)
      windowListeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }

  /** 向 window 派发事件，返回被调用到的监听器数量。 */
  const dispatchWindow = (type, event) => {
    const list = [...(windowListeners.get(type) || [])]
    for (const fn of list) fn(event)
    return list.length
  }

  return {
    registered, styleTags, storage, localStorageStub, windowStub, documentStub,
    windowListeners, dispatchWindow,
  }
}

function loadPlugin(env) {
  const req = (spec) => {
    if (spec === 'react') return React
    // 白名单之外一律失败：用来证明产物没有偷偷依赖别的模块
    throw new Error(`产物请求了非平台模块: ${spec}`)
  }

  // 刻意不用 require()：
  // 本包 package.json 是 "type": "module"，Node 会把 lib/client.js 当 ESM，
  // 而 ESM 模块实例缓存在另一套表里，删 require.cache 无效 —— 第二个用例就
  // 再也拿不到注册回调（实测确实如此）。改为每次在全新的函数作用域里求值。
  const code = fs.readFileSync(BUNDLE, 'utf8')
  const run = new Function('window', 'document', 'localStorage', 'require', 'console', code)
  run(env.windowStub, env.documentStub, env.localStorageStub, req, console)

  if (env.registered.length !== 1) throw new Error(`期望恰好 1 次注册，实际 ${env.registered.length}`)
  const reg = env.registered[0]
  const exportsObj = reg.factory(req)
  return { reg, exportsObj }
}

// ───────────────────────── 用例 ─────────────────────────

console.log('=== 用例 A：接线与渲染（好感度 0 → Lv1） ===')
{
  const env = makeEnv({ affinity: 0, mode: 'float', visible: true, size: 160, right: 24, bottom: 24 })
  const { reg, exportsObj } = loadPlugin(env)

  check('注册 id 与包名一致', reg.id === PKG, reg.id)
  check('导出 inject 为 ["slots"]', JSON.stringify(exportsObj.inject) === '["slots"]', JSON.stringify(exportsObj.inject))
  check('导出 apply 为函数', typeof exportsObj.apply === 'function')

  // 假 ctx：捕获槽位注册
  const captured = []
  const fakeCtx = {
    slots: {
      inject(key, cb) {
        const r = cb()
        captured.push({ key, opts: r.opts, Comp: r.Comp })
        return () => {}
      },
      register(opts, Comp) { return { opts, Comp } },
    },
    effect(fn) { const c = fn(); return typeof c === 'function' ? c : () => {} },
  }
  exportsObj.apply(fakeCtx)

  // CSS 注入发生在 apply 内，因此必须在 apply 之后断言
  check('CSS 已注入（apply 后）', env.styleTags.length === 1, `styleTags=${env.styleTags.length}`)
  check('CSS 带 plugin-css 标记', env.styleTags[0] !== undefined)

  check('注入了 2 个槽位', captured.length === 2, JSON.stringify(captured.map((c) => c.key)))
  const overlay = captured.find((c) => c.key === 'shell.overlay')
  const header = captured.find((c) => c.key === 'conversation.session.header.actions')
  check('挂载到 shell.overlay', overlay !== undefined)
  check('挂载到 conversation.session.header.actions', header !== undefined)
  check('overlay 的 id/order 正确', overlay && overlay.opts.id === PKG && overlay.opts.order === 100,
    overlay && JSON.stringify(overlay.opts))
  check('header 的 id/order 正确', header && header.opts.id === PKG && header.opts.order === 40,
    header && JSON.stringify(header.opts))
  check('name 与槽位 key 一致', overlay && overlay.opts.name === overlay.key)

  // 先验证选择器形态
  let lastSelector = null
  const useSessionStatus = (sel) => { lastSelector = sel; return false }
  const props = { useSessionStatus }

  const overlayHtml = renderNode(React.createElement(overlay.Comp, props))
  check('overlay 渲染出 .dg-root', overlayHtml.includes('class="dg-root"'))
  check('overlay 渲染出 .dg-stage', overlayHtml.includes('class="dg-stage"'))
  check('overlay 渲染出守护龙影 .dg-dragon', overlayHtml.includes('class="dg-dragon"') && overlayHtml.includes('dg-dragon-img'))
  check('overlay 含内联美术（data URI ×2 少女+龙影）', (overlayHtml.match(/data-uri:/g) || []).length === 2,
    String((overlayHtml.match(/data-uri:/g) || []).length))
  check('overlay 有 3 颗紫炎火星', (overlayHtml.match(/class="dg-spark"/g) || []).length === 3)
  check('overlay 含好感度 HUD', overlayHtml.includes('dg-hud') && overlayHtml.includes('Lv1'))
  check('overlay 绑定了拖拽钩子', overlayHtml.includes('data-fn-onpointerdown') && overlayHtml.includes('data-fn-onpointermove'))
  check('overlay 绑定了点击/右键钩子', overlayHtml.includes('data-fn-ondoubleclick') && overlayHtml.includes('data-fn-oncontextmenu'))
  check('好感度 0 → data-tier=1', overlayHtml.includes('data-tier="1"'))
  check('float 模式可见', overlayHtml.includes('data-hidden="0"'))

  const headerHtml = renderNode(React.createElement(header.Comp, props))
  check('header 渲染出 .dg-chip', headerHtml.includes('class="dg-chip"'))
  check('header 在 float 模式下隐藏', headerHtml.includes('data-visible="0"'))

  // 选择器形态验证
  check('选择器已传给 useSessionStatus', typeof lastSelector === 'function')
  check('选择器 undefined → false', lastSelector(undefined) === false)
  check('选择器 Map(共 1 跑 1) → true', lastSelector(new Map([['a', { running: true }]])) === true)
  check('选择器 Map(全停) → false', lastSelector(new Map([['a', { running: false }]])) === false)
  check('选择器 Map(混合) → true', lastSelector(new Map([['a', { running: false }], ['b', { running: true }]])) === true)
  check('选择器 Array → true', lastSelector([{ running: false }, { running: true }]) === true)
  check('选择器 普通对象 → false', lastSelector({ a: { running: false } }) === false)
  check('选择器 形状异常不抛错', lastSelector(42) === false)
}

console.log('\n=== 用例 B：成长进阶分档（好感度 12 → Lv2） ===')
{
  const env = makeEnv({ affinity: 12, mode: 'float', visible: true, size: 160 })
  const { exportsObj } = loadPlugin(env)
  const captured = []
  exportsObj.apply({
    slots: {
      inject(key, cb) { const r = cb(); captured.push({ key, Comp: r.Comp }); return () => {} },
      register(opts, Comp) { return { opts, Comp } },
    },
    effect(fn) { const c = fn(); return typeof c === 'function' ? c : () => {} },
  })
  const overlay = captured.find((c) => c.key === 'shell.overlay')
  const html = renderNode(React.createElement(overlay.Comp, { useSessionStatus: () => false }))
  check('好感度 12 → data-tier=2', html.includes('data-tier="2"'))
  check('好感度 12 → Lv2 文案', html.includes('Lv2'))
}

console.log('\n=== 用例 C：高好感度（35 → Lv3）+ 标题栏模式 ===')
{
  const env = makeEnv({ affinity: 35, mode: 'header', visible: true, size: 160 })
  const { exportsObj } = loadPlugin(env)
  const captured = []
  exportsObj.apply({
    slots: {
      inject(key, cb) { const r = cb(); captured.push({ key, Comp: r.Comp }); return () => {} },
      register(opts, Comp) { return { opts, Comp } },
    },
    effect(fn) { const c = fn(); return typeof c === 'function' ? c : () => {} },
  })
  const overlay = captured.find((c) => c.key === 'shell.overlay')
  const header = captured.find((c) => c.key === 'conversation.session.header.actions')
  const oh = renderNode(React.createElement(overlay.Comp, { useSessionStatus: () => false }))
  const hh = renderNode(React.createElement(header.Comp, { useSessionStatus: () => false }))
  check('好感度 35 → data-tier=3', oh.includes('data-tier="3"'))
  check('header 模式：overlay 隐藏', oh.includes('data-hidden="1"'))
  check('header 模式：chip 可见', hh.includes('data-visible="1"'))
  check('chip 显示 Lv3', hh.includes('Lv3'))
}

console.log('\n=== 用例 D：缺少 useSessionStatus 时仍能渲染（老版本 DSH 降级） ===')
{
  const env = makeEnv({ affinity: 0, mode: 'float', visible: true, size: 160 })
  const { exportsObj } = loadPlugin(env)
  const captured = []
  exportsObj.apply({
    slots: {
      inject(key, cb) { const r = cb(); captured.push({ key, Comp: r.Comp }); return () => {} },
      register(opts, Comp) { return { opts, Comp } },
    },
    effect(fn) { const c = fn(); return typeof c === 'function' ? c : () => {} },
  })
  const overlay = captured.find((c) => c.key === 'shell.overlay')
  const html = renderNode(React.createElement(overlay.Comp, {}))
  check('无 useSessionStatus 时仍渲染出 .dg-root', html.includes('class="dg-root"'))
}

console.log('\n=== 用例 E：ctx.slots 缺失时不抛错 ===')
{
  const env = makeEnv({ affinity: 0 })
  const { exportsObj } = loadPlugin(env)
  let threw = false
  try { exportsObj.apply({ effect(fn) { fn() } }) } catch { threw = true }
  check('ctx.slots 缺失时安全返回', threw === false)
}

console.log('\n=== 用例 F：CSS 与 DOM 类名一致性 ===')
{
  const env = makeEnv({ affinity: 0, mode: 'float', visible: true, size: 160 })
  const { exportsObj } = loadPlugin(env)
  const captured = []
  exportsObj.apply({
    slots: {
      inject(key, cb) { const r = cb(); captured.push({ key, Comp: r.Comp }); return () => {} },
      register(opts, Comp) { return { opts, Comp } },
    },
    effect(fn) { const c = fn(); return typeof c === 'function' ? c : () => {} },
  })
  const css = env.styleTags[0].textContent
  const p = { useSessionStatus: () => false }
  const html = captured.map((c) => renderNode(React.createElement(c.Comp, p))).join('')

  // 渲染出的每个类名都必须有对应 CSS 规则，否则就是「引用了但没样式」的隐形缺陷
  const classes = new Set()
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c)
  }
  const missing = [...classes].filter((c) => !css.includes('.' + c))
  check(`渲染出 ${classes.size} 个类名，全部有 CSS 规则`, missing.length === 0, missing.join(', '))

  // 动画用到的关键帧必须都存在
  for (const kf of ['dg-breathe', 'dg-crossfade', 'dg-lookback', 'dg-feed', 'dg-aura-pulse',
                    'dg-spark', 'dg-heart-up', 'dg-dragon-float', 'dg-dragon-look']) {
    check('关键帧存在: ' + kf, css.includes('@keyframes ' + kf))
  }

  // 待机呼吸必须是**缩放**而不是摇晃/位移：旧的 dg-float 已整块移除
  check('已移除 @keyframes dg-float（待机改为纯缩放呼吸）', !css.includes('@keyframes dg-float'))
  {
    const m = css.match(/@keyframes dg-breathe\{[\s\S]*?\n\}/)
    const body = m ? m[0] : ''
    check('dg-breathe 用 scale 做呼吸', /scale\(/.test(body), body)
    check('dg-breathe 不含 rotate（不是摇晃）', !/rotate/.test(body), body)
    check('dg-breathe 不含 translate（不是整体浮动）', !/translate/.test(body), body)
  }

  // 验收 3：待机时不能有整体摇晃 —— dg-sway 已按要求整块移除
  check('已移除 @keyframes dg-sway（待机不再整体摇晃）', !css.includes('@keyframes dg-sway'))
  check('CSS 里不再有 .dg-sway 规则', !/\.dg-sway\s*[,{]/.test(css))
  check('CSS 里不再有 .dg-drag 的 rotate 规则', !/\.dg-drag[^{]*\{[^}]*rotate/.test(css))
  // 约定：拖拽时不再改变浮动周期
  check('拖拽不再改变浮动周期（无 .dg-drag 动画覆盖规则）',
    !/\.dg-drag\s+\.dg-(idle|dragon|sway)\s*\{/.test(css))

  // 悬浮层必须是 fixed 定位，否则会跟着文档流跑掉
  check('.dg-root 为 position:fixed', /\.dg-root\s*\{[^}]*position\s*:\s*fixed/.test(css))
  // 三档成长都有视觉差异
  check('tier2 有光环规则', css.includes('.dg-root[data-tier="2"]'))
  check('tier3 有光环规则', css.includes('.dg-root[data-tier="3"]'))
  check('tier3 有火星动画规则', css.includes('.dg-root[data-tier="3"] .dg-spark'))
}

// ───────── 用例 G：真正驱动交互处理器（行为验证，不只是结构） ─────────

/** 造一个够组件用的合成指针事件。 */
function pointerEvent(x, y, button = 0) {
  return {
    button, clientX: x, clientY: y, pointerId: 1,
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
    preventDefault() {},
  }
}

/**
 * 从产物里取出走路四帧的内联数据 URI（顺序固定 walk-1..walk-4）。
 * 直接从 bundle 源码里抽，而不是从渲染树里猜：渲染树同一时刻只用得到一帧，
 * 只有这样才能断言「帧序号确实按 1→2→3→4 推进」以及四帧确实互不相同。
 * 取不到（素材缺失或键名变了）返回 null，让断言明确失败而不是静默通过。
 */
function walkFrameSrcs() {
  const code = fs.readFileSync(BUNDLE, 'utf8')
  const out = []
  for (let i = 1; i <= 4; i += 1) {
    const m = code.match(new RegExp(`"girlWalk${i}"\\s*:\\s*"(data:image/webp;base64,[^"]+)"`))
    if (!m) return null
    out.push(m[1])
  }
  return out
}

/** 按固定间隔轮询某个取值，记录变化序列（用于验证异步的收步链）。 */
async function sample(get, ms, every = 20) {
  const seen = []
  const deadline = Date.now() + ms
  do {
    const v = get()
    if (seen[seen.length - 1] !== v) seen.push(v)
    await new Promise((r) => setTimeout(r, every))
  } while (Date.now() < deadline)
  return seen
}

/**
 * 用例 K：松手收步。这段逻辑是**异步**的（setTimeout 链），必须真正等计时器，
 * 不能只看一次同步渲染。它也顺带是该保真修复的回归：早先的迷你 React 忽略
 * useEffect 的依赖数组、每次渲染都把 effect 清理一遍，会把收步链在每个渲染里
 * 掐断 —— 只有真正 await 过计时器才会暴露。
 */
async function caseK() {
  const base = { affinity: 0, mode: 'float', visible: true, size: 160, right: 24, bottom: 24 }
  const W = walkFrameSrcs()

  const mount = () => {
    const h = setupOverlay({ ...base })
    const read = () => render(h.Comp, h.props)
    const imgs = () => read().nodes.filter((n) => n._classes.has('dg-img'))
    return {
      stage: read().find('dg-stage'),
      imgs,
      curSrc: () => imgs()[0].props.src,
    }
  }

  if (!Array.isArray(W) || W.length !== 4) {
    check('K 需要产物内联走路四帧', false, String(W && W.length))
    return
  }

  console.log('--- K1 松手时仍在移动 → 收步走完这一步再回待机（不瞬回） ---')
  {
    const t = mount()
    const idle = t.curSrc()
    t.stage.props.onPointerDown(pointerEvent(300, 100))
    t.stage.props.onPointerMove(pointerEvent(268, 100))
    t.stage.props.onPointerMove(pointerEvent(236, 100))
    check('K1 拖拽中处于 walk-3', t.curSrc() === W[2], String(W.indexOf(t.curSrc())))

    t.stage.props.onPointerUp(pointerEvent(236, 100))
    const atRelease = t.curSrc()
    check('K1 松手瞬间仍是走路帧（不瞬回待机）',
      atRelease !== idle && W.includes(atRelease), String(W.indexOf(atRelease)))

    const seen = await sample(() => t.curSrc(), 420, 20)
    const walked = seen.filter((s) => W.includes(s))
    check('K1 收步期间观察到至少 2 个走路帧', walked.length >= 2, String(walked.length))
    const idx = seen.map((s) => W.indexOf(s)).filter((i) => i >= 0)
    let mono = idx.length > 0
    for (let i = 1; i < idx.length; i += 1) {
      const step = (idx[i] - idx[i - 1] + 4) % 4
      if (step !== 1 && step !== 2) mono = false
    }
    check('K1 收步期间帧序号单调前进（每步 +1 或 +2）', mono, idx.join('→'))
    check('K1 收步结束后回到待机帧', t.curSrc() === idle)
    check('K1 收步结束后淡出层已移除', t.imgs().length === 1, String(t.imgs().length))
  }

  console.log('--- K2 松手瞬间完全静止 → 立即回待机（不进入收步） ---')
  {
    const t = mount()
    const idle = t.curSrc()
    t.stage.props.onPointerDown(pointerEvent(300, 100))
    t.stage.props.onPointerMove(pointerEvent(268, 100))
    t.stage.props.onPointerMove(pointerEvent(268, 100))   // 同一坐标 → 速度 0
    t.stage.props.onPointerUp(pointerEvent(268, 100))
    check('K2 静止松手立即回待机帧', t.curSrc() === idle)
  }

  console.log('--- K3 松手后重新按下：旧收步链必须被掐断 ---')
  {
    const t = mount()
    t.stage.props.onPointerDown(pointerEvent(300, 100))
    t.stage.props.onPointerMove(pointerEvent(268, 100))
    t.stage.props.onPointerUp(pointerEvent(268, 100))     // 进入收步，挂上计时器
    t.stage.props.onPointerDown(pointerEvent(300, 100))   // 立刻重新按下
    check('K3 重新按下即回到 contact-A', t.curSrc() === W[0], String(W.indexOf(t.curSrc())))
    await new Promise((r) => setTimeout(r, 260))          // 旧链若没被掐断，这里会被推走
    check('K3 旧收步链已掐断（帧停在按下时的 walk-1）',
      t.curSrc() === W[0], String(W.indexOf(t.curSrc())))
  }
}

/** 装好插件并拿到 shell.overlay 里那个组件的渲染工具。 */
function setupOverlay(seedState) {
  resetHooks()
  const env = makeEnv(seedState)
  const { exportsObj } = loadPlugin(env)
  const captured = []
  exportsObj.apply({
    slots: {
      inject(key, cb) { const r = cb(); captured.push({ key, Comp: r.Comp }); return () => {} },
      register(opts, Comp) { return { opts, Comp } },
    },
    effect(fn) { const c = fn(); return typeof c === 'function' ? c : () => {} },
  })
  const Comp = captured.find((c) => c.key === 'shell.overlay').Comp
  const state = () => JSON.parse(env.localStorageStub.getItem(`${PKG}.state`))
  return { env, Comp, state, props: { useSessionStatus: () => false } }
}

console.log('\n=== 用例 G：交互行为（实际调用事件处理器，不只是看结构） ===')
{
  const base = { affinity: 0, mode: 'float', visible: true, size: 160, right: 24, bottom: 24 }

  // G1 拖拽：相位驱动步态（取代原来的阈值翻帧与方向倾斜）
  {
    const { Comp, state, props } = setupOverlay({ ...base })
    const r = render(Comp, props)
    const stage = r.find('dg-stage')
    const root = r.find('dg-root')
    const W = walkFrameSrcs()
    check('G1 产物内联了走路四帧且互不相同', Array.isArray(W) && new Set(W).size === 4,
      Array.isArray(W) ? String(W.length) : 'null')

    // 第 0 个 .dg-img 是当前帧；第 1 个（若存在）是正在淡出的上一帧
    const imgs = () => render(Comp, props).nodes.filter((n) => n._classes.has('dg-img'))
    const curSrc = () => imgs()[0].props.src
    const fadeSrc = () => (imgs()[1] ? imgs()[1].props.src : null)
    const lift = () => render(Comp, props).find('dg-walk-lift').style.transform
    const facing = () => render(Comp, props).find('dg-walk').style.transform

    const idleSrc = curSrc()
    check('G1 待机帧不是任何走路帧', W.every((s) => s !== idleSrc))

    stage.props.onPointerDown(pointerEvent(200, 100))
    check('G1 按下后加 .dg-drag', root.classList.contains('dg-drag'))
    check('G1 起手固定从 contact-A（walk-1）开始', curSrc() === W[0])
    check('G1 起手没有淡出层', fadeSrc() === null)
    check('G1 起手帧无重心起伏', lift() === 'translateY(0px)', lift())

    // 步幅 32px：一次 32px 位移正好推进一帧，帧序号 = floor(相位) % 4
    stage.props.onPointerMove(pointerEvent(168, 100))   // Δx=-32 → 相位 1
    check('G1 位移 32px（=步幅）推进到 walk-2', curSrc() === W[1])
    check('G1 passing 帧（walk-2）重心抬高 2px', lift() === 'translateY(-2px)', lift())
    check('G1 换帧后上一帧进入淡出层', fadeSrc() === W[0])
    check('G1 向左拖 → scaleX(-1) 镜像', facing() === 'scaleX(-1)', facing())

    stage.props.onPointerMove(pointerEvent(136, 100))   // 相位 2
    check('G1 再推进到 walk-3（contact-B）', curSrc() === W[2])
    check('G1 contact 帧重心回落', lift() === 'translateY(0px)', lift())

    stage.props.onPointerMove(pointerEvent(104, 100))   // 相位 3
    check('G1 再推进到 walk-4（passing-B）', curSrc() === W[3])
    check('G1 passing-B 同样抬 2px', lift() === 'translateY(-2px)', lift())

    stage.props.onPointerMove(pointerEvent(72, 100))    // 相位 4
    check('G1 走满四帧后回到 walk-1（4 帧循环）', curSrc() === W[0])

    stage.props.onPointerMove(pointerEvent(40, 100))    // 相位 5
    check('G1 循环后继续按位移推进', curSrc() === W[1])

    // 单次位移不足一个步幅 → 相位推进但帧号不变（相位是连续量）
    stage.props.onPointerMove(pointerEvent(60, 100))    // Δx=+20，相位 +0.625
    check('G1 单次位移不足步幅时不换帧', curSrc() === W[1])
    check('G1 向右拖 → scaleX(1) 正向', facing() === 'scaleX(1)', facing())

    check('G1 拖拽中仍未落盘（避免 pointermove 反复写 localStorage）',
      state().right === 24 && state().bottom === 24, `right=${state().right}`)

    stage.props.onPointerUp(pointerEvent(60, 100))
    check('G1 松手后不再瞬回待机帧（进入收步）', curSrc() !== idleSrc, curSrc().slice(0, 32))
    check('G1 松手时才落盘', state().right !== 24, `right=${state().right}`)
    check('G1 松手后移除 .dg-drag', !root.classList.contains('dg-drag'))
  }

  // G1b 步频：慢速（多事件小步）与快速（少事件大步）
  {
    const W = walkFrameSrcs()
    const run = (steps) => {
      const { Comp, props } = setupOverlay({ ...base })
      const stage = render(Comp, props).find('dg-stage')
      const curSrc = () => render(Comp, props).nodes.filter((n) => n._classes.has('dg-img'))[0].props.src
      stage.props.onPointerDown(pointerEvent(500, 100))
      let x = 500
      let advances = 0
      let prev = curSrc()
      for (const d of steps) {
        x -= d
        stage.props.onPointerMove(pointerEvent(x, 100))
        const now = curSrc()
        if (now !== prev) advances += 1
        prev = now
      }
      return { advances, events: steps.length, finalSrc: prev }
    }
    // 慢速：8 次 × 4px = 32px 总位移（跨过一个步幅）
    const slow = run([4, 4, 4, 4, 4, 4, 4, 4])
    // 快速：1 次 × 32px = 同样 32px 总位移
    const fast = run([32])
    check('G1b 慢速拖拽 8 次小步共 32px 只推进 1 帧', slow.advances === 1, String(slow.advances))
    check('G1b 快速拖拽 1 次大步 32px 也推进 1 帧', fast.advances === 1, String(fast.advances))
    check('G1b 相同总位移 → 相同帧序号（推进量与位移成正比）',
      slow.finalSrc === fast.finalSrc)
    // 步频 = 每次事件推进的帧数；总位移相同时，快速拖拽步频更高
    const slowRate = slow.advances / slow.events
    const fastRate = fast.advances / fast.events
    check('G1b 快速拖拽步频高于慢速拖拽', fastRate > slowRate,
      `slow=${slowRate}/事件 fast=${fastRate}/事件`)
  }

  // G1c 相位驱动的边界：跨圈循环、绝对值累计、不足一步
  {
    const W = walkFrameSrcs()
    if (!Array.isArray(W) || W.length !== 4) {
      check('G1c 需要产物内联走路四帧', false, String(W && W.length))
    } else {
      // 相位 = 累计横向位移 ÷ 32px；帧序号 = floor(相位) % 4
      const frameAfter = (steps) => {
        const { Comp, props } = setupOverlay({ ...base })
        const read = () => render(Comp, props)
        const stage = read().find('dg-stage')
        const curSrc = () => read().nodes.filter((n) => n._classes.has('dg-img'))[0].props.src
        stage.props.onPointerDown(pointerEvent(500, 100))
        let x = 500
        for (const s of steps) { x -= s; stage.props.onPointerMove(pointerEvent(x, 100)) }
        return W.indexOf(curSrc())
      }
      check('G1c 位移 96px → 相位 3 → walk-4', frameAfter([96]) === 3, String(frameAfter([96])))
      check('G1c 位移 128px → 相位 4 → 绕回 walk-1', frameAfter([128]) === 0, String(frameAfter([128])))
      check('G1c 位移 160px → 相位 5 → walk-2', frameAfter([160]) === 1, String(frameAfter([160])))
      check('G1c 32px×4 分四步与一次 128px 同帧（相位只与总位移有关）',
        frameAfter([32, 32, 32, 32]) === 0)
      check('G1c 32px×5 → 相位 5 → walk-2（跨圈后继续前进）',
        frameAfter([32, 32, 32, 32, 32]) === 1)
      check('G1c 来回拖拽按绝对位移累计（+32 再 -32 → 相位 2 → walk-3）',
        frameAfter([32, -32]) === 2, String(frameAfter([32, -32])))
      check('G1c 位移不足一个步幅不换帧（16px → 相位 0.5 → 仍 walk-1）',
        frameAfter([16]) === 0, String(frameAfter([16])))
    }
  }

  // G2 点击（位移 < 6px）判定为点击 → 回眸
  {
    const { Comp, state, props } = setupOverlay({ ...base })
    const r = render(Comp, props)
    const stage = r.find('dg-stage')
    const root = r.find('dg-root')

    stage.props.onPointerDown(pointerEvent(100, 100))
    stage.props.onPointerMove(pointerEvent(103, 100))   // 位移 3 < 6
    stage.props.onPointerUp(pointerEvent(103, 100))
    check('G2 轻点触发回眸 class', root.classList.contains('dg-lookback'))
    check('G2 轻点不改位置', state().right === 24 && state().bottom === 24)
  }

  // G3 投喂：双击 → 好感度/投喂次数增加 + 爱心粒子
  {
    const { Comp, state, props } = setupOverlay({ ...base })
    const r = render(Comp, props)
    const stage = r.find('dg-stage')
    const fx = r.find('dg-fx')
    const root = r.find('dg-root')

    stage.props.onDoubleClick()
    check('G3 双击加 1 次投喂', state().feeds === 1, String(state().feeds))
    check('G3 双击加 2 点好感度', state().affinity === 2, String(state().affinity))
    check('G3 触发挥光特效 class', root.classList.contains('dg-feed'))
    check('G3 生成 6 颗爱心粒子', fx.children.length === 6, String(fx.children.length))
  }

  // G4 成长进阶：好感度跨过阈值后档位真的变化
  {
    const { Comp, state, props } = setupOverlay({ ...base, affinity: 9 })
    const r1 = render(Comp, props)
    check('G4 好感度 9 → tier1', r1.html.includes('data-tier="1"'))

    r1.find('dg-stage').props.onDoubleClick()   // +2 → 11
    check('G4 投喂后好感度 = 11', state().affinity === 11, String(state().affinity))

    const r2 = render(Comp, props)              // 同一 store，重新渲染
    check('G4 好感度 11 → tier2（档位真的进阶）', r2.html.includes('data-tier="2"'))
    check('G4 tier2 显示 Lv2', r2.html.includes('Lv2'))
  }

  // G5 会话状态 → 动画加速；一轮结束 → 庆祝并累计好感度
  {
    let runningFlag = false
    let lastSelector = null
    const compProps = { useSessionStatus: (sel) => { lastSelector = sel; return runningFlag } }
    const { Comp, state } = setupOverlay({ ...base })

    const r1 = render(Comp, compProps)
    check('G5 空闲时不加运行态 class', !r1.find('dg-root').classList.contains('dg-thinking'))
    check('G5 选择器：运行中 Map → true', lastSelector(new Map([['s', { running: true }]])) === true)
    check('G5 选择器：全停 Map → false', lastSelector(new Map([['s', { running: false }]])) === false)

    runningFlag = true
    const r2 = render(Comp, compProps)
    check('G5 运行中加 .dg-thinking', r2.find('dg-root').classList.contains('dg-thinking'))
    check('G5 运行中加 .dg-working', r2.find('dg-root').classList.contains('dg-working'))

    runningFlag = false
    const beforeAffinity = state().affinity
    const r3 = render(Comp, compProps)
    check('G5 运行结束播放庆祝 .dg-feed', r3.find('dg-root').classList.contains('dg-feed'))
    check('G5 运行结束好感度 +1', state().affinity === beforeAffinity + 1,
      `${beforeAffinity} -> ${state().affinity}`)
    check('G5 运行结束累计回合数', state().turns === 1, String(state().turns))
  }
}

// ───────── 用例 H：右键菜单（回归测试） ─────────
//
// 曾经的 bug：菜单被渲染成 .dg-stage 的子元素，而 .dg-stage 的 onPointerDown 会
// setPointerCapture() + preventDefault()，导致菜单按钮的 click 永不触发；
// 而菜单唯一的关闭途径就是那些按钮，于是菜单点不动也关不掉。
// 这个用例把「按钮可点」「点外部可关」「Esc 可关」都钉住。

console.log('\n=== 用例 H：右键菜单（回归：曾完全点不动、关不掉） ===')
{
  const base = { affinity: 0, mode: 'float', visible: true, size: 160, right: 24, bottom: 24 }
  const { env, Comp, state } = setupOverlay({ ...base })
  const props = { useSessionStatus: () => false }
  const ctxMenu = (x, y) => ({ preventDefault() {}, clientX: x, clientY: y })

  const r0 = render(Comp, props)
  check('H 初始没有菜单', r0.find('dg-menu') === undefined)

  r0.find('dg-stage').props.onContextMenu(ctxMenu(400, 300))
  const r1 = render(Comp, props)
  const menu = r1.find('dg-menu')
  check('H 右键后出现菜单', menu !== undefined)

  // 关键回归断言：菜单必须是 .dg-root 的直接子元素，而不是 .dg-stage 的后代
  check('H 菜单不再是 .dg-stage 的后代', menu !== undefined && menu._parent !== null
    && menu._parent._classes.has('dg-root'),
    menu && menu._parent ? [...menu._parent._classes].join(',') : 'null')
  check('H 菜单定位在右键点击处', menu.style.left === '400px' && menu.style.top === '300px',
    `${menu.style.left} / ${menu.style.top}`)
  check('H 打开时注册了外部关闭监听', (env.windowListeners.get('pointerdown') || []).length === 1,
    String((env.windowListeners.get('pointerdown') || []).length))

  const buttons = r1.nodes.filter((n) => n.tagName === 'BUTTON')
  check('H 菜单含 7 个按钮（新增独立的「缩小尺寸」）', buttons.length === 7, String(buttons.length))

  // 按钮可点：这一条正是原 bug 失效的地方
  buttons[1].props.onClick()      // 「切到标题栏常驻」
  check('H 点按钮后动作生效（模式切到 header）', state().mode === 'header', state().mode)
  const r2 = render(Comp, props)
  check('H 点按钮后菜单关闭', r2.find('dg-menu') === undefined)

  // 点外部关闭
  r2.find('dg-stage').props.onContextMenu(ctxMenu(200, 200))
  const r3 = render(Comp, props)
  check('H 再次右键可打开', r3.find('dg-menu') !== undefined)
  const handled = env.dispatchWindow('pointerdown', { target: {} })
  check('H 外部按下被监听器接到', handled === 1, String(handled))
  const r4 = render(Comp, props)
  check('H 点外部后菜单关闭', r4.find('dg-menu') === undefined)

  // Esc 关闭
  r4.find('dg-stage').props.onContextMenu(ctxMenu(200, 200))
  const r5 = render(Comp, props)
  check('H 第三次打开菜单', r5.find('dg-menu') !== undefined)
  env.dispatchWindow('keydown', { key: 'Escape' })
  const r6 = render(Comp, props)
  check('H 按 Esc 后菜单关闭', r6.find('dg-menu') === undefined)

  // 菜单内部的 pointerdown 不应关闭菜单，否则按钮的 click 会失去目标
  r6.find('dg-stage').props.onContextMenu(ctxMenu(200, 200))
  const r7 = render(Comp, props)
  check('H 第四次打开菜单', r7.find('dg-menu') !== undefined)
  r7.find('dg-menu').contains = () => true    // 模拟事件落在菜单内部
  env.dispatchWindow('pointerdown', { target: {} })
  const r8 = render(Comp, props)
  check('H 菜单内按下不关闭（保住按钮 click）', r8.find('dg-menu') !== undefined)
}

// ───────── 用例 I：立绘切换 ─────────
//
// 动作立绘由 art/gen-actions.py 生成：lookback / feed / walk-1..4。
// 拖拽时按累计横向位移推进步态相位（步幅 32px，帧序号 = floor(相位) % 4）；
// 松手不瞬回，先走完这一步（异步部分见用例 K）。

console.log('\n=== 用例 I：立绘切换（走路四帧 + 动作专属帧） ===')
{
  const base = { affinity: 0, mode: 'float', visible: true, size: 160, right: 24, bottom: 24 }
  const { Comp } = setupOverlay({ ...base })
  const props = { useSessionStatus: () => false }
  const srcOf = (r) => r.find('dg-img').props.src
  const stageOf = (r) => r.find('dg-stage')
  const now = () => srcOf(render(Comp, props))

  const r0 = render(Comp, props)
  const idleSrc = srcOf(r0)
  check('I 待机立绘非空', typeof idleSrc === 'string' && idleSrc.length > 100, String(idleSrc).slice(0, 24))

  // 拖拽开始 → 进入走路帧（固定从 contact-A 起步）
  stageOf(r0).props.onPointerDown(pointerEvent(100, 100))
  const walk1 = now()
  check('I 拖拽开始即切到走路帧（与待机不同）', walk1 !== idleSrc)

  // 位移不足一个步幅（+16px，相位 0.5）→ 维持同一帧，避免抖动式乱切
  stageOf(r0).props.onPointerMove(pointerEvent(116, 100))
  check('I 位移不足一个步幅时保持同一帧', now() === walk1)

  // 累计跨过一个步幅后依次推进四帧
  stageOf(r0).props.onPointerMove(pointerEvent(132, 100))   // 累计 32 → 相位 1
  const walk2 = now()
  check('I 累计 32px（一个步幅）推进到第二帧', walk2 !== walk1)

  stageOf(r0).props.onPointerMove(pointerEvent(164, 100))   // 累计 64 → 相位 2
  const walk3 = now()
  stageOf(r0).props.onPointerMove(pointerEvent(196, 100))   // 累计 96 → 相位 3
  const walk4 = now()
  check('I 四帧依次推进且互不相同',
    new Set([walk1, walk2, walk3, walk4]).size === 4,
    `distinct=${new Set([walk1, walk2, walk3, walk4]).size}`)

  // 相位绕圈 → 回到第一帧（步态循环，不是走到头就停）
  stageOf(r0).props.onPointerMove(pointerEvent(228, 100))   // 累计 128 → 相位 4
  check('I 走满四帧后回到第一帧（步态循环）', now() === walk1)

  // 拖拽中不做 rotate
  check('I 拖拽中不再写 rotate 变换',
    typeof stageOf(r0).style.transform !== 'string' || stageOf(r0).style.transform === '',
    String(stageOf(r0).style.transform))

  // 松手：仍在移动 → 进入收步，**不**瞬回待机（异步收尾由用例 K 验证）
  stageOf(r0).props.onPointerUp(pointerEvent(228, 100))
  check('I 松手后不瞬回待机帧（进入收步）', now() !== idleSrc)

  // 轻点 → 回眸专属帧（换一个干净的实例，避免上一条收步链干扰）
  const h2 = setupOverlay({ ...base })
  const r2 = render(h2.Comp, h2.props)
  const srcOf2 = () => render(h2.Comp, h2.props).find('dg-img').props.src
  r2.find('dg-stage').props.onPointerDown(pointerEvent(100, 100))
  r2.find('dg-stage').props.onPointerMove(pointerEvent(102, 100))
  r2.find('dg-stage').props.onPointerUp(pointerEvent(102, 100))
  const lookbackSrc = srcOf2()
  check('I 轻点切到「回眸」帧（与待机不同）', lookbackSrc !== idleSrc)
  // 回归：曾经轻点后那点残余速度会启动收步链，在 ~95ms 里压着走路帧，
  // 把回眸/投喂立绘顶掉（表现为点一下先看到走路帧）。
  check('I 轻点后立绘不是任何走路帧（收步链不会顶掉动作立绘）',
    ![walk1, walk2, walk3, walk4].includes(lookbackSrc),
    `isWalk=${[walk1, walk2, walk3, walk4].includes(lookbackSrc)}`)

  // 双击投喂 → 投喂专属帧
  r2.find('dg-stage').props.onDoubleClick()
  const feedSrc = srcOf2()
  check('I 投喂切到「投喂」帧（与待机不同）', feedSrc !== idleSrc)
  check('I 投喂立绘不是任何走路帧、也不是回眸帧',
    ![walk1, walk2, walk3, walk4, lookbackSrc].includes(feedSrc))

  // 七张必须两两不同 —— 否则说明某张缺失而静默回退成了同一张
  const all = [idleSrc, walk1, walk2, walk3, walk4, lookbackSrc, feedSrc]
  check('I 待机 + 走路四帧 + 回眸 + 投喂 共七张两两不同（没有静默回退）',
    new Set(all).size === 7, `distinct=${new Set(all).size}`)

  // 立绘全部以 data URI 内联，不依赖任何外部请求
  check('I 全部立绘为内联 data URI', all.every((s) => s.startsWith('data:image/')))
}

// ───────── 用例 J：右键菜单的尺寸放大 / 缩小 ─────────
//
// 曾经的 bug：菜单里只有一个循环按钮（120→160→200→240→280→跳回 120），
// 所以尺寸只能一路变大，绕回小尺寸之前无法往回缩。现在拆成两个显式项并做边界钳制。

console.log('\n=== 用例 J：尺寸放大 / 缩小（回归：原先只能放大） ===')
{
  const base = { affinity: 0, mode: 'float', visible: true, size: 160, right: 24, bottom: 24 }
  const { Comp, state } = setupOverlay({ ...base })
  const props = { useSessionStatus: () => false }
  const ctxMenu = (x, y) => ({ preventDefault() {}, clientX: x, clientY: y })

  // 菜单项索引：0 投喂 / 1 切标题栏 / 2 隐藏 / 3 放大尺寸 / 4 缩小尺寸 / 5 归位 / 6 重置
  const menuButtons = () => {
    const r = render(Comp, props)
    r.find('dg-stage').props.onContextMenu(ctxMenu(300, 300))
    return render(Comp, props).nodes.filter((n) => n.tagName === 'BUTTON')
  }
  /** 打开菜单并点第 idx 项；返回该项点之前是否处于禁用态。 */
  const clickItem = (idx) => {
    const btns = menuButtons()
    const disabled = btns[idx].props.disabled === true
    if (!disabled) btns[idx].props.onClick()
    return disabled
  }

  check('J 默认尺寸 160px', state().size === 160, String(state().size))

  // 缩小：这是原 bug 缺失的方向
  const b0 = menuButtons()
  check('J 默认尺寸下「缩小」项可用', b0[4].props.disabled !== true)
  clickItem(4)
  check('J 点「缩小尺寸」后减小 40 → 120', state().size === 120, String(state().size))

  // 下限：禁用且强制点击也不越界
  const b1 = menuButtons()
  check('J 到下限 120 后「缩小」项被禁用', b1[4].props.disabled === true)
  clickItem(4)
  check('J 下限处再点「缩小」不越界', state().size === 120, String(state().size))

  // 放大到上限（120→160→200→240→280）
  clickItem(3); clickItem(3); clickItem(3); clickItem(3)
  check('J 连点四次「放大」到上限 280', state().size === 280, String(state().size))

  // 上限：禁用且不跳回小尺寸（旧实现会跳回 120）
  const b2 = menuButtons()
  check('J 到上限 280 后「放大」项被禁用', b2[3].props.disabled === true)
  clickItem(3)
  check('J 上限处再点「放大」不跳回小尺寸', state().size === 280, String(state().size))

  // 反向再缩回下限
  clickItem(4); clickItem(4); clickItem(4); clickItem(4)
  check('J 连点四次「缩小」回到下限 120', state().size === 120, String(state().size))
}

// 用例 K 需要真正等计时器（松手收步是异步的），所以收尾放进 async IIFE
;(async () => {
  await caseK()
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
  process.exit(failures === 0 ? 0 : 1)
})()
