# 汽水音乐 source extension

汽水音乐扩展，先用本机下载服务作为平台适配桥：

- 读取本机汽水客户端 Cookie；
- 搜索汽水音乐；
- 把下载任务交给本机下载队列；
- 读取“喜欢”歌单；
- 定时喜欢同步任务（只把新增红心加入下载队列）。

## Auth

使用本机汽水客户端登录态，不需要在留声里输入账号密码。

## Methods

- `search`
- `resolve`（返回 `{ queued: true }` 时由核心标记为已入队）
- `auth.begin` / `auth.status`
- `likes.list` / `likes.sync`
- `job.run`（`likes-sync`）

## Notes

依赖本机 `go-music-dl` 服务和管理员凭据。凭据从本地数据目录读取，不写入扩展 manifest 或仓库。
