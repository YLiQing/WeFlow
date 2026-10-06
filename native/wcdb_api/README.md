# TalkGate（语扉） `wcdb_api.dll` 重建

这是 TalkGate（语扉） 的独立 C ABI 适配层，底层使用腾讯 WCDB 发布包中的 SQLCipher 源码和 OpenSSL 静态库。

## 构建

先在仓库根目录准备并编译官方 WCDB：

```powershell
$cmake = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $cmake -S tmp/wcdb-2.1.16/src -B tmp/wcdb-build-20261006 -G 'Visual Studio 17 2022' -A x64 -DSKIP_WCONAN=ON -DWCDB_CPP=ON -DWCDB_BRIDGE=OFF -DWCDB_ZSTD=OFF -DBUILD_SHARED_LIBS=ON
& $cmake --build tmp/wcdb-build-20261006 --config Release --parallel 4
```

然后构建适配层：

```powershell
& $cmake -S native/wcdb_api -B tmp/wcdb-api-build-20261006 -G 'Visual Studio 17 2022' -A x64
& $cmake --build tmp/wcdb-api-build-20261006 --config Release --parallel 4
```

输出：`tmp/wcdb-api-build-20261006/Release/wcdb_api.dll`。

原生回归检查使用独立的合成加密数据库，不读取用户聊天数据：

```powershell
& tmp/wcdb-api-build-20261006/Release/wcdb_api_test.exe
```

验证 TalkGate（语扉） 时使用：

```powershell
$env:WCDB_DLL_PATH = (Resolve-Path tmp/wcdb-api-build-20261006/Release/wcdb_api.dll)
npm run electron:dev
```

当前工作分支已将构建产物复制到 `resources/wcdb/win32/x64/wcdb_api.dll`，用于本地验证；原 DLL 备份在 `tmp/wcdb_api.expired-original.dll`。

## 当前能力边界

- 已在真实账号上验证：解密并打开数据库、读取会话和联系人、读取聊天消息、消息计数、类型统计、游标连续翻页、群成员与联系人分类统计。抽样会话的计数和统计均为 21，前两批各 2 条且无重复；抽样群的单群、批量和成员列表数量均为 6，联系人五类统计与现有 TypeScript 算法一致。
- 图片/视频资源流已在真实账号上验证连续两页各 40 条、无重复；消息库 9 个、媒体库 2 个，媒体查询可读取 `VoiceInfo` 表。
- 语音单条/批量、头像二进制、图片硬链接路径和视频硬链接 MD5 已用真实数据库样本验证；批量统计和硬链接批量结果与单条接口一致。
- 全局搜索跨消息库的时间排序、分页及 `_session_id`，`chat_room.ext_buffer` 群昵称解析、群聊统计、共享聚合与年度基础统计已通过合成加密数据库检查；仍需用真实账号回归页面行为。
- 已补齐足迹统计、朋友圈时间线/统计/删除、朋友圈删除拦截 SQLite trigger、防撤回状态与消息表 trigger、监控管道导出及 Windows 命名管道启动。
- 当前 DLL 已通过 113 个导出符号核对、合成加密数据库回归和 Electron 冷启动验证；发布前仍应针对具体微信版本做页面和数据导出回归。

