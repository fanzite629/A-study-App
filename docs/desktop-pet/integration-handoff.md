# Claude / Codex 联调交接

用户分工：Codex 负责完整桌宠程序和美术，Claude 负责 T计划平台，之后由 Codex 合并。此交接基于 Claude 的 `bdf8f30`，保留同一个后台。

## 接入点

- `desktop/src/main/core.js` 为唯一状态、计时和落盘源。平台不能另开计时器或把 localStorage 当第二份权威数据。
- 桌宠 `petApi.dispatch(type,payload)` 与主窗口 `tplan.dispatch(type,payload)` 都进入 `core:dispatch`。
- 主窗口 `tplan.get()` / `onUpdate` 是控制台投影：view、未完成任务（最近 80）、最近 30 条记录、settings、prefs、资源包和诊断。**不足以承载完整平台。** 请扩展完整查询接口，不用被截断的数组覆盖状态。
- notes、trees、archive、任务编辑/删除需增加明确 Core 命令和测试；保留导入的未知业务字段。
- 可调用 `open-main`、`show-pet`、`hide-pet`、`show-review` 等窗口动作。
- 默认角色包在 `desktop/assets/characters/warm-scholar/manifest.json`，不要用占位 SVG 或 CSS 重绘覆盖。

## 本次契约变化

| 项目 | 内容 |
|---|---|
| task.add | 支持 at: HH:mm、date: null 以后清单 |
| task.schedule | {taskId,date,at?}；日期为 YYYY-MM-DD 或 null；仅用户操作改期 |
| settings.update | {eveningReview?:boolean,reviewTime?:HH:mm} |
| session.outcome | continue 重新打开任务；next 保存下一步；done 完成任务 |
| 记录 | durationMs 精确毫秒、minutes 两位小数，短时记录也保留 |
| petView.reviewTasks | 今天相关任务的条数、分钟、完成状态、下一步 |
| gentleReminder | 计划/晚间回看事件，遵循静音和次数预算 |
| prefs.reducedMotion | 关闭角色眨眼与呼吸 |
| blink | 可选 PNG，idle 的 150ms 眨眼辅助状态，不是业务状态 |
| 恢复 | 10 秒心跳；重启暂停并排除停机时长；锁屏立即暂停 |

平台显示时可以四舍五入分钟，不可覆盖精确 durationMs。原设计“锁屏 10 分钟再询问”现改为即时暂停，以免误计入学习。

## 合并验收

1. 平台开始计时，桌宠显示同一 ID；桌宠暂停、加时、结束即时同步到平台。
2. 关闭平台或隐藏桌宠继续计时，退出应用才暂停写盘。
3. 时间到、重复点击、两窗口同时结束只有一条记录。
4. 全部任务/笔记/计划树迁移无丢失，包含版本迁移和回滚备份。
5. 实机复核鼠标穿透、DPI、多屏、睡眠、锁屏、托盘、自启动。

本次 EXE 是独立可用的桌宠及临时共享控制台，尚不是完整 v4.0 平台发行版。完整平台仍需合并与联调。
