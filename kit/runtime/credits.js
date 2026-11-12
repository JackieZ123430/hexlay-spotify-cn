'use strict';
// The translation credit in the corner: Chinese packages only. Its text is in their locale.json
// (build.py, from kit/localization/credit.zh-CN.json); other packages carry none.
const locale = require('./locale.json');
const { getLanguage } = require('./i18n');
const CREDIT = typeof locale.credit === 'string' ? locale.credit : '';
function drawCredit(canvas, x, baseline, left = 0) {
    if (getLanguage() !== 'zh-CN' || !CREDIT) return;
    const opts = { align: 'right', font: 'label', literal: true };
    const label = canvas.textWidth(CREDIT, 12, opts) <= x - left ? CREDIT : '汉化 · 小白151';
    if (canvas.textWidth(label, 12, opts) <= x - left) canvas.text(label, x, baseline, 12, '#ffffff40', opts);
}
module.exports = { CREDIT, drawCredit };
