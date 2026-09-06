package com.sevenailab.yujianji;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(YujianjiHealthPlugin.class);
        registerPlugin(YujianjiOscPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
