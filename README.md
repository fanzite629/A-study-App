# A-study-App · 学习桌宠

已完成的 Windows 学习桌宠「暖阳学者」，支持任务选择、专注计时、自动记录、下一步书签与今天回看。基于 Electron，桌宠和主窗口共用一个计时与数据核心。

<img src="desktop/assets/characters/warm-scholar/states/idle.png" alt="暖阳学者默认立绘" width="220">

## 下载与运行

在 [v0.1.0 下载页面](https://github.com/fanzite629/A-study-App/releases/tag/v0.1.0) 下载 `TPlan-Pet-0.1.0-Windows.exe`，双击即可运行。Windows x64 便携版，无需安装 Node.js。默认显示透明桌宠和托盘图标。

同一页面提供完整角色包 ZIP、中文使用说明和 SHA-256 校验清单。数据保存在 `%APPDATA%\TPlan`，移动 EXE 不会移动学习记录。该版本尚无数字签名与自动更新。

## 已有功能

| 功能 | 当前行为 |
|---|---|
| 任务与起步 | 选主任务、添加任务、先做 5/10 分钟、按计划计时、正计时、缩小下一步 |
| 专注计时 | 全局唯一计时，暂停、继续、加时、结束；隐藏桌宠或关闭主窗口后继续 |
| 自动记录 | 结束或倒计时到零即保存，重复操作不重复记账；保留精确时长 |
| 回看与接续 | 补充完成状态、备注及下次从哪里继续；由用户选择是否改期 |
| 温和提醒 | 计划提醒、可选晚间回看；每天合计最多 4 次，间隔至少 30 分钟 |
| 桌面交互 | 拖拽、透明区域穿透、置顶、位置锁定、全穿透、失屏找回、大小调整 |
| 托盘与设置 | 显示/隐藏、恢复交互、安静模式、减少动作、开机启动 |
| 数据恢复 | 原子保存与有效备份，10 秒心跳，锁屏/休眠/退出暂停，重启排除停机时间 |
| 角色包 | 独立 manifest 与透明 PNG，可替换、重新加载；缺少可选素材回退 idle |

没有计时记录不代表没有学习；任务不会自动改期，复盘备注可以稍后补充。

## 角色与图案

正式素材为 9 张 **1024×1536 透明 PNG**，默认人物显示高度 320 DIP。图片、manifest 和美术来源记录均随源码保存。

| 状态 | 图案 |
|---|---|
| 待机 | [idle.png](desktop/assets/characters/warm-scholar/states/idle.png) |
| 专注陪读 | [focus.png](desktop/assets/characters/warm-scholar/states/focus.png) |
| 思考 | [thinking.png](desktop/assets/characters/warm-scholar/states/thinking.png) |
| 温柔提醒 | [reminder.png](desktop/assets/characters/warm-scholar/states/reminder.png) |
| 时间到了 | [timeUp.png](desktop/assets/characters/warm-scholar/states/timeUp.png) |
| 完成一步 | [done.png](desktop/assets/characters/warm-scholar/states/done.png) |
| 休息 | [rest.png](desktop/assets/characters/warm-scholar/states/rest.png) |
| 拖拽 | [dragging.png](desktop/assets/characters/warm-scholar/states/dragging.png) |
| 眨眼 | [blink.png](desktop/assets/characters/warm-scholar/states/blink.png) |

[九状态实际应用图鉴](docs/desktop-pet/verification/05-gallery.png) · [角色设定参考](docs/desktop-pet/artwork/character-sheet.png) · [资源包接口](docs/desktop-pet/character-pack-spec.md)

## 从源码运行

建议使用 Node.js 22.12+ 和 Windows x64。依赖版本固定在 `desktop/package-lock.json`。

```powershell
git clone https://github.com/fanzite629/A-study-App.git
cd A-study-App/desktop
npm ci
npm start
```

```powershell
npm run start:pet   # 只显示桌宠
npm test           # 核心逻辑、保存、几何、命中与素材测试
npm run test:windows # 启动真实 Electron 的集成检查
npm run dist       # 生成 Windows 便携版，输出到 desktop/dist
```

开发启动同时显示临时控制台；便携程序默认只启动桌宠，可加 `--main` 打开主窗口。完整操作与开发说明见 [desktop/README.md](desktop/README.md)。

## 目录与实现入口

```text
desktop/
  src/main/       共享数据核心、计时、保存、窗口、托盘、角色包加载
  src/preload/    桌宠和主窗口的受限 IPC 桥接
  src/renderer/   桌宠交互、角色显示及临时主窗口
  src/shared/     状态映射、透明度命中、布局与资源包校验
  assets/         正式九状态角色和托盘图标
  test/           单元与 Windows 集成测试
  dev-fixtures/   隔离测试角色包
docs/desktop-pet/
  verification/   已有验证报告和实际应用截图
  artwork/        正式角色设定参考
  pack-template/  可复用角色包模板
  import-record.md 本次导入范围和验证记录
```

## 当前范围

这是已完成的桌宠及临时共享控制台，完整 T计划 v4.0 平台尚未接入。当前动作包含状态立绘切换、眨眼和轻微呼吸；Live2D、逐帧走路和联网 AI 对话尚未实现。平台接入契约见 [integration-handoff.md](docs/desktop-pet/integration-handoff.md)。

历史设计文档保留作为参考；实现行为以源码、[当前使用说明](desktop/README.md)和[验证记录](docs/desktop-pet/verification/README.md)为准。物理鼠标穿透、多屏 DPI、真实休眠、系统通知和开机启动仍需实机人工验收。
