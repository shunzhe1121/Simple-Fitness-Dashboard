"""启动入口。

    python run.py

监听 0.0.0.0 时会额外打印局域网地址，手机连同一 WiFi 直接用该地址访问，
就能完成「拍照 → 豆包识图 → 复制 → 粘贴入库」的完整流程。
"""

from __future__ import annotations

import socket

import uvicorn

from app import config, db


def lan_ip() -> str | None:
    """探测本机局域网地址。

    连一个外部地址但不真的发包，靠系统路由表选出对外网卡的 IP。
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("223.5.5.5", 80))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def banner() -> None:
    """打印访问地址与配置状态。"""
    print("\n  健身记录助手")
    print("  " + "-" * 46)
    print(f"  本机访问    http://127.0.0.1:{config.PORT}")

    if config.HOST == "0.0.0.0":
        address = lan_ip()
        if address:
            print(f"  手机访问    http://{address}:{config.PORT}   （需同一 WiFi）")
        else:
            print("  手机访问    未能探测到局域网地址")

    print(f"  接口文档    http://127.0.0.1:{config.PORT}/docs")
    print(f"  数据文件    {config.DB_PATH}")

    if config.llm_configured():
        print(f"  LLM         已配置（{config.LLM_MODEL}）")
    else:
        print("  LLM         未配置，对话功能暂不可用")
        print("              在 .env 里填 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL")
    print("  " + "-" * 46 + "\n")


def main() -> None:
    db.init_db()
    banner()
    uvicorn.run(
        "app.api:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
