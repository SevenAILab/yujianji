import Capacitor

@objc(YujianjiOscPlugin)
public class YujianjiOscPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "YujianjiOscPlugin"
    public let jsName = "YujianjiOsc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise)
    ]

    @objc func execute(_ call: CAPPluginCall) {
        guard let urlText = call.getString("url"), let url = URL(string: urlText) else {
            call.reject("缺少 OSC 请求地址", "INVALID_URL")
            return
        }
        let body = call.getString("body") ?? ""
        let timeoutMs = call.getInt("timeoutMs") ?? 20000
        var request = URLRequest(url: url, timeoutInterval: TimeInterval(timeoutMs) / 1000)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body.data(using: .utf8)

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                call.reject(error.localizedDescription, "OSC_ERROR", error)
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            call.resolve(["status": status, "body": text, "ok": (200..<300).contains(status)])
        }.resume()
    }
}
