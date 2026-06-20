# X Following Radar

每天或手动扫描指定 X 账号的最新帖子，生成 Markdown 摘要，并用本地状态文件避免重复汇报。

## 准备

1. 在 X Developer Portal 创建项目和 App，拿到 `Bearer Token`。
2. 复制 `.env.example` 为 `.env`，填入：

```env
X_BEARER_TOKEN=你的_token
```

3. 编辑 `config/sources.json`，加入要监控的账号：

```json
{
  "timezone": "Asia/Shanghai",
  "lookbackHours": 24,
  "maxPostsPerAccount": 3,
  "includeReplies": false,
  "includeReposts": false,
  "language": "zh-CN",
  "accounts": [
    { "handle": "karpathy", "name": "Andrej Karpathy" },
    { "handle": "levelsio", "name": "Pieter Levels" }
  ]
}
```

## 运行

```bash
npm run scan
```

输出报告会写入 `reports/`，去重状态会写入 `state/seen-posts.json`。

试跑但不写入去重状态：

```bash
npm run scan:dry
```

估算一次扫描的 X API 读取成本：

```bash
npm run cost
```

打开本地阅读页面：

```bash
npm run dashboard
```

然后访问：

- 时间线：`http://127.0.0.1:4173`
- 今日简报：`http://127.0.0.1:4173/briefing.html`
- 历史归档：`http://127.0.0.1:4173/history.html`

页面只读取 `public/data/*.json` 和 archive 文件，不会调用 X API。

导出某个账号可见的关注列表，方便挑选监控源：

```bash
node scripts/x-radar.mjs --discover-following "@DianZhiAI" --limit 200
```

结果会写入 `config/following-dianzhiai.json`。检查后，把想监控的账号复制到 `config/sources.json` 的 `accounts` 数组里。

如果 X 返回 `does not have any credits`，说明 token 可用，但 Developer Console 里还没有可消费的 API credits。

## 去重策略

脚本用 X post id 作为唯一键。只有报告成功写入后，才会把本次汇报过的帖子写入 `state/seen-posts.json`。默认不清理旧 id，所以同一条帖子之后不会重复汇报。

## 数据与归档

每次扫描会写入当前视图和不可变历史：

- `public/data/latest.json`：最新一次帖子数据。
- `public/data/briefing.json`：最新一次主题聚类简报。
- `public/data/archive/posts/<run>.json`：某次扫描的帖子归档。
- `public/data/archive/briefings/<run>.json`：某次扫描的简报归档。
- `public/data/archive/index.json`：历史页面使用的归档索引。

如果之后用 Codex 深度分析补充 `codexAnalysis`，merge 脚本会同步刷新当前简报和同一次 run 的 archive。

## 自动分析设计

扫描后自动分析的方案见 [docs/auto-analysis-flow.md](docs/auto-analysis-flow.md)。当前可用流程是先 `npm run scan`，再用 `x-radar-analyzer` skill 合并 Codex 分析；后续可以接 OpenAI API 做成 `npm run scan:analyze`。

## 定时

### Windows 任务计划程序

可以创建每天一次的任务，动作设置为：

```text
程序: powershell
参数: -NoProfile -ExecutionPolicy Bypass -Command "cd C:\Users\icecream\Documents\X; npm run scan"
```

### GitHub Actions

也可以把项目推到 GitHub，用 Actions 每天跑，并把 `state/` 和 `reports/` 提交回来。需要把 `X_BEARER_TOKEN` 放进仓库 secrets。
