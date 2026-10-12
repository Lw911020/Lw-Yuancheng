'use strict';
// 默认配置：首次启动写入 userData/config.json，之后可在界面上修改
const path = require('path');

// 内置 EasyTier 内核的位置：打包后在 exe 同级的 easytier 目录，开发时在 vendor/easytier
function vendorEt(app, name) {
  const base = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'easytier')
    : path.join(__dirname, '..', 'vendor', 'easytier');
  return path.join(base, name);
}

module.exports = function defaultConfig(app) {
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return {
    guard: 'strict',                       // strict = 红线硬禁用；relaxed = 需手输确认
    adbPath: 'D:\\移动WiFi\\pc-tools\\platform-tools\\adb.exe',
    scrcpyDir: 'D:\\移动WiFi\\pc-tools\\scrcpy-win64-v5.0.1',
    easytier: {
      coreExe: vendorEt(app, 'easytier-core.exe'),
      cliExe: vendorEt(app, 'easytier-cli.exe'),
      startMode: 'core',
      guiLnk: home + '\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\easytier-gui.lnk',
      probeIp: '10.126.126.1',
      autoStart: true,
      guardian: true,
      guardianIntervalSec: 20,
      autoRestart: false,
      stopGui: false,
      args: ['-d', '--network-name', 'ufi-u30air-9f3c', '--network-secret', 'Kq7mZ2xT9pL4vR8w', '-p', 'tcp://easytier-us.slarker.me:11010']
    },
    scriptsDir: path.join(app.getPath('userData'), 'scripts'),
    backupsDir: path.join(app.getPath('userData'), 'backups'),
    targets: [
      {
        id: 'local', name: '本机 (PowerShell)', kind: 'local', color: '#6b7280', enabled: true,
        note: '本地命令执行'
      },
      {
        id: 'u30', name: 'U30 Air 随身WiFi', kind: 'ufi', color: '#12b886', enabled: true,
        note: '中兴 U30 Air / UFI-TOOLS 后台',
        ufi: {
          base: 'http://10.126.126.1:2333',
          baseLan: 'http://192.168.0.1:2333',
          token: 'admin',
          timeoutMs: 30000
        },
        adb: { addr: '10.126.126.1:5555' }
      },
      {
        id: 'c3', name: 'C3 (comma 3)', kind: 'ssh', color: '#3b82f6', enabled: true,
        note: 'openpilot / comma three',
        ssh: {
          host: '192.168.0.66', port: 22, user: 'comma',
          keyPath: home + '\\.ssh\\c3_id_ed25519',
          passphrase: ''
        }
      },
      {
        id: 'car', name: '车机 (BYD DiLink)', kind: 'adb', color: '#f59e0b', enabled: true,
        note: 'BYD DiLink 3.0 / Android 10',
        adb: { addr: '192.168.0.100:5555' }
      }
    ]
  };
};
