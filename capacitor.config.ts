import type { CapacitorConfig } from "@capacitor/cli";

if (process.env.NATIVE_SERVER_URL) {
  throw new Error("Offline App bundles its pages. Remove NATIVE_SERVER_URL before syncing.");
}

const config: CapacitorConfig = {
  appId: "com.sevenailab.yujianji",
  appName: "遇见集",
  webDir: ".native-build/project/out",
};

export default config;
