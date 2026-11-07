# 全民 K 歌 Windows 伴奏接入

本适配以 Windows 全民 K 歌客户端的有效登录态为来源，只提供伴奏播放和 LRC 歌词同步，不提供录音、麦克风采集、评分或原唱切换。

## 使用

登录官方普通 PC 客户端，打开 Mineradio 右上角的「登录接入」面板，点击第五个「全民 K 歌」节点，再点「检测连接」，成功后可点击「搜索伴奏」。也可以点击搜索框，选择「K歌伴奏」并重新检测。未找到缓存时，填写官方客户端的 `WeSingCache` 根目录，而不是安装目录或 `Log` 子目录。搜索、队列和内置歌单保存歌曲 ID 与伴奏标记；每次需要播放时获取有效媒体地址。

选择平台或打开面板只读取已缓存的连接状态；点击检测、保存目录或拖动端口连接到 MR 才主动检测客户端会话。此节点不显示扫码或 Cookie 导入，不会将全民 K 歌当作其他平台账号；退出账号需在官方客户端完成。

配置优先使用明确指定的目录（`QMKG_CACHE_DIR` 或页面保存的目录），并尝试常见的 Windows 缓存位置。`QMKG_CONFIG_FILE` 只存 `{ "cacheDir": "..." }`，桌面运行时位于 Mineradio 用户数据目录；仓库已忽略默认设置文件。

## 数据流

```text
官方 Windows 客户端完成登录
  → WeSingCache/Log/WeSing 内的最新请求记录
  → 服务端读取白名单 Cookie 字段（仅内存）
  → node.kg.qq.com/webapp/proxy 的 GetSongUrl|96|1
  → track_url 伴奏资源
  → Mineradio 本地 /api/audio Range 代理
  → 现有音频播放与歌词时钟
```

搜索走 `search.search`，详情走 `ksonginfo.get`，歌词走 `fcg_lyric`。这是私有协议互通，不是全民 K 歌开放平台 SDK，不需要申请其应用密钥，但不代表获得额外曲目或会员权限。

Windows 请求日志中的真实 Cookie `uid` 必须原样保留，不能用界面日志 `SetWebCookie` 的 `strLoginUID` 拼接代替。登录字段限定于 `ver`、`qua`、`uid`、`muid`、`opentype`、`udid`、`openid`、`openkey`；不读取支付字段。缺失凭据或当前记录清空登录时，不复活较旧会话。

只接受伴奏 `track_url`。上游只有原唱 `song_url` 时返回不可播放，前端也禁止将这类队列项换成普通音乐源。

## 本地接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/qmkg/status` | 展示缓存状态，不扫描登录日志 |
| `POST /api/qmkg/session/refresh` | 用户主动重新检测会话 |
| `POST /api/qmkg/config` | 保存 `{cacheDir}` 并检测 |
| `GET /api/qmkg/search?keywords=...&limit=15&offset=0` | 匿名伴奏目录搜索 |
| `GET /api/qmkg/song/detail?id=...` | 匿名歌曲详情 |
| `GET /api/qmkg/song/url?id=...` | 使用本机登录态获取伴奏 |
| `GET /api/qmkg/lyric?id=...` | LRC 歌词，接入已有歌词解析和进度时钟 |

适配接口仅接受本机连接，校验本机 Host 和同源 Origin，并且不开放通配 CORS。修改配置与重新检测需要同源 JSON POST；Cookie 不进入接口响应。媒体临时地址只用于当前播放，不保存到设置或歌单。

## 验证

`node --test tests/qmkg-api.test.js tests/qmkg-server.test.js tests/qmkg-frontend.test.js tests/qmkg-login-panel.test.js tests/built-in-playlist-library.test.js` 覆盖会话解析/更新、匿名查询、伴奏权限失败、接口边界、伴奏身份持久化、平台连接图、前端路由和换源阻断。

真实联调需要开发者自己的已登录官方客户端。不要把登录日志、Cookie、签名音频 URL、私人缓存或测试下载的歌曲提交到仓库。公开仓库的测试仅使用合成凭据和模拟响应。

协议参考：[DBeidachazi/KGSing](https://github.com/DBeidachazi/KGSing)（MIT）。本项目使用自己的 Windows 会话发现与 Mineradio 播放适配；不使用其 macOS 微信日志发现器。版权声明见 `NOTICE.md`。
