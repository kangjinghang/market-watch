# 远程运维 SOP（market-watch / trend-trading-agents）

> 唯一入口：`python3 reports/remote/remote.py <子命令>`
> 服务器：`quant-server`（Windows，`C:\workspace\`）。主仓 `trend-trading-agents`，站点仓 `market-watch`。
> 全链路调度脚本（权威、已验证）：`C:\workspace\market-watch\reports\remote\run_market_watch.cmd`
> 全链路日志（唯一真相源）：`C:\workspace\market-watch.log`

---

## ⚠️ 会话启动必读（防失忆自检清单）

**每次新开会话 / 对话压缩后，动手做任何远程操作前，先按顺序确认：**

1. [ ] 读过本文件（`reports/remote/SOP_REMOTE.md`）
2. [ ] 读过 `.codebuddy/memory/MEMORY.md`（坑位表 + 重跑 SOP 摘要）
3. [ ] 确认 `remote.py` 文件头 docstring 的"失忆保护"段仍是最新版
4. [ ] 记住铁律：**补跑/重跑只用 `run <日期>`**，绝不另写后台拉 snapshot.py 的临时脚本

**如果上下文已丢失（不知道上次跑到哪）：**
```
python3 reports/remote/remote.py status --date <可疑日期>   # 看 market-watch.log 实际进度
```
**别猜、别写新脚本、别手动 ssh 试。** status 已经能回答"在跑没、卡没卡、产物齐没齐"。

---

**为什么要有这份清单**：2026-08-25 曾因未读记忆直接上手，自己造了 `Win32_Process.Create` 拉 snapshot.py 半截 + 各种错误日志文件名，导致后台进程全卡死、空转一小时。根因 = 没先固化 SOP 就临时发挥。此后任何远程操作一律照本文件，禁止即兴。

---

## 0. 铁律（今天踩的坑，永不再犯）

1. **不要另造重跑脚本**。补跑 / 重跑 = 直接 `remote.py run <日期>`。它后台拉起 `run_market_watch.cmd`，走的是和每晚定时任务**完全相同**的、已验证的生产路径。任何自己写 `Win32_Process.Create` 拉 `snapshot.py` 半截的做法，都绕开了生产路径、且日志落盘不可靠。
2. **日志只在 `market-watch.log`**。snapshot/diff/candidates/build 全部 `>> market-watch.log 2>&1`。不要去查 `scan_live_*.log` / `scan*.log` 这些不存在/过时的文件名（早期 `rerun-scan` 残留命名，已废弃）。
3. **先看日志，别猜 CPU/进程**。排错第一动作永远是 `status`（它 dump `market-watch.log` 尾部），不是 `Get-CimInstance` 看进程 CPU。
4. **token 由用户保证最新**：`set-token` 纯写 `.env`，不 probe。要验证就单独 `probe`（只读）。
5. **路径无空格就不套引号**（`Win32_Process.Create` 的 CommandLine）；cmd 重定向 `>>` 前必须有空格。

---

## 1. 日常补跑单日（最常见场景）

适用：某天数据缺失（如定时任务因 400016/WAF 失败），需补齐。

```bash
# 1) 若 token 过期，用户给新 token 后：
python3 reports/remote/remote.py set-token <新token>      # 纯写 .env，不 probe

# 2) 补跑（后台拉起 run_market_watch.cmd，自动跑全链路+双仓 push）
python3 reports/remote/remote.py run 2026-08-24

# 3) 反复查进度/结果（看 market-watch.log 尾部）
python3 reports/remote/remote.py status --date 2026-08-24

# 4) 确认产物齐全：raw/diff/candidates/daily 全 OK 即完成
```

`run` 的 skip 逻辑：若 `raw/<日期>.json` 已存在，自动跳过不重扫。所以"补跑缺失日"和"重跑某日"都用同一条命令，安全。

---

## 2. 验证 token / 环境

```bash
python3 reports/remote/remote.py probe        # 只读，确认 .env 的 XUEQIU_TOKEN 返回 200
python3 reports/remote/remote.py status        # 看服务器双仓 git 状态 + 最近日志
```

- `probe` 返回 `STATUS: 200` → token 有效。
- 返回 `400016` → token 过期，走 §1 第 1 步换 token。
- 返回 WAF 拦截页（含 `captcha` / `acw_sc__v2`）→ 阿里云风控，需浏览器访问 xueqiu.com 过验证码解封服务器 IP，无法代码解决。

---

## 3. 卡死 / 僵尸进程清理

若 `status` 显示进程残留但日志不再增长（疑似卡死）：

```bash
python3 reports/remote/remote.py kill-scan     # 只杀命令行含 snapshot.py 的进程，不动其它 python 服务
```

清理后重新 `run <日期>`。

---

## 4. raw 已存在但后续步骤没跑（半截失败）

若 `raw/<日期>.json` 已有，但 `diff/candidates/daily` 缺失（snapshot 成功、后续崩）：

```bash
python3 reports/remote/remote.py build 2026-08-24   # 跳过 scan，直接 diff+candidates+build:report+双仓 push
```

（注：`build` 子命令走自己的 `build___MMDD__.log`，非 market-watch.log，但其产物契约与 run 一致。）

---

## 5. 排错决策树

```
status 显示 scan FAILED / 400016
  ├─ probe 返回 400016 → set-token 换 token → run 重跑
  ├─ probe 返回 WAF 拦截页 → 浏览器过验证码解封 IP → probe 复 200 → run 重跑
  └─ probe 返回 200 但仍失败 → 看 market-watch.log 具体报错
        ├─ snapshot.py 语法错误 → 本地修 snapshot.py（只许 ASCII 注释）→ push → run 重跑
        ├─ npm run verify 自检失败 → 本地 npm test + npm run verify 修坏代码 → push → run 重跑
        └─ 进程卡死无进展 → kill-scan → run 重跑
```

---

## 6. 子命令速查

| 命令 | 作用 | 日志去哪看 |
|---|---|---|
| `probe` | 只读测 token 是否 200 | 本地终端直出 |
| `set-token <t>` | 纯写 `.env` 的 XUEQIU_TOKEN | 本地终端直出 |
| `run <日期> [sleep]` | 后台拉 `run_market_watch.cmd` 跑全链路+双仓 push | `market-watch.log` |
| `build <日期>` | 跳过 scan，只跑后续步骤 | `build___MMDD__.log` |
| `kill-scan` | 精准杀 snapshot 僵尸进程 | 本地终端直出 |
| `status [--date D]` | dump market-watch.log 尾部 + 双仓 git 状态 + 产物清单 | 本地终端直出 |

---

## 7. 改完代码后必做（质量保障，勿省）

改 `run_market_watch.cmd` 调度逻辑后，**必须先本地验证再上生产**（历史教训：连续两次线上 FAILED）：

```bash
npm test                              # pipeline-check 单测+集成测试
npm run verify                        # cmd 调度逻辑孪生冒烟（假 raw 跑真实 diff/candidates）
```

`run_market_watch.cmd` 自身也有 `--verify` 模式（假 raw 占位走产物契约检查），可在服务器直接 `cmd /c run_market_watch.cmd --verify` 验证。
