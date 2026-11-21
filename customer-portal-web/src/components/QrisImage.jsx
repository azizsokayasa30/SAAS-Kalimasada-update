import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Render QRIS payload as crisp SVG (avoids PNG+pixelated mis-scans on phone cameras).
 */
export default function QrisImage({ value, className = '' }) {
  const [src, setSrc] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    const payload = String(value || '').trim();
    if (!payload.startsWith('000201')) {
      setSrc('');
      setErr('QR tidak valid');
      return undefined;
    }
    setErr('');
    QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 4,
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then((svg) => {
        if (cancelled) return;
        setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e.message || 'Gagal membuat QR');
        setSrc('');
      });
    return () => { cancelled = true; };
  }, [value]);

  if (err) {
    return <p className="text-xs text-rose-600 text-center py-6">{err}</p>;
  }
  if (!src) {
    return <div className={`bg-slate-50 animate-pulse rounded-xl ${className}`} />;
  }
  return (
    <img
      src={src}
      alt="QRIS"
      className={`w-full h-full object-contain bg-white ${className}`}
      draggable={false}
    />
  );
}
