# 设备与媒体接入说明

## 当前已实现（离线 Capacitor App）

- 行程记录：浏览器 `Geolocation.watchPosition` 持续记录纬度、经度、速度、方位与海拔（设备提供时）。
- 轨迹分析：本地计算距离、累计爬升和基础风险等级，数据保存在 IndexedDB。
- 健康快照：支持手动录入心率、血氧、步数和海拔；风险规则会随最近快照更新。
- 标准蓝牙心率：在支持 Web Bluetooth 的浏览器中，可连接实现 Bluetooth Heart Rate Service 的设备。
- 全景素材：支持上传本地 equirectangular 图片并拖动预览；与行程一起保存。
- 路线交换：导出/导入 JSON，包含轨迹、健康快照、补给、全景素材和风险摘要。
- 离线 App：页面内置到 Android/iOS 包中，照片、轨迹、饮食、健康导入和分享素材保存在 WebView IndexedDB；不配置 `NATIVE_SERVER_URL`。
- 原生健康桥：Android Health Connect、iOS HealthKit 读取插件已加入工程；品牌选择是接入指引，真实来源由系统返回。

## 为什么没有直接读取华为 / 华米 / 小米手表

手机 Web 页面无法稳定、跨品牌地读取这些厂商的私有健康数据。正式接入应增加原生桥接层：

1. Android 使用 Health Connect 或各厂商官方授权 SDK，把心率、血氧、步数和运动会话转换为 `HealthSnapshot`。
2. iOS 使用 HealthKit，并遵守用户授权、最小权限和后台采样限制。
3. 华为、Amazfit/Zepp、小米分别实现 provider adapter，统一输出 `HealthSnapshot`，不要让 UI 直接依赖厂商字段。
4. 将原生同步结果通过 Capacitor/React Native bridge 或 API 上传到同一行程；Web 端继续使用当前类型和风险逻辑。

## Insta360 Link 2 SDK 的边界

`insta360-link2-sdk-标准UVC.zip` 是 Link 2 / Link 2 Pro 的 UVC 摄像头视频流与 PTZ 云台控制示例，不是手表健康 SDK，也不是 360 全景编码 SDK。其 Windows/Ubuntu 文档要求以 UVC 视频设备方式打开摄像头，并通过 UVC Camera Terminal 控制 pan/tilt。

因此当前产品分两条链路：

- **照片/全景上传**：Web 端接受用户导出的 360 全景图片，当前做本地预览；下一步可在原生端加入等距柱状图投影、EXIF/GPano 元数据校验和更完整的球面查看器。
- **Link 2 摄像头接入**：在 Windows/Ubuntu 端运行独立本地 helper（V4L2/DirectShow + UVC PTZ），通过 localhost/WebSocket 把视频帧和云台状态桥接到应用；不要在 Windows 上直接替换系统摄像头驱动。

## 安全提示

心率、血氧和风险等级只用于提醒，不是医疗诊断。高风险提示应允许用户确认、暂停记录并联系同行者或当地救援服务。
