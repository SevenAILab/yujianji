import Capacitor
import HealthKit

@objc(YujianjiHealthPlugin)
public class YujianjiHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "YujianjiHealthPlugin"
    public let jsName = "YujianjiHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSamples", returnType: CAPPluginReturnPromise)
    ]
    private let store = HKHealthStore()
    private let sampleTypes: [(HKQuantityTypeIdentifier, String, HKUnit)] = [
        (.heartRate, "heartRate", HKUnit.count().unitDivided(by: .minute())),
        (.oxygenSaturation, "bloodOxygen", .percent()),
        (.stepCount, "steps", .count())
    ]

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable(), "provider": "healthkit"])
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("此设备无法使用 HealthKit", "UNAVAILABLE")
            return
        }
        let types = Set<HKObjectType>(sampleTypes.compactMap { HKQuantityType.quantityType(forIdentifier: $0.0) })
        store.requestAuthorization(toShare: [], read: types) { success, error in
            if let error = error { call.reject("无法打开健康授权", "PERMISSION_ERROR", error); return }
            call.resolve(["requested": success, "granted": NSNull()])
        }
    }

    private func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    @objc func readSamples(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else { call.reject("HealthKit 不可用", "UNAVAILABLE"); return }
        guard let fromText = call.getString("from"), let toText = call.getString("to"),
              let from = parseDate(fromText), let to = parseDate(toText),
              from < to, to.timeIntervalSince(from) <= 86400,
              to <= Date().addingTimeInterval(60) else {
            call.reject("每次同步范围必须在 24 小时以内", "INVALID_RANGE")
            return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var samples: [[String: Any]] = []
        var firstError: Error?
        var truncated = false
        let predicate = HKQuery.predicateForSamples(withStart: from, end: to, options: [.strictStartDate, .strictEndDate])
        for (identifier, metric, unit) in sampleTypes {
            guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { continue }
            group.enter()
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: 5001,
                                      sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]) { _, result, error in
                let formatter = ISO8601DateFormatter()
                let quantities = (result as? [HKQuantitySample]) ?? []
                let mapped: [[String: Any]] = quantities.prefix(5000).filter { $0.metadata?[HKMetadataKeyWasUserEntered] as? Bool != true }.map { sample in
                    let source = sample.sourceRevision.source
                    var row: [String: Any] = [
                        "id": sample.uuid.uuidString,
                        "metric": metric,
                        "value": sample.quantity.doubleValue(for: unit) * (metric == "bloodOxygen" ? 100 : 1),
                        "timestamp": formatter.string(from: sample.startDate),
                        "originId": source.bundleIdentifier,
                        "originName": source.name,
                        "provider": "healthkit"
                    ]
                    if metric == "steps" { row["endTimestamp"] = formatter.string(from: sample.endDate) }
                    return row
                }
                lock.lock()
                samples.append(contentsOf: mapped)
                truncated = truncated || quantities.count > 5000
                if let error = error { firstError = firstError ?? error }
                lock.unlock()
                group.leave()
            }
            store.execute(query)
        }
        group.notify(queue: .main) {
            if let error = firstError { call.reject("健康数据读取失败", "READ_FAILED", error); return }
            call.resolve(["samples": samples, "truncated": truncated])
        }
    }
}

@objc(HealthBridgeViewController)
class HealthBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(YujianjiHealthPlugin())
        bridge?.registerPluginInstance(YujianjiOscPlugin())
    }
}
