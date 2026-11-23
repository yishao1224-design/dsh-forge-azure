# dsh-forge-azure

DeepSeek Harness 的独立插件：给 forge 注册表加一个**只读**的 Azure DevOps（Azure Repos）提供方。启用后，「代码评审」页面和会话面板能显示 Azure 的 pull request：列表、状态与检查、diff、评审讨论。

> **未经真实环境验证。** 所有 API 行为只对照微软 REST 文档写的模拟服务测试过（`tests/fake.ts`），没有连过真实的 Azure DevOps 组织。见[已知限制](#已知限制)。

## 能做什么

| 功能 | 说明 |
|---|---|
| 「代码评审」页的三个列表 | 待我评审（我是评审者且还没投票）、我创建的、与我有关（我是评审者且已投票），只列 `organizations` 里的组织 |
| PR 状态 | 标题、草稿、分支、冲突状态、评审者及投票、未解决讨论数 |
| 检查 | PR statuses（每个 context 取最新一条）和分支策略评估（构建验证、必需评审者等） |
| diff | 从目标分支与 head 的合并基准到 head，和 Azure 的 PR 页面一致 |
| 评审讨论 | 文件上的讨论线程，区分当前位置和已过期的线程 |
| 描述与标签 | Markdown 描述、标签 |
| 会话自动关联 | 会话所在分支推送后，自动发现该分支上打开的 PR |

**不能做**（只读）：评论、回复、解决讨论、投票、合并、标记为可评审、重跑检查、请求评审。界面上不会出现这些操作；合并和标记为可评审会直接返回失败。

## 安装

1. 在插件页启用官方的「变更请求与工作树」套件，本插件依赖它提供的 `ctx.forge`。
2. 构建并安装本插件：

   ```powershell
   npm install
   npm run build
   dsh plugin add <本目录的绝对路径>
   ```

   也可以在插件页「安装第三方插件」里填本目录的绝对路径。
3. 重启 `dsh`。

## 令牌

和 [dsh-okf](https://github.com/yishao1224-design/dsh-okf-plugin) 用同一个：**启动 `dsh` 之前**设置环境变量 `DSH_OKF_AZURE_TOKEN`，值是 Azure DevOps 的个人访问令牌（PAT），只需要 *Code: Read* 权限。没有时回退到 `DSH_OKF_GIT_TOKEN`。

- 令牌以 HTTP Basic 头发送，只发往 `https://dev.azure.com/`，不会出现在 URL、日志或错误信息里，也不落盘。
- 每次请求时读取环境变量。
- 没有令牌时不发任何请求，「代码评审」页会提示登录 dev.azure.com。
- dsh-okf 的令牌是 *Code: Read & Write*，对本插件够用；本插件只发 GET 请求。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（会替换整个 config 块）：

```yaml
- id: forge-azure
  name: '@local/dsh-forge-azure'
  config:
    organizations: ['contoso']     # 「代码评审」页要列出 PR 的组织；不填则列表为空
```

| 设置 | 默认值 | 含义 |
|---|---|---|
| `organizations` | `[]` | 列出 PR 的 Azure DevOps 组织名 |
| `tokenEnv` | `['DSH_OKF_AZURE_TOKEN', 'DSH_OKF_GIT_TOKEN']` | 存放 PAT 的环境变量，按顺序取第一个有值的 |
| `timeoutMs` | `30000` | 单次请求超时 |
| `maxResponseBytes` | `16777216` | 单个响应体上限 |
| `maxConcurrentRequests` | `6` | 一次状态读取或一次 diff 的并发请求数 |
| `maxDiffFiles` | `300` | 一个 diff 最多的文件数，超过则提示太大 |
| `maxDiffBytes` | `4194304` | 一个 diff 读取的文件文本和补丁的字节上限 |
| `maxReviewThreads` | `500` | 一次读取返回的讨论线程上限 |
| `maxViewerItems` | `100` | 每个组织每个列表最多读取的 PR 数 |

不配置 `organizations` 时，会话面板里按仓库远端和 PR 链接识别的功能仍然可用，只是「代码评审」页不列 Azure 的 PR。

## 识别的地址

- 远端：`https://dev.azure.com/org/project/_git/repo`、`https://org.visualstudio.com/project/_git/repo`、`git@ssh.dev.azure.com:v3/org/project/repo`
- PR：`https://dev.azure.com/org/project/_git/repo/pullrequest/123`

仓库在 DSH 里表示为 owner `org/project`、name `repo`。

## 已知限制

- **没有连过真实组织。** 字段名和端点来自微软 REST 文档（Git Pull Requests、Pull Request Threads、Diffs、Items、Policy Evaluations 7.1），真实响应如有出入需要调整。讨论线程在多次推送后的位置映射（`trackingCriteria`）把握最小。
- **只支持 dev.azure.com。** 不支持本地部署的 Azure DevOps Server。
- **变更行数始终为 0。** Azure 不返回增删行数，算出来需要读完整 diff。
- **列表按创建时间排序。** Azure 的 PR 没有更新时间；列表里也没有检查状态，一律显示为无。
- **团队评审请求不入列表。** 搜索只匹配你本人，不匹配你所在的团队。
- **diff 较慢。** Azure 没有补丁接口，每个改动文件要读两个版本，再在本地算出补丁。
- **针对整个 PR 的讨论不显示。** 只显示挂在文件上的线程；它们仍计入未解决讨论数。
- **头像不显示。** Azure 的头像地址需要登录会话。
- **关联工作项不显示。**

## 开发

```powershell
npm run typecheck
npm test
npm run build
```

`lib/index.js` 是单文件产物，除 Node 内置模块外不 import 任何东西（`diff` 包被打进去，DSH 包只用类型）。

```
src/
├── index.ts      # 插件入口、配置、令牌读取
├── provider.ts   # ForgeProvider 实现
├── api.ts        # 带令牌的只读 REST 客户端
├── urls.ts       # 远端 / PR 地址解析与 REST 路径
├── status.ts     # PR → 快照（评审结论、检查）
├── diff.ts       # 改动文件列表 + 两侧内容 → 统一补丁
├── review.ts     # 讨论线程映射
└── viewer.ts     # 「与我相关」的三个列表
tests/
├── fake.ts       # 模拟的 Azure DevOps REST API
├── urls.spec.ts
└── provider.spec.ts
```
