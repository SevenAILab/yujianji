package com.sevenailab.yujianji

import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import kotlin.reflect.KClass

@CapacitorPlugin(name = "YujianjiHealth")
class YujianjiHealthPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val metrics = mapOf(
        HealthPermission.getReadPermission(HeartRateRecord::class) to "heartRate",
        HealthPermission.getReadPermission(OxygenSaturationRecord::class) to "bloodOxygen",
        HealthPermission.getReadPermission(StepsRecord::class) to "steps"
    )
    private var requesting = false

    private fun available(): Boolean = Build.VERSION.SDK_INT >= 28 &&
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    @PluginMethod
    fun status(call: PluginCall) {
        scope.launch {
            try {
                val isAvailable = available()
                val response = JSObject()
                response.put("available", isAvailable)
                response.put("provider", "health-connect")
                if (isAvailable) {
                    val granted = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
                    response.put("granted", JSArray(metrics.filterKeys { it in granted }.values.toList()))
                } else {
                    response.put("reason", "需要 Android 9+ 且 Health Connect 已安装或可用")
                }
                call.resolve(response)
            } catch (error: Exception) { call.reject("无法确认健康权限", "PERMISSION_ERROR", error) }
        }
    }

    @PluginMethod
    fun requestAccess(call: PluginCall) {
        if (!available()) { call.reject("Health Connect 不可用", "UNAVAILABLE"); return }
        if (requesting) { call.reject("正在请求授权", "BUSY"); return }
        requesting = true
        try {
            val contract = PermissionController.createRequestPermissionResultContract()
            startActivityForResult(call, contract.createIntent(context, metrics.keys), "accessResult")
        } catch (error: Exception) {
            requesting = false
            call.reject("无法打开健康授权页面", "PERMISSION_ERROR", error)
        }
    }

    @ActivityCallback
    private fun accessResult(call: PluginCall?, result: ActivityResult) {
        requesting = false
        if (call == null) return
        scope.launch {
            try {
                val granted = HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()
                val response = JSObject()
                response.put("requested", true)
                response.put("granted", JSArray(metrics.filterKeys { it in granted }.values.toList()))
                call.resolve(response)
            } catch (error: Exception) { call.reject("无法确认健康权限", "PERMISSION_ERROR", error) }
        }
    }

    private suspend fun <RecordType : Record> readType(
        client: HealthConnectClient, recordType: KClass<RecordType>, range: TimeRangeFilter,
        consume: (RecordType) -> Unit
    ): Boolean {
        var token: String? = null
        var count = 0
        do {
            val response = client.readRecords(ReadRecordsRequest(recordType, range, pageSize = 500, pageToken = token))
            response.records.forEach(consume)
            count += response.records.size
            token = response.pageToken
        } while (token != null && count < 5_000)
        return token != null
    }

    @PluginMethod
    fun readSamples(call: PluginCall) {
        if (!available()) { call.reject("Health Connect 不可用", "UNAVAILABLE"); return }
        scope.launch {
            try {
                val from = Instant.parse(call.getString("from"))
                val to = Instant.parse(call.getString("to"))
                require(from < to && Duration.between(from, to) <= Duration.ofDays(1))
                require(to <= Instant.now().plusSeconds(60))
                val client = HealthConnectClient.getOrCreate(context)
                val granted = client.permissionController.getGrantedPermissions()
                if (metrics.keys.none { it in granted }) { call.reject("尚未授权读取健康数据", "PERMISSION_DENIED"); return@launch }
                val samples = JSArray()
                var truncated = false
                fun append(record: Record, metric: String, value: Number, timestamp: Instant, end: Instant? = null) {
                    if (record.metadata.recordingMethod == Metadata.RECORDING_METHOD_MANUAL_ENTRY) return
                    if (samples.length() >= 15_000) { truncated = true; return }
                    if (timestamp < from || timestamp > to || (end != null && end > to)) return
                    val sample = JSObject()
                    sample.put("id", record.metadata.id)
                    sample.put("metric", metric)
                    sample.put("value", value)
                    sample.put("timestamp", timestamp.toString())
                    if (end != null) sample.put("endTimestamp", end.toString())
                    val origin = record.metadata.dataOrigin.packageName
                    sample.put("originId", origin)
                    sample.put("originName", origin)
                    sample.put("provider", "health-connect")
                    samples.put(sample)
                }
                val range = TimeRangeFilter.between(from, to)
                if (HealthPermission.getReadPermission(HeartRateRecord::class) in granted) {
                    val more = readType(client, HeartRateRecord::class, range) { record ->
                        record.samples.forEach { sample -> append(record, "heartRate", sample.beatsPerMinute, sample.time) }
                    }
                    truncated = truncated || more
                }
                if (HealthPermission.getReadPermission(OxygenSaturationRecord::class) in granted) {
                    val more = readType(client, OxygenSaturationRecord::class, range) { record ->
                        append(record, "bloodOxygen", record.percentage.value, record.time)
                    }
                    truncated = truncated || more
                }
                if (HealthPermission.getReadPermission(StepsRecord::class) in granted) {
                    val more = readType(client, StepsRecord::class, range) { record ->
                        append(record, "steps", record.count, record.startTime, record.endTime)
                    }
                    truncated = truncated || more
                }
                val response = JSObject()
                response.put("samples", samples)
                response.put("truncated", truncated)
                call.resolve(response)
            } catch (error: Exception) { call.reject("读取失败：请检查权限、同步状态与时间范围", "READ_FAILED", error) }
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }
}
