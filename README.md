# compiler-js

`compiler-js` 是 Ring Engine 的 JavaScript 编译工具链工作区。

它包含三部分：

- `core`：编译器核心，只处理内存中的 `filter-src` 输入与编译产物输出
- `packer`：资源包打包库，负责正式加密资源包的打包/解包
- `cli`：命令行入口，负责把 `core` 和 `packer` 组合成实际可用的工具

## 模块关系

- `core` 不受 Node 环境约束，可以在浏览器环境中使用
- `packer` 不受 Node 环境约束，可以在浏览器环境中使用
- `cli` 依赖 `core` 和 `packer`

## 工程结构

```text
compiler-js/
  package.json
  package-lock.json
  README.md
  core/
    package.json
    src/
    test/
    scripts/
    vendor/
  packer/
    package.json
    src/
    test/
  cli/
    package.json
    src/
    test/
```

各目录职责如下：

- `core/src`
  - 编译器核心实现
  - Lua / GLSL / manifest 校验逻辑
  - 浏览器与 Node 可共用的编译入口
- `core/test`
  - 编译器规则单测
  - 文档约束对应测试
- `core/scripts`
  - 开发辅助脚本
- `core/vendor`
  - 编译器依赖的语法文件等静态资源
- `packer/src`
  - 资源包格式实现
  - 正式加密包打包/解包
  - 包头与 entry list 编解码
- `packer/test`
  - 正式资源包 round-trip 与签名校验测试
- `cli/src`
  - 命令行入口
  - 目录读写
  - 密钥输入解析
- `cli/test`
  - 正式资源包 CLI 集成测试

## core

`core` 的职责是把 `filter-src` 的内存文件字典编译成产物文件字典。

输入形式：

- `Record<string, string | Uint8Array>`

输出形式：

- `Record<string, string | Uint8Array>`

它不负责：

- 打包为 ZIP
- 打包为正式加密包
- 读写本地磁盘
- 命令行交互

它负责：

- 校验 `manifest.json`
- 通过远程 `filter-src.schema.json` 和 `filter.schema.json` 做 schema 约束
- 校验 Lua 语法与当前编译器规则
- 校验 GLSL 语法与当前编译器规则
- 编译 shader
- 生成最终编译产物内存字典

主要入口：

- `core/src/index.js`
  - 浏览器/通用入口
- `core/src/node.js`
  - Node 环境辅助入口
- `core/src/glslang-web.js`
  - 浏览器 shader 编译器工厂
- `core/src/glslang-node.js`
  - Node shader 编译器工厂

## packer

`packer` 的职责是把内存文件字典转换成可分发的二进制资源包，或者把资源包还原回内存文件字典。

它设计为浏览器可运行的库，不直接依赖 Node 的 `fs`、`path`、`process`。

`packer` 当前执行的资源包格式标准是：

- [FILTER_PACKAGE.md](https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_PACKAGE.md?plain=1)
- [FILTER_PACKAGE.zh-CN.md](https://github.com/RingEngine/Docs/blob/runtime-1/FILTER_PACKAGE.zh-CN.md?plain=1)

上面两份文档定义了 `packer` 当前遵循的正式资源包标准，包括：

- 包整体布局
- 固定头字段
- 签名覆盖范围
- 密钥派生规则
- 内容加密规则
- `encryptedEntryList` 结构
- `entryRecord` 字段定义
- payload 的压缩与加密顺序

正式资源包文件扩展名是 `.rfp`。

当前支持的正式输出是 `.rfp` 资源包。

正式资源包能力包括：

- 使用主密钥派生资源包密钥
- 可选使用私钥进行签名
- 加密 `entry list`
- 独立加密每个 entry payload
- 根据主密钥解包
- 可选使用公钥验签
- 支持只列出文件清单和属性，不必解密全部文件

主要入口：

- `packer/src/index.js`

核心 API：

```js
await packFilterPackage({
  masterKey,
  privateKey,
  files
})

await unpackFilterPackage(packageBytes, {
  masterKey,
  publicKey,
  listOnly
})

listFilterPackage(packageBytes)
```

其中：

- `masterKey`：字符串或字节
- `privateKey`：可选，PEM 私钥字符串或已导入密钥对象
- `publicKey`：可选，PEM 公钥字符串或已导入密钥对象
- `files`：逻辑路径到内容的字典

### 当前加解密实现概览

下面这部分描述的是 `packer` 当前实现语义，方便调用方理解输入要求与实际处理流程；正式资源包格式仍以 `Docs` 仓库中的规范文档为准。

- `masterKey` 本质上是任意字节序列
- 如果传入的是字符串，当前实现会先取它的 UTF-8 编码字节；不会自动按 hex 或 base64 解码
- `masterKey` 不会直接拿来做 AES 密钥，而是先作为 HKDF 输入材料
- `packer` 会先生成随机 `salt`，然后使用 `HKDF-SHA-256(masterKey, salt, "ring.filter.package.v1")` 派生出固定长度的 `packageKey`
- `packageKey` 之后会继续派生出：
  - `manifestKey`
  - `manifestNonce`
  - 每个 entry 各自独立的 `entryKey`
- `entry list` 会使用 `manifestKey` 做 AES-GCM 加密
- 每个 entry 的 payload 会先做 `deflateRaw` 压缩，再使用各自的 `entryKey` 和随机 nonce 做 AES-GCM 加密
- 私钥和公钥不参与内容加密，只用于可选签名校验
- 私钥输入是 PEM 文本，导入格式是 `PKCS#8`
- 公钥输入是 PEM 文本，导入格式是 `SPKI`
- 当前签名算法是 `RSA-PSS + SHA-256`
- 当前实现中签名区固定为 256 字节，因此实际使用应与 `RSA 2048` 对齐

## cli

`cli` 是 `compiler-js` 的命令行封装层。

CLI 交付的命令名是 `rfc2`。

`rfc2` 是 `Ring Filter Compiler CLI` 的缩写。

它当前覆盖完整的编译与打包链路：

- `filter-src` 检查
- `filter-src` 编译
- 目录打包为正式资源包
- 包内容查看
- 资源包解包

命令入口：

- `cli/src/main.js`

如果只是使用已发布的 CLI，可以直接通过 npm 包运行：

```powershell
npx @ring-engine-org/filter-cli@0.1.1 <command> ...
```

或者全局安装后使用 `rfc2`：

```powershell
npm install -g @ring-engine-org/filter-cli@0.1.1
rfc2 <command> ...
```

如果是在当前工作区里开发，可以通过以下方式运行：

```powershell
npm install
node ./cli/src/main.js <command> ...
```

或者使用工作区生成的二进制入口：

```powershell
npx rfc2 <command> ...
```

### `pack`

把指定目录直接打包为正式资源包。

```powershell
npx rfc2 pack `
  --input .\compiled `
  --output .\my-filter.rfp `
  --master-key "my-master-key"
```

如果希望先编译源码再打包：

```powershell
npx rfc2 pack `
  --input .\my-filter-src `
  --output .\my-filter.rfp `
  --master-key "my-master-key" `
  --include-compiling `
  --private-key-file .\private.pem
```

参数：

- `--input <dir>`：输入目录
- `--output <file.rfp>`：输出正式资源包
- `--master-key <value>`：直接传入主密钥
- `--include-compiling`：先把输入目录按 `filter-src` 编译，再打包编译结果
- `--private-key <pem>`：直接传入 PEM 私钥
- `--private-key-file <path>`：从文件读取 PEM 私钥
- `--private-key-url <url>`：从 URL 读取 PEM 私钥

要求：

- `pack` 必须提供主密钥
- 私钥是可选项，不提供时产出未签名资源包
- 不带 `--include-compiling` 时，`pack` 直接打包输入目录内容
- 带 `--include-compiling` 时，`pack` 会先编译；如果编译失败，则和 `compile` 一样报错退出

### `check-source`

检查 `filter-src` 源目录，但不产出编译结果。

```powershell
npx rfc2 check-source --input .\my-filter-src
```

参数：

- `--input <dir>`：输入 `filter-src` 目录

行为：

- 输出检查摘要
- 诊断信息输出到标准错误
- 有 error 时以非零退出码结束

### `compile`

把 `filter-src` 源目录编译到输出目录。

```powershell
npx rfc2 compile `
  --input .\my-filter-src `
  --output .\compiled
```

参数：

- `--input <dir>`：输入 `filter-src` 目录
- `--output <dir>`：输出编译结果目录

行为：

- 产出编译后的 `manifest.json`
- 产出 `main.lua`
- 产出 `.spv` shader 文件
- 拷贝编译结果需要的资源文件

### `list`

查看 ZIP 或正式资源包内容。

```powershell
npx rfc2 list --input .\my-filter.rfp
```

如果希望解出正式包中的 entry 清单并验签：

```powershell
npx rfc2 list `
  --input .\my-filter.rfp `
  --master-key "my-master-key" `
  --public-key-file .\public.pem
```

参数：

- `--input <file>`：输入 ZIP 或正式资源包
- `--master-key <value>`：直接传入主密钥
- `--public-key <pem>` / `--public-key-file <path>` / `--public-key-url <url>`

行为：

- 对 ZIP：直接列出文件路径、类型、大小
- 对正式资源包且未提供主密钥：只列头信息
- 对正式资源包且提供主密钥：列头信息、entry 清单，且在提供公钥时返回验签结果

### `unpack`

把 ZIP 或正式资源包解包到目录。

```powershell
npx rfc2 unpack --input .\my-filter.rfp --output .\out --master-key "my-master-key"
```

解包正式资源包：

```powershell
npx rfc2 unpack `
  --input .\my-filter.rfp `
  --output .\out `
  --master-key "my-master-key" `
  --public-key-file .\public.pem
```

参数：

 - `--input <file>`：输入正式资源包或 ZIP
- `--output <dir>`：输出目录
- `--master-key <value>`：直接传入主密钥
- `--public-key <pem>` / `--public-key-file <path>` / `--public-key-url <url>`

要求：

- 解包正式资源包必须提供主密钥
- 公钥可选；提供时会执行签名验证

## 开发

安装依赖：

```powershell
cd compiler-js
npm install
```

运行全部测试：

```powershell
npm test
```

分别运行单模块测试：

```powershell
npm --prefix ./core test
npm --prefix ./packer test
npm --prefix ./cli test
```

发布前检查：

```powershell
npm run release:check
```

## npm 包与发布

当前工作区会发布这三个 npm 包：

- `@ring-engine-org/filter-compiler-core`
- `@ring-engine-org/filter-packer`
- `@ring-engine-org/filter-cli`

其中：

- `@ring-engine-org/filter-cli` 对外提供 `rfc2`
- `@ring-engine-org/filter-cli` 依赖 `@ring-engine-org/filter-compiler-core`
- `@ring-engine-org/filter-cli` 依赖 `@ring-engine-org/filter-packer`
- 当前已成功发布版本是 `0.1.1`

CI 位于：

- `.github/workflows/ci.yml`

tag 驱动的发布工作流位于：

- `.github/workflows/publish.yml`

当前约定：

- PR 会触发 CI：
  - 运行测试
  - 生成临时预览 tarball
  - 预览版本格式为 `0.0.0-pr.<pr号>.<run号>`
  - 产物以 GitHub Actions artifact 形式上传
- 推送 `v0.0.0` 这类 tag 时会触发正式发布流程
- 正式发布要求：
  - tag commit 必须位于 `master`
  - tag 必须匹配 `v0.0.0` 格式
  - `core` / `packer` / `cli` 的 `package.json.version` 必须与 tag 去掉前导 `v` 后一致
- 发布前会先执行测试和 `npm pack --dry-run`
- 正式发布当前使用 `Node 24` 自带的 npm 11
- 正式发布走纯 npm trusted publishing / OIDC
- GitHub Actions 不再依赖 `NPM_TOKEN`

## 当前边界

当前工作区的边界如下：

- `core` 只关心编译规则与编译产物，不关心最终容器
- `packer` 只关心包格式，不关心 `filter-src` 语义
- `cli` 负责把 `core` 和 `packer` 组合成实际可执行的编译命令行工具

这个拆分的目的，是让：

- `core` 可被 web editor 直接引用
- `packer` 可被浏览器与其他宿主复用
- `cli` 作为完整 compiler CLI 对外提供统一入口
