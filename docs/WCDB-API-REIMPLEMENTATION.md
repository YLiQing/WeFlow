# WCDB API 重建基线

逆向输入目录：`C:\Users\Administrator\Documents\Codex\2026-10-06\new-chat\outputs`

目标 DLL：`resources/wcdb/win32/x64/wcdb_api.dll`

## 已确认

- 目标文件是 Windows x64 PE DLL，导出 112 个函数。
- TalkGate（语扉） 当前通过 `electron/services/wcdbCore.ts` 使用其中约 92 个不同接口；逆向输出中的 FFI 声明与项目调用基本一致。
- 额外导出包括 AI 查询、自定义表情、FTS 探测、带密钥游标等接口，当前 TalkGate（语扉） 没有调用。
- `InitProtection` 内含固定时间判断：`0x6ABDA27F`，即 `2026-09-30 23:59:59 UTC`。当前时间超过该值时返回 `0xFFFFFF9B`（有符号值 `-101`）。
- `wcdb_init` 在安全状态失败时记录 `expired: self-destruct triggered`，后续数据库接口也会被安全状态拦截。
- `wcdb_open_account` 的伪代码显示它会调用 `WCDB::Database::setCipherKey` 和 `canOpen`，因此它确实负责打开加密数据库，不是单纯的转发 DLL。

## 能否直接使用逆向 C 文件

不能。`wcdb_api_decompiled.c` 和 `wcdb_api_all_functions.c` 是反编译伪代码，不具备可编译条件：

- `FUN_...` 内部函数、C++ 类型和异常边界都缺失；
- Ghidra 对部分返回类型的推断与 TalkGate（语扉） 的 FFI 声明不一致；
- 依赖的 WCDB C++ 对象、SQLite/SQLCipher、线程和资源管理代码没有恢复；
- 直接复制伪代码还会把原 DLL 的过期保护和未知副作用带进新实现。

## 重建路线

1. 以 `wcdbCore.ts` 的 FFI 声明作为 ABI 合同。
2. 基于腾讯 WCDB 的合法源码/发布包实现新的只读适配层。
3. 先实现 `wcdb_init`、`wcdb_shutdown`、`wcdb_open_account`、`wcdb_get_sessions`、`wcdb_get_messages`、游标和 `wcdb_free_string`。
4. 用测试数据库验证返回 JSON、句柄生命周期和错误码，再补联系人、媒体、统计和写入接口。
5. 新 DLL 单独放在重建产物目录，通过 `WCDB_DLL_PATH` 做 A/B 验证，不覆盖现有资源。

## 当前结论

`-101` 已被逆向结果确认是 DLL 内置的过期逻辑，不是当前 TalkGate（语扉） 的路径、密钥或聊天页面改动造成的。

## 当前构建验证

- `InitProtection` 已改为无过期校验并返回成功。
- 兼容层已实现足迹统计、朋友圈删除、防撤回状态与 SQLite 触发器、朋友圈删除拦截触发器、监控管道名称及 Windows 命名管道启动。
- 合成数据库测试：`wcdb_api synthetic search, nickname, group, and annual checks passed`。
- Electron 冷启动：`koffi.load ok`、`open ok handle=1`、`database_count=29`，无 `-101`。
- 当前资源 DLL SHA256：`4455FE763432F64C362CCD5DCF0C4609ED66AD9EE1D024F9CBD1C3E179A94B32`。

