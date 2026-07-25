# GitHub 仓库池 Workplan

状态：已完成。实现、测试和最终 review 已对照本文执行。

## 目标

在现有 Git 云保险库上增加可选的“仓库池”。用户可在面板保存多个 GitHub 仓库，新的聊天范围会按已占用的逻辑体积分配到较空的仓库；面板仍把所有仓库的备份当成一个云保险库浏览、预览、导入、恢复和删除。

一次聊天范围只归属一个仓库。该范围的快照、分块和关联资源都保存在同一个仓库，因此恢复不需要跨仓库拼装，也不会把一个大型 JSONL 再拆散。0.3.4 的 8 MiB gzip 分块继续处理单条聊天超过 GitHub blob 限制的问题。

## 已确认基线

- 当前版本为 `0.3.4`，`main` 与 `origin/main` 都在 `ab5072c`。
- `cloud-config.json` 只有一组 `repoUrl`、`branch`、`githubToken` 和同步选择项。服务端所有 cloud 动作都从这一个配置解析仓库。
- 本地云工作区已经以 `sha1(repoUrl|branch)` 区隔在 `cloud/remotes/<repoKey>/repo/`。这能直接承载多个仓库，不需要迁移 live SillyTavern data。
- 云端每个仓库都已经是自包含保险库：`vault.json`、`manifest.json`、快照对象、分块、资源对象和设备状态都在该仓库内。
- 同步已经按单个本地快照流式处理；单条本地快照读失败会跳过，并继续上传其他聊天。
- 现有 `tests/cloud-snapshot.test.mjs` 已用本地 bare Git remote 模拟了 105 MiB JSONL，并确认云端物理 blob 小于 45 MiB。

## 范围

本期包含：

- 可选仓库池。只有一个仓库时行为、接口语义和用户操作与当前版本一致。
- 旧单仓 `cloud-config.json` 自动升级为只有一个成员的仓库池，不移动远端对象，不要求重新输入 token。
- 每个聊天范围固定一个 `homeRepositoryId`。新范围按当前各成员的逻辑快照体积选择最轻成员；已有范围不自动移动。
- 无 token 的仓库池目录文件，复制到每个健康成员仓库。它让另一台设备从已连接成员发现池成员 URL 和范围归属，但绝不复制 access token。
- 多仓库目录聚合。每条聚合备份都携带 `repositoryId`，所有读取、导入、恢复和删除都精确回到原仓库。
- 单成员失败隔离。失败成员只影响归属它的范围；其他成员继续同步，前端显示部分成功和具体成员状态。
- 紧凑的仓库池管理视图。首个仓库保留目前的配置流程；新增成员只需 URL，默认复用已保存的池 token，分支默认 `main`。需要不同权限时才输入成员 token 覆盖值。

## 排除项

- 不使用外置对象存储、Git LFS、GitHub Releases 或额外账号服务。
- 不把一个范围的同一份恢复包跨仓库分片。
- 不把 live `data/` 目录变成 Git 工作树。
- 不自动把已有范围迁移、复制或删除。新增仓库只接收之后首次同步的新范围。
- 不在第一期提供“移除成员”或“一键重均衡”。两者都可能让已有归属无凭据或要求复制后再显式删除，另开需求处理。
- 不把 token 写进 Git URL、`.git/config`、`vault-pool.json`、manifest 或前端响应。

## 数据与兼容设计

### 本地配置

`cloud-config.json` 升级到本地池配置。旧字段迁移为一个成员，原 `githubToken` 变为 `defaultGithubToken`。每个成员可有空的 `githubTokenOverride`；鉴权时优先成员覆盖值，回退池默认 token。

```json
{
  "version": 2,
  "poolId": "pool-...",
  "catalogRepositoryId": "repo-...",
  "defaultGithubToken": "server-side only",
  "deviceId": "device-...",
  "deviceName": "Mac mini",
  "syncPinned": true,
  "syncLatestStable": true,
  "syncDrafts": false,
  "repositories": [
    {
      "repositoryId": "repo-...",
      "repoUrl": "https://github.com/owner/vault-a.git",
      "branch": "main",
      "githubTokenOverride": "",
      "addedAt": 0,
      "lastPulledAt": 0,
      "lastPushedAt": 0
    }
  ]
}
```

服务端会把本地配置与远端对象格式的版本号分开处理。旧 `vault.json`、manifest、snapshot meta 和未分块 JSONL 都继续可读；新增尺寸字段只是可选增强，不使旧备份失效。

### 复制到成员仓库的目录

每个健康成员仓库根目录新增 `vault-pool.json`。目录不含 token，不含本地路径，不含用户昵称。首个仓库是 `catalogRepositoryId`，作为目录写入的串行源；同步后将同一份目录复制到其他健康成员。这避免多设备同时改池成员或范围归属时出现两种权威映射。

```json
{
  "version": 1,
  "poolId": "pool-...",
  "catalogRepositoryId": "repo-...",
  "members": [
    { "repositoryId": "repo-...", "repoUrl": "https://github.com/owner/vault-a.git", "branch": "main", "addedAt": 0 }
  ],
  "scopeHomes": {
    "scope-...": { "repositoryId": "repo-...", "assignedAt": 0, "assignedLogicalBytes": 0 }
  },
  "updatedAt": 0
}
```

`vault.json` 增加可选 `poolId` 和 `repositoryId`。连接时必须验证 plugin、storage、pool ID、仓库 ID 和 descriptor 成员列表，拒绝把陌生仓库并入现有池。

### 分配与统计

1. 读取 catalog descriptor 后，已有 `scopeHomes[scopeId]` 永远优先。
2. 从 v1 升级时，先读取首仓现有 manifest，把其中每个历史 `scopeId` 都写成首仓 home，再接受任何新范围。这样旧云端范围不会因新增成员被误投到另一个仓库。
3. 未分配范围按各成员 manifest 的 `logicalBytes` 加本轮已排队范围的预估体积，选择最小成员；并按稳定的 `repositoryId` 打破并列。
4. 在上传对象前，先把新映射提交到 catalog descriptor。中途成员失败时映射保留，下次同步仍回到同一 home，不会改投另一个仓库。
5. 每个成员 manifest 补充 scope/entry 的可选逻辑体积。新快照取 `snapshotStorage.rawSize`；旧普通 JSONL 在本地 workspace 用文件大小补齐。资源因内容寻址会跨 scope 去重，故不用于精确配额。

这是一种稳定分配，不承诺将单条不断增长的超大聊天自动搬家。这样不会触碰已成功备份的历史对象，也让每个范围保持可独立恢复。

## 后端实施路径

1. 将单仓配置归一化、token 脱敏、成员 ID、descriptor 合并/校验、范围分配和 manifest 聚合抽到可单测的 cloud-pool helper。保留 `getCloudPaths()` 的 URL/branch 工作区隔离规则。
2. 将现有单仓生命周期封装为“一个成员”的操作：初始化/拉取、marker 校验、流式持久化、重建 manifest、commit/push、记录 `lastPulledAt` 与 `lastPushedAt`。成员 token 仍只通过当前仓库 URL 对应的临时 `git -c http.<url>.extraHeader` 传入。
3. 重写 `/cloud/connect` 与 `/cloud/sync/push` 的编排层：先加载并校验 catalog，再计划 `scopeId -> homeRepositoryId`，按 home 分组同步。Git 操作锁按稳定成员顺序取得，避免同一进程内的交叉等待。
4. 对每个成员单独捕获失败。响应保留原有 `skipped`（本地快照坏档）并新增成员级 `memberResults`、`failedRepositoryIds` 和受影响的 `scopeId`；健康成员照常提交推送。
5. 重写 `/cloud/status` 和 `/cloud/list` 为池聚合：逐成员拉取 manifest，按 scope 展示；每条 entry 附带 `repositoryId`、仓库显示名和成员可用状态。失败成员可保留上次本地缓存的目录，但必须标为不可刷新，不能伪装成最新远端状态。
6. 将 `repositoryId` 设为 `/cloud/snapshot/get`、`prepare-restore`、`import`、`delete` 的必填请求字段。服务端必须先从本地配置和 descriptor 双重校验该成员，再进入现有 get/prepare/import/delete 链路。
7. 删除只修改 entry 所属成员仓库，并只在该仓库内清理无引用快照分块和资源。随后重取或重建池聚合目录，不跨仓库删对象。

## 前端实施路径

1. `cloudConfigCache` 改为池安全视图，`cloudManifestCache` 改为聚合 manifest；当前 `activeCloudScopeId` 可以保留，checkpoint action 从 entry 读取 `repositoryId`。
2. 云端设置区首个成员继续显示当前 URL、分支、token、设备名和同步规则。新增“添加仓库”后出现成员行；空 token 表示使用已有默认 token，避免同一 GitHub 帐号重复填写。
3. 成员行展示 URL、分支、已保存凭据状态、最近同步时间、已分配范围数、逻辑体积和最近错误。新增/保存/连接/同步期间禁用相关控件，避免重复提交。
4. 远端范围列表仍按聊天范围聚合；备份卡展示来源仓库标记。预览、导入、恢复和删除调用都携带 entry 的 `repositoryId`。
5. 当成员失败时，toast 说明“其他仓库已完成”，并在成员状态中列出失败仓库及受影响范围数；不把整次同步误报为完全失败。
6. 新增中英文 i18n。首个仓库用户不需要阅读仓库池说明才能继续使用原来的单仓流程。

## 测试与验收

自动测试新增 `tests/cloud-pool.test.mjs`，使用临时目录和至少三个本地 bare Git remotes：

1. 旧 v1 单仓配置迁移为一成员池，保留 URL、分支、token、设备和选择项；安全 API 响应中不出现 token。
2. 多个新范围按逻辑体积稳定分配。一次成功分配后新增成员或下次同步都不改变旧 home。
3. 每个范围的 meta、快照/分块和资源只出现在其 home remote；聚合 manifest 可列出全部范围，每条 entry 都能定位回正确成员。
4. 预览、导入、恢复和删除分别命中正确成员；删除 A 不清理 B 的资源或快照。
5. 一个 remote 故意不可访问或被拒绝时，其他 remote 仍完成；响应准确列出失败成员和受影响范围。已有“单条本地快照坏档继续”的行为不回退。
6. 105 MiB 分块测试继续通过，并确认被分配成员的最大 Git blob 仍小于 45 MiB。
7. 运行现有语法检查、character fingerprint 测试、cloud snapshot 测试，以及全新的 pool 测试。再按手动测试文档验证单仓升级、多仓新增、跨设备发现、部分失败、恢复和移动端布局。

## 文档与发布

- 更新 `README.md`、`README_EN.md`：仓库池是可选能力；说明新增成员只需 URL，默认 token 复用；明确不自动迁移旧范围。
- 更新 `docs/ARCHITECTURE.md`：catalog descriptor、稳定 home 路由、成员失败隔离和聚合读取。
- 更新 `docs/DATA_MODEL.md`：v2 本地配置、`vault-pool.json`、marker 扩展、manifest provenance 与兼容规则。
- 更新 `docs/MANUAL_TESTING.md`：单仓兼容、成员新增、故障隔离、跨设备发现和恢复验证。
- 更新 `CHANGELOG.md`、`extension/manifest.json`，目标版本为 `0.4.0`，并在发布前确认所有版本号一致。

## 执行顺序

1. `CVP-01` 配置与纯数据模型。
2. `CVP-02` 成员连接、descriptor 和安全校验。
3. `CVP-03` 固定 home 路由与分成员同步。
4. `CVP-04` 聚合目录与 repository-aware 恢复链。
5. `CVP-05` 面板与 i18n。
6. `CVP-06` 自动与手动验证。
7. `CVP-07` 文档、版本和最终 review。
8. `CVP-08` 发布提交并合并到 `main`。

## 通过标准

- 现有单仓用户升级后不需要任何额外操作，旧远端对象可读可恢复。
- 添加第二个仓库只要求一个新的仓库 URL；同权限 token 不需要重复输入。
- 同一范围不会在正常同步中改仓或跨仓拆包。
- 一成员同步失败不会阻塞其他成员，也不会损坏或删除本地备份。
- 云端每项操作都通过 `repositoryId` 精确命中来源仓库。
- 任何 API、远端 descriptor、Git 配置和文档示例都不泄漏 token。
- 多 remote 自动测试、现有 105 MiB 分块测试、语法检查和人工回归全部通过后，才进入 `0.4.0` 发布步骤。

## 发布收口

- `CVP-08`：完整自动回归通过，CHANGELOG 仅保留 `0.3.4` 与 `0.4.0` 的最终用户差异；feature 提交 `7531674` 已 fast-forward 合并到 `main`。未推送远端，未创建 tag。
