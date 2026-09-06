import type { DeviceSource, HealthSnapshot } from "./types";

type BluetoothCharacteristic = {
  value?: DataView;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  startNotifications(): Promise<BluetoothCharacteristic>;
};
type BluetoothDeviceLike = {
  name?: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  gatt?: {
    connect(): Promise<{ getPrimaryService(name: string): Promise<{ getCharacteristic(name: string): Promise<BluetoothCharacteristic> }> }>;
    disconnect(): void;
  };
};

type BluetoothNavigator = Navigator & {
  bluetooth?: { requestDevice(options: unknown): Promise<BluetoothDeviceLike> };
};

export type DeviceKind = "huawei" | "amazfit" | "xiaomi" | "standard-bluetooth";
export interface DeviceConnection { kind: DeviceKind; label: string; source: DeviceSource; disconnect(): void; }

export function supportsStandardBluetooth(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && !!(navigator as BluetoothNavigator).bluetooth;
}
export async function connectStandardHeartRate(
  onSnapshot: (snapshot: HealthSnapshot) => void,
  onDisconnect?: () => void,
): Promise<DeviceConnection> {
  if (!supportsStandardBluetooth()) throw new Error("当前环境不支持蓝牙心率，请使用支持 Web Bluetooth 的浏览器并通过 HTTPS 访问");
  const bluetooth = (navigator as BluetoothNavigator).bluetooth!;
  const device = await bluetooth.requestDevice({ filters: [{ services: ["heart_rate"] }] });
  let characteristic: BluetoothCharacteristic | undefined;
  let closed = false;
  const handleValue = (event: Event) => {
    const value = (event.target as unknown as BluetoothCharacteristic).value;
    if (closed || !value || value.byteLength < 2) return;
    const wide = (value.getUint8(0) & 1) !== 0;
    if (wide && value.byteLength < 3) return;
    const heartRate = wide ? value.getUint16(1, true) : value.getUint8(1);
    onSnapshot({ timestamp: new Date().toISOString(), heartRate, source: "bluetooth-heart-rate" });
  };
  const cleanup = () => {
    characteristic?.removeEventListener("characteristicvaluechanged", handleValue);
    device.removeEventListener("gattserverdisconnected", handleDisconnected);
  };
  const handleDisconnected = () => {
    if (closed) return;
    closed = true;
    cleanup();
    onDisconnect?.();
  };
  device.addEventListener("gattserverdisconnected", handleDisconnected);
  try {
    const server = await device.gatt?.connect();
    const service = await server?.getPrimaryService("heart_rate");
    characteristic = await service?.getCharacteristic("heart_rate_measurement");
    if (!characteristic) throw new Error("未找到标准心率服务");
    if (closed) throw new Error("设备已断开，请重新连接");
    characteristic.addEventListener("characteristicvaluechanged", handleValue);
    await characteristic.startNotifications();
    if (closed) throw new Error("设备已断开，请重新连接");
    return {
      kind: "standard-bluetooth",
      label: device.name || "标准蓝牙心率设备",
      source: "bluetooth-heart-rate",
      disconnect: () => {
        if (closed) return;
        closed = true;
        cleanup();
        device.gatt?.disconnect();
      },
    };
  } catch (error) {
    closed = true;
    cleanup();
    device.gatt?.disconnect();
    throw error;
  }
}

export function healthProviderStatus(kind: DeviceKind): { available: boolean; message: string } {
  if (kind === "standard-bluetooth") return { available: supportsStandardBluetooth(), message: "可通过标准 Bluetooth Heart Rate Service 接入" };
  return { available: false, message: "需要原生桥接或厂商授权 SDK；Web 端不能直接读取该品牌手表数据" };
}

