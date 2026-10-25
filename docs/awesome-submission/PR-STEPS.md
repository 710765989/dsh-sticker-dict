# 提 PR 到 awesome-dsh-plugin 的操作单

> 同目录的 `entry.yml` 是给 awesome-dsh-plugin 仓库用的条目文件，**不是**本仓库的东西。
> 提 PR 时把它复制到 awesome 仓库的 `data/plugins/` 下，文件名换成你真实的 `<owner>__<repo>.yml`。

## 0. 先决条件（缺一不可）

- 本仓库已经推到 GitHub 上，**创建满 1 天**（CI 自动查）。
- 仓库加了 `dsh-plugin` topic（仓库首页 → About 右边的齿轮 → Topics）。
- 仓库的 `package.json` 里 `dsh.bundle.patch` 指到 `cordis.patch.yml`（已经有了）。
- 有真实可跑的代码（不是占位仓库）——这点没问题。

## 1. fork + clone awesome 仓库

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git switch -c add/dsh-sticker-dict
```

## 2. 放条目文件（只加这一个文件）

```sh
cp /path/to/dsh-sticker-dict/docs/awesome-submission/entry.yml \
   data/plugins/<你的GitHub用户名>__dsh-sticker-dict.yml
```

然后把文件里的 `OWNER` 两处都换成你的 GitHub 用户名：

```yaml
url: https://github.com/OWNER/dsh-sticker-dict
name: OWNER/dsh-sticker-dict
```

**不要手工改 README / README.zh** —— 那两份是脚本从 `data/plugins/*.yml` 生成的，合并后会自动重建。

## 3. 本地预检（可选但推荐）

```sh
npm ci
node scripts/generate-readme.mjs
npx awesome-lint
```

README 重新生成后如果有 diff，说明你那一行格式不对；修到「生成结果与你的条目一致」为止。

## 4. 提交 & 发 PR

```sh
git add data/plugins/<你的用户名>__dsh-sticker-dict.yml
git commit -m "Add <你的用户名>/dsh-sticker-dict (vision)"
git push -u origin add/dsh-sticker-dict
gh pr create --title "Add dsh-sticker-dict" \
  --body "Sticker dictionary keyed by content sha256 so seen images are recalled instead of re-read, plus GIF contact sheets for vision models. Two tools: \`sticker_dict\`, \`gif_frame_extraction\`."
```

## 5. CI 会依次查什么

1. 一个 PR 最多 3 条（你只有 1 条）。
2. 从你仓库 `package.json` 读到 `dsh.bundle`（只声明 `dsh.client` 会挂）。
3. 仓库创建满 1 天。
4. `awesome-lint` + 站点构建（双语、分隔符、日期、截图）。

挂了会在 PR 评论里写明改什么，**在同一个分支上 push 修复就行，不用重开 PR**。

## 已经对齐的点

- `category: vision` —— 干的是「让视觉模型看清动图」，不是 UI 增强。
- 描述只讲功能、没营销词，且与代码一致：两个工具 `gif_frame_extraction` / `sticker_dict`，字典按内容 sha256 索引。
- 官方包 `@deepseek-ai/dsh-tools` 走 `peerDependencies`，范围带显式预发布分支：
  `>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`
- 已自带 `cordis.patch.yml`。
- 截图可选：需要在仓库里放 `screenshots.json`（1-8 张 GitHub 托管的图）。想加的话把插件设置卡片截个图，放 `assets/screenshot-1.png`，再建 `screenshots.json`：

```json
["assets/screenshot-1.png"]
```

## 关于依赖：为什么仓库里要放 `.npmrc`

本插件有两个外部包：

- `@napi-rs/canvas` —— 真正干活的原生渲染库（`dependencies`）。预编译，装着就能用，不需要 CMake / VS 构建环境。
- `@deepseek-ai/dsh-tools` —— 宿主提供的工具 API（`peerDependencies`，且标记 `optional`）。

**必须保留仓库根目录的 `.npmrc`**：

```
auto-install-peers=false
strict-peer-dependencies=false
```

原因：pnpm 如果被允许自动装 peer，会顺着 `dsh-tools` 声明的 peer 链去抓
`@deepseek-ai/dsh-type-meta` 这类**没有发布到 npm registry 的包**，直接 `ERR_PNPM_FETCH_404` 装不上。

每个人 profile 里的 pnpm 配置不一样，所以不能指望用户自己配 —— 写在仓库里才能保证「谁装都是同样的结果」。

## 提醒

- 提交前把本仓库 `package.json` 里的 `repository.url` 里的 `你的GitHub用户名` 换成真名。
- 安装后如果报 `Cannot find native binding`，是 `@napi-rs/canvas` 的平台二进制没装对（常见于换了 Node 架构或跨平台复制了 `node_modules`）。删掉 `node_modules` 和 `pnpm-lock.yaml` 重装即可。
