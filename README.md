# dsh-prompt-library

提示词库插件：**设置里管理，输入框里使用**。

- **管理**：设置 → 提示词库。可视化增删改查，保存即时生效。
- **使用**：聊天输入框输入 `/`，从菜单选择提示词回车发送；或直接输入 `/<名称>`。命令后追加的文字会拼到提示词末尾，如 `/code-review 重点看并发安全`。

A prompt library for DeepSeek Harness: manage prompts in the settings page,
use them from the composer's `/` menu as real user messages.

---

## 使用

### 发送提示词

1. 在聊天输入框输入 `/`，弹出命令菜单，选择你的提示词（或直接输入 `/<名称>`）。
2. 回车发送。提示词内容会作为一条**真实的用户消息**提交给 agent —— 和你手打这句话效果完全一样。
3. 命令后面可以追加文字，会自动拼到提示词末尾：`/code-review 重点看并发安全`。

执行反馈在聊天流里以命令节点展示，不会产生额外的模型消息。

### 在设置里管理

打开 **设置 → 提示词库**：

- **新建提示词**：名称（即命令名）、标题（菜单显示名）、内容（发送给 agent 的文本）、描述（菜单说明）。
- **编辑 / 删除**：列表行内操作，删除需二次确认。
- 所有修改**立即生效**：宿主端写完文件就重挂斜杠命令，不需要重启或刷新。

名称规则：小写字母开头，只能含小写字母、数字、`-`、`_`（输入时自动规范化，如 `Code Review` → `code-review`）。

### 直接编辑文件

提示词库是 `<DSH_HOME>/prompt-library.json`（默认 `~/.dsh/prompt-library.json`）。插件监视这个文件，外部编辑保存后约半秒自动生效：

```jsonc
{
  "version": 1,
  "prompts": [
    {
      "name": "code-review",       // 斜杠命令名（必填，小写）
      "title": "代码审查",          // 菜单里的显示标题
      "content": "请审查以下代码…", // 发送给 agent 的内容（必填）
      "description": "按维度审查代码改动" // 菜单描述（可选）
    }
  ]
}
```

损坏的文件按空库处理，不会让宿主崩溃。

---

## 安装

插件目录在 `~/.dsh/plugins/dsh-prompt-library/`，已作为 bundle 接入 desktop profile：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里有
   `"dsh-prompt-library": "link:/Users/gavintong/.dsh/plugins/dsh-prompt-library"`；
2. `dsh.profile.bundles` 里列有 `"dsh-prompt-library"`；
3. profile 目录里 `pnpm install` 已执行（`node_modules/dsh-prompt-library` 软链存在）；
4. 插件管理器里已启用（用户 patch 层 / `set_bundle`）。

在其他 profile 安装时重复这四步即可（把 `desktop` 换成目标 profile 名）。宿主端文件变更后需要**重启宿主**（Node ESM 缓存），客户端设置页则随窗口刷新加载。

---

## 实现

```
lib/library.js    纯逻辑：文件读写（原子写）、名称规范化、校验、消息构造
lib/index.js      宿主插件：每条提示词一个斜杠命令 + 设置 API 前缀路由 + 文件 watch
lib/client.js     浏览器插件：设置 → 提示词库 页面（CRUD 编辑器）
test/             node:test 单元测试（17 条）
```

关键设计：

- **一个存储所有者**：库文件是唯一权威；宿主端 HTTP API 与外部编辑器都写同一个文件，
  谁写完谁触发命令重挂，两个入口永不冲突。
- **发送即真实消息**：提示词命令的 handler 调用 `agent.followup(用户消息)`，把内容作为 user-role
  消息进入会话 —— 与官方 `/goal` 命令提交附件的方式同源，模型看到的就是一条普通用户输入。
- **命令热更新**：`ctx.commands.register()` 返回精确的注销函数；文件变化时先全部注销再按新内容重挂，
  命名冲突、数量上限（500 条）、内容上限（32k 字符）都在写入前校验。
- **原子持久化**：写临时文件后 `rename` 覆盖，崩溃不会留下半写的库文件。
- **双面插件**：宿主半（`lib/index.js`）持有文件与命令；浏览器半（`lib/client.js`）通过
  `dsh.client` 声明加载，只经 `/dsh-prompt-library/api/*` 前缀路由通信，无业务逻辑。

### 配置

```yaml
- id: dsh-prompt-library
  name: 'dsh-prompt-library'
  config:
    libraryPath: /custom/path.json   # 默认 <DSH_HOME>/prompt-library.json
```

### API

设置页使用的路由（都在 `/dsh-prompt-library/api` 下）：

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/ping` | 存活探测，含插件 revision |
| `GET` | `/prompts` | 列出全部提示词（名称排序）与库文件路径 |
| `POST` | `/prompts` | 新建：`{ name, content, title?, description? }` |
| `POST` | `/prompts/update` | 更新/改名：同上 + `previousName` |
| `POST` | `/prompts/delete` | 删除：`{ name }` |

## 已知限制

- 命令名与 DSH 内置命令或其他插件命令重名时无法注册（宿主日志报 `already registered`），换个名称即可。
- 提示词本身是纯文本；如需占位符替换，在发送时用「附加说明」手动补充上下文。
