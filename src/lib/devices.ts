import type { DeviceSource, HealthSnapshot } from "./types";

type BluetoothCharacteristic = {
  value?: DataView;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  startNotifications(): Promise<BluetoothCharacteristic>;
};
type BluetoothDeviceLike = {
  name?: string;
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
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}
export async function connectStandardHeartRate(onSnapshot: (snapshot: HealthSnapshot) => void): Promise<DeviceConnection> {
  if (!supportsStandardBluetooth()) throw new Error("当前浏览器不支持 Web Bluetooth");
  const bluetooth = (navigator as BluetoothNavigator).bluetooth;
  if (!bluetooth) throw new Error("当前浏览器不支持 Web Bluetooth");
  const device = await bluetooth.requestDevice({ filters: [{ services: ["heart_rate"] }] });
  const server = await device.gatt?.connect();
  const service = await server?.getPrimaryService("heart_rate");
  const characteristic = await service?.getCharacteristic("heart_rate_measurement");
  if (!characteristic) throw new Error("未找到标准心率服务");
  const handleValue = (event: Event) => {
    const value = ((event.target as unknown) as BluetoothCharacteristic).value;
    if (!value) return;
    const flags = value.getUint8(0);
    const heartRate = flags & 1 ? value.getUint16(1, true) : value.getUint8(1);
    onSnapshot({ timestamp: new Date().toISOString(), heartRate, source: "bluetooth-heart-rate" });
  };
  characteristic.addEventListener("characteristicvaluechanged", handleValue);
  await characteristic.startNotifications();
  return {
    kind: "standard-bluetooth",
    label: device.name || "标准蓝牙心率设备",
    source: "bluetooth-heart-rate",
    disconnect: () => {
      characteristic.removeEventListener("characteristicvaluechanged", handleValue);
      device.gatt?.disconnect();
    },
  };
}

export function healthProviderStatus(kind: DeviceKind): { available: boolean; message: string } {
  if (kind === "standard-bluetooth") return { available: supportsStandardBluetooth(), message: "可通过标准 Bluetooth Heart Rate Service 接入" };
  return { available: false, message: "需要原生桥接或厂商授权 SDK；Web 端不能直接读取该品牌手表数据" };
}

