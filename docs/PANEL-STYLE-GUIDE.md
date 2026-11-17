# 面板单页样式记录（PANEL-STYLE-GUIDE）

> 用途：按单页逐页改造面板视觉时，每改完一页，把该页的布局结构、卡片样式、间距、状态色等记到这里。
> 后续页面改造前先读本文件，**复用既有模式，不另起炉灶**。
> 约束（方案 v2 §五）：沿用品牌样式与宿主 `--dsw-alias-*` 变量 / `data-ds-dark-theme`；海浪泡泡只作轻量装饰；
> 严重问题保留明确排障入口；样式改动与功能改动分开提交便于回退。

## 全局既有模式（各页通用，直接复用）

| 模式 | 现状 | 使用处 |
| --- | --- | --- |
| 页面骨架 | 顶部页签行（`.ab-tabs`）+ 内容区卡片流 | 所有页 |
| 卡片 | `Card` 组件：标题 + 说明 + children；支持 `collapsible` / `defaultOpen` | 语音/记忆的「更多设置」、翻唱音色 |
| 子视图切换 | `.ab-seg` 分段按钮（发语音/听语音、记忆条目/人物、内容平台三选一） | 双视图页 |
| 状态色 | 沿用现有状态标签配色（绿=可用、黄=受限/降级、灰=停用、红=失败） | 概览、管理功能 |
| 保存栏 | 页面底部常显，含未保存标记与撤销 | 有表单的页 |
| CSS 变量 | 只用 `--dsw-alias-*` 与面板既有 `--ab-*`，不引入新裸色值 | 全部 |

---

## 页面改造记录

### 管理功能（manage）— 2026-11-16 改造中

**改造前**：9 个模块每个占一整行（行式布局），行内宽度利用率低。

**改造后**：卡片网格形式。9 个模块按四类状态分组，每组内一张卡一项。

#### 网格规格

| 项 | 值 | 说明 |
| --- | --- | --- |
| 容器 | `.ab-manage-grid` | `display:grid` |
| 列 | `repeat(auto-fill, minmax(180px, 1fr))` | 宽度够就多列，最窄 **180px** |
| 间距 | `gap:12px` | 与面板既有 `.ab-grid{gap:12px}` 一致 |
| 对齐 | `align-items:stretch` | 同一排卡片等高，操作区靠底对齐 |
| 窄窗行为 | **无需单独断点** | `auto-fill` 在放不下一列时自动降为单列 |

**为什么是 180px（不是 280px）**：DSH 面板内容区偏窄，且本页每张卡外面还套了一层 `Card`（左右各约 16px 内边距）。
初版取 `minmax(280px,1fr)`，在约 420px 的内容宽下 `auto-fill` 只算得出 **1 列**，用户实测反馈「宽度还是占满了整行」。
收窄到 180px 后，**窄容器（380~560px）稳定排 2 列**，620px 以上排 3 列：

| 容器可用宽度 | 列数（180px + gap 12） |
| --- | --- |
| 380px | 2 |
| 420px | 2 |
| 460px | 2 |
| 520px | 2 |
| 560px | 2 |
| 620px | 3 |

> **踩坑提示**：面板是窄容器，直接抄宽 minmax（280+) 会退化成单列，看起来「跟行式没区别」。
> 给窄容器做卡片网格，minmax 建议 170~200px，并给正文补 `min-width:0; overflow-wrap:anywhere` 防止长英文/URL 横向溢出。

> 复用提示：任何「等宽信息卡列表」都可以直接抄这四行，不必写媒体查询。

**分组留白是结构性的**：9 项按四类状态分组，每组**各自一个 grid**（实测各组卡片数 `[2,2,2,3]`）。
某组只有 1 张卡时右侧留白属正常——要的是卡片形式，不是把不同状态混排塞满一行。

#### 单卡结构

`div.ab-manage-card[.is-blocked|.is-off|.is-absent]`，纵向 flex、`gap:8px`、`padding:14px 16px`、`border-radius:12px`：

1. **头部** `.ab-manage-head`：**两端对齐**（`justify-content:space-between` + `width:100%; align-self:stretch; box-sizing:border-box`），左侧 `span.ab-manage-name`（模块名 + 内嵌 `span.ab-badge[.ok|.warn|.dim]` 状态徽标），右侧启用开关。
   - **名称字号 `15.5px` / `font-weight:620`**（面板层级：正文 12.5px < 卡片标题 15px ≤ 卡内主标题 15.5px，卡片内比说明更醒目）；
   - 名称带 `min-width:0; overflow-wrap:anywhere`，长名折行不撑破卡片；
   - 开关外层包 `span{flex-shrink:0}`，名称再长也不会把开关挤扁；
   - ⚠️ **`width:100%` 不能省**：名称是 auto 宽度的 flex item，不显式撑满头部，`space-between` 就没有剩余空间可分配，开关看起来「没贴右」（本项目实测踩过）。
2. **正文** `.ab-manage-desc`：一句话说明；`flex:1 1 auto` 把操作区顶到卡底；带 `min-width:0; overflow-wrap:anywhere` 防窄列横向溢出。
3. **原因**（仅受限/失败）：`div.ab-note.warn.ab-manage-reason`，沿用既有 `.ab-note.warn` 告警样式。
4. **操作区** `.ab-manage-acts`：只放动作按钮（打开设置 / 看日志排障 / 去安装）；`margin-top:auto` 固定贴底，保证同排卡片按钮水平对齐。

> 阅读顺序：**头部（名称徽标 ↔ 开关）→ 说明 → 原因 → 操作区**。
> 开关属于「状态控制」，放头部右侧与名称同行，一眼能看出这项开没开；操作区只留「去别处做什么」的跳转按钮，职责不混。

#### 四类状态视觉

| 状态 | kind | 卡片类名 | 徽标 | 卡片底色/边框 | 头部右侧 | 操作区按钮 |
| --- | --- | --- | --- | --- | --- | --- |
| 可用 | `ok` | （无） | `ab-badge.ok`（蓝底白字） | 默认卡底 `--ab-card` + `--ab-line` 边框 | 开关 | 去设置（primary） |
| 受限/失败 | `blocked` | `is-blocked` | `ab-badge.warn`（黄） | 告警色边框 `rgba(191,135,0,.35)` + `--ab-card-2` 底 | 开关 | 打开设置 + **看日志排障** |
| 已停用 | `off` | `is-off` | `ab-badge`（无修饰，灰调） | `--ab-card-2` 底 | 开关 | 打开设置 |
| 未安装 | `absent` | `is-absent` | `ab-badge`（灰） | `--ab-card-2` 底 | 无（找不到模块，无开关） | **去安装**（跳模块市场） |

> 告警边框色与既有 `.ab-badge.warn` 同源同色（`rgba(191,135,0,…)`），未引入新色值；其余全部走 `--ab-card` / `--ab-card-2` / `--ab-line` / `--ab-sub`。

#### 交互不变量（布局改造不碰行为）

- 启用/停用仍走既有 `setEnabled` → `POST /save { modules: { [id]: { enabled } } }`，成功后 `reload()` 刷新导航，失败 `toast(err)` 就地提示、不刷新。
  - 开关位置两次调整（操作区 → 头部右侧），`onChange` 逻辑**始终未改**；无对应模块的项（`ms.length === 0`，如未安装）不渲染开关。
- 受限项**必须保留**「看日志排障」入口；未安装项保留「去安装」入口 —— 这是方案 §五「严重问题保留明确排障入口」的落地。
- `kind` 判定逻辑（absent / error / 未运行 / 平台受限 / 用户停用）一行未改，只换了 DOM 结构与类名。
- 分组标题与说明文案保持原样（正常可用 / 需要处理 / 已停用 / 未安装）。

#### 验证记录

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 语法 | `node --check client/client.js` | exit 0 |
| 回归 | `node --test test/panel-stage2.test.js test/panel-stage3.test.js` | 见交付说明；卡片内容断言需把选择器 `ab-mod` 换成 `ab-manage-card` |
| 四类状态渲染 | vm 渲染 Manage，检查节点与文案 | 四类分组、徽标、原因、四类按钮全部正确产出 |
| 深色适配 | 只用 `--ab-*` 变量，暗色由 `.ab-root` / `data-ds-dark-theme` 的变量覆盖自动生效 | 无需额外暗色规则 |
| 窄窗 | `auto-fill + minmax(280px,1fr)` 自动降单列，无媒体查询 | 结构性保证 |

> **给下一个改造页的提示**：本页的「卡片网格 + 头部/正文/操作三段式 + `margin-top:auto` 贴底」可直接复用；
> 行式 `.ab-mod` 仍保留给「已安装模块」等列表页，两者不要混用。

---

### 聊天（group）— 已实施（2026-11-17）

> 状态：**已实施**。用户两轮修订口径后落地：①按心智自由重组分组 ②折叠单位是「组行」而非单项，
> 可见区 2~3 组行、行内项自由流式排版、其余全部折叠 ③`.ab-seg` 两段维持。
> 源码基准：`feat/panel-nav` 分支 `client/client.js`，`function Group`（L2540-2627）及其子组件。
> 盘点方式：正则抽取 `f.*('键')` + `setPath(...)` 全量枚举，并与 `src/chat/group-policy.js: DEFAULT_GROUP_POLICY` 逐键核对，**无遗漏、无虚键**。

#### 一、现状结构（改造前）

页面顶部是**三段式分段按钮**（相当于页内子页），每段下挂若干 `Card`：

| 段 | 现有卡片 |
| --- | --- |
| 群聊（`groups`） | 选择群（GroupOverrides） / 相关设置 / 群聊通用设置 / 被叫到时回复 / 主动插话频率 / 避免连续刷屏 |
| 回复方式（`messages`） | 连发合并 / 合并转发 / 回复发送与等待 |
| 权限与限制（`manage`） | 不回应的人 / 群设置指令 / 跨群查看 / 按头衔不理 / 群聊摘要 / 发文件 / 群里的本机工具 |

**问题**：分组按「配置结构 + 实现模块」划分（merge/forward/chat/files 各自一卡），与用户心智（谁能说、怎么接话、何时别说、怎么回）不对齐；`权限与限制` 一段塞了 7 张卡、40+ 项，是全页最长的一段。

#### 二、设置项全量盘点（共 **47 项**）

图例：控件类型 ｜ 所在卡片（改造前）｜ 条件显隐

**A. 群与白名单（5 项）**

| # | 配置键 | 控件 | 现卡片 | 条件/联动 |
| --- | --- | --- | --- | --- |
| 1 | `allow.groups`（群号增删） | 文本 + chip 列表 | 选择群 | 决定其余群项的可用性 |
| 2 | `group.overrides[gid]`（整块） | 局部草稿对象 | 选择群 | 每群独立；空对象=用通用 |
| 3 | 群响应模式（`allow.groups` + `group.moduleOnlyGroups` 派生） | 选择 off/modules/chat | 选择群 › 群详情 | 非 `chat` 时下方 AI 设置置灰/折叠 |
| 4 | `memory.passiveGroups` | 开关 | 选择群 › 群详情 | 仅"不响应"时有意义 |
| 5 | `group.moduleOnlyGroups`（间接，由响应模式写） | — | 选择群 | 与 3 联动 |

**B. 谁能让它说话 · 被叫到（6 项）**

| # | 配置键 | 控件 | 现卡片 | 条件/联动 |
| --- | --- | --- | --- | --- |
| 6 | `group.wakeWords` | 列表（一行一个） | 被叫到时回复 | — |
| 7 | `group.ignoreAtOthers` | 开关 | 被叫到时回复 | — |
| 8 | `group.mustMaxPerHour` | 范围 0-100（0=不限） | 被叫到时回复 | — |
| 9 | `memberFilter.enabled` | 开关（Card right） | 不回应的人 | 关掉则下方规则全部失效 |
| 10 | `memberFilter.rules[]`（userId/scope/groups） | 文本 + 选择 + 列表 | 不回应的人 | 主人不可加入；上限 100 |
| 11 | `titleFilter.enabled` / `titleFilter.title` / `titleFilter.groups` | 开关 + 文本 + chip | 按头衔不理 | 需拉 `/groups/titles` |

**C. 怎么接话 · 主动插话（10 项）**

| # | 配置键 | 控件 | 现卡片 | 条件/联动 |
| --- | --- | --- | --- | --- |
| 12 | `group.proactiveEnabled` | 开关 | 群聊通用设置 | 群覆盖可覆写 |
| 13 | `group.engagedEnabled` | 开关 | 群聊通用设置 | fallback 到 `interjectChance>0` |
| 14 | `group.quietHours` [start,end] | 双数字 | 群聊通用设置 | 起止相同=不限制 |
| 15 | `group.interjectChance` | 百分比 | 主动插话频率 | =0 时提示条出现 |
| 16 | `group.cooldownSec` | 范围 0-600 | 主动插话频率 | — |
| 17 | `group.maxPerHour` | 范围 0-30 | 主动插话频率 | — |
| 18 | `group.interests` | 列表 | 主动插话频率 › **details 折叠** | — |
| 19 | `group.minRelevance` | 范围 0-1（0=不看话题） | 同上 | — |
| 20 | `group.minRecentMessages` + `group.activeWindowSec` | 数字 ×2 | 同上 | 组合成"群冷清"判定 |
| 21 | `group.engagedMax` | 范围 0-10 | 避免连续刷屏 | — |

**D. 防刷屏 / 安全刹车（3 项）**

| # | 配置键 | 控件 | 现卡片 |
| --- | --- | --- | --- |
| 22 | `group.burstMax` | 范围 1-20 | 避免连续刷屏 |
| 23 | `group.burstWindowSec` | 范围 30-600 | 避免连续刷屏 |
| 24 | `group.engagedMax`（与 #21 同键，视觉上属本组） | — | 归并时注意不要重复渲染 |

**E. 怎么回复 · 发送行为（11 项）**

| # | 配置键 | 控件 | 现卡片 | 条件/联动 |
| --- | --- | --- | --- | --- |
| 25 | `merge.enabled` | 开关（right） | 连发合并 | 关掉后下 4 项无效果 |
| 26 | `merge.waitSec` | 范围 0.5-10 | 连发合并 | — |
| 27 | `merge.maxSec` | 范围 2-30 | 连发合并 | — |
| 28 | `merge.groupWaitSec` | 范围 1-20 | 连发合并 | 群专用 |
| 29 | `merge.groupMaxSec` | 范围 3-60 | 连发合并 | 群专用 |
| 30 | `forward.expandEarly` | 开关（right） | 合并转发 | 关掉则 #31 无效 |
| 31 | `forward.expandHistory` | 开关 | 合并转发 | 依赖 #30 |
| 32 | `chat.seedHistory` | 开关 | 回复发送与等待 | — |
| 33 | `chat.everyStep` | 开关 | 同上 | — |
| 34 | `chat.rescueFromThinking` | 开关 | 同上 | — |
| 35 | `chat.turnTimeoutMinutes` | 数字 0-180 | 同上 | 0=不兜底 |

**F. 跨群 / 主人侧能力（6 项）**

| # | 配置键 | 控件 | 现卡片 | 条件/联动 |
| --- | --- | --- | --- | --- |
| 36 | `group.crossRead` | choices（off/private/group） | 跨群查看 | — |
| 37 | `group.ownerBrief.enabled` | 开关（right） | 群聊摘要 | 关掉则下 2 项无效 |
| 38 | `group.ownerBrief.lines` | 范围 1-30 | 群聊摘要 | — |
| 39 | `group.ownerBrief.groups` | chip 多选 | 群聊摘要 | 空=全部白名单群 |
| 40 | `group.privateCommandsEnabled` | 开关（right） | 群设置指令 | — |
| 41 | `group.ownerTools` | choices（off/owner） | 群里的本机工具 | 非 off 才显示 #42 |
| 42 | `group.ownerToolsGroups` | 列表 | 群里的本机工具 | 条件显隐（依赖 #41） |

**G. 文件（4 项）**

| # | 配置键 | 控件 | 现卡片 | 条件/联动 |
| --- | --- | --- | --- | --- |
| 43 | `files.enabled` | 开关（right） | 发文件 | 需权限页配合 |
| 44 | `files.maxMB` | 数字 1-2048 | 发文件 | — |
| 45 | `files.dirs` | 列表（路径） | 发文件 | — |
| 46 | `files.imageByPath` | 开关 | 发文件 | — |

**H. 导航/跳转（非配置，2 处）**

| # | 项 | 类型 | 位置 |
| --- | --- | --- | --- |
| 47 | 「记忆总开关与清理」「管理模块」「表情制作与休息时段」 | 跳转按钮 | 相关设置卡 |

**统计口径说明**：47 = 46 个真实配置项（含 2 个派生/间接项 #3、#5）+ 1 组跳转入口。
其中 **6 项有条件显隐**（#4、#9、#10 内部、#25、#30、#41→#42），**1 个键被两处渲染**（`group.engagedMax`：#21 与 #24，实施时须合并）。

#### 三、最终分组（已实施 · 2026-11-17）

**折叠口径（用户最终确认）**：可见区放 **2~3 个「组行」**——单位是**组**不是单个设置项；每组占一行、
行内项**自由流式排版**（`.ab-grp-row`，`auto-fit + minmax(190px,1fr)`，窄窗自动降列）；
行内项数上限 ≤10；**其余所有组/项全部收进「更多设置（N 项）」折叠卡**（折叠卡内同样按行组织，不再二次限制）。

结构：顶部 `.ab-seg` 两段「单个群 / 所有群默认」，替代原「群聊 / 回复方式 / 权限与限制」三段。

**「单个群」视图** = 原 `GroupOverrides`（群选择 + 单群覆盖）+ 相关设置跳转卡，保持原有交互不变。

**「所有群默认」视图**：

| 位置 | 卡片/折叠标题 | 行内项 | 项数 |
| --- | --- | --- | --- |
| **可见组行 ①** | 被叫到时怎么回 | 称呼列表 / @了别人不算 / 每小时必回上限 | 3 |
| **可见组行 ②** | 没人叫时怎么接话 | 主动插话开关 / 继续回应开关 / 插话概率 / 最多连续接话 | 4 |
| **可见组行 ③** | 一条消息怎么变成回复 | 连发合并 / 合并转发 / 每段都发 | 3 |
| 折叠 | 接话节奏与时段（4 项） | 插话间隔 / 每小时上限 / 不主动说话时段 / 短时间最多回复 | 4 |
| 折叠 | 话题与群活跃度（3 项） | 感兴趣话题 / 相关度门槛 / 群冷清判定 | 3 |
| 折叠 | 合并与发送明细（8 项） | 4 个 merge 参数 / 补展开 / 补看记录 / 捞思考 / 超时 | 8 |
| 折叠 | 主人跨群与特权（7 项） | /群设置 / 群摘要 / 本机工具(+条件群列表) / 跨群看 / 摘要条数 / 摘要群 | 7 |
| 折叠 | 发文件（4 项） | 允许发文件 / 大小 / 目录 / 图片直发 | 4 |
| 整卡折叠 | 不想理的人与头衔 | MemberFilter + TitleFilter | 2 卡 |

**合计**：可见 3 行共 **10 项**；折叠 **5 张 + 1 整卡**共 **26 项**；「单个群」视图承载群与覆盖项。

#### 三点五、键 → 新位置对照表（47 项零缺失验证）

| 原编号 | 配置键 | 新位置 |
| --- | --- | --- |
| 1-5 | `allow.groups` / `group.overrides` / 响应模式 / `memory.passiveGroups` / `group.moduleOnlyGroups` | 「单个群」视图（GroupOverrides 未改） |
| 6 | `group.wakeWords` | 可见行① |
| 7 | `group.ignoreAtOthers` | 可见行① |
| 8 | `group.mustMaxPerHour` | 可见行① |
| 9-11 | `memberFilter.*` / `titleFilter.*` | 整卡折叠「不想理的人与头衔」 |
| 12 | `group.proactiveEnabled` | 可见行② |
| 13 | `group.engagedEnabled` | 可见行② |
| 14 | `group.quietHours` | 折叠「接话节奏与时段」 |
| 15 | `group.interjectChance` | 可见行② |
| 16 | `group.cooldownSec` | 折叠「接话节奏与时段」 |
| 17 | `group.maxPerHour` | 折叠「接话节奏与时段」 |
| 18-20 | `group.interests` / `minRelevance` / `minRecentMessages`+`activeWindowSec` | 折叠「话题与群活跃度」 |
| 21,24 | `group.engagedMax`（原两处渲染合一） | 可见行② |
| 22-23 | `group.burstMax` / `burstWindowSec` | 折叠「接话节奏与时段」 |
| 25-29 | `merge.enabled` / `waitSec` / `maxSec` / `groupWaitSec` / `groupMaxSec` | enabled 在可见行③；其余 4 项在折叠「合并与发送明细」 |
| 30-31 | `forward.expandEarly` / `expandHistory` | early 在可见行③；history 在折叠 |
| 32-34 | `chat.seedHistory` / `everyStep` / `rescueFromThinking` | everyStep 在可见行③；另两项在折叠 |
| 35 | `chat.turnTimeoutMinutes` | 折叠「合并与发送明细」 |
| 36-39 | `group.crossRead` / `ownerBrief.enabled` / `.lines` / `.groups` | 折叠「主人跨群与特权」 |
| 40-42 | `group.privateCommandsEnabled` / `ownerTools` / `ownerToolsGroups` | 折叠「主人跨群与特权」（群列表条件显隐保留） |
| 43-46 | `files.enabled` / `maxMB` / `dirs` / `imageByPath` | 折叠「发文件」 |
| 47 | 跳转按钮×3 | 「单个群」视图「相关设置」卡 |

#### 四、布局设计与复用（实际落地）

| 区域 | 复用/新建 | 实际做法 |
| --- | --- | --- |
| 页内两级切换 | **复用 `.ab-seg`（`Seg` 组件）** | `single`/`all` 两段，替代原三按钮 |
| 分组卡 | **复用 `Card`** | 标题 + desc + children |
| 折叠 | **复用 `Card collapsible defaultOpen=false`** | 折叠不渲染 children（已验证） |
| 行内流式排版 | **新增 `.ab-grp-row`** | 见下，本页主要新增样式 |
| 折叠子卡弱化 | **新增 `.ab-fold-sub`** | 虚线边框 + 透明底，避免父卡内再套实底卡 |
| 群列表 chip | 复用 `.ab-chip` | 未改 |
| 设置项控件 | 复用 `.ab-row` / `useField` | 未改 |
| 名单卡（不回应的人/头衔） | **未引入新样式** | 评估后沿用现有 chip + 详情卡，`ab-people-*` 草案未采用 |

**本页实际新增的 CSS（全部在 client.js 样式区）**：

```css
/* 组行：一行放一组设置，行内项自由流式排版（按类型与宽度自然排，窄窗自动降列） */
.ab-grp-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px;align-items:start}
.ab-grp-row>.ab-row{flex-direction:column;align-items:flex-start;gap:4px}
.ab-grp-row>.ab-row>.ab-ctl{width:100%}
/* 卡片内「更多设置（N 项）」子折叠卡：视觉上弱化一层，避免与父卡重复的实底边框 */
.ab-fold-sub{background:transparent;border-style:dashed;box-shadow:none}
```

> **关键点**：`.ab-grp-row` 让每组项自动按可用宽度排成 1~N 列（`auto-fit`），
> 既满足「一行放一组」的组行语义，又不会在窄面板里把项挤成一条。
> 想让某组固定 2 列，把 `auto-fit` 换成 `auto-fill` 并给 `minmax` 调宽即可。

> 名单型设置（不回应的人 / 头衔）评估后**沿用现有 `ab-chip` + 下方详情卡**，未引入额外样式。

#### 五、风险与不变量（实施时不能破坏）

| # | 不变量 | 现状依据 | 风险点 |
| --- | --- | --- | --- |
| 1 | **草稿基线对账** | `_groupSettingsBase`（save 里 L9546）、`memberFilter`/`group`/`memory` 走单独 baseline 比对 | 重排卡片时若把某项挪出 `group` 键、或拆成新顶层键，会导致保存漏写/多写 |
| 2 | **群覆盖优先级** | `group.overrides[gid]` 逐键覆盖通用值；`??` fallback 到通用 | 合并「单群/所有群默认」视图时，**必须保持 override 只写显式改过的键**（`value===''` 时 `delete`） |
| 3 | **条件显隐的连带失效** | `merge.enabled` 关→参数无效；`files.enabled` 关→参数无效；`ownerTools==='off'`→群列表隐藏 | 不要因为重排把「被控制项」移出可视区却仍可编辑 |
| 4 | **权限检查在宿主侧** | 群白名单/主人判定由后端做，前端只是编辑器 | 布局改造不得引入前端侧"看起来能开"的假开关 |
| 5 | **保存栏常显** | 底部 `.ab-savebar` + 未保存标记 + 撤销 | `tabDirty('group')` 的键集合不能漏项，否则某组改动不显示未保存 |
| 6 | **排障入口常显** | 方案 §五要求 | 「不回应的人」「头衔」折叠时，标题行要能看出当前生效数量 |
| 7 | **深色/窄窗** | 全站变量体系 | 新 CSS 只用 `--ab-*`，不引入裸色值 |

**TAB_KEYS 已修（本页改造的一项必修）**：
- 改前：`group: ['group','merge','titleFilter','memberFilter','chat']` —— **漏 `files`、`forward`**
- 改后：`group: ['group','merge','titleFilter','memberFilter','chat','files','forward']`
- 若将来再加顶层配置域（如新的 `xxx`），**必须同步加进这个数组**，否则该组改动不显示未保存标记。

#### 六、验收结果（已实施 · 2026-11-17）

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 语法 | `node --check client/client.js` | **exit 0** |
| 回归 | `node --test test/panel-stage2.test.js test/panel-stage3.test.js` | **30/30 pass** |
| 可见组行数 | vm 渲染 `Group`（all 视图），数 `.ab-grp-row` | **3 个**（用户口径 2~3 ✓） |
| 行内项数 | 每行 `.ab-row` 计数 | **[3, 4, 3]**，均 ≤10 ✓ |
| 折叠卡 | 未展开树上数 `Card.collapsible` | **5 张 + 1 整卡**，标题均标「（N 项）」、`defaultOpen:false` ✓ |
| 47 项键位 | 键名清单逐一比对 Group+子组件 | **42 个客观键 + 3 个派生项，零缺失** |
| TAB_KEYS | 源码断言 | 已补 `files`、`forward` ✓ |
| 整树渲染兜底 | vm 渲染 `AurabotPage` 首帧 + ready，及 `Group` 两种视图 | **均不抛异常** ✓ |

> `test/panel-root-render.test.js` 在实施时**尚未落地**（qa 侧未创建）。
> 我用等价的临时脚本做了整树渲染兜底（AurabotPage 首帧 / ready+tab=group / Group 两视图），
> 全部不抛异常；该临时脚本未进仓库。建议 qa 补上正式用例后由 CI 长期守住。

**已知未覆盖**：真机视觉确认（深色/窄窗观感、行内项的实际换行效果）需在面板里目测一次。

---

**状态：已实施（feat/panel-nav，未提交）。** 47 项零缺失、可见组行 3 个（[3,4,3] 项）、折叠 6 处。

---

### 记忆（memory）— 已实施（2026-11-17）

> 沿用聊天页已验证口径：可见区 2~3 个「组行」（行内项自由流式排版，≤10 项），其余全部收进
> 「更多设置（N 项）」折叠卡；折叠卡复用 `.ab-fold-sub` 弱化样式。

#### 一、三视图结构（本次新增）

用户要求把「可视化」与「设置」分开，记忆页改为 `.ab-seg` **三段**：

| 视图 | 组件 | 默认 | 说明 |
| --- | --- | --- | --- |
| **星图** `starmap` | `StarMap` | ✅ 默认（排第一） | 记忆关系可视化，好看且与设置区分 |
| 记忆条目 `entries` | `MemoryPage` | — | 设置 + 条目列表（本次重排对象） |
| 人物 `person` | `PersonaMemory` | — | 画像墙（未改动） |

**按需加载（硬验收，已实测）**：

- `StarMap` 只在 `memoryView === 'starmap'` 时挂载 → `entries` / `person` 视图**星图请求 0 次**（实测）
- `StarMap` 只做一次性 `GET /memory/graph`，**无 `setInterval`**，所以「卸载即停、不残留轮询」天然成立
- `PersonaMemory` 同样只在 `person` 视图挂载，`/persona/*` 零请求（实测）

**`aurabot.memory-view` 取值集合**：`starmap | entries | person`
- 老用户已存的 `entries` / `person` **继续有效**（源码归一化：只认这两值，其余落 `starmap`）
- 没存过 / 值异常 → 默认 `starmap`
- `pickMemoryView` 持久化逻辑**未改一行**

#### 二、设置项盘点（64 项，零缺失）

盘点方法：对 `MemoryPage` 全量正则抽取 `f.*('键')` + `setPath(draft,'键')`，再与 `src/core/config.js` 的
memory 默认值对象**双向核对**（页面有但 config 无 → 查后端确认；config 有但页面无 → 标注为内部键）。

结果：**64 个配置键** + 1 个动态模板键 `memory.tierDays.*`（按后端 `factTiers` 动态渲染 N 项）。

> 两处曾疑似虚键，均已核实为真实键：
> - `memory.crossContext`：不在默认字面量里，但 `config.js:848` 有归一化、`memory.js:2215` 在用
> - `memory.vector.mode`：前端「本地/在线」切换的辅助状态（阶段三起就如此）

#### 三、最终分组（可见 3 组行 + 折叠若干）

| 位置 | 卡片/折叠标题 | 行内项 | 项数 |
| --- | --- | --- | --- |
| **可见组行 ①** | 记忆开关与整理 | 每天自动整理(含时间+手动整理) / 自动记忆容量 / 聊天流水留多久 / 整理时合并重复 | 4 |
| **可见组行 ②** | 每轮想起多少 | 直接想起条数 / 联想条数 / 总数上限 / 常驻记忆上限 | 4 |
| **可见组行 ③** | 记忆联想与加深 | 记忆联想开关 / 相似度门槛 / 联想跳数 | 3 |
| 折叠 | 每轮想起多少 › 更多设置 | 私人优先 / 召回门槛 / 翻旧账模式 / 触发词 / 近况记忆 ×4 | 8 |
| 折叠 | 记忆联想与加深 › 更多设置 | 每条最多连几个 / 跳衰减 / 加深开关 / 联想计数 / 每日涨幅 / 最少天数 / 上限 / 两档门槛 / 联想预览 | 10 |
| 折叠 | 高级调优 | 内含向量检索 + 重排候选 + 分层记忆与遗忘 三个 Fold | 3 组 |
| 折叠 | 人物与群印象 | 只记有交集的人 / 讨厌的人不接几率 / 字数上限 ×3 / 群印象 ×2 | 7 |
| 保留 | 手动加一条 / 翻一翻 | 功能块（无配置键），不折叠 | — |

**成本与依赖提示原文保留**：向量检索「本地离线不花钱 / 在线需自备接口」、重排「超时自动保留原顺序」、
联想「本地向量建边，不花钱、不联网」、以及「本地模型未就绪 → 联想静默失效」的告警条，**文案一字未改**。

#### 四、键 → 新位置对照（关键项）

| 配置键 | 新位置 |
| --- | --- |
| `memory.enabled` / `dailyConsolidate` / `capacity` / `keepChatlogDays` / `mergeGroups` | 可见组行 ① |
| `memory.consolidateTimes`（时间点） | 可见组行 ①（每日整理行内） |
| `memory.recallCount` / `assoc.recall` / `recallTotal` / `residentMaxChars` | 可见组行 ② |
| `memory.preferPersonal` / `recallMinRelevance` / `recallMode` / `recallTriggers` / `shortTerm*`(4) | ② 的「更多设置」(8) |
| `memory.assoc.enabled` / `assoc.minSim` / `assoc.hops` | 可见组行 ③ |
| `memory.assoc.limit` / `hopDecay` / `tierGrow.*`(9) | ③ 的「更多设置」(10) |
| `memory.vector.*`(10) | 折叠「高级调优 › 向量检索」 |
| `memory.rerank.*`(6) | 折叠「高级调优 › 重排候选」 |
| `memory.gist*` / `impressionDays` / `extractDailyBatches` / `tierDays.*` / `retentionBase` / `compress*` / `crossContext` | 折叠「高级调优 › 分层记忆与遗忘」 |
| `memory.profileOnlyAcquainted` / `dislikeSilence` / `profile*`(3) / `chatImpression*`(2) | 折叠「人物与群印象」(7) |

#### 五、验收结果

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 语法 | `node --check` | **exit 0** |
| 键位零缺失 | 64 键逐个对照 | **64/64 全在** + 模板键在 |
| 可见组行 | 数 `ab-grp-row` | **3 个** ✓ |
| 折叠卡 | 数 `more()` | **4 张**（另 1 处「高级调优」含 3 组 Fold） |
| 默认视图 | vm 渲染 | **星图选中** ✓ |
| entries 星图请求 | vm 统计 fetch | **0 次** ✓ |
| person 星图请求 | vm 统计 fetch | **0 次** ✓ |
| 三视图往返 | 渲染 5 次往返 | 不抛异常、**草稿未被改动** ✓ |
| 整树兜底 | AurabotPage 首帧 + ready+tab=memory | **不抛异常** ✓ |
| 回归 | `panel-stage3` + `panel-stage2` | **27/30**（3 条为旧双视图契约，见下） |

**需 qa 对齐的过期断言**（实现正确，测试仍按双视图写）：

- `panel-stage3.test.js:222`「记忆页要有一对子视图页签」——实际已是 `['星图','记忆条目','人物']` 三段
- `panel-stage3.test.js:247`「点「人物」要切视图」——页签索引变化：`[1]` 现在是「记忆条目」，`[2]` 才是「人物」
- 另 1 条为默认视图断言（原期望默认「记忆条目」，现应为默认「星图」）

> 建议 qa 把这三条改为三视图契约，并加一条「entries 视图不挂 StarMap、0 个 graph 请求」的按需加载断言。
