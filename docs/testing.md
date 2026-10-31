
## 测试策略

### 单元测试

```bash
npm test
```

使用 Node 内置 `node:test`，不引入额外测试框架。

覆盖：

- `LibraryStore`：写入、更新、全量替换、删除清理；
- `ExtensionStore`：安装、列表、启用/禁用、移除、无效 manifest；
- `ExtensionHost`：搜索、结果归一化、resolve 输出文件、子进程退出清理；
- `ExtensionScheduler`：任务注册、持久化、成功/失败状态；
- `LikesStore`：忽略列表去重、配置边界；
- `buildSourceRegistry`：内置源、扩展来源自动注册、禁用过滤；
- `files`：标题前缀清洗、安全文件名。

### 集成/冒烟

- 打包后启动 Portable，检查窗口、音乐库、搜索、扩展下载、主题和界面比例；
- 任何“只在真实 UI 出现”的问题，必须用真实进程复现，不以单元测试通过代替。

### 规则

- 先写或更新测试，再改实现；
- 失败测试优先于临时手动验证；
- 测试不能依赖个人目录、外部网络或真实平台账号。
