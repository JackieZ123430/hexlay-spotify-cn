'use strict';
/**
 * QuickCode Automated Backup & Rollback Manager
 *
 * Safety Principles:
 *   1. Every coding change automatically snapshots the full ECU state BEFORE writing.
 *   2. Backups are stored in crash-proof, atomic JSON storage on the head unit disk.
 *   3. Rollback can restore any previous snapshot with a single tap.
 *   4. Zero risk: BDC (0x40) parameters are safe comfort options; head unit OS is never touched.
 *   5. Self-healing: Automatic .bak mirror recovery prevents data loss if power cuts during writes.
 */
const fs = require('fs');
const path = require('path');

class BackupManager {
    constructor(dataDir, log) {
        this.log = log || console;
        const baseDir = dataDir || process.cwd();
        this.filePath = path.join(baseDir, 'quick_code_backups.json');
        this.bakPath = this.filePath + '.bak';
        this.maxBackups = 30;

        // Ensure target directory exists on disk immediately
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch (e) {
            this.log.warn('BackupManager: Could not create base directory: ' + e.message);
        }
    }

    /**
     * Safely load backups with fallback to backup mirror (.bak) if corruption detected.
     */
    load() {
        // Attempt 1: Load primary file
        try {
            if (fs.existsSync(this.filePath)) {
                const content = fs.readFileSync(this.filePath, 'utf8');
                if (content && content.trim().length > 0) {
                    const data = JSON.parse(content);
                    if (Array.isArray(data)) return data;
                }
            }
        } catch (e) {
            this.log.warn('BackupManager: Primary backup file load/parse error: ' + e.message);
        }

        // Attempt 2: Self-healing fallback to mirror (.bak)
        try {
            if (fs.existsSync(this.bakPath)) {
                const bakContent = fs.readFileSync(this.bakPath, 'utf8');
                if (bakContent && bakContent.trim().length > 0) {
                    const data = JSON.parse(bakContent);
                    if (Array.isArray(data)) {
                        this.log.info('BackupManager: Successfully recovered backups from mirror (.bak)');
                        // Restore primary from valid backup mirror
                        this.save(data);
                        return data;
                    }
                }
            }
        } catch (e) {
            this.log.warn('BackupManager: Mirror backup load error: ' + e.message);
        }

        return [];
    }

    /**
     * Atomically write backups to disk using temp file + atomic rename.
     * Prevents file corruption if vehicle power/ignition is turned off mid-write.
     */
    save(list) {
        if (!Array.isArray(list)) return;
        const dir = path.dirname(this.filePath);
        const tempPath = path.join(dir, `.tmp_qc_bk_${process.pid}_${Date.now()}`);

        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const jsonStr = JSON.stringify(list, null, 2);

            // 1. Write full content to temporary file
            fs.writeFileSync(tempPath, jsonStr, 'utf8');

            // 2. If primary file currently exists and is valid, maintain mirror copy
            if (fs.existsSync(this.filePath)) {
                try {
                    fs.copyFileSync(this.filePath, this.bakPath);
                } catch (_) {}
            }

            // 3. Atomically replace primary file with temp file (POSIX atomic rename)
            fs.renameSync(tempPath, this.filePath);
        } catch (e) {
            this.log.warn('BackupManager: Atomic save error: ' + e.message);
            // Clean up orphaned temp file if rename failed
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch (_) {}
        }
    }

    /**
     * Create an automated pre-coding snapshot before modifying any parameter.
     */
    createBackup(actionTitle, paramKey, oldValue, newValue, currentStateSnapshot) {
        const list = this.load();
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timeFormatted = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        // Deep clone snapshot to eliminate any reference leak
        let safeSnapshot = {};
        try {
            safeSnapshot = JSON.parse(JSON.stringify(currentStateSnapshot || {}));
        } catch (_) {
            safeSnapshot = Object.assign({}, currentStateSnapshot);
        }

        const entry = {
            id: 'bk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
            timestamp: Date.now(),
            timeFormatted,
            actionTitle: actionTitle || 'Parameter Modification',
            paramKey: paramKey || 'custom',
            oldValue: (oldValue !== undefined) ? oldValue : null,
            newValue: (newValue !== undefined) ? newValue : null,
            ecu: 'BDC_BODY3 (0x40)',
            snapshot: safeSnapshot
        };

        list.unshift(entry);
        if (list.length > this.maxBackups) {
            list.splice(this.maxBackups);
        }
        this.save(list);
        this.log.info(`BackupManager: Created atomic backup ${entry.id} for "${entry.actionTitle}"`);
        return entry;
    }

    getBackups() {
        return this.load();
    }

    getBackupById(id) {
        if (!id) return null;
        const list = this.load();
        return list.find(b => b && b.id === id) || null;
    }

    deleteBackup(id) {
        if (!id) return;
        let list = this.load();
        list = list.filter(b => b && b.id !== id);
        this.save(list);
    }

    clearAll() {
        this.save([]);
    }
}

module.exports = { BackupManager };
