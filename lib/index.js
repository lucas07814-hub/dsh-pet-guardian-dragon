/**
 * 少女主体 + 守护龙影 —— DSH Web UI 桌宠：宿主半边。
 *
 * 这是一个**纯客户端插件**：所有内容都在浏览器半边（exports["./client"]），
 * 宿主侧只有一条空 apply。官方对该形态有明确背书 ——
 * docs/cookbook/adding-a-settings-card.zh.md：
 *   「内置命名空间的伴生包就是同样的浏览器半侧放在一个纯客户端包里，
 *     宿主 apply 为空，列入 Web 组合的插件花名册」
 *
 * 之所以保持空实现：桌宠不进入模型请求、不注册工具、不改提示词，
 * 也不新增任何网络路由（美术以 data URI 内联在 client bundle 里）。
 */

/** 稳定的 Cordis 插件名，与 package.json 的包名和 cordis.patch.yml 的 id 一致。 */
export const name = 'dsh-pet-guardian-dragon'

/** 宿主半边无依赖：不需要 webServer，也不需要任何服务。 */
export const inject = []

/**
 * 宿主半边为空——客户端半边由 exports["./client"] 交给浏览器。
 */
export function apply() {
  // 有意留空。
}
