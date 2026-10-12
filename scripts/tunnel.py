"""用 Cloudflare 临时隧道把本机服务映射到公网。

    python scripts/tunnel.py

不需要域名，也不需要 Cloudflare 账号，cloudflared 会分配一个
https://xxx.trycloudflare.com 地址。代价是**每次重启地址都会变**，
所以手机加桌面图标后如果打不开，重跑一次、用新地址再加一次即可。

想固定地址就得有自己的域名走 named tunnel，见 README-CN.md。
"""

from __future__ import annotations

import re
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from app import config  # noqa: E402

# cloudflared 输出的地址形如 https://random-words-1234.trycloudflare.com
URL_RE = re.compile(r"https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com")

DOWNLOAD_URL = (
    "https://github.com/cloudflare/cloudflared/releases/latest/download/"
    "cloudflared-windows-amd64.exe"
)


def find_cloudflared() -> Path | None:
    """按常见位置查找 cloudflared 可执行文件。"""
    candidates = [
        BASE_DIR / "tools" / "cloudflared.exe",
        BASE_DIR / "tools" / "cloudflared",
        Path.home() / ".cloudflared" / "cloudflared.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def download_cloudflared() -> Path | None:
    """没装就下载一份到 tools/ 目录，让脚本开箱可用。"""
    target = BASE_DIR / "tools" / "cloudflared.exe"
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  未找到 cloudflared，正在下载到 {target}")
    print("  文件约 53 MB，取决于网速可能要等一会儿…")
    try:
        with urllib.request.urlopen(DOWNLOAD_URL, timeout=600) as response:
            target.write_bytes(response.read())
    except Exception as error:  # noqa: BLE001 — 网络问题种类多，统一提示
        print(f"  下载失败：{error}")
        print(f"  可以手动下载后放到 {target}")
        return None
    print("  下载完成。\n")
    return target


def main() -> int:
    binary = find_cloudflared() or download_cloudflared()
    if not binary:
        return 1

    target = f"http://127.0.0.1:{config.PORT}"
    token = config.ensure_access_token() if config.access_enabled() else config.ACCESS_TOKEN

    print(f"  为 {target} 申请临时隧道…")
    print("  保持本窗口开着，关掉即断开。\n")

    process = subprocess.Popen(
        [str(binary), "tunnel", "--url", target, "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    announced = False
    try:
        for line in process.stdout:  # type: ignore[union-attr]
            match = URL_RE.search(line)
            if match and not announced:
                announced = True
                link = match.group(0)
                print("=" * 58)
                print(f"  公网地址    {link}")
                if token and token.lower() != "off":
                    print(f"  手机入口    {link}/?k={token}")
                    print("\n  手机用「手机入口」打开一次，之后凭 cookie 免输。")
                else:
                    print("\n  未开启访问令牌（ACCESS_TOKEN=off），任何拿到地址的人都能进。")
                print("=" * 58)
                print("\n  这个地址重启后会变。手机加过桌面图标的话，")
                print("  换新地址后需要重新「添加到主屏幕」一次。\n")
            elif not match and ("ERR" in line or "WRN" in line):
                print("  " + line.strip())
    except KeyboardInterrupt:
        print("\n  正在关闭隧道…")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
