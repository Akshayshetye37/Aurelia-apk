const QRCodeCore = require('qrcode/lib/core/qrcode');
const SvgRenderer = require('qrcode/lib/renderer/svg-tag');

function toString(text, options = {}) {
  try {
    const qrData = QRCodeCore.create(text, options);
    return Promise.resolve(SvgRenderer.render(qrData, options));
  } catch (error) {
    return Promise.reject(error);
  }
}

module.exports = { toString };
