# 产品反思 · 2026-10-31

这不是一份“已经做好了”的总结，而是对这次 LSA / Electron 开发过程的复盘。用户反复指出：功能“接上了”，但没有从用户任务出发设计；我修的是报错，不是体验。

## 我实际犯的错

| 现象 | 真实根因 | 应该先问的问题 |
|---|---|---|
| 录音只能录，不能听、不能删 | 把 `recordStart` 当成功能完成，没有设计录音后的任务闭环 | 用户录完后要做什么？试听、删除、找到文件、继续录 |
| 录音列表一次全量加载 | 只实现“列出文件”，没考虑数量和 DOM 成本 | 1 万条时首屏加载时间、滚动、内存、删除后的刷新 |
| 下载队列保留成功任务 | 把后端队列当展示列表，没区分“待处理工作”和“历史记录” | 成功任务还有行动价值吗？失败任务需要保留吗？ |
| 清空队列 403 | 只照抄了 DELETE 路径，没有验证认证链路 | 谁有权清空？失败时用户看到什么？ |
| 登录状态显示未登录 | 代码改了，但部署数据里没有管理员凭据；旧进程还在跑 | 状态来自哪里？首次启动的默认值是什么？ |
| README 截图是旧客户端 | 没有把“交付证据”纳入完成定义 | 这张图是否代表当前版本？顶部/关键区域是否一致？ |
| 审计失败后试图清零 Electron 字节 | 把“审计通过”当成目标，而不是把“发布物干净”当成目标 | 哪些是项目文件？哪些是第三方运行时？正确的豁免边界是什么？ |
| 目录平铺、main 过重 | 没先查 Electron 进程边界和项目结构惯例 | main/preload/renderer/service 各自负责什么？ |
| 个人路径写进默认配置 | 没先做“通用默认 + 用户覆盖” | 换用户/换机器是否要改代码？ |

## 根因

1. **以 API 为中心，而不是以用户任务为中心**：有 `recordStart` 就以为录音完成；有 `recordings` 就以为列表完成。
2. **没有状态矩阵**：只设计 happy path，没有 loading / empty / error / partial / success 的完整状态。
3. **把“编译通过 / 命令返回 ok”当成验收**：没有在真实界面走一遍用户路径。
4. **没有先调研再决策**：技术栈、目录、配置、审计都存在“先写再补”的猜测。
5. **没有把反思变成产物**：反思只停留在对话里，所以下一轮又犯同类错误。
6. **默认值没有产品判断**：首次打开应该可用；不能让用户先猜配置、猜凭据、猜端口。

## 我采用的思考框架

这次实际调用了工作区技能，而不是凭感觉：

- `ui-ux-review`：按状态、反馈、可访问性、平台惯例审查界面；
- `ui-progressive-disclosure`：默认只显示标签和当前选择后果，细节进 tooltip / 折叠；
- `project-loop`：先调研、再决策、再实现、再验证、最后反思；
- 外部参考：用户旅程、状态设计、完成定义（见文末）。

## 产品原则（后续必须遵守）

1. **用户任务优先**：先写“用户要完成什么”，再决定 IPC、数据库和页面。
2. **默认可用**：首次启动就有合理默认；个人路径/凭据走本地配置；端口被占用自动避让。
3. **状态齐全**：每个异步操作有 idle / loading / progress / success / error / retry；每个列表有 empty / loading / error / pagination。
4. **结果可行动**：录音可试听/删除，失败任务可重试，成功任务不占队列；破坏性操作有确认。
5. **状态来自真实源**：登录态读后端 Cookie，不读本地残留；成功数来自真实响应。
6. **渐进披露**：默认界面只显示当前选择会发生什么；技术细节放帮助/折叠，不铺开发说明。
7. **可访问性底线**：图标按钮有 `aria-label`、键盘可达、焦点可见、弹窗焦点回归。
8. **通用核心 + 用户配置**：代码里没有个人路径/身份；默认配置入库，个人值本地覆盖。
9. **完成 = 证据**：代码 + 真实操作验证 + 截图/录屏 + 文档 + 审计结果，缺一不算完成。
10. **先研究再自研**：未知技术先查官方文档、上游源码、成熟项目；决策写 ADR。

## 新的完成定义（DoD）

一个功能只有同时满足以下条件才算完成：

- [ ] 用户旅程和边界情况写清楚（首次、空、失败、重复、取消、大数据量）；
- [ ] 每个状态有可见反馈，失败有恢复路径；
- [ ] 真实界面操作验证过至少 happy path + 一个失败路径；
- [ ] 列表有分页/上限/空状态；长任务可取消或显示进度；
- [ ] 破坏性操作有确认，结果有真实反馈；
- [ ] 键盘可操作，图标有可访问名称；
- [ ] 配置不含个人值，默认值可用；
- [ ] 截图/文档与当前版本一致；
- [ ] 源码审计和构建包审计通过；
- [ ] 反思记录到 `docs/product-reflection-*.md`，而不是只留在对话里。

## 这次之后已经落地的改变

- 录音：播放/暂停、删除、确认、分页 40 条、滚动加载、状态动画、空/错/加载状态；
- 下载队列：成功任务自动移出，失败任务保留，清空走真实认证；
- 登录：二维码/登录态读取真实后端，凭据进入本地数据目录；
- MCP：端口可改，占用自动顺延；
- 配置：`config/default.json` 通用默认 + 本地覆盖；
- 架构：`src/main/index.js` / `src/main/services/` / `src/preload/index.js` 分层，ADR 记录；
- 审计：第三方运行时用 SHA256 固定 allowlist，不再破坏二进制；
- 文档：架构、工程流程、ADR、反思全部入库。

## 参考

- [Electron project structure](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/architecture/project-structure.md)
- [Electron process separation](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/architecture/process-separation.md)
- [Electron security checklist](https://github.com/jwynia/agent-skills/blob/main/skills/tech/development/tooling/electron-best-practices/references/security/security-checklist.md)
- [UX states](https://github.com/ryan-mahoney/ryan-llm-skills/blob/main/rules/ux-states.md)
- [Definition of Done](https://www.productboard.com/product-management-prompts-library/definition-of-done-checklist/)
- [User journey / edge cases](https://skillsmp.com/ko/creators/gulati8/justice-league-factory/claude-skills-product-thinking)

## 追加教训（滚动、标题与原生控件）

- 文件名里的 `01_` 是音轨号，不是歌名；显示层必须剥离，不能把原始文件名直接当产品标题。
- 隐藏原生滚动条不是完成；必须提供 hover 可见、可拖拽的 overlay，以及 PageUp/PageDown、Home/End 等快速滚动方式。
- 原生 `<select>` 的弹层由系统绘制，无法主题化；必须用自绘 listbox，并保留键盘、aria 和程序化 value 同步。
- 页面布局不是单页修补：列表页统一采用固定头部 + flex 撑满 + 单一滚动列表；进入页面重置滚动位置。
- 每修一个组件都要在真实窗口截图/操作验证，不能只看代码和构建成功。

## 追加教训（下载记录）

- 下载任务页有两个语义：等待/下载中的队列，以及最近记录。一个「清空等待」按钮不能清空最近记录。
- 清空动作必须跟当前 tab 绑定：当前是「最近」就清记录，当前是「当前」就清等待队列；文案、确认弹窗、空状态都要同步。
- 每个 tab 的空状态都要能回到一个明确动作，不能留下“看着能点但清不掉”的按钮。

## 追加教训（专辑列）

- 这批文件的 FLAC/M4A 标签里没有 album 字段；同时全量解析会显著拖慢首次扫描。
- 因此删除「专辑」列，换成真实可用的文件日期列，而不是保留一整列「—」。
- 先验证数据能力再决定列；不能为了“看起来完整”保留空字段。

## 追加教训（删除与喜欢反向同步）

- 删除本地歌曲必须把文件移到回收站，并同步更新库、队列和最近播放；不能只从界面移除。
- 删除已喜欢的歌曲时，记录到 `likes/ignored.json`，下次同步跳过，避免重新下载。
- go-music-dl 当前只提供喜欢读取，没有平台取消喜欢写接口；因此只能做到“本地忽略”，不能声称平台红心已取消。

## 追加教训（行首图标叠字）

- 行首同时放序号和播放按钮，不能靠 opacity 互相淡出；过渡期间两个 glyph 会叠成一团。
- 现在按状态使用 display 互斥切换：默认序号，hover/focus 播放，播放中 EQ，暂停当前歌曲显示播放。
- 这类“同一槽位替换”的 UI 必须在真实 hover 状态下截图检查，不能只看静态首屏。

## 追加教训（整理音乐库报错）

- `maintain` 返回的是 summary 对象，renderer 当字符串调用 `.split()`，所以点击后抛 `res.summary.split is not a function`。
- 已做类型收窄，状态栏显示真实结果：`1366 首 · 95 GB`。
- 已通过 Electron CDP 在真实应用里调用 `call('maintain')` 验证返回结构，再验证 UI 摘要字符串；不是只跑语法检查。

## 追加教训（上一首/下一首）

- 用户指出上一首应按真实听过顺序返回，不受随机/循环模式影响；下一首才按模式。
- 已增加 `state.playHistory`，每次真实切歌记录上一首；上一首从历史弹出，`fromHistory` 不再反向写入。
- 通过 Electron CDP 实际播三首后验证：上一首回到第二首，历史只剩第一首。

## 追加教训（主题切换卡顿）

- 根因：`html.theme-switching * { transition: ... !important }` 给整页所有节点强制 300ms 过渡；主题变量本身不是瓶颈。
- 已删除全局过渡和 102 条纸张主题逐选择器硬编码覆盖，主题色统一走 `--ui-*` 变量；实测连续切换 6 个主题到下一帧约 10–18ms。
- 纸张主题实际截图检查通过；`badge.accent` 和下载状态色改为变量 mix，不再残留固定薄荷绿。

## 追加教训（界面比例实时生效）

- 用户要求界面比例下次启动才生效；已改为滑块只保存配置并提示“重启留声后生效”，不实时改 DOM。
- 配置由主进程写入 `config.json`；启动时通过 `loadFile` 的 query 传入，首屏内联脚本在 CSS 绘制前设置 `--text-boost`，避免启动闪烁。
- 实测：改到 120% 时当前窗口不变；重启后 query/`--text-boost` 均为 1.2，字体从 17.3px 变为 20.75px。

## 追加（扩展能力层阶段一）

- 已实现来源自动注册：扩展 manifest 的 `sources` 合并进 `getSources`，搜索页显示动态来源筛选。
- 已实现核心调度器：扩展声明 `jobs`，核心持久化下次运行时间、调用 `job.run`、记录状态；`news-feed` 示例任务已实际跑通并生成文件。
- 已暴露通用 `extensionInvoke`，为后续 `auth.*` / `likes.*` 契约做入口。
- 内置网易云/QQ/汽水仍走内置适配器；迁移为完整扩展（登录、搜索、下载、喜欢）是下一阶段，不能对外说成已完成。

## 追加纠正（新闻示例）

- 用户指出：这是音乐播放器，不该在正式应用里安装“新闻同步示例”。已删除已部署扩展和仓库示例目录。
- 扩展调度器保留为通用核心能力，可服务喜欢同步等音乐相关周期任务；不把新闻当作产品功能。
- 规则：示例/示例扩展只能留在 SDK 开发目录，不能默认安装进用户应用；安装演示内容前先问“它属于这个产品吗”。

## 追加（开发工具重新检测）

- 用户指出「重新检测」点击后没有反馈，且 DSH 明明装了却没检测到。
- 已加按钮 busy 态、旋转图标、检测状态行、最短可见时间和结果 toast。
- DSH 安装路径在注册表 `HKCU\...\Uninstall` 的 `DisplayIcon` 中，不在 PATH；检测现同时查 PATH、常见安装目录和注册表，实测识别到 `<DSH install>\DeepSeek Harness.exe`。
- Cursor / Codex 本机确实未安装，UI 显示未安装是正确的，不伪造。
- 新增 `agents` 纯函数单测，测试数 25。


## 追加（进度条时间气泡挡住拖动）

- 时间气泡虽然设了 `pointer-events:none`，但固定在进度条上方且命中区域只有 4px，用户仍会觉得拖不动。
- 已把气泡定位到轨道下方 `rect.bottom + 6`，明确 `pointer-events:none !important`，并把 range 实际命中高度提升到 14px，视觉轨道仍保持 4–6px。
- 这类“看得见但点不到”的问题必须用真实拖拽验证，截图不算完成。

## 追加（进度条一格一格）

- 进度点卡顿的根因是只在 `timeupdate`（约 4Hz）和媒体事件时更新 range，属于离散跳变。
- 已改为 `requestAnimationFrame` 60fps 显示循环，用锚点时间推进并按目标时间做小幅修正；range 使用 `step="any"`。
- 命中高度 14px，时间气泡 `pointer-events:none` 并固定到轨道下方。
- 用 CDP 实际播放采样并模拟从 25% 拖到 70%，实际进度到 70.2%，拖动链路验证通过。

## 追加（信息图标没有提示气泡）

- 用户指出喜欢同步设置里的 info 图标没有气泡。原实现只绑定 `click`，hover/focus 不显示；且图标在 label 内，点击还可能触发表单切换。
- 现已支持 hover 140ms 后显示、focus 显示、点击固定显示；点击外部/Esc 关闭；气泡从图标下方展开并在靠边时翻转。
- 实际用 CDP 验证了悬浮气泡文本和位置，点击后不再被同一按钮立即关闭。

## 追加（播放按钮 hover 被裁切）

- 播放按钮的缩放动效被 `.player-center { overflow: hidden }` 裁掉上下边缘。
- 已解除 player-center、transport、transport-play 的 overflow 限制；实测 hover 后 transform 1.035，上下命中点仍返回 btnPlay，不再裁切。
