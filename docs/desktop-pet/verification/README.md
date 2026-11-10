# Windows 验证记录 · 2026-11-02

环境：Windows 系统版本 10.0.26100，Electron 45.2.1，x64。代码基于 Claude bdf8f30 加本分支桌宠实现。

| 验证 | 结果 | 证据 |
|---|---|---|
| Node 逻辑/素材/保存测试 | 49/49 通过 | `npm test`，源码在 desktop/test |
| 原有测试角色包集成 | 19/19 通过 | fixture-report.json |
| 缺失素材容错 | 5/5 通过 | missing-pack-report.json |
| 正式 Windows 打包程序 | 12/12 通过，无页面脚本错误 | windows-report.json |
| 便携启动器 | 4/4 通过 | portable-report.json |

正式程序测试用 `TPLAN_TEST_EXE=dist/win-unpacked/T计划桌宠.exe` 执行 `node test/windows-smoke.cjs`，覆盖实际打包后的 asar 和 preload。便携启动器使用 `node test/portable-smoke.cjs`，等待自解压完成后连接本机 Chromium 调试端口。NSIS 启动器不转发 Electron inspector 输出，因此不使用 `_electron.launch` 直接接管启动器。测试结束关闭测试进程；每次使用独立测试数据目录。

截图均来自真实应用，不是效果图：02 为任务卡片，04 为回看，05 为正式九状态画廊，06 为便携 EXE 启动后的气泡。截图透明区域在部分查看器显示黑色，PNG 含透明通道。

便携 EXE SHA256：`6064C825D703805B0D6E4B524A60DDF35A31DB95B06649E0FB12BF50FBA8F8E8`。

尚未做物理操作验证：穿透到其他应用、原生拖拽手感、不同 DPI 多屏与拔屏、真实系统睡眠/锁屏、Windows 通知交付、开机启动。自动化验证了窗口 focusable=false 属性，未测与其他应用之间的实际键盘焦点流转。

完整 v4.0 平台还未迁移，以上跨窗口验证对象是 Claude 的共享后台和临时控制台。动画仅状态切换、眨眼和轻微呼吸，不能代表 Live2D 或逐帧动画已完成。
