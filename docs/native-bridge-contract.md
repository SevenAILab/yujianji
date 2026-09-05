# 原生健康桥接：实现与真机验收

## 本轮交付

不是 `window` 注入示例：现在使用 Capacitor 8 原生容器和注册插件 `YujianjiHealth`，包含 Android 工程、iOS Xcode 工程、Kotlin Health Connect 读取和 Swift HealthKit 读取代码。

- `/devices` 根据提供的「09-连接设备」图延续米白、青绿、同心圆和设备卡片。没有照抄图中的“正在扫描 / 已发现”，因为系统健康共享不是蓝牙扫描。
- `status()` 返回平台服务可用性，不表示手表连接。
- `requestAccess()` 由用户勾选同意并点击后触发，只申请心率、血氧、步数只读权限。
- `readSamples({from,to})` 每次最多 24 小时，保留来源、原始记录 ID 和采样时间。Android 分页读取；两端超过限制均返回 `truncated`。
- 血氧统一为 0–100；iOS 原始比例乘 100。步数保留区间，不把多来源相加，不冒充实时步数。
- 前端校验、去重并存入 IndexedDB；仅时间落在进行中行程内的新记录关联到该行程，不覆盖并发 GPS 更新。
- 缺失数据不补零，旧读数标记历史记录。用户可删除本机导入记录，包括行程里的原生导入快照。
- 本轮是用户触发的历史同步，不是持续健康流，不是原生后台定位或后台医疗监测。

## 三个品牌的实际边界

| 品牌 | 当前读取路径 | 不能保证的部分 |
| --- | --- | --- |
| 华为 | 华为运动健康若能写入 HealthKit / Health Connect，读取其实际写入的记录 | 没有 Health Connect 的华为系统、HarmonyOS、地区/机型不支持共享时，仍需华为授权 SDK |
| 华米 / Amazfit | Zepp 若能向系统健康平台共享，可读取其实际记录 | Zepp 版本、系统、机型和指标共享范围各异 |
| 小米 | 小米运动健康 / Mi Fitness 若能共享，可读取其实际记录 | 血氧等字段可能不共享，不能凭 UI 声称已接入 |

选择品牌只切换说明；UI 按平台返回的 source bundle ID / packageName 展示和筛选来源，不推断品牌，不伪造配对。厂商 OAuth、专有 SDK、自动导入手表路线均未实现。现有 UVC SDK 不提供健康能力。

## 离线 App（当前构建方式）

当前 App 不读取 `NATIVE_SERVER_URL`，页面在构建时内置到 Capacitor 的 Android/iOS 包内；设置该变量会被拒绝，避免误把数据导向外部网站。

```powershell
Remove-Item Env:NATIVE_SERVER_URL -ErrorAction SilentlyContinue
npm run native:sync
npm run native:preview
```

照片、轨迹、健康导入、饮食、路线和分享素材只写入 WebView 的 IndexedDB；清除 App 数据或卸载会删除本机数据。离线包关闭云端 AI、在线地点查询和云端地图接口，识别页面提供手动本地保存。健康桥仍然需要系统授权，并只读取厂商 App 已同步到 Health Connect / HealthKit 的记录。

## 启动 Web

```powershell
npm ci --ignore-scripts
npm run dev -- --hostname 0.0.0.0
```

打开 `http://localhost:3000/devices`。普通浏览器没有 HealthKit / Health Connect；点击接入按钮会说明这一限制。普通 Web 运行仍可使用项目原有云端识别功能；它不是离线 App 构建。

## Android 真机

1. 安装 Android Studio、SDK 36、JDK 21。Health Connect 读取需要 Android 9+，Android 14+ 通常集成在系统中，较旧系统需支持安装服务；不支持服务时明确返回不可用。
2. 直接使用离线包，不设置 `NATIVE_SERVER_URL`，执行 `npm run native:sync`。
3. `npx cap open android`，或 `cd android; ./gradlew.bat assembleDebug`，连接手机运行。
5. 插件注册在 `MainActivity.java`，读取实现为 `YujianjiHealthPlugin.kt`；清单已加入只读权限与健康权限用途页面。发布前需完成 Play 健康数据声明和隐私审查。

## iOS 真机

1. 在 Mac 安装 Xcode，执行 `npm run native:sync` 后 `npx cap open ios`。
2. 选择自己的签名 Team，确认 App ID 开启 HealthKit 并生成对应 provisioning profile。
3. 工程已包含 `NSHealthShareUsageDescription`、HealthKit entitlement、自定义桥接控制器与 Swift 插件源码编译引用。
4. HealthKit 授权回调成功只说明授权流程完成，**不表示读取被允许**。Apple 不披露读取拒绝状态；空结果也可能是没有数据。UI 不宣称授权成功。
5. 不申请写权限，不启动后台 observer，不上传数据到服务器。

## 真机验收（未完成，不能用 Web 测试替代）

- 每品牌记录具体手表型号、固件、手机系统、厂商 App 版本、地区。
- 首次拒绝、部分允许、撤销后重试、服务未安装，均不得产生虚构读数或崩溃。
- 与系统健康 App 对照同一条心率/血氧/步数：值、单位、采样时间、来源一致。
- 连续同步两次不重复；不同来源不合并；离线/无数据提示明确；超过记录上限显示不完整。
- 在新建行程前的记录不归入当前行程；暂停/结束的行程不接收此次导入。
- 删除本机导入，关闭 App 后重新打开确认删除生效。已导出文件和系统平台记录不自动删除。

Windows 环境不能编译签名 iOS；本机缺少 Android SDK，Android 构建需补工具链。尚无实际手表或厂商开发者授权，因此这次不声称三品牌真机已经打通。

## 隐私与安全

仅用户点击后读取，数据留在 WebView IndexedDB。生产应关闭不受信任外链进入容器，不配置任意 `allowNavigation`，保护 HTTPS 源站、防止 XSS。分享现有行程 JSON 会包含关联健康快照，必须由用户确认分享内容；旧导出副本需自行删除。来源属于系统元数据，不是医学或真伪认证。

健康提醒不是诊断，也不能证明能否走完路线；照片不能评估所有地形、天气、海拔和个人风险。步数、血氧不同步不代表健康正常。

## 依据

- [Android 官方 Health Connect 示例](https://github.com/android/health-samples/tree/main/health-connect/HealthConnectSample)：已读取其 HealthConnectManager 源码，核对权限与分页请求方式。
- [Health Connect 读取指南](https://developer.android.com/health-and-fitness/guides/health-connect/develop/read-data)：本机直连超时，使用官方 GitHub 示例交叉核对。
- [Apple 请求健康授权](https://developer.apple.com/documentation/healthkit/hkhealthstore/requestauthorization(toshare:read:completion:))：已读取 Apple 文档 JSON。
- [Capacitor 原生插件](https://capacitorjs.com/docs/plugins)：工程由 CLI 生成，插件使用注册的原生方法调用，不向 JS 传递原生函数对象。
