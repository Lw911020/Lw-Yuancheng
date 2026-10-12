#!/usr/bin/env python3
"""params_dump.py v2 — 全量参数注册表 / 当前值 / 中文说明 / 分组（CP · SP · 官方 通吃）

2026-09-24 v2（SP2025 实机适配后重写）。适配原则：
  1) 键集合优先问运行时 Params().all_keys()（权威），不假设某个头文件存在；
  2) 参数目录不再写死：候选 = $PARAMS_DIR → /data/params/d_sp → /data/params/d，取条目最多的那个。
     （SP2025 实测：/data/params/d 只有 5 项，活库是 d_sp → /data/params/.tmp_XXXX）
  3) 取值兼容新旧 API（旧版 Params.get(k, encoding=...) / 新版不接受 encoding 关键字）；
  4) 中文名与分组：CP/官方读 selfdrive/ui/qt/offroad/settings.cc；
     SP2025 读 selfdrive/ui/layouts/settings/*.py + translations/main_zh-CHS.ts；
  5) 每一段独立 try：某段失败只丢那一段，其它照给（页面降级，绝不整页报错）。
  6) 写回优先用 Params().put()（任何 fork 都对），失败才回退直接写活库文件。

输出（单行 JSON）：registry / values / meta / defaults / groups / groupOrder / env
"""
import glob
import json
import os
import re
import sys

OP = '/data/openpilot'
sys.path.insert(0, OP)

_PARAM_CANDIDATES = [os.environ.get('PARAMS_DIR'), '/data/params/d_sp', '/data/params/d']
SETTINGS_CC = os.path.join(OP, 'selfdrive/ui/qt/offroad/settings.cc')
MANAGER_PY = os.path.join(OP, 'system/manager/manager.py')
CARROT_CFG = os.path.join(OP, 'selfdrive/carrot/config.py')
NAV_JSON = os.path.join(OP, 'selfdrive/carrot/nav_params.json')
SP_SETTINGS_DIR = os.path.join(OP, 'selfdrive/ui/layouts/settings')
SP_TS = os.path.join(OP, 'selfdrive/ui/translations/main_zh-CHS.ts')


def param_dir():
    best, best_n = None, -1
    for d in _PARAM_CANDIDATES:
        if not d:
            continue
        try:
            n = len(os.listdir(d))
        except Exception:
            continue
        if n > best_n:
            best, best_n = d, n
    return best or '/data/params/d'


PARAM_DIR = param_dir()


def P_obj():
    try:
        from openpilot.common.params import Params
        return Params()
    except Exception:
        return None


def norm(v):
    """SP2025 的 Params.get() 返回原生类型（int/float/bool/datetime/dict），
    老版本返回 bytes？统一归一成字符串，让页面与默认值比对的行为跨 fork 一致。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return '1' if v else '0'
    if isinstance(v, bytes):
        return v.decode('utf-8', 'replace')
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list, tuple)):
        try:
            return json.dumps(v, ensure_ascii=False)
        except Exception:
            return str(v)
    try:
        return v.isoformat()   # datetime / date
    except Exception:
        return str(v)


def P_get(P, k):
    for kw in ({'encoding': 'utf-8'}, {}):
        try:
            v = P.get(k, **kw)
        except Exception:
            continue
        return norm(v)
    return None


def all_names(P):
    out = []
    try:
        for k in (P.all_keys() if P else []):
            out.append(k.decode('utf-8', 'replace') if isinstance(k, bytes) else str(k))
    except Exception:
        pass
    try:
        for k in os.listdir(PARAM_DIR):
            out.append(k)
    except Exception:
        pass
    return sorted(set(out))


def _op_python():
    """找 openpilot 自己的解释器（**必须能 import capnp**）。
    坑（2026-09-24 实测）：不能只看 /proc/<pid>/exe —— 它会把符号链接解析掉，
    venv 路径（/usr/local/venv/bin/python3）被解析成 /usr/bin/python3.12，venv 就丢了 ✗，
    结果拿到一个没有 capnp 的解释器，注册表/服务全都降级。
    正确做法：① 读运行进程 cmdline 的 argv[0]（venv 路径只出现在这）
              ② 固定位置 + pyenv
              ③ **逐个试 import capnp**，选第一个真能用的 ✓"""
    import glob as _g
    import subprocess as _sp
    cands = []
    try:
        out = _sp.check_output(['sh', '-c',
            'for p in $(pgrep -f manager.py | head -3); do tr "\0" "\n" < /proc/$p/cmdline | head -1; done'],
            stderr=_sp.DEVNULL, timeout=6)
        for line in out.decode('utf-8', 'replace').split():
            if 'python' in line:
                cands.append(line)
    except Exception:
        pass
    cands += ['/usr/local/venv/bin/python3', '/data/openpilot/.venv/bin/python3']
    try:
        cands += sorted(_g.glob('/usr/local/pyenv/versions/*/bin/python3*'), reverse=True)
    except Exception:
        pass
    cands += ['/usr/local/pyenv/shims/python3', '/usr/bin/python3']
    seen = set()
    for c in cands:
        if c in seen or not (os.path.isfile(c) and os.access(c, os.X_OK)):
            continue
        seen.add(c)
        try:
            _sp.check_call([c, '-c', 'import capnp'], stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, timeout=12)
            return c
        except Exception:
            continue
    return None
_op_py = _op_python()
_op_py = _op_python()  # 动态解析（pyenv / venv / 运行时 manager）
VENV_CANDIDATES = ((_op_py,) if _op_py else ('/usr/local/venv/bin/python3', '/data/openpilot/.venv/bin/python3'))


def _reexec_with_venv():
    """APP 是用系统 python3 跑本脚本的（那里面没有 capnp）→ 拿不到运行时注册表，
    实测会从 276 键退化成 149 键（只剩参数目录里存过的）。
    这里自我重入到 openpilot 的 venv，保证不管谁调用结果都一样（与 live_stream.py 同款做法）。"""
    if os.environ.get('DSH_PARAMS_REEXEC') == '1':
        return
    try:
        import capnp  # noqa: F401
        return
    except Exception:
        pass
    for cand in VENV_CANDIDATES:
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            os.environ['DSH_PARAMS_REEXEC'] = '1'
            os.execv(cand, [cand] + sys.argv)


_reexec_with_venv()

NOTES_CANDIDATES = [os.path.join(os.path.dirname(os.path.abspath(__file__)), 'param-notes-zh.json'),
                    '/data/openpilot/.dsh/param-notes-zh.json']


def notes():
    """随 APP 发布的中文备注词库（设备端本身没有说明时用它兜底，SP2025 全靠它）。
    设备上能解析出来的（settings.cc / layouts/settings/*.py）优先，词库只补空缺。"""
    for p in NOTES_CANDIDATES:
        try:
            d = json.load(open(p, encoding='utf-8'))
            if isinstance(d, dict) and d:
                return d
        except Exception:
            continue
    return {}


def fork():
    """fork 判定要认三种布局（2026-09-24 实测）：
    CP = selfdrive/carrot · SP 新版 = 顶层 sunnypilot/ · SP 老版(0.9.8) = selfdrive/sunnypilot/ 或 build.json 里源是 sunnypilot"""
    f = []
    if os.path.isdir(os.path.join(OP, 'selfdrive/carrot')):
        f.append('CP')
    origin = ''
    try:
        origin = (op_version().get('origin') or '').lower()
    except Exception:
        pass
    # 注意：Carrot(CP) 的 build.json 源**也是** sunnypilot（它基于 SP 改的）→
    # 有 carrot/frogpilot 目录时不能再叠加 SP（否则显示成 CP+SP ✗，2026-09-24 实测）
    sp_dir = (os.path.isdir(os.path.join(OP, 'sunnypilot'))
              or os.path.isdir(os.path.join(OP, 'selfdrive/sunnypilot')))
    if sp_dir or (not f and 'sunnypilot' in origin):
        f.append('SP')
    return '+'.join(f) or 'OP'


def op_version():
    try:
        b = json.load(open(os.path.join(OP, 'build.json'), encoding='utf-8'))
        o = b.get('openpilot', {})
        return {'version': o.get('version', ''), 'channel': b.get('channel', ''),
                'origin': o.get('git_origin', ''), 'style': o.get('build_style', '')}
    except Exception:
        return {}


# ── 注册表 ───────────────────────────────────────────────────────────────
def registry(P):
    """键 + flags：优先 params_keys.h（CP/官方）；没有就用运行时键表（SP2025 实测就是这样）。"""
    out = []
    try:
        txt = open(os.path.join(OP, 'common/params_keys.h'), encoding='utf-8', errors='replace').read()
        for m in re.finditer(r'\{\s*"([^"]+)"\s*,\s*([^}]+)\}', txt):
            out.append({'name': m.group(1), 'flags': m.group(2).strip()})
    except Exception:
        pass
    if out:
        return out, 'params_keys.h'
    return [{'name': k, 'flags': ''} for k in all_names(P)], 'runtime.all_keys'


def values(P, names):
    out = {}
    if P is not None:
        ok = 0
        for k in names:
            v = P_get(P, k)
            out[k] = v
            if v is not None:
                ok += 1
        if ok:
            return out
    for k in names:
        for d in (PARAM_DIR, '/data/params/d'):
            try:
                out[k] = open(os.path.join(d, k), encoding='utf-8', errors='replace').read()
                break
            except Exception:
                out.setdefault(k, None)
    return out


# ── 中文名 / 分组：CP（settings.cc） ─────────────────────────────────────
def cc_meta_groups():
    meta, groups, order = {}, {}, []
    try:
        txt = open(SETTINGS_CC, encoding='utf-8', errors='replace').read()
    except Exception:
        return meta, groups, order
    try:
        pat = re.compile(r'\("([A-Za-z0-9_]+)"\s*,\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"((?:[^"\\]|\\.)*)")?')
        for m in pat.finditer(txt):
            name, title, desc = m.group(1), m.group(2), m.group(3) or ''
            if name and (title or desc):
                meta.setdefault(name, {'title': title.replace('\\"', '"'), 'desc': desc.replace('\\"', '"')})
    except Exception:
        pass
    try:
        varmap = {}
        for line in txt.splitlines():
            if '= new' in line:
                m = re.search(r'\b(\w+)\s*=\s*new\b[^("]*\(\s*"([A-Za-z0-9_]+)"', line)
                if m:
                    varmap[m.group(1)] = m.group(2)
        names = {}
        for m in re.finditer(r'QPushButton\*\s*(\w+)_btn\s*=\s*new QPushButton\(tr\("([^"]+)"\)\)', txt):
            names[m.group(1)] = m.group(2)
        idx2var = {}
        for m in re.finditer(r'(\w+)Toggles->setVisible\(widgetIndex\s*==\s*(\d+)\)', txt):
            idx2var[int(m.group(2))] = m.group(1)
        for i in sorted(idx2var):
            v = idx2var[i]
            label = names.get(v) or names.get(v.lower()) or v
            order.append(label)
            for m in re.finditer(v + r'Toggles->addItem\(new\s+[A-Za-z_:<>]+\s*\(\s*"([A-Za-z0-9_]+)"', txt):
                groups[m.group(1)] = label
            for m in re.finditer(v + r'Toggles->addItem\(\s*(\w+)\s*\)', txt):
                key = varmap.get(m.group(1))
                if key:
                    groups[key] = label
    except Exception:
        pass
    return meta, groups, order


# ── 中文名 / 分组：SP2025（layouts/settings/*.py + 中文 .ts） ────────────
def zh_map():
    out = {}
    try:
        txt = open(SP_TS, encoding='utf-8', errors='replace').read()
        for m in re.finditer(r'<source>(.*?)</source>\s*<translation[^>]*>(.*?)</translation>', txt, re.S):
            src, zh = m.group(1).strip(), m.group(2).strip()
            if src and zh and zh.lower() != 'unfinished':
                out.setdefault(src, zh)
    except Exception:
        pass
    return out


SP_PANEL_ZH = {'toggles': '开关', 'device': '设备', 'software': '软件',
               'firehose': 'Firehose', 'developer': '开发者'}


def sp_meta_groups(known=None):
    """SP2025：设置界面是 Python（selfdrive/ui/layouts/settings/*.py）。
    做法：把这些文件里的字符串字面量与「注册表真实键」求交 → 命中即认为该键属于本页；
    命中处向前最近的另一个字符串就是它的标题；说明取自同文件的 DESCRIPTIONS 字典；
    最后用 translations/main_zh-CHS.ts 把英文标题/说明换成中文。"""
    meta, groups, order = {}, {}, []
    known = set(known or [])
    zh = zh_map()
    files = sorted(glob.glob(os.path.join(SP_SETTINGS_DIR, '*.py')))
    files += sorted(glob.glob(os.path.join(OP, 'selfdrive/ui/sunnypilot/**/*.py'), recursive=True))
    for fp in files:
        base = os.path.basename(fp)[:-3]
        if base == 'settings':
            continue
        panel = SP_PANEL_ZH.get(base, 'SunnyPilot' if 'sunnypilot' in fp else base)
        try:
            txt = open(fp, encoding='utf-8', errors='replace').read()
        except Exception:
            continue
        if panel not in order:
            order.append(panel)
        lits = [(m.start(), m.group(1)) for m in re.finditer(r'"([^"]{2,140})"', txt)]
        keys_here = [(pos, lit) for pos, lit in lits if lit in known]
        for pos, k in keys_here:
            groups.setdefault(k, panel)
        for pos, k in keys_here:
            prev = [t for (p2, t) in lits if p2 < pos and (pos - p2) <= 150 and t not in known
                    and ' ' in t and 3 <= len(t) <= 40 and 'http' not in t and '%' not in t
                    and ':' not in t and not t.endswith('.') and not t.endswith('!')
                    and not t.endswith(('.png', '.jpg', '.svg'))]
            if prev and 'title' not in meta.get(k, {}):
                meta.setdefault(k, {})['title'] = prev[-1]
        for m in re.finditer(r'"([A-Za-z0-9_]+)"[ ]*:[ ]*[(]?[ ]*"([^"]{4,})"', txt):
            k, d = m.group(1), m.group(2)
            if k in known or k in meta:
                meta.setdefault(k, {})['desc'] = d
        for k, v in meta.items():
            for field in ('title', 'desc'):
                val = v.get(field)
                if val and val in zh:
                    v[field] = zh[val]
    return meta, groups, order


_HEUR_GROUPS = (('Byd', 'BYD'), ('Sunnylink', 'Sunnylink'), ('CustomAcc', 'SunnyPilot'),
                ('SpeedLimit', 'SunnyPilot'), ('MapTarget', 'SunnyPilot'), ('SmartCruise', 'SunnyPilot'),
                ('Alpha', 'SunnyPilot'), ('Blinker', 'SunnyPilot'), ('SP', 'SunnyPilot'))


def heur_group(k):
    """设备端设置界面没覆盖到的键 → 按命名规则给个兜底分类（诚实叫「未分类」而不是假装是设备分类）。"""
    for pre, name in _HEUR_GROUPS:
        if k.startswith(pre) or k.endswith(pre):
            return name
    return '未分类'


def meta_groups(known=None):
    m, g, o = cc_meta_groups()
    if m or g:
        return m, g, o, 'settings.cc'
    m, g, o = sp_meta_groups(known)
    if known:
        for k in known:
            if k not in g:
                g[k] = heur_group(k)
                if g[k] not in o:
                    o.append(g[k])
    if m or g:
        return m, g, o, 'layouts/settings/*.py + zh.ts + 命名兜底'
    return {}, {}, [], 'none'


def defaults():
    """默认值表：manager.py（元组表）+ carrot/config.py + nav_params.json（有才读）。"""
    out = {}
    for path in (MANAGER_PY, CARROT_CFG, NAV_JSON):
        try:
            txt = open(path, encoding='utf-8', errors='replace').read()
        except Exception:
            continue
        for m in re.finditer(r'\(\s*"([A-Za-z0-9_]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)', txt):
            out.setdefault(m.group(1), m.group(2))
        for m in re.finditer(r'"([A-Za-z0-9_]+)"\s*:\s*(-?\d+(?:\.\d+)?|true|false|"[^"]*")', txt):
            k, v = m.group(1), m.group(2)
            if v == 'true':
                v = '1'
            elif v == 'false':
                v = '0'
            out.setdefault(k, v.strip('"'))
    return out


def main():
    P = P_obj()
    names = all_names(P)
    reg, reg_src = registry(P)
    meta, groups, order, meta_src = meta_groups(names)
    # 2026-09-24：设备端没有说明时用随 APP 发布的中文词库兜底（SP2025 上设备端只覆盖约 25 个参数）
    nm = notes()
    filled = 0
    for k, v in nm.items():
        cur = meta.setdefault(k, {})
        if not cur.get('title'):
            cur['title'] = v.get('title', '')
        if not cur.get('desc'):
            cur['desc'] = v.get('desc', '')
        if cur.get('title') or cur.get('desc'):
            filled += 1
    if nm:
        meta_src = meta_src + ' + 内置词库(%d)' % len(nm)
    # 2026-09-24 用户反馈「太多无用参数」→ 按词库的 kind 分层：
    #   user=常用可调 · danger=动作型(写入即执行,危险) · internal=内部状态(不用手改)
    # 分组也重排：设备原生分组优先，其余按 kind 归到「常用可调 / 动作型（危险） / 内部状态（不用手改）」，
    # 页面默认只显示常用（一个开关可以展开内部）。
    _kinds = {}
    for k, v in nm.items():
        kd = v.get('kind')
        if not kd:
            continue
        _kinds[k] = kd
        cur = meta.setdefault(k, {})
        cur['kind'] = kd
    if _kinds:
        for k in names:
            kd = _kinds.get(k)
            if kd == 'internal':
                groups[k] = '内部状态（不用手改）'
            elif kd == 'danger':
                groups[k] = '动作型（危险）'
            elif k not in groups or groups.get(k) == '未分类':
                groups[k] = '常用可调'   # 旧的命名兜底给的是「未分类」→ 归到常用可调
        for gname in ('常用可调', '动作型（危险）', '内部状态（不用手改）'):
            if gname not in order:
                order.append(gname)
        meta_src = meta_src + ' / 分层' 
    print(json.dumps({
        'ok': True,
        'registry': reg,
        'values': values(P, names),
        'meta': meta,
        'defaults': defaults(),
        'groups': groups,
        'groupOrder': order,
        'env': {'fork': fork(), 'paramDir': PARAM_DIR, 'params': len(names),
                'registrySource': reg_src, 'metaSource': meta_src, 'openpilot': op_version()},
    }, ensure_ascii=False, default=str))


def set_params(pairs):
    P = P_obj()
    applied, errors = 0, []
    for k, v in pairs:
        done = False
        if P is not None:
            try:
                P.put(k, v)
                done = True
            except Exception:
                pass
        if not done:
            try:
                with open(os.path.join(PARAM_DIR, k), 'w') as fh:
                    fh.write(v)
                done = True
            except Exception as e:
                errors.append(k + ': ' + str(e))
        if done:
            applied += 1
    print(json.dumps({'ok': not errors, 'applied': applied, 'errors': errors,
                      'paramDir': PARAM_DIR}, ensure_ascii=False, default=str))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'set':
        ps = []
        for a in sys.argv[2:]:
            if '=' in a:
                k, v = a.split('=', 1)
                ps.append((k, v))
        set_params(ps)
    else:
        main()