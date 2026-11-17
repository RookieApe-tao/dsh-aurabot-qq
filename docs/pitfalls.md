# 坑记录（docs/pitfalls.md）

> 规则（见 AGENTS.md）：遇到问题先读本文件；每次问题解决后，必须把坑（现象/原因/解决）追加进来。

## 2026-11-13 合并 origin/beta 后 backup.test.js 2 个用例挂（上游自带，非合并引入）

- **现象**：`git merge origin/beta`（56 commits，零冲突）后跑 `npm test`，2167 项挂 2：
  - `恢复中途移动失败时回退已完成的移动…`（backup.test.js:310，期望抛 `/模拟写入拒绝/`）
  - `LA-21 提交标记移动失败时回退…`（backup.test.js:392，期望抛 `/模拟提交拒绝/`）
  - 断言均为 `Missing expected exception`，即 `api.applyPendingRestore()` 根本没抛。
- **原因**：在临时 worktree 检出纯 `origin/beta` 跑 `node --test test/backup.test.js`，同样挂这 2 个 → 上游 beta 自带失败，与本地超集/合并无关。两个用例依赖 `t.mock.method(fs, 'renameSync')` + `syncBuiltinESMExports()` 劫持内置 fs——上游 commit `1adc076 fix(security): 备份恢复与敏感命令授权加固` 后 `backup.js` 的恢复路径很可能改走了不被该劫持方式命中的调用（如 `fs.promises.rename` 或解构引用），Windows/当前 Node 版本下 mock 不生效。
- **解决**：本次更新按「上游自带失败」放行，不阻塞本机升级；若要修，应改上游 `backup.js` 让恢复走 `fs.renameSync`（可被 `syncBuiltinESMExports` 劫持），或改测试的 mock 方式——留给上游 PR。
- **涉及文件/命令**：`repo/test/backup.test.js`（L310-337、L392-431）、`repo/src/core/backup.js`；命令 `git worktree add ..\beta-check origin/beta && node --test test/backup.test.js`。

- 解决：改用 glob：
ode --test "test/replay/**/*.test.js"；package.json 里 npm test 本来就是 glob 写法，不受影响。
- 涉及文件/命令：test/replay/*（新增）；命令 
ode --test "test/replay/**/*.test.js"。

## 2026-11-13 · Windows 下 `node --test <目录>` 不生效
- 现象：`node --test test/replay/` 报 `Cannot find module ...\test\replay`，整个目录作为入口失败。
- 原因：Node 的 test runner 在 Windows 上不接受裸目录参数（把目录当模块解析）。
- 解决：改用 glob：`node --test "test/replay/**/*.test.js"`；package.json 里 npm test 本来就是 glob 写法，不受影响。
- 涉及文件/命令：test/replay/*（新增）；命令 `node --test "test/replay/**/*.test.js"`。

## 2026-11-13 · `npx tsc` 拉到同名假包，校验假通过
- 现象：`npx tsc --noEmit ...` 输出「This is not the tsc command you are looking for」还 exit 0，contracts.d.ts 的语法校验等于没跑。
- 原因：npm 上有个叫 `tsc` 的摆烂恶搞包，npx 找不到本地 typescript 时按名字拉到了它。
- 解决：显式指定包名：`npx -y -p typescript tsc --noEmit --strict ...`（P0 校验 contracts.d.ts 用这个，实测 exit 0 才算数）。
- 涉及文件/命令：src/gateway/contracts.d.ts；命令 `npx -y -p typescript tsc`。

## 2026-11-13 I1 身份库：SQLite 错误包装不能罩住业务错误
- 现象：identity-store 的 transact 把 fn 里的所有异常都包成「身份库损坏」，导致 link 的 IdentityConflict 被 test 判 instanceof 失败。
- 原因：try 块同时包住了「开库/初始化」和「fn 执行」，坏库包装范围过宽。
- 解决：只在开库+initialize 阶段做损坏包装（且仅当文件已存在），fn 的错误原样抛出。涉及 src/gateway/identity-store.js。
- 另：createIdentity 原本懒开库，库损坏要到第一次调用才炸；改成构造时 transact(() => {}) 预热，启动当场报错（任务书过关条件要求「启动报清楚的错」）。

## 2026-11-16 git rebase 把主检出的分支切走了，后续 merge 落错线
- 现象：阶段二收尾执行 `git rebase dev local/runtime` 后主检出从 dev 切到 local/runtime，紧接着的 `git merge --ff-only` 实际快进了 local/runtime，dev 停在阶段一；下一阶段 port 时成员发现 worktree 基线缺阶段二组件（VoiceTab/Manage 计数为 0），险些照错基线硬合。
- 原因：`git rebase <upstream> <branch>` 会把主检出切到 branch；后续命令的落点全部跟着变，而汇报里只看了 log 没核对 `git branch --show-current`。
- 解决：port 前先用 `git branch --show-current` + `git log -1 <线>` 核对落点；本机统一口径以 local/runtime 为准（本机运行线），dev 用 `git branch -f` 对齐。涉及命令 `git rebase` / `git merge --ff-only` / `git worktree add`。
- 教训：任何 rebase/checkout 后，紧接的 merge/push 前必须重新确认「当前在哪个分支」。

## 2026-11-16 在途编辑的测试文件被截断出中文引号，node --check 都过不了
- 现象：qa-tests 预写 test/panel-stage3.test.js 时 L37 中文引号被截断（`'…要跟着改?)`），整文件 Invalid or unexpected token，实现成员差点把它当实现 bug 排查。
- 原因：编辑器/工具对含中文标点的行做流式写入时截断（与 MEMORY.md §3.12 pwsh Get-Content/Set-Content 转写毁 UTF-8 同族）。
- 解决：编辑工具统一用 read/edit/write 而非 pwsh 转写；文件损坏先 `node --check` 分清「语法坏」还是「逻辑坏」，语法坏的先修语法再谈对齐。qa 已在该测试文件头加禁用 pwsh 转写提醒注释。

## 2026-11-17 同步 beta 触发「本机独有审计 × 上游新增代码」口径碰撞（16 文件冲突 + 2 个静态审计挂）
- 现象：`local/runtime` 拖了 19 个提交没同步、`git merge origin/beta` 报 16 文件 28 处 UU；全量测试除既有 4 个环境失败外，新增 `i3-owner-identity.test.js`（ownerQQ 静态审计）与 `layering.test.js`（中枢层平台词）2 挂。
- 原因：迁移主线（#486）两边各合一次 → 大量同功能伪冲突；两个审计测试是**本机独有**（`git cat-file -e origin/beta:test/layering.test.js` 为不存在），上游 #465 新加的 `src/core/persona-memory-bridge.js`（直读 `cfg.ownerQQ`）与 `src/chat/receipts.js`（注释含 OneBot、代码含 `platform: 'qq'`）不知道本机 I3/G3 契约。巨型合并派单个成员硬啃会中途失败（client.js 万余行压死成员），改为 lead 逐个裁决 + 只派「小块」。
- 解决：①冲突按「共同部分取上游官方版、本机独有保留、测试冲突取并集」逐块裁决，`git add` 消 UU；②bridge 的 scope 改为经 `identity` 注入解析主人（host.js L223 注入，identity L197 已建好），注释里也别写字面 `ownerQQ`（审计扫字面量）；③receipts.js 语义属网关层，`git mv` 到 `src/gateway/` 并改 3 处 import（hub.js/bridge/module-chat-api.test.js），去注释平台词——**不要往 layering 白名单加文件（规矩只许缩短）**。
- 教训：同步 beta 前先确认哪些测试/文件是本机独有（本机超集口径）；静态审计类失败优先怀疑「上游新代码违反本机契约」，别急着改断言。全量测试里的 `连发合并` 是并发计时 flaky（单独跑通过），别误判为回归。
- 涉及文件/命令：`git diff --name-only --diff-filter=U` 盘点、`git diff --numstat HEAD/origin/beta` 看两侧差异量、`git show origin/beta:<file>` 判断文件是否上游存在、`node --test <单文件>` 隔离 flaky。
- 附带结论（#493 口径校正）：上游 beta 的 client.js 已含 `chatlogRow`(2) 与 `StarMap/MemoryTab`(4/2)，仍缺 `ab-manage-grid`(0) 与 `OwnerBriefGroups`(0)——#493 现只需恢复 2 批而非交接总结里的 4 批。判存在性按签名/键级计数，别按 hash。

## 2026-11-17 内容平台页「B站/抖音/小黑盒」三个按钮点了没反应
- 现象：面板「内容平台」页，三个平台 tab 显示正常、B站高亮选中，但点抖音/小黑盒画面纹丝不动，用户报「无法点击」。
- 原因：`ContentTab` 里用**可用集合**做选中归一化——`usable = avail.length ? avail.map(p=>p.id) : all`，`picked = usable.includes(contentView) ? contentView : usable[0]`。只要至少一个模块在跑（如只有 bili），`usable` 就只剩 `['bili']`；点抖音 → `setContentView('douyin')` → 重渲染时 `usable.includes('douyin')` 为 false → `picked` 立刻回落 `'bili'`，表现为「点了没反应」。而同处注释明写「模块没在跑的也允许点进去看设置」，实现与注释相反。
- 解决：把「能不能点」和「默认选哪个」拆开——`all`（全部平台，用于校验并沿用上次选择）+ `defaultId`（running 的第一个，仅作默认值），`picked = all.includes(contentView) ? contentView : defaultId`。改 `repo/client/client.js` ContentTab。
- 教训：**「可用集合」不能既当白名单又当选择校验**，否则未启用项的点击会被静默弹回；抓「点击后 setState 但渲染值来自过滤集合」的回流。面板交互问题优先读渲染函数本身，别先怀疑 CSS 遮挡/事件绑定。
- 涉及文件/命令：`repo/client/client.js`（ContentTab，约 L8333-8353）；验证 `node --check`（拷 .mjs）+ `node --test test/panel-stage2.test.js test/group-panel-layout.test.js test/panel-root-render.test.js`。

## 2026-11-17 内容平台页点抖音/小黑盒整页崩「Cannot read properties of undefined (reading 'length')」
- 现象：接上一条修好「按钮点不动」后，点抖音/小黑盒立刻变成「这一页出错了」，错误信息 `Cannot read properties of undefined (reading 'length')`。
- 原因：两个平台模块没在跑 → `/douyin/state`、`/heybox/state` 路由不存在 → `get()` 的 `.catch` 返回 `{ok:false,message}`（**没有 history 字段**）→ `setS` 把它当正常 state 存进 `s` → 渲染层 `s.history.length` 直接对 undefined 取属性。`!s ? 加载中 : s.history.length===0` 这种写法只防了「s 为 null」，没防「s 存在但缺字段」。B站页同理（L8445）只是它模块在跑才没暴露。
- 解决：①渲染层改成 `!Array.isArray(s.history) || s.history.length === 0`（B站/抖音两处）；②ContentTab 层加 `runningOf(picked)` 判断——模块没在跑就不挂载子组件，直接渲染「这个平台还没启用」提示卡，从根上不发那个必然失败、必然返回残对象的请求。
- 教训：`!s ? ... : s.field.length` 只挡 null，挡不住 `{ok:false}` 这类残对象；接口失败兜底对象是 `{ok:false,message}`，凡进入渲染的 API 结果都要按「可能只含 ok/message」设防。**优先在容器层判断「组件该不该挂载」，而不是在每个子组件里补容错**——前者一次解决，后者容易漏（三个组件只改了两个才是常态）。
- 涉及文件/命令：`repo/client/client.js`（ContentTab L8333-8370、Bili L8445、Douyin L8625）；`get()` 定义在 L18（catch 返回 `{ok:false,message}`）。

## 2026-11-17 记忆条目页设置项被 ab-grp-row 网格压成竖排「高卡片」
- 现象：「记忆 → 记忆条目」页第一组设置（每天自动整理两次 / 自动记忆容量 / 聊天流水留多久 / 合并重复记忆）里，第一项被渲染成占满整列的竖排高卡片，右侧三项是普通列，高度与节奏完全不一致。
- 原因：这几组 `Row` 被包在 `h('div',{className:'ab-grp-row'})` 里，而 CSS `.ab-grp-row>.ab-row{flex-direction:column;align-items:flex-start}` 会把网格内的 Row 强制竖排、`.ab-ctl{width:100%}` 把控件撑满整列 —— 于是每个 Row 变成一张「窄高卡」而非行。`.ab-grp-row` 本意是「组内自由流式排版」（聊天页在用），不适合承载标准行式设置项。
- 解决：记忆页三处组行（记忆开关与整理 / 每轮想起多少 / 记忆联想与加深）的 `ab-grp-row` 包裹全部去掉，`Row` 直接纵向排列（label 左、控件右）。聊天页 L2998/3006/3016 的用法保持不动（那边是用户验收过的流式排版）。
- 教训：`.ab-grp-row` 不是「行容器」而是「网格碎片排版容器」，里面放标准 `Row` 会被 CSS 改写成竖排卡。判断面板设置项该用哪种：**标准参数行一律直接放 `Row`**；只有需要把多个小控件挤在一行内自由换行时才用 `ab-grp-row`。
- 涉及文件/命令：`repo/client/client.js`（记忆页约 L5304-5378、CSS L727-729）；验证 `node --check` + `node --test test/panel-stage2.test.js test/panel-stage3.test.js test/group-panel-layout.test.js test/panel-root-render.test.js`（41/41）。

## 2026-11-17 收紧：`.ab-grp-row` 这条全局样式整套删除（聊天页同病）
- 现象：继记忆页之后，聊天页「被叫到时怎么回 / 没人叫时怎么接话 / 一条消息怎么变成回复」三组设置同样被渲染成竖排窄高卡，控件撑满整列。
- 根因（用户判断准确）：不是各页面写错，而是**一条全局 CSS 规则**——`.ab-grp-row{display:grid;...}` + `.ab-grp-row>.ab-row{flex-direction:column;...}` + `.ab-grp-row>.ab-row>.ab-ctl{width:100%}`，任何 `Row` 放进这个容器都会被改写成竖排卡。本意是「组内自由流式排版」，实际把标准行式设置全毁了。
- 解决：三处用法（聊天页 2998/3006/3016、记忆页三处）全部去掉包裹，`Row` 直接纵向排列；CSS 三行整段删除（无任何剩余使用者、无测试引用），原位留注释说明为什么移除，防止以后有人再引入。
- 教训：**「容器类改写了子组件形状」是面板布局类 bug 的常见源**——看到某个 Row 变竖排/控件撑满，先查它父容器的 class 有没有针对 `.ab-row` 的覆盖规则，别去改 Row 组件本身。全局样式删除前先 `Select-String test/*.test.js` 确认无断言依赖。
- 涉及文件/命令：`repo/client/client.js`（CSS L724-729 改注释、聊天页 L2996-3020 去包裹）；验证 47/47。
