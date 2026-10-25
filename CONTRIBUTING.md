# Contributing / 贡献

## Development / 开发

```sh
npm install
```

Load the plugin into a local profile to try it / 挂到本地 profile 里试：

```sh
dsh plugin --profile web add /path/to/dsh-sticker-dict
```

Then restart `dsh web`. The settings card appears on the `sticker-dict` row under Plugins. / 然后重启 `dsh web`，插件列表里 `sticker-dict` 那一行就有设置卡片。

## Layout / 目录

```
lib/index.js       entry: tools, `stickerDict` service, settings bridge routes
                  入口：工具注册、stickerDict 服务、设置 bridge 路由
lib/gif.js         GIF block-walking parser + frame contact sheet
                  GIF 结构块解析（宽高/帧数）+ 抽帧拼图
lib/dict.js        sticker dictionary: sha256 index, hit counting, eviction
                  表情包字典：sha256 索引、命中计数、淘汰
lib/client.js      plugin settings card (web client)
                  插件页设置卡片（web 客户端）
cordis.patch.yml   the entry merged into the profile on install
                  安装时插进 profile 的那一条
```

## Conventions / 约定

- No build step; plain ESM, Node >= 20. / 不设构建步骤，纯 ESM，Node >= 20。
- `@deepseek-ai/*` packages are `peerDependencies`, never `dependencies`. / 官方包一律 `peerDependencies`。
- The dictionary never leaves the machine — it is local JSON under `~/.dsh/sticker-dict/dict`. / 字典只存在本机。
- Chinese comments are the house style here; keep new code consistent with the file you touch. / 注释沿用中文。
