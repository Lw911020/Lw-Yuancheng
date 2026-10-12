'use strict';
// 红线守卫：默认硬禁用不可逆 / 违反商家红线的操作
// guard = 'strict'  -> blocked（代码级拦截）
// guard = 'relaxed' -> needsConfirm（必须手动输入确认文字）
const RED_LINES = [
  {
    id: 'factory-reset',
    label: '恢复出厂设置',
    reason: '商家红线：禁止恢复出厂设置（会导致小鲸卡/IP 被封）',
    patterns: [
      /factory[\s_-]*reset/i,
      /wipe[_ ]?data/i,
      /master_clear/i,
      /--wipe\b/i,
      /\bpm\s+clear\b/i,
      /am\s+broadcast[^\n]*(FACTORY|WIPE)/i,
      /\brecovery\b[^\n]*wipe/i
    ]
  },
  {
    id: 'ota-update',
    label: '系统更新 / 固件升级',
    reason: '商家红线：禁止更新任何东西（禁止 OTA / FOTA / 系统升级）',
    patterns: [
      /\b(fota|ota)[_-]?(update|upgrade)\b/i,
      /system[_-]update/i,
      /apply_update|update_engine/i,
      /\binstall_apk\b/i
    ]
  },
  {
    id: 'sim-swap',
    label: '小鲸卡换设备相关操作',
    reason: '商家红线：小鲸卡禁止换设备（换机秒封）',
    patterns: [
      /sim[_-]?swap/i,
      /change_device|bind_new_device/i,
      /iccid[^\n]*(write|set)/i
    ]
  },
  {
    id: 'destructive',
    label: '破坏性操作',
    reason: '可能清空数据或破坏系统分区',
    patterns: [
      /rm\s+-[a-z]*r[a-z]*f?\s+\/\s*$/,
      /rm\s+-[a-z]*r[a-z]*f?\s+\/(data|system|sdcard)\b/,
      /\bmkfs(\.|\s)/i,
      /\bdd\s+if=[^\n]*of=\/dev\//i,
      /git\s+clean\s+-[a-z]*f/i,
      /DROP\s+TABLE/i
    ]
  }
];

function scan(cmd, opts) {
  const mode = (opts && opts.guard) || 'strict';
  const s = String(cmd == null ? '' : cmd);
  for (const rule of RED_LINES) {
    for (const re of rule.patterns) {
      if (re.test(s)) {
        return {
          ruleId: rule.id,
          label: rule.label,
          reason: rule.reason,
          action: mode === 'strict' ? 'blocked' : 'needsConfirm',
          confirmWord: rule.id.toUpperCase()
        };
      }
    }
  }
  return { action: 'allow', ruleId: null };
}

module.exports = { scan, RED_LINES };
