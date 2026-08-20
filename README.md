# MW Rules

`MW-Shadowrocket-Config.conf` 的私有可视化管理后台。

## 功能

- 从 `mmousew/MWshadowrocket-rules` 的 `rules/initial-region-module` 分支读取配置
- 可视化新增、编辑和删除代理分组、域名规则及远程规则集
- 保存前检查重复规则、策略引用与 `FINAL` 规则
- 通过服务端 GitHub API 提交修改，访问令牌不会发送到浏览器
- 站点使用私有访问，仅授权账号可打开

## 本地运行

```bash
npm install
npm run dev
```

如需测试保存功能，将 `.env.example` 复制为 `.env.local`，并填入仅对该仓库具有 Contents 读写权限的 fine-grained GitHub token。

```bash
npm test
npm run lint
```
