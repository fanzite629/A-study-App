# T计划桌宠 · Windows 0.1.0

可独立运行的 Windows 桌宠，基于 Claude 的 `bdf8f30` 共享后台与窗口框架，接入 Codex 制作的暖阳学者角色、复盘与提醒、数据恢复和 Windows 打包。

## 直接运行

双击 `TPlan-Pet-0.1.0-Windows.exe`。Windows x64 便携版，无需安装 Node.js，默认只显示透明桌宠和托盘。

- 单击角色：选任务、加任务、先做 5 / 10 分钟、按计划计时、正计时、缩小下一步。
- 按住人物拖动；右键打开设置、复盘和主窗口。空白区域按图片透明度穿透。
- 结束或时间到即保存；结果、备注、下次从哪继续均可稍后补充。
- 今天回看：查看计时事实、完成状态、下一步，明确选择今天、明天或以后清单。
- 托盘支持显示 / 隐藏 / 找回 / 恢复交互 / 安静模式 / 减少动作 / 开机启动。
- 隐藏桌宠或关闭主窗口不结束计时；托盘「退出 T计划」才退出整个程序。

数据位于 `%APPDATA%\TPlan`，不会随 EXE 移动。移动 EXE 后须重新设置开机启动。此构建没有数字签名或自动更新。

## 角色和学习功能

九张正式透明 PNG，1024×1536：idle、focus、thinking、reminder、timeUp、done、rest、dragging、blink。保留用户选定的第一版自然姿态。默认人物高 320 DIP，可调整为 200 / 260 / 400。待机眨眼、轻微呼吸，可关闭动作。资源包可单独替换，加载失败保留上一包。

窗口支持拖拽、位置记忆、置顶、位置锁定、全穿透、失屏找回和状态气泡。学习功能包括唯一计时、暂停 / 继续 / 加时 / 转正计时、休息、自动记录和可选复盘。短于一分钟也保留，记录包含精确 `durationMs` 和两位小数的 `minutes`；记录 ID 等于轮次 ID。

任务设置时间后可收到计划提醒；晚间回看在主窗口「桌宠窗口」自行开启。两者合计每天最多 4 次，间隔至少 30 分钟，专注、休息和安静模式下不主动提醒。未计时不等于未学习，任务不会自动改期。

## 保存规则

- 主进程 `Core` 是状态与计时的唯一写入者，所有窗口只派发命令和显示快照。
- 倒计时到零立即保存，15 分钟未回应结束同一轮，等待时间不计入学习。
- 睡眠、锁屏、退出暂停。重启排除关闭期间的时间，由用户选择继续。
- 正常运行每 10 秒写心跳；意外退出恢复到最近成功写盘的心跳。
- 原子写入并保留上一份有效 JSON；主文件损坏读备份，两份都损坏则报错，不清空数据。
- 导入替换任务和历史前先确认，并保留独立 `before-import-*.json`；当前计时保留。主窗口支持导出 JSON。

## 开发与验证

```powershell
cd desktop
npm ci
npm start
npm run start:pet
npm test
npm run test:windows
npm run selftest
npm run selftest:nopack
npm run dist
```

`npm start` 同时打开临时控制台；发行 EXE 默认只开桌宠，可加 `--main`。打包输出在 `desktop/dist`，不提交 Git。

`src/main/core.js` 管数据；`src/main/main.js` 管窗口和 IPC；`src/preload` 提供受限桥接；`src/renderer/pet` 管角色和气泡；`assets/characters/warm-scholar` 是正式素材；`src/renderer/console` 是临时控制台。

Windows 自动化启动真实 Electron，验证素材、气泡操作、跨窗口计时、关主窗口继续、记录去重、复盘、缩放、退出写盘和重启。测试用独立目录，不访问真实学习数据。报告和截图见 `docs/desktop-pet/verification/`。

仍须人工实机验收：穿透到另一应用、原生拖拽手感、多屏 DPI 与插拔、真实休眠、通知交付和开机启动。逻辑单测不能代替这些检查。

## 与平台的分工

完整 T计划 v4.0 HTML 尚未接入，主窗口仍是共享后台的临时控制台。Claude 负责平台迁移，见 `docs/desktop-pet/integration-handoff.md`。

本版动作是状态立绘切换、眨眼和轻微呼吸，尚无 Live2D、逐帧走路、坐下、联网 AI 对话、全屏自动静音。`sequence` / `layered` 仍为预留类型。
