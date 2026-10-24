# 会话资源管理器 · 资源介绍

> 像 Windows 资源管理器那样管理 DSH 的会话，让会话管理像文件管理那样简单。
> 不改变会话文件的物理位置，只在 `~/.dsh-session-navigator/` 记一份索引——记录文件夹、名称、标签、备注。

| 项目 | 内容 |
| --- | --- |
| 包名 | `dsh-session-navigator`（npm） |
| 版本 | 1.0.4 |
| 仓库 | https://github.com/Anlerway/dsh-session-navigator |
| 发行包 | [Releases 最新版](https://github.com/Anlerway/dsh-session-navigator/releases/latest) |
| 许可 | MIT |
| 运行要求 | Node `^22.15.0 \|\| >=24.0.0`；DSH 版本不限 |

## 能做什么

- 目录树按工作区自动生成，自己可以新建文件夹无限嵌套，会话工作区支持拖进拖出
- 标题、标签、备注随心所欲的自定义
- 搜索支持标题、备注、标签搜索
- 收藏、待办、置顶、归档；配备回收站，删除后有后悔药
- 跨工作区剪切粘贴；会话内容可自由导出 Markdown 或 JSONL，供其他会话使用

## 界面

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/split.png" width="900" alt="分屏">
</p>
<p align="center"><em>分屏：左边照常聊天，右边的目录树和会话列表一直在</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/window.png" width="900" alt="独立窗口全屏">
</p>
<p align="center"><em>独立弹窗：目录树、列表、详细信息三栏全展开</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/filter.png" width="600" alt="筛选">
</p>
<p align="center"><em>筛选：范围、收藏、归档、待办，标签可多选</em></p>

## 安装

**1）DSH 插件页**：插件页 → 「添加插件」→ 输入包名 `dsh-session-navigator` → 安装 → 重启 DSH。

**2）命令行**

```powershell
dsh plugin --profile web add dsh-session-navigator      # Web 版
dsh plugin --profile desktop add dsh-session-navigator  # 桌面版
```

**3）本地装**：从 [Releases 最新版](https://github.com/Anlerway/dsh-session-navigator/releases/latest) 下载 `.tgz`，再 `dsh plugin --profile web add '<绝对路径>'`。

## 数据

- 全部状态在 `~/.dsh-session-navigator/`——`~/.dsh` 的兄弟目录，不是子目录，卸载插件就是删一个目录。
- 不联网，没有遥测。
- 零运行时依赖，没有构建步骤，`lib/` 直接跟着仓库走。

## English summary

Session Navigator manages DSH sessions the way Windows Explorer manages files: a folder tree
per workspace, tags, notes, favourites and a recycle bin on top of the native session store.
Session files never move — all state lives in `~/.dsh-session-navigator/`, a sibling of `~/.dsh`,
so uninstalling means deleting one folder. Zero runtime dependencies, no build step, MIT.

```bash
dsh plugin --profile web add dsh-session-navigator
```
