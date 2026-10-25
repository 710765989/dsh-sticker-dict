# dsh-sticker-dict

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)

> 给视觉模型用的表情包字典，外加把人看不懂的动图拆成一张拼图。

DeepSeek-Harness 的视觉模型有两个浪费：同一个表情包每次发来都要重新识图，发来动图却只能看到第一帧。这个插件补的就是这两块：

- **`sticker_dict`** —— 表情包字典。看过的图按**内容 sha256** 记下来，同一个表情再发来直接返回上次的结论，不再重新识图。静态图、GIF 都能存，还支持给某条加「主人批注」。
- **`gif_frame_extraction`** —— 把一个 GIF 均匀抽 N 帧，横向拼成一张联系表（contact sheet），返回一张图的路径。模型看一张拼图就知道整段动作怎么走的，比一帧一帧喂省 token。

两个工具在「插件 → sticker-dict」那一行的设置卡片里可以各自独立开关，改完立即生效，不用重启。

## 特性

- **抽帧可视化** —— `gif_frame_extraction` 抽帧后拼成一张 PNG，返回 `{ path, width, height, frames, picked }`，配 `read_image` 使用。
- **同图不重读** —— 抽帧前先查字典，命中就直接返回上次的描述和命中次数，连解码都省了。
- **按内容去重** —— 字典以图片内容的 sha256 为键（GIF 还是按结构块解析出的宽高、帧数一起记），换文件名、换目录也认得出来。
- **主人批注** —— `annotate` 可以给某条记录写上人话解释，之后每次命中都会一起带出来；模型自己的 `note` 和人工批注分开存，互不覆盖。
- **截图不占坑** —— 超过约 200 万像素的非动图默认当截图，不往字典里塞（想存可以带 `force`）。
- **自动淘汰** —— 字典上限 2000 条，超了淘汰最久没被访问的。
- **面板即时开关** —— 抽帧、字典两个开关走 `/api/dsh-sticker-dict-settings/{describe,mutate}` 读写，改完马上作用于下一次工具调用。

## 安装

```sh
dsh plugin add github:710765989/dsh-sticker-dict
```

然后重启 `dsh web`，插件列表里会出现 `sticker-dict` 一行。

依赖只有 `@napi-rs/canvas`（预编译原生库，装上即用，不需要构建环境）。仓库自带 `.npmrc` 关闭了 peer 自动安装，避免 pnpm 顺着宿主包的 peer 链去抓未发布的包。

手动装的话，在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: sticker-dict
      name: dsh-sticker-dict
```

## 配置

在插件列表里 `sticker-dict` 那一行点开配置卡片，或直接改 `cordis.patch.yml`：

```yaml
- id: sticker-dict
  name: dsh-sticker-dict
  config:
    frames:
      enabled: true      # 抽帧工具总开关
      maxFrames: 5       # 默认抽几帧
      cellPx: 140        # 每帧边长（像素）
    dict:
      enabled: true      # 字典总开关
      dir: ''            # 字典目录，留空用默认 ~/.dsh/sticker-dict/dict
    enabled: true
```

## 工具

### `gif_frame_extraction`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string，必填 | GIF 文件路径 |
| `maxFrames` | number | 抽几帧，省略用配置（默认 5） |
| `cellPx` | number | 每帧边长，省略用配置（默认 140） |

命中字典时直接返回上次的结论（`cached: true`），不会重新抽帧。

### `sticker_dict`

| action | 作用 |
| --- | --- |
| `lookup` | 查这张图以前看过没有（GIF、静态图都行） |
| `remember` | 把看图的结论记进字典，下次直接复用 |
| `annotate` | 给某条加/改主人批注（按 `sha` 或 `path` 定位） |
| `forget` | 删一条 |
| `list` | 看字典规模，或按关键词列条目 |

## 服务

插件对外提供 `stickerDict` 服务，别的插件可以直接用：

```js
ctx.stickerDict.contact(path, { maxFrames: 6, cellPx: 160 })  // 抽帧拼图
ctx.stickerDict.lookup(path)                                   // 查字典（命中会累加 hits）
ctx.stickerDict.remember(path, note, force)                    // 记一条
ctx.stickerDict.annotate(sha, { note, owner })                 // 改批注
ctx.stickerDict.list() / entries(limit, keyword) / forget(path)
```

## 字典放哪

默认 `~/.dsh/sticker-dict/dict/`（Windows / macOS / Linux 同一个写法），一条记录一个 `<sha256>.json`：

```json
{ "v": 1, "sha": "…", "note": "…", "owner": "…", "w": 480, "h": 320, "frames": 12, "source": "gif", "at": 1761300000000, "hits": 3 }
```

想换个地方就在配置里写 `dict.dir`。

## 依赖

- 官方包 `@deepseek-ai/dsh-tools` 走 `peerDependencies`，不随插件重复安装。
- 图片处理用 [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas)（预编译二进制，装完即用，不需要本地编译工具链）。

## License

MIT
