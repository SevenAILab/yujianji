package com.sevenailab.yujianji

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class HealthRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = TextView(this)
        text.text = "遇见集健康数据说明\n\n仅读取你授权的心率、血氧和步数，用于本地行程记录。不会写入健康平台、用于广告或自动上传 AI。\n\n你可以在 Health Connect 撤销读取权限，在设备中心删除本机导入记录。路线导出可能包含你主动加入的体征，请在分享前确认。\n\n数据可能延迟或缺失，不用于医疗诊断或证明路线安全。"
        text.textSize = 18f
        text.setPadding(32, 60, 32, 32)
        setContentView(text)
    }
}
