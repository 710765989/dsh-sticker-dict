> 这份文件只是**本地开发**的说明，不影响安装。

# 开发

```sh
npm install
```

## 本地挂到一个 profile 上调试

```sh
dsh plugin --profile web add /path/to/dsh-sticker-dict
```

改完代码重启 `dsh web`。想在面板上看到开关，确认 profile 的 `cordis.patch.yml` 里有：

```yaml
- id: sticker-dict
  name: dsh-sticker-dict
```

## 目录

```
lib/index.js    插件入口：工具注册、服务 stickerDict、设置 bridge 路由
lib/gif.js      GIF 解析（结构块走一遍拿宽高/帧数）+ 抽帧拼图
lib/dict.js     表情包字典：sha256 索引、命中计数、淘汰
lib/client.js   插件页设置卡片（web 客户端）
cordis.patch.yml  安装时插进 profile 的那一条
```
