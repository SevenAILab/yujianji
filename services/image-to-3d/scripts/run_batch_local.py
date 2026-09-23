"""Load local .env, start a temporary API server, run the Encounter batch, stop server."""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv


def main():
    load_dotenv(Path.cwd() / ".env", override=False)
    if not os.getenv("TRIPO_API_KEY"):
        raise SystemExit("未找到 TRIPO_API_KEY；请配置项目 .env 或进程环境变量")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    log_path = Path(".pipeline") / "local-server.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
             "--port", str(port)], stdout=log, stderr=subprocess.STDOUT,
            creationflags=flags, env=os.environ.copy())
        try:
            with httpx.Client(timeout=1) as client:
                for _ in range(60):
                    if server.poll() is not None:
                        raise RuntimeError(f"本地 API 服务启动失败；查看 {log_path}")
                    try:
                        if client.get(base + "/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.5)
                else:
                    raise RuntimeError(f"本地 API 服务未就绪；查看 {log_path}")
            print(f"本地 API 服务就绪：{base}", flush=True)
            return subprocess.call([sys.executable, "-m", "scripts.pipeline.batch",
                                    "--api-url", base, *sys.argv[1:]], env=os.environ.copy())
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    raise SystemExit(main())
