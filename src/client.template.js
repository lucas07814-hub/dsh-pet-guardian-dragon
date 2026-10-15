/**
 * 少女主体 + 守护龙影 —— DSH Web UI 桌宠：浏览器半边（模板）。
 *
 * 本文件不是最终产物。art/build-client.py 会把美术数据注入下面的 ART 常量
 * 占位符，再把整段包进官方的 lazy-CJS factory 外壳，产出 lib/client.js。
 * 之所以手写而不是用打包器：本机没有 pnpm/git，而官方的 clientBundle 预设
 * 不在任何已发布包里，仓库外无法复刻。
 *
 * ── 契约依据（全部在本机运行中的 DSH 上实测确认，非推测）──
 *
 * 1) factory 外壳：packages/client/tsdown.client.ts 的 banner/intro/footer
 *    window.__ModuleLoader__.load({ id, factory })（见 manifest.ts 的
 *    ClientBundleRegistration）。
 *
 * 2) shell.overlay 真实存在且为根作用域 list：从运行中的
 *    @deepseek-ai/dsh-client-ui-layout 的 client bundle 里读到
 *      ctx.slots.register({ name: "root", children: {
 *        "sidebar": {kind:"single"}, "main": {kind:"keyed"},
 *        "rightbar": {kind:"single"},
 *        "shell.overlay": { kind: "list", scope: "root" },   ← 本插件挂这里
 *        "shell.leading": {kind:"single"} } }, AppFrame)
 *    并由 AppFrame 执行 renderSlot("shell.overlay", {})。
 *    list 语义：以必填 id 定址、按 order 排序 → 追加成员不会与既有 occupant 冲突。
 *
 * 3) 状态来源：@deepseek-ai/dsh-client-ui-session 的 apply 里
 *      ctx.slots.provideRoot({ hooks: {
 *        sessions: ctx.sessions.list,          // → prop useSessions
 *        sessionStatus: service.sessionStatus, // → prop useSessionStatus（Map<id,{running}>）
 *      } })
 *    文档（docs/subsystems/slots.zh.md）说明这两个 hook 在**所有 scope** 可用，
 *    因此 root 作用域的 shell.overlay 也能拿到会话运行状态——不需要标题栏，
 *    也不需要 IPC。没有打开会话时也能反映其它会话的运行情况。
 *
 * 4) 可 require 的平台模块：packages/client/web/src/platform.ts
 *
 * ── 设计要点 ──
 *   - 所有副作用（含 CSS 注入）都在 factory 闭包内，物化时才运行。
 *   - 宠物由 React 渲染（不再手动 appendChild），生命周期交给 cordis/React；
 *     拖拽与特效走 ref 的命令式写入，避免 pointermove 引发重渲染风暴。
 *   - 整棵宠物树包在错误边界里：万一某个 DSH 版本的 slot 契约变化导致渲染抛错，
 *     只让桌宠消失，绝不连累 AppFrame。
 */

const React = require('react')

/** 美术数据由构建脚本注入：{ girl, dragon, avatar, girlLookback, girlFeed, girlWalkA, girlWalkB }。 */
const ART = __ART__

/**
 * 状态 → 立绘。
 * 变体由 art/gen-actions.py 生成；缺任何一张都回退到待机立绘，
 * 因此老版本产物或部分生成失败时也不会出现空白。
 */
const POSE_SRC = {
  idle: ART.girl,
  lookback: ART.girlLookback || ART.girl,
  feed: ART.girlFeed || ART.girl,
}

/**
 * 走路四帧（相位驱动步态循环），顺序固定：
 *   0 = contact-A  左脚本步落地、重心最低
 *   1 = passing-A  右腿摆过身体下方、重心最高
 *   2 = contact-B  与 0 同姿态，left/right 对调
 *   3 = passing-B  与 1 同姿态，left/right 对调
 * 由 art/gen-actions.py 生成；缺任何一张都回退到待机立绘。
 */
const WALK_FRAMES = [
  ART.girlWalk1 || ART.girl,
  ART.girlWalk2 || ART.girl,
  ART.girlWalk3 || ART.girl,
  ART.girlWalk4 || ART.girl,
]

/**
 * 步幅（像素/帧）。相位 = 累计横向位移 ÷ STRIDE_PX，帧序号 = floor(相位) % 4。
 * 步幅固定、步频随速度变：慢速拖拽步频慢，快速拖拽步频快；
 * 而总帧推进量始终与总位移成正比。
 */
const STRIDE_PX = 32

/**
 * 重心起伏：passing 帧（1、3）额外抬高 2px。
 * 立绘本身的高低差常常不够明显，这里补一点，让「一高一低」看得出节奏。
 */
const FRAME_LIFT_PX = [0, -2, 0, -2]

/** 松手收步：每帧间隔（2 帧 ≈ 190ms），以及判定「松手时仍在移动」的速度阈值。 */
const SETTLE_STEP_MS = 95
const SETTLE_FAST_PX = 12

/** 尺寸档位（右键菜单的放大/缩小）。原先只有一个循环按钮，只能一路变大，
    绕回小尺寸之前无法往回缩，故拆成两个显式项并做边界钳制。 */
const SIZE_MIN = 120
const SIZE_MAX = 280
const SIZE_STEP = 40

const PKG = 'dsh-pet-guardian-dragon'
const STORE_KEY = `${PKG}.state`
/** 右下角悬浮：根作用域 list，由 ui-layout 的 AppFrame 渲染。 */
const OVERLAY_SLOT = 'shell.overlay'
/** 标题栏常驻：由 ui-conversation 声明的 list/session 槽。 */
const HEADER_SLOT = 'conversation.session.header.actions'

// ───────────────────────────── 样式 ─────────────────────────────

const CSS = `
.dg-root{position:fixed;right:24px;bottom:24px;z-index:2147483000;
  display:flex;flex-direction:column;align-items:center;justify-content:flex-end;
  width:160px;pointer-events:none;user-select:none;-webkit-user-select:none;
  touch-action:none;font:12px/1.4 system-ui,sans-serif}
.dg-root[data-hidden="1"]{display:none}

.dg-stage{position:relative;pointer-events:auto;cursor:grab;
  filter:drop-shadow(0 6px 14px rgba(20,8,40,.45));
  transform-origin:50% 100%;will-change:transform}
.dg-stage:active{cursor:grabbing}
.dg-img{display:block;width:100%;height:auto;pointer-events:none}

/* 守护龙影：浮游在少女右上方，独立于主体的节奏。
   放在 .dg-lift 之前并给后者 position:relative;z-index:1，
   否则绝对定位的龙影会盖在少女身上。 */
.dg-dragon{position:absolute;right:-20%;top:-26%;width:62%;pointer-events:none;
  filter:drop-shadow(0 3px 10px rgba(150,90,255,.35));
  animation:dg-dragon-float 7.4s ease-in-out infinite}
.dg-dragon-img{display:block;width:100%;height:auto}
@keyframes dg-dragon-float{
  0%,100%{transform:translate(0,0) rotate(-1.5deg)}
  50%{transform:translate(3px,-7px) rotate(2deg)}
}
.dg-thinking .dg-dragon{animation-duration:3.2s}
.dg-working .dg-dragon{animation-duration:2.2s}
/* 拖拽期间不再加速龙影浮动（约定：不在拖拽时改变浮动周期） */

/* 点击回眸：龙首翻面 */
.dg-lookback .dg-dragon-img{animation:dg-dragon-look .66s ease-in-out}
@keyframes dg-dragon-look{
  0%{transform:scaleX(1)}
  40%{transform:scaleX(.78) rotate(6deg)}
  100%{transform:scaleX(1)}
}
.dg-feed .dg-dragon{filter:drop-shadow(0 0 14px rgba(216,120,255,.9))}
.dg-root[data-tier="3"] .dg-dragon{filter:drop-shadow(0 0 12px rgba(178,102,255,.8))}

/* 待机呼吸：**只有**极小幅缩放，不含平移/旋转/摇晃。
   周期 3.4s、幅度 0.8%，看起来像呼吸而不是晃动。 */
.dg-idle{animation:dg-breathe 3.4s ease-in-out infinite}
@keyframes dg-breathe{
  0%,100%{transform:scale(1)}
  50%{transform:scale(1.008)}
}

/* 走路：外层只做左右镜像（**不设 transition**，否则翻面会穿过 0 宽度变形），
   内层做重心起伏（可过渡），最内层叠「当前帧 + 正在淡出的上一帧」。
   整体摇晃（原 .dg-sway）与拖拽 rotate 均已移除；
   .dg-lift 只负责把少女压在龙影之上（z-index），不再有任何动画。
   拖拽期间也不改变浮动周期 —— .dg-drag 只作为拖拽态标记。 */
.dg-lift{position:relative;z-index:1}
.dg-walk{position:relative}
.dg-walk-lift{position:relative;transition:transform .1s ease-out}
/* 上一帧盖在当前帧之上，100ms 内淡出 → 帧切换不会硬闪 */
.dg-walk-fade{position:absolute;left:0;top:0;width:100%;height:auto;
  animation:dg-crossfade .1s linear forwards}
@keyframes dg-crossfade{from{opacity:1}to{opacity:0}}

.dg-thinking .dg-idle{animation-duration:2.0s}
.dg-working .dg-idle{animation-duration:1.3s}

/* 点击回眸 */
.dg-lookback .dg-stage{animation:dg-lookback .62s ease-in-out}
@keyframes dg-lookback{
  0%{transform:scaleX(1)}
  35%{transform:scaleX(.86) rotate(-6deg)}
  60%{transform:scaleX(.94) rotate(3deg)}
  100%{transform:scaleX(1)}
}
.dg-lookback .dg-img{filter:brightness(1.14) saturate(1.08)}

/* 投喂：发光 + 爱心 */
.dg-feed .dg-stage{animation:dg-feed .9s ease-out}
@keyframes dg-feed{
  0%{filter:drop-shadow(0 0 0 rgba(216,120,255,0))}
  35%{filter:drop-shadow(0 0 18px rgba(216,120,255,.95)) brightness(1.2)}
  100%{filter:drop-shadow(0 6px 14px rgba(20,8,40,.45))}
}
.dg-heart{position:absolute;left:50%;bottom:62%;width:14px;height:14px;
  pointer-events:none;will-change:transform,opacity;
  background:no-repeat center/contain;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path fill='%23ff5fa8' d='M16 28S3 19.6 3 11.6C3 7 6.6 4 10.4 4c2.4 0 4.4 1.2 5.6 3.1C17.2 5.2 19.2 4 21.6 4 25.4 4 29 7 29 11.6 29 19.6 16 28 16 28z'/></svg>")}
/* 爱心容器：给它一个明确的包含块，使 .dg-heart 的百分比相对整个 stage 解析。
   同时不拦截指针（否则会挡住拖拽）。 */
.dg-fx{position:absolute;inset:0;pointer-events:none}
@keyframes dg-heart-up{
  0%{transform:translate(-50%,0) scale(.4);opacity:0}
  20%{opacity:1}
  100%{transform:translate(calc(-50% + var(--dx,0px)),-72px) scale(1.15);opacity:0}
}

/* 成长进阶：紫炎光环层次 */
.dg-aura{position:absolute;inset:-14% -18% -6% -18%;pointer-events:none;
  border-radius:50%;opacity:0;transition:opacity .5s ease;
  background:radial-gradient(ellipse at 50% 78%,
    rgba(178,102,255,.55) 0%,rgba(126,58,214,.28) 42%,rgba(80,30,150,0) 72%)}
.dg-root[data-tier="2"] .dg-aura{opacity:.65;animation:dg-aura-pulse 3.4s ease-in-out infinite}
.dg-root[data-tier="3"] .dg-aura{opacity:1;animation:dg-aura-pulse 2.2s ease-in-out infinite}
@keyframes dg-aura-pulse{0%,100%{transform:scale(.96);opacity:.45}50%{transform:scale(1.06);opacity:1}}

.dg-spark{position:absolute;width:5px;height:5px;border-radius:50%;
  background:#d9a6ff;box-shadow:0 0 8px 2px rgba(196,120,255,.9);
  pointer-events:none;opacity:0}
/* 用长写属性而非 animation 简写：简写会重置 animation-delay，
   而每颗火星的延迟是内联设定的。 */
.dg-root[data-tier="3"] .dg-spark{
  animation-name:dg-spark;animation-duration:3.6s;
  animation-iteration-count:infinite;animation-timing-function:linear}
@keyframes dg-spark{
  0%{opacity:0;transform:translateY(0) scale(.6)}
  25%{opacity:1}
  100%{opacity:0;transform:translateY(-46px) scale(1.1)}
}

/* 好感度 HUD（悬停显示） */
.dg-hud{position:absolute;left:50%;transform:translateX(-50%);bottom:-16px;
  display:flex;gap:6px;align-items:center;white-space:nowrap;
  padding:2px 8px;border-radius:9px;background:rgba(24,12,44,.82);
  color:#e9dcff;font-size:10.5px;opacity:0;transition:opacity .18s;pointer-events:none}
.dg-stage:hover .dg-hud{opacity:1}
.dg-hud b{color:#d9a6ff;font-weight:600}

/* 右键菜单 */
/* 右键菜单：固定定位在点击处（left/top 由内联样式给出）。
   它必须是 .dg-root 的直接子元素，**绝不能放进 .dg-stage** ——
   否则按钮上的 pointerdown 会冒泡到 stage 的拖拽处理器，被
   setPointerCapture() 重定向指针、再被 preventDefault() 抑制兼容性鼠标事件，
   结果是按钮的 click 永远不触发、菜单也就永远关不掉（这是实际踩到的 bug）。 */
.dg-menu{position:fixed;min-width:150px;padding:5px;
  border-radius:10px;background:rgba(28,16,50,.97);color:#eae1ff;
  border:1px solid rgba(160,110,240,.35);box-shadow:0 10px 28px rgba(0,0,0,.5);
  font:12px/1.5 system-ui,sans-serif;pointer-events:auto;z-index:2}
.dg-menu button{display:block;width:100%;padding:6px 10px;border:0;border-radius:7px;
  background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dg-menu button:hover{background:rgba(150,100,240,.28)}
/* 已到尺寸上下限时对应项禁用，视觉上明确不可点 */
.dg-menu button:disabled{opacity:.42;cursor:default}
.dg-menu button:disabled:hover{background:transparent}
.dg-menu hr{border:0;border-top:1px solid rgba(160,110,240,.22);margin:4px 2px}

/* 标题栏常驻 */
.dg-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px 0 3px;
  border-radius:11px;background:rgba(120,70,200,.16);cursor:pointer;
  border:1px solid transparent;transition:background .15s,border-color .15s}
.dg-chip:hover{background:rgba(140,90,220,.28);border-color:rgba(170,120,250,.34)}
.dg-chip img{width:18px;height:18px;border-radius:50%;display:block}
.dg-chip span{font-size:11px;color:rgba(235,225,255,.88);white-space:nowrap}
.dg-chip-host{display:none}
.dg-chip-host[data-visible="1"]{display:inline-flex}
`

function installStyles() {
  if (document.querySelector(`style[data-plugin-css="${PKG}/client"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PKG
  tag.dataset.pluginCss = `${PKG}/client`
  tag.textContent = CSS
  document.head.appendChild(tag)
}

// ─────────────────────── 共享状态（含持久化） ───────────────────────

const DEFAULT_STATE = {
  mode: 'float',   // float = 右下角悬浮（shell.overlay）；header = 标题栏常驻
  size: 160,
  right: 24,
  bottom: 24,
  affinity: 0,
  feeds: 0,
  turns: 0,
  visible: true,
}

function tierOf(affinity) {
  if (affinity >= 30) return 3
  if (affinity >= 10) return 2
  return 1
}

function createStore() {
  let state = { ...DEFAULT_STATE }
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved) state = { ...state, ...JSON.parse(saved) }
  } catch { /* 隐私模式等场景忽略 */ }

  const listeners = new Set()
  const emit = () => { for (const fn of [...listeners]) { try { fn() } catch { /* 隔离单个订阅者 */ } } }

  return {
    get state() { return state },
    /** 供 useSyncExternalStore / 自建订阅使用：快照必须是稳定引用。 */
    getSnapshot() { return state },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    patch(next) {
      state = { ...state, ...next }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch { /* 忽略 */ }
      emit()
    },
  }
}

// ───────────────────── 会话运行状态（root scope hook） ─────────────────────

/**
 * 从 useSessionStatus 的快照里求「是否有会话在跑」。
 * 实测契约（ui-session 的 provideRoot）：sessionStatus 是 Map<sessionId, {running}>。
 * 这里对 Map / 数组 / 普通对象三种形态都做容忍，避免版本差异直接抛错。
 */
function selectAnyRunning(snapshot) {
  if (!snapshot) return false
  try {
    if (typeof snapshot.forEach === 'function' && typeof snapshot.size === 'number') {
      let running = false
      snapshot.forEach((v) => { if (v && v.running === true) running = true })
      return running
    }
    if (Array.isArray(snapshot)) return snapshot.some((v) => v && v.running === true)
    if (typeof snapshot === 'object') {
      for (const k of Object.keys(snapshot)) {
        const v = snapshot[k]
        if (v && v.running === true) return true
      }
    }
  } catch { /* 形状不符时静默降级 */ }
  return false
}

/**
 * 状态探针。单独抽成组件是为了满足 Hooks 规则：`useSessionStatus` 只在它
 * 存在时挂载，因此 hook 调用顺序在该组件整个生命周期内恒定。
 */
function StatusProbe(props) {
  const running = props.useSessionStatus(selectAnyRunning) === true
  const onChange = props.onChange
  React.useEffect(() => { onChange(running) }, [running, onChange])
  return null
}

/** 简易错误边界：桌宠渲染失败只让它自己消失，绝不连累 AppFrame。 */
class Boundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) {
    console.warn(`[${PKG}] 桌宠渲染失败，已自行隐藏：`, error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

// ─────────────────────────── 悬浮桌宠 ───────────────────────────

function PetOverlay(props) {
  const store = props.store
  // useSyncExternalStore 在 React 18 稳定可用；退化为 useState 订阅也够用。
  const [, force] = React.useReducer((n) => n + 1, 0)
  React.useEffect(() => store.subscribe(force), [store])

  const state = store.state
  const rootRef = React.useRef(null)
  const stageRef = React.useRef(null)
  const fxRef = React.useRef(null)
  const [menu, setMenu] = React.useState(null)
  const runningRef = React.useRef(false)
  const lastRunningRef = React.useRef(null)
  const fxTimerRef = React.useRef(null)

  // 当前使用哪张动作立绘（由 art/gen-actions.py 生成的专属变体）。
  // 缺图时 POSE_SRC 已回退到待机立绘，因此这里不会出现空白。
  const [pose, setPose] = React.useState('idle')
  const poseTimerRef = React.useRef(null)

  // 走路状态：{ cur 当前帧序号, prev 上一帧, seq 切换计数, active 是否在走路, facing 朝向 }
  // 放 ref 而非 state —— pointermove 里要同步读改写相位，state 会有闭包旧值问题。
  // 只在帧/活动态/朝向**真正变化**时 bump 一次触发重渲染，
  // 所以拖拽过程中每推进一帧才渲染一次，不是每个 pointermove 都渲染。
  // 用独立的走路状态而非复用 pose，是为了让「走路 → 立绘」的优先级
  // 不受 lookback/feed 的定时回落干扰（那会在拖拽中途把帧改回待机）。
  const walk = React.useRef({ cur: 0, prev: 0, seq: 0, active: false, facing: 1 })
  const [, setWalkTick] = React.useState(0)
  const bumpWalk = React.useCallback(() => setWalkTick((n) => n + 1), [])

  const walkTo = React.useCallback((next) => {
    const w = walk.current
    if (next === w.cur) return
    // seq 自增 → 淡出层换 key 重新挂载，交叉淡化才会重新播放
    walk.current = { cur: next, prev: w.cur, seq: w.seq + 1, active: true, facing: w.facing }
    bumpWalk()
  }, [bumpWalk])

  const walkActive = React.useCallback((active) => {
    if (walk.current.active === active) return
    walk.current = { ...walk.current, active }
    bumpWalk()
  }, [bumpWalk])

  const walkFace = React.useCallback((facing) => {
    if (walk.current.facing === facing) return
    walk.current = { ...walk.current, facing }
    bumpWalk()
  }, [bumpWalk])

  // 松手收步的定时链：{ timer, left 还要推进几帧 }
  const settle = React.useRef({ timer: null, left: 0 })
  const stopSettle = React.useCallback(() => {
    if (settle.current.timer !== null) {
      clearTimeout(settle.current.timer)
      settle.current.timer = null
    }
    settle.current.left = 0
  }, [])

  /** 切到某个动作立绘；给 ms 时到点自动回待机。 */
  const showPose = React.useCallback((next, ms) => {
    setPose(next)
    if (poseTimerRef.current !== null) { clearTimeout(poseTimerRef.current); poseTimerRef.current = null }
    if (ms) {
      poseTimerRef.current = setTimeout(() => {
        setPose('idle')
        poseTimerRef.current = null
      }, ms)
    }
  }, [])

  /** CSS 特效 class ↔ 对应动作立绘：同一切换时机、同一回落时长。 */
  const FLASH_POSE = { 'dg-lookback': 'lookback', 'dg-feed': 'feed' }

  const flash = React.useCallback((cls, ms) => {
    const el = rootRef.current
    // CSS 变换作为 fallback 保留：立绘切了，缩放/翻面/发光照旧叠加
    if (el) {
      el.classList.add(cls)
      if (fxTimerRef.current !== null) clearTimeout(fxTimerRef.current)
      fxTimerRef.current = setTimeout(() => {
        const cur = rootRef.current
        if (cur) cur.classList.remove(cls)
      }, ms)
    }
    const mapped = FLASH_POSE[cls]
    if (mapped) showPose(mapped, ms)
  }, [showPose])

  const burstHearts = React.useCallback((n) => {
    const host = fxRef.current
    if (!host) return
    for (let i = 0; i < n; i += 1) {
      const h = document.createElement('div')
      h.className = 'dg-heart'
      h.style.setProperty('--dx', `${(Math.random() * 44 - 22).toFixed(0)}px`)
      h.style.animation =
        `dg-heart-up ${(0.9 + Math.random() * 0.5).toFixed(2)}s ease-out ${(i * 0.09).toFixed(2)}s forwards`
      host.appendChild(h)
      setTimeout(() => h.remove(), 1800)
    }
  }, [])

  const pet = React.useMemo(() => ({
    lookBack() { flash('dg-lookback', 650) },
    feed() {
      flash('dg-feed', 900)
      burstHearts(6)
      store.patch({ feeds: store.state.feeds + 1, affinity: store.state.affinity + 2 })
    },
  }), [flash, burstHearts, store])

  // 会话状态 → 动画 class。running 由 StatusProbe 推来。
  const onRunning = React.useCallback((running) => {
    runningRef.current = running
    const el = rootRef.current
    if (el) {
      el.classList.toggle('dg-thinking', running === true)
      el.classList.toggle('dg-working', running === true)
    }
    if (lastRunningRef.current === true && running === false) {
      // 一轮结束：庆祝并累积好感度
      flash('dg-feed', 900)
      burstHearts(3)
      store.patch({ turns: store.state.turns + 1, affinity: store.state.affinity + 1 })
    }
    lastRunningRef.current = running
  }, [flash, burstHearts, store])

  React.useEffect(() => () => {
    if (fxTimerRef.current !== null) clearTimeout(fxTimerRef.current)
    if (poseTimerRef.current !== null) clearTimeout(poseTimerRef.current)
    // 收步定时链也要清掉，否则组件卸载后还会 walkTo 一次
    if (settle.current.timer !== null) clearTimeout(settle.current.timer)
  }, [])

  // ---- 右键菜单的定位与关闭 ----
  const menuRef = React.useRef(null)
  const closeMenu = React.useCallback(() => setMenu(null), [])

  // 打开期间挂外部关闭：点别处 / 按 Esc。
  // 关键细节：必须判断事件是否落在菜单内部 —— 否则按钮自身的 pointerdown 会
  // 先把菜单卸载掉，随后那次 click 就没有目标元素可派发了。
  React.useEffect(() => {
    if (menu === null) return undefined
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const onDown = (e) => {
      const el = menuRef.current
      if (el && typeof el.contains === 'function' && e && e.target && el.contains(e.target)) return
      setMenu(null)
    }
    const onKey = (e) => { if (e && e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  // 出现在右键点击处，并夹在视口内（菜单约 150×250）
  const menuStyle = React.useMemo(() => {
    if (menu === null) return { left: '0px', top: '0px' }
    const W = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const H = (typeof window !== 'undefined' && window.innerHeight) || 800
    const x = Math.max(8, Math.min(menu.x, W - 170))
    const y = Math.max(8, Math.min(menu.y, H - 260))
    return { left: `${x}px`, top: `${y}px` }
  }, [menu])

  // ---- 拖拽（ref 命令式写入，pointermove 不触发重渲染） ----
  const drag = React.useRef({
    on: false, moved: 0, x: 0, y: 0, right: 0, bottom: 0, lx: 0,
    phase: 0,      // 步态相位（累计横向位移 ÷ STRIDE_PX）
    frame: 0,      // 当前帧序号，用于判断是否需要真的换帧
    speed: 0,      // 最近一次事件的横向速度（px/事件），松手时用来决定收几步
  })

  const onPointerDown = (e) => {
    if (e.button !== 0) return
    const el = rootRef.current
    if (!el) return
    stopSettle()                   // 上一次的收步链若还在跑，先掐掉
    drag.current = {
      on: true, moved: 0, x: e.clientX, y: e.clientY,
      right: state.right, bottom: state.bottom, lx: e.clientX,
      phase: 0, frame: 0, speed: 0,
    }
    el.classList.add('dg-drag')    // 仅作拖拽态标记（不再驱动任何动画）
    // 起手固定从 contact-A 开始，且不带淡出层（seq 归零）
    walk.current = { ...walk.current, cur: 0, prev: 0, seq: 0, active: true }
    bumpWalk()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d.on) return
    const el = rootRef.current
    if (!el) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy))

    // 相位驱动：累计横向位移 ÷ 步幅 → 相位；帧序号 = floor(相位) % 4。
    // 步幅固定、步频随速度变：慢速拖拽步频慢，快速拖拽步频快，
    // 而**总**帧推进量始终与**总**位移成正比（相位是位移的线性函数）。
    // 优先用 pointer 事件自带的 movementX；合成事件里没有该字段时退化为
    // clientX 差值（两者对「横向位移」是等价的）。
    const step = typeof e.movementX === 'number' ? e.movementX : (e.clientX - d.lx)
    d.lx = e.clientX
    d.speed = Math.abs(step)
    d.phase += Math.abs(step) / STRIDE_PX
    const next = Math.floor(d.phase) % 4
    if (next !== d.frame) {
      d.frame = next
      walkTo(next)
    }
    // 朝向：向右拖正向、向左拖镜像（不为两个方向各做一套素材）
    if (step !== 0) walkFace(step > 0 ? 1 : -1)

    // 位置直接写样式，不动 React state；这里**不再**做任何 rotate
    const r = Math.max(0, d.right - dx)
    const b = Math.max(0, d.bottom - dy)
    el.style.right = `${r}px`
    el.style.bottom = `${b}px`
    d.pendingRight = r
    d.pendingBottom = b
  }

  const onPointerUp = (e) => {
    const d = drag.current
    if (!d.on) return
    d.on = false
    const el = rootRef.current
    if (el) el.classList.remove('dg-drag')
    e.currentTarget.releasePointerCapture?.(e.pointerId)

    // 点击（几乎没移动）**不算走路**：直接退出走路态，让回眸/投喂立绘立刻生效。
    // 否则那点残余速度会启动收步链，在 ~95ms 里压着走路帧、把动作立绘顶掉。
    const isClick = d.moved < 6
    // 松手收步：**不瞬回**待机帧。若松手瞬间还在移动，让相位再推进 1–2 帧
    // （2 帧 ≈ 190ms）走完这一步，再回待机；完全静止松手才立刻回。
    const back = isClick ? 0 : (d.speed >= SETTLE_FAST_PX ? 2 : (d.speed > 0 ? 1 : 0))
    if (back > 0) {
      settle.current.left = back
      const tick = () => {
        const s = settle.current
        if (s.left <= 0) return
        walkTo((walk.current.cur + 1) % 4)
        s.left -= 1
        if (s.left > 0) {
          s.timer = setTimeout(tick, SETTLE_STEP_MS)
        } else {
          s.timer = null
          walkActive(false)
        }
      }
      settle.current.timer = setTimeout(tick, SETTLE_STEP_MS)
    } else {
      stopSettle()
      walkActive(false)
    }

    if (isClick) {
      pet.lookBack()   // 视为点击 → 回眸立绘（由 flash 连带切换）
    } else if (d.pendingRight !== undefined) {
      // 只在松手时落盘一次，避免 pointermove 里反复写 localStorage
      store.patch({ right: d.pendingRight, bottom: d.pendingBottom })
    }
  }

  // 走路状态快照（ref → 本次渲染）。每次变更都伴随 bumpWalk，
  // 所以这里读到的就是最新值。
  const walkState = walk.current
  const hud = `好感度 ${state.affinity} · Lv${tierOf(state.affinity)} · 投喂 ${state.feeds}`
  const hidden = !(state.visible && state.mode === 'float')

  return React.createElement(React.Fragment, null,
    React.createElement('div', {
      ref: rootRef,
      className: 'dg-root',
      'data-tier': String(tierOf(state.affinity)),
      'data-hidden': hidden ? '1' : '0',
      style: { width: `${state.size}px`, right: `${state.right}px`, bottom: `${state.bottom}px` },
    },
      React.createElement('div', {
        ref: stageRef,
        className: 'dg-stage',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onDoubleClick: () => pet.feed(),
        onContextMenu: (e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        },
      },
        React.createElement('div', { className: 'dg-aura' }),
        React.createElement('div', { className: 'dg-dragon' },
          React.createElement('img', { className: 'dg-dragon-img', src: ART.dragon, alt: '', draggable: false }),
        ),
        React.createElement('div', { className: 'dg-lift' },
          React.createElement('div', {
            className: 'dg-walk',
            // 左右镜像：向左拖 scaleX(-1)。刻意放在外层且不带 transition，
            // 否则翻面会经过 0 宽度、看起来像被压扁。
            style: { transform: `scaleX(${walkState.facing})` },
          },
            React.createElement('div', {
              className: 'dg-walk-lift',
              // 重心起伏：passing 帧抬高 2px。走路时才生效（待机不做位移）。
              style: {
                transform: `translateY(${walkState.active ? FRAME_LIFT_PX[walkState.cur] : 0}px)`,
              },
            },
              React.createElement('img', {
                className: 'dg-img dg-idle',
                // 渲染优先级：走路（拖拽中/收步中）→ 走路帧；否则 → 当前姿态帧
                src: walkState.active ? WALK_FRAMES[walkState.cur] : POSE_SRC[pose],
                alt: '守护龙影桌宠',
                draggable: false,
              }),
              // 上一帧盖在上面淡出 → 帧切换不硬闪。
              // key 用 seq：每次换帧都重新挂载，CSS 动画才会重新播放。
              walkState.active && walkState.seq > 0
                ? React.createElement('img', {
                    key: `dg-fade-${walkState.seq}`,
                    className: 'dg-img dg-walk-fade',
                    src: WALK_FRAMES[walkState.prev],
                    alt: '',
                    draggable: false,
                  })
                : null,
            ),
          ),
        ),
        [{ left: '30%', bottom: '18%', delay: '0s' },
         { left: '18%', bottom: '24%', delay: '1.2s' },
         { left: '78%', bottom: '34%', delay: '2.4s' }].map((s, i) =>
          React.createElement('div', {
            key: `sp${i}`, className: 'dg-spark',
            style: { left: s.left, bottom: s.bottom, animationDelay: s.delay },
          })),
        React.createElement('div', { className: 'dg-hud' }, hud),
        React.createElement('div', { ref: fxRef, className: 'dg-fx' }),
      ),
      // 菜单是 .dg-root 的直接子元素，刻意不放进 .dg-stage（原因见上面 CSS 注释）。
      // 这样按钮上的指针事件不会冒泡到 stage 的拖拽处理器，click 才能正常触发。
      menu === null ? null : React.createElement('div', {
        ref: menuRef,
        className: 'dg-menu',
        style: menuStyle,
      },
        React.createElement('button', { type: 'button', onClick: () => { closeMenu(); pet.feed() } }, '投喂爱心'),
        React.createElement('button', {
          type: 'button',
          onClick: () => { closeMenu(); store.patch({ mode: 'header' }) },
        }, '切到标题栏常驻'),
        React.createElement('button', {
          type: 'button',
          onClick: () => { closeMenu(); store.patch({ visible: false }) },
        }, '隐藏桌宠'),
        React.createElement('hr'),
        React.createElement('button', {
          type: 'button',
          disabled: state.size >= SIZE_MAX,
          onClick: () => {
            closeMenu()
            store.patch({ size: Math.min(SIZE_MAX, state.size + SIZE_STEP) })
          },
        }, `放大尺寸 ${state.size} → ${Math.min(SIZE_MAX, state.size + SIZE_STEP)}px`),
        React.createElement('button', {
          type: 'button',
          disabled: state.size <= SIZE_MIN,
          onClick: () => {
            closeMenu()
            store.patch({ size: Math.max(SIZE_MIN, state.size - SIZE_STEP) })
          },
        }, `缩小尺寸 ${state.size} → ${Math.max(SIZE_MIN, state.size - SIZE_STEP)}px`),
        React.createElement('button', {
          type: 'button',
          onClick: () => { closeMenu(); store.patch({ right: 24, bottom: 24 }) },
        }, '回到右下角'),
        React.createElement('button', {
          type: 'button',
          onClick: () => { closeMenu(); store.patch({ affinity: 0, feeds: 0, turns: 0 }) },
        }, '重置好感度'),
      ),
    ),
    typeof props.useSessionStatus === 'function'
      ? React.createElement(StatusProbe, { useSessionStatus: props.useSessionStatus, onChange: onRunning })
      : null,
  )
}

// ───────────────────── 标题栏常驻（同为 list 槽） ─────────────────────

function PetChip(props) {
  const store = props.store
  const [, force] = React.useReducer((n) => n + 1, 0)
  React.useEffect(() => store.subscribe(force), [store])
  const runningRef = React.useRef(false)
  const onRunning = React.useCallback((running) => { runningRef.current = running; force() }, [])

  const state = store.state
  const tier = tierOf(state.affinity)
  const running = runningRef.current
  const visible = state.visible && state.mode === 'header'

  return React.createElement(React.Fragment, null,
    React.createElement('div', {
      className: 'dg-chip-host',
      'data-visible': visible ? '1' : '0',
    },
      React.createElement('div', {
        className: 'dg-chip',
        title: running
          ? '干活中…（点击投喂 / 右键切回悬浮）'
          : `好感度 ${state.affinity} · Lv${tier}（点击投喂 / 右键切换位置）`,
        onClick: () => store.patch({ feeds: state.feeds + 1, affinity: state.affinity + 2 }),
        onContextMenu: (e) => { e.preventDefault(); store.patch({ mode: 'float' }) },
      },
        React.createElement('img', { src: ART.avatar, alt: '守护龙影' }),
        React.createElement('span', null, running ? '干活中…' : `Lv${tier}`),
      ),
    ),
    typeof props.useSessionStatus === 'function'
      ? React.createElement(StatusProbe, { useSessionStatus: props.useSessionStatus, onChange: onRunning })
      : null,
  )
}

// ───────────────────────────── 插件入口 ─────────────────────────────

/** Cordis 依赖的服务：slots 注册表（由 ui-renderer 提供）。 */
exports.inject = ['slots']

/**
 * 浏览器半边插件体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 客户端根上下文
 */
exports.apply = function apply(ctx) {
  installStyles()

  const store = createStore()

  if (ctx === null || ctx === undefined || ctx.slots === null || ctx.slots === undefined) {
    console.warn(`[${PKG}] ctx.slots 不可用：桌宠未挂载`)
    return
  }

  ctx.effect(() => {
    // 右下角悬浮：根作用域 list 槽，由 ui-layout 的 AppFrame 渲染。
    // slots.inject 会等待该 child 的声明生命周期，owner 折叠时贡献随之移除。
    const disposeOverlay = ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register(
      { name: OVERLAY_SLOT, id: PKG, order: 100 },
      (props) => React.createElement(Boundary, null,
        React.createElement(PetOverlay, { ...props, store })),
    ))

    // 标题栏常驻：ui-conversation 声明的 list/session 槽。
    const disposeHeader = ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register(
      { name: HEADER_SLOT, id: PKG, order: 40 },
      (props) => React.createElement(Boundary, null,
        React.createElement(PetChip, { ...props, store })),
    ))

    return () => {
      // register / inject 的返回值不保证是 disposer，因此逐个判类型。
      for (const d of [disposeOverlay, disposeHeader]) {
        if (typeof d === 'function') { try { d() } catch { /* 已折叠 */ } }
      }
    }
  }, 'pet-guardian-dragon: overlay + header')
}
