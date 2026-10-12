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


def banner(access_token: str | None = None) -> None:
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

    if access_token:
        print(f"  访问令牌    {access_token}")
        address = lan_ip() if config.HOST == "0.0.0.0" else None
        if address:
            print(f"  手机入口    http://{address}:{config.PORT}/?k={access_token}")
        print("              手机用「手机入口」打开一次即可，之后凭 cookie 免输")

    print(f"  接口文档    http://127.0.0.1:{config.PORT}/docs")
    print(f"  数据文件    {config.DB_PATH}")

    if config.llm_configured():
        print(f"  LLM         已配置（{config.LLM_MODEL}）")
    else:
        print("  LLM         未配置，对话功能暂不可用")
        print("              在 .env 里填 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL")
    print("  " + "-" * 46 + "\n")


def _daily_job() -> None:
    """后台每日任务：佳明同步 + 昨日日报生成。

    放在守护线程里跑，失败只打日志不影响服务启动——
    同步与日报都是幂等操作，下次启动或手动触发会补上。
    """
    import threading
    import time
    from datetime import datetime, timedelta

    def job() -> None:
        while True:
            # 每天早上 8 点后第一次检查时执行
            now = datetime.now()
            target = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
            # 起算日（config.GARMIN_SINCE）之前的日期不做任何事：既不同步，也不补日报。
            # 否则「清空历史、从今天重新开始」之后，会凭空冒出一篇空日报。
            before_start = bool(config.GARMIN_SINCE) and target < config.GARMIN_SINCE
            if now.hour >= 8 and not before_start:
                try:
                    from app import garmin, report, repository

                    if config.GARMIN_EMAIL and config.GARMIN_PASSWORD:
                        synced = garmin.sync(days=7)
                        print(
                            f"  [garmin] 同步完成"
                            f"（体重 {len(synced.get('weights') or {})} 天）"
                        )
                    if not repository.get_daily_report(target):
                        result = report.generate(target)
                        print(f"  [report] {target} 生成完成（fallback={result.get('fallback')}）")
                except Exception as error:
                    print(f"  [daily-job] 失败（明天重试）：{error}")
            # 距下次检查睡 1 小时
            time.sleep(3600)

    threading.Thread(target=job, daemon=True).start()


def main() -> None:
    db.init_db()
    # 令牌在启动时确保存在：走隧道时服务挂在公网上，这是唯一凭据
    token = config.ensure_access_token()
    banner(token if config.access_enabled() else None)
    _daily_job()
    uvicorn.run(
        "app.api:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
