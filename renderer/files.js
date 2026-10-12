'use strict';
/* 远程控制台 · 文件管理面板（C3 走 SFTP，车机/U30 走 ADB） */
(function () {
  const rc = window.rc;
  const el = window.APP ? window.APP.el : null;

  function E(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtSize(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let x = n / 1024, i = 0;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return x.toFixed(x < 10 ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(ms) {
    if (!ms || isNaN(ms)) return '-';
    const d = new Date(ms);
    const p = (x) => (x < 10 ? '0' + x : '' + x);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function j(o) { try { return JSON.stringify(o, null, 2); } catch (e) { return String(o); } }

  const SHORTCUTS = {
    c3: ['/data/openpilot', '/data/params/d', '/data/media/0/realdata', '/data', '/tmp', '/home/comma'],
    car: ['/sdcard', '/sdcard/Download', '/data/local/tmp', '/system/etc'],
    u30: ['/sdcard', '/sdcard/Download', '/data/local/tmp']
  };
  const START = { c3: '/data/openpilot', car: '/sdcard', u30: '/sdcard' };

  window.PANELS = window.PANELS || {};
  window.PANELS.files = function (pane) {
    const APP = window.APP;
    const wanted = (pane.__arg && START[pane.__arg]) ? pane.__arg : 'c3';
    const st = { targetId: wanted, path: START[wanted], recursive: false };

    const box = E('div', 'panel');
    pane.appendChild(box);
    box.appendChild(E('h2', null, '文件管理'));
    box.appendChild(E('div', 'desc', 'C3 = SFTP（结构化属性）· 车机 / U30 = ADB（ls 解析）。读取 / 修改 / 移动 / 权限 / 上传下载都在这里。'));

    const bar = E('div', 'row-flex'); bar.style.margin = '10px 0';
    const devSel = E('select', 'txt');
    (APP.state.cfg.targets || []).filter(function (t) { return t.kind === 'ssh' || t.adb; }).forEach(function (t) {
      const o = E('option', null, t.name); o.value = t.id; devSel.appendChild(o);
    });
    devSel.value = st.targetId;
    devSel.onchange = function () { st.targetId = devSel.value; st.path = START[st.targetId] || '/'; nav(st.path); };
    bar.appendChild(devSel);

    const pathInput = E('input', 'txt');
    pathInput.style.flex = '1'; pathInput.style.minWidth = '260px';
    pathInput.value = st.path;
    pathInput.onkeydown = function (e) { if (e.key === 'Enter') nav(pathInput.value); };
    bar.appendChild(pathInput);

    const btn = function (label, fn, cls) { const b = E('button', 'btn' + (cls ? ' ' + cls : ''), label); b.onclick = fn; return b; };
    bar.appendChild(btn('上级', function () { if (st.parent) nav(st.parent); }));
    bar.appendChild(btn('↻ 刷新', function () { nav(st.path); }));
    bar.appendChild(btn('上传', doUpload, 'primary'));
    bar.appendChild(btn('新建文件夹', doMkdir));
    const rec = E('label', 'badge');
    rec.style.cursor = 'pointer';
    const cb = E('input'); cb.type = 'checkbox';
    cb.onchange = function () { st.recursive = cb.checked; };
    rec.appendChild(cb); rec.appendChild(document.createTextNode(' 递归删除'));
    bar.appendChild(rec);
    box.appendChild(bar);

    const sc = E('div', 'row-flex');
    sc.style.margin = '0 0 10px';
    box.appendChild(sc);
    const status = E('div', 'desc');
    box.appendChild(status);
    const table = E('div');
    box.appendChild(table);

    function renderShortcuts() {
      sc.innerHTML = '';
      (SHORTCUTS[st.targetId] || []).forEach(function (p) {
        const b = E('button', 'btn small', p);
        b.onclick = function () { nav(p); };
        sc.appendChild(b);
      });
    }

    async function nav(p) {
      st.path = p;
      pathInput.value = p;
      status.textContent = '读取 ' + p + ' …';
      table.innerHTML = '';
      APP.setBusy('读取目录 ' + p + ' …');
      try {
        const r = await rc.filesList(st.targetId, p);
        APP.clearBusy();
        st.parent = r.parent;
        status.textContent = r.items.length + ' 项 · ' + r.path + (r.raw ? '（原始输出：' + r.raw.replace(/\n/g, ' ') + '）' : '');
        const tb = E('table', 'tbl');
        const head = E('tr');
        ['名称', '大小', '修改时间', '权限', '操作'].forEach(function (x) { head.appendChild(E('th', null, x)); });
        tb.appendChild(head);
        r.items.forEach(function (it) {
          const tr = E('tr');
          const tdN = E('td');
          const a = E('span', null, (it.dir ? '📁 ' : (it.link ? '🔗 ' : '📄 ')) + it.name);
          a.style.cursor = 'pointer';
          a.onclick = function () { it.dir ? nav((r.path === '/' ? '' : r.path) + '/' + it.name) : openEditor(it, r.path); };
          tdN.appendChild(a);
          tr.appendChild(tdN);
          tr.appendChild(E('td', null, it.dir ? '-' : fmtSize(it.size)));
          tr.appendChild(E('td', null, fmtTime(it.mtime)));
          tr.appendChild(E('td', null, it.perm || ''));
          const tdA = E('td');
          const full = (r.path === '/' ? '' : r.path) + '/' + it.name;
          if (!it.dir) {
            tdA.appendChild(btn('✎ 编辑', function () { openEditor(it, r.path); }, 'small'));
            tdA.appendChild(btn('下载', function () { download(full, it.name); }, 'small'));
          }
          tdA.appendChild(btn('移动', function () { moveTo(full, it.name); }, 'small'));
          tdA.appendChild(btn('权限', function () { chmod(full, it.mode || it.perm); }, 'small'));
          tdA.appendChild(btn('✕ 删除', function () { del(full, it.name, it.dir); }, 'small danger'));
          tr.appendChild(tdA);
          tb.appendChild(tr);
        });
        table.appendChild(tb);
      } catch (e) {
        status.textContent = '读取失败：' + APP.describeErr(e);
      } finally { APP.clearBusy(); }
    }

    async function openEditor(it, dir) {
      const full = (dir === '/' ? '' : dir) + '/' + it.name;
      status.textContent = '读取文件 ' + full + ' …';
      try {
        const f = await rc.filesRead(st.targetId, full);
        status.textContent = full + ' · ' + fmtSize(f.size) + (f.binary ? ' · 二进制' : '');
        APP.modal('编辑 · ' + it.name, function (b) {
          b.appendChild(E('div', 'desc', full + (f.binary ? '（二进制文件，不显示内容）' : '')));
          const ta = E('textarea', 'txt');
          ta.style.minHeight = '420px';
          ta.value = f.content;
          ta.disabled = !!f.binary;
          b.appendChild(ta);
          b.__get = function () { return ta.value; };
        }, async function () {}, '保存');
        const masks = document.querySelectorAll('.modal-mask');
        const mask = masks[masks.length - 1];
        const ok = mask.querySelector('.btn.primary');
        ok.textContent = '保存';
        ok.onclick = async function () {
          const content = mask.querySelector('textarea');
          if (!content || content.disabled) { mask.remove(); return; }
          try {
            await rc.filesWrite(st.targetId, full, content.value);
            mask.remove();
            status.textContent = '已保存 ' + full;
            APP.toast('已保存 ' + full);
            nav(st.path);
          } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
        };
      } catch (e) { status.textContent = '读取失败：' + APP.describeErr(e); APP.toast(APP.describeErr(e), 'fail'); }
    }

    async function moveTo(full, name) {
      APP.modal('移动 / 重命名 · ' + name, function (b) {
        b.appendChild(E('div', 'desc', '当前：' + full));
        const i = E('input', 'txt');
        i.value = full.replace(/\/[^/]+$/, '/' + name);
        b.appendChild(i);
        b.__get = function () { return i.value; };
      }, async function () {}, '移动');
      const masks = document.querySelectorAll('.modal-mask');
      const mask = masks[masks.length - 1];
      const inp = mask.querySelector('input');
      mask.querySelector('.btn.primary').onclick = async function () {
        try {
          await rc.filesMove(st.targetId, full, inp.value.trim());
          mask.remove(); APP.toast('已移动'); nav(st.path);
        } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
      };
    }

    async function chmod(full, mode) {
      APP.modal('修改权限 · ' + full, function (b) {
        b.appendChild(E('div', 'desc', '八进制权限，例如 644 / 755 / 600'));
        const i = E('input', 'txt');
        i.value = String(mode || '644').replace(/^0/, '');
        b.appendChild(i);
      }, async function () {}, '保存');
      const masks = document.querySelectorAll('.modal-mask');
      const mask = masks[masks.length - 1];
      const inp = mask.querySelector('input');
      mask.querySelector('.btn.primary').onclick = async function () {
        try {
          await rc.filesChmod(st.targetId, full, inp.value.trim());
          mask.remove(); APP.toast('权限已修改'); nav(st.path);
        } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
      };
    }

    async function del(full, name, isDir) {
      APP.modal('确认删除', function (b) {
        b.appendChild(E('div', null, '将删除：' + full));
        if (isDir) b.appendChild(E('div', 'note', '这是目录，需勾选上方"递归删除"才能删除'));
      }, async function () {}, '删除');
      const masks = document.querySelectorAll('.modal-mask');
      const mask = masks[masks.length - 1];
      const ok = mask.querySelector('.btn.primary');
      ok.classList.add('danger');
      ok.onclick = async function () {
        try {
          await rc.filesRemove(st.targetId, full, st.recursive);
          mask.remove(); APP.toast('已删除'); nav(st.path);
        } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
      };
    }

    async function doMkdir() {
      const name = prompt('新文件夹名称');
      if (!name) return;
      try {
        await rc.filesMkdir(st.targetId, (st.path === '/' ? '' : st.path) + '/' + name);
        nav(st.path);
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
    }

    async function doUpload() {
      APP.setBusy('正在上传…');
      try {
        const r = await rc.filesUpload(st.targetId, st.path);
        if (r.ok) { APP.toast('已上传 ' + r.files.length + ' 个文件'); nav(st.path); }
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
      finally { APP.clearBusy(); }
    }

    async function download(full, name) {
      APP.setBusy('正在下载 ' + name + ' …');
      try {
        const r = await rc.filesDownload(st.targetId, full, name);
        if (r.ok) APP.toast('已下载到 ' + r.local);
      } catch (e) { APP.toast(APP.describeErr(e), 'fail'); }
      finally { APP.clearBusy(); }
    }

    // 允许外部切换设备（比如点 U30 卡片上的「文件」）
    pane.setTarget = function (id) {
      if (!START[id]) return;
      st.targetId = id;
      st.path = START[id];
      devSel.value = id;
      renderShortcuts();
      nav(st.path);
    };

    renderShortcuts();
    nav(st.path);
    pane.refresh = function () { nav(st.path); };
  };
})();
