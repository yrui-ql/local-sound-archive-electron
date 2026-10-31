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
