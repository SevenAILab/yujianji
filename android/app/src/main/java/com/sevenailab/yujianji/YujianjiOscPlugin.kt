package com.sevenailab.yujianji

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.URL

@CapacitorPlugin(name = "YujianjiOsc")
class YujianjiOscPlugin : Plugin() {
    @PluginMethod
    fun execute(call: PluginCall) {
        val url = call.getString("url")
        val body = call.getString("body") ?: ""
        val timeoutMs = call.getInt("timeoutMs", 20000)

        if (url.isNullOrBlank()) {
            call.reject("缺少 OSC 请求地址", "INVALID_URL")
            return
        }

        Thread {
            try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = timeoutMs
                connection.readTimeout = timeoutMs
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val responseText = stream?.bufferedReader()?.use { it.readText() } ?: ""
                connection.disconnect()

                val result = JSObject()
                result.put("status", status)
                result.put("body", responseText)
                result.put("ok", status in 200..299)
                call.resolve(result)
            } catch (error: Exception) {
                call.reject(error.message ?: "OSC 请求失败", "OSC_ERROR", error)
            }
        }.start()
    }
}
