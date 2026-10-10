"""佳明一次性登录（含 MFA 短信验证码）。

流程：
1. 先尝试用本地 token 恢复会话，成功即退出；
2. 账密登录触发 Garmin 下发验证码（发到账号绑定的手机/邮箱）；
3. 轮询 /tmp/garmin_mfa_code.txt，把用户提供的验证码写进该文件即可；
4. 完成登录后 token 缓存到 data/garmin_tokens/，日常同步不再需要验证码。

用法：.venv/Scripts/python.exe scripts/garmin_login.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import garth.sso

from app import config, garmin

CODE_FILE = Path("/tmp/garmin_mfa_code.txt")


def main() -> int:
    email = config.GARMIN_EMAIL
    password = config.GARMIN_PASSWORD
    if not email or not password:
        print("缺少 GARMIN_EMAIL / GARMIN_PASSWORD（.env）")
        return 1

    from app import garmin

    client = garmin._client()
    token_dir = garmin.TOKEN_DIR
    token_dir.mkdir(parents=True, exist_ok=True)

    try:
        client.load(str(token_dir))
        print("本地 token 有效，无需重新登录")
        return 0
    except Exception:
        pass

    client.domain = "garmin.cn"
    CODE_FILE.unlink(missing_ok=True)
    print("正在登录，验证码将发送到佳明账号绑定的手机/邮箱…", flush=True)
    result = client.login(email, password, return_on_mfa=True)
    if result[0] != "needs_mfa":
        client.dump(str(token_dir))
        print("登录成功（未要求 MFA），token 已缓存")
        return 0

    client_state = result[1]
    print(f"验证码已发送（方式：{client_state.get('mfa_method', 'sms')}）")
    print(f"收到验证码后，把 6 位数字写入文件：{CODE_FILE}", flush=True)

    deadline = time.time() + 600
    while time.time() < deadline:
        if CODE_FILE.exists():
            code = CODE_FILE.read_text(encoding="utf-8").strip()
            if code:
                print(f"使用验证码 {code} 完成登录…", flush=True)
                client.resume_login(client_state, code)
                client.dump(str(token_dir))
                print("登录成功，token 已缓存，以后同步不再需要验证码")
                return 0
        time.sleep(3)

    print("10 分钟内未收到验证码文件，退出")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
