# 扫描后自动分析流程设计

## 目标

每次手动或定时扫描后，系统自动完成：

1. 拉取 X 新帖并去重。
2. 写入 `latest.json`、`briefing.json` 和 archive 初稿。
3. 对新帖做深度分析，补充 `codexAnalysis`。
4. 重新生成主题聚类简报。
5. 更新同一次 run 的 archive，保证历史保存的是最终分析版。

## 当前可用流程

当前扫描脚本 `npm run scan` 已经会自动生成：

- `public/data/latest.json`
- `public/data/briefing.json`
- `public/data/archive/posts/<run>.json`
- `public/data/archive/briefings/<run>.json`
- `public/data/archive/index.json`

如果使用 Codex 做深度分析，流程是：

1. 运行 `npm run scan`。
2. 使用 `x-radar-analyzer` skill 读取 `latest.json`。
3. Codex 产出分析 JSON。
4. 运行 `merge-analysis.mjs <project-root> <analysis-json>`。
5. merge 脚本同步刷新：
   - `latest.json`
   - `briefing.json`
   - 当前 run 的 posts archive
   - 当前 run 的 briefing archive
   - `archive/index.json`

这个流程不额外消耗 X API，只消耗 Codex/LLM 分析成本。

## 全自动方案

后续如果要脱离人工 Codex 操作，可以新增：

```text
npm run scan:analyze
```

它内部执行：

```text
x-radar.mjs
  -> 写本地规则版 latest / briefing / archive
  -> analyze-latest.mjs 调用 OpenAI API
  -> merge-analysis.mjs 合并深度分析并刷新 archive
```

建议新增环境变量：

```text
OPENAI_API_KEY=
X_RADAR_ANALYSIS_MODEL=gpt-4.1-mini
X_RADAR_ANALYSIS_MAX_POSTS=50
```

## 分析原则

分析优先级按私人雷达价值判断：

- 高信号：新信息、技术学习价值、投资/标的线索、明确后续 action。
- 中信号：有参考价值的趋势或框架，但没有明确行动。
- 低信号：纯链接、表情、社交、泛个人思考、无上下文内容。

互动数只做弱辅助，不应决定高低信号。

## 失败处理

- X 扫描失败：不更新 seen 状态。
- `latest.json` / `briefing.json` / archive 任一写入失败：不更新 seen 状态。
- LLM 分析失败：保留本地规则版 archive，并在下一次或手动运行 merge 时补齐。
- merge 成功后必须覆盖同一 run 的 archive，避免历史和最新视图不一致。

## 推荐下一步实现

1. 增加 `scripts/analyze-latest.mjs`，调用 OpenAI API 生成分析 JSON。
2. 增加 `npm run scan:analyze`。
3. 加入成本保护：最多分析 N 条、只分析中高候选、跳过低信息量内容。
4. 在 history 页面显示 run 是否已经有 `codexAnalysisUpdatedAt`。
