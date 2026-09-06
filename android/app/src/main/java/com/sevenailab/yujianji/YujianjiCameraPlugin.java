package com.sevenailab.yujianji;

import android.content.Intent;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "YujianjiCamera")
public class YujianjiCameraPlugin extends Plugin {
    @PluginMethod
    public void openWifiSettings(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS));
            call.resolve();
        } catch (Exception error) { call.reject("无法打开 Wi-Fi 设置，请手动打开系统设置", error); }
    }

    @PluginMethod
    public void openInsta360(PluginCall call) {
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage("com.arashivision.insta360akiko");
        if (intent == null) { call.reject("尚未安装 Insta360 App"); return; }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject("无法打开 Insta360 App", error); }
    }
}
