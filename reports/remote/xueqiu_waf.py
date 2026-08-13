#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
雪球(xueqiu.com) 阿里云 WAF 反爬层 —— acw_sc__v2 独立复现模块

背景：
  雪球请求被阿里云 WAF 拦截时，会先返回一段挑战：
    - Set-Cookie 里带 acw_tc（临时票）
    - 响应体里有一段混淆 JS，调用 setCookie(arg1, arg2) 算出 acw_sc__v2
  只有把算出的 acw_sc__v2 带回第二次请求，才能拿到正常数据。
  这层与 xq_a_token 登录态无关 —— 触发后必须人工/自动过这道挑战。

本模块作用（暂未接入主流程，仅供手动验证/将来接入）：
  1. fetch_waf_challenge()  : 触发并抓取挑战页，提取 arg1 / acw_tc
  2. compute_acw_sc_v2()    : 用公开还原算法算 acw_sc__v2
  3. solve()                : 一站式拿齐 acw_tc + acw_sc__v2（完整 WAF cookie）
  4. is_waf_challenge()     : 判断一个响应是否命中阿里云反爬挑战（将来接入判据）
  5. demo()                 : 自带 __main__ 演示，不依赖主项目

算法说明：
  acw_sc__v2 由 arg1（挑战参数，来自 setCookie 第一个实参）与固定密钥
  "3000176000856006061501533003690027800375" 经字符重排+异或得到。
  这是阿里系 _0x55f3 混淆的公开已知还原逻辑，非从任何混淆源码扒取。

依赖：仅标准库 + requests（如无可 pip install requests）。
"""

import re
import sys

try:
    import requests
except ImportError:
    requests = None

# 固定密钥（阿里系 acw 算法常量）
_ACW_KEY = "3000176000856006061501533003690027800375"

# 完整浏览器 UA —— 见 MEMORY.md：裸 UA 会被 WAF 当机器人拦
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)

# 触发挑战用的入口（首页/任意需过 WAF 的页面）
_CHALLENGE_URL = "https://xueqiu.com/"
# 验证用 API（带 WAF cookie 应能正常返回 JSON）
_API_URL = "https://stock.xueqiu.com/v5/stock/quote.json?code=SH000001"


# ----------------------------------------------------------------------------
# 核心：acw_sc__v2 算法（阿里系公开还原逻辑）
# ----------------------------------------------------------------------------
def _bts(input_str: str, key: str) -> str:
    """按位异或 + 重排，还原 acw_sc__v2。

    输入 arg1 与固定 key 逐字符异或（ord 求和再 &0xff），得到中间串，
    再对中间串做字符重排（奇数位后移、偶数位前移交错）。
    """
    # 1) 逐字符异或
    xored = []
    for i, ch in enumerate(input_str):
        k = key[i % len(key)]
        v = (ord(ch) + ord(k)) & 0xFF
        xored.append(v)
    mid = "".join(chr(v) for v in xored)

    # 2) 字符重排：拆成两半交错拼回
    n = len(mid)
    half = (n + 1) // 2
    left = mid[:half]
    right = mid[half:]
    out_chars = []
    for i in range(half):
        out_chars.append(left[i])
        if i < len(right):
            out_chars.append(right[i])
    return "".join(out_chars)


def compute_acw_sc_v2(arg1: str, key: str = _ACW_KEY) -> str:
    """由挑战参数 arg1 算出 acw_sc__v2。

    真实混淆里 arg1 还会先经过一次 hash/变换（_0x55f3('0x19') 那步），
    但社区复现中多数站点 arg1 已是最终输入；这里直接对 arg1 做 bts。
    若将来实测发现差一步变换，在此前补一步即可（集中在一处）。
    """
    if not arg1:
        raise ValueError("arg1 为空，无法计算 acw_sc__v2")
    return _bts(arg1, key)


# ----------------------------------------------------------------------------
# 挑战识别
# ----------------------------------------------------------------------------
def is_waf_challenge(response_text: str, status_code: int = 200) -> bool:
    """判断响应是否命中阿里云 WAF 反爬挑战。

    命中特征（任一即判为挑战）：
      - 非 JSON 的黑名单/验证页（含 'acw_sc__v2' / 'acw_tc' / 'verify' / 'captcha'）
      - 雪球专属 'Seek IP Blacklisted' / '请完成验证'
    注意：正常 JSON 响应不算挑战。
    """
    if status_code >= 400:
        return True
    text = response_text or ""
    markers = [
        "acw_sc__v2",
        "acw_tc",
        "seek ip blacklisted",
        "请完成验证",
        "captcha",
        "verify",
        "<title>验证",
    ]
    low = text.lower()
    # 若同时像 JSON 则不是挑战
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        return False
    return any(m.lower() in low for m in markers)


# ----------------------------------------------------------------------------
# 抓取 + 求解
# ----------------------------------------------------------------------------
def fetch_waf_challenge(session: "requests.Session" = None) -> dict:
    """访问入口页，提取 acw_tc 与 arg1。

    返回 dict: {acw_tc, arg1, ok}
    """
    if requests is None:
        raise RuntimeError("需要 requests 库：pip install requests")
    s = session or requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "*/*"})

    resp = s.get(_CHALLENGE_URL, timeout=20)
    acw_tc = None
    for c in resp.cookies:
        if c.name == "acw_tc":
            acw_tc = c.value
            break
    # 兜底：从 Set-Cookie 头里抓
    if acw_tc is None:
        sc = resp.headers.get("Set-Cookie", "")
        m = re.search(r"acw_tc=([^;]+)", sc)
        if m:
            acw_tc = m.group(1)

    # 从响应体 JS 里抓 setCookie(arg1, ...) 的 arg1
    arg1 = None
    m = re.search(r"setCookie\(\s*['\"]([^'\"]+)['\"]", resp.text)
    if m:
        arg1 = m.group(1)

    return {"acw_tc": acw_tc, "arg1": arg1, "ok": bool(acw_tc and arg1)}


def solve(xq_a_token: str = "", session: "requests.Session" = None) -> dict:
    """一站式：拿到完整 WAF cookie 并用 API 验证。

    返回 dict: {acw_tc, acw_sc__v2, cookies(str), api_ok, api_status, api_head}
    """
    if requests is None:
        raise RuntimeError("需要 requests 库：pip install requests")
    s = session or requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": "https://xueqiu.com/"})

    ch = fetch_waf_challenge(s)
    result = {
        "acw_tc": ch["acw_tc"],
        "arg1": ch["arg1"],
        "acw_sc__v2": None,
        "cookies": "",
        "api_ok": False,
        "api_status": None,
        "api_head": "",
    }
    if not ch["ok"]:
        return result

    acw_sc_v2 = compute_acw_sc_v2(ch["arg1"])
    result["acw_sc__v2"] = acw_sc_v2

    cookies = f"acw_tc={ch['acw_tc']}; acw_sc__v2={acw_sc_v2}"
    if xq_a_token:
        cookies += f"; xq_a_token={xq_a_token}"
    result["cookies"] = cookies
    s.headers.update({"Cookie": cookies})

    try:
        r = s.get(_API_URL, timeout=20)
        head = r.text[:150] if r.text else ""
        result["api_status"] = r.status_code
        result["api_head"] = head
        result["api_ok"] = (r.status_code == 200) and not is_waf_challenge(
            r.text, r.status_code
        )
    except Exception as e:  # noqa
        result["api_head"] = f"REQUEST ERROR: {e}"
    return result


# ----------------------------------------------------------------------------
# 演示（不接入任何流程，手动跑：python xueqiu_waf.py）
# ----------------------------------------------------------------------------
def demo():
    if requests is None:
        print("请先安装 requests：pip install requests")
        sys.exit(1)
    token = ""  # 可在此填你的 xq_a_token 做完整验证；留空只验证 WAF 层
    print("== 触发雪球 WAF 挑战并求解 acw_sc__v2 ==")
    res = solve(xq_a_token=token)
    print(f"acw_tc      : {res['acw_tc']}")
    print(f"arg1        : {res['arg1']}")
    print(f"acw_sc__v2  : {res['acw_sc__v2']}")
    print(f"完整 cookie : {res['cookies']}")
    print(f"API status  : {res['api_status']}")
    print(f"API head    : {res['api_head']}")
    print(f"API 是否过WAF: {res['api_ok']}")


if __name__ == "__main__":
    demo()
