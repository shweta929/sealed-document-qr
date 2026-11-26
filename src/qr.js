import QRCode from 'qrcode';

const QR_OPTIONS = {
  errorCorrectionLevel: 'H',
  margin: 2,
  width: 640,
  color: {
    dark: '#1c1915',
    light: '#ffffff',
  },
};

export function qrPng(text) {
  return QRCode.toBuffer(text, QR_OPTIONS);
}
