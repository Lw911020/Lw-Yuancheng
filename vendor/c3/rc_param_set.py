#!/usr/bin/env python3
# rc_param_set.py —— 写一个 openpilot 参数：优先 Params().put()，失败才回退直接写活库文件
# 用法: python3 rc_param_set.py <KEY> <base64(值)>
import sys, os, base64, json
sys.path.insert(0, '/data/openpilot')

def live_dir():
    best, best_n = None, -1
    for d in [os.environ.get('PARAMS_DIR'), '/data/params/d_sp', '/data/params/d']:
        if not d:
            continue
        try:
            n = len(os.listdir(d))
        except Exception:
            continue
        if n > best_n:
            best, best_n = d, n
    return best or '/data/params/d'

def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': '用法: rc_param_set.py KEY base64(值)'}))
        return 1
    key = sys.argv[1]
    try:
        val = base64.b64decode(sys.argv[2]).decode('utf-8')
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '值解码失败: ' + str(e)}))
        return 1

    # 1) 官方接口（任何分支都对）
    try:
        from openpilot.common.params import Params
        p = Params()
        try:
            p.put(key, val)
        except TypeError:
            p.put(key, val.encode())
        cur = p.get(key)
        if isinstance(cur, bytes):
            cur = cur.decode('utf-8', 'replace')
        print(json.dumps({'ok': True, 'key': key, 'value': cur, 'via': 'Params().put'}))
        return 0
    except Exception as e:
        first = str(e)

    # 2) 回退：直接写活库文件
    try:
        d = live_dir()
        with open(os.path.join(d, key), 'wb') as f:
            f.write(val.encode('utf-8'))
        print(json.dumps({'ok': True, 'key': key, 'value': val, 'via': 'file:' + d, 'note': first[:120]}))
        return 0
    except Exception as e2:
        print(json.dumps({'ok': False, 'error': first[:160] + ' / ' + str(e2)[:160]}))
        return 1

sys.exit(main())
