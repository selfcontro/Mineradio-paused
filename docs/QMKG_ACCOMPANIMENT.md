# 全民 K 歌伴奏接入

此适配只提供伴奏播放和 LRC 同步，不提供录音、麦克风采集、评分或原唱切换。

## 登录和使用

右上角「登录接入」中的全民 K 歌使用与其他平台相同的节点、排序、展示开关、扫码和 Cookie 界面。

- **扫码**：打开 `https://kg.qq.com/node/personal` 的官方窗口，由官方页面生成二维码，使用全民 K 歌手机版扫描并确认。窗口使用独立的 Electron 登录分区，必要 Cookie 由主进程读取。
- **Cookie**：导入自己的官方会话 Cookie，必须保留真实 `uid`、`openid`、`openkey`。登录结果通过受保护的伴奏接口验证后才保存并显示成功。
- **Windows 客户端兼容**：折叠设置中仍可主动检测 `WeSingCache/Log/WeSing` 的最新请求记录。只有用户明确检测或保存兼容目录时才读取客户端日志。

在搜索框选择「K歌伴奏」即可搜索播放。队列、内置歌单、播放恢复和历史记录保存平台身份与伴奏标记，每次播放重新获取有效媒体地址。搜索和歌词可以匿名查询，播放取决于登录会话和曲目权限。

## 凭据和退出

只使用 `ver`、`qua`、`uid`、`muid`、`opentype`、`udid`、`openid`、`openkey` 白名单，不读取支付字段。Cookie 的协议 `uid` 与界面用户 ID、`muid` 不是同一字段，不能相互补造。

扫码和导入的 Cookie 保存于 `QMKG_COOKIE_FILE`（桌面用户数据目录的 `.qmkg-cookie`），Windows Electron 运行时使用 `safeStorage` 系统加密。Node 开发服务使用本机权限受限的文件；不要将其提交到仓库。Cookie 不通过状态接口、IPC 返回值、队列或错误消息返回前端；导入文本提交成功后清空。

`QMKG_CONFIG_FILE` 只保存缓存目录和兼容检测启用标记。`QMKG_CACHE_DIR` 可明确指定官方客户端缓存根目录。原生请求日志只读取内存，不复制到凭据文件。

退出会清除保存 Cookie 和本平台网页登录分区，禁止自动从旧 Windows 日志恢复账号；重新扫码、导入或主动检测客户端后才能再连接。导入的会话失效时，不自动换到本机其他客户端账号。异步登录和检测不能在退出完成后重新激活账号。

## 协议

官方网页扫码页面自己的 `fcg_login_code` / `fcg_scan_login` 流程完成网页登录，`fcg_login_info` 仅用于昵称等展示信息。网页 Cookie 必须另经 `mini_kg_song` 的 `GetSongUrl|96|1` 验证，不能以“二维码生成”或“官方页面已登录”冒充伴奏授权成功。

搜索走 `search.search`，详情走 `ksonginfo.get`，歌词走 `fcg_lyric`。播放只接受返回的 `track_url`，不以原唱 `song_url` 替代；临时媒体地址通过本地 `/api/audio` Range 代理播放，不保存到歌单。歌词复用现有进度时钟和解析器。

这是私有协议互通，不是全民 K 歌开放平台 SDK，不需要申请其应用密钥，也不增加曲目或会员权限。平台更新可能影响可用性。

## 本地接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/qmkg/status` | 展示当前或已保存会话的状态，不扫描客户端日志 |
| `POST /api/qmkg/login/cookie` | `{cookie}`，远端验证成功后保存 |
| `POST /api/qmkg/logout` | 清保存态并禁止自动读取旧客户端会话 |
| `POST /api/qmkg/session/refresh` | 主动重新检测 Windows 客户端会话 |
| `POST /api/qmkg/config` | 保存 `{cacheDir}` 并主动检测兼容客户端 |
| `GET /api/qmkg/search?keywords=...&limit=15&offset=0` | 匿名伴奏目录搜索 |
| `GET /api/qmkg/song/detail?id=...` | 匿名歌曲详情 |
| `GET /api/qmkg/song/url?id=...` | 使用本平台会话获取伴奏 |
| `GET /api/qmkg/lyric?id=...` | 带时间戳的 LRC 歌词 |

接口只接受本机连接，校验 Host 和同源 Origin，不开放通配 CORS。修改、登录和退出使用 JSON POST。桌面扫码通过可信主窗口的 `openQmkgMusicLogin` IPC，Cookie 仅由主进程交给本地服务验证；`clearQmkgMusicLogin` 清理本平台分区与保存态。

## 验证

运行 `node --test tests/qmkg-*.test.js tests/built-in-playlist-library.test.js`，覆盖会话解析、导入和加密存储适配、注销竞态、Cookie 白名单、匿名查询、伴奏身份、平台 UI、官方窗口导航边界与换源阻断。

真实扫码需要账号本人在手机确认。不要提交实际登录日志、Cookie、签名 URL、私人缓存或歌曲文件。测试仅使用合成凭据和模拟响应。

媒体协议参考：[DBeidachazi/KGSing](https://github.com/DBeidachazi/KGSing)（MIT）；官方扫码入口使用其网页自身流程。版权声明见 `NOTICE.md`。
